import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useAtom } from "jotai"
import { Loader2Icon } from "lucide-react"
import { lazy, Suspense, useEffect } from "react"
import { bankRecUnreconcileModalAtom } from "./bankRecAtoms"
import _ from "@/lib/translate"

/*
 * Held as a named loader so the chunk can be WARMED before it is needed as well as loaded when it is.
 *
 * The body carries the dialog's Cancel button, and Radix's alert dialog moves focus by focusing that
 * button and nothing else - so a cold first open had no Cancel to focus and left focus behind in the
 * background. `AlertDialogContent` now backstops that unconditionally, but fetching the chunk while the
 * reviewer is still reading the list means the common case never needs the backstop: the real Cancel is
 * mounted by the time the dialog opens, and this destructive action behaves identically on its first
 * open and its tenth.
 */
const loadUnreconcileModalBody = () => import('./BankTransactionUnreconcileModalBody')

const BankTransactionUnreconcileModalBody = lazy(loadUnreconcileModalBody)

const BankTransactionUnreconcileModalFallback = () => (
	<div className="flex items-center justify-center py-16">
		<Loader2Icon className="size-6 animate-spin text-muted-foreground" />
	</div>
)

const BankTransactionUnreconcileModal = () => {
	const [unreconcileModal, setBankRecUnreconcileModal] = useAtom(bankRecUnreconcileModalAtom)

	// Warmed on mount, which is long before any row's Undo can be reached. A failed prefetch is ignored:
	// `lazy` will simply fetch it again when it is actually rendered.
	useEffect(() => {
		void loadUnreconcileModalBody().catch(() => undefined)
	}, [])

	const onOpenChange = (v: boolean) => {
		if (!v) {
			setBankRecUnreconcileModal('')
		}
	}

	if (!unreconcileModal) {
		return null
	}

	return (
		<AlertDialog open onOpenChange={onOpenChange}>
			<AlertDialogContent size="2xl">
				<AlertDialogHeader>
					<AlertDialogTitle>{_("Undo Transaction Reconciliation")}</AlertDialogTitle>
					<AlertDialogDescription>
						{_("Are you sure you want to unreconcile this transaction?")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<Suspense fallback={<BankTransactionUnreconcileModalFallback />}>
					<BankTransactionUnreconcileModalBody />
				</Suspense>
			</AlertDialogContent>
		</AlertDialog>
	)
}

export default BankTransactionUnreconcileModal
