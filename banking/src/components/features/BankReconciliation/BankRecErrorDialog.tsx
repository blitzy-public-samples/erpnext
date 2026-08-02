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

/** Tab-reachable controls a restored focus target may legitimately be. */
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Shared, dismissible error dialog for the Bank Reconciliation and Bank Statement Importer
 * surfaces. Takes no props: one shared atom drives every mount site across both route trees,
 * so the two surfaces can never show conflicting error state.
 *
 * This component is deliberately nothing but alert-dialog chrome, focus management and a
 * Dismiss control. The error itself is rendered by the SHARED `ErrorBanner`, passed the atom's
 * value COMPLETELY UNMODIFIED and with `overrideHeading` left unset, so the parser
 * (`getErrorMessages`), the severity rule (`indicator === 'yellow'` -> amber, else red), the
 * heading rule and the message rendering are the SAME single implementation the ~20 inline
 * banner call sites use. Composing rather than restating is what guarantees this dialog and an
 * inline banner can never disagree about the same rejection, and it means the server's own
 * words - for example `"Bank Transaction {0} is already fully reconciled"` - reach the user
 * verbatim with no client paraphrasing and no severity judgement of our own.
 *
 * SAFETY OF THAT COMPOSITION. `ErrorBanner` renders each parsed message through
 * `ui/markdown.tsx`, which runs `rehypeRaw`; error text is wholly server-controlled and
 * arrives at the exact moment something has already gone wrong. That path is safe because the
 * renderer applies an allow-list sanitiser AFTER `rehypeRaw`: scripts, styles, frames,
 * embedded objects, media, form controls, every `on*` handler, `style`, and - specifically to
 * close CWE-451 UI redress, since this application's utility classes are compiled into the
 * shipped stylesheet - `class` and `id` are all removed, and links survive only when they
 * point back at this application. Frappe's own inline `frappe.bold()` markup therefore still
 * renders as emphasis, which is precisely the shared behaviour a bespoke text-only renderer
 * here would have lost.
 *
 * Dismissing clears the dialog atom and nothing else - it issues no request, triggers no
 * revalidation and raises no notification, because the calling hook owns revalidation.
 * Atomicity is the backend's: its already-reconciled guard runs first and the whole operation
 * commits through a single save.
 */
const BankRecErrorDialog = () => {
	const [error, setError] = useAtom(bankRecErrorDialogAtom)
	const dismissRef = useRef<HTMLButtonElement>(null)
	// The most recent control to hold focus outside this dialog, then the control that was
	// focused when the failure surfaced and the region it belonged to. The first is tracked
	// continuously, the other two are frozen on open and consumed on close, so focus returns
	// where the user left it instead of falling to <body>.
	const lastFocusedRef = useRef<HTMLElement | null>(null)
	const invokerRef = useRef<HTMLElement | null>(null)
	const invokerRegionRef = useRef<HTMLElement | null>(null)

	// The invoking control cannot be read from `document.activeElement` at the moment this
	// dialog opens. The actions that fail here are asynchronous, and the control that starts
	// one re-renders into its disabled pending state within a few milliseconds of the click —
	// browsers blur a control the instant it becomes disabled, with no related target — so
	// `document.activeElement` has already fallen back to <body> well before the rejection
	// arrives and this dialog mounts. Recording focus as it actually happens is therefore the
	// only way to still know the invoker at close time. The listener is capture-phase so an
	// intervening handler cannot suppress it, and it ignores anything belonging to this dialog
	// (its own content subtree, and the focus guards Radix parks either side of it) so an open
	// dialog never overwrites the element it is going to restore.
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

	// This dialog renders a Dismiss action and no cancel control, so Radix has no default target
	// to seed its focus scope with; naming Dismiss keeps Radix's own focus trap authoritative.
	// Radix dispatches this before it moves focus inward, so it is also where the tracked
	// invoker is frozen for the lifetime of this dialog.
	const onOpenAutoFocus = (event: Event) => {
		const lastFocused = lastFocusedRef.current
		const invoker = lastFocused?.isConnected ? lastFocused : null
		invokerRef.current = invoker
		// The surrounding region is remembered as well, because a rejection can be followed by
		// a revalidation that replaces the invoking control's subtree. When that happens the
		// captured element is detached and focusing it would be a no-op, so the first control
		// of the same region is the next logical target.
		invokerRegionRef.current = invoker?.closest<HTMLElement>('[data-slot="tabs-content"]') ?? document.getElementById('root')
		event.preventDefault()
		dismissRef.current?.focus()
	}

	// Radix funnels its close intents through here: the Escape key and the action button's own
	// implicit close both arrive as `false`. An overlay click deliberately does NOT —
	// `AlertDialog` suppresses interact-outside so an error that must be acknowledged cannot be
	// dismissed by a stray click. Escape and Dismiss are what make it dismissible.
	const onOpenChange = (v: boolean) => {
		if (!v) {
			dismiss()
		}
	}

	// Radix restores focus to whatever it recorded as previously-focused, which for an
	// atom-driven dialog with no trigger resolves to <body>. Returning focus to the captured
	// invoker keeps the keyboard user where they were; if that element is gone, the region's
	// first control is focused instead, and only when neither survives is Radix's own default
	// left to run.
	const onCloseAutoFocus = (event: Event) => {
		const invoker = invokerRef.current
		const region = invokerRegionRef.current
		invokerRef.current = null
		invokerRegionRef.current = null

		if (invoker?.isConnected) {
			event.preventDefault()
			invoker.focus()
			return
		}

		const fallback = region?.isConnected ? region.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) : null
		if (fallback) {
			event.preventDefault()
			fallback.focus()
		}
	}

	// An empty atom means "no error to show", mirroring the falsy-means-closed modal-atom
	// convention used throughout this feature folder.
	if (!error) {
		return null
	}

	return (
		<AlertDialog open onOpenChange={onOpenChange}>
			{/* Radix marks the rest of the page inert but does not emit `aria-modal`, so the
				modal semantics are declared explicitly here. The focus trap, Escape handling
				and `role="alertdialog"` all remain Radix's. */}
			{/* WIDTH: no unconditional MINIMUM width. `min-w-*` beats the primitive's own
				`max-w-[calc(100%-2rem)]` in the CSS cascade, which forced a fixed 672px dialog
				onto every viewport and pushed ~300px of the server's message off-screen on a
				phone - the one message the user most needs to read. Widening through
				`max-width` instead leaves the primitive's ladder intact and simply adds a rung
				above it, so the dialog always fits: below 640px the gutter rule governs, from
				640px the primitive's own `sm:max-w-lg` (512px) does, and from 768px this
				`md:max-w-2xl` (672px) does - each value comfortably inside its own range.

				The `data-[size=default]:` qualifier is REQUIRED rather than cosmetic. The
				primitive's class is attribute-qualified, so it carries higher specificity than a
				bare `md:max-w-2xl` would and would win at every width; matching the qualifier
				puts both classes on equal specificity, which leaves source order to decide -
				and Tailwind always emits `sm` before `md`. The rendered desktop width is
				therefore unchanged at 2xl, exactly as before.

				HEIGHT: `max-h-[90vh]` is the bound `ui/dialog.tsx` already applies to the
				ordinary dialog primitive. An arbitrarily long or multi-message backend error
				would otherwise grow the dialog past the viewport and carry the only Dismiss
				control off-screen with it.

				`grid-rows-[auto_minmax(0,1fr)_auto]` is what makes that bound actually bite,
				and it is REQUIRED rather than belt-and-braces. The primitive is `display:
				grid` with IMPLICIT rows, and a `max-height` on a grid container does not
				shrink an `auto` track: the middle track keeps its full content height, so the
				message row below is handed a box equal to its own content, its
				`overflow-y-auto` never activates (`scrollHeight === clientHeight`), and the
				surplus - footer and all - paints outside the clamped box. Measured before this
				track constraint was added: at 375x812 the box clamped correctly to 731px while
				the content ran to 2723px and Dismiss rendered 1952px below the fold,
				unreachable by any pointer; at 1440x900 it was 335px below the fold. Naming
				three tracks pins the header and footer at their natural heights and lets ONLY
				the middle one shrink, which is why Dismiss now stays on screen at every
				height. The count is exact because this dialog renders exactly three children,
				unconditionally: header, message region, footer.

				Radix marks the rest of the page inert but does not emit `aria-modal`, so the
				modal semantics are declared explicitly here. The focus trap, Escape handling
				and `role="alertdialog"` all remain Radix's. */}
			<AlertDialogContent aria-modal="true" className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] data-[size=default]:md:max-w-2xl" onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
				<AlertDialogHeader>
					{/* This chrome is deliberately outcome-NEUTRAL. It is rendered
					    unconditionally, before the rejection has been inspected, and a
					    transport-level failure carries no server response at all - so the
					    client cannot know whether the operation was applied and must not
					    say. FM1 makes the backend response the sole source of truth, so the
					    heading and this line only frame the authoritative text below; they
					    assert nothing about what was posted. */}
					<AlertDialogTitle>{_("Something went wrong")}</AlertDialogTitle>
					<AlertDialogDescription>
						{_("Review the details below, then dismiss this message to continue. The server remains the authority on what was recorded.")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{/* The SHARED banner, handed the server's envelope untouched. `overrideHeading`
					is deliberately unset so the server's own title survives.

					This is the row that scrolls, and it takes BOTH halves to work. The named
					`minmax(0,1fr)` track above lets the row shrink below its content instead of
					sizing to it; `min-h-0` then lets this item shrink inside that track, since
					a grid item's automatic minimum size would otherwise still be its content;
					and `overflow-y-auto` gives the overflow somewhere to go. The result is that
					the header AND the Dismiss control stay on screen however much text the
					server sent, and only the message itself scrolls. */}
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
