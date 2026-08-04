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
import { bankRecErrorDialogAtom } from "./bankRecAtoms"
import _ from "@/lib/translate"

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
 */
const BankRecErrorDialog = () => {
	const [error, setError] = useAtom(bankRecErrorDialogAtom)

	// Radix funnels its close intents through here: the Escape key and the action button's own
	// implicit close both arrive as `false`. An overlay click deliberately does NOT - `AlertDialog`
	// suppresses interact-outside - so Escape and Dismiss are what make this dismissible.
	const onOpenChange = (open: boolean) => {
		if (!open) {
			setError(null)
		}
	}

	if (!error) {
		return null
	}

	return (
		<AlertDialog open onOpenChange={onOpenChange}>
			<AlertDialogContent className="min-w-2xl">
				<AlertDialogHeader>
					{/* Outcome-neutral: a transport-level failure carries no server response, so the client
					    cannot know whether the operation was applied and must not say. */}
					<AlertDialogTitle>{_("Something went wrong")}</AlertDialogTitle>
					<AlertDialogDescription>
						{_("Review the details below, then dismiss this message to continue. The server remains the authority on what was recorded.")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<ErrorBanner error={error} />
				<AlertDialogFooter>
					<AlertDialogAction onClick={() => setError(null)}>
						{_("Dismiss")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

export default BankRecErrorDialog
