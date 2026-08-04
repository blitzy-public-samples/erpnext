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
 * Shared, dismissible error dialog for the Bank Reconciliation and Bank Statement Importer surfaces
 * (FM1, FM2, FM3). Takes no props: one shared atom drives every mount site across both route trees,
 * so the surfaces can never show conflicting error state.
 *
 * The rejection is handed to the SHARED `ErrorBanner` EXACTLY as the SDK delivered it - by identity,
 * with nothing reshaped, cleared or re-encoded, and with `overrideHeading` left unset. That is what
 * makes the parser (`getErrorMessages`), the severity rule (`indicator === 'yellow'` -> amber, else
 * red), the heading rule and the message rendering the same single implementation the inline banner
 * call sites use, so this dialog and an inline banner can never disagree about the same rejection and
 * the server's own words - for example `"Bank Transaction {0} is already fully reconciled"` - reach
 * the reviewer verbatim.
 *
 * Untrusted markup inside those messages is handled where it is actually rendered: the shared markdown
 * renderer runs one restrictive allow-list sanitiser after `rehypeRaw` (`@/lib/sanitize-html`), which
 * protects this dialog and every other `ErrorBanner`/`Markdown` consumer at once.
 *
 * Dismissing clears the dialog atom and nothing else - it issues no request, triggers no revalidation
 * and raises no notification, because the calling hook owns revalidation and the backend remains the
 * sole authority on what was recorded.
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

	// An empty atom means "no error to show", mirroring the falsy-means-closed modal-atom convention
	// used throughout this feature folder.
	if (!error) {
		return null
	}

	return (
		<AlertDialog open onOpenChange={onOpenChange}>
			{/* Width follows the canonical pattern this dialog imitates,
			    `BankTransactionUnreconcileModal.tsx:37`. */}
			<AlertDialogContent className="min-w-2xl">
				<AlertDialogHeader>
					{/* Deliberately outcome-NEUTRAL: this chrome renders before the rejection has been
					    inspected, and a transport-level failure carries no server response at all, so the
					    client cannot know whether the operation was applied and must not say. FM1 makes
					    the backend response the sole source of truth. */}
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
