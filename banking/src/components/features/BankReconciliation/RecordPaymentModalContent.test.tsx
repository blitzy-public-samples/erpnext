/**
 * Behavioural specification for the "Record Payment" modal.
 *
 * This is the surface a reviewer uses when a bank transaction has NO matching voucher: instead of linking
 * an existing one, they create a Payment Entry and reconcile against it in a single server call. The
 * modal therefore both composes a financial document and posts a reconciliation, which makes its
 * selection routing and its endpoint choice the behaviours that matter most.
 *
 * The subject is a modal BODY - it renders the contents of an already-open dialog and uses `DialogClose`
 * for its Cancel control - so every render below wraps it in an open `Dialog`, which is the context Radix
 * requires and which the production mount supplies.
 *
 * Four behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. The modal routes on the SIZE of the selection - none, exactly one, or several - and the three
 *      branches are genuinely different forms rather than one form in three states.
 *   2. The single and bulk branches post to DIFFERENT endpoints, so a bulk action is one server call
 *      rather than a loop of single ones. That is what makes it atomic.
 *   3. The selection is read from a per-bank-account atom family, so a selection made against one account
 *      is invisible to another - the key is the account name.
 *   4. It renders the "no transaction selected" branch rather than nothing when the selection is empty,
 *      because the dialog frame around it is already open by then.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, render } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'

import { TooltipProvider } from '@/components/ui/tooltip'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
	createFrappeSDKMock,
	frappeSDKMock,
	makeUnreconciledTransaction
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import RecordPaymentModalContent from './RecordPaymentModalContent'
import { bankRecSelectedTransactionsAtom, selectedBankAccountAtom } from './bankRecAtoms'
import { makePanelBank } from '@/test/renderPanel'

const SINGLE_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.create_payment_entry_and_reconcile'
const BULK_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.create_bulk_payment_entry_and_reconcile'

interface Options {
	selection?: ReturnType<typeof makeUnreconciledTransaction>[]
	bank?: ReturnType<typeof makePanelBank> | null
}

const renderModal = ({ selection = [], bank = makePanelBank() }: Options = {}) => {
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
								<RecordPaymentModalContent />
							</DialogContent>
						</Dialog>
					</MemoryRouter>
				</TooltipProvider>
			</Provider>
		)
	}
}

const deposit = (overrides: Record<string, unknown> = {}) =>
	makeUnreconciledTransaction({
		name: 'ACC-BTN-2026-00001',
		deposit: 4825.5,
		withdrawal: 0,
		unallocated_amount: 4825.5,
		...overrides
	})

/** Which endpoints the modal registered a post for on this render. */
const registeredPostEndpoints = () =>
	frappeSDKMock.useFrappePostCall.mock.calls.map(([method]) => method)

describe('RecordPaymentModalContent', () => {

	beforeEach(() => {
		frappeSDKMock.useFrappeGetCall.mockReturnValue({
			data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
		})
		frappeSDKMock.useFrappeGetDocList.mockReturnValue({
			data: [], error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
		})
	})

	describe('QUIRK - when nothing is selected', () => {

		it('says so rather than rendering an empty form', () => {
			// The dialog frame is already open by the time this renders, so returning nothing would leave
			// the reviewer looking at an empty box with no explanation.
			renderModal({ selection: [] })

			expect(screen.getByText('No transaction selected')).toBeInTheDocument()
		})

		it('says so when no bank account is chosen either', () => {
			renderModal({ bank: null, selection: [] })

			expect(screen.getByText('No transaction selected')).toBeInTheDocument()
		})

		it('registers no payment endpoint at all on that branch', () => {
			renderModal({ selection: [] })

			expect(registeredPostEndpoints()).not.toContain(SINGLE_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(BULK_ENDPOINT)
		})
	})

	describe('when exactly one transaction is selected', () => {

		it('renders the single Payment Entry form', () => {
			renderModal({ selection: [deposit()] })

			expect(screen.queryByText('No transaction selected')).not.toBeInTheDocument()
			expect(screen.getByText('Posting Date')).toBeInTheDocument()
		})

		it('QUIRK - registers the SINGLE-transaction endpoint', () => {
			renderModal({ selection: [deposit()] })

			expect(registeredPostEndpoints()).toContain(SINGLE_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(BULK_ENDPOINT)
		})

		it('offers the fields a Payment Entry needs to be postable', () => {
			renderModal({ selection: [deposit()] })

			expect(screen.getByText('Posting Date')).toBeInTheDocument()
			expect(screen.getByText('Reference Date')).toBeInTheDocument()
			expect(screen.getByText('Mode of Payment')).toBeInTheDocument()
		})

		it('offers a way out as well as a way forward', () => {
			// A financial document must always be abandonable.
			renderModal({ selection: [deposit()] })

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
		})

		it('renders a withdrawal as readily as a deposit', () => {
			// The direction decides which party type and account side the form defaults to, so both must
			// mount.
			renderModal({
				selection: [deposit({ deposit: 0, withdrawal: 1250, unallocated_amount: 1250 })]
			})

			expect(screen.getByText('Posting Date')).toBeInTheDocument()
			expect(registeredPostEndpoints()).toContain(SINGLE_ENDPOINT)
		})
	})

	describe('when several transactions are selected', () => {

		const twoDeposits = [
			deposit({ name: 'ACC-BTN-2026-00001' }),
			deposit({ name: 'ACC-BTN-2026-00002', deposit: 2100, unallocated_amount: 2100 })
		]

		it('renders the bulk form instead of the single one', () => {
			renderModal({ selection: twoDeposits })

			expect(screen.queryByText('No transaction selected')).not.toBeInTheDocument()
			expect(screen.getByText('Party Type')).toBeInTheDocument()
		})

		it('QUIRK - registers the BULK endpoint, so the whole batch is one server call', () => {
			// This is what makes a bulk action atomic: either every transaction is reconciled or none is.
			// A client-side loop over the single endpoint could half-succeed.
			renderModal({ selection: twoDeposits })

			expect(registeredPostEndpoints()).toContain(BULK_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(SINGLE_ENDPOINT)
		})

		it('asks for the party and account details once, to apply across the batch', () => {
			renderModal({ selection: twoDeposits })

			expect(screen.getByText('Party Type')).toBeInTheDocument()
			expect(screen.getByText('Account')).toBeInTheDocument()
			expect(screen.getByText('Mode of Payment')).toBeInTheDocument()
		})

		it('offers a way out as well as a way forward', () => {
			renderModal({ selection: twoDeposits })

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
		})

		it('scales past two without changing branch', () => {
			renderModal({
				selection: [
					deposit({ name: 'ACC-BTN-2026-00001' }),
					deposit({ name: 'ACC-BTN-2026-00002' }),
					deposit({ name: 'ACC-BTN-2026-00003' })
				]
			})

			expect(registeredPostEndpoints()).toContain(BULK_ENDPOINT)
		})
	})

	describe('QUIRK - the selection is scoped per bank account', () => {

		it('sees nothing when the selection was made against a DIFFERENT account', () => {
			// The selection is stamped with the account it was made under, so switching accounts must not
			// carry it across - reconciling one account's transaction from another's screen would be wrong.
			const store = createStore()
			const bank = makePanelBank()
			/*
			 * The selection is made while ANOTHER account is picked, then the account is switched. That is
			 * how a cross-scope selection actually arises, and it also pins the half that used to fail:
			 * the selection is orphaned rather than parked, so switching back cannot replay it.
			 */
			store.set(selectedBankAccountAtom, makePanelBank({ name: 'Some Other Account' }))
			store.set(bankRecSelectedTransactionsAtom, [deposit()])
			store.set(selectedBankAccountAtom, bank)

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

			expect(screen.getByText('No transaction selected')).toBeInTheDocument()
		})

		it('sees the selection made against the CURRENT account', () => {
			const store = createStore()
			store.set(selectedBankAccountAtom, makePanelBank())
			store.set(bankRecSelectedTransactionsAtom, [deposit()])

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

			expect(screen.queryByText('No transaction selected')).not.toBeInTheDocument()
		})
	})
})
