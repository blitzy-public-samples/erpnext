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
import { render, screen } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'

import { TooltipProvider } from '@/components/ui/tooltip'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { createFrappeSDKMock, frappeSDKMock, makeUnreconciledTransaction } from '@/test/factories'

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
