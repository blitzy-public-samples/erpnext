/*
 * `BankRecErrorDialog` — the dismissible error dialog.
 *
 * `AlertDialogContent` renders inside `AlertDialogPortal`, so the dialog is portaled to
 * `document.body` and is NOT inside the tree `render()` returns: every query goes through
 * `screen`/`document`, and the render helper exposes no `container` to reach for by mistake.
 *
 * Severity is asserted on the theme's token CLASSES because `ui/alert.tsx` emits no `data-theme` -
 * it carries the theme only in its `cva` class list, so the class is the sole observable signal.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
 * Reproduces Frappe's real DOUBLE encoding — a JSON array whose elements are themselves JSON
 * strings. Needed only for the two envelopes the named factories deliberately do not cover: a
 * message carrying a DISTINCTIVE title, and two messages in one envelope. A drift guard below
 * pins this against the shared factory's own output, so it cannot quietly diverge from the
 * contract the rest of the suite is built on.
 */
const encodeServerMessages = (...messages: ServerMessagePayload[]): string =>
	JSON.stringify(messages.map((message) => JSON.stringify(message)))

type SeededError = ReturnType<typeof makeFrappeError>
type SeededStore = ReturnType<typeof createStore>

/*
 * A per-test store is mandatory rather than stylistic: jotai state is per-`Provider` and the harness
 * performs no global reset, so a shared store would leak one test's error into the next. `seed`
 * reaches that same store before the first render, which is how the dismissal test can show unrelated
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

/**
 * A realistic INVOKER for the focus tests: the confirm control that started the failed post,
 * sitting inside the tab panel the dialog's region fallback looks for
 * (`[data-slot="tabs-content"]` — verified as the slot `ui/tabs.tsx:161` emits, and the exact
 * selector the dialog queries). `showConfirm` models a revalidation replacing that control's
 * subtree, which is the only case the region fallback exists for.
 */
const InvokerRegion = ({ showConfirm, disableConfirm = false }: { showConfirm: boolean, disableConfirm?: boolean }) => (
	<div data-slot="tabs-content">
		{showConfirm ? <button type="button" disabled={disableConfirm}>Confirm match</button> : null}
		<button type="button">Create voucher</button>
	</div>
)

/**
 * Renders the dialog alongside that invoker with the atom EMPTY, so the failure can be raised
 * only after focus has already moved. That ordering is the whole point: the actions that fail
 * here are asynchronous, the control that starts one re-renders into its disabled state within
 * milliseconds and the browser blurs it immediately, so by the time the rejection arrives
 * `document.activeElement` has already fallen back to `<body>`. The dialog therefore tracks
 * focus as it happens rather than reading it on open, and only this sequence exercises that.
 */
const renderWithInvoker = () => {
	const store = createStore()
	const tree = (showConfirm: boolean, disableConfirm = false) => (
		<Provider store={store}>
			<InvokerRegion showConfirm={showConfirm} disableConfirm={disableConfirm} />
			<BankRecErrorDialog />
		</Provider>
	)

	const { rerender } = render(tree(true))

	return {
		store,
		raise: (error: SeededError) => {
			act(() => {
				store.set(bankRecErrorDialogAtom, error)
			})
		},
		dropInvoker: () => rerender(tree(false)),
		/**
		 * Models the PRODUCTION state of the invoker after a refused post: still mounted, still
		 * connected, but disabled by the confirm guard now that the refreshed `status` /
		 * `unallocated_amount` have landed. This is the case a plain `isConnected` check gets wrong.
		 */
		disableInvoker: () => rerender(tree(true, true))
	}
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

const getBannerMessageText = (): string =>
	getBanner().querySelector('[data-slot="alert-description"]')?.textContent ?? ''

const getBannerHeading = (): string =>
	getBanner().querySelector('[data-slot="alert-title"]')?.textContent ?? ''

describe('BankRecErrorDialog', () => {
	afterEach(() => {
		delete (window as unknown as Record<string, unknown>).__pwned
	})

	describe('when the atom holds no error', () => {
		it('starts empty, so a store nobody has written to shows nothing', () => {
			expect(createStore().get(bankRecErrorDialogAtom)).toBeNull()
		})

		it('renders nothing at all — no content, no overlay, no chrome, no control', () => {
			renderDialog(null)

			expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull()
			expect(document.querySelector('[data-slot="alert-dialog-overlay"]')).toBeNull()
			expect(screen.queryByRole('alert')).not.toBeInTheDocument()

			expect(screen.queryByText(DIALOG_TITLE)).toBeNull()
			expect(screen.queryByText(DIALOG_DESCRIPTION)).toBeNull()
			expect(screen.queryByRole('button', { name: DISMISS_LABEL })).toBeNull()
		})
	})

	describe("renders the server's own words", () => {
		/*
		 * The real server text, thrown by the guard that makes a double post impossible. Both halves
		 * are checked: that the shared factory still transcribes the template exactly, and that the
		 * banner renders the formatted result character for character.
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
		 * `getErrorMessages` (`lib/frappe.ts:133-169`) resolves in a fixed order, and a rejection can
		 * arrive on any of these paths depending on how it was raised. Covering each one is what
		 * stops the dialog rendering an empty banner for a shape nobody happened to test.
		 */
		describe('across every envelope path the parser resolves', () => {
			it('PATH 1 — the double-encoded `_server_messages` a frappe.throw produces', () => {
				renderDialog(makeServerMessagesError('Nothing was posted'))

				expect(getBannerMessageText()).toBe('Nothing was posted')
			})

			it('PATH 2 — `_error_message`, which the parser appends', () => {
				renderDialog(makeErrorMessageError('The linked voucher is over-allocated'))

				expect(getBannerMessageText()).toBe('The linked voucher is over-allocated')
			})

			it('PATH 3 — the text after the first colon of `exception`', () => {
				// Reached only because there are no server messages at all. The parsed message keeps
				// the space that follows the colon, which markdown then folds away on render.
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

				const description = getBanner().querySelector('[data-slot="alert-description"]')
				expect(description?.textContent).toContain('Reconciliation refused')
				expect(description?.textContent).toContain('Bank Transaction is already fully reconciled')
				// TWO rendered messages, counted as the banner's own direct children rather than as
				// `<p>` elements. The element the renderer emits per message is an implementation
				// detail of the sanitisation wrapper (`sanitizeServerMarkup` hands the shared renderer
				// an HTML block so that no markdown, and therefore no markdown-authored `<img>` or
				// off-origin link, can be interpreted inside a server message); the COUNT is the
				// contract, and it must not change with it.
				expect(description?.children).toHaveLength(2)
			})

			/**
			 * The re-encoding {@link sanitizeServerMarkup} performs must not double the appended
			 * `_error_message`. The shared parser APPENDS that field to whatever `_server_messages`
			 * yielded, so handing the banner a re-encoded envelope that still carried the original
			 * field would make it append a second copy — the message would be reported twice.
			 */
			it('does not report the appended `_error_message` twice after re-encoding', () => {
				renderDialog(makeErrorMessageError('The linked voucher is over-allocated'))

				const description = getBanner().querySelector('[data-slot="alert-description"]')
				expect(description?.children).toHaveLength(1)
				expect(getBannerMessageText()).toBe('The linked voucher is over-allocated')
			})

			it('encodes an envelope exactly as the shared factory does', () => {
				const factoryEnvelope = makeServerMessagesError('Nothing was posted')._server_messages

				expect(
					encodeServerMessages({ message: 'Nothing was posted', title: 'Message', indicator: 'red' })
				).toBe(factoryEnvelope)
			})
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
		})

		it("keeps Frappe's own inline emphasis, which the shared markdown path renders", () => {
			// A bespoke text-only renderer here would have shown these tags literally. The server's
			// `frappe.bold()` wrappers — used by the currency guard at `bank_transaction.py:64-83`,
			// among others — must arrive as emphasis, exactly as they do in every inline banner.
			renderDialog(makeServerMessagesError('Transaction currency: <b>USD</b> cannot be different'))

			const banner = getBanner()
			expect(banner.querySelector('b')).not.toBeNull()
			expect(banner).toHaveTextContent('Transaction currency: USD cannot be different')
			expect(banner.textContent).not.toContain('<b>')
		})
	})

	/*
	 * ================================================================================================
	 * SANITISATION OF SERVER MARKUP  (CWE-79 / CWE-451)
	 *
	 * `_server_messages` is HTML and the shared renderer puts it on the page as REAL DOM: it runs
	 * `rehypeRaw` with no sanitiser after it. Anything that can reach a server error message - a party
	 * name, a document field interpolated into a validation string - can therefore reach this dialog as
	 * markup. Every case below is asserted on the RENDERED tree, not on the sanitiser's return value,
	 * because what matters is what survives the whole shared pipeline.
	 *
	 * TEXT is never sacrificed to achieve this: each case that removes an element also asserts the
	 * words the server wrote are still readable.
	 * ============================================================================================== */
	describe('sanitises server-controlled markup before the shared renderer sees it', () => {
		/** Every message body the banner rendered, as markup, so element-level absence can be asserted. */
		const getBannerMarkup = (): string =>
			getBanner().querySelector('[data-slot="alert-description"]')?.innerHTML ?? ''

		describe('script and active content', () => {
			it('drops a <script> subtree outright and executes nothing', () => {
				renderDialog(
					makeServerMessagesError(
						'Import refused<script>window.__pwned = true</script> — fix the file'
					)
				)

				expect(getBannerMarkup()).not.toContain('<script')
				expect(getBanner().querySelector('script')).toBeNull()
				// The script's own SOURCE goes with it: it is code, not text a reader should see.
				expect(getBannerMessageText()).not.toContain('window.__pwned')
				expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()

				// ...and the server's actual words survive on both sides of it.
				expect(getBannerMessageText()).toContain('Import refused')
				expect(getBannerMessageText()).toContain('fix the file')
			})

			it('strips every event-handler attribute while keeping the element and its text', () => {
				renderDialog(
					makeServerMessagesError(
						'<b onclick="window.__pwned = true" onmouseover="window.__pwned = true">Row 1</b>: invalid'
					)
				)

				const bold = getBanner().querySelector('b')
				expect(bold).not.toBeNull()
				expect(bold?.getAttribute('onclick')).toBeNull()
				expect(bold?.getAttribute('onmouseover')).toBeNull()
				expect(getBannerMessageText()).toContain('Row 1')
				expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
			})

			it('drops <style>, <iframe> and <object> subtrees', () => {
				renderDialog(
					makeServerMessagesError(
						'Refused<style>body{display:none}</style><iframe src="/app"></iframe><object data="/x"></object>'
					)
				)

				const banner = getBanner()
				expect(banner.querySelector('style')).toBeNull()
				expect(banner.querySelector('iframe')).toBeNull()
				expect(banner.querySelector('object')).toBeNull()
				expect(getBannerMessageText()).toContain('Refused')
			})
		})

		describe('off-origin resources', () => {
			it('drops an <img> even when its source is same-origin, because no message needs one', () => {
				renderDialog(makeServerMessagesError('Refused <img src="/assets/erpnext/x.png"> here'))

				expect(getBanner().querySelector('img')).toBeNull()
				expect(getBannerMessageText()).toContain('Refused')
			})

			it('drops an off-origin <img>, so opening the dialog issues no outbound request', () => {
				renderDialog(
					makeServerMessagesError('Refused <img src="https://tracker.example/pixel.png"> here')
				)

				expect(getBanner().querySelector('img')).toBeNull()
				expect(getBannerMarkup()).not.toContain('tracker.example')
			})

			/**
			 * The markdown-authored spellings matter independently of the HTML ones: this sanitiser
			 * necessarily runs BEFORE the shared renderer's markdown parser, so `![x](url)` is not
			 * HTML and no HTML filter can see it. The `<div>` wrapper is what closes that hole, by
			 * making the whole message a CommonMark HTML block that remark passes through verbatim.
			 */
			it('renders no <img> for a markdown image, and keeps its text visible', () => {
				renderDialog(makeServerMessagesError('Refused ![pixel](https://tracker.example/p.png) here'))

				expect(getBanner().querySelector('img')).toBeNull()
				expect(getBannerMessageText()).toContain('Refused')
				// Not silently deleted either - the reviewer still sees what the server wrote.
				expect(getBannerMessageText()).toContain('tracker.example')
			})

			it('renders no anchor for a markdown link to another origin', () => {
				renderDialog(makeServerMessagesError('Refused [click here](https://phish.example/login) now'))

				expect(getBanner().querySelector('a')).toBeNull()
				expect(getBannerMessageText()).toContain('click here')
			})

			it('renders no anchor for a bare GFM autolink literal', () => {
				renderDialog(makeServerMessagesError('Refused, see https://phish.example/login for details'))

				expect(getBanner().querySelector('a')).toBeNull()
				expect(getBannerMessageText()).toContain('https://phish.example/login')
			})
		})

		describe('the same-origin link boundary', () => {
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

			it('keeps a fragment and a plain relative reference', () => {
				renderDialog(
					makeServerMessagesError('See <a href="#details">details</a> or <a href="rules">rules</a>')
				)

				const hrefs = Array.from(getBanner().querySelectorAll('a')).map((a) => a.getAttribute('href'))
				expect(hrefs).toEqual(['#details', 'rules'])
			})

			/*
			 * The BACKSLASH spellings are the subtle ones. WHATWG URL parsing - what every browser and
			 * jsdom implement - folds `\` into `/` inside an http(s) URL, so each of these resolves to
			 * an entirely different origin while carrying neither an explicit scheme nor a leading `//`
			 * for a purely syntactic test to catch.
			 */
			it.each([
				['an absolute URL', 'https://phish.example/login'],
				['a scheme-relative network path', '//phish.example/login'],
				['a double-backslash network path', '\\\\phish.example/login'],
				['a slash-backslash network path', '/\\phish.example/login'],
				['a backslash-slash network path', '\\/phish.example/login'],
				['a javascript: URL', 'javascript:window.__pwned=true'],
				['a data: URL', 'data:text/html,<script>window.__pwned=true</script>'],
				['a scheme split by a control character', 'java\nscript:window.__pwned=true'],
				['an unparseable reference', '////'],
				['an empty destination', '']
			])('unwraps an anchor whose destination is %s, keeping the text', (_label, href) => {
				renderDialog(makeServerMessagesError(`Open <a href="${href}">the record</a> to continue`))

				expect(getBanner().querySelector('a')).toBeNull()
				expect(getBannerMessageText()).toContain('the record')
				expect(getBannerMessageText()).toContain('to continue')
				expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
			})

			it('proves the backslash spellings really do resolve off this origin', () => {
				// Non-vacuous companion to the table above: if jsdom ever stopped folding backslashes
				// these would resolve to this origin and the refusals above would be testing nothing.
				for (const href of ['\\\\phish.example/login', '/\\phish.example/login', '\\/phish.example/login']) {
					expect(new URL(href, window.location.href).origin).not.toBe(window.location.origin)
				}
			})
		})

		describe('UI-redress attributes', () => {
			it('removes class and id, the two attributes that can cover or re-label the dialog', () => {
				renderDialog(
					makeServerMessagesError(
						'<span class="fixed inset-0 z-50 bg-surface-white" id="radix-title">Refused</span>'
					)
				)

				const span = getBanner().querySelector('span')
				expect(span).not.toBeNull()
				expect(span?.getAttribute('class')).toBeNull()
				expect(span?.getAttribute('id')).toBeNull()
				expect(getBannerMessageText()).toContain('Refused')
			})

			it('removes inline style', () => {
				renderDialog(
					makeServerMessagesError('<span style="position:fixed;inset:0">Refused</span>')
				)

				expect(getBanner().querySelector('span')?.getAttribute('style')).toBeNull()
			})

			it('keeps a distinctive server title as TEXT, with any markup in it stripped', () => {
				renderDialog(
					makeFrappeError({
						_server_messages: encodeServerMessages({
							message: 'Allocated amount exceeds the unallocated amount',
							title: 'Over-<script>window.__pwned=true</script>allocation',
							indicator: 'red'
						})
					})
				)

				expect(getBannerHeading()).toBe('Over-allocation')
				expect(getBanner().querySelector('[data-slot="alert-title"] script')).toBeNull()
				expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
			})
		})

		it('discards an HTML comment, which carries nothing renderable', () => {
			renderDialog(
				makeServerMessagesError('Refused<!-- internal: retry queue 7 --> — check the file')
			)

			expect(getBannerMarkup()).not.toContain('<!--')
			expect(getBannerMessageText()).not.toContain('retry queue 7')
			expect(getBannerMessageText()).toContain('Refused')
			expect(getBannerMessageText()).toContain('check the file')
		})

		it('unwraps an unknown-but-harmless tag, keeping every word inside it', () => {
			// Unwrapped rather than dropped: the tag is not on the allow-list, but its CONTENT is text
			// the server wrote and losing it would tell the reviewer less than the server did.
			renderDialog(
				makeServerMessagesError('Refused: <frappe-widget>the bank account is disabled</frappe-widget>')
			)

			expect(getBanner().querySelector('frappe-widget')).toBeNull()
			expect(getBannerMessageText()).toContain('the bank account is disabled')
		})

		it('keeps the structural markup a validation summary legitimately uses', () => {
			renderDialog(
				makeServerMessagesError(
					'Fix the following:<ul><li>Row <b>1</b>: no date</li><li>Row 2: no amount</li></ul>'
				)
			)

			const banner = getBanner()
			expect(banner.querySelectorAll('li')).toHaveLength(2)
			expect(banner.querySelector('b')).not.toBeNull()
			expect(getBannerMessageText()).toContain('Row 2: no amount')
		})
	})

	/*
	 * ================================================================================================
	 * MALFORMED ENVELOPES (FM1)
	 *
	 * `_server_messages` is server-controlled and only CONVENTIONALLY well formed. The shared parser
	 * used to call `JSON.parse` on it unguarded, and that expression sat in front of every safety
	 * action the failure paths perform - so a truncated or rewritten body did not garble the message,
	 * it threw out of the handler and abandoned the dialog, the per-file failure marker, the cleared
	 * selection and the revalidations. These cases pin the parser as TOTAL: the dialog must still
	 * open, and must still say something the reviewer can act on.
	 * ============================================================================================== */
	describe('survives a malformed `_server_messages` envelope', () => {
		it('falls through to `exception` when the envelope is not valid JSON at all', () => {
			expect(() =>
				renderDialog(
					makeFrappeError({
						_server_messages: '[{"message":"Reconciliation refu',
						exception: 'frappe.exceptions.ValidationError: Bank Account is disabled'
					})
				)
			).not.toThrow()

			expect(getDialogContent()).toBeInTheDocument()
			expect(getBannerMessageText()).toContain('Bank Account is disabled')
		})

		it('falls through to `message` when the envelope is valid JSON but not an array', () => {
			renderDialog(
				makeFrappeError({
					_server_messages: '{"message":"Reconciliation refused"}',
					exception: '',
					message: 'Internal Server Error'
				})
			)

			expect(getDialogContent()).toBeInTheDocument()
			expect(getBannerMessageText()).toBe('Internal Server Error')
		})

		it('normalises a SINGLY encoded element instead of rendering an empty banner', () => {
			// Frappe's convention is double encoding, so the inner parse is what turns an element into
			// an object. A bare string has no `message` property and used to render as `undefined`.
			renderDialog(
				makeFrappeError({
					_server_messages: JSON.stringify(['Bank Transaction is already fully reconciled'])
				})
			)

			expect(getBannerMessageText()).toBe('Bank Transaction is already fully reconciled')
			expect(getBannerHeading()).toBe(COLLAPSED_HEADING)
		})

		it('ignores an entry carrying no `message` and uses the text available elsewhere', () => {
			renderDialog(
				makeFrappeError({
					_server_messages: JSON.stringify([JSON.stringify({ title: 'Message', indicator: 'red' })]),
					exception: 'frappe.exceptions.ValidationError: The bank account is disabled'
				})
			)

			expect(getDialogContent()).toBeInTheDocument()
			expect(getBannerMessageText()).toContain('The bank account is disabled')
		})

		it('still opens, with an honest heading, when no field carries any text at all', () => {
			renderDialog(
				makeFrappeError({
					_server_messages: 'not json',
					exception: '',
					message: ''
				})
			)

			expect(getDialogContent()).toBeInTheDocument()
			expect(screen.getByText(DIALOG_TITLE)).toBeInTheDocument()
			expect(getBannerMessageText()).toBe('No further details were returned.')
			expect(screen.getByRole('button', { name: DISMISS_LABEL })).toBeInTheDocument()
		})
	})

	/*
	 * Severity is the SERVER's call and the whole of it: the shared banner themes on
	 * `messages[0]?.indicator === 'yellow'` and makes no judgement of its own, so a client that
	 * decided severity for itself could paint a hard refusal as an advisory.
	 */
	describe("severity follows the server's own indicator", () => {
		it("renders amber when the server marked its message 'yellow'", () => {
			renderDialog(makeWarningServerMessagesError('Statement already imported for this period'))

			const banner = getBanner()
			expect(banner).toHaveClass('text-ink-amber-3')
			expect(banner).toHaveClass('bg-surface-amber-2')
			expect(banner).not.toHaveClass('text-ink-red-3')
		})

		it('renders red for any other indicator', () => {
			renderDialog(makeServerMessagesError('Hard refusal'))

			const banner = getBanner()
			expect(banner).toHaveClass('text-ink-red-3')
			expect(banner).toHaveClass('bg-surface-red-2')
			expect(banner).not.toHaveClass('text-ink-amber-3')
		})

		it('renders red when the server sent no indicator at all', () => {
			// The colon-slice branch pushes an entry with NO `indicator` (`lib/frappe.ts:153-156`), so
			// this is the "unknown severity" case, and the safe reading of unknown is red.
			renderDialog(makeExceptionError('Bank Account is disabled'))

			expect(getBanner()).toHaveClass('text-ink-red-3')
		})

		it('tracks the server rather than fixing a severity of its own', () => {
			// The proof that the dialog forwards NO `theme` prop. `ErrorBanner` spreads its remaining
			// props AFTER the theme it computed (`ui/error-banner.tsx:39`), so a `theme` passed by the
			// dialog would override the server's choice and pin both renders to the same value. They
			// differ, so nothing is being overridden.
			const { unmount } = renderDialog(makeWarningServerMessagesError('Careful now'))
			const amber = getBanner().className
			unmount()

			renderDialog(makeServerMessagesError('Hard refusal'))
			const red = getBanner().className

			expect(amber).not.toBe(red)
			expect(amber).toContain('text-ink-amber-3')
			expect(red).toContain('text-ink-red-3')
		})
	})

	describe('structure', () => {
		it('renders the canonical alert-dialog skeleton', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			const content = getDialogContent()
			expect(content).toBe(document.querySelector('[data-slot="alert-dialog-content"]'))
			expect(content).toHaveAttribute('data-size', 'default')
			// Radix marks the rest of the page inert but does not emit `aria-modal` itself.
			expect(content).toHaveAttribute('aria-modal', 'true')

			expect(content.querySelector('[data-slot="alert-dialog-header"]')).not.toBeNull()
			expect(content.querySelector('[data-slot="alert-dialog-title"]')?.textContent).toBe(
				DIALOG_TITLE
			)
			expect(content.querySelector('[data-slot="alert-dialog-description"]')?.textContent).toBe(
				DIALOG_DESCRIPTION
			)

			const footer = content.querySelector('[data-slot="alert-dialog-footer"]')
			expect(footer).not.toBeNull()

			const action = content.querySelector('[data-slot="alert-dialog-action"]')
			expect(footer?.contains(action ?? null)).toBe(true)
			expect(action?.textContent).toBe(DISMISS_LABEL)
			expect(screen.getByRole('button', { name: DISMISS_LABEL })).toBe(action)

			expect(content.querySelector('[data-slot="alert-dialog-cancel"]')).toBeNull()
		})

		it('portals its overlay and content directly into the document body', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			const content = getDialogContent()
			const overlay = getOverlay()

			// Radix's portal renders NO wrapper of its own - `data-slot="alert-dialog-portal"` never
			// reaches the DOM - so the overlay and the content are direct children of <body>, flanked
			// by Radix's two focus guards.
			expect(content.parentElement).toBe(document.body)
			expect(overlay.parentElement).toBe(document.body)

			// The overlay paints beneath the content, so it must precede it in document order.
			const bodyChildren = Array.from(document.body.children)
			expect(bodyChildren.indexOf(content)).toBeGreaterThan(bodyChildren.indexOf(overlay))
		})

		/**
		 * The CONTENT WIDTH, which is a specified contract rather than a styling choice — and which
		 * has to be a RESPONSIVE contract, not a bare minimum.
		 *
		 * The Agent Action Plan fixes the widened form by reference to the folder's canonical modal
		 * — "Follow the unreconcile modal's structure exactly, INCLUDING ITS CONTENT WIDTH"
		 * (§0.8.2.2) — and that modal widens itself with `min-w-2xl`
		 * (`BankTransactionUnreconcileModal.tsx:37`). But `min-width` beats `max-width` in CSS, so
		 * applying 42rem unconditionally overrode the primitive's own `max-w-[calc(100%-2rem)]` and
		 * forced a 672px box onto a 375px viewport, carrying the only Dismiss control off-screen
		 * horizontally. The importer routes have no desktop-only gate, so that viewport is reachable.
		 *
		 * So the assertion is deliberately on the BREAKPOINT-QUALIFIED class and on the ABSENCE of
		 * the unqualified one: `md` (768px) is the first default breakpoint that can hold 672px
		 * inside the primitive's 2rem gutter (768 − 32 = 736), and below it the primitive's own
		 * responsive width must be left to do its job. A reader who "restores" the bare class would
		 * be reintroducing the overflow, and this is what says so.
		 *
		 * The HEIGHT bound asserted alongside it is a separate, orthogonal concern — the plan
		 * specifies no height — and it is what keeps Dismiss on screen VERTICALLY for an arbitrarily
		 * long server message.
		 */
		it('widens only from md upwards, so the narrow-viewport width stays the primitive\'s', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))
			const content = getDialogContent()

			// The canonical pattern's width, gated behind a breakpoint wide enough to hold it.
			expect(content).toHaveClass('md:min-w-2xl')

			// And NOT applied unconditionally. Tailwind class lists are space-separated, so the
			// qualified class cannot satisfy this check by substring.
			expect(content.className.split(/\s+/)).not.toContain('min-w-2xl')

			// The primitive's own ladder is still underneath it, untouched — this dialog adds a
			// breakpoint-scoped minimum width, it does not restyle the primitive. Below `md` these
			// two are therefore the only width rules in play, which is the mobile contract.
			expect(content).toHaveClass('max-w-[calc(100%-2rem)]')
			expect(content).toHaveClass('data-[size=default]:sm:max-w-lg')

			expect(content).toHaveClass('max-h-[90vh]')

			// And the bound has to actually bite. The primitive is `display: grid` with implicit
			// rows, and `max-height` does not shrink an `auto` track — so without a named middle
			// track the message row sizes to its content, the scroller below never activates, and
			// the footer holding the only Dismiss control paints outside the clamped box.
			expect(content).toHaveClass('grid-rows-[auto_minmax(0,1fr)_auto]')
		})

		it('scrolls the message region so the header and Dismiss stay in view', () => {
			renderDialog(makeServerMessagesError('x'.repeat(4000)))

			const scroller = getBanner().parentElement
			expect(scroller).toHaveClass('overflow-y-auto')
			expect(scroller).toHaveClass('min-h-0')
			expect(screen.getByRole('button', { name: DISMISS_LABEL })).toBeInTheDocument()

			// The scroller must be the MIDDLE of exactly three children, because the track template
			// names exactly three tracks. A fourth child would land in an implicit `auto` row and
			// reintroduce the overflow.
			const content = getDialogContent()
			expect(content.children).toHaveLength(3)
			expect(content.children[1]).toBe(scroller)
		})
	})

	/*
	 * Dismissal clears only the error atom; the calling hook owns refresh and posting state.
	 */
	describe('dismissal', () => {
		it('clears the atom when Dismiss is pressed and removes the dialog', async () => {
			const user = userEvent.setup()
			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'))

			await user.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
			expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull()
		})

		it('clears the atom when Escape is pressed', async () => {
			// Radix funnels Escape through the same `onOpenChange(false)` the action button uses, so
			// the keyboard route has to end in the identical state.
			const user = userEvent.setup()
			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'))

			await user.keyboard('{Escape}')

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
			expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
		})

		it('leaves every other piece of reconciliation state byte-identical', async () => {
			// The assertion that expresses FM1's "state unchanged". Two unrelated atoms are seeded into
			// the SAME store — the selected bank and the selected-transaction family entry — and each is
			// compared by REFERENCE afterwards, so a rebuilt equal-but-new value would fail just as
			// loudly as a cleared one.
			const bank = makeSelectedBank()
			const selection = [makeUnreconciledTransaction()]
			const selectionAtom = bankRecSelectedTransactionAtom(TEST_BANK_ACCOUNT)

			const user = userEvent.setup()
			const { store } = renderDialog(makeAlreadyReconciledError('ACC-BTN-2024-00001'), (seeded) => {
				seeded.set(selectedBankAccountAtom, bank)
				seeded.set(selectionAtom, selection)
			})

			await user.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})

			expect(store.get(selectedBankAccountAtom)).toBe(bank)
			expect(store.get(selectionAtom)).toBe(selection)
			expect(store.get(selectionAtom)).toHaveLength(1)
		})

		it('issues no request and triggers no revalidation of its own', async () => {
			const user = userEvent.setup()
			renderDialog(makeServerMessagesError('Nothing was posted'))

			expect(frappePostCall).not.toHaveBeenCalled()
			expect(frappeSWRMutate).not.toHaveBeenCalled()

			await user.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			expect(frappePostCall).not.toHaveBeenCalled()
			expect(frappeSWRMutate).not.toHaveBeenCalled()
		})

		it('is not dismissed by a click outside, because the refusal must be acknowledged', async () => {
			// `AlertDialog` suppresses interact-outside deliberately: a stray click must not discard
			// the only account the user has of what the server refused. Escape and Dismiss are what
			// make it dismissible, and they are the only two.
			//
			// `pointerEventsCheck` is disabled because Radix sets `pointer-events: none` on <body>
			// while a modal is open; jsdom computes no layout, so the guard would reject the click
			// before it reached the overlay and the test would prove nothing.
			const user = userEvent.setup({ pointerEventsCheck: 0 })
			const error = makeServerMessagesError('Nothing was posted')
			const { store } = renderDialog(error)

			await user.click(getOverlay())

			expect(store.get(bankRecErrorDialogAtom)).toBe(error)
			expect(screen.getByRole('alertdialog')).toBeInTheDocument()
		})
	})

	/**
	 * Focus management. This is not decoration: the dialog is atom-driven and has no trigger, so
	 * Radix's own "restore to the previously-focused element" resolves to `<body>` — which strands
	 * a keyboard user at the top of the page every time a post is refused, on the surface where
	 * they were mid-task. The dialog therefore tracks focus continuously and restores it itself,
	 * and each test below pins a distinct branch of that logic.
	 */
	describe('focus management', () => {
		it('moves focus to Dismiss when the failure surfaces', () => {
			// There is no cancel control, so Radix has no default target to seed its focus scope
			// with; naming Dismiss keeps the focus trap authoritative and gives the keyboard user
			// something to act on immediately.
			const { raise } = renderWithInvoker()

			raise(makeServerMessagesError('Nothing was posted'))

			expect(screen.getByRole('button', { name: DISMISS_LABEL })).toHaveFocus()
		})

		it('returns focus to the control that was focused when the failure surfaced', async () => {
			const user = userEvent.setup()
			const { raise } = renderWithInvoker()
			const invoker = screen.getByRole('button', { name: 'Confirm match' })

			// Focus first, THEN raise — the real order, and the reason the dialog cannot simply read
			// `document.activeElement` when it opens.
			invoker.focus()
			raise(makeAlreadyReconciledError('ACC-BTN-2024-00001'))
			expect(screen.getByRole('button', { name: DISMISS_LABEL })).toHaveFocus()

			await user.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			// Back where the user left off, not on <body>. Note this also proves the tracker ignores
			// focus moving INTO the dialog: Dismiss took focus on open, and had that been recorded
			// the dialog would have tried to restore focus to its own detached button.
			await waitFor(() => {
				expect(invoker).toHaveFocus()
			})
		})

		/**
		 * The PRODUCTION state of the invoker, and the one a plain `isConnected` check gets wrong.
		 *
		 * After a refused post the reconcile control is still mounted and still connected — but the
		 * confirm guard has disabled it, because the refreshed `status` / `unallocated_amount` now
		 * say the transaction is already reconciled. `HTMLElement.focus()` is a silent no-op on a
		 * disabled control, so suppressing Radix's default restoration and then calling `.focus()`
		 * on it left keyboard focus on `<body>`: no error message, no control, nothing to Tab from.
		 *
		 * The region fallback must therefore be reached on the strength of FOCUSABILITY, not mere
		 * presence. Note the invoker is asserted to still be in the document, so this cannot be
		 * mistaken for the detached-invoker case above.
		 */
		it("falls back to the region when the invoker is still connected but disabled", async () => {
			const user = userEvent.setup()
			const { raise, disableInvoker } = renderWithInvoker()
			const invoker = screen.getByRole('button', { name: 'Confirm match' })

			invoker.focus()
			raise(makeAlreadyReconciledError('ACC-BTN-2024-00001'))

			// The guard closes the control while the dialog is open — exactly the real sequence. React
			// reuses the DOM node for a prop-only change, so `invoker` still points at the live
			// element; it is asserted on directly because an open Radix dialog hides everything
			// outside itself from the accessibility tree, which would make a role query unusable here
			// and, worse, indistinguishable from the element having been removed.
			disableInvoker()
			expect(invoker).toBeDisabled()
			expect(invoker.isConnected).toBe(true)
			expect(document.body.contains(invoker)).toBe(true)

			await user.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Create voucher' })).toHaveFocus()
			})
			// And explicitly NOT stranded on <body>, which is what the defect produced.
			expect(document.body).not.toHaveFocus()
		})

		it("falls back to the region's first control when the invoker no longer exists", async () => {
			const user = userEvent.setup()
			const { raise, dropInvoker } = renderWithInvoker()

			screen.getByRole('button', { name: 'Confirm match' }).focus()
			raise(makeAlreadyReconciledError('ACC-BTN-2024-00001'))

			// A rejection is followed by a revalidation, which can replace the invoking control's
			// subtree. The captured element is then detached and focusing it would be a no-op.
			dropInvoker()
			expect(screen.queryByRole('button', { name: 'Confirm match' })).toBeNull()

			await user.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Create voucher' })).toHaveFocus()
			})
		})

		it('ignores a focus event whose target is not an element', async () => {
			// `focusin` is listened for on `document` in the capture phase, so an event whose target
			// is the document itself does reach the handler. Recording it would leave the dialog
			// holding a non-focusable "invoker" and throw on close, so the guard is load-bearing —
			// and its effect is observable: the real invoker is still restored.
			const user = userEvent.setup()
			const { raise } = renderWithInvoker()
			const invoker = screen.getByRole('button', { name: 'Confirm match' })

			invoker.focus()
			document.dispatchEvent(new FocusEvent('focusin'))

			raise(makeServerMessagesError('Nothing was posted'))
			await user.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			await waitFor(() => {
				expect(invoker).toHaveFocus()
			})
		})
	})
})
