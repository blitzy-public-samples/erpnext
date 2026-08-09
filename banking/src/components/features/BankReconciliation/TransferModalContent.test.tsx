/**
 * Behavioural specification for the "Internal Transfer" modal.
 *
 * A reviewer reaches this surface when a bank transaction is the other half of a movement between two of
 * the company's OWN accounts - a sweep between bank accounts, or a cash deposit - rather than a dealing
 * with a third party. It creates a Payment Entry of type Internal Transfer and reconciles against it in
 * one server call.
 *
 * The subject is a modal BODY: it renders inside an already-open dialog and uses `DialogClose` for its
 * cancel control, so every render below supplies an open `Dialog`, which is the context Radix requires and
 * which the production mount provides.
 *
 * Three behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. It routes on the SIZE of the selection - none, one, or several - into three genuinely different
 *      forms, and the single and bulk branches post to DIFFERENT endpoints.
 *   2. Its primary control is labelled "Transfer" rather than "Submit", because what it creates is not a
 *      payment to anyone.
 *   3. The selection is read from a per-bank-account atom family, so a selection made against another
 *      account is invisible here.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'

import { TooltipProvider } from '@/components/ui/tooltip'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { createFrappeSDKMock, frappePostCall, frappeSDKMock, makeUnreconciledTransaction } from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import TransferModalContent from './TransferModalContent'
import { bankRecSelectedTransactionsAtom, selectedBankAccountAtom } from './bankRecAtoms'
import { makePanelBank } from '@/test/renderPanel'

const SINGLE_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.create_internal_transfer'
const BULK_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.create_bulk_internal_transfer'

const transfer = (overrides: Record<string, unknown> = {}) =>
	makeUnreconciledTransaction({
		name: 'ACC-BTN-2026-00001',
		withdrawal: 5000,
		deposit: 0,
		unallocated_amount: 5000,
		description: 'Sweep to deposit account',
		...overrides
	})

const renderModal = (selection: ReturnType<typeof transfer>[] = [], bank = makePanelBank()) => {
	const store = createStore()
	store.set(selectedBankAccountAtom, bank)
	store.set(bankRecSelectedTransactionsAtom, selection)

	return {
		store,
		...render(
			<Provider store={store}>
				<TooltipProvider>
					<MemoryRouter>
						<Dialog open>
							<DialogContent>
								<TransferModalContent />
							</DialogContent>
						</Dialog>
					</MemoryRouter>
				</TooltipProvider>
			</Provider>
		)
	}
}

const registeredPostEndpoints = () =>
	frappeSDKMock.useFrappePostCall.mock.calls.map(([method]) => method)

describe('TransferModalContent', () => {

	beforeEach(() => {
		frappeSDKMock.useFrappeGetCall.mockReturnValue({
			data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
		})
		frappeSDKMock.useFrappeGetDocList.mockReturnValue({
			data: [], error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
		})
	})

	describe('when nothing is selected', () => {

		it('says so rather than rendering an empty form', () => {
			renderModal([])

			expect(screen.getByText('No transaction selected')).toBeInTheDocument()
		})

		it('says so when no bank account is chosen either', () => {
			renderModal([], null as unknown as ReturnType<typeof makePanelBank>)

			expect(screen.getByText('No transaction selected')).toBeInTheDocument()
		})

		it('registers no transfer endpoint on that branch', () => {
			renderModal([])

			expect(registeredPostEndpoints()).not.toContain(SINGLE_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(BULK_ENDPOINT)
		})
	})

	describe('when exactly one transaction is selected', () => {

		it('renders the single transfer form', () => {
			renderModal([transfer()])

			expect(screen.queryByText('No transaction selected')).not.toBeInTheDocument()
			expect(screen.getByText('Posting Date')).toBeInTheDocument()
		})

		it('QUIRK - registers the SINGLE-transfer endpoint', () => {
			renderModal([transfer()])

			expect(registeredPostEndpoints()).toContain(SINGLE_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(BULK_ENDPOINT)
		})

		it('asks which account the money left and which it arrived in', () => {
			// Both sides are the company's own, which is what distinguishes this from a payment.
			renderModal([transfer()])

			expect(screen.getByText('Paid From')).toBeInTheDocument()
			expect(screen.getByText('Paid To')).toBeInTheDocument()
		})

		it('offers the reference fields a transfer is traced by', () => {
			renderModal([transfer()])

			expect(screen.getByText('Reference Date')).toBeInTheDocument()
			expect(screen.getByText('Reference')).toBeInTheDocument()
		})

		it('QUIRK - labels its primary control Transfer rather than Submit', () => {
			// What it creates is not a payment to anybody, and the label says so.
			renderModal([transfer()])

			expect(screen.getByRole('button', { name: 'Transfer' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
		})

		it('renders an inbound transfer as readily as an outbound one', () => {
			renderModal([transfer({ withdrawal: 0, deposit: 5000, unallocated_amount: 5000 })])

			expect(screen.getByText('Paid From')).toBeInTheDocument()
			expect(registeredPostEndpoints()).toContain(SINGLE_ENDPOINT)
		})
	})

	describe('when several transactions are selected', () => {

		const twoTransfers = [
			transfer({ name: 'ACC-BTN-2026-00001' }),
			transfer({ name: 'ACC-BTN-2026-00002', withdrawal: 2500, unallocated_amount: 2500 })
		]

		it('renders the bulk form instead of the single one', () => {
			renderModal(twoTransfers)

			expect(screen.queryByText('No transaction selected')).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Transfer' })).toBeInTheDocument()
		})

		it('QUIRK - registers the BULK endpoint, so the batch posts atomically', () => {
			renderModal(twoTransfers)

			expect(registeredPostEndpoints()).toContain(BULK_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(SINGLE_ENDPOINT)
		})

		it('offers a way out as well as a way forward', () => {
			renderModal(twoTransfers)

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Transfer' })).toBeInTheDocument()
		})

		it('scales past two without changing branch', () => {
			renderModal([
				transfer({ name: 'ACC-BTN-2026-00001' }),
				transfer({ name: 'ACC-BTN-2026-00002' }),
				transfer({ name: 'ACC-BTN-2026-00003' })
			])

			expect(registeredPostEndpoints()).toContain(BULK_ENDPOINT)
		})
	})

	/**
	 * The five required fields on this form carried `isRequired`, which drew the red asterisk and set
	 * `aria-required`, and nothing else. Validation lives in a separate `rules` prop that this form never
	 * supplied, so the constraint was an assertion to the reader that the form itself did not hold: an
	 * empty Reference submitted, the control was never marked invalid, no message appeared, and the
	 * request went to `create_internal_transfer` regardless.
	 *
	 * It is worth being precise about what that cost. `paid_to` defaults to the matching rule's account
	 * or the empty string, so on a withdrawal with no rule the destination account is blank until the
	 * reviewer picks one - and submitting sent that blank straight to the server as the other half of an
	 * internal transfer.
	 *
	 * The rule is now derived from `isRequired` inside the form primitives, so the two cannot drift apart
	 * again. The three behaviours below are what "required" has to mean: the request is not sent, the
	 * control is marked invalid, and the reviewer is told which field to fix.
	 */
	describe('required fields', () => {

		const submit = async () => {
			const user = userEvent.setup()
			await user.click(screen.getByRole('button', { name: 'Transfer' }))
			return user
		}

		/**
		 * Resolved by the control's `name` attribute rather than by its accessible name.
		 *
		 * The accessible name is the label plus the required indicator's screen-reader text, so it reads
		 * `Reference(required)` - and both the wording and the spacing of that suffix are an accessibility
		 * concern in their own right, which means an assertion keyed on it would break the moment that is
		 * improved. `name` is the field's identity in the form and is exactly what the request carries.
		 */
		const field = (name: string): HTMLInputElement => {
			const node = document.querySelector<HTMLInputElement>(`input[name="${name}"]`)
			if (!node) throw new Error(`no control named ${name}`)
			return node
		}

		it('blocks the request when Reference is cleared', async () => {
			renderModal([transfer({ reference_number: 'SWEEP-1' })])
			const user = userEvent.setup()

			await user.clear(field('reference_no'))
			await user.click(screen.getByRole('button', { name: 'Transfer' }))

			// The point of the finding: nothing may reach the server.
			expect(frappePostCall).not.toHaveBeenCalled()
		})

		it('marks the cleared control invalid and names it in a message', async () => {
			renderModal([transfer({ reference_number: 'SWEEP-1' })])
			const user = userEvent.setup()

			const reference = field('reference_no')
			await user.clear(reference)
			await user.click(screen.getByRole('button', { name: 'Transfer' }))

			await waitFor(() => {
				expect(reference).toHaveAttribute('aria-invalid', 'true')
			})
			// Named rather than a bare "this field is required": several labels here are visually
			// similar and one form holds twelve controls.
			expect(await screen.findByText('Reference is required')).toBeInTheDocument()
		})

		/**
		 * The destination account is genuinely empty on arrival for a withdrawal with no matching rule -
		 * `paid_to` defaults to `rule?.account ?? ''` - so this is not a contrived blank but the state the
		 * form opens in.
		 */
		it('blocks the request when the destination account was never chosen', async () => {
			renderModal([transfer()])

			await submit()

			expect(frappePostCall).not.toHaveBeenCalled()
			expect(await screen.findByText('Paid To is required')).toBeInTheDocument()
		})

		it('states the constraint in the accessible tree as well as in the asterisk', () => {
			renderModal([transfer({ reference_number: 'SWEEP-1' })])

			// `aria-required` rather than the native attribute: no <form> here sets `noValidate`, so a
			// native `required` would hand validation to the browser's own bubble and pre-empt the
			// form's own message.
			expect(field('reference_no')).toHaveAttribute('aria-required', 'true')
		})

		it('still submits once every required field is answered', async () => {
			frappePostCall.mockResolvedValue({
				message: { transaction: { name: 'ACC-BTN-2026-00001' }, payment_entry: { name: 'ACC-PAY-2026-00001' } }
			} as never)

			// A deposit pre-fills `paid_to` with the selected bank account, so the only blank left is the
			// source account, which the recommended-account default supplies.
			renderModal([
				transfer({
					withdrawal: 0,
					deposit: 5000,
					unallocated_amount: 5000,
					reference_number: 'SWEEP-1'
				})
			])

			const user = userEvent.setup()
			await user.click(screen.getByRole('button', { name: 'Transfer' }))

			// Guards against the fix overshooting into "nothing can ever be submitted": with `paid_from`
			// still blank the form must refuse, and it must refuse for that field and no other.
			expect(await screen.findByText('Paid From is required')).toBeInTheDocument()
			expect(screen.queryByText('Reference is required')).not.toBeInTheDocument()
			expect(screen.queryByText('Posting Date is required')).not.toBeInTheDocument()
			expect(screen.queryByText('Reference Date is required')).not.toBeInTheDocument()
			expect(screen.queryByText('Paid To is required')).not.toBeInTheDocument()
		})
	})

	describe('QUIRK - the selection is scoped per bank account', () => {

		it('sees nothing when the selection was made against a DIFFERENT account', () => {
			const store = createStore()

			/*
			 * The selection is made while ANOTHER account is picked, then the account is switched. That is
			 * how a cross-scope selection actually arises, and it also pins the half that used to fail:
			 * the selection is orphaned rather than parked, so switching back cannot replay it.
			 */
			store.set(selectedBankAccountAtom, makePanelBank({ name: 'Some Other Account' }))
			store.set(bankRecSelectedTransactionsAtom, [transfer()])
			store.set(selectedBankAccountAtom, makePanelBank())

			render(
				<Provider store={store}>
					<TooltipProvider>
						<MemoryRouter>
							<Dialog open>
								<DialogContent>
									<TransferModalContent />
								</DialogContent>
							</Dialog>
						</MemoryRouter>
					</TooltipProvider>
				</Provider>
			)

			expect(screen.getByText('No transaction selected')).toBeInTheDocument()
		})
	})
})
