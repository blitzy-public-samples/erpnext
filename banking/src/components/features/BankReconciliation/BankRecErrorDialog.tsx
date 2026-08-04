import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import ErrorBanner from "@/components/ui/error-banner"
import { useAtom } from "jotai"
import { useEffect, useRef } from "react"
import { bankRecErrorDialogAtom } from "./bankRecAtoms"
import _ from "@/lib/translate"

/**
 * Tab-reachable controls a restored focus target may legitimately be. The `:not([disabled])`
 * clauses are load-bearing, not decorative — see {@link canTakeFocus}.
 */
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Whether an element can ACTUALLY take focus right now, as opposed to merely still being in the
 * document. `HTMLElement.focus()` is a silent no-op on a disabled control, so "connected" is not
 * the same question and answering it instead is what stranded keyboard focus on `<body>`: the
 * reconcile button this dialog is usually raised from stays connected after a rejection but is
 * disabled by its own already-reconciled guard the moment the refreshed status lands.
 *
 * `FOCUSABLE_SELECTOR` already excludes `[disabled]` controls, so matching it answers most of the
 * question; `aria-disabled` is checked separately because the design system uses it on composite
 * controls that carry no native `disabled` attribute.
 */
const canTakeFocus = (element: HTMLElement | null): element is HTMLElement =>
	element !== null && element.isConnected &&
	element.matches(FOCUSABLE_SELECTOR) &&
	element.getAttribute('aria-disabled') !== 'true'

/**
 * Shared, dismissible error dialog for the Bank Reconciliation and Bank Statement Importer
 * surfaces. Takes no props: one shared atom drives every mount site across both route trees, so
 * the two surfaces can never show conflicting error state.
 *
 * The error itself is rendered by the SHARED `ErrorBanner`, passed the atom's value COMPLETELY
 * UNMODIFIED and with `overrideHeading` left unset, so the parser (`getErrorMessages`), the
 * severity rule (`indicator === 'yellow'` -> amber, else red), the heading rule and the message
 * rendering are the same single implementation the ~20 inline banner call sites use. Composing
 * rather than restating is what guarantees this dialog and an inline banner can never disagree
 * about the same rejection, and it means the server's own words - for example
 * `"Bank Transaction {0} is already fully reconciled"` - reach the user verbatim.
 *
 * Rendering is likewise the shared path: `ErrorBanner` hands each parsed message to
 * `ui/markdown.tsx`, exactly as it does at every inline call site, so this dialog introduces no
 * rendering behaviour of its own and inherits whatever that component does.
 *
 * Dismissing clears the dialog atom and nothing else - it issues no request, triggers no
 * revalidation and raises no notification, because the calling hook owns revalidation. Atomicity
 * is the backend's: its already-reconciled guard runs first and the whole operation commits
 * through a single save.
 */
const BankRecErrorDialog = () => {
	const [error, setError] = useAtom(bankRecErrorDialogAtom)
	const dismissRef = useRef<HTMLButtonElement>(null)
	// The most recent control to hold focus outside this dialog, then the control that was focused
	// when the failure surfaced and the region it belonged to. The first is tracked continuously,
	// the other two are frozen on open and consumed on close, so focus returns where the user left
	// it instead of falling to <body>.
	const lastFocusedRef = useRef<HTMLElement | null>(null)
	const invokerRef = useRef<HTMLElement | null>(null)
	const invokerRegionRef = useRef<HTMLElement | null>(null)

	// The invoking control cannot be read from `document.activeElement` when this dialog opens. The
	// actions that fail here are asynchronous and the control that starts one re-renders into its
	// disabled pending state within milliseconds of the click - browsers blur a control the instant
	// it becomes disabled - so `activeElement` has already fallen back to <body> before the
	// rejection arrives. Recording focus as it happens is the only way to still know the invoker at
	// close time. Capture-phase so an intervening handler cannot suppress it, and anything belonging
	// to this dialog is ignored so an open dialog never overwrites the element it will restore.
	useEffect(() => {
		const recordFocus = (event: FocusEvent) => {
			const target = event.target
			if (!(target instanceof HTMLElement)) {
				return
			}

			if (target.hasAttribute('data-radix-focus-guard') || target.closest('[data-slot="alert-dialog-content"]')) {
				return
			}

			lastFocusedRef.current = target
		}

		document.addEventListener('focusin', recordFocus, true)
		return () => document.removeEventListener('focusin', recordFocus, true)
	}, [])

	/** Discards the error being displayed. This is the only state this dialog owns. */
	const dismiss = () => {
		setError(null)
	}

	// This dialog renders a Dismiss action and no cancel control, so Radix has no default target to
	// seed its focus scope with; naming Dismiss keeps Radix's own focus trap authoritative. Radix
	// dispatches this before it moves focus inward, so it is also where the tracked invoker and its
	// surrounding region are frozen for the lifetime of this dialog. The region matters because a
	// rejection can be followed by a revalidation that replaces the invoking control's subtree.
	const onOpenAutoFocus = (event: Event) => {
		const lastFocused = lastFocusedRef.current
		const invoker = lastFocused?.isConnected ? lastFocused : null
		invokerRef.current = invoker
		invokerRegionRef.current = invoker?.closest<HTMLElement>('[data-slot="tabs-content"]') ?? document.getElementById('root')
		event.preventDefault()
		dismissRef.current?.focus()
	}

	// Radix funnels its close intents through here: the Escape key and the action button's own
	// implicit close both arrive as `false`. An overlay click deliberately does NOT - `AlertDialog`
	// suppresses interact-outside so an error that must be acknowledged cannot be dismissed by a
	// stray click. Escape and Dismiss are what make it dismissible.
	const onOpenChange = (v: boolean) => {
		if (!v) {
			dismiss()
		}
	}

	// Radix restores focus to whatever it recorded as previously-focused, which for an atom-driven
	// dialog with no trigger resolves to <body>. So a target is chosen here instead: the captured
	// invoker, else the first focusable control of the region it belonged to.
	//
	// Each candidate is tested with `canTakeFocus` BEFORE the default is suppressed. Testing only
	// `isConnected` suppressed the default and then failed to replace it, because the invoker is
	// routinely connected-but-disabled by the time this runs. Focus is also VERIFIED after the call
	// rather than assumed, so a refusal no predicate can anticipate falls through to the next
	// candidate instead of leaving focus nowhere.
	const onCloseAutoFocus = (event: Event) => {
		const invoker = invokerRef.current
		const region = invokerRegionRef.current
		invokerRef.current = null
		invokerRegionRef.current = null

		const candidates = [
			invoker,
			region?.isConnected ? region.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) : null
		]

		for (const candidate of candidates) {
			if (!canTakeFocus(candidate)) {
				continue
			}

			event.preventDefault()
			candidate.focus()

			if (document.activeElement === candidate) {
				return
			}
		}
	}

	// An empty atom means "no error to show", mirroring the falsy-means-closed modal-atom convention
	// used throughout this feature folder.
	if (!error) {
		return null
	}

	return (
		<AlertDialog open onOpenChange={onOpenChange}>
			{/* Radix marks the rest of the page inert but does not emit `aria-modal`, so the modal
				semantics are declared explicitly here. The focus trap, Escape handling and
				`role="alertdialog"` all remain Radix's.

				WIDTH: the 42rem minimum matches the canonical pattern this dialog imitates
				(`BankTransactionUnreconcileModal.tsx:37`), but it is applied ONLY from `md` (768px)
				upwards. Unqualified, a `min-width` of 672px overrides the primitive's
				`max-w-[calc(100%-2rem)]` - `min-width` beats `max-width` in CSS - so on a 375px
				viewport the box rendered 672px wide and pushed the only Dismiss control off-screen
				horizontally. The importer routes have no desktop-only gate, so that viewport is
				reachable. `md` is the first default breakpoint wide enough to hold 672px inside the
				primitive's 2rem gutter (768 - 32 = 736); below it the primitive's own responsive
				width is left to do its job.

				HEIGHT: `max-h-[90vh]` is the bound `ui/dialog.tsx` already applies to the ordinary
				dialog primitive, and `grid-rows-[auto_minmax(0,1fr)_auto]` is what makes it bite. The
				primitive is `display: grid` with IMPLICIT rows, and a `max-height` on a grid
				container does not shrink an `auto` track - so the message row kept its full content
				height, its `overflow-y-auto` never activated, and the footer painted outside the
				clamped box (measured at 375x812: box 731px, content 2723px, Dismiss 1952px below the
				fold). Naming three tracks pins the header and footer at their natural heights and
				lets only the middle one shrink. The count is exact because this dialog renders
				exactly three children, unconditionally. */}
			<AlertDialogContent aria-modal="true" className="md:min-w-2xl max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto]" onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
				<AlertDialogHeader>
					{/* Deliberately outcome-NEUTRAL. This chrome renders before the rejection has been
					    inspected, and a transport-level failure carries no server response at all - so
					    the client cannot know whether the operation was applied and must not say. FM1
					    makes the backend response the sole source of truth, so the heading and this
					    line only frame the authoritative text below. */}
					<AlertDialogTitle>{_("Something went wrong")}</AlertDialogTitle>
					<AlertDialogDescription>
						{_("Review the details below, then dismiss this message to continue. The server remains the authority on what was recorded.")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{/* The SHARED banner, handed the server's envelope untouched; `overrideHeading` is
					deliberately unset so the server's own title survives. `min-h-0` lets this grid item
					shrink inside the `minmax(0,1fr)` track above - a grid item's automatic minimum size
					would otherwise still be its content - and `overflow-y-auto` gives the surplus
					somewhere to go, so only the message scrolls and Dismiss always stays on screen. */}
				<div className="min-h-0 overflow-y-auto">
					<ErrorBanner error={error} />
				</div>
				<AlertDialogFooter>
					<AlertDialogAction ref={dismissRef} onClick={dismiss}>
						{_("Dismiss")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

export default BankRecErrorDialog
