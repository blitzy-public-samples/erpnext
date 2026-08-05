/**
 * Behavioural specification for the CSV/XLSX column mapper.
 *
 * A spreadsheet statement is just a grid of strings until someone says which column is the date, which is
 * the withdrawal, and which row is the header. This component is where that is said, and the server
 * re-derives the entire transaction preview from it - so a wrong mapping here produces wrong
 * transactions, not merely an ugly table.
 *
 * Five behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. Mapping edits SAVE THEMSELVES on a debounce, with no save button, so the preview stays live.
 *   2. The debounce reads the mapping from a REF at fire time, so two quick edits are sent together
 *      rather than the second overwriting the first with a stale snapshot.
 *   3. A header change is sent IMMEDIATELY, not debounced, and the server's re-derived mapping REPLACES
 *      the local one - the reviewer's column choices are deliberately discarded, because the columns
 *      themselves have just been renamed.
 *   4. A header index of -1 on the wire means "no header", because the endpoint cannot carry null.
 *   5. Once the statement is Completed every path returns early, so the grid becomes a read-only record.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import {
	createFrappeSDKMock,
	frappeSDKMock,
	makeBankStatementImportLog
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { TooltipProvider } from '@/components/ui/tooltip'
import CSVRawDataPreview from './CSVRawDataPreview'
import type { GetStatementDetailsResponse } from '../import_utils'
import type { BankStatementImportLogColumnMap } from '@/types/Accounts/BankStatementImportLogColumnMap'

const UPDATE_MAPPING =
	'erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.update_column_mapping'
const SET_HEADER =
	'erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.set_header_index'

const RAW_DATA: string[][] = [
	['Statement for August 2026', '', '', ''],
	['Date', 'Narrative', 'Debit', 'Credit'],
	['05-08-2026', 'Bank charge', '150.00', ''],
	['08-08-2026', 'Salary', '', '48000.00']
]

const makeColumn = (
	overrides: Partial<BankStatementImportLogColumnMap>
): BankStatementImportLogColumnMap =>
	({
		index: 0,
		header_text: 'Date',
		maps_to: 'Date',
		variable: '',
		...overrides
	}) as BankStatementImportLogColumnMap

const COLUMN_MAPPING: BankStatementImportLogColumnMap[] = [
	makeColumn({ index: 0, header_text: 'Date', maps_to: 'Date' }),
	makeColumn({ index: 1, header_text: 'Narrative', maps_to: 'Description' }),
	makeColumn({ index: 2, header_text: 'Debit', maps_to: 'Withdrawal' }),
	makeColumn({ index: 3, header_text: 'Credit', maps_to: 'Deposit' })
]

const makeDetails = (
	overrides: Partial<GetStatementDetailsResponse> = {},
	docOverrides: Parameters<typeof makeBankStatementImportLog>[0] = {}
): GetStatementDetailsResponse => ({
	doc: makeBankStatementImportLog({
		name: 'csv-log-1',
		status: 'Not Started',
		column_mapping: COLUMN_MAPPING,
		detected_header_index: 1,
		...docOverrides
	}),
	conflicting_transactions: [],
	final_transactions: [],
	date_format: 'dd-mm-yyyy',
	raw_data: RAW_DATA,
	...overrides
})

const renderPreview = (data: GetStatementDetailsResponse = makeDetails()) => {
	const updateMapping = vi.fn().mockResolvedValue({ message: data })
	const setHeader = vi.fn().mockResolvedValue({ message: data })
	const mutate = vi.fn()

	// One spy per endpoint, keyed on the method the hook was built with, so a mapping save and a
	// header change can be told apart.
	frappeSDKMock.useFrappePostCall.mockImplementation(((method: string) => ({
		call:
			method === UPDATE_MAPPING
				? updateMapping
				: method === SET_HEADER
					? setHeader
					: vi.fn().mockResolvedValue({}),
		result: null,
		loading: false,
		error: null,
		isCompleted: false,
		reset: vi.fn()
	})) as never)

	const user = userEvent.setup()

	render(
		<TooltipProvider>
			<CSVRawDataPreview data={data} mutate={mutate} />
		</TooltipProvider>
	)

	return { updateMapping, setHeader, mutate, user }
}

/**
 * Finds the column control currently showing `label`.
 *
 * It has to match on CONTENT rather than accessible name: `combobox` is not a name-from-content ARIA
 * role, so `getByRole('combobox', { name: 'Date' })` finds nothing even though the trigger plainly
 * reads "Date". Matching on content is what actually identifies the column here.
 */
const columnControl = (label: string): HTMLElement => {
	const control = screen
		.getAllByRole('combobox')
		.find((candidate) => candidate.textContent?.trim() === label)

	if (!control) {
		throw new Error(
			`No column control showing "${label}". Present: ${screen
				.getAllByRole('combobox')
				.map((candidate) => JSON.stringify(candidate.textContent?.trim()))
				.join(', ')}`
		)
	}

	return control
}

/** Chooses a meaning for a column through its dropdown. */
const mapColumn = async (
	user: ReturnType<typeof userEvent.setup>,
	currentLabel: string,
	newLabel: string
) => {
	await user.click(columnControl(currentLabel))
	// A Radix Select, so the choices are options rather than menu items.
	await user.click(await screen.findByRole('option', { name: newLabel }))
}

describe('CSVRawDataPreview', () => {

	describe('what it presents', () => {

		it('shows the raw sheet, including the rows above the header', () => {
			renderPreview()

			// The preamble matters: it is how a reviewer recognises which row is really the header.
			expect(screen.getByText('Statement for August 2026')).toBeInTheDocument()
			expect(screen.getByText('Bank charge')).toBeInTheDocument()
			expect(screen.getByText('48000.00')).toBeInTheDocument()
		})

		it('shows the meaning already assigned to each column', () => {
			renderPreview()

			// One control per column, each showing the meaning currently assigned to it.
			expect(screen.getAllByRole('combobox')).toHaveLength(4)
			expect(columnControl('Date')).toBeInTheDocument()
			expect(columnControl('Description')).toBeInTheDocument()
			expect(columnControl('Withdrawal')).toBeInTheDocument()
			expect(columnControl('Deposit')).toBeInTheDocument()
		})

		it('QUIRK - treats a negative detected header as no header at all', () => {
			// The endpoint cannot carry null, so it uses -1. Rendering that literally would highlight
			// a row that does not exist.
			renderPreview(makeDetails({}, { detected_header_index: -1 }))

			expect(screen.getByText('Statement for August 2026')).toBeInTheDocument()
		})

		it('copes with a statement whose columns were never mapped', () => {
			renderPreview(makeDetails({}, { column_mapping: undefined }))

			// Still renders the grid, so the reviewer can map it from scratch.
			expect(screen.getByText('Bank charge')).toBeInTheDocument()
		})
	})

	describe('changing a column mapping', () => {

		it('QUIRK - saves itself, with no save button anywhere', async () => {
			// The transaction preview is derived server-side from the mapping, so an unsaved edit would
			// leave the preview contradicting the grid.
			const { updateMapping, mutate, user } = renderPreview()

			expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()

			await mapColumn(user, 'Deposit', 'Do not import')

			await waitFor(
				() => {
					expect(updateMapping).toHaveBeenCalledTimes(1)
				},
				{ timeout: 3000 }
			)

			expect(updateMapping.mock.calls[0][0]).toMatchObject({
				statement_import_id: 'csv-log-1'
			})
			expect(updateMapping.mock.calls[0][0].column_mapping).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ index: 3, maps_to: 'Do not import' })
				])
			)
			await waitFor(() => {
				expect(mutate).toHaveBeenCalled()
			})
		})

		it('QUIRK - collapses a burst of edits into one save carrying all of them', async () => {
			// The mapping is read from a ref at fire time. Reading the closure instead would send the
			// first edit twice and lose the second.
			const { updateMapping, user } = renderPreview()

			await mapColumn(user, 'Withdrawal', 'Do not import')
			await mapColumn(user, 'Deposit', 'Reference')

			await waitFor(
				() => {
					expect(updateMapping).toHaveBeenCalledTimes(1)
				},
				{ timeout: 3000 }
			)

			const sent = updateMapping.mock.calls[0][0].column_mapping
			expect(sent).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ index: 2, maps_to: 'Do not import' }),
					expect.objectContaining({ index: 3, maps_to: 'Reference' })
				])
			)
		})

		it('reports a refused save rather than pretending it landed', async () => {
			const error = vi.spyOn(toast, 'error').mockReturnValue('t')
			const { updateMapping, user } = renderPreview()
			updateMapping.mockRejectedValue(new Error('nope'))

			await mapColumn(user, 'Deposit', 'Do not import')

			await waitFor(
				() => {
					expect(error).toHaveBeenCalledWith('Could not save the column mapping.')
				},
				{ timeout: 3000 }
			)

			error.mockRestore()
		})
	})

	describe('changing the header row', () => {

		it('QUIRK - sends the change at once, not on the save debounce', async () => {
			// The server re-derives every column's meaning from the header, so the reviewer must see
			// that result immediately rather than half a second later.
			const { setHeader, mutate } = renderPreview()

			fireEvent.click(screen.getByRole('button', { name: '3' }))

			await waitFor(() => {
				expect(setHeader).toHaveBeenCalledWith({
					statement_import_id: 'csv-log-1',
					header_index: 2
				})
			})
			await waitFor(() => {
				expect(mutate).toHaveBeenCalled()
			})
		})

		it('QUIRK - sends -1 to clear the header, because the wire cannot carry null', async () => {
			// Clicking the CURRENT header row clears it.
			const { setHeader } = renderPreview()

			fireEvent.click(screen.getByRole('button', { name: '2' }))

			await waitFor(() => {
				expect(setHeader).toHaveBeenCalledWith({
					statement_import_id: 'csv-log-1',
					header_index: -1
				})
			})
		})

		it('QUIRK - adopts the server re-derived mapping, discarding the local one', async () => {
			// This looks like data loss and is deliberate: the columns have just been renamed, so the
			// reviewer's previous choices referred to different headers.
			const { setHeader } = renderPreview()

			setHeader.mockResolvedValue({
				message: makeDetails(
					{},
					{
						detected_header_index: 2,
						column_mapping: [
							makeColumn({ index: 0, header_text: '05-08-2026', maps_to: 'Do not import' }),
							makeColumn({ index: 1, header_text: 'Bank charge', maps_to: 'Description' })
						]
					}
				)
			})

			fireEvent.click(screen.getByRole('button', { name: '3' }))

			await waitFor(() => {
				expect(columnControl('Do not import')).toBeInTheDocument()
			})

			// One control per SHEET COLUMN regardless of how many are mapped, so the count is
			// unchanged - it is the LABELS that prove the server's mapping replaced the local one.
			expect(screen.getAllByRole('combobox')).toHaveLength(4)
			expect(
				screen
					.getAllByRole('combobox')
					.some((candidate) => candidate.textContent?.trim() === 'Withdrawal')
			).toBe(false)
		})

		it('reports a refused header change', async () => {
			const error = vi.spyOn(toast, 'error').mockReturnValue('t')
			const { setHeader } = renderPreview()
			setHeader.mockRejectedValue(new Error('nope'))

			fireEvent.click(screen.getByRole('button', { name: '3' }))

			await waitFor(() => {
				expect(error).toHaveBeenCalledWith('Could not update the header row.')
			})

			error.mockRestore()
		})
	})

	describe('once the statement has been imported', () => {

		const completed = () => makeDetails({}, { status: 'Completed' })

		it('QUIRK - refuses every edit, because the transactions already exist', async () => {
			// Re-deriving the preview now could only disagree with transactions that have already been
			// created.
			const { updateMapping, setHeader } = renderPreview(completed())

			// The row numbers are no longer offered as controls at all.
			expect(screen.queryByRole('button', { name: '3' })).not.toBeInTheDocument()

			await new Promise((resolve) => setTimeout(resolve, 700))

			expect(updateMapping).not.toHaveBeenCalled()
			expect(setHeader).not.toHaveBeenCalled()
		})

		it('still shows the sheet, so the import remains auditable', () => {
			renderPreview(completed())

			expect(screen.getByText('Bank charge')).toBeInTheDocument()
			expect(screen.getByText('48000.00')).toBeInTheDocument()
		})
	})
})
