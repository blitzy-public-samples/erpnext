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
import { useMemo, useRef } from "react"
import { bankRecErrorDialogAtom } from "./bankRecAtoms"
import { resolveDisplayError } from "./utils"
import _ from "@/lib/translate"

/**
 * Shared, dismissible error dialog for the Bank Reconciliation and Bank Statement
 * Importer surfaces. Takes no props: one shared atom drives every mount site across
 * both route trees, so the two surfaces can never show conflicting error state.
 *
 * Composed, not invented — it wraps the existing `ErrorBanner`, which already parses
 * Frappe's `_server_messages` envelope, derives amber/red severity from the server's
 * own indicator and renders each message as markdown. Whenever the server said
 * anything at all the error is therefore handed over COMPLETELY UNMODIFIED, and the
 * banner's heading-override prop is deliberately left alone, so the server's own title
 * and text reach the user verbatim: no client-side paraphrasing and no client-side
 * severity decision. The shared `resolveDisplayError` from `./utils` substitutes copy in
 * the two cases where there is no server text to preserve — see its own comment. That
 * normaliser is deliberately shared with the transient toast raised by the same rejection
 * handler, so the dialog and the toast can never tell the user two different things.
 *
 * Clearing the atom is the ONLY state change performed here. This dialog issues no
 * follow-up request, triggers no cache revalidation and raises no transient
 * notification — the backend response is the sole source of truth, and the calling
 * hook already owns revalidation. Dismissing therefore leaves every other piece of
 * state untouched, which is what makes a failed post provably incapable of changing
 * or partially applying anything.
 */
const BankRecErrorDialog = () => {
	const [error, setError] = useAtom(bankRecErrorDialogAtom)
	const dismissRef = useRef<HTMLButtonElement>(null)

	// The atom always keeps the RAW rejection so nothing downstream of it loses fidelity;
	// only what the banner renders is resolved, and only when the rejection carries no
	// server text to show. Memoised so the banner's own `useMemo(…, [error])` is not
	// invalidated by a fresh object on every render.
	const displayError = useMemo(() => (error ? resolveDisplayError(error) : null), [error])

	/** Discards the error being displayed. This is the only state this dialog owns. */
	const dismiss = () => {
		setError(null)
	}

	// Radix's AlertDialog seeds its focus scope by focusing an AlertDialogCancel on
	// open. This dialog is purely informational, so it renders a Dismiss action and no
	// cancel control — which leaves Radix's internal cancel ref null, the focus scope
	// unseeded and its guard inert, so Tab would walk the page behind the overlay.
	// Naming Dismiss as the target seeds the scope and keeps Radix's own trap
	// authoritative rather than hand-rolling one.
	const onOpenAutoFocus = (event: Event) => {
		event.preventDefault()
		dismissRef.current?.focus()
	}

	// Radix funnels its close intents through here: the Escape key and the action
	// button's own implicit close both arrive as `false`. An overlay click deliberately
	// does NOT — `AlertDialog` suppresses interact-outside so an error that must be
	// acknowledged cannot be dismissed by a stray click. Escape and Dismiss are what
	// make it dismissible.
	const onOpenChange = (v: boolean) => {
		if (!v) {
			dismiss()
		}
	}

	// An empty atom means "no error to show", mirroring the falsy-means-closed
	// modal-atom convention used throughout this feature folder.
	if (!error) {
		return null
	}

	return (
		<AlertDialog open onOpenChange={onOpenChange}>
			<AlertDialogContent className="min-w-2xl" onOpenAutoFocus={onOpenAutoFocus}>
				<AlertDialogHeader>
					<AlertDialogTitle>{_("Could not complete the operation")}</AlertDialogTitle>
					<AlertDialogDescription>
						{_("The action was not completed. Review the details below, then dismiss this message to continue.")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<ErrorBanner error={displayError} />
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
