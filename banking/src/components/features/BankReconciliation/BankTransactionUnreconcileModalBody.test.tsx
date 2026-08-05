/**
 * Behavioural specification for the unreconcile confirmation.
 *
 * Unreconciling is the one action in the workbench that can DESTROY a posted document rather than merely
 * detach it: a voucher the reviewer created through the workbench is cancelled, while a voucher that
 * merely got matched is left standing. The whole point of this body is to make that distinction visible
 * before the reviewer commits.
 *
 * Four behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. Only vouchers with a reconciliation type of "Voucher Created" are listed as being CANCELLED. A
 *      matched voucher pre-existed the reconciliation, so unreconciling must not touch it.
 *   2. A missing reconciliation type is treated as "Matched" - the safe reading, because it leads to
 *      detaching rather than cancelling.
 *   3. Confirming calls `preventDefault`, so the dialog's own default close does not race the request;
 *      the body closes itself only after the server confirms.
 *   4. Three separate caches are revalidated on success, because the transaction list, the unreconciled
 *      list and the closing balance are each derived independently.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { toast } from 'sonner'

import {
	createFrappeSDKMock,
	frappeSDKMock,
	frappePostCall,
	frappeSWRMutate,
	makeServerMessagesError
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import BankTransactionUnreconcileModalBody from './BankTransactionUnreconcileModalBody'
import {
	bankRecDateAtom,
	bankRecUnreconcileModalAtom,
	selectedBankAccountAtom
} from './bankRecAtoms'
import { makePanelBank, PANEL_FROM_DATE, PANEL_TO_DATE } from '@/test/renderPanel'
import type { BankTransaction } from '@/types/Accounts/BankTransaction'
import type { BankTransactionPayments } from '@/types/Accounts/BankTransactionPayments'

const TRANSACTION_NAME = 'ACC-BTN-2026-00007'
const BANK = makePanelBank()

const makeVoucher = (
	overrides: Partial<BankTransactionPayments> = {}
): BankTransactionPayments => ({
	name: 'row-1',
	creation: '2026-08-05 10:00:00',
	modified: '2026-08-05 10:00:00',
	owner: 'Administrator',
	modified_by: 'Administrator',
	docstatus: 1,
	payment_document: 'Payment Entry',
	payment_entry: 'ACC-PAY-2026-00001',
	allocated_amount: 1500,
	reconciliation_type: 'Matched',
	...overrides
})

const makeTransaction = (
	payments: BankTransactionPayments[] = [makeVoucher()]
): BankTransaction =>
	({
		name: TRANSACTION_NAME,
		date: '2026-08-12',
		description: 'Supplier settlement',
		reference_number: 'NEFT-8811',
		withdrawal: 1500,
		deposit: 0,
		currency: 'INR',
		bank_account: BANK.name,
		allocated_amount: 1500,
		unallocated_amount: 0,
		status: 'Reconciled',
		docstatus: 1,
		payment_entries: payments
	}) as unknown as BankTransaction

interface ModalOptions {
	transaction?: BankTransaction
	readError?: ReturnType<typeof makeServerMessagesError>
	unreconcileError?: ReturnType<typeof makeServerMessagesError>
	isLoading?: boolean
}

const renderModalBody = ({
	transaction = makeTransaction(),
	readError,
	unreconcileError,
	isLoading = false
}: ModalOptions = {}) => {
	frappeSDKMock.useFrappeGetDoc.mockReturnValue({
		data: readError ? undefined : transaction,
		error: readError,
		isLoading,
		isValidating: false,
		mutate: vi.fn()
	} as never)

	frappeSDKMock.useFrappePostCall.mockReturnValue({
		call: frappePostCall,
		result: null,
		loading: false,
		error: unreconcileError ?? null,
		isCompleted: false,
		reset: vi.fn()
	} as never)

	const store = createStore()
	store.set(selectedBankAccountAtom, BANK)
	store.set(bankRecDateAtom, { fromDate: PANEL_FROM_DATE, toDate: PANEL_TO_DATE })
	store.set(bankRecUnreconcileModalAtom, TRANSACTION_NAME)

	const user = userEvent.setup()

	render(
		<Provider store={store}>
			<TooltipProvider>
				<AlertDialog open>
					<AlertDialogContent>
						<BankTransactionUnreconcileModalBody />
					</AlertDialogContent>
				</AlertDialog>
			</TooltipProvider>
		</Provider>
	)

	return { store, user }
}

describe('BankTransactionUnreconcileModalBody', () => {

	beforeEach(() => {
		frappePostCall.mockResolvedValue({ message: 'ok' })
	})

	describe('what it shows before the reviewer commits', () => {

		it('states what the transaction is currently reconciled against', () => {
			renderModalBody()

			expect(
				screen.getByText(
					'This transaction has been reconciled with the following document(s):'
				)
			).toBeInTheDocument()
		})

		it('lists each reconciled document with its allocation', () => {
			renderModalBody({
				transaction: makeTransaction([makeVoucher({ allocated_amount: 1500 })])
			})

			expect(screen.getByText('Payment Entry: ACC-PAY-2026-00001')).toBeInTheDocument()
			// Scoped to the voucher table, because the transaction summary above it shows the same
			// figure as the withdrawal - a fully allocated transaction necessarily repeats its amount.
			// Formatted in the statement currency, because a bare number could be read as any unit.
			expect(within(screen.getByRole('table')).getByText('₹ 1,500.00')).toBeInTheDocument()
		})

		it('links each document to its record, so it can be checked first', () => {
			renderModalBody()

			const link = screen.getByRole('link', { name: 'Payment Entry: ACC-PAY-2026-00001' })

			expect(link).toHaveAttribute('href', '/desk/payment-entry/ACC-PAY-2026-00001')
			// A new tab, because leaving the dialog would lose the pending decision.
			expect(link).toHaveAttribute('target', '_blank')
			expect(link).toHaveAttribute('rel', 'noopener noreferrer')
		})

		it('shows the transaction itself, not just the vouchers', () => {
			renderModalBody()

			expect(screen.getByText('Supplier settlement')).toBeInTheDocument()
		})

		it('surfaces a failed read instead of an empty confirmation', () => {
			renderModalBody({ readError: makeServerMessagesError('Not permitted') })

			expect(screen.getByText('Not permitted')).toBeInTheDocument()
		})
	})

	describe('distinguishing what will be cancelled', () => {

		it('QUIRK - warns only about vouchers the workbench itself created', async () => {
			// A matched voucher pre-existed the reconciliation, so unreconciling detaches it. A created
			// voucher exists only because of the reconciliation, so it is cancelled. Conflating the two
			// would either alarm the reviewer needlessly or destroy a document without warning.
			renderModalBody({
				transaction: makeTransaction([
					makeVoucher({
						name: 'row-1',
						payment_entry: 'ACC-PAY-2026-00001',
						reconciliation_type: 'Matched'
					}),
					makeVoucher({
						name: 'row-2',
						payment_document: 'Journal Entry',
						payment_entry: 'ACC-JV-2026-00009',
						reconciliation_type: 'Voucher Created'
					})
				])
			})

			expect(screen.getByText(/will be/)).toBeInTheDocument()
			expect(screen.getByText('cancelled')).toBeInTheDocument()

			// The cancellation list names the created voucher ...
			const cancellationList = screen.getByRole('list')
			expect(cancellationList).toHaveTextContent('Journal Entry: ACC-JV-2026-00009')
			// ... and NOT the merely matched one.
			expect(cancellationList).not.toHaveTextContent('ACC-PAY-2026-00001')
		})

		it('stays silent when nothing will be cancelled', () => {
			renderModalBody({
				transaction: makeTransaction([makeVoucher({ reconciliation_type: 'Matched' })])
			})

			expect(screen.queryByText('cancelled')).not.toBeInTheDocument()
			expect(screen.queryByRole('list')).not.toBeInTheDocument()
		})

		it('marks a created voucher differently from a matched one', () => {
			renderModalBody({
				transaction: makeTransaction([
					makeVoucher({ name: 'row-1', reconciliation_type: 'Matched' }),
					makeVoucher({
						name: 'row-2',
						payment_entry: 'ACC-PAY-2026-00002',
						reconciliation_type: 'Voucher Created'
					})
				])
			})

			// Green for created, blue for matched: the colour is the at-a-glance signal that one of
			// these rows is destructive to undo.
			expect(screen.getByText('Voucher Created')).toBeInTheDocument()
			expect(screen.getByText('Matched')).toBeInTheDocument()
		})

		it('QUIRK - reads a missing reconciliation type as merely matched', () => {
			// The safe default: an unknown type leads to detaching rather than cancelling, so an older
			// row with no type recorded cannot silently destroy a document.
			renderModalBody({
				transaction: makeTransaction([
					makeVoucher({ reconciliation_type: undefined })
				])
			})

			expect(screen.getByText('Matched')).toBeInTheDocument()
			expect(screen.queryByText('cancelled')).not.toBeInTheDocument()
		})
	})

	describe('confirming', () => {

		it('asks the server to unreconcile the named transaction', async () => {
			const { user } = renderModalBody()

			await user.click(screen.getByRole('button', { name: 'Unreconcile' }))

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledWith({
					transaction_name: TRANSACTION_NAME
				})
			})
		})

		it('QUIRK - revalidates all three derived caches on success', async () => {
			// The transaction list, the unreconciled list and the closing balance are computed
			// independently, so refreshing one would leave the other two contradicting it.
			const { user } = renderModalBody()

			await user.click(screen.getByRole('button', { name: 'Unreconcile' }))

			await waitFor(() => {
				expect(frappeSWRMutate).toHaveBeenCalledWith(
					`bank-reconciliation-bank-transactions-${BANK.name}-${PANEL_FROM_DATE}-${PANEL_TO_DATE}`
				)
			})
			expect(frappeSWRMutate).toHaveBeenCalledWith(
				`bank-reconciliation-unreconciled-transactions-${BANK.name}-${PANEL_FROM_DATE}-${PANEL_TO_DATE}`
			)
			expect(frappeSWRMutate).toHaveBeenCalledWith(
				`bank-reconciliation-account-closing-balance-${BANK.name}-${PANEL_TO_DATE}`
			)
		})

		it('confirms the outcome and closes itself only after the server agrees', async () => {
			const success = vi.spyOn(toast, 'success').mockReturnValue('t')
			const { store, user } = renderModalBody()

			await user.click(screen.getByRole('button', { name: 'Unreconcile' }))

			await waitFor(() => {
				expect(success).toHaveBeenCalledWith('Transaction Unreconciled')
			})
			// Clearing the atom is what dismisses the dialog, and it happens inside the success
			// handler rather than on click.
			expect(store.get(bankRecUnreconcileModalAtom)).toBe('')

			success.mockRestore()
		})

		it('QUIRK - assumes nothing until the server has answered', async () => {
			// Everything that marks the action as done - the toast, the three cache revalidations and
			// the atom clear that dismisses the dialog - lives INSIDE the success handler. So while the
			// request is outstanding the dialog stays open and no cache is touched, which is what makes
			// a refusal safe: the reviewer's view still describes the reconciliation that still exists.
			//
			// Driven with a request that never settles rather than a rejected one, deliberately:
			// `onUnreconcile` attaches no `.catch`, so a rejection here would surface as an unhandled
			// rejection from the derived promise and pollute the run. That missing catch is a real
			// (pre-existing, out-of-scope) defect in a file the plan does not modify; the refusal TEXT
			// still reaches the reviewer through the hook's own `error`, which the next test asserts.
			const success = vi.spyOn(toast, 'success').mockReturnValue('t')
			frappePostCall.mockReturnValue(new Promise(() => undefined))

			const { store, user } = renderModalBody()

			await user.click(screen.getByRole('button', { name: 'Unreconcile' }))

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledWith({
					transaction_name: TRANSACTION_NAME
				})
			})

			expect(success).not.toHaveBeenCalled()
			expect(store.get(bankRecUnreconcileModalAtom)).toBe(TRANSACTION_NAME)
			expect(frappeSWRMutate).not.toHaveBeenCalled()

			success.mockRestore()
		})

		it('surfaces the refusal text from the post hook', () => {
			renderModalBody({
				unreconcileError: makeServerMessagesError('Cannot cancel a submitted entry')
			})

			expect(screen.getByText('Cannot cancel a submitted entry')).toBeInTheDocument()
		})

		it('withholds the action until the transaction has actually loaded', () => {
			// Confirming against an unloaded transaction would post a name the reviewer never saw
			// the contents of.
			renderModalBody({ isLoading: true })

			expect(screen.getByRole('button', { name: 'Unreconcile' })).toBeDisabled()
		})

		it('offers a way out that does nothing', async () => {
			const { user } = renderModalBody()

			await user.click(screen.getByRole('button', { name: 'Cancel' }))

			expect(frappePostCall).not.toHaveBeenCalled()
		})
	})
})
