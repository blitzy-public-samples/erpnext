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
import { useRef } from "react"
import { bankRecErrorDialogAtom } from "./bankRecAtoms"
import _ from "@/lib/translate"

/**
 * Shared, dismissible error dialog for the Bank Reconciliation and Bank Statement
 * Importer surfaces. Takes no props: one shared atom drives every mount site across
 * both route trees, so the two surfaces can never show conflicting error state.
 *
 * Composed, not invented — it wraps the existing `ErrorBanner`, which already parses
 * Frappe's `_server_messages` envelope, derives amber/red severity from the server's
 * own indicator and renders each message as markdown. The error is therefore handed
 * over COMPLETELY UNMODIFIED, and the banner's heading-override prop is deliberately
 * left alone, so the server's own title and text reach the user verbatim: no
 * client-side paraphrasing and no client-side severity decision.
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

	// Radix funnels every close intent through here — the Escape key, an overlay
	// click and the action button's own implicit close all arrive as `false`.
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
				<ErrorBanner error={error} />
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
