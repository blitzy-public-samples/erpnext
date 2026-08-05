/**
 * Behavioural specification for the PDF table editor.
 *
 * A PDF statement has no columns - it has ink. The server guesses where the tables are and what each
 * column means, and this editor is where a reviewer corrects those guesses before any transaction is
 * created. Every correction is persisted to the server, which re-derives the transaction preview, so
 * the editor is really a thin, carefully debounced front end over three whitelisted endpoints.
 *
 * Seven behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. Edits SAVE THEMSELVES, on a debounce, with no save button - so the preview stays live.
 *   2. A region change triggers a RE-EXTRACT rather than a plain save, because moving the box changes
 *      which ink is read, not merely where the box is.
 *   3. The debounce reads the target table from a REF at fire time, not from the closure, so a rapid
 *      second edit cannot send the first edit's stale figures.
 *   4. Setting a header row is sent IMMEDIATELY rather than debounced, because the server re-derives
 *      the whole column mapping from it and the reviewer needs to see that at once.
 *   5. Once the statement is Completed, every edit path is disabled - the transactions already exist,
 *      so re-reading the page would be meaningless.
 *   6. The editor tracks each table by its position in the FLAT list across all pages, so paging never
 *      misdirects an edit to the wrong table.
 *   7. A page with no extracted tables and a PDF with no tables at all are different states, and both
 *      say so rather than rendering an empty frame.
 *
 * All three endpoints arrive through the same `useFrappePostCall` seam, so the harness gives each its
 * own spy keyed on the method name - otherwise no assertion could tell a save from a re-extract.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
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
import PDFTableEditor from './PDFTableEditor'
import type { GetStatementDetailsResponse, PDFTable } from '../import_utils'

/* ─── Endpoint seams ─────────────────────────────────────────────────────────────────── */

const UPDATE_TABLES =
	'erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.update_pdf_tables'
const REEXTRACT =
	'erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.reextract_pdf_table'
const SET_HEADER =
	'erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.set_pdf_table_header'

/* ─── Fixtures, shaped to `PDFTable` ─────────────────────────────────────────────────── */

const makePDFTable = (overrides: Partial<PDFTable> = {}): PDFTable => ({
	page: 1,
	table_index: 0,
	bbox: [50, 100, 550, 400],
	page_width: 600,
	page_height: 800,
	page_image: 'data:image/png;base64,iVBORw0KGgo=',
	render_scale: 2,
	rows: [
		['Date', 'Details', 'Withdrawal', 'Deposit'],
		['05-09-2026', 'Bank charge', '150.00', ''],
		['08-09-2026', 'Salary', '', '48000.00']
	],
	header_index: 0,
	column_mapping: [
		{ index: 0, header_text: 'Date', maps_to: 'Date' },
		{ index: 1, header_text: 'Details', maps_to: 'Description' },
		{ index: 2, header_text: 'Withdrawal', maps_to: 'Withdrawal' },
		{ index: 3, header_text: 'Deposit', maps_to: 'Deposit' }
	],
	included: true,
	...overrides
})

const SECOND_TABLE_SAME_PAGE = makePDFTable({
	table_index: 1,
	bbox: [50, 450, 550, 700],
	rows: [['Advertisement'], ['Open a savings account today']],
	header_index: null,
	column_mapping: [{ index: 0, header_text: 'Advertisement', maps_to: 'Do not import' }],
	included: false
})

const SECOND_PAGE_TABLE = makePDFTable({
	page: 2,
	table_index: 0,
	rows: [
		['Date', 'Details', 'Withdrawal', 'Deposit'],
		['12-09-2026', 'Transfer out', '900.00', '']
	]
})

const makeDetails = (
	overrides: Partial<GetStatementDetailsResponse> = {}
): GetStatementDetailsResponse => ({
	doc: makeBankStatementImportLog({ name: 'pdf-log-1', status: 'Not Started' }),
	conflicting_transactions: [],
	final_transactions: [],
	date_format: 'dd-mm-yyyy',
	raw_data: [],
	pdf_tables: [makePDFTable()],
	...overrides
})

/* ─── Harness ────────────────────────────────────────────────────────────────────────── */

interface EditorSeams {
	updateTables: ReturnType<typeof vi.fn>
	reextract: ReturnType<typeof vi.fn>
	setHeader: ReturnType<typeof vi.fn>
	mutate: ReturnType<typeof vi.fn>
}

const renderEditor = (
	data: GetStatementDetailsResponse = makeDetails()
): EditorSeams & { user: ReturnType<typeof userEvent.setup> } => {
	const updateTables = vi.fn().mockResolvedValue({ message: data })
	const reextract = vi.fn().mockResolvedValue({ message: data })
	const setHeader = vi.fn().mockResolvedValue({ message: data })
	const mutate = vi.fn()

	// One spy per endpoint, keyed on the method the hook was constructed with. Sharing a single
	// spy would make "saved" and "re-extracted" indistinguishable.
	frappeSDKMock.useFrappePostCall.mockImplementation(((method: string) => ({
		call:
			method === UPDATE_TABLES
				? updateTables
				: method === REEXTRACT
					? reextract
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
			<PDFTableEditor data={data} mutate={mutate} />
		</TooltipProvider>
	)

	return { updateTables, reextract, setHeader, mutate, user }
}

/** jsdom performs no layout, so the overlay's points-per-pixel conversion needs a real rect. */
const stubPageRect = () => {
	const page = document.querySelector('.relative.w-full') as HTMLElement | null
	if (page) {
		page.getBoundingClientRect = () =>
			({
				x: 0,
				y: 0,
				top: 0,
				left: 0,
				right: 600,
				bottom: 800,
				width: 600,
				height: 800,
				toJSON: () => ({})
			}) as DOMRect
	}
}

describe('PDFTableEditor', () => {

	beforeEach(() => {
		HTMLElement.prototype.setPointerCapture = vi.fn()
		HTMLElement.prototype.releasePointerCapture = vi.fn()
	})

	describe('what it presents', () => {

		it('explains what the reviewer is being asked to check', () => {
			renderEditor()

			expect(screen.getByText('Detected Tables')).toBeInTheDocument()
			// The instruction is load-bearing: nothing else tells a reviewer that clicking a row
			// number is how a header is set.
			expect(
				screen.getByText(/click a row number to set\/clear the header row/)
			).toBeInTheDocument()
		})

		it('QUIRK - says so plainly when the PDF yielded no tables at all', () => {
			// An empty frame would read as "still loading" and leave the reviewer waiting.
			renderEditor(makeDetails({ pdf_tables: [] }))

			expect(
				screen.getByText('No tables were extracted from this PDF.')
			).toBeInTheDocument()
			expect(screen.queryByText('Detected Tables')).not.toBeInTheDocument()
		})

		it('QUIRK - distinguishes a page with no rendered image from a PDF with no tables', () => {
			// A table can be extracted from a page the server could not rasterise, and the reviewer
			// then needs the table view rather than a dead end.
			renderEditor(makeDetails({ pdf_tables: [makePDFTable({ page_image: null })] }))

			expect(
				screen.getByText('No page image is available for this page.')
			).toBeInTheDocument()
			expect(screen.getByText('Detected Tables')).toBeInTheDocument()
		})

		it('starts on the page view, showing the rendered page and its regions', () => {
			renderEditor(makeDetails({ pdf_tables: [makePDFTable(), SECOND_TABLE_SAME_PAGE] }))

			expect(screen.getByAltText('Page preview')).toBeInTheDocument()
			// One overlay label and one legend row per table.
			expect(screen.getAllByText('Table 1').length).toBeGreaterThanOrEqual(2)
			expect(screen.getAllByText('Table 2').length).toBeGreaterThanOrEqual(2)
		})

		it('tells the reviewer the regions are draggable', () => {
			renderEditor()

			expect(
				screen.getByText(/Drag a box to move it, or drag a corner to resize/)
			).toBeInTheDocument()
		})
	})

	describe('paging between pages', () => {

		it('reports the current page and the total', () => {
			renderEditor(makeDetails({ pdf_tables: [makePDFTable(), SECOND_PAGE_TABLE] }))

			expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
		})

		it('cannot page back from the first page', () => {
			renderEditor(makeDetails({ pdf_tables: [makePDFTable(), SECOND_PAGE_TABLE] }))

			const [back] = screen.getAllByRole('button', { name: '' })
			expect(back).toBeDisabled()
		})

		it('moves to the next page and back again', async () => {
			const { user } = renderEditor(
				makeDetails({ pdf_tables: [makePDFTable(), SECOND_PAGE_TABLE] })
			)

			const iconButtons = screen.getAllByRole('button', { name: '' })
			const forward = iconButtons[1]

			await user.click(forward)

			expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument()

			await user.click(screen.getAllByRole('button', { name: '' })[0])

			expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument()
		})

		it('cannot page forward past the last page', async () => {
			const { user } = renderEditor(
				makeDetails({ pdf_tables: [makePDFTable(), SECOND_PAGE_TABLE] })
			)

			await user.click(screen.getAllByRole('button', { name: '' })[1])
			await screen.findByText('Page 2 of 2')

			expect(screen.getAllByRole('button', { name: '' })[1]).toBeDisabled()
		})
	})

	describe('excluding a region', () => {

		it('QUIRK - saves itself, with no save button anywhere', async () => {
			// The transaction preview is derived server-side from these settings, so an unsaved edit
			// would show a preview that contradicts the screen.
			const { updateTables, mutate } = renderEditor()

			expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()

			fireEvent.click(screen.getByRole('switch'))

			await waitFor(
				() => {
					expect(updateTables).toHaveBeenCalledTimes(1)
				},
				{ timeout: 3000 }
			)

			expect(updateTables).toHaveBeenCalledWith({
				statement_import_id: 'pdf-log-1',
				tables: [expect.objectContaining({ included: false })]
			})
			// The caller re-reads the statement, which is how the preview refreshes.
			await waitFor(() => {
				expect(mutate).toHaveBeenCalled()
			})
		})

		it('QUIRK - collapses a burst of edits into one save', async () => {
			// Each toggle would otherwise be a round trip, and a reviewer sweeping through six
			// regions would queue six extractions of the same page.
			const { updateTables } = renderEditor(
				makeDetails({ pdf_tables: [makePDFTable(), SECOND_TABLE_SAME_PAGE] })
			)

			const toggles = screen.getAllByRole('switch')
			fireEvent.click(toggles[0])
			fireEvent.click(toggles[1])

			await waitFor(
				() => {
					expect(updateTables).toHaveBeenCalledTimes(1)
				},
				{ timeout: 3000 }
			)

			// QUIRK 3: the ref is read at fire time, so the ONE save carries BOTH edits rather than
			// the first edit's stale snapshot.
			expect(updateTables.mock.calls[0][0].tables).toEqual([
				expect.objectContaining({ included: false }),
				expect.objectContaining({ included: true })
			])
		})

		it('reports a refused save rather than pretending it landed', async () => {
			const error = vi.spyOn(toast, 'error').mockReturnValue('t')
			const { updateTables } = renderEditor()
			updateTables.mockRejectedValue(new Error('nope'))

			fireEvent.click(screen.getByRole('switch'))

			await waitFor(
				() => {
					expect(error).toHaveBeenCalledWith('Could not save the table settings.')
				},
				{ timeout: 3000 }
			)

			error.mockRestore()
		})
	})

	describe('moving a region', () => {

		it('QUIRK - re-extracts the rows rather than merely saving the new box', async () => {
			// Moving the box changes WHICH ink is read. A plain save would leave the rows describing
			// the old region while the overlay described the new one.
			const { reextract, updateTables, mutate } = renderEditor()

			stubPageRect()
			const overlay = screen.getAllByText('Table 1')[0].parentElement as HTMLElement

			fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 0, clientY: 0 })
			fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 30, clientY: 20 })
			fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 30, clientY: 20 })

			await waitFor(
				() => {
					expect(reextract).toHaveBeenCalledTimes(1)
				},
				{ timeout: 3000 }
			)

			expect(reextract).toHaveBeenCalledWith({
				statement_import_id: 'pdf-log-1',
				page: 1,
				table_index: 0,
				bbox: [80, 120, 580, 420]
			})
			// A region change is NOT also a settings save.
			expect(updateTables).not.toHaveBeenCalled()
			await waitFor(() => {
				expect(mutate).toHaveBeenCalled()
			})
		})

		it('reports a refused re-extract rather than leaving the rows silently stale', async () => {
			const error = vi.spyOn(toast, 'error').mockReturnValue('t')
			const { reextract } = renderEditor()
			reextract.mockRejectedValue(new Error('nope'))

			stubPageRect()
			const overlay = screen.getAllByText('Table 1')[0].parentElement as HTMLElement

			fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 0, clientY: 0 })
			fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 30, clientY: 20 })
			fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 30, clientY: 20 })

			await waitFor(
				() => {
					expect(error).toHaveBeenCalledWith('Could not re-extract the table.')
				},
				{ timeout: 3000 }
			)

			error.mockRestore()
		})
	})

	describe('the table view', () => {

		const showTableView = async (
			data: GetStatementDetailsResponse = makeDetails()
		) => {
			const seams = renderEditor(data)

			await seams.user.click(screen.getByRole('tab', { name: /Table/ }))
			await screen.findByText('Table 1')

			return seams
		}

		it('shows the extracted cells so the reviewer can check them', async () => {
			await showTableView()

			expect(screen.getByText('Bank charge')).toBeInTheDocument()
			expect(screen.getByText('48000.00')).toBeInTheDocument()
		})

		it('QUIRK - sends a header change immediately, not on the save debounce', async () => {
			// The server re-derives the whole column mapping from the header row, so the reviewer has
			// to see that result at once rather than half a second later.
			const { setHeader, mutate } = await showTableView()

			await waitFor(() => {
				expect(screen.getByText('Bank charge')).toBeInTheDocument()
			})

			// Clicking the row number of the CURRENT header clears it (`onSetHeader(null)` becomes -1
			// on the wire).
			fireEvent.click(screen.getAllByText('1')[0])

			await waitFor(() => {
				expect(setHeader).toHaveBeenCalled()
			})
			expect(setHeader.mock.calls[0][0]).toMatchObject({
				statement_import_id: 'pdf-log-1',
				page: 1,
				table_index: 0
			})
			await waitFor(() => {
				expect(mutate).toHaveBeenCalled()
			})
		})

		it('reports a refused header change', async () => {
			const error = vi.spyOn(toast, 'error').mockReturnValue('t')
			const { setHeader } = await showTableView()
			setHeader.mockRejectedValue(new Error('nope'))

			fireEvent.click(screen.getAllByText('1')[0])

			await waitFor(() => {
				expect(error).toHaveBeenCalledWith('Could not update the header row.')
			})

			error.mockRestore()
		})

		it('dims a table that is excluded from the import', async () => {
			await showTableView(
				makeDetails({ pdf_tables: [makePDFTable({ included: false })] })
			)

			expect(document.querySelector('.opacity-60')).not.toBeNull()
		})

		it('collapses a table so a long one can be scrolled past', async () => {
			const { user } = await showTableView()

			expect(screen.getByText('Bank charge')).toBeInTheDocument()

			// Identified by its icon: the page-navigation buttons carry chevron-LEFT and -RIGHT, and
			// the row-number buttons carry no icon at all, so chevron-DOWN is unambiguously the
			// table's own collapse control.
			const collapse = document
				.querySelector('svg.lucide-chevron-down')
				?.closest('button') as HTMLElement

			await user.click(collapse)

			await waitFor(() => {
				expect(screen.queryByText('Bank charge')).not.toBeInTheDocument()
			})
		})
	})

	describe('once the statement has been imported', () => {

		const completed = () =>
			makeDetails({
				doc: makeBankStatementImportLog({ name: 'pdf-log-1', status: 'Completed' })
			})

		it('QUIRK - refuses every edit, because the transactions already exist', async () => {
			// Re-reading the page now could only disagree with transactions that have already been
			// created, so the whole surface is frozen rather than partly disabled.
			const { updateTables, reextract } = renderEditor(completed())

			expect(screen.getByRole('switch')).toBeDisabled()

			fireEvent.click(screen.getByRole('switch'))

			await new Promise((resolve) => setTimeout(resolve, 700))

			expect(updateTables).not.toHaveBeenCalled()
			expect(reextract).not.toHaveBeenCalled()
		})

		it('withdraws the drag instruction, since nothing can be dragged', () => {
			renderEditor(completed())

			expect(
				screen.queryByText(/Drag a box to move it, or drag a corner to resize/)
			).not.toBeInTheDocument()
		})
	})
})
