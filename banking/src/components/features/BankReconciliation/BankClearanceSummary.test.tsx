/**
 * Behavioural specification for the "Bank Clearance Summary" tab of the reconciliation workbench.
 *
 * The tab answers one question for a reviewer closing a period: which payment documents have been
 * cleared against this bank account in this date range, and on what date. It is a thin surface over the
 * server's own query report - the component contributes the filters, the column set and the empty state,
 * and nothing else - so the behaviours worth pinning are the ones the component decides:
 *
 *   1. It refuses to fetch anything until BOTH a bank account and a date range are chosen, and says which
 *      is missing rather than rendering an empty table.
 *   2. It filters on the bank account's LEDGER ACCOUNT (`account`) rather than on the Bank Account
 *      document name, because that is what the report takes.
 *   3. It declares a cache key derived from those filters, so changing either refetches rather than
 *      showing a stale period.
 *   4. It asks the server to ignore any prepared report, so a reviewer always sees current data.
 *   5. It deep-links each payment document into the Desk by slugging its doctype.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { createFrappeSDKMock, frappeSDKMock, makeFrappeError } from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankClearanceSummary from './BankClearanceSummary'
import {
	PANEL_FROM_DATE,
	PANEL_TO_DATE,
	makePanelBank,
	makeReportResponse,
	renderPanel,
	stubViewportMeasurement
} from '@/test/renderPanel'

const REPORT_ENDPOINT = 'frappe.desk.query_report.run'

const clearedEntry = (overrides: Record<string, unknown> = {}) => ({
	payment_document_type: 'Payment Entry',
	payment_entry: 'ACC-PAY-2026-00001',
	posting_date: '2026-08-03',
	cheque_no: 'CHQ-000123',
	amount: 4825.5,
	against: 'ACME Traders',
	clearance_date: '2026-08-05',
	...overrides
})

/** The last argument set the subject passed to the report endpoint. */
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

describe('BankClearanceSummary', () => {

	stubViewportMeasurement()

	beforeEach(() => {
		answerWith(makeReportResponse([]))
	})

	describe('before the reviewer has chosen what to look at', () => {

		it('asks for a bank account, and names that as what is missing', () => {
			renderPanel(<BankClearanceSummary />, { bank: null })

			expect(
				screen.getByText('Please select a bank account to view the bank clearance summary.')
			).toBeInTheDocument()
		})

		it('renders no table at all while a filter is missing', () => {
			// The point of the guard: an empty table would read as "nothing was cleared", which is a
			// different and wrong answer.
			renderPanel(<BankClearanceSummary />, { bank: null })

			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})

	describe('once both filters are set', () => {

		it('asks the server for the Bank Clearance Summary report', () => {
			renderPanel(<BankClearanceSummary />)

			const [, params] = lastReportCall()!

			expect(params).toMatchObject({
				report_name: 'Bank Clearance Summary',
				ignore_prepared_report: 1,
				are_default_filters: false
			})
		})

		it("filters on the bank account's LEDGER account and the chosen dates", () => {
			// The report takes an Account, not a Bank Account, so passing the Bank Account name here would
			// silently return nothing.
			const bank = makePanelBank()

			renderPanel(<BankClearanceSummary />, { bank })

			const [, params] = lastReportCall()!

			expect(JSON.parse((params as { filters: string }).filters)).toEqual({
				account: bank.account,
				from_date: PANEL_FROM_DATE,
				to_date: PANEL_TO_DATE
			})
		})

		it('declares a cache key that moves with the filters', () => {
			const { unmount } = renderPanel(<BankClearanceSummary />)
			const [, , firstKey] = lastReportCall()!
			unmount()

			renderPanel(<BankClearanceSummary />, { fromDate: '2026-07-01', toDate: '2026-07-31' })
			const [, , secondKey] = lastReportCall()!

			expect(firstKey).toContain('Report-Bank Clearance Summary-')
			expect(secondKey).not.toBe(firstKey)
		})

		it('asks the server to ignore a prepared report, so the figures are current', () => {
			// A prepared report is a cached snapshot; a reviewer reconciling needs today's answer.
			renderPanel(<BankClearanceSummary />)

			const [, params] = lastReportCall()!

			expect((params as { ignore_prepared_report: number }).ignore_prepared_report).toBe(1)
		})
	})

	describe('when the server returns cleared entries', () => {

		beforeEach(() => {
			answerWith(makeReportResponse([
				clearedEntry(),
				clearedEntry({
					payment_document_type: 'Journal Entry',
					payment_entry: 'ACC-JV-2026-00002',
					cheque_no: undefined,
					amount: 1250,
					against: 'Globex Supplies',
					posting_date: '2026-08-08',
					clearance_date: '2026-08-09'
				})
			]))
		})

		it('lists each entry the report returned', async () => {
			renderPanel(<BankClearanceSummary />)

			expect(await screen.findByText('ACC-PAY-2026-00001')).toBeInTheDocument()
			expect(screen.getByText('ACC-JV-2026-00002')).toBeInTheDocument()
		})

		it('deep-links each payment document into the Desk, slugging its doctype', async () => {
			renderPanel(<BankClearanceSummary />)

			expect(await screen.findByRole('link', { name: 'ACC-PAY-2026-00001' }))
				.toHaveAttribute('href', '/desk/payment-entry/ACC-PAY-2026-00001')
			expect(screen.getByRole('link', { name: 'ACC-JV-2026-00002' }))
				.toHaveAttribute('href', '/desk/journal-entry/ACC-JV-2026-00002')
		})

		it('opens each link in a new tab, so the reviewer does not lose the workbench', async () => {
			renderPanel(<BankClearanceSummary />)

			const link = await screen.findByRole('link', { name: 'ACC-PAY-2026-00001' })

			expect(link).toHaveAttribute('target', '_blank')
			expect(link).toHaveAttribute('rel', 'noreferrer')
		})

		it('renders the parties the entries were cleared against', async () => {
			renderPanel(<BankClearanceSummary />)

			expect(await screen.findByText('ACME Traders')).toBeInTheDocument()
			expect(screen.getByText('Globex Supplies')).toBeInTheDocument()
		})

		it('renders a row whose cheque number is absent without breaking', async () => {
			// `cheque_no` is optional on the report row, and a bank transfer has none.
			renderPanel(<BankClearanceSummary />)

			expect(await screen.findByText('ACC-JV-2026-00002')).toBeInTheDocument()
			expect(screen.getByText('CHQ-000123')).toBeInTheDocument()
		})
	})

	describe('when the account has nothing cleared in the range', () => {

		it('says so explicitly rather than showing an empty grid', async () => {
			answerWith(makeReportResponse([]))

			renderPanel(<BankClearanceSummary />)

			expect(await screen.findByText('No entries found')).toBeInTheDocument()
			expect(
				screen.getByText(
					'There are no accounting entries in the system for the selected account and dates.'
				)
			).toBeInTheDocument()
		})
	})

	describe('when the report itself fails', () => {

		it("surfaces the server's own message", async () => {
			const refusal = makeFrappeError({
				_server_messages: JSON.stringify([
					JSON.stringify({ message: 'Report Bank Clearance Summary not found', indicator: 'red' })
				])
			})

			answerWith(undefined, refusal)

			renderPanel(<BankClearanceSummary />)

			await waitFor(() => {
				expect(screen.getByText('Report Bank Clearance Summary not found')).toBeInTheDocument()
			})
		})
	})
})
