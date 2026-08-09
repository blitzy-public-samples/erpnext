/**
 * Behavioural specification for the "Bank Reconciliation Statement" tab of the workbench.
 *
 * This is the tab a reviewer uses to tie the ledger back to the bank: it lists the payment documents
 * that are still outstanding as at a report date, which is what explains the gap between the system
 * balance and the statement balance. Like the other report tabs it is a thin surface over the server's
 * query report, so what is worth pinning is what the component itself decides:
 *
 *   1. It refuses to fetch until a bank account and a date range exist, and says which is missing.
 *   2. It is an AS-AT report, not a range report: it sends only `report_date`, taken from the range's END,
 *      plus the company. Sending a from-date would be a different question.
 *   3. It filters on the bank account's LEDGER account rather than the Bank Account document name.
 *   4. It renders a document link only when the row carries a document type, because the report also
 *      returns total and blank rows that have none.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'

import { TEST_COMPANY, createFrappeSDKMock, frappeSDKMock, makeFrappeError } from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankReconciliationStatement from './BankReconciliationStatement'
import {
	PANEL_TO_DATE,
	makePanelBank,
	makeReportResponse,
	renderPanel,
	stubViewportMeasurement
} from '@/test/renderPanel'

const REPORT_ENDPOINT = 'frappe.desk.query_report.run'

const statementRow = (overrides: Record<string, unknown> = {}) => ({
	payment_document: 'Payment Entry',
	payment_entry: 'ACC-PAY-2026-00001',
	posting_date: '2026-08-03',
	reference_no: 'REF-INR-0001',
	credit: 4825.5,
	debit: 0,
	against_account: 'Debtors - _TC',
	ref_date: '2026-08-03',
	account_currency: 'INR',
	clearance_date: '',
	...overrides
})

const lastReportCall = () => {
	const calls = frappeSDKMock.useFrappeGetCall.mock.calls.filter(([method]) => method === REPORT_ENDPOINT)
	return calls[calls.length - 1]
}

const answerWith = (response: unknown, error: unknown = undefined) => {
	frappeSDKMock.useFrappeGetCall.mockImplementation(((method: string) =>
		method === REPORT_ENDPOINT
			? { data: response, error, isLoading: false, isValidating: false, mutate: vi.fn() }
			: { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn() }) as never)
}

describe('BankReconciliationStatement', () => {

	stubViewportMeasurement()

	beforeEach(() => {
		answerWith(makeReportResponse([]))
	})

	describe('before the reviewer has chosen what to look at', () => {

		it('asks for a bank account and renders no table', () => {
			renderPanel(<BankReconciliationStatement />, { bank: null })

			expect(
				screen.getByText('Please select a bank account to view the bank reconciliation statement.')
			).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})

	describe('once both filters are set', () => {

		it('asks the server for the Bank Reconciliation Statement report', () => {
			renderPanel(<BankReconciliationStatement />)

			expect(lastReportCall()![1]).toMatchObject({
				report_name: 'Bank Reconciliation Statement',
				ignore_prepared_report: 1,
				are_default_filters: false
			})
		})

		it('sends an AS-AT report date taken from the END of the range, with no from-date', () => {
			// The distinction matters: this report answers "what is still outstanding on this date",
			// so a from-date would silently narrow it into a different question.
			renderPanel(<BankReconciliationStatement />)

			const filters = JSON.parse((lastReportCall()![1] as { filters: string }).filters)

			expect(filters).toEqual({
				account: makePanelBank().account,
				report_date: PANEL_TO_DATE,
				company: TEST_COMPANY
			})
			expect(filters).not.toHaveProperty('from_date')
		})

		it('declares a cache key that moves with the report date', () => {
			const { unmount } = renderPanel(<BankReconciliationStatement />)
			const firstKey = lastReportCall()![2]
			unmount()

			renderPanel(<BankReconciliationStatement />, { toDate: '2026-07-31' })

			expect(firstKey).toContain('Report-Bank Reconciliation Statement-')
			expect(lastReportCall()![2]).not.toBe(firstKey)
		})
	})

	describe('when the server returns outstanding entries', () => {

		beforeEach(() => {
			answerWith(makeReportResponse([
				statementRow(),
				statementRow({
					payment_document: 'Journal Entry',
					payment_entry: 'ACC-JV-2026-00002',
					reference_no: 'REF-EU-0002',
					credit: 0,
					debit: 1250,
					against_account: 'Creditors - _TC',
					posting_date: '2026-08-08'
				})
			]))
		})

		it('lists each outstanding document', async () => {
			renderPanel(<BankReconciliationStatement />)

			expect(await screen.findByText('ACC-PAY-2026-00001')).toBeInTheDocument()
			expect(screen.getByText('ACC-JV-2026-00002')).toBeInTheDocument()
		})

		it('deep-links each document into the Desk, slugging its doctype', async () => {
			renderPanel(<BankReconciliationStatement />)

			expect(await screen.findByRole('link', { name: 'ACC-PAY-2026-00001' }))
				.toHaveAttribute('href', '/desk/payment-entry/ACC-PAY-2026-00001')
			expect(screen.getByRole('link', { name: 'ACC-JV-2026-00002' }))
				.toHaveAttribute('href', '/desk/journal-entry/ACC-JV-2026-00002')
		})

		it('renders both sides of the ledger and the accounts they sit against', async () => {
			renderPanel(<BankReconciliationStatement />)

			expect(await screen.findByText('Debtors - _TC')).toBeInTheDocument()
			expect(screen.getByText('Creditors - _TC')).toBeInTheDocument()
		})

		it('renders the references the bank would show', async () => {
			renderPanel(<BankReconciliationStatement />)

			expect(await screen.findByText('REF-INR-0001')).toBeInTheDocument()
			expect(screen.getByText('REF-EU-0002')).toBeInTheDocument()
		})
	})

	describe('QUIRK - when a row carries no document type', () => {

		it('renders the row without a link, because the report emits total rows too', async () => {
			// `frappe.desk.query_report.run` returns section and total rows alongside the data rows, and
			// those have no document to link to. Linking them would produce a dead `/desk//` href, so the
			// cell falls back to plain content and only the real document is linked.
			answerWith(makeReportResponse([
				statementRow(),
				statementRow({ payment_document: '', payment_entry: 'Total Outstanding' })
			]))

			renderPanel(<BankReconciliationStatement />)

			// Both rows render...
			expect(await screen.findByText('ACC-PAY-2026-00001')).toBeInTheDocument()
			expect(screen.getByText('Total Outstanding')).toBeInTheDocument()

			// ...but only the one carrying a document type is a link. The document-less row shows its
			// label as plain text, so no dead `/desk//` href is produced.
			expect(screen.getByRole('link', { name: 'ACC-PAY-2026-00001' }))
				.toHaveAttribute('href', '/desk/payment-entry/ACC-PAY-2026-00001')
			expect(screen.queryByRole('link', { name: 'Total Outstanding' })).not.toBeInTheDocument()
		})
	})

	/*
	 * The summary tiles are the headline figures of the whole tab: the ledger balance, what is still
	 * outstanding against it, anything cleared that should not have been, and the statement balance the
	 * three of them imply. A reviewer reads these before anything else and decides from them whether the
	 * account ties out.
	 *
	 * They are computed by RECOGNISING four rows the report appends after the data rows, and the report
	 * names those rows by their translated display text - there is no fieldname to key off. That is the
	 * whole hazard, and it is the defect these tests exist for: the client matched a hardcoded en-US
	 * "Checks" while the report is written with the en-GB "Cheques", so two of the four rows never
	 * matched and the outstanding tile reported a balanced 0.00 against a statement carrying 134,047 of
	 * outstanding items. Correct data, false headline.
	 *
	 * So every payload below carries the server's OWN spelling, copied from
	 * `bank_reconciliation_statement.py`, and one case deliberately carries the other spelling to prove
	 * the two can no longer diverge in either direction.
	 */
	describe('the summary tiles', () => {

		/**
		 * The summary tile carrying `label`.
		 *
		 * Scoped rather than searched globally on purpose: the report returns its summary rows in the same
		 * `result` array as the data rows, so every label and every figure below ALSO appears once in the
		 * grid. An unscoped assertion would pass on the grid's copy while the tile still read zero - which
		 * is precisely the defect these tests exist to catch.
		 */
		const tile = (label: string) => {
			const container = screen.getAllByText(label)
				.map((node) => node.closest('[data-slot="stat-container"]'))
				.find((node): node is HTMLElement => Boolean(node))

			if (!container) {
				throw new Error(`No summary tile is labelled "${label}"`)
			}

			return container
		}

		const hasTile = (label: string) => screen.queryAllByText(label)
			.some((node) => node.closest('[data-slot="stat-container"]'))

		const balanceRow = (label: string, debit: number, credit: number) => ({
			payment_document: '',
			payment_entry: label,
			debit,
			credit,
			account_currency: 'INR'
		})

		/** The four rows exactly as `bank_reconciliation_statement.py` appends them. */
		const serverSummaryRows = () => [
			balanceRow('Bank Statement balance as per General Ledger', 500000, 0),
			{},
			balanceRow('Outstanding Cheques and Deposits to clear', 134047, 0),
			balanceRow('Cheques and Deposits incorrectly cleared', 0, 2500),
			{},
			balanceRow('Calculated Bank Statement balance', 363453, 0)
		]

		it('reports the outstanding total the report actually returned', async () => {
			answerWith(makeReportResponse([statementRow(), ...serverSummaryRows()]))

			renderPanel(<BankReconciliationStatement />)

			// The regression in one assertion: this tile read ₹ 0.00 before the fix.
			expect(await screen.findByText('ACC-PAY-2026-00001')).toBeInTheDocument()
			expect(within(tile('Outstanding Cheques and Deposits to clear')).getByText('₹ 134,047.00'))
				.toBeInTheDocument()
		})

		it('reports the ledger balance and the calculated statement balance', async () => {
			answerWith(makeReportResponse([...serverSummaryRows()]))

			renderPanel(<BankReconciliationStatement />)

			await waitFor(() => expect(hasTile('Calculated Bank Statement balance')).toBe(true))

			expect(within(tile('Bank Statement balance as per General Ledger')).getByText('₹ 500,000.00'))
				.toBeInTheDocument()
			expect(within(tile('Calculated Bank Statement balance')).getByText('₹ 363,453.00'))
				.toBeInTheDocument()
		})

		it('shows the incorrectly-cleared tile, in the account currency, when there is one', async () => {
			answerWith(makeReportResponse([...serverSummaryRows()]))

			renderPanel(<BankReconciliationStatement />)

			// Debit 0 - credit 2500. Formatted with the account's currency rather than defaulting to the
			// browser's, which is what the other tiles already did.
			await waitFor(() => expect(hasTile('Cheques and Deposits incorrectly cleared')).toBe(true))
			expect(within(tile('Cheques and Deposits incorrectly cleared')).getByText('₹ -2,500.00'))
				.toBeInTheDocument()
		})

		it('hides the incorrectly-cleared tile when nothing was cleared in error', async () => {
			answerWith(makeReportResponse([
				balanceRow('Bank Statement balance as per General Ledger', 500000, 0),
				balanceRow('Outstanding Cheques and Deposits to clear', 134047, 0),
				balanceRow('Cheques and Deposits incorrectly cleared', 0, 0),
				balanceRow('Calculated Bank Statement balance', 365953, 0)
			]))

			renderPanel(<BankReconciliationStatement />)

			await waitFor(() => expect(hasTile('Outstanding Cheques and Deposits to clear')).toBe(true))

			expect(within(tile('Outstanding Cheques and Deposits to clear')).getByText('₹ 134,047.00'))
				.toBeInTheDocument()
			expect(hasTile('Cheques and Deposits incorrectly cleared')).toBe(false)
		})

		it('recognises the en-US spelling of the same rows too', async () => {
			// Neither spelling may be the only one understood. This is the mirror image of the original
			// defect: were the report ever to emit "Checks", the tiles must not silently read zero again.
			answerWith(makeReportResponse([
				balanceRow('Bank Statement balance as per General Ledger', 500000, 0),
				balanceRow('Outstanding Checks and Deposits to clear', 134047, 0),
				balanceRow('Checks and Deposits incorrectly cleared', 0, 2500),
				balanceRow('Calculated Bank Statement balance', 363453, 0)
			]))

			renderPanel(<BankReconciliationStatement />)

			await waitFor(() => expect(hasTile('Outstanding Cheques and Deposits to clear')).toBe(true))

			// The tiles are labelled with the report's own wording either way, so the labels below are the
			// en-GB ones even though this payload spelled its rows the other way.
			expect(within(tile('Outstanding Cheques and Deposits to clear')).getByText('₹ 134,047.00'))
				.toBeInTheDocument()
			expect(within(tile('Cheques and Deposits incorrectly cleared')).getByText('₹ -2,500.00'))
				.toBeInTheDocument()
		})

		it('labels the tiles with the report\'s own wording', async () => {
			answerWith(makeReportResponse([...serverSummaryRows()]))

			renderPanel(<BankReconciliationStatement />)

			await waitFor(() => expect(hasTile('Outstanding Cheques and Deposits to clear')).toBe(true))

			expect(hasTile('Bank Statement balance as per General Ledger')).toBe(true)
			expect(hasTile('Cheques and Deposits incorrectly cleared')).toBe(true)
			expect(hasTile('Calculated Bank Statement balance')).toBe(true)
		})

		it('reads a numeric string as a number rather than concatenating it', async () => {
			// `query_report.run` is JSON, and a Currency column can arrive as a string. `0` minus a string
			// is NaN, so an unguarded subtraction would have printed a nonsense balance.
			answerWith(makeReportResponse([
				{ payment_document: '', payment_entry: 'Bank Statement balance as per General Ledger', debit: '500000', credit: '0' },
				{ payment_document: '', payment_entry: 'Outstanding Cheques and Deposits to clear', debit: '134047', credit: '0' }
			]))

			renderPanel(<BankReconciliationStatement />)

			await waitFor(() => expect(hasTile('Outstanding Cheques and Deposits to clear')).toBe(true))

			expect(within(tile('Bank Statement balance as per General Ledger')).getByText('₹ 500,000.00'))
				.toBeInTheDocument()
			expect(within(tile('Outstanding Cheques and Deposits to clear')).getByText('₹ 134,047.00'))
				.toBeInTheDocument()
		})
	})

	describe('when nothing is outstanding', () => {

		it('says so rather than showing an empty grid', async () => {
			answerWith(makeReportResponse([]))

			renderPanel(<BankReconciliationStatement />)

			expect(await screen.findByText('No entries found')).toBeInTheDocument()
		})
	})

	describe('when the report fails', () => {

		it("surfaces the server's own message", async () => {
			answerWith(undefined, makeFrappeError({
				_server_messages: JSON.stringify([
					JSON.stringify({ message: 'Not permitted to run this report', indicator: 'red' })
				])
			}))

			renderPanel(<BankReconciliationStatement />)

			await waitFor(() => {
				expect(screen.getByText('Not permitted to run this report')).toBeInTheDocument()
			})
		})
	})
})
