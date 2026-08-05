/**
 * Behavioural specification for the "Bank Transactions" tab of the reconciliation workbench.
 *
 * This tab is the audit view: unlike the Match and Reconcile tab it asks the endpoint for ALL transactions
 * rather than only the outstanding ones, so it is the one place a reviewer sees a settled transaction
 * alongside an open one - and the one place an already-reconciled row is rendered at all. That makes its
 * status column and its undo affordance the behaviours that matter.
 *
 * Five behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. The three status badges are derived from `allocated_amount` and `unallocated_amount` alone; the
 *      server's own `status` field is NOT consulted here.
 *   2. "Not Reconciled" is chosen when `allocated_amount` is falsy, so a zero and an absent value are one
 *      case - which is what the endpoint actually returns for an untouched row.
 *   3. Undo is offered ONLY on a row with a positive allocation, because there is nothing to reverse
 *        otherwise - so the action column's contents differ per row.
 *   4. Every "View" link opens the Desk in a new tab, so the reviewer never loses the workbench.
 *   5. The amount filter's placeholder is built from the account's own currency symbol and decimal
 *      separator, so it reflects the site's number format rather than a hard-coded "0.00".
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
	TEST_BANK_ACCOUNT,
	createFrappeSDKMock,
	frappeSDKMock,
	makeFrappeError
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankTransactions from './BankTransactionList'
import { bankRecUnreconcileModalAtom } from './bankRecAtoms'
import {
	PANEL_FROM_DATE,
	PANEL_TO_DATE,
	renderPanel,
	stubViewportMeasurement
} from '@/test/renderPanel'

const GET_TRANSACTIONS =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions'
const ALL_TRANSACTIONS_KEY =
	`bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${PANEL_FROM_DATE}-${PANEL_TO_DATE}`

/** A row exactly as `get_bank_transactions` returns one when `all_transactions` is passed. */
const transaction = (overrides: Record<string, unknown> = {}) => ({
	name: 'ACC-BTN-2026-00001',
	date: '2026-08-03',
	description: 'NEFT inbound from ACME Traders',
	reference_number: 'REF-INR-0001',
	withdrawal: 0,
	deposit: 4825.5,
	unallocated_amount: 4825.5,
	allocated_amount: 0,
	transaction_type: 'Bank Transfer',
	currency: 'INR',
	status: 'Unreconciled',
	bank_account: TEST_BANK_ACCOUNT,
	company: '_Test Company',
	party_type: 'Customer',
	party: 'ACME Traders',
	...overrides
})

const answerWith = (rows: unknown[] | undefined, error: unknown = undefined) => {
	frappeSDKMock.useFrappeGetCall.mockImplementation(((method: string) =>
		method === GET_TRANSACTIONS
			? { data: rows === undefined ? undefined : { message: rows }, error, isLoading: false, isValidating: false, mutate: vi.fn() }
			: { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn() }) as never)
}

const lastTransactionsCall = () => {
	const calls = frappeSDKMock.useFrappeGetCall.mock.calls.filter(([method]) => method === GET_TRANSACTIONS)
	return calls[calls.length - 1]
}

describe('BankTransactionList', () => {

	stubViewportMeasurement()

	beforeEach(() => {
		answerWith([])
	})

	describe('before the reviewer has chosen what to look at', () => {

		it('asks for a bank and a date range, and renders no table', () => {
			renderPanel(<BankTransactions />, { bank: null })

			expect(screen.getByText('Please select a bank and set the date range')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})

	describe('QUIRK - the request it makes', () => {

		it('asks for ALL transactions, which is what makes settled rows visible here', () => {
			// The endpoint filters `unallocated_amount > 0` server-side unless this flag is passed, so
			// without it a reconciled transaction could never appear on this tab at all.
			renderPanel(<BankTransactions />)

			expect(lastTransactionsCall()![1]).toMatchObject({
				bank_account: TEST_BANK_ACCOUNT,
				from_date: PANEL_FROM_DATE,
				to_date: PANEL_TO_DATE,
				all_transactions: true
			})
		})

		it('keys the read separately from the unreconciled list, so the two never share a cache entry', () => {
			renderPanel(<BankTransactions />)

			expect(lastTransactionsCall()![2]).toBe(ALL_TRANSACTIONS_KEY)
			expect(lastTransactionsCall()![2]).not.toContain('unreconciled')
		})
	})

	describe('the status column', () => {

		it('QUIRK - calls an unallocated row Not Reconciled, from the amounts rather than the status field', async () => {
			// `status` is deliberately not consulted: the amounts are what the badge is derived from.
			answerWith([transaction({ allocated_amount: 0, status: 'Reconciled' })])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Not Reconciled')).toBeInTheDocument()
			expect(screen.queryByText('Reconciled')).not.toBeInTheDocument()
		})

		it('treats an ABSENT allocation the same as a zero one', async () => {
			// This is the shape the endpoint really returns for an untouched row.
			answerWith([transaction({ allocated_amount: undefined })])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Not Reconciled')).toBeInTheDocument()
		})

		it('calls a fully allocated row Reconciled', async () => {
			answerWith([transaction({ allocated_amount: 4825.5, unallocated_amount: 0 })])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Reconciled')).toBeInTheDocument()
		})

		it('calls a part-allocated row Partially Reconciled', async () => {
			answerWith([transaction({ allocated_amount: 2000, unallocated_amount: 2825.5 })])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Partially Reconciled')).toBeInTheDocument()
		})

		it('distinguishes all three states in one list', async () => {
			answerWith([
				transaction({ name: 'ACC-BTN-2026-00001', allocated_amount: 0 }),
				transaction({
					name: 'ACC-BTN-2026-00002', allocated_amount: 2000, unallocated_amount: 2825.5
				}),
				transaction({ name: 'ACC-BTN-2026-00003', allocated_amount: 4825.5, unallocated_amount: 0 })
			])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Not Reconciled')).toBeInTheDocument()
			expect(screen.getByText('Partially Reconciled')).toBeInTheDocument()
			expect(screen.getByText('Reconciled')).toBeInTheDocument()
		})
	})

	describe('the actions column', () => {

		it('links every row into the Desk, in a new tab', async () => {
			answerWith([transaction()])

			renderPanel(<BankTransactions />)

			const view = await screen.findByRole('link', { name: /View/ })

			expect(view).toHaveAttribute('href', '/desk/bank-transaction/ACC-BTN-2026-00001')
			expect(view).toHaveAttribute('target', '_blank')
			expect(view).toHaveAttribute('rel', 'noreferrer')
		})

		it('QUIRK - offers Undo only where there is an allocation to reverse', async () => {
			answerWith([
				transaction({ name: 'ACC-BTN-2026-00001', allocated_amount: 0 }),
				transaction({ name: 'ACC-BTN-2026-00002', allocated_amount: 4825.5, unallocated_amount: 0 })
			])

			renderPanel(<BankTransactions />)

			await screen.findByText('Not Reconciled')

			// Two rows, but only the settled one can be undone.
			expect(screen.getAllByRole('button', { name: /Undo/ })).toHaveLength(1)
		})

		it('opens the unreconcile confirmation for the row it was pressed on, rather than acting at once', async () => {
			// Reversing a posting is destructive, so the action only ARMS the modal - the atom is what the
			// page-level modal reads to decide which transaction it is about.
			const user = userEvent.setup()

			answerWith([transaction({ allocated_amount: 4825.5, unallocated_amount: 0 })])

			const { store } = renderPanel(<BankTransactions />)

			await user.click(await screen.findByRole('button', { name: /Undo/ }))

			await waitFor(() => {
				expect(store.get(bankRecUnreconcileModalAtom)).toBe('ACC-BTN-2026-00001')
			})
		})
	})

	describe('the rows themselves', () => {

		it('renders the description, reference and amounts the reviewer matches on', async () => {
			answerWith([transaction()])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('NEFT inbound from ACME Traders')).toBeInTheDocument()
			expect(screen.getByText('REF-INR-0001')).toBeInTheDocument()
			// The figure appears twice - once as the deposit and once as the amount still unallocated -
			// which is exactly what an untouched row looks like.
			expect(screen.getAllByText('₹ 4,825.50')).toHaveLength(2)
		})

		it('badges the transaction type, and omits the badge when there is none', async () => {
			answerWith([
				transaction({ name: 'ACC-BTN-2026-00001', transaction_type: 'Bank Transfer' }),
				transaction({ name: 'ACC-BTN-2026-00002', transaction_type: undefined })
			])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Bank Transfer')).toBeInTheDocument()
		})

		it('renders a withdrawal as readily as a deposit', async () => {
			answerWith([transaction({ withdrawal: 1250, deposit: 0, unallocated_amount: 1250 })])

			renderPanel(<BankTransactions />)

			// Withdrawal and unallocated both carry it; the deposit column renders the zero.
			expect(await screen.findAllByText('₹ 1,250.00')).toHaveLength(2)
			expect(screen.getByText('₹ 0.00')).toBeInTheDocument()
		})
	})

	describe('its filters', () => {

		it('offers a search box and an amount box', async () => {
			answerWith([transaction()])

			renderPanel(<BankTransactions />)

			expect(await screen.findByPlaceholderText('Search')).toBeInTheDocument()
		})

		it("QUIRK - builds the amount placeholder from the account's own currency and separator", async () => {
			// The site's number format decides the separator, so the hint matches what the reviewer will
			// actually type rather than assuming a full stop.
			answerWith([transaction()])

			renderPanel(<BankTransactions />)

			expect(await screen.findByPlaceholderText('₹0.00')).toBeInTheDocument()
		})

		it('narrows the list to the searched text', async () => {
			const user = userEvent.setup()

			answerWith([
				transaction({ name: 'ACC-BTN-2026-00001', description: 'NEFT inbound from ACME Traders' }),
				transaction({ name: 'ACC-BTN-2026-00002', description: 'RTGS outbound to Globex Supplies' })
			])

			renderPanel(<BankTransactions />)

			await screen.findByText('NEFT inbound from ACME Traders')

			await user.type(await screen.findByPlaceholderText('Search'), 'Globex')

			await waitFor(() => {
				expect(screen.getByText('RTGS outbound to Globex Supplies')).toBeInTheDocument()
			}, { timeout: 3000 })
		})
	})

	describe('when the account has no transactions in the range', () => {

		it('says so rather than showing an empty grid', async () => {
			answerWith([])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('No bank transactions found')).toBeInTheDocument()
		})
	})

	describe('when the read fails', () => {

		it("surfaces the server's own message", async () => {
			answerWith(undefined, makeFrappeError({
				_server_messages: JSON.stringify([
					JSON.stringify({ message: 'Insufficient Permission for Bank Transaction', indicator: 'red' })
				])
			}))

			renderPanel(<BankTransactions />)

			await waitFor(() => {
				expect(screen.getByText('Insufficient Permission for Bank Transaction')).toBeInTheDocument()
			})
		})
	})
})
