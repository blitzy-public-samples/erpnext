/**
 * `BankRecErrorDialog` — the dismissible error dialog FM1 and FM3 both require.
 *
 * This suite covers mandated scenario TC6 (*a failed confirm/post leaves the transaction
 * unreconciled with no partial posting*) from the PRESENTATION side. The server-side half of
 * TC6 is structural rather than testable from here: the already-reconciled guard is the FIRST
 * statement of the first method the posting endpoint invokes
 * (`bank_transaction.py:160-161`) and the whole operation commits through a single save, so a
 * partial posting on the rejection path is impossible rather than merely unlikely. What the
 * CLIENT still has to get right, and what is asserted below, is that:
 *
 *   1. nothing renders while there is no error to show;
 *   2. the server's wording reaches the user VERBATIM, through every envelope Frappe uses;
 *   3. severity is the SERVER's decision, never the dialog's;
 *   4. dismissing discards the error and changes NOTHING else — no request, no revalidation,
 *      no other atom touched (FM1's "state unchanged", and C9's no-optimistic-mutation);
 *   5. server-controlled text stays inert (CWE-79) and cannot redress the UI (CWE-451);
 *   6. the dialog and its only Dismiss control stay inside the viewport.
 *
 * ASSERTION DISCIPLINE, and why it is what it is:
 *
 *  • `AlertDialogContent` renders inside `AlertDialogPortal` (`ui/alert-dialog.tsx:52-64`), so
 *    the dialog is portaled to `document.body` and is NOT inside the tree `render()` returns.
 *    Everything is therefore queried through `screen` / `document`, and the render helper
 *    deliberately does not expose a `container` for anyone to reach for by mistake.
 *
 *  • Fixtures come from the SHARED builders in `@/test/factories`, never from a hand-written
 *    envelope. Constraint C1 makes the backend contract authoritative for shapes, and the
 *    builders are the checked transcription of it — `_server_messages`, for one, is
 *    DOUBLE-ENCODED (a JSON array whose elements are themselves JSON strings), which a
 *    hand-rolled fixture reliably gets wrong and then passes for the wrong reason.
 *
 *  • `ParsedErrorMessage` is private to both `lib/frappe.ts` and `ui/error-banner.tsx`, so
 *    parsing is asserted STRUCTURALLY through rendered output rather than by importing a type
 *    that is not exported.
 *
 *  • Severity is asserted on the theme's token CLASSES. That is a deliberate choice made after
 *    reading the primitive, not a shortcut: `ui/alert.tsx` emits `data-slot="alert"` and
 *    `role="alert"` and carries its theme ONLY in the `cva` class list (`amber` ->
 *    `text-ink-amber-3` + `bg-surface-amber-2`, `red` -> `text-ink-red-3` +
 *    `bg-surface-red-2`; `ui/alert.tsx:14-49`). There is no `data-theme` attribute to assert
 *    on, and adding one would mean editing a `ui/` primitive that 21 files depend on — which
 *    C5 forbids. The token class is therefore the only observable severity signal.
 *
 *  • Nothing here modifies a source file to make testing easier, and no `data-testid` is
 *    added anywhere: the design-system primitives already emit `data-slot` hooks.
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

// Replaces the SDK wholesale so nothing in this suite can reach the real transport. The dialog's
// own graph currently touches the package only through type-only imports, which are erased at
// transpile, so no module here loads it today — this is the suite's isolation guarantee, not a
// workaround for a specific import. It has to stay declared here because `vi.mock` is hoisted
// above the imports: a value import reintroduced anywhere beneath the dialog would otherwise
// reach the real package before any test could intervene. The SHARED helper is used rather than
// a per-suite mock so that every suite mocks the same eleven hooks with the same identities.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankRecErrorDialog from './BankRecErrorDialog'
import {
	bankRecErrorDialogAtom,
	bankRecReconcileSettlingAtom,
	bankRecSelectedTransactionAtom,
	selectedBankAccountAtom
} from './bankRecAtoms'

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

/** Every `id` the hostile payload tries to mount, swept document-wide below. */
const HOSTILE_IDS = ['#pwned-style', '#pwned-span', '#pwned-img', '#pwned-script', '#pwned-anchor']

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

/** The dialog's own chrome, which is outcome-NEUTRAL by design and states nothing about state. */
const DIALOG_TITLE = 'Something went wrong'
const DIALOG_DESCRIPTION =
	'Review the details below, then dismiss this message to continue. The server remains the authority on what was recorded.'
const DISMISS_LABEL = 'Dismiss'
/** `ui/error-banner.tsx:20-23` collapses Frappe's generic titles into this one heading. */
const COLLAPSED_HEADING = 'There was an error.'

/** The envelope shape `_server_messages` carries, mirroring `lib/frappe.ts`'s private parse target. */
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

/** The envelope type, taken from the shared builder rather than from the mocked SDK module. */
type SeededError = ReturnType<typeof makeFrappeError>
type SeededStore = ReturnType<typeof createStore>

/**
 * Renders the dialog against a FRESH jotai store, seeded with the error under test.
 *
 * A per-test store is mandatory, not stylistic: `src/test/setup.ts` performs no global jotai
 * reset (it cannot — jotai state is per-`Provider` and owned by each test file), so a shared
 * store would leak one test's error into the next.
 *
 * `seed` reaches the same store before the first render, which is how the dismissal test proves
 * that unrelated reconciliation state survives untouched. Only the store and `unmount` are
 * returned: the dialog is PORTALED, so a `container` here would only invite a query that can
 * never match.
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
		/** Surfaces a rejection the way the reconcile hook does — by writing the atom. */
		raise: (error: SeededError) => {
			act(() => {
				store.set(bankRecErrorDialogAtom, error)
			})
		},
		/** Replaces the region's contents, detaching the control that was tracked. */
		dropInvoker: () => rerender(tree(false))
	}
}

/**
 * The portaled dialog surface, resolved through its ARIA role so the query fails loudly with a
 * printed DOM rather than returning `null` and deferring the failure to a later assertion.
 * `getDialogContent` is additionally proven to BE the `alert-dialog-content` slot element.
 */
const getDialogContent = (): HTMLElement => screen.getByRole('alertdialog')

/**
 * The portaled overlay. It carries no ARIA role, so it is resolved by slot — and resolved
 * through a helper that throws rather than one that returns `null`, for the same reason
 * `getByRole` is preferred over `querySelector` everywhere else in this file.
 */
const getOverlay = (): HTMLElement => {
	const overlay = document.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]')
	if (!overlay) {
		throw new Error('The alert-dialog overlay was not rendered')
	}
	return overlay
}

/** The shared `ErrorBanner`'s root, which is where the server's severity becomes observable. */
const getBanner = (): HTMLElement => screen.getByRole('alert')

/** Exactly the text the banner renders for the server's message(s) — no chrome, no heading. */
const getBannerMessageText = (): string =>
	getBanner().querySelector('[data-slot="alert-description"]')?.textContent ?? ''

/** The heading the banner chose, which is either the server's title or the collapsed literal. */
const getBannerHeading = (): string =>
	getBanner().querySelector('[data-slot="alert-title"]')?.textContent ?? ''

describe('BankRecErrorDialog', () => {
	// `cleanup()`, `resetFrappeSDKMock()`, storage clearing and the Frappe-runtime rebuild are all
	// owned by `src/test/setup.ts`'s global hooks, so none of that is repeated here. The single
	// thing this suite installs on `window` is the injection canary, so it is the single thing
	// this suite removes.
	afterEach(() => {
		delete (window as unknown as Record<string, unknown>).__pwned
	})

	describe('when the atom holds no error', () => {
		it('starts empty, so a store nobody has written to shows nothing', () => {
			// The falsy-means-closed modal-atom convention this feature folder uses throughout.
			expect(createStore().get(bankRecErrorDialogAtom)).toBeNull()
		})

		it('renders nothing at all — no content, no overlay, no chrome, no control', () => {
			renderDialog(null)

			// `queryBy*` returns null instead of throwing, which is what makes absence assertable.
			expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull()
			expect(document.querySelector('[data-slot="alert-dialog-overlay"]')).toBeNull()
			expect(screen.queryByRole('alert')).not.toBeInTheDocument()

			// None of the dialog's own strings reach the document either, so nothing suggests a
			// failure the server never reported.
			expect(screen.queryByText(DIALOG_TITLE)).toBeNull()
			expect(screen.queryByText(DIALOG_DESCRIPTION)).toBeNull()
			expect(screen.queryByRole('button', { name: DISMISS_LABEL })).toBeNull()
		})
	})

	describe("renders the server's own words", () => {
		/**
		 * TC6 / C1. The message asserted here is the REAL server text, thrown by the guard that
		 * makes a double post impossible: `bank_transaction.py:160-161`,
		 * `frappe.throw(_("Bank Transaction {0} is already fully reconciled"))`. Both halves are
		 * checked — that the shared factory still transcribes that template exactly, and that the
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

			// EXACT equality, not containment: the rendered message is the server's sentence and
			// nothing else. Anything the client added, dropped, truncated or reworded fails here —
			// which is precisely what "no client-side paraphrasing" has to mean to be testable.
			expect(getBannerMessageText()).toBe(expected)

			// And the identifier the server named survives, so the user can act on it.
			expect(getBannerMessageText()).toContain(transaction)
		})

		/**
		 * `getErrorMessages` (`lib/frappe.ts:20-69`) resolves in a fixed order, and a rejection can
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
				// A transport-level failure: HTTP 500, no server envelope, empty `exception`. FM1's
				// "API or network failure" case, where there is no server text to preserve.
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
				// Drift guard for `encodeServerMessages`. If the shared factory's transcription of the
				// contract ever changes, the two locally-built envelopes above must change with it —
				// so this suite can never pass against an encoding the rest of the harness abandoned.
				const factoryEnvelope = makeServerMessagesError('Nothing was posted')._server_messages

				expect(
					encodeServerMessages({ message: 'Nothing was posted', title: 'Message', indicator: 'red' })
				).toBe(factoryEnvelope)
			})
		})

		/**
		 * The heading rule belongs to the SHARED banner (`ui/error-banner.tsx:20-23`), and the
		 * dialog composes it rather than restating it. These three tests are what prove that
		 * composition: a bespoke heading here would either always say the same thing or always
		 * echo the title, and could not do both.
		 */
		describe('heading', () => {
			it("collapses Frappe's generic 'Message' title into the shared friendly heading", () => {
				renderDialog(makeServerMessagesError('Hard refusal'))

				expect(getBannerHeading()).toBe(COLLAPSED_HEADING)
				expect(getBannerMessageText()).toBe('Hard refusal')
			})

			it("collapses the generic 'Error' title the same way", () => {
				// `_error_message` entries are appended with `title: 'Error'`, the parser's own choice.
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

	/**
	 * Severity is the SERVER's call, and the whole of it: the shared banner themes on
	 * `messages[0]?.indicator === 'yellow'` (`ui/error-banner.tsx:39`) and makes no judgement of
	 * its own. This matters beyond tidiness — a client that decided severity for itself would
	 * eventually paint a hard refusal as an advisory, or an advisory as a refusal, and FM1 makes
	 * the backend response the sole source of truth about what happened.
	 *
	 * Asserted on the theme's token classes because `ui/alert.tsx` emits no `data-theme`: it
	 * renders `data-slot="alert"` plus `role="alert"` and expresses the theme entirely through
	 * `cva` (`ui/alert.tsx:14-49`). See this file's header for why adding an attribute was not an
	 * option.
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
			// The colon-slice branch pushes an entry with NO `indicator` (`lib/frappe.ts:52-55`), so
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

	/**
	 * Conformance to the folder's canonical alert-dialog pattern, asserted through the
	 * `data-slot` hooks the design-system primitives already emit — so no `data-testid` has to be
	 * added to a source file (C5).
	 */
	describe('structure', () => {
		it('renders the canonical alert-dialog skeleton', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			const content = getDialogContent()
			// The role and the slot are the same element, which is what lets every other assertion
			// in this suite move freely between the two.
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

			// One dismiss control, inside the footer, and it is the accessible button a user reaches.
			const action = content.querySelector('[data-slot="alert-dialog-action"]')
			expect(footer?.contains(action ?? null)).toBe(true)
			expect(action?.textContent).toBe(DISMISS_LABEL)
			expect(screen.getByRole('button', { name: DISMISS_LABEL })).toBe(action)

			// No cancel control: an error that has already happened cannot be declined.
			expect(content.querySelector('[data-slot="alert-dialog-cancel"]')).toBeNull()
		})

		it('portals its overlay and content directly into the document body', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			const content = getDialogContent()
			const overlay = getOverlay()

			// Verified rather than assumed: Radix's portal renders NO wrapper element of its own —
			// `data-slot="alert-dialog-portal"` never reaches the DOM — so the overlay and the
			// content are direct children of <body>, flanked by Radix's two focus guards. This is
			// exactly why every query in this suite goes through `screen`/`document`: neither
			// element is inside the tree `render()` returned, and a container-scoped query would
			// find nothing.
			expect(content.parentElement).toBe(document.body)
			expect(overlay.parentElement).toBe(document.body)

			// The overlay paints beneath the content, so it must precede it in document order.
			const bodyChildren = Array.from(document.body.children)
			expect(bodyChildren.indexOf(content)).toBeGreaterThan(bodyChildren.indexOf(overlay))
		})

		/**
		 * REGRESSION — F11/M4, and a DELIBERATE, documented divergence from the folder's canonical
		 * modal pattern. `BankTransactionUnreconcileModal.tsx:37` widens itself with
		 * `min-w-2xl`; this dialog must NOT, and asserting the absence is what keeps it from being
		 * "restored" by a later reader matching the pattern by eye.
		 *
		 * A `min-w-*` beats the primitive's own `max-w-[calc(100%-2rem)]` in the cascade, which
		 * forced a fixed 672px dialog onto every viewport: measured at 375px, ~297px of the
		 * server's message sat off-screen — the one message the user most needs to read — and the
		 * only Dismiss control rendered 1952px below the fold. Widening through `max-width`
		 * instead leaves the primitive's ladder intact and adds a rung above it.
		 */
		it('carries no min-w-2xl, and bounds its width and height instead', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))
			const content = getDialogContent()

			// The canonical pattern's class, deliberately absent here — and no other minimum width
			// smuggled in under a breakpoint or state prefix either.
			expect(content.className).not.toContain('min-w-2xl')
			expect(content.className).not.toMatch(/(^|\s|:)min-w-/)

			// The complete max-width ladder, every rung inside its own range:
			//   < 640px  -> the primitive's gutter rule
			//   >= 640px -> the primitive's 512px
			//   >= 768px -> this dialog's 672px
			expect(content).toHaveClass('max-w-[calc(100%-2rem)]')
			expect(content).toHaveClass('data-[size=default]:sm:max-w-lg')
			expect(content).toHaveClass('data-[size=default]:md:max-w-2xl')

			// Qualified to match the primitive's own selector, so the two rungs sit at equal
			// specificity and Tailwind's ascending breakpoint order decides — rather than an
			// unqualified class losing to the primitive at every width.
			expect(content.className).not.toMatch(/(^|\s)md:max-w-/)

			// Bounded height, the same treatment `ui/dialog.tsx` applies to the ordinary dialog.
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


	/**
	 * REGRESSION — CWE-79. Server messages reach `ui/markdown.tsx`, which runs `rehype-raw`,
	 * so raw HTML in a `_server_messages` envelope is parsed into real nodes. The allow-list
	 * sanitiser that runs immediately afterwards is what keeps it from becoming active DOM.
	 * These assertions fail the moment that sanitiser weakens.
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

			// Not by tag name either, anywhere in the rendered dialog.
			expect(dialog.querySelectorAll('style')).toHaveLength(0)
			expect(dialog.querySelectorAll('script')).toHaveLength(0)
			expect(dialog.querySelectorAll('img')).toHaveLength(0)
			expect(dialog.querySelectorAll('a')).toHaveLength(0)

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
			const text = getDialogContent().textContent ?? ''

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
			// PATH 4 reaches the same renderer, so the sanitiser has to hold there too.
			renderDialog(makeFrappeError({ message: HOSTILE_MESSAGE, exception: '' }))
			const dialog = getDialogContent()

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

		it('refuses an off-site destination, including the scheme-relative form', () => {
			renderDialog(makeServerMessagesError(REDRESS_MESSAGE))
			const dialog = getDialogContent()

			// Neither anchor survives, and no link to that host exists under any attribute.
			expect(dialog.querySelectorAll('a')).toHaveLength(0)
			expect(dialog.querySelector('[href*="evil.example.com"]')).toBeNull()
			// The link TEXT is still shown, so nothing the server wrote is hidden from the user.
			expect(dialog.textContent).toContain('Sign in')
			expect(dialog.textContent).toContain('Continue')
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
	})

	/**
	 * FM1 — "a dismissible error dialog; the transaction stays unreconciled with state
	 * unchanged; no partial or duplicate postings." Dismissing has to be genuinely inert: the
	 * error goes away and NOTHING else moves. Revalidation belongs to the calling hook, and the
	 * server remains the authority on what was recorded (C9).
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

			// Same objects, not merely equal ones.
			expect(store.get(selectedBankAccountAtom)).toBe(bank)
			expect(store.get(selectionAtom)).toBe(selection)
			expect(store.get(selectionAtom)).toHaveLength(1)
			// The settling flag belongs to the reconcile hook, which owns the revalidation that
			// follows a rejection. Dismissing the dialog must not release it early — doing so would
			// re-enable confirm against a snapshot the client has just been told is unreliable.
			expect(store.get(bankRecReconcileSettlingAtom)).toBe(true)
		})

		it('issues no request and triggers no revalidation of its own', async () => {
			// No optimistic mutation, and no side effect either: the dialog reports, it does not act.
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
