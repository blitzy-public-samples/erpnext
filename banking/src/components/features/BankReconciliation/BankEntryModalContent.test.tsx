/**
 * Behavioural specification for the "Record Bank Entry" modal.
 *
 * This is the surface a reviewer uses when a bank transaction is neither a dealing with a party nor an
 * internal transfer - a bank charge, an interest credit, a correction. It creates a Journal Entry against
 * chosen ledger accounts and reconciles the transaction against it in one server call, which makes it the
 * most general of the three "create a voucher" surfaces.
 *
 * The subject is a modal BODY: it renders inside an already-open dialog and uses `DialogClose` for its
 * cancel control, so every render below supplies an open `Dialog` - the context Radix requires and the
 * production mount provides.
 *
 * Three behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. It routes on the SIZE of the selection into three genuinely different forms, and the single and bulk
 *      branches post to DIFFERENT endpoints so a batch is atomic rather than a client-side loop.
 *   2. Unlike the other two modals it offers an ATTACHMENTS affordance, because a bank charge is the case
 *      where a reviewer most often has a document to keep with the entry.
 *   3. The selection is read from a per-bank-account atom family, so a selection made against another
 *      account is invisible here.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'

import { TooltipProvider } from '@/components/ui/tooltip'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { createFrappeSDKMock, frappeSDKMock, makeUnreconciledTransaction } from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import RecordBankEntryModalContent from './BankEntryModalContent'
import { bankRecSelectedTransactionAtom, selectedBankAccountAtom } from './bankRecAtoms'
import { makePanelBank } from '@/test/renderPanel'

const SINGLE_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.create_bank_entry_and_reconcile'
const BULK_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.create_bulk_bank_entry_and_reconcile'

const charge = (overrides: Record<string, unknown> = {}) =>
	makeUnreconciledTransaction({
		name: 'ACC-BTN-2026-00001',
		withdrawal: 340.25,
		deposit: 0,
		unallocated_amount: 340.25,
		description: 'Quarterly account maintenance charge',
		...overrides
	})

const renderModal = (selection: ReturnType<typeof charge>[] = [], bank = makePanelBank()) => {
	const store = createStore()
	store.set(selectedBankAccountAtom, bank)
	store.set(bankRecSelectedTransactionAtom(bank?.name ?? ''), selection)

	return {
		store,
		...render(
			<Provider store={store}>
				<TooltipProvider>
					<MemoryRouter>
						<Dialog open>
							<DialogContent>
								<RecordBankEntryModalContent />
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

describe('BankEntryModalContent', () => {

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

		it('registers no bank-entry endpoint on that branch', () => {
			renderModal([])

			expect(registeredPostEndpoints()).not.toContain(SINGLE_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(BULK_ENDPOINT)
		})
	})

	describe('when exactly one transaction is selected', () => {

		it('renders the single Journal Entry form', () => {
			renderModal([charge()])

			expect(screen.queryByText('No transaction selected')).not.toBeInTheDocument()
			expect(screen.getByText('Posting Date')).toBeInTheDocument()
		})

		it('QUIRK - registers the SINGLE-transaction endpoint', () => {
			renderModal([charge()])

			expect(registeredPostEndpoints()).toContain(SINGLE_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(BULK_ENDPOINT)
		})

		it('offers the fields a Journal Entry is traced by', () => {
			renderModal([charge()])

			expect(screen.getByText('Reference Date')).toBeInTheDocument()
			expect(screen.getByText('Reference')).toBeInTheDocument()
			// "Remarks" appears both as the field label and inside the custom-remarks toggle, so the
			// assertion is on presence rather than uniqueness.
			expect(screen.getAllByText('Remarks').length).toBeGreaterThan(0)
		})

		it('QUIRK - offers attachments, which the other two voucher modals do not', () => {
			// A bank charge or correction is the case where the reviewer most often has paperwork to keep
			// alongside the entry.
			renderModal([charge()])

			expect(screen.getByText('Attachments')).toBeInTheDocument()
		})

		it('offers a way out as well as a way forward', () => {
			renderModal([charge()])

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
		})

		it('renders a credit as readily as a charge', () => {
			// An interest credit takes the opposite ledger side, so both directions must mount.
			renderModal([charge({ withdrawal: 0, deposit: 125.75, unallocated_amount: 125.75 })])

			expect(screen.getByText('Posting Date')).toBeInTheDocument()
			expect(registeredPostEndpoints()).toContain(SINGLE_ENDPOINT)
		})
	})

	describe('when several transactions are selected', () => {

		const twoCharges = [
			charge({ name: 'ACC-BTN-2026-00001' }),
			charge({ name: 'ACC-BTN-2026-00002', withdrawal: 55, unallocated_amount: 55 })
		]

		it('renders the bulk form instead of the single one', () => {
			renderModal(twoCharges)

			expect(screen.queryByText('No transaction selected')).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
		})

		it('QUIRK - registers the BULK endpoint, so the batch posts atomically', () => {
			renderModal(twoCharges)

			expect(registeredPostEndpoints()).toContain(BULK_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(SINGLE_ENDPOINT)
		})

		it('offers a way out as well as a way forward', () => {
			renderModal(twoCharges)

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
		})

		it('scales past two without changing branch', () => {
			renderModal([
				charge({ name: 'ACC-BTN-2026-00001' }),
				charge({ name: 'ACC-BTN-2026-00002' }),
				charge({ name: 'ACC-BTN-2026-00003' })
			])

			expect(registeredPostEndpoints()).toContain(BULK_ENDPOINT)
		})
	})

	describe('QUIRK - the selection is scoped per bank account', () => {

		it('sees nothing when the selection was made against a DIFFERENT account', () => {
			const store = createStore()
			store.set(selectedBankAccountAtom, makePanelBank())
			store.set(bankRecSelectedTransactionAtom('Some Other Account'), [charge()])

			render(
				<Provider store={store}>
					<TooltipProvider>
						<MemoryRouter>
							<Dialog open>
								<DialogContent>
									<RecordBankEntryModalContent />
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
