/**
 * Behavioural specification for the import-log detail route.
 *
 * This page is a router, not a view: it fetches one import log and then decides whether the reviewer gets
 * the spreadsheet workflow or the PDF workflow. Everything visible belongs to one of those two, so the
 * behaviour worth specifying is the routing itself and the states it refuses to route in.
 *
 * The ORDER of its four guards is the behaviour most worth pinning, because getting it wrong is how this
 * page came to render a blank frame for both of the states a reviewer most needs explained. `data` is
 * absent while a read is in flight AND after one fails, so a no-data guard placed first swallows the two
 * states below it: pending and failed became indistinguishable, and both looked like an empty page. The
 * order asserted here is pending, then failed, then genuinely-absent, then the workflow itself.
 *
 * Two behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. The choice of workflow is made from the FILE EXTENSION, not from a field on the document, and the
 *      comparison is case-insensitive - so `STATEMENT.PDF` routes correctly.
 *   2. A failed read still offers a way back to the list, because the reviewer would otherwise be
 *      stranded on a dead route - and so does the absent-log state, for the same reason.
 *
 * The two workflow components are lazily imported, so each routing assertion waits for the chunk rather
 * than asserting synchronously.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { Provider, createStore } from 'jotai'

import {
	createFrappeSDKMock,
	frappeSDKMock,
	makeBankStatementImportLog,
	makeServerMessagesError
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { TooltipProvider } from '@/components/ui/tooltip'
import ViewBankStatementImportLog from './ViewBankStatementImportLog'
import type { GetStatementDetailsResponse } from '@/components/features/BankStatementImporter/import_utils'

const makeDetails = (
	file: string,
	overrides: Partial<GetStatementDetailsResponse> = {}
): GetStatementDetailsResponse => ({
	doc: makeBankStatementImportLog({
		name: 'log-1',
		status: 'Not Started',
		file,
		column_mapping: [],
		detected_header_index: 0
	}),
	conflicting_transactions: [],
	final_transactions: [],
	date_format: 'dd-mm-yyyy',
	raw_data: [['Date', 'Narrative'], ['05-08-2026', 'Bank charge']],
	// Present only for a PDF, mirroring the endpoint, which returns this key exclusively from its
	// `is_pdf()` branch.
	...(file.toLowerCase().endsWith('.pdf')
		? {
			pdf_tables: [
				{
					page: 1,
					table_index: 0,
					bbox: [50, 100, 550, 400] as [number, number, number, number],
					page_width: 600,
					page_height: 800,
					page_image: 'data:image/png;base64,iVBORw0KGgo=',
					render_scale: 2,
					rows: [['Date', 'Narrative'], ['05-08-2026', 'Bank charge']],
					header_index: 0,
					column_mapping: [
						{ index: 0, header_text: 'Date', maps_to: 'Date' as const },
						{ index: 1, header_text: 'Narrative', maps_to: 'Description' as const }
					],
					included: true
				}
			]
		}
		: {}),
	...overrides
})

interface RouteOptions {
	details?: GetStatementDetailsResponse
	error?: ReturnType<typeof makeServerMessagesError>
	isLoading?: boolean
}

const renderRoute = ({ details, error, isLoading = false }: RouteOptions = {}) => {
	frappeSDKMock.useFrappeGetCall.mockImplementation(((method: string) => {
		// Only the statement-details read is answered from the scenario; the nested workflows make
		// their own unrelated calls, which stay empty.
		if (method.endsWith('get_statement_details')) {
			return {
				data: details ? { message: details } : undefined,
				error,
				isLoading,
				isValidating: false,
				mutate: vi.fn()
			}
		}

		return {
			data: { message: [] },
			error: undefined,
			isLoading: false,
			isValidating: false,
			mutate: vi.fn()
		}
	}) as never)

	frappeSDKMock.useFrappePostCall.mockReturnValue({
		call: vi.fn().mockResolvedValue({}),
		result: null,
		loading: false,
		error: null,
		isCompleted: false,
		reset: vi.fn()
	} as never)

	const store = createStore()

	// Mounted behind its real route pattern rather than directly, because the page reads the log's id out
	// of the route params and reports it in the absent-log state: rendered bare, `useParams` yields nothing
	// and that reporting would go untested.
	return render(
		<Provider store={store}>
			<TooltipProvider>
				<MemoryRouter initialEntries={['/statement-importer/log-1']}>
					<Routes>
						<Route path="/statement-importer/:id" element={<ViewBankStatementImportLog />} />
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</Provider>
	)
}

describe('ViewBankStatementImportLog', () => {

	beforeEach(() => {
		frappeSDKMock.useFrappeGetDocList.mockReturnValue({
			data: [],
			error: undefined,
			isLoading: false,
			isValidating: false,
			mutate: vi.fn()
		} as never)
	})

	describe('while the read is in flight', () => {

		it('says it is loading, in place of the statement', () => {
			// The reviewer arrives here by clicking a row in the importer list, so SOMETHING has to occupy
			// the page while the read runs: a blank one reads as "this import is empty".
			renderRoute({ isLoading: true })

			expect(screen.getByRole('status')).toHaveTextContent('Loading')
		})

		it('shows a skeleton of the grid it is about to draw, not an error and not a way back', () => {
			// A pending read is not a failure, so neither the refusal nor its escape hatch belongs here -
			// offering "Back" while a read is merely slow invites the reviewer to abandon it.
			const { container } = renderRoute({ isLoading: true })

			expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
			expect(screen.queryByRole('link', { name: /Back/ })).not.toBeInTheDocument()
		})
	})

	describe('when the read fails', () => {

		it('shows the refusal even though the failed read left no data behind', () => {
			// The whole point of the guard order: a server that throws returns no `data`, so a no-data
			// guard checked first would swallow this and render an empty page instead of the reason.
			renderRoute({ error: makeServerMessagesError('Not permitted') })

			expect(screen.getByText('Not permitted')).toBeInTheDocument()
		})

		it('shows the refusal when a previous read had already delivered data', () => {
			renderRoute({
				details: makeDetails('statement.csv'),
				error: makeServerMessagesError('Not permitted')
			})

			expect(screen.getByText('Not permitted')).toBeInTheDocument()
		})

		it('QUIRK - still offers a way back to the list', () => {
			// Without this the reviewer is stranded: the route renders no navigation of its own.
			renderRoute({ error: makeServerMessagesError('Not permitted') })

			expect(screen.getByRole('link', { name: /Back/ })).toHaveAttribute(
				'href',
				'/statement-importer'
			)
		})

		it('does not also draw the loading skeleton', () => {
			const { container } = renderRoute({ error: makeServerMessagesError('Not permitted') })

			expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0)
		})
	})

	describe('when the log itself is absent', () => {

		it('names the state instead of rendering an empty page', () => {
			// A settled read that returned nothing is a deleted or mistyped log, and it must not look like
			// a statement that happens to hold no transactions.
			renderRoute()

			expect(screen.getByText('This statement import could not be opened')).toBeInTheDocument()
		})

		it('names the id it could not open, so the reviewer can tell which one is gone', () => {
			renderRoute()

			expect(screen.getByText(/log-1/)).toBeInTheDocument()
		})

		it('offers the same way back to the list', () => {
			renderRoute()

			expect(screen.getByRole('link', { name: /Back/ })).toHaveAttribute(
				'href',
				'/statement-importer'
			)
		})

		it('does not claim a failure it was not told about', () => {
			// Nothing was refused here - the read simply came back empty - so no error surface belongs on
			// the page. `alert` is what the refusal branch renders through.
			renderRoute()

			expect(screen.queryByRole('alert')).not.toBeInTheDocument()
		})
	})

	describe('choosing the workflow', () => {

		it('QUIRK - sends a PDF to the region editor, keyed on the file extension', async () => {
			// There is no "is this a PDF" field on the document, so the extension is the only signal.
			renderRoute({ details: makeDetails('september-statement.pdf') })

			// The PDF workflow is the only one that offers the detected-table editor.
			expect(await screen.findByText('Detected Tables')).toBeInTheDocument()
		})

		it('QUIRK - matches the extension case-insensitively', async () => {
			// Statements exported by bank portals are frequently upper-cased, and routing such a file
			// to the spreadsheet workflow would show a reviewer an unusable grid of binary text.
			renderRoute({ details: makeDetails('SEPTEMBER-STATEMENT.PDF') })

			expect(await screen.findByText('Detected Tables')).toBeInTheDocument()
		})

		it('sends a spreadsheet to the column-mapping workflow', async () => {
			renderRoute({ details: makeDetails('september-statement.csv') })

			// The spreadsheet workflow shows the raw sheet and no table-region editor.
			expect(await screen.findByText('Bank charge')).toBeInTheDocument()
			expect(screen.queryByText('Detected Tables')).not.toBeInTheDocument()
		})

		it('sends an XLSX to the spreadsheet workflow too', async () => {
			renderRoute({ details: makeDetails('september-statement.xlsx') })

			expect(await screen.findByText('Bank charge')).toBeInTheDocument()
			expect(screen.queryByText('Detected Tables')).not.toBeInTheDocument()
		})

	})
})
