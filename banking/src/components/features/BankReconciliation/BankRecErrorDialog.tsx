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
 *
 * Sizing widens the primitive's `sm:max-w-lg` cap to `2xl` from the same breakpoint, rather than
 * setting a minimum width: a `min-width` beats a `max-width` in CSS, so a fixed `2xl` minimum forced
 * the box wider than a viewport narrower than roughly 704px and overflowed it horizontally. Height is
 * capped against the dynamic viewport and only the banner scrolls, so a long stack of server messages
 * can never push the Dismiss control off screen.
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
			<AlertDialogContent className="data-[size=default]:sm:max-w-2xl max-h-[calc(100dvh-4rem)]">
				<AlertDialogHeader>
					{/* Outcome-neutral: a transport-level failure carries no server response, so the client
					    cannot know whether the operation was applied and must not say. */}
					<AlertDialogTitle>{_("Something went wrong")}</AlertDialogTitle>
					<AlertDialogDescription>
						{_("Review the details below, then dismiss this message to continue. The server remains the authority on what was recorded.")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{/* `min-h-0` is what lets this grid row shrink below its content, so the height cap above
				    scrolls the messages instead of growing the dialog past the viewport. */}
				<div className="min-h-0 overflow-y-auto">
					<ErrorBanner error={error} />
				</div>
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
