/*
 * `BankRecErrorDialog` — the dismissible error dialog (FM1, FM2, FM3).
 *
 * The component is a COMPOSITION and this suite specifies it as one: an `AlertDialog` wrapping the
 * shared `ErrorBanner`, handed the `FrappeError` EXACTLY as the SDK delivered it. So the assertions
 * fall into three groups — that the server's own words reach the reader through the shared parser and
 * the shared renderer; that the shared sanitiser is in front of that renderer, proved end-to-end
 * through the real `react-markdown` pipeline; and that dismissal touches nothing but the dialog atom.
 *
 * `AlertDialogContent` renders inside `AlertDialogPortal`, so the dialog is portaled to
 * `document.body` and is NOT inside the tree `render()` returns: every query goes through
 * `screen`/`document`, and the render helper exposes no `container` to reach for by mistake.
 *
 * Severity is asserted on the theme's token CLASSES because `ui/alert.tsx` emits no `data-theme` — it
 * carries the theme only in its `cva` class list, so the class is the sole observable signal.
 *
 * ⚠️ jsdom does not execute scripts and does not load subresources, and `vitest.config.ts` configures
 * neither, so an assertion that nothing ran or nothing was fetched would pass whether or not the
 * sanitiser works. Nothing here claims otherwise: the sanitisation assertions are STRUCTURAL — which
 * elements and attributes survive the whole shared pipeline, and that the server's text is not lost.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { describe, expect, it, vi } from 'vitest'
import {
	ALREADY_RECONCILED_MESSAGE_TEMPLATE,
	TEST_BANK_ACCOUNT,
	createFrappeSDKMock,
	formatAlreadyReconciledMessage,
	frappePostCall,
	frappeSWRMutate,
	makeAlreadyReconciledError,
	makeErrorMessageError,
	makeExceptionError,
	makeFrappeError,
	makeMessageOnlyError,
	makeSelectedBank,
	makeServerMessagesError,
	makeUnreconciledTransaction,
	makeWarningServerMessagesError
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankRecErrorDialog from './BankRecErrorDialog'
import {
	bankRecErrorDialogAtom,
	bankRecSelectedTransactionAtom,
	selectedBankAccountAtom
} from './bankRecAtoms'

const DIALOG_TITLE = 'Something went wrong'
const DIALOG_DESCRIPTION =
	'Review the details below, then dismiss this message to continue. The server remains the authority on what was recorded.'
const DISMISS_LABEL = 'Dismiss'
const COLLAPSED_HEADING = 'There was an error.'

type ServerMessagePayload = {
	message: string
	title?: string
	indicator?: string
}

/**
 * Reproduces Frappe's real DOUBLE encoding — a JSON array whose elements are themselves JSON strings.
 * Needed only for the two envelopes the named factories deliberately do not cover: a message carrying
 * a DISTINCTIVE title, and two messages in one envelope. A drift guard below pins this against the
 * shared factory's own output, so it cannot quietly diverge from the contract the rest of the suite is
 * built on.
 */
const encodeServerMessages = (...messages: ServerMessagePayload[]): string =>
	JSON.stringify(messages.map((message) => JSON.stringify(message)))

type SeededError = ReturnType<typeof makeFrappeError>
type SeededStore = ReturnType<typeof createStore>

/*
 * A per-test store is mandatory rather than stylistic: jotai state is per-`Provider` and the harness
 * performs no global reset, so a shared store would leak one test's error into the next. `seed` reaches
 * that same store before the first render, which is how the dismissal test can show unrelated
 * reconciliation state surviving untouched.
 */
const renderDialog = (error: SeededError | null, seed?: (store: SeededStore) => void) => {
	const store = createStore()
	store.set(bankRecErrorDialogAtom, error)
	seed?.(store)

	const { unmount } = render(
		<Provider store={store}>
			<BankRecErrorDialog />
		</Provider>
	)

	return { store, unmount }
}

const getDialogContent = (): HTMLElement => screen.getByRole('alertdialog')

const getOverlay = (): HTMLElement => {
	const overlay = document.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]')
	if (!overlay) {
		throw new Error('The alert-dialog overlay was not rendered')
	}
	return overlay
}

const getBanner = (): HTMLElement => screen.getByRole('alert')

const getBannerDescription = (): HTMLElement | null =>
	getBanner().querySelector('[data-slot="alert-description"]')

const getBannerMessageText = (): string => getBannerDescription()?.textContent ?? ''

const getBannerMarkup = (): string => getBannerDescription()?.innerHTML ?? ''

const getBannerHeading = (): string =>
	getBanner().querySelector('[data-slot="alert-title"]')?.textContent ?? ''

describe('BankRecErrorDialog', () => {
	describe('when the atom holds no error', () => {
		it('starts empty, so a store nobody has written to shows nothing', () => {
			expect(createStore().get(bankRecErrorDialogAtom)).toBeNull()
		})

		it('renders nothing at all — no content, no overlay, no chrome, no control', () => {
			renderDialog(null)

			expect(screen.queryByRole('alertdialog')).toBeNull()
			expect(document.querySelector('[data-slot="alert-dialog-overlay"]')).toBeNull()
			expect(screen.queryByText(DIALOG_TITLE)).toBeNull()
			expect(screen.queryByRole('button', { name: DISMISS_LABEL })).toBeNull()
		})
	})

	describe("renders the server's own words", () => {
		/*
		 * The real server text, thrown by the guard that makes a double post impossible. Both halves are
		 * checked: that the shared factory still transcribes the template exactly, and that the banner
		 * renders the formatted result character for character.
		 */
		it('renders "Bank Transaction {0} is already fully reconciled" verbatim', () => {
			expect(ALREADY_RECONCILED_MESSAGE_TEMPLATE).toBe(
				'Bank Transaction {0} is already fully reconciled'
			)

			const transaction = 'ACC-BTN-2024-00001'
			const expected = formatAlreadyReconciledMessage(transaction)
			expect(expected).toBe('Bank Transaction ACC-BTN-2024-00001 is already fully reconciled')

			renderDialog(makeAlreadyReconciledError(transaction))

			expect(getDialogContent()).toBeInTheDocument()
			expect(screen.getByText(expected)).toBeInTheDocument()
			expect(getBannerMessageText()).toBe(expected)
			expect(getBannerMessageText()).toContain(transaction)
		})

		/**
		 * `getErrorMessages` resolves in a fixed order, and a rejection can arrive on any of these paths
		 * depending on how it was raised. Covering each one is what stops the dialog rendering an empty
		 * banner for a shape nobody happened to test.
		 */
		describe('across every envelope path the shared parser resolves', () => {
			it('PATH 1 — the double-encoded `_server_messages` a frappe.throw produces', () => {
				renderDialog(makeServerMessagesError('Nothing was posted'))

				expect(getBannerMessageText()).toBe('Nothing was posted')
			})

			it('PATH 2 — `_error_message`, which the parser appends', () => {
				renderDialog(makeErrorMessageError('The linked voucher is over-allocated'))

				expect(getBannerMessageText()).toBe('The linked voucher is over-allocated')
			})

			it('PATH 3 — the text after the first colon of `exception`', () => {
				// Reached only because there are no server messages at all. The parsed message keeps the
				// space that follows the colon, which markdown then folds away on render.
				renderDialog(makeExceptionError('Bank Account is disabled'))

				expect(getBannerMessageText().trim()).toBe('Bank Account is disabled')
			})

			it('PATH 4 — the bare `message`, the last resort', () => {
				renderDialog(makeMessageOnlyError())

				expect(getBannerMessageText()).toBe('Internal Server Error')
			})

			it('appends `_error_message` to `_server_messages` rather than replacing it', () => {
				// The append is additive by design, so a rejection carrying both shows BOTH — one
				// rendered message per parsed entry (`ui/error-banner.tsx:43-45`).
				renderDialog(
					makeFrappeError({
						_server_messages: encodeServerMessages({
							message: 'Reconciliation refused',
							title: 'Message',
							indicator: 'red'
						}),
						_error_message: 'Bank Transaction is already fully reconciled'
					})
				)

				expect(getBannerMessageText()).toContain('Reconciliation refused')
				expect(getBannerMessageText()).toContain('Bank Transaction is already fully reconciled')
				expect(getBannerDescription()?.children).toHaveLength(2)
			})

			it('encodes an envelope exactly as the shared factory does', () => {
				const factoryEnvelope = makeServerMessagesError('Nothing was posted')._server_messages

				expect(
					encodeServerMessages({ message: 'Nothing was posted', title: 'Message', indicator: 'red' })
				).toBe(factoryEnvelope)
			})
		})

		/*
		 * THE RAW-ERROR CONTRACT. The dialog hands `ErrorBanner` the object the atom holds, by identity
		 * and untouched. That is what makes this dialog and any inline banner incapable of disagreeing
		 * about the same rejection, and it is asserted directly rather than inferred, because the way
		 * this contract gets broken is by a well-meaning transformation that "only" normalises a field.
		 */
		it('never reshapes, clears or re-encodes the rejection it was handed', () => {
			const error = makeFrappeError({
				_server_messages: encodeServerMessages({
					message: 'Nothing was posted',
					title: 'Message',
					indicator: 'red'
				}),
				_error_message: 'Bank Transaction is already fully reconciled',
				exception: 'frappe.exceptions.ValidationError: refused',
				exc: 'Traceback (most recent call last): …'
			})
			const before = structuredClone(error)

			const { store } = renderDialog(error)

			expect(store.get(bankRecErrorDialogAtom)).toBe(error)
			expect(error).toEqual(before)
		})

		describe('heading', () => {
			it("collapses Frappe's generic 'Message' title into the shared friendly heading", () => {
				renderDialog(makeServerMessagesError('Hard refusal'))

				expect(getBannerHeading()).toBe(COLLAPSED_HEADING)
				expect(getBannerMessageText()).toBe('Hard refusal')
			})

			it("collapses the generic 'Error' title the same way", () => {
				renderDialog(makeErrorMessageError('Hard refusal'))

				expect(getBannerHeading()).toBe(COLLAPSED_HEADING)
			})

			it('keeps a distinctive server title, so the dialog sets no overrideHeading', () => {
				// `overrideHeading` would win over the parsed title unconditionally. It is left unset,
				// which is only observable when the server sends a title worth keeping.
				renderDialog(
					makeFrappeError({
						_server_messages: encodeServerMessages({
							message: 'Allocated amount exceeds the unallocated amount',
							title: 'Over-allocation',
							indicator: 'red'
						})
					})
				)

				expect(getBannerHeading()).toBe('Over-allocation')
				expect(getBannerHeading()).not.toBe(COLLAPSED_HEADING)
			})

			it('renders markup in a title as literal TEXT, because the heading is a plain React child', () => {
				// `AlertTitle` receives the parsed title as a string child, so React escapes it. Nothing
				// executes and nothing is silently deleted — the reader sees exactly what was sent.
				renderDialog(
					makeFrappeError({
						_server_messages: encodeServerMessages({
							message: 'Refused',
							title: 'Over-<script>window.__pwned=true</script>allocation',
							indicator: 'red'
						})
					})
				)

				expect(getBanner().querySelector('[data-slot="alert-title"] script')).toBeNull()
				expect(getBannerHeading()).toBe('Over-<script>window.__pwned=true</script>allocation')
			})
		})

		it("keeps Frappe's own inline emphasis, which the shared markdown path renders", () => {
			// A bespoke text-only renderer here would have shown these tags literally. The server's
			// `frappe.bold()` wrappers — used by the currency guard at `bank_transaction.py:64-83`, among
			// others — must arrive as emphasis, exactly as they do in every inline banner.
			renderDialog(makeServerMessagesError('Transaction currency: <b>USD</b> cannot be different'))

			const banner = getBanner()
			expect(banner.querySelector('b')).not.toBeNull()
			expect(banner).toHaveTextContent('Transaction currency: USD cannot be different')
			expect(banner.textContent).not.toContain('<b>')
		})
	})

	/*
	 * ================================================================================================
	 * THE SHARED SANITISER, PROVED AT THIS CONSUMER  (CWE-79 / CWE-451)
	 *
	 * `_server_messages` is HTML and the shared renderer puts it on the page as REAL DOM: it runs
	 * `rehypeRaw`, and `react-markdown` then creates those nodes with `document.createElement`. The
	 * guard is ONE sanitiser installed after `rehypeRaw` inside `ui/markdown.tsx`, so it protects this
	 * dialog and the other ~20 inline `ErrorBanner` call sites at the same time.
	 *
	 * `@/lib/sanitize-html.test.ts` specifies the allow-list rule by rule as a unit. What is asserted
	 * HERE is the end-to-end outcome through the real pipeline, including the two spellings that only
	 * exist after remark has run — a markdown image and a GFM autolink — which no HTML-level filter
	 * could ever see on its own.
	 * ============================================================================================== */
	describe('renders server markup through the shared sanitiser', () => {
		it('drops a <script> subtree, its source text with it, and keeps the words around it', () => {
			renderDialog(
				makeServerMessagesError('Refused <script>window.__pwned = true</script> here')
			)

			expect(getBanner().querySelector('script')).toBeNull()
			expect(getBannerMessageText()).toContain('Refused')
			expect(getBannerMessageText()).toContain('here')
			expect(getBannerMessageText()).not.toContain('__pwned')
		})

		it('strips every event-handler attribute while keeping the element and its text', () => {
			renderDialog(
				makeServerMessagesError('<span onclick="steal()" onmouseover="steal()">Refused</span>')
			)

			const span = getBanner().querySelector('span')
			expect(span).not.toBeNull()
			expect(span?.getAttribute('onclick')).toBeNull()
			expect(span?.getAttribute('onmouseover')).toBeNull()
			expect(getBannerMessageText()).toContain('Refused')
		})

		it('drops <style>, <iframe> and <object> subtrees', () => {
			renderDialog(
				makeServerMessagesError(
					'Refused <style>body{display:none}</style><iframe src="/app"></iframe><object data="/x"></object>'
				)
			)

			const banner = getBanner()
			expect(banner.querySelector('style')).toBeNull()
			expect(banner.querySelector('iframe')).toBeNull()
			expect(banner.querySelector('object')).toBeNull()
			expect(getBannerMessageText()).toContain('Refused')
		})

		it('removes class and id, the two attributes that can cover or re-label the dialog', () => {
			renderDialog(
				makeServerMessagesError('<div class="fixed inset-0 bg-surface-white" id="radix-title">Refused</div>')
			)

			const div = getBanner().querySelector('[data-slot="alert-description"] div')
			expect(div).not.toBeNull()
			expect(div?.getAttribute('class')).toBeNull()
			expect(div?.getAttribute('id')).toBeNull()
			expect(getBannerMessageText()).toContain('Refused')
		})

		it('removes inline style', () => {
			renderDialog(makeServerMessagesError('<span style="position:fixed;inset:0">Refused</span>'))

			expect(getBanner().querySelector('span')?.getAttribute('style')).toBeNull()
		})

		it('drops an <img> whatever its source, because no Frappe message needs one', () => {
			renderDialog(
				makeServerMessagesError(
					'Refused <img src="/assets/erpnext/x.png"><img src="https://tracker.example/pixel.png"> here'
				)
			)

			expect(getBanner().querySelector('img')).toBeNull()
			expect(getBannerMarkup()).not.toContain('tracker.example')
			expect(getBannerMessageText()).toContain('Refused')
			expect(getBannerMessageText()).toContain('here')
		})

		/*
		 * The markdown-authored spellings, which exist only because the sanitiser runs AFTER remark:
		 * `![x](url)` is not HTML, so no HTML-level filter could see it, and a GFM autolink literal is
		 * plain text until remark turns it into an anchor. Both arrive at the sanitiser as ordinary
		 * elements and are handled by the same two rules as their HTML equivalents.
		 */
		it('renders no <img> for a markdown image', () => {
			renderDialog(makeServerMessagesError('Refused ![pixel](https://tracker.example/p.png) here'))

			expect(getBanner().querySelector('img')).toBeNull()
			expect(getBannerMarkup()).not.toContain('tracker.example')
			expect(getBannerMessageText()).toContain('Refused')
			expect(getBannerMessageText()).toContain('here')
		})

		it('renders no anchor for a markdown link to another origin, and keeps its text', () => {
			renderDialog(makeServerMessagesError('Refused [click here](https://phish.example/login) now'))

			expect(getBanner().querySelector('a')).toBeNull()
			expect(getBannerMessageText()).toContain('click here')
		})

		it('renders no anchor for a bare GFM autolink literal, and keeps its text', () => {
			renderDialog(makeServerMessagesError('Refused, see https://phish.example/login for details'))

			expect(getBanner().querySelector('a')).toBeNull()
			expect(getBannerMessageText()).toContain('https://phish.example/login')
		})

		it("keeps Frappe's own root-relative document link, with rel stamped on it", () => {
			renderDialog(
				makeServerMessagesError(
					`Please cancel <a href="/app/bank-transaction/${TEST_BANK_ACCOUNT}">this transaction</a> first`
				)
			)

			const anchor = getBanner().querySelector('a')
			expect(anchor).not.toBeNull()
			expect(anchor?.getAttribute('href')).toBe(`/app/bank-transaction/${TEST_BANK_ACCOUNT}`)
			expect(anchor?.getAttribute('rel')).toBe('noreferrer noopener')
			expect(anchor?.getAttribute('target')).toBeNull()
		})

		it.each([
			['javascript:', 'javascript:window.__pwned=true'],
			['data:', 'data:text/html,<script></script>'],
			['a backslash network-path reference', '\\\\phish.example/login']
		])('unwraps an anchor whose href is %s, keeping the words the server wrote', (_label, href) => {
			renderDialog(makeServerMessagesError(`See <a href="${href}">the detail</a> for more`))

			expect(getBanner().querySelector('a')).toBeNull()
			expect(getBannerMessageText()).toContain('the detail')
		})

		it('keeps the structural markup a validation summary legitimately uses', () => {
			renderDialog(
				makeServerMessagesError(
					'<b>Refused</b><ul><li>one</li><li>two</li></ul><table><tbody><tr><td colspan="2">cell</td><th scope="col">head</th></tr></tbody></table>'
				)
			)

			const banner = getBanner()
			expect(banner.querySelector('b')).not.toBeNull()
			expect(banner.querySelectorAll('li')).toHaveLength(2)
			expect(banner.querySelector('td')?.getAttribute('colspan')).toBe('2')
			expect(banner.querySelector('th')?.getAttribute('scope')).toBe('col')
		})

		it('discards an HTML comment, which carries nothing renderable', () => {
			renderDialog(makeServerMessagesError('Refused<!-- window.__pwned = true --> here'))

			expect(getBannerMarkup()).not.toContain('__pwned')
			expect(getBannerMessageText()).toContain('Refused')
		})

		it('unwraps an unknown-but-harmless tag, keeping every word inside it', () => {
			renderDialog(makeServerMessagesError('Refused <frappe-note>because of a lock</frappe-note> here'))

			expect(getBanner().querySelector('frappe-note')).toBeNull()
			expect(getBannerMessageText()).toContain('because of a lock')
		})
	})

	describe("severity follows the server's own indicator", () => {
		it("renders amber when the server marked its message 'yellow'", () => {
			renderDialog(makeWarningServerMessagesError('The statement covers an earlier period'))

			expect(getBanner().className).toContain('amber')
			expect(getBanner().className).not.toContain('red')
		})

		it('renders red for any other indicator', () => {
			renderDialog(makeServerMessagesError('Hard refusal'))

			expect(getBanner().className).toContain('red')
			expect(getBanner().className).not.toContain('amber')
		})

		it('renders red when the server sent no indicator at all', () => {
			renderDialog(makeExceptionError('Bank Account is disabled'))

			expect(getBanner().className).toContain('red')
		})

		it('tracks the server rather than fixing a severity of its own', () => {
			const { unmount } = renderDialog(makeWarningServerMessagesError('Advisory'))
			expect(getBanner().className).toContain('amber')
			unmount()

			renderDialog(makeServerMessagesError('Refusal'))
			expect(getBanner().className).toContain('red')
		})
	})

	describe('structure', () => {
		it('renders the canonical alert-dialog skeleton', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			const content = getDialogContent()
			expect(content).toBeInTheDocument()
			expect(screen.getByText(DIALOG_TITLE)).toBeInTheDocument()
			expect(screen.getByText(DIALOG_DESCRIPTION)).toBeInTheDocument()
			expect(screen.getByRole('button', { name: DISMISS_LABEL })).toBeInTheDocument()
			// One control only: an error that must be acknowledged offers no second way out, so there is
			// deliberately no Cancel.
			expect(content.querySelectorAll('button')).toHaveLength(1)
			expect(getBanner()).toBeInTheDocument()
		})

		it('portals its overlay and content directly into the document body', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			expect(getOverlay().parentElement).toBe(document.body)
			expect(getDialogContent().parentElement).toBe(document.body)
		})

		it('follows the width of the canonical modal it imitates, and adds nothing else', () => {
			// `BankTransactionUnreconcileModal.tsx:37` is the pattern; matching it exactly is what keeps
			// this dialog from carrying sizing rules of its own.
			renderDialog(makeServerMessagesError('Nothing was posted'))

			expect(getDialogContent().className).toContain('min-w-2xl')
		})
	})

	describe('dismissal', () => {
		it('clears the atom when Dismiss is pressed and removes the dialog', async () => {
			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'))

			await userEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).toBeNull()
			})
		})

		it('clears the atom when Escape is pressed', async () => {
			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'))

			await userEvent.keyboard('{Escape}')

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
		})

		it('leaves every other piece of reconciliation state byte-identical', async () => {
			// FM1: dismissing acknowledges a message. It must not stand in for the revalidation the
			// calling hook owns, and it must not disturb the selection that hook already corrected.
			const bank = makeSelectedBank()
			const selection = [makeUnreconciledTransaction()]

			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'), (seeded) => {
				seeded.set(selectedBankAccountAtom, bank)
				seeded.set(bankRecSelectedTransactionAtom(bank.name), selection)
			})

			await userEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
			expect(store.get(selectedBankAccountAtom)).toBe(bank)
			expect(store.get(bankRecSelectedTransactionAtom(bank.name))).toBe(selection)
		})

		it('makes no SDK call and triggers no revalidation of its own', async () => {
			frappePostCall.mockClear()
			frappeSWRMutate.mockClear()

			renderDialog(makeServerMessagesError('Nothing was posted'))
			await userEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			expect(frappePostCall).not.toHaveBeenCalled()
			expect(frappeSWRMutate).not.toHaveBeenCalled()
		})

		it('is not dismissed by a click outside, because the refusal must be acknowledged', async () => {
			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'))

			await userEvent.click(getOverlay())

			expect(store.get(bankRecErrorDialogAtom)).not.toBeNull()
			expect(screen.getByRole('alertdialog')).toBeInTheDocument()
		})
	})
})
