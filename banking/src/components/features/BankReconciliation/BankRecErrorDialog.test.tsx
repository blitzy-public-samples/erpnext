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
	bankRecReconcileSettlingAtom,
	bankRecSelectedTransactionAtom,
	selectedBankAccountAtom
} from './bankRecAtoms'

/*
 * Frappe messages are server-controlled, so every fragment here - a live stylesheet, inline event
 * handlers, executable script and the two `javascript:` URL-scheme forms - could arrive inside
 * `_server_messages`. Each is asserted separately below.
 */
const HOSTILE_MESSAGE =
	'Import failed. <style id="pwned-style">body{display:none}</style>' +
	'<span id="pwned-span" onclick="window.__pwned = true">click me</span>' +
	'<img id="pwned-img" src="x" onerror="window.__pwned = true" />' +
	'<script id="pwned-script">window.__pwned = true</script>' +
	'<a id="pwned-anchor" href="javascript:window.__pwned = true">link</a>' +
	'[markdown link](javascript:window.__pwned = true)'

const HOSTILE_IDS = ['#pwned-style', '#pwned-span', '#pwned-img', '#pwned-script', '#pwned-anchor']

/*
 * None of this payload is script; every fragment is presentational, which is what makes it dangerous
 * in an application whose Tailwind utilities are already compiled into the shipped stylesheet. One
 * server-controlled `class` can cover the real UI, a colliding `id` can rewrite what a screen reader
 * announces, and an `<input>` or off-site `<a href>` can present a credential prompt as the product's
 * own.
 */
const REDRESS_MESSAGE =
	'Session expired. <div id="redress-overlay" class="fixed inset-0 z-50 bg-surface-white p-6">' +
	'<p class="text-2xl">Re-enter your password to continue</p>' +
	'<input id="redress-input" type="password" name="password" placeholder="Password" />' +
	'<a id="redress-external" href="https://evil.example.com/login">Sign in</a>' +
	'<a id="redress-scheme-relative" href="//evil.example.com/login">Continue</a>' +
	/*
	 * The same off-site destination written with BACKSLASHES. WHATWG URL parsing - what every
	 * browser and jsdom implement - folds `\` into `/` inside an http(s) URL, so all three of
	 * these resolve to `evil.example.com` exactly as the two forms above do, while carrying
	 * neither a scheme nor a leading `//` for a purely syntactic test to catch. They are the
	 * forms a sanitiser that compares characters instead of canonicalising will let through.
	 */
	'<a id="redress-backslash" href="\\\\evil.example.com/login">Proceed</a>' +
	'<a id="redress-slash-backslash" href="/\\evil.example.com/login">Verify</a>' +
	'<a id="redress-backslash-slash" href="\\/evil.example.com/login">Confirm</a>' +
	'</div>'

/**
 * Every off-site destination the sanitiser must refuse, paired with the text that must survive
 * it. Each is asserted on its own below, so a regression in one form cannot hide behind the
 * others being caught.
 *
 * `HOSTILE_HOST` is the host jsdom's own URL parser resolves each of them to - asserted first,
 * so the payloads are demonstrably hostile in this environment rather than only in theory. It is
 * compared as a HOST rather than a full origin because the absolute form names its own scheme
 * while the four relative forms inherit this document's, and the point being made is the same
 * for all five: the browser, not the character sequence, decides where a link goes.
 */
const HOSTILE_HOST = 'evil.example.com'

type LinkProbe = {
	readonly label: string
	readonly href: string
	readonly text: string
}

const OFF_SITE_DESTINATIONS: readonly LinkProbe[] = [
	{ label: 'an absolute URL', href: 'https://evil.example.com/login', text: 'Sign in' },
	{ label: 'the scheme-relative form', href: '//evil.example.com/login', text: 'Continue' },
	{ label: 'two leading backslashes', href: '\\\\evil.example.com/login', text: 'Proceed' },
	{ label: 'a slash followed by a backslash', href: '/\\evil.example.com/login', text: 'Verify' },
	{ label: 'a backslash followed by a slash', href: '\\/evil.example.com/login', text: 'Confirm' }
]

/**
 * Destinations that resolve to THIS origin - so a bare origin comparison would admit every one of
 * them - and that the renderer refuses anyway. They pin the three refusals it deliberately keeps
 * stricter than origin equality, each of which stays load-bearing somewhere the origin check alone
 * is blind: a backslash makes the destination the reader sees and the one the browser computes
 * disagree, a scheme-relative URL reads as off-site whoever it happens to name, and refusing every
 * explicit scheme is what keeps `javascript:` out of a document whose own origin is opaque.
 *
 * Built from `window.location` rather than hard-coded, so they stay this document's own host and
 * origin whatever the harness serves the tests from.
 */
const STRICTLY_REFUSED_DESTINATIONS: readonly LinkProbe[] = [
	{
		label: 'a backslash inside an otherwise local path',
		href: '/app/bank-transaction\\ACC-BTN-2024-00001',
		text: 'Backslash path'
	},
	{
		label: 'the scheme-relative form naming this very host',
		href: `//${window.location.host}/app/bank-transaction/ACC-BTN-2024-00001`,
		text: 'Scheme-relative to us'
	},
	{
		label: 'an absolute URL naming this very origin',
		href: `${window.location.origin}/app/bank-transaction/ACC-BTN-2024-00001`,
		text: 'Absolute to us'
	}
]

/**
 * Destinations that point back at this application and must therefore still render, so the
 * hardening above cannot quietly turn into "no link ever survives" - which would pass every
 * hostile case while silently dropping the `/app/bank-transaction/…` links Frappe's own
 * messages carry.
 */
const SAME_ORIGIN_DESTINATIONS: readonly string[] = [
	'#reconciliation',
	'/app/bank-transaction/ACC-BTN-2024-00001',
	'app/bank-transaction/ACC-BTN-2024-00001',
	'?bank_transaction=ACC-BTN-2024-00001'
]

/** A single anchor the server wrote, as raw HTML inside a `_server_messages` entry. */
const anchorMessage = (href: string, text: string): string =>
	`Next step: <a href="${href}">${text}</a>`

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
const InvokerRegion = ({ showConfirm }: { showConfirm: boolean }) => (
	<div data-slot="tabs-content">
		{showConfirm ? <button type="button">Confirm match</button> : null}
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
	const tree = (showConfirm: boolean) => (
		<Provider store={store}>
			<InvokerRegion showConfirm={showConfirm} />
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
		dropInvoker: () => rerender(tree(false))
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
				expect(description?.querySelectorAll('p')).toHaveLength(2)
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
		 * The CONTENT WIDTH, which is a specified contract rather than a styling choice.
		 *
		 * The Agent Action Plan fixes it by reference to the folder's canonical modal — "Follow the
		 * unreconcile modal's structure exactly, INCLUDING ITS CONTENT WIDTH" (§0.8.2.2), "Content
		 * width follows the unreconcile modal precedent" (§0.8.5.2) — and that modal widens itself
		 * with `min-w-2xl` (`BankTransactionUnreconcileModal.tsx:37`). Asserting the class is
		 * therefore checking a deliberate PATTERN MATCH, which is exactly why it belongs in a test:
		 * a later reader who replaced it with a `max-width` ladder by eye would be departing from
		 * the plan, and this assertion is what says so.
		 *
		 * The HEIGHT bound asserted alongside it is a separate, orthogonal concern — the plan
		 * specifies no height — and it is what keeps the only Dismiss control on screen for an
		 * arbitrarily long server message.
		 */
		it('carries the pattern\'s min-w-2xl content width, and bounds its height', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))
			const content = getDialogContent()

			// The canonical pattern's width class, present verbatim.
			expect(content.className).toContain('min-w-2xl')
			expect(content).toHaveClass('min-w-2xl')

			// The primitive's own ladder is still underneath it, untouched — this dialog adds a
			// minimum width, it does not restyle the primitive.
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
	 * Raw server HTML is parsed into real nodes by `rehypeRaw`; the allow-list sanitiser that runs
	 * immediately afterwards must prevent active DOM.
	 */
	describe('server-controlled text is inert (CWE-79 regression)', () => {
		it('mounts no element, stylesheet, script or handler from hostile HTML', () => {
			renderDialog(makeServerMessagesError(HOSTILE_MESSAGE))
			const dialog = getDialogContent()

			// Nothing from the payload became an element — swept DOCUMENT-wide rather than only
			// within the dialog, so a node escaping into the portal root or back into the React
			// container is caught just the same.
			HOSTILE_IDS.forEach((id) => {
				expect(document.querySelector(id)).toBeNull()
			})

			expect(dialog.querySelectorAll('style')).toHaveLength(0)
			expect(dialog.querySelectorAll('script')).toHaveLength(0)
			expect(dialog.querySelectorAll('img')).toHaveLength(0)
			expect(dialog.querySelectorAll('a')).toHaveLength(0)

			dialog.querySelectorAll('*').forEach((element) => {
				expect(element.getAttribute('onclick')).toBeNull()
				expect(element.getAttribute('onerror')).toBeNull()
			})

			expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
		})

		it("keeps the reader's text while discarding the executable payload", () => {
			renderDialog(makeServerMessagesError(HOSTILE_MESSAGE))
			const text = getDialogContent().textContent ?? ''

			// Every human-readable fragment survives: the sanitiser unwraps rather than deletes
			// wherever there is text to preserve, so no part of the server's sentence is lost.
			expect(text).toContain('Import failed.')
			expect(text).toContain('click me')
			expect(text).toContain('link')
			// A destination with spaces is not a CommonMark link, so this one stays literal text.
			expect(text).toContain('javascript:window.__pwned')
			expect(text).not.toContain('body{display:none}')
		})

		it('does not interpret a hostile URL from a message that carries no server envelope', () => {
			renderDialog(makeFrappeError({ message: HOSTILE_MESSAGE, exception: '' }))
			const dialog = getDialogContent()

			expect(dialog.querySelectorAll('a')).toHaveLength(0)
			expect(dialog.querySelectorAll('style')).toHaveLength(0)
			expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
		})
	})

	/*
	 * Presentational `class` and `id` attributes are also removed, because they can visually or
	 * accessibly redress the dialog even though they carry no script.
	 */
	describe('server-controlled text cannot redress the UI (CWE-451 regression)', () => {
		it('strips class and id, so a message cannot position or paint anything', () => {
			renderDialog(makeServerMessagesError(REDRESS_MESSAGE))
			const dialog = getDialogContent()

			expect(dialog.querySelector('#redress-overlay')).toBeNull()
			expect(dialog.querySelector('.fixed')).toBeNull()
			expect(dialog.querySelector('[class*="inset-0"]')).toBeNull()

			// No element rendered from the message carries either attribute. The dialog's own
			// chrome legitimately does, so the scan is scoped to the banner's message body.
			getBanner()
				.querySelectorAll('p *')
				.forEach((element) => {
					expect(element.getAttribute('class')).toBeNull()
					expect(element.getAttribute('id')).toBeNull()
				})
		})

		it('renders no form control from a message', () => {
			renderDialog(makeServerMessagesError(REDRESS_MESSAGE))
			const dialog = getDialogContent()

			expect(dialog.querySelector('#redress-input')).toBeNull()
			expect(
				dialog.querySelectorAll('input, textarea, select, button[type="submit"], form')
			).toHaveLength(0)
		})

		it('refuses an off-site destination in every form, including the backslash ones', () => {
			renderDialog(makeServerMessagesError(REDRESS_MESSAGE))
			const dialog = getDialogContent()

			expect(dialog.querySelectorAll('a')).toHaveLength(0)
			expect(dialog.querySelector('[href*="evil.example.com"]')).toBeNull()
			// Swept by attribute VALUE as well, so the assertion does not depend on which element
			// a stray destination ends up on: NOTHING rendered from this message may name that host.
			dialog.querySelectorAll('[href]').forEach((element) => {
				expect(element.getAttribute('href')).not.toContain(HOSTILE_HOST)
			})

			// The link TEXT of every refused destination is still shown, so nothing the server
			// wrote is hidden from the user.
			OFF_SITE_DESTINATIONS.forEach(({ text }) => {
				expect(dialog.textContent).toContain(text)
			})
		})

		/*
		 * The characters the server wrote are NOT the destination: the browser canonicalises them
		 * first. This asserts that canonicalisation directly, through jsdom's own URL parser - the
		 * same one the production predicate resolves with - so every payload here is demonstrably
		 * hostile in this environment rather than presumed to be.
		 */
		it.each(OFF_SITE_DESTINATIONS)(
			'resolves $label to another origin, which is what makes it hostile',
			({ href }) => {
				const resolved = new URL(href, window.location.href)

				expect(resolved.host).toBe(HOSTILE_HOST)
				expect(resolved.origin).not.toBe(window.location.origin)
			}
		)

		it.each(OFF_SITE_DESTINATIONS)('renders no anchor for $label', ({ href, text }) => {
			renderDialog(makeServerMessagesError(anchorMessage(href, text)))
			const dialog = getDialogContent()

			// No anchor at all - not an href-less one, and not one pointing anywhere.
			expect(dialog.querySelectorAll('a')).toHaveLength(0)
			// Swept DOCUMENT-wide rather than only within the dialog, so a node escaping into the
			// portal root or back into the React container is caught just the same.
			document.querySelectorAll('[href]').forEach((element) => {
				expect(element.getAttribute('href')).not.toContain(HOSTILE_HOST)
			})
			// The sentence is intact, including the destination as literal text.
			expect(dialog.textContent).toContain(text)
		})

		/*
		 * Everything below resolves to THIS origin, so it is refused by a rule that is deliberately
		 * stricter than "same origin". Pinning those rules is what stops the predicate being
		 * simplified back down to a single origin comparison, which would reopen the backslash
		 * bypass wherever the document's own origin is opaque and would start honouring absolute
		 * URLs this renderer has never honoured.
		 */
		it.each(STRICTLY_REFUSED_DESTINATIONS)(
			'resolves $label to this very origin, which is what makes refusing it a choice',
			({ href }) => {
				expect(new URL(href, window.location.href).origin).toBe(window.location.origin)
			}
		)

		it.each(STRICTLY_REFUSED_DESTINATIONS)('refuses $label all the same', ({ href, text }) => {
			renderDialog(makeServerMessagesError(anchorMessage(href, text)))
			const dialog = getDialogContent()

			expect(dialog.querySelectorAll('a')).toHaveLength(0)
			expect(dialog.textContent).toContain(text)
		})

		it.each(['', '   '])('refuses a link whose destination is empty (%j)', (href) => {
			// Nothing to navigate to, so nothing that should look navigable. The whitespace-only
			// form is the same case once the control-character strip has run.
			renderDialog(makeServerMessagesError(anchorMessage(href, 'Empty destination')))
			const dialog = getDialogContent()

			expect(dialog.querySelectorAll('a')).toHaveLength(0)
			expect(dialog.textContent).toContain('Empty destination')
		})

		it('refuses a destination the URL parser cannot resolve at all, without throwing', () => {
			// `////` is a network path with an empty host: `new URL('////', location.href)` THROWS.
			// The sanitiser must answer "not ours" rather than let that escape and take down the
			// very dialog that is reporting the failure.
			expect(() => new URL('////', window.location.href)).toThrow()

			renderDialog(makeServerMessagesError(anchorMessage('////', 'Retry')))
			const dialog = getDialogContent()

			expect(dialog).toBeInTheDocument()
			expect(dialog.querySelectorAll('a')).toHaveLength(0)
			expect(dialog.textContent).toContain('Retry')
		})

		it('still renders a same-origin document link the server offered', () => {
			renderDialog(
				makeServerMessagesError(
					'See <a href="/app/bank-transaction/ACC-BTN-2024-00001">ACC-BTN-2024-00001</a>'
				)
			)
			const anchor = getDialogContent().querySelector('a')

			expect(anchor).not.toBeNull()
			expect(anchor).toHaveAttribute('href', '/app/bank-transaction/ACC-BTN-2024-00001')
			expect(anchor).toHaveAttribute('rel', 'noreferrer noopener')
			expect(anchor).not.toHaveAttribute('target')
		})

		it.each(SAME_ORIGIN_DESTINATIONS)('still renders the destination %s, which is ours', (href) => {
			// The guard against over-correcting: refusing every link would satisfy each hostile
			// case above while dropping the document links Frappe's own messages carry.
			expect(new URL(href, window.location.href).origin).toBe(window.location.origin)

			renderDialog(makeServerMessagesError(anchorMessage(href, 'Open the record')))
			const anchor = getDialogContent().querySelector('a')

			expect(anchor).not.toBeNull()
			expect(anchor).toHaveAttribute('href', href)
			expect(anchor).toHaveAttribute('rel', 'noreferrer noopener')
		})

		/*
		 * The invariant the whole boundary reduces to, asserted on a payload that mixes both kinds
		 * so it cannot pass vacuously: whatever survives, EVERY surviving destination resolves to
		 * this origin - which is exactly the question the browser answers when the link is clicked.
		 */
		it('leaves no surviving anchor whose destination resolves off this origin', () => {
			const message =
				anchorMessage('/app/bank-transaction/ACC-BTN-2024-00001', 'Open the record') +
				OFF_SITE_DESTINATIONS.map(({ href, text }) => ` <a href="${href}">${text}</a>`).join('')

			renderDialog(makeServerMessagesError(message))
			const anchors = Array.from(getDialogContent().querySelectorAll('a'))

			// Non-vacuous: the legitimate link is there to be found.
			expect(anchors).toHaveLength(1)

			anchors.forEach((anchor) => {
				const href = anchor.getAttribute('href') ?? ''
				expect(new URL(href, window.location.href).origin).toBe(window.location.origin)
			})
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
			// The assertion that expresses FM1's "state unchanged". Three unrelated atoms are seeded
			// into the SAME store — the selected bank, the selected-transaction family entry, and the
			// in-flight settling flag — and each is compared by REFERENCE afterwards, so a rebuilt
			// equal-but-new value would fail just as loudly as a cleared one.
			const bank = makeSelectedBank()
			const selection = [makeUnreconciledTransaction()]
			const selectionAtom = bankRecSelectedTransactionAtom(TEST_BANK_ACCOUNT)

			const user = userEvent.setup()
			const { store } = renderDialog(makeAlreadyReconciledError('ACC-BTN-2024-00001'), (seeded) => {
				seeded.set(selectedBankAccountAtom, bank)
				seeded.set(selectionAtom, selection)
				seeded.set(bankRecReconcileSettlingAtom, true)
			})

			await user.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})

			expect(store.get(selectedBankAccountAtom)).toBe(bank)
			expect(store.get(selectionAtom)).toBe(selection)
			expect(store.get(selectionAtom)).toHaveLength(1)
			// The settling flag belongs to the reconcile hook, which owns the revalidation that
			// follows a rejection. Dismissing the dialog must not release it early — doing so would
			// re-enable confirm against a snapshot the client has just been told is unreliable.
			expect(store.get(bankRecReconcileSettlingAtom)).toBe(true)
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
