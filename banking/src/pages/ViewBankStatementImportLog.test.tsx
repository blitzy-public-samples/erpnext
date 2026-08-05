/**
 * Behavioural specification for the import-log detail route.
 *
 * This page is a router, not a view: it fetches one import log and then decides whether the reviewer gets
 * the spreadsheet workflow or the PDF workflow. Everything visible belongs to one of those two, so the
 * behaviour worth specifying is the routing itself and the states it refuses to route in.
 *
 * Four behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. The choice of workflow is made from the FILE EXTENSION, not from a field on the document, and the
 *      comparison is case-insensitive - so `STATEMENT.PDF` routes correctly.
 *   2. The "Loading..." branch is DEAD CODE. The no-data guard is checked first, and while a read is in
 *      flight there is no data, so the page renders nothing at all instead of a loading message.
 *   3. It renders nothing rather than an empty frame when the log is absent, which is what keeps a bad
 *      URL from looking like an empty statement.
 *   4. A failed read still offers a way back to the list, because the reviewer would otherwise be
 *      stranded on a dead route.
 *
 * The two workflow components are lazily imported, so each routing assertion waits for the chunk rather
 * than asserting synchronously.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
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

	return render(
		<Provider store={store}>
			<TooltipProvider>
				<MemoryRouter initialEntries={['/statement-importer/log-1']}>
					<ViewBankStatementImportLog />
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

	describe('before the log has arrived', () => {

		it('QUIRK - renders nothing rather than an empty frame', () => {
			// A bad or deleted id must not look like a statement with no transactions in it.
			const { container } = renderRoute()

			expect(container).toBeEmptyDOMElement()
		})

		it('QUIRK - never shows its own loading message, because that branch is unreachable', () => {
			// The no-data guard runs BEFORE the `isLoading` check, and a read in flight has no data,
			// so `Loading...` can never render. Pinned rather than fixed: the empty render is the
			// better behaviour anyway, and reordering the guards would introduce a flash of text that
			// no other route in the SPA shows.
			const { container } = renderRoute({ isLoading: true })

			expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
			expect(container).toBeEmptyDOMElement()
		})
	})

	describe('when the read fails', () => {

		it('shows the refusal', () => {
			renderRoute({
				details: makeDetails('statement.csv'),
				error: makeServerMessagesError('Not permitted')
			})

			expect(screen.getByText('Not permitted')).toBeInTheDocument()
		})

		it('QUIRK - still offers a way back to the list', () => {
			// Without this the reviewer is stranded: the route renders no navigation of its own.
			renderRoute({
				details: makeDetails('statement.csv'),
				error: makeServerMessagesError('Not permitted')
			})

			expect(screen.getByRole('link', { name: /Back/ })).toHaveAttribute(
				'href',
				'/statement-importer'
			)
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
