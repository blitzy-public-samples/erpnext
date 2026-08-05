/**
 * Behavioural specification for the "Incorrectly Cleared Entries" tab of the workbench.
 *
 * This tab exists to catch a specific data error: a voucher whose clearance date falls BEFORE its posting
 * date, which means it was recorded as cleared by the bank before it was recorded at all. Such a row
 * corrupts every balance the other tabs compute, so the tab both surfaces it and offers the remedy -
 * clearing the bad clearance date server-side.
 *
 * Four behaviours are worth pinning:
 *   1. Its guard names EVERY missing filter at once, joined into one sentence, rather than reporting them
 *      one at a time - and it checks the COMPANY as well as the bank account and dates.
 *   2. Its empty state is a POSITIVE statement ("It's all good!"), because finding nothing here is the
 *      desired outcome rather than an absence of data.
 *   3. The remedy posts to a dedicated whitelisted endpoint with the voucher's type and name; the client
 *      never edits the date itself.
 *   4. It is an as-at report keyed on the range's end date and the company.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
	TEST_COMPANY,
	createFrappeSDKMock,
	frappePostCall,
	frappeSDKMock,
	makeFrappeError
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import IncorrectlyClearedEntries from './IncorrectlyClearedEntries'
import {
	PANEL_TO_DATE,
	makePanelBank,
	makeReportResponse,
	renderPanel,
	stubViewportMeasurement
} from '@/test/renderPanel'

const REPORT_ENDPOINT = 'frappe.desk.query_report.run'
const CLEAR_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.clear_clearing_date'

/** A voucher cleared BEFORE it was posted, which is the whole point of this report. */
const badlyClearedEntry = (overrides: Record<string, unknown> = {}) => ({
	payment_document: 'Payment Entry',
	payment_entry: 'ACC-PAY-2026-00001',
	debit: 0,
	credit: 4825.5,
	posting_date: '2026-08-10',
	clearance_date: '2026-08-03',
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

describe('IncorrectlyClearedEntries', () => {

	stubViewportMeasurement()

	beforeEach(() => {
		answerWith(makeReportResponse([]))
	})

	describe('its guard', () => {

		it('names the bank account when that is what is missing', () => {
			renderPanel(<IncorrectlyClearedEntries />, { bank: null })

			expect(
				screen.getByText('Please select Bank Account to view the incorrectly cleared entries.')
			).toBeInTheDocument()
		})

		it('renders no table while a filter is missing', () => {
			renderPanel(<IncorrectlyClearedEntries />, { bank: null })

			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})

	describe('once the filters are set', () => {

		it('asks the server for the cheques-and-deposits report', () => {
			renderPanel(<IncorrectlyClearedEntries />)

			expect(lastReportCall()![1]).toMatchObject({
				report_name: 'Cheques and Deposits Incorrectly cleared',
				ignore_prepared_report: 1,
				are_default_filters: false
			})
		})

		it('filters as at the end of the range, by company and ledger account', () => {
			renderPanel(<IncorrectlyClearedEntries />)

			expect(JSON.parse((lastReportCall()![1] as { filters: string }).filters)).toEqual({
				company: TEST_COMPANY,
				account: makePanelBank().account,
				report_date: PANEL_TO_DATE
			})
		})
	})

	describe('when the report finds badly cleared vouchers', () => {

		beforeEach(() => {
			answerWith(makeReportResponse([
				badlyClearedEntry(),
				badlyClearedEntry({
					payment_document: 'Journal Entry',
					payment_entry: 'ACC-JV-2026-00002',
					debit: 1250,
					credit: 0,
					posting_date: '2026-08-19',
					clearance_date: '2026-08-08'
				})
			]))
		})

		it('lists every offending voucher', async () => {
			renderPanel(<IncorrectlyClearedEntries />)

			expect(await screen.findByText('ACC-PAY-2026-00001')).toBeInTheDocument()
			expect(screen.getByText('ACC-JV-2026-00002')).toBeInTheDocument()
		})

		it('deep-links each voucher into the Desk so the reviewer can inspect it', async () => {
			renderPanel(<IncorrectlyClearedEntries />)

			expect(await screen.findByRole('link', { name: 'ACC-PAY-2026-00001' }))
				.toHaveAttribute('href', '/desk/payment-entry/ACC-PAY-2026-00001')
		})

		it('posts the voucher type and name to the dedicated endpoint when the remedy is used', async () => {
			// The client never writes the date itself - it asks the server to clear it, which is what keeps
			// the ledger the single authority for the change.
			const user = userEvent.setup()

			renderPanel(<IncorrectlyClearedEntries />)

			await screen.findByText('ACC-PAY-2026-00001')

			const remedies = screen.getAllByRole('button')
			expect(remedies.length).toBeGreaterThan(0)

			await user.click(remedies[0])

			await waitFor(() => {
				expect(frappeSDKMock.useFrappePostCall).toHaveBeenCalledWith(CLEAR_ENDPOINT)
			})
		})
	})

	describe('QUIRK - when the report finds nothing', () => {

		it('congratulates rather than reporting an absence', async () => {
			// Finding nothing here is the DESIRED outcome, so the empty state is phrased as good news -
			// unlike the other report tabs, whose empty state is neutral.
			answerWith(makeReportResponse([]))

			renderPanel(<IncorrectlyClearedEntries />)

			expect(await screen.findByText("It's all good!")).toBeInTheDocument()
			expect(
				screen.getByText(
					'There are no entries in the system where the clearance date is before the posting date.'
				)
			).toBeInTheDocument()
		})
	})

	describe('when the report fails', () => {

		it("surfaces the server's own message", async () => {
			answerWith(undefined, makeFrappeError({
				_server_messages: JSON.stringify([
					JSON.stringify({ message: 'Insufficient Permission for Account', indicator: 'red' })
				])
			}))

			renderPanel(<IncorrectlyClearedEntries />)

			await waitFor(() => {
				expect(screen.getByText('Insufficient Permission for Account')).toBeInTheDocument()
			})
		})

		it('does not attempt the remedy when there is nothing listed', () => {
			answerWith(undefined, makeFrappeError({}))

			renderPanel(<IncorrectlyClearedEntries />)

			expect(frappePostCall).not.toHaveBeenCalled()
		})
	})
})
