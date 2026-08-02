import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Paragraph } from "@/components/ui/typography"
import { getErrorMessages } from "@/lib/frappe"
import { useAtom } from "jotai"
import { AlertCircle } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import { bankRecErrorDialogAtom } from "./bankRecAtoms"
import _ from "@/lib/translate"

/** Tab-reachable controls a restored focus target may legitimately be. */
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Collapses Frappe's two placeholder server titles into a friendly heading — byte-for-byte
 * the rule `ui/error-banner.tsx:20-23` applies — so this dialog's heading behaviour matches
 * every inline banner in the SPA: a SPECIFIC server title survives verbatim and only the
 * generic `Message` / `Error` placeholders are replaced.
 */
const parseHeading = (title?: string) => {
	if (title === 'Message' || title === 'Error') {
		return _("There was an error.")
	}
	return title
}

/**
 * Shared, dismissible error dialog for the Bank Reconciliation and Bank Statement Importer
 * surfaces. Takes no props: one shared atom drives every mount site across both route trees,
 * so the two surfaces can never show conflicting error state.
 *
 * The server's own words are surfaced UNMODIFIED and UNPARAPHRASED, resolved through the same
 * shared parser (`getErrorMessages`) and presented with the same design-system `Alert`
 * primitives, severity rule and heading rule every inline `ErrorBanner` uses. The severity is
 * the SERVER'S — `indicator === 'yellow'` gives amber, anything else red — so this component
 * makes no judgement of its own.
 *
 * It renders each message as TEXT rather than delegating to `ui/error-banner.tsx`, and that is
 * a security requirement (CWE-79) rather than a style preference: the banner renders through
 * `ui/markdown.tsx`, which runs `rehype-raw`, so raw HTML in a message would become live DOM.
 * Error text is wholly server-controlled and reaches the user at the exact moment something has
 * already gone wrong, so no markup path exists from here at all. The cost is that Frappe's own
 * inline markup (for example the `frappe.bold()` wrappers in the currency-mismatch throw) shows
 * literally; every value in the message still reaches the reader intact.
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

	// Parsed with the SAME shared parser the inline banners use (`_server_messages` ->
	// `_error_message` -> `exception` -> bare `message`), so what this dialog shows and what a
	// banner would have shown for the same rejection can never diverge.
	const messages = useMemo(() => getErrorMessages(error), [error])

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
			<AlertDialogContent aria-modal="true" className="min-w-2xl" onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
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
				{/* Every message the server sent, in its own words and in its own order, as inert
					text. `whitespace-pre-line` keeps any line breaks the server intended and
					`wrap-anywhere` stops an unbroken reference number from overflowing the dialog. */}
				<Alert theme={messages[0]?.indicator === 'yellow' ? 'amber' : "red"}>
					<AlertCircle />
					<AlertTitle>{parseHeading(messages[0]?.title)}</AlertTitle>
					<AlertDescription>
						{messages.map((serverMessage, index) => (
							<Paragraph key={index} className="whitespace-pre-line wrap-anywhere">
								{serverMessage.message}
							</Paragraph>
						))}
					</AlertDescription>
				</Alert>
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
