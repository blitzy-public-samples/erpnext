/**
 * Behavioural specification for allocating a payment across outstanding invoices.
 *
 * This is the second half of "Record Payment": having decided WHO the money moved to or from, the reviewer
 * then decides WHICH of that party's open invoices it settles. Every figure here ends up on a posted
 * Payment Entry, so the allocation arithmetic and the guards around it are financial behaviour, not
 * presentation.
 *
 * Crucially, the allocation itself is computed by the SERVER. The modal gathers the chosen invoices, asks
 * `allocate_amount_to_references` to distribute the payment across them, and then displays what came
 * back - so the client never invents an allocation of its own.
 *
 * Seven behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. The invoice picker OPENS ITSELF when a matching rule already supplies the party and account,
 *      because in that case the reviewer's next action is certain.
 *   2. The picker's trigger is WITHHELD until a party is known, since there is nobody to fetch invoices
 *      for.
 *   3. Selection is by OBJECT IDENTITY, not by index or voucher number, so the picker is immune to the
 *      list being reordered underneath it.
 *   4. The server's re-allocation REPLACES four form fields at once - references, total allocated,
 *      unallocated and difference - because they are one consistent answer rather than four values.
 *   5. A server advisory arriving alongside the invoices (`_server_messages`) is surfaced, because it is
 *      how the backend explains a short or empty list.
 *   6. "Select all" is a THREE-state affair: it is disabled with no rows, clears when everything is
 *      already selected, and otherwise selects everything.
 *   7. Removing rows takes a LIST of indices in one call, so removing several cannot shift the indices of
 *      the ones still to be removed.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'

import {
	createFrappeSDKMock,
	frappeSDKMock,
	frappePostCall,
	makeUnreconciledTransaction,
	makeServerMessagesError
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { TooltipProvider } from '@/components/ui/tooltip'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import RecordPaymentModalContent from './RecordPaymentModalContent'
import { bankRecSelectedTransactionsAtom, selectedBankAccountAtom } from './bankRecAtoms'
import { makePanelBank } from '@/test/renderPanel'

const OUTSTANDING_ENDPOINT =
	'erpnext.accounts.doctype.payment_entry.payment_entry.get_outstanding_reference_documents'

/**
 * A rule that names the party AND the account, which is what makes the picker open itself
 * (`RecordPaymentModalContent.tsx:295-300`).
 */
const MATCHING_RULE = {
	name: 'SUPPLIER-RULE',
	rule_name: 'ACME settlements',
	party_type: 'Supplier',
	party: 'ACME Traders',
	party_name: 'ACME Traders',
	account: 'Creditors - _TC'
}

interface Invoice {
	voucher_type: string
	voucher_no: string
	bill_no?: string
	due_date: string
	invoice_amount: number
	outstanding_amount: number
	allocated_amount?: number
	account?: string
}

const INVOICE_A: Invoice = {
	voucher_type: 'Purchase Invoice',
	voucher_no: 'ACC-PINV-2026-00001',
	bill_no: 'ACME-8801',
	due_date: '2026-08-20',
	invoice_amount: 3000,
	outstanding_amount: 3000,
	allocated_amount: 3000,
	account: 'Creditors - _TC'
}

const INVOICE_B: Invoice = {
	voucher_type: 'Purchase Invoice',
	voucher_no: 'ACC-PINV-2026-00002',
	bill_no: 'ACME-8802',
	due_date: '2026-08-25',
	invoice_amount: 2500,
	outstanding_amount: 1825.5,
	allocated_amount: 1825.5,
	account: 'Creditors - _TC'
}

/** What `allocate_amount_to_references` answers with: a whole re-allocated document. */
const makeAllocationAnswer = (invoices: Invoice[], paid = 4825.5) => ({
	docs: [
		{
			references: invoices.map((invoice) => ({
				reference_doctype: invoice.voucher_type,
				reference_name: invoice.voucher_no,
				bill_no: invoice.bill_no,
				due_date: invoice.due_date,
				total_amount: invoice.invoice_amount,
				outstanding_amount: invoice.outstanding_amount,
				allocated_amount: invoice.allocated_amount ?? invoice.outstanding_amount,
				account: invoice.account,
				exchange_rate: 1
			})),
			total_allocated_amount: invoices.reduce(
				(sum, invoice) => sum + (invoice.allocated_amount ?? invoice.outstanding_amount),
				0
			),
			unallocated_amount:
				paid -
				invoices.reduce(
					(sum, invoice) => sum + (invoice.allocated_amount ?? invoice.outstanding_amount),
					0
				),
			difference_amount: 0
		}
	]
})

const TRANSACTION = () =>
	makeUnreconciledTransaction({
		name: 'ACC-BTN-2026-00001',
		withdrawal: 4825.5,
		deposit: 0,
		unallocated_amount: 4825.5,
		matched_transaction_rule: MATCHING_RULE.name
	})

interface FlowOptions {
	rule?: typeof MATCHING_RULE | null
	invoices?: Invoice[]
	invoicesError?: ReturnType<typeof makeServerMessagesError>
	serverAdvisory?: string
	isLoading?: boolean
}

const renderFlow = ({
	rule = MATCHING_RULE,
	invoices = [INVOICE_A, INVOICE_B],
	invoicesError,
	serverAdvisory,
	isLoading = false
}: FlowOptions = {}) => {
	frappeSDKMock.useFrappeGetDoc.mockReturnValue({
		data: rule ?? undefined,
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: vi.fn()
	} as never)

	frappeSDKMock.useFrappeGetCall.mockImplementation(((method: string) => {
		if (method === OUTSTANDING_ENDPOINT) {
			return {
				data: invoicesError
					? undefined
					: {
						message: invoices,
						...(serverAdvisory
							? {
								_server_messages: JSON.stringify([
									JSON.stringify({ message: serverAdvisory })
								])
							}
							: {})
					},
				error: invoicesError,
				isLoading,
				isValidating: false,
				mutate: vi.fn()
			}
		}

		return {
			data: { message: [] },
			error: undefined,
			isLoading: false,
			isValidating: false,
			mutate: vi.fn()
		}
	}) as never)

	const bank = makePanelBank()
	const store = createStore()
	store.set(selectedBankAccountAtom, bank)
	store.set(bankRecSelectedTransactionsAtom, [TRANSACTION()])

	const user = userEvent.setup()

	render(
		<Provider store={store}>
			<TooltipProvider>
				<MemoryRouter>
					<Dialog open>
						<DialogContent>
							<RecordPaymentModalContent />
						</DialogContent>
					</Dialog>
				</MemoryRouter>
			</TooltipProvider>
		</Provider>
	)

	return { store, user }
}

/** The picker's own dialog, identified by its heading. */
const picker = () => screen.getByText('Select Invoices').closest('[role="dialog"]') as HTMLElement

/**
 * The allocation table in the payment form.
 *
 * Scoped by its own "Reference Document" header, because the form ALSO carries an Other Charges table
 * whose select-all has the identical accessible name - and, while a picker is closing, Radix keeps the
 * picker's table mounted too. An unscoped `getByRole('checkbox', { name: 'Select all' })` matches
 * several of them.
 */
const allocationTable = () =>
	screen.getByText('Reference Document').closest('table') as HTMLElement

const selectAllAllocations = () =>
	within(allocationTable()).getByRole('checkbox', { name: 'Select all' })

const allocationRow = (position: number) =>
	within(allocationTable()).getByRole('checkbox', { name: `Select row ${position}` })

/** Chooses invoices in the picker and confirms, returning once the allocation has been applied. */
const allocate = async (
	user: ReturnType<typeof userEvent.setup>,
	voucherNumbers: string[],
	answer = makeAllocationAnswer([INVOICE_A, INVOICE_B])
) => {
	frappePostCall.mockResolvedValue(answer)

	for (const voucherNumber of voucherNumbers) {
		await user.click(within(picker()).getByText(voucherNumber))
	}

	await user.click(within(picker()).getByRole('button', { name: /Select/ }))

	await waitFor(() => {
		expect(screen.queryByText('Select Invoices')).not.toBeInTheDocument()
	})
}

describe('allocating a recorded payment across invoices', () => {

	beforeEach(() => {
		frappePostCall.mockResolvedValue(makeAllocationAnswer([INVOICE_A, INVOICE_B]))
	})

	describe('reaching the invoice picker', () => {

		it('QUIRK - opens itself when a rule already supplies the party and account', async () => {
			// With the party and account already decided, choosing invoices is certainly the reviewer's
			// next action, so making them find a button first would be pure friction.
			renderFlow()

			expect(await screen.findByText('Select Invoices')).toBeInTheDocument()
		})

		it('states the amount being allocated', async () => {
			renderFlow()

			await screen.findByText('Select Invoices')

			// The amount is the constraint on the whole allocation, so it belongs in the heading rather
			// than only in the table below. Asserted on text content because the sentence is assembled
			// from separate nodes.
			expect(picker()).toHaveTextContent(/₹ 4,825.50/)
		})

		it('names the party in the heading rather than leaving a gap where the name should be', async () => {
			/*
			 * This heading interpolates `party_name`, which the payment form's defaults do not set -
			 * neither from the matching rule nor from the party lookup - so the sentence used to render
			 * as "Unpaid invoices from  for ₹ 4,825.50." with a hole in it, even though the party was
			 * perfectly well known and was what the invoices had just been fetched for.
			 *
			 * It now falls back to the party ID, which is always present. That is the same idiom the
			 * party fields on this form already use (`party_name !== party ? party_name : undefined`),
			 * so the sentence always names somebody.
			 */
			renderFlow()

			await screen.findByText('Select Invoices')

			expect(picker()).toHaveTextContent('Unpaid invoices from ACME Traders for ₹ 4,825.50.')
			expect(picker()).not.toHaveTextContent('Unpaid invoices from for')
		})

		it('reads the amount off the side of the entry that carries it', async () => {
			/*
			 * This fixture is a WITHDRAWAL, so the form is a payment (`payment_type: 'Pay'`) and the
			 * figure lives in `paid_amount`. The heading used to read `paid_amount` unconditionally,
			 * which is right here and wrong for a receipt, where this form fills `received_amount`
			 * instead - the same distinction the allocation calls in this component already make.
			 */
			renderFlow()

			await screen.findByText('Select Invoices')

			expect(picker()).toHaveTextContent('for ₹ 4,825.50.')
			// Not a zero, which is what reading the empty side of the entry would have produced.
			expect(picker()).not.toHaveTextContent('for ₹ 0.00.')
		})

		it('QUIRK - stays shut when the rule names no account', async () => {
			// A party alone is not enough: without an account the server cannot say which invoices are
			// outstanding against it.
			renderFlow({ rule: { ...MATCHING_RULE, account: '' } })

			await waitFor(() => {
				expect(screen.queryByText('Select Invoices')).not.toBeInTheDocument()
			})
		})

		it('QUIRK - withholds the trigger entirely when no party is known', async () => {
			// Nothing to fetch invoices FOR, so the affordance would only ever produce an error.
			renderFlow({ rule: null })

			await waitFor(() => {
				expect(screen.queryByText('Select Invoices')).not.toBeInTheDocument()
			})
			expect(
				screen.queryByRole('button', { name: 'Get Unpaid Invoices' })
			).not.toBeInTheDocument()
		})

		it('offers the trigger once a party is known, for a reviewer who closed the picker', async () => {
			const { user } = renderFlow()

			await screen.findByText('Select Invoices')
			await user.keyboard('{Escape}')

			await waitFor(() => {
				expect(screen.queryByText('Select Invoices')).not.toBeInTheDocument()
			})
			// Reopenable rather than a one-shot: the reviewer may want to change their mind.
			expect(
				screen.getByRole('button', { name: 'Get Unpaid Invoices' })
			).toBeInTheDocument()
		})
	})

	describe('what the picker shows', () => {

		it('lists each outstanding invoice with what is still owed on it', async () => {
			renderFlow()

			await screen.findByText('Select Invoices')

			expect(within(picker()).getByText('ACC-PINV-2026-00001')).toBeInTheDocument()
			expect(within(picker()).getByText('ACC-PINV-2026-00002')).toBeInTheDocument()
			// The outstanding figure differs from the invoice total on the second one, and it is the
			// outstanding figure that bounds the allocation.
			expect(within(picker()).getByText('₹ 1,825.50')).toBeInTheDocument()
		})

		it('QUIRK - surfaces a server advisory sent alongside the list', async () => {
			// The backend uses `_server_messages` to explain a short or empty list - for instance that
			// some invoices were skipped - and dropping it would leave the reviewer guessing.
			renderFlow({
				invoices: [INVOICE_A],
				serverAdvisory: 'No outstanding invoices found for the specified period'
			})

			await screen.findByText('Select Invoices')

			expect(
				within(picker()).getByText(
					'No outstanding invoices found for the specified period'
				)
			).toBeInTheDocument()
		})

		it('surfaces a refused fetch instead of an empty picker', async () => {
			renderFlow({ invoicesError: makeServerMessagesError('Not permitted') })

			await screen.findByText('Select Invoices')

			expect(within(picker()).getByText('Not permitted')).toBeInTheDocument()
		})

		it('names the supplier-invoice column after the field it actually renders', async () => {
			/*
			 * That column renders `bill_no`, which the server fills ONLY for a Purchase Invoice and which
			 * ERPNext labels "Supplier Invoice No". Calling it "Invoice No" misdirected the reviewer
			 * twice over: allocating a customer receipt they read a column of dashes under a heading
			 * promising invoice numbers, while the invoice number itself sat under "Name".
			 */
			renderFlow()

			await screen.findByText('Select Invoices')

			expect(within(picker()).getByText('Supplier Invoice No')).toBeInTheDocument()
			expect(within(picker()).queryByText('Invoice No')).not.toBeInTheDocument()
		})

		it("keeps ERPNext's own labels for the columns it already named correctly", async () => {
			/*
			 * "Type" and "Name" are the labels the Payment Entry Reference DocType itself gives
			 * `reference_doctype` and `reference_name`, and the Desk shows the same words over the same
			 * data. Renaming them to something that reads better would have made this view disagree
			 * with the rest of the product, so they are pinned as they are.
			 */
			renderFlow()

			await screen.findByText('Select Invoices')

			for (const header of ['Type', 'Name', 'Due Date', 'Grand Total', 'Outstanding']) {
				expect(within(picker()).getByText(header)).toBeInTheDocument()
			}
		})

		it('renders a dash when the server sends no supplier invoice number at all', async () => {
			// The server returns an EMPTY STRING for a Sales Invoice, which `??` let through as a blank
			// cell; only `undefined` reached the dash.
			renderFlow({
				invoices: [
					{ ...INVOICE_A, bill_no: '' },
					{ ...INVOICE_B, bill_no: undefined }
				]
			})

			await screen.findByText('Select Invoices')

			expect(within(picker()).getAllByText('-')).toHaveLength(2)
		})

		it("formats every figure in the entry's own currency rather than the system default", async () => {
			// The picker sits inside a payment for one bank account, so a figure shown in a different
			// currency to the entry it is being allocated against is simply wrong.
			renderFlow()

			await screen.findByText('Select Invoices')

			// Both the per-row figures and the running total carry the account's symbol.
			expect(within(picker()).getByText('₹ 1,825.50')).toBeInTheDocument()
			expect(picker()).not.toHaveTextContent('$')
		})

		it('gives the select-all checkbox a name instead of leaving it unlabelled', async () => {
			renderFlow()

			await screen.findByText('Select Invoices')

			expect(within(picker()).getByRole('checkbox', { name: 'Select all' })).toBeInTheDocument()
		})

		it('names each row checkbox after the invoice it selects, not by row number', async () => {
			// The header checkbox was named but the per-row ones were not, so a screen-reader user could
			// hear "checkbox" with no indication of which invoice they were about to allocate against.
			renderFlow()

			await screen.findByText('Select Invoices')

			expect(within(picker()).getByRole('checkbox', { name: 'Select invoice ACC-PINV-2026-00001' }))
				.toBeInTheDocument()
			expect(within(picker()).getByRole('checkbox', { name: 'Select invoice ACC-PINV-2026-00002' }))
				.toBeInTheDocument()
		})

		it('renders a dash for an absent due date, the same as for an absent invoice number', async () => {
			// A Journal Entry has no due date. A blank cell reads as a rendering failure; the cell beside
			// it already said "-" for the same absence, so the two now agree.
			renderFlow({ invoices: [{ ...INVOICE_A, due_date: '', bill_no: '' }] })

			await screen.findByText('Select Invoices')

			// Two dashes on the one row: Supplier Invoice No and Due Date.
			expect(within(picker()).getAllByText('-')).toHaveLength(2)
		})
	})

	describe('asking the server to allocate', () => {

		it('QUIRK - sends the chosen invoices and lets the SERVER distribute the payment', async () => {
			// The client never computes an allocation. It hands over the selection and the payment
			// amount, and `allocate_amount_to_references` decides how the money lands - which is what
			// keeps the split identical to what a Payment Entry would compute on the desk.
			const { user } = renderFlow()

			await screen.findByText('Select Invoices')
			await allocate(user, ['ACC-PINV-2026-00001'])

			expect(frappePostCall).toHaveBeenCalledWith(
				expect.objectContaining({
					method: 'allocate_amount_to_references',
					args: expect.objectContaining({
						allocate_payment_amount: 1,
						paid_amount_change: false
					})
				})
			)

			const sent = frappePostCall.mock.calls[0][0] as {
				docs: { references: { reference_name: string }[] }
			}
			expect(sent.docs.references.map((row) => row.reference_name)).toEqual([
				'ACC-PINV-2026-00001'
			])
		})

		it('sends the document as an unsaved local Payment Entry', async () => {
			// The server allocates against a document that does not exist yet, so it has to be marked
			// local and unsaved or the call would be taken as an edit to a real entry.
			const { user } = renderFlow()

			await screen.findByText('Select Invoices')
			await allocate(user, ['ACC-PINV-2026-00001'])

			const sent = frappePostCall.mock.calls[0][0] as {
				docs: Record<string, unknown>
			}
			expect(sent.docs).toMatchObject({
				doctype: 'Payment Entry',
				name: 'new-payment-entry-1',
				__unsaved: 1,
				__islocal: 1
			})
		})

		it('QUIRK - selects by object identity, so a reordered list cannot mis-select', async () => {
			// Selection holds the invoice OBJECTS rather than indices or voucher numbers, so choosing
			// the second row then the first sends them in the order they were chosen, unaffected by
			// where they sat in the list.
			const { user } = renderFlow()

			await screen.findByText('Select Invoices')
			await allocate(user, ['ACC-PINV-2026-00002', 'ACC-PINV-2026-00001'])

			const sent = frappePostCall.mock.calls[0][0] as {
				docs: { references: { reference_name: string }[] }
			}
			expect(sent.docs.references.map((row) => row.reference_name)).toEqual([
				'ACC-PINV-2026-00002',
				'ACC-PINV-2026-00001'
			])
		})

		it('deselects an invoice chosen by mistake', async () => {
			const { user } = renderFlow()

			await screen.findByText('Select Invoices')

			await user.click(within(picker()).getByText('ACC-PINV-2026-00001'))
			await user.click(within(picker()).getByText('ACC-PINV-2026-00001'))
			await user.click(within(picker()).getByText('ACC-PINV-2026-00002'))

			frappePostCall.mockResolvedValue(makeAllocationAnswer([INVOICE_B]))
			await user.click(within(picker()).getByRole('button', { name: /Select/ }))

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalled()
			})

			const sent = frappePostCall.mock.calls[0][0] as {
				docs: { references: { reference_name: string }[] }
			}
			expect(sent.docs.references.map((row) => row.reference_name)).toEqual([
				'ACC-PINV-2026-00002'
			])
		})
	})

	describe('after the server has allocated', () => {

		it('QUIRK - adopts the whole server answer, not just the references', async () => {
			// References, total allocated, unallocated and difference are ONE consistent answer.
			// Adopting only some of them would leave the summary contradicting the rows.
			const { user } = renderFlow()

			await screen.findByText('Select Invoices')
			await allocate(user, ['ACC-PINV-2026-00001', 'ACC-PINV-2026-00002'])

			// The rows the server allocated are now in the form ...
			expect(
				screen.getByRole('link', { name: 'Purchase Invoice: ACC-PINV-2026-00001' })
			).toBeInTheDocument()
			expect(
				screen.getByRole('link', { name: 'Purchase Invoice: ACC-PINV-2026-00002' })
			).toBeInTheDocument()
			// ... and each row carries the figures from that same answer. The first invoice is wholly
			// outstanding, so its total and outstanding columns necessarily agree; the second is part
			// paid, which is why its two figures differ and are individually identifiable.
			expect(within(allocationTable()).getAllByText('₹ 3,000.00')).toHaveLength(2)
			expect(within(allocationTable()).getByText('₹ 2,500.00')).toBeInTheDocument()
			expect(within(allocationTable()).getByText('₹ 1,825.50')).toBeInTheDocument()
		})

		it('names the supplier-invoice column correctly in the FORM table too, not just the picker', async () => {
			/*
			 * The form's own allocation table carried the identical mislabel the picker did: a header
			 * reading "Invoice No" over a cell rendering `bill_no`. The ERPNext document number lives in
			 * the "Reference Document" cell beside it, so a reviewer looking for the invoice number was
			 * being pointed at the wrong column on BOTH surfaces.
			 */
			const { user } = renderFlow()

			await screen.findByText('Select Invoices')
			await allocate(user, ['ACC-PINV-2026-00001'])

			// Asserted on the header ROW, because "Allocated" also appears as the hidden label of the
			// per-row amount field further down the same table.
			const headers = Array.from(allocationTable().querySelectorAll('thead th'))
				.map((cell) => (cell.textContent || '').trim())

			expect(headers).toContain('Supplier Invoice No')
			expect(headers).not.toContain('Invoice No')
			// The columns it already named correctly are left alone.
			expect(headers).toContain('Reference Document')
			expect(headers).toContain('Allocated')
		})

		it('renders a dash in the form table for an absent supplier invoice number or due date', async () => {
			/*
			 * The server sends an empty string for a Sales Invoice, which `??` let through as a blank cell.
			 *
			 * Note the allocation answer has to be overridden as well as the picker's list: these rows come
			 * from the SERVER's re-allocated document, not from the list the reviewer chose from.
			 */
			const bare = { ...INVOICE_A, bill_no: '', due_date: '' }

			const { user } = renderFlow({ invoices: [bare] })

			await screen.findByText('Select Invoices')
			// The answer has to be passed through `allocate`, which sets the post-call mock itself.
			await allocate(user, ['ACC-PINV-2026-00001'], makeAllocationAnswer([bare]))

			expect(within(allocationTable()).getAllByText('-')).toHaveLength(2)
		})

		it('shows each allocated invoice with the figures the server returned', async () => {
			const { user } = renderFlow()

			await screen.findByText('Select Invoices')
			await allocate(user, ['ACC-PINV-2026-00001', 'ACC-PINV-2026-00002'])

			expect(screen.getByText('ACME-8801')).toBeInTheDocument()
			expect(screen.getByText('ACME-8802')).toBeInTheDocument()
			// Due dates matter: they are how a reviewer spots that an old invoice is being skipped.
			expect(screen.getByText('20-08-2026')).toBeInTheDocument()
		})

		it('links each allocated invoice to its record', async () => {
			const { user } = renderFlow()

			await screen.findByText('Select Invoices')
			await allocate(user, ['ACC-PINV-2026-00001'])

			expect(
				screen.getByRole('link', { name: 'Purchase Invoice: ACC-PINV-2026-00001' })
			).toHaveAttribute('href', '/desk/purchase-invoice/ACC-PINV-2026-00001')
		})

		it('closes the picker, returning the reviewer to the payment form', async () => {
			const { user } = renderFlow()

			await screen.findByText('Select Invoices')
			await allocate(user, ['ACC-PINV-2026-00001'])

			expect(screen.queryByText('Select Invoices')).not.toBeInTheDocument()
			expect(screen.getByText('Invoices')).toBeInTheDocument()
		})
	})

	describe('adjusting the allocation afterwards', () => {

		const withTwoAllocated = async () => {
			const { store, user } = renderFlow()

			await screen.findByText('Select Invoices')
			await allocate(user, ['ACC-PINV-2026-00001', 'ACC-PINV-2026-00002'])

			return { store, user }
		}

		it('QUIRK - disables select-all while there is nothing to select', async () => {
			renderFlow({ rule: null })

			await waitFor(() => {
				expect(screen.getByText('Invoices')).toBeInTheDocument()
			})

			expect(selectAllAllocations()).toBeDisabled()
		})

		it('selects every allocated row at once', async () => {
			const { user } = await withTwoAllocated()

			await user.click(selectAllAllocations())

			await waitFor(() => {
				expect(allocationRow(1)).toBeChecked()
			})
			expect(allocationRow(2)).toBeChecked()
		})

		it('QUIRK - clears the selection when everything is already selected', async () => {
			// The third state of the same control: with all rows selected it becomes "select none",
			// which is the only way to undo a select-all without clicking every row.
			const { user } = await withTwoAllocated()

			await user.click(selectAllAllocations())
			await waitFor(() => {
				expect(allocationRow(1)).toBeChecked()
			})

			await user.click(selectAllAllocations())

			await waitFor(() => {
				expect(allocationRow(1)).not.toBeChecked()
			})
			expect(allocationRow(2)).not.toBeChecked()
		})

		it('offers removal only once something is selected', async () => {
			const { user } = await withTwoAllocated()

			// No selection, no destructive control on screen.
			expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument()

			await user.click(allocationRow(1))

			expect(
				await screen.findByRole('button', { name: /Remove/ })
			).toBeInTheDocument()
		})

		it('removes a selected invoice from the allocation', async () => {
			const { user } = await withTwoAllocated()

			await user.click(allocationRow(1))
			await user.click(await screen.findByRole('button', { name: /Remove/ }))

			await waitFor(() => {
				expect(
					screen.queryByRole('link', { name: 'Purchase Invoice: ACC-PINV-2026-00001' })
				).not.toBeInTheDocument()
			})
			// The one that was not selected survives.
			expect(
				screen.getByRole('link', { name: 'Purchase Invoice: ACC-PINV-2026-00002' })
			).toBeInTheDocument()
		})

		it('QUIRK - removes several rows in one call, so indices cannot shift mid-removal', async () => {
			// `remove(selectedRows)` takes the whole list. Removing one at a time would renumber the
			// remaining rows after each removal and delete the wrong ones.
			const { user } = await withTwoAllocated()

			await user.click(selectAllAllocations())
			await waitFor(() => {
				expect(allocationRow(1)).toBeChecked()
			})

			await user.click(await screen.findByRole('button', { name: /Remove/ }))

			await waitFor(() => {
				expect(
					screen.queryByRole('link', { name: /Purchase Invoice: ACC-PINV/ })
				).not.toBeInTheDocument()
			})
		})

		it('clears the selection after removing, so the control cannot act twice', async () => {
			const { user } = await withTwoAllocated()

			await user.click(allocationRow(1))
			await user.click(await screen.findByRole('button', { name: /Remove/ }))

			await waitFor(() => {
				expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument()
			})
		})
	})
})
