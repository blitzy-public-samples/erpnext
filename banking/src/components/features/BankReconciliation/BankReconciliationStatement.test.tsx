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
import { screen, waitFor } from '@testing-library/react'

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
