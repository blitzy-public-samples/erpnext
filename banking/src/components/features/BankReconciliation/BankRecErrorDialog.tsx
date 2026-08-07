import {
	AlertDialog,
	AlertDialogCancel,
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

/** The element `main.tsx` mounts the SPA into. Everything except a portalled overlay lives inside it. */
const APP_ROOT_ID = "root"

/**
 * Places focus at the top of the application content.
 *
 * Used only as a last resort, when the element that held focus before the dialog opened no longer exists
 * to return it to. A container is not focusable on its own, so `tabindex="-1"` is added to make it
 * programmatically focusable WITHOUT creating a tab stop, and removed again on blur so the document
 * returns to the shape it had before.
 */
const focusAppRoot = () => {
	const root = document.getElementById(APP_ROOT_ID)

	if (!root) {
		return
	}

	if (!root.hasAttribute("tabindex")) {
		root.setAttribute("tabindex", "-1")
		root.addEventListener("blur", () => root.removeAttribute("tabindex"), { once: true })
	}

	root.focus({ preventScroll: true })
}

/**
 * Shared, dismissible error dialog for the Bank Reconciliation and Bank Statement Importer surfaces.
 * Takes no props: one shared atom drives every mount site across both route trees, so the surfaces
 * cannot report different errors at once.
 *
 * The rejection reaches the shared `ErrorBanner` by identity, with `overrideHeading` left unset, so
 * parsing, severity and heading stay the single implementation the inline banner call sites use and
 * the server's own words reach the reviewer verbatim.
 *
 * Dismissing clears the atom and nothing else: the calling hook owns revalidation.
 *
 * Sizing widens the primitive's `sm:max-w-lg` cap to `2xl` from the same breakpoint, rather than
 * setting a minimum width: a `min-width` beats a `max-width` in CSS, so a fixed `2xl` minimum forced
 * the box wider than a viewport narrower than roughly 704px and overflowed it horizontally. Height is
 * capped against the dynamic viewport and only the banner scrolls, so a long stack of server messages
 * can never push the Dismiss control off screen - see the explicit row template on the content below,
 * without which that guarantee was words rather than behaviour.
 */
const BankRecErrorDialog = () => {
	const [error, setError] = useAtom(bankRecErrorDialogAtom)

	const isOpen = error !== null

	/*
	 * Where focus came from, and where it goes back to. Both are needed because THIS composition gives
	 * Radix neither of the two anchors it focuses by default, so each of its own handlers resolves to
	 * `null` and silently does nothing:
	 *
	 *   - on open, `AlertDialog.Content` cancels the focus scope's auto-focus and focuses its
	 *     `AlertDialogCancel` instead. A dismissible report of something that already happened offers
	 *     no cancel - there is nothing to cancel - so nothing was focused, `FocusScope` never recorded
	 *     a last-focused element inside the container, and its `focusin` guard had nothing to pull Tab
	 *     back to. Focus stayed on `<body>` and every Tab landed on the live controls behind the
	 *     dialog, Reconcile among them.
	 *   - on close, `DialogContentModal` focuses its `Trigger`. This dialog is driven by an atom from a
	 *     rejection handler rather than by a trigger element, so there was none, and focus was dropped.
	 *
	 * Supplying the two anchors ARMS Radix's own focus scope rather than replacing it: the trap, the
	 * Tab loop, the escape handling and the ARIA wiring all remain the primitive's.
	 */
	const returnFocusTo = useRef<HTMLElement | null>(null)
	const dismissRef = useRef<HTMLButtonElement>(null)

	/*
	 * The return anchor is tracked AS FOCUS MOVES rather than read when the dialog opens, and the
	 * difference is the whole behaviour:
	 *
	 * every caller disables its control for the duration of the request - that in-flight `disabled` is
	 * what stops a double post - and a browser blurs a control the moment it becomes disabled. Focus
	 * therefore lands on `<body>` a few milliseconds after the click and tens of milliseconds BEFORE
	 * the server answers and this dialog mounts. Reading `document.activeElement` at open time hands
	 * back `document.body`, which is an `HTMLElement`, is connected, and satisfies every guard - so the
	 * restore below would run, succeed, and leave focus exactly where a broken one would.
	 *
	 * A capture-phase listener sees the control while it still holds focus, so what is remembered is
	 * the control the reviewer actually used. It ignores `<body>` and the document element for the
	 * reason above, and ignores anything inside the dialog because that is where focus is going rather
	 * than where it came from.
	 */
	useEffect(() => {
		const rememberFocus = (event: FocusEvent) => {
			const target = event.target

			if (!(target instanceof HTMLElement)) return
			if (target === document.body || target === document.documentElement) return
			if (target.closest('[data-slot="alert-dialog-content"]')) return
			/*
			 * The application container is skipped for the same reason as `<body>`: it is somewhere focus
			 * is PUT when there is nowhere better, never a control a reviewer chose. Without this the
			 * fallback below poisons its own anchor - `focusAppRoot()` focuses this element, that focus is
			 * seen here, and the next refusal then tries to "restore" to a container whose temporary
			 * tabindex has already been taken back off it, so the restore fails and lands on the root
			 * again while the control the reviewer actually used is forgotten.
			 */
			if (target.id === APP_ROOT_ID) return

			returnFocusTo.current = target
		}

		document.addEventListener("focusin", rememberFocus, true)
		return () => document.removeEventListener("focusin", rememberFocus, true)
	}, [])

	useEffect(() => {
		if (!isOpen) {
			return
		}

		const root = document.getElementById(APP_ROOT_ID)

		/*
		 * Radix hides the rest of the document from assistive technology while a modal is open, but
		 * `aria-hidden` on its own still leaves the page behind operable - by pointer, and by Tab if focus
		 * ever escapes the scope. `inert` is what makes it genuinely unreachable, and it is the one signal
		 * Radix does not manage itself, so setting it here cannot race Radix's own cleanup. The dialog is
		 * portalled to <body>, OUTSIDE this element, so it stays operable while everything else does not.
		 */
		if (!root || root.hasAttribute("inert")) {
			return
		}

		root.setAttribute("inert", "")

		return () => root.removeAttribute("inert")
	}, [isOpen])

	// Radix funnels its close intents through here: the Escape key and the dismiss control's own
	// implicit close both arrive as `false`. An overlay click deliberately does NOT - `AlertDialog`
	// suppresses interact-outside - so Escape and Dismiss are what make this dismissible.
	const onOpenChange = (open: boolean) => {
		if (!open) {
			setError(null)
		}
	}

	/*
	 * Preventing the default suppresses the primitive's own attempt to resolve an initial focus target and
	 * focuses Dismiss outright, which puts a real, tabbable element inside the container - exactly what
	 * the scope's `focusin` guard needs before it can hold Tab inside the dialog. Rendering the control as
	 * Radix's CANCEL slot means the primitive would arrive at the same element on its own, so if the ref
	 * has not attached yet the default is deliberately left in place rather than suppressed for nothing.
	 */
	const onOpenAutoFocus = (event: Event) => {
		const dismiss = dismissRef.current

		if (!dismiss) {
			return
		}

		event.preventDefault()
		dismiss.focus({ preventScroll: true })
	}

	/*
	 * Hand focus back to the control the reviewer used, for Escape and Dismiss alike.
	 *
	 * `preventDefault` comes first and unconditionally, because Radix's own restore is a dead end for a
	 * triggerless dialog: it focuses the TRIGGER that opened it, and this dialog is opened by an atom from
	 * a rejection handler. Radix composes this handler AHEAD of its internal one and skips that one once
	 * the default is prevented, so the focus performed below is the only focus this close performs.
	 *
	 * Two states disqualify the remembered control: one the post-refusal re-read has since replaced is
	 * detached, and focusing a detached node moves focus to `<body>` silently; one that is still disabled
	 * refuses focus outright, which would do the same. No LOOKALIKE is ever substituted - the nearest on a
	 * refused reconciliation is another voucher's live Reconcile button, and putting a keyboard user's
	 * focus on a posting control they did not choose is not a recovery.
	 *
	 * When it is disqualified, focus goes to the top of the application content instead of being left on
	 * `<body>`. That is the COMMON case here rather than an edge one: converging with the server after a
	 * refusal removes the very row whose Reconcile control was clicked. `<body>` would mean no announced
	 * position and a Tab that starts again from the top of the document.
	 */
	const onCloseAutoFocus = (event: Event) => {
		event.preventDefault()

		const target = returnFocusTo.current
		returnFocusTo.current = null

		if (target?.isConnected && (target as HTMLElement & { disabled?: boolean }).disabled !== true) {
			target.focus({ preventScroll: true })

			// It can still refuse - hidden, or inside something inert by now - so confirm rather than
			// assume, and fall through to the root when it did not take.
			if (document.activeElement === target) {
				return
			}
		}

		focusAppRoot()
	}

	if (!error) {
		return null
	}

	return (
		<AlertDialog open onOpenChange={onOpenChange}>
			{/* `grid-rows-[auto_minmax(0,1fr)_auto]` is what makes the height cap above do anything. The
			    primitive declares `grid` with no row template, so `grid-auto-rows: auto` sized all three
			    rows to their content: the messages row grew to its full height, `min-h-0` had no flexible
			    track to shrink, `overflow-y` never engaged, and a verbose refusal pushed the footer
			    outside the capped box - measured off screen and not hit-testable at every viewport, with
			    Escape the only remaining exit. Naming the middle track `minmax(0,1fr)` gives it a
			    definite height to scroll within and pins the header and footer to their own content, so
			    Dismiss stays on screen whatever the server sends.
			    `aria-modal` is stated for two reasons. It states the containment the `inert` effect above
			    enforces, which ARIA asks for on a modal dialog and which Radix does not set because it
			    relies on hiding the rest of the document instead. And it cannot be left to that
			    `aria-hidden` alone: Chrome refuses to apply it while a descendant still holds focus, so
			    the page behind stayed in the accessibility tree in exactly the case that mattered. */}
			<AlertDialogContent
				aria-modal="true"
				className="data-[size=default]:sm:max-w-2xl max-h-[calc(100dvh-4rem)] grid-rows-[auto_minmax(0,1fr)_auto]"
				onOpenAutoFocus={onOpenAutoFocus}
				onCloseAutoFocus={onCloseAutoFocus}
			>
				<AlertDialogHeader>
					{/* Outcome-neutral: a transport-level failure carries no server response, so the client
					    cannot know whether the operation was applied and must not say. */}
					<AlertDialogTitle>{_("Something went wrong")}</AlertDialogTitle>
					<AlertDialogDescription>
						{_("Review the details below, then dismiss this message to continue. The server remains the authority on what was recorded.")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{/* `min-h-0` is what lets this grid row shrink below its content, so the height cap above
				    scrolls the messages instead of growing the dialog past the viewport.
				    `wrap-anywhere` matches the transaction list: server text can carry an unbroken token
				    with nowhere to break - a reference, an SQL fragment, a path - and without it one such
				    token laid out as a single line thousands of pixels wide, readable only by scrolling
				    sideways inside the banner. `anywhere` rather than `break-word` because only
				    `anywhere` also lowers the intrinsic width, which is what keeps the line inside the
				    box rather than merely allowing it to break. */}
				<div className="min-h-0 overflow-y-auto wrap-anywhere">
					<ErrorBanner error={error} />
				</div>
				<AlertDialogFooter>
					{/*
					 * `AlertDialogCancel` rather than `AlertDialogAction`, and the choice is not cosmetic.
					 * Radix's alert dialog declines its own default autofocus on open and focuses the CANCEL
					 * control instead - a deliberate design, so that the keyboard lands on the safe way out
					 * of a destructive prompt rather than on the destructive button. With no Cancel rendered
					 * there was nothing for it to focus, focus stayed on <body> outside the focus scope, and
					 * from there Tab walked straight into the page behind: the trap never engaged, because
					 * Radix contains focus by observing where it moves FROM inside the scope.
					 *
					 * Dismissing is the only action this dialog offers, so Cancel is also the honest role for
					 * it. The solid red styling is carried over explicitly to keep the control looking exactly
					 * as it did - the primitive's Cancel defaults to a grey outline.
					 *
					 * The ref is the dialog's explicit initial focus target; see `onOpenAutoFocus` above.
					 */}
					<AlertDialogCancel ref={dismissRef} variant="solid" theme="red" onClick={() => setError(null)}>
						{_("Dismiss")}
					</AlertDialogCancel>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

export default BankRecErrorDialog
