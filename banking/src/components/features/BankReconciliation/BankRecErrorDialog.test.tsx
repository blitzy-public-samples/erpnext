import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createFrappeSDKMock,
	formatAlreadyReconciledMessage,
	makeAlreadyReconciledError,
	makeFrappeError,
	makeServerMessagesError,
	makeWarningServerMessagesError,
	resetFrappeSDKMock
} from '@/test/factories'

// Replaces the SDK wholesale so nothing in this suite can reach the real transport. The dialog's
// own graph currently touches the package only through type-only imports, which are erased at
// transpile, so no module here loads it today — this is the suite's isolation guarantee, not a
// workaround for a specific import. It has to stay declared here because `vi.mock` is hoisted
// above the imports: a value import reintroduced anywhere beneath the dialog would otherwise
// reach the real package before any test could intervene.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankRecErrorDialog from './BankRecErrorDialog'
import { bankRecErrorDialogAtom } from './bankRecAtoms'

/**
 * Hostile payload. Every fragment is a real injection primitive, and each one is asserted
 * on separately below:
 *   - `<style>`  mounts a live stylesheet (the exact vector reproduced during review)
 *   - `<span onclick>` / `<img onerror>` mount id-bearing elements carrying handlers
 *   - `<script>` mounts executable script
 *   - `[…](javascript:…)` is the markdown-link URL vector
 * Frappe messages are server-controlled, so any of these could arrive inside
 * `_server_messages`.
 */
const HOSTILE_MESSAGE =
	'Import failed. <style id="pwned-style">body{display:none}</style>' +
	'<span id="pwned-span" onclick="window.__pwned = true">click me</span>' +
	'<img id="pwned-img" src="x" onerror="window.__pwned = true" />' +
	'<script id="pwned-script">window.__pwned = true</script>' +
	'<a id="pwned-anchor" href="javascript:window.__pwned = true">link</a>' +
	'[markdown link](javascript:window.__pwned = true)'

const renderDialog = (error: ReturnType<typeof makeFrappeError> | null) => {
	const store = createStore()
	store.set(bankRecErrorDialogAtom, error)

	const utils = render(
		<Provider store={store}>
			<BankRecErrorDialog />
		</Provider>
	)

	return { ...utils, store }
}

describe('BankRecErrorDialog', () => {
	beforeEach(() => {
		resetFrappeSDKMock()
	})

	afterEach(() => {
		cleanup()
		delete (window as unknown as Record<string, unknown>).__pwned
	})

	it('renders nothing while the atom holds no error', () => {
		renderDialog(null)

		expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
	})

	it("renders the server's message verbatim, with no client paraphrasing", () => {
		const message = formatAlreadyReconciledMessage('ACC-BTN-2024-00001')
		renderDialog(makeAlreadyReconciledError('ACC-BTN-2024-00001'))

		expect(screen.getByRole('alertdialog')).toBeInTheDocument()
		expect(screen.getByText(message)).toBeInTheDocument()
	})

	// `Alert` carries its theme in the class list only (`ui/alert.tsx:15-20`), so the token
	// class is the observable severity — which is exactly the value the SERVER chose.
	it("uses the server's own indicator for severity — amber for a warning, red otherwise", () => {
		const { unmount } = renderDialog(makeWarningServerMessagesError('Careful now'))
		expect(screen.getByRole('alert')).toHaveClass('text-ink-amber-3')
		unmount()

		renderDialog(makeServerMessagesError('Hard refusal'))
		expect(screen.getByRole('alert')).toHaveClass('text-ink-red-3')
	})

	/**
	 * REGRESSION — CWE-79. The dialog used to hand server messages to `ErrorBanner`, whose
	 * markdown renderer runs `rehype-raw` with no sanitizer, so a `_server_messages`
	 * envelope mounted live HTML and an active stylesheet into the document. Server text is
	 * now rendered as text; these assertions fail the moment any markup path returns.
	 */
	describe('server-controlled text is inert (CWE-79 regression)', () => {
		it('mounts no element, stylesheet, script or handler from hostile HTML', () => {
			const { container } = renderDialog(makeServerMessagesError(HOSTILE_MESSAGE))
			const dialog = screen.getByRole('alertdialog')

			// Nothing from the payload became an element.
			expect(dialog.querySelector('#pwned-style')).toBeNull()
			expect(dialog.querySelector('#pwned-span')).toBeNull()
			expect(dialog.querySelector('#pwned-img')).toBeNull()
			expect(dialog.querySelector('#pwned-script')).toBeNull()
			expect(dialog.querySelector('#pwned-anchor')).toBeNull()

			// Not by tag name either, anywhere in the rendered tree or the document.
			expect(dialog.querySelectorAll('style')).toHaveLength(0)
			expect(dialog.querySelectorAll('script')).toHaveLength(0)
			expect(dialog.querySelectorAll('img')).toHaveLength(0)
			expect(dialog.querySelectorAll('a')).toHaveLength(0)
			expect(container.querySelectorAll('style, script, img, a')).toHaveLength(0)

			// No inline handler attribute survived anywhere in the dialog.
			dialog.querySelectorAll('*').forEach((element) => {
				expect(element.getAttribute('onclick')).toBeNull()
				expect(element.getAttribute('onerror')).toBeNull()
			})

			// And nothing executed.
			expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
		})

		it('shows the hostile markup to the user as literal text instead', () => {
			renderDialog(makeServerMessagesError(HOSTILE_MESSAGE))

			expect(screen.getByRole('alertdialog').textContent).toContain('<style id="pwned-style">')
			expect(screen.getByRole('alertdialog').textContent).toContain('javascript:window.__pwned')
		})

		it('does not interpret a hostile URL from a message that carries no server envelope', () => {
			renderDialog(makeFrappeError({ message: HOSTILE_MESSAGE, exception: '' }))
			const dialog = screen.getByRole('alertdialog')

			expect(dialog.querySelectorAll('a')).toHaveLength(0)
			expect(dialog.querySelectorAll('style')).toHaveLength(0)
			expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
		})
	})

	describe('dismissal', () => {
		it('clears the atom when Dismiss is pressed and changes nothing else', async () => {
			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'))

			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
			expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
		})

		it('clears the atom when Escape is pressed', async () => {
			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'))

			await userEvent.keyboard('{Escape}')

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
		})
	})
})
