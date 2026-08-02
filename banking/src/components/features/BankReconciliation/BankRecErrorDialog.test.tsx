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
 *   - `<a href="javascript:…>` and `[…](javascript:…)` are the URL-scheme vectors
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

/**
 * UI-redress payload (CWE-451). None of this is script — every fragment is *presentational*,
 * which is exactly why it is dangerous in an application whose Tailwind utilities are already
 * compiled into the shipped stylesheet. A single server-controlled `class` is otherwise enough
 * to paint an opaque full-viewport panel over the dialog reporting the failure and to put
 * attacker-authored text and a "sign in again" control where the user expects the product's own:
 *   - `class` on a positioned overlay        -> covers the real UI
 *   - `id` colliding with a live description -> rewrites what a screen reader announces
 *   - `<input>`                              -> a credential field inside an error message
 *   - `<a href>` off-site and scheme-relative -> a phishing destination presented as ours
 */
const REDRESS_MESSAGE =
	'Session expired. <div id="redress-overlay" class="fixed inset-0 z-50 bg-surface-white p-6">' +
	'<p class="text-2xl">Re-enter your password to continue</p>' +
	'<input id="redress-input" type="password" name="password" placeholder="Password" />' +
	'<a id="redress-external" href="https://evil.example.com/login">Sign in</a>' +
	'<a id="redress-scheme-relative" href="//evil.example.com/login">Continue</a>' +
	'</div>'

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
	 * The dialog composes the SHARED `ErrorBanner` rather than restating its parser, severity
	 * rule, heading rule and message rendering. Asserting the composition — not just the
	 * rendered text — is what stops the duplication returning.
	 */
	describe('composes the shared ErrorBanner', () => {
		it('renders through the shared banner, so the alert carries the banner heading rule', () => {
			// `makeServerMessagesError` sends Frappe's real placeholder title 'Message', which
			// ONLY `ErrorBanner.parseHeading` collapses into this friendly heading.
			renderDialog(makeServerMessagesError('Hard refusal'))

			const alert = screen.getByRole('alert')
			expect(alert).toHaveTextContent('There was an error.')
			expect(alert).toHaveTextContent('Hard refusal')
		})

		it("keeps Frappe's own inline emphasis, which the shared markdown path renders", () => {
			// A bespoke text-only renderer here would have shown these tags literally. The
			// server's `frappe.bold()` wrappers must arrive as emphasis, exactly as they do in
			// every inline banner.
			renderDialog(makeServerMessagesError('Transaction currency: <b>USD</b> cannot be different'))

			const alert = screen.getByRole('alert')
			expect(alert.querySelector('b')).not.toBeNull()
			expect(alert).toHaveTextContent('Transaction currency: USD cannot be different')
			expect(alert.textContent).not.toContain('<b>')
		})
	})

	/**
	 * REGRESSION — CWE-79. Server messages reach `ui/markdown.tsx`, which runs `rehype-raw`,
	 * so raw HTML in a `_server_messages` envelope is parsed into real nodes. The allow-list
	 * sanitiser that runs immediately afterwards is what keeps it from becoming active DOM.
	 * These assertions fail the moment that sanitiser weakens.
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

		it("keeps the reader's text while discarding the executable payload", () => {
			renderDialog(makeServerMessagesError(HOSTILE_MESSAGE))
			const text = screen.getByRole('alertdialog').textContent ?? ''

			// Every human-readable fragment survives: the sanitiser unwraps rather than deletes
			// wherever there is text to preserve, so no part of the server's sentence is lost.
			expect(text).toContain('Import failed.')
			expect(text).toContain('click me')
			expect(text).toContain('link')
			// A destination with spaces is not a CommonMark link, so this one stays literal text.
			expect(text).toContain('javascript:window.__pwned')
			// But the contents of the dropped script and style subtrees are gone entirely.
			expect(text).not.toContain('body{display:none}')
		})

		it('does not interpret a hostile URL from a message that carries no server envelope', () => {
			renderDialog(makeFrappeError({ message: HOSTILE_MESSAGE, exception: '' }))
			const dialog = screen.getByRole('alertdialog')

			expect(dialog.querySelectorAll('a')).toHaveLength(0)
			expect(dialog.querySelectorAll('style')).toHaveLength(0)
			expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
		})
	})

	/**
	 * REGRESSION — CWE-451 (UI redress / clickjacking). None of this payload is script, which
	 * is precisely why it needs its own coverage: presentational attributes are enough to
	 * hijack an error dialog in an application that ships compiled utility classes.
	 */
	describe('server-controlled text cannot redress the UI (CWE-451 regression)', () => {
		it('strips class and id, so a message cannot position or paint anything', () => {
			renderDialog(makeServerMessagesError(REDRESS_MESSAGE))
			const dialog = screen.getByRole('alertdialog')

			expect(dialog.querySelector('#redress-overlay')).toBeNull()
			expect(dialog.querySelector('.fixed')).toBeNull()
			expect(dialog.querySelector('[class*="inset-0"]')).toBeNull()

			// No element rendered from the message carries either attribute. The dialog's own
			// chrome legitimately does, so the scan is scoped to the banner's message body.
			const banner = screen.getByRole('alert')
			banner.querySelectorAll('p *').forEach((element) => {
				expect(element.getAttribute('class')).toBeNull()
				expect(element.getAttribute('id')).toBeNull()
			})
		})

		it('renders no form control from a message', () => {
			renderDialog(makeServerMessagesError(REDRESS_MESSAGE))
			const dialog = screen.getByRole('alertdialog')

			expect(dialog.querySelector('#redress-input')).toBeNull()
			expect(dialog.querySelectorAll('input, textarea, select, button[type="submit"], form')).toHaveLength(0)
		})

		it('refuses an off-site destination, including the scheme-relative form', () => {
			renderDialog(makeServerMessagesError(REDRESS_MESSAGE))
			const dialog = screen.getByRole('alertdialog')

			// Neither anchor survives, and no link to that host exists under any attribute.
			expect(dialog.querySelectorAll('a')).toHaveLength(0)
			expect(dialog.querySelector('[href*="evil.example.com"]')).toBeNull()
			// The link TEXT is still shown, so nothing the server wrote is hidden from the user.
			expect(dialog.textContent).toContain('Sign in')
			expect(dialog.textContent).toContain('Continue')
		})

		it('still renders a same-origin document link the server offered', () => {
			renderDialog(makeServerMessagesError('See <a href="/app/bank-transaction/ACC-BTN-2024-00001">ACC-BTN-2024-00001</a>'))
			const anchor = screen.getByRole('alertdialog').querySelector('a')

			expect(anchor).not.toBeNull()
			expect(anchor).toHaveAttribute('href', '/app/bank-transaction/ACC-BTN-2024-00001')
			expect(anchor).toHaveAttribute('rel', 'noreferrer noopener')
			expect(anchor).not.toHaveAttribute('target')
		})
	})

	/**
	 * REGRESSION — F11/M4. The dialog must stay inside the viewport at every width and must
	 * never carry its only Dismiss control off-screen, so the geometry-bearing classes are
	 * asserted directly: jsdom computes no layout, and these are the exact classes the
	 * measured 297px overflow at 375px came down to.
	 */
	describe('viewport containment', () => {
		it('sets no unconditional minimum width and bounds its height', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))
			const dialog = screen.getByRole('alertdialog')

			// NOTHING forces a width. A `min-w-*` is what defeated the gutter rule below, so its
			// absence is the assertion that matters most here.
			expect(dialog.className).not.toMatch(/(^|\s|:)min-w-/)

			// The complete max-width ladder, every rung inside its own range:
			//   < 640px -> the primitive's gutter rule
			//   >= 640px -> the primitive's 512px
			//   >= 768px -> our 672px
			expect(dialog).toHaveClass('max-w-[calc(100%-2rem)]')
			expect(dialog).toHaveClass('data-[size=default]:sm:max-w-lg')
			expect(dialog).toHaveClass('data-[size=default]:md:max-w-2xl')

			// Qualified to match the primitive's own selector, so the two rungs sit at equal
			// specificity and Tailwind's ascending breakpoint order decides — rather than an
			// unqualified class losing to the primitive at every width.
			expect(dialog.className).not.toMatch(/(^|\s)md:max-w-/)

			// Bounded height, the same treatment `ui/dialog.tsx` applies to the ordinary dialog.
			expect(dialog).toHaveClass('max-h-[90vh]')

			// And the bound has to actually bite. The primitive is `display: grid` with
			// implicit rows, and `max-height` does not shrink an `auto` track — so without a
			// named middle track the message row sizes to its content, the scroller below
			// never activates, and the footer holding the only Dismiss control paints outside
			// the clamped box. Measured off-screen by 1952px at 375x812 before this was added.
			expect(dialog).toHaveClass('grid-rows-[auto_minmax(0,1fr)_auto]')
		})

		it('scrolls the message region so the header and Dismiss stay in view', () => {
			renderDialog(makeServerMessagesError('x'.repeat(4000)))

			const scroller = screen.getByRole('alert').parentElement
			expect(scroller).toHaveClass('overflow-y-auto')
			expect(scroller).toHaveClass('min-h-0')
			expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()

			// The scroller must be the MIDDLE of exactly three children, because the track
			// template names exactly three tracks. A fourth child would land in an implicit
			// `auto` row and reintroduce the overflow.
			const dialog = screen.getByRole('alertdialog')
			expect(dialog.children).toHaveLength(3)
			expect(dialog.children[1]).toBe(scroller)
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
