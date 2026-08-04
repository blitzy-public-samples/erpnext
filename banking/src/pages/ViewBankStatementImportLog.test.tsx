/*
 * `ViewBankStatementImportLog` — the import-log detail route (`/statement-importer/:id`).
 *
 * This suite exists for ONE reason, and it is a reason worth stating precisely: the three render
 * branches of this route were ordered NO-DATA -> LOADING -> ERROR, and `useFrappeGetCall` returns no
 * data on a FAILED read as well as on a pending one. The no-data guard therefore returned `null` for
 * every refusal of `get_statement_details` and the two branches after it became unreachable. A
 * reviewer who opened an import log whose file had been deleted, whose bank account they lacked
 * permission on, or whose PDF password was missing was shown a BLANK PAGE — no message, no
 * explanation, and not even the Back control, which meant the only way out was the browser's own
 * back button.
 *
 * FM2 requires the import status view to show the backend's own account of what went wrong. The
 * banner and the Back link were already written; they were simply never reached. Every case below
 * asserts on what the route RENDERS for a given hook state, so a future reordering fails here.
 *
 * The two import flows are lazily loaded, so the success branches are asserted at the Suspense
 * boundary — see the note above them for why the flow bodies themselves are deliberately not mounted.
 */
import { render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import {
	createFrappeSDKMock,
	frappeHookMutate,
	frappeSDKMock,
	makeBankStatementImportLog,
	makeExceptionError,
	makeServerMessagesError
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import ViewBankStatementImportLog from './ViewBankStatementImportLog'

const LOG_NAME = makeBankStatementImportLog().name

/** The shape `get_statement_details` returns, narrowed to what this route reads off it. */
const statementDetails = (file: string) => ({
	message: {
		doc: makeBankStatementImportLog({ file }),
		conflicting_transactions: [],
		final_transactions: [],
		date_format: '%d-%m-%Y',
		raw_data: []
	}
})

type HookState = {
	data?: unknown
	error?: unknown
	isLoading?: boolean
}

const installStatementDetails = ({ data, error, isLoading = false }: HookState) => {
	frappeSDKMock.useFrappeGetCall.mockImplementation(() => ({
		data,
		error: error as never,
		isLoading,
		isValidating: false,
		mutate: frappeHookMutate
	}))
}

const renderRoute = () =>
	render(
		<MemoryRouter initialEntries={[`/statement-importer/${LOG_NAME}`]}>
			<Suspense fallback={<span>Loading the import flow</span>}>
				<Routes>
					<Route path="/statement-importer/:id" element={<ViewBankStatementImportLog />} />
				</Routes>
			</Suspense>
		</MemoryRouter>
	)

describe('ViewBankStatementImportLog', () => {

	describe('while the statement details are still being read', () => {
		it('reports the read in progress rather than a failure', () => {
			// Loading is tested BEFORE error precisely because SWR reports it while `data` and `error`
			// are both absent: a pending read must never be presented as a refusal.
			installStatementDetails({ isLoading: true })

			renderRoute()

			expect(screen.getByText('Loading...')).toBeInTheDocument()
			expect(screen.queryByRole('alert')).not.toBeInTheDocument()
		})
	})

	/*
	 * ⚠️ THE BLANK-PAGE REGRESSION. Each case here failed outright before the branch order was
	 * corrected: the route returned `null`, so there was nothing in the document to assert on.
	 */
	describe('when the read is refused', () => {
		it("renders the server's own message instead of an empty page", () => {
			installStatementDetails({ error: makeServerMessagesError('Insufficient Permission for File') })

			renderRoute()

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText('Insufficient Permission for File')).toBeInTheDocument()
		})

		it('keeps a way out, so the reviewer is not stranded on the route', () => {
			installStatementDetails({ error: makeServerMessagesError('Insufficient Permission for File') })

			renderRoute()

			const back = screen.getByRole('link', { name: 'Back' })
			expect(back).toBeInTheDocument()
			expect(back).toHaveAttribute('href', '/statement-importer')
		})

		it('reports a refusal that arrives on `exception` rather than `_server_messages`', () => {
			// The shared parser resolves across four envelope shapes, and this route hands it whatever
			// the SDK produced — so the branch has to be reachable for all of them, not just the common
			// one.
			installStatementDetails({ error: makeExceptionError('Bank Statement Import Log not found') })

			renderRoute()

			expect(screen.getByRole('alert')).toHaveTextContent('Bank Statement Import Log not found')
		})

		it('renders the error branch even though the failed read carries no data', () => {
			// The defect in one assertion: `data` is undefined here, which is exactly the condition the
			// no-data guard used to short-circuit on before the error branch could run.
			installStatementDetails({ data: undefined, error: makeServerMessagesError('No tables detected') })

			renderRoute()

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
		})
	})

	describe('when the read succeeds but carries no document', () => {
		it('renders nothing, since there is neither an error to report nor a statement to show', () => {
			// A degenerate response rather than an expected one. It must NOT be presented as a failure:
			// no refusal was observed, so the route asserts nothing about one.
			installStatementDetails({ data: { message: undefined } })

			const { container } = renderRoute()

			expect(container).toBeEmptyDOMElement()
			expect(screen.queryByRole('alert')).not.toBeInTheDocument()
		})
	})

	describe('when the statement details arrive', () => {
		/*
		 * Asserted at the SUSPENSE BOUNDARY and then unmounted, deliberately.
		 *
		 * Both import flows are `lazy()` and pull in the whole statement-import subtree — the details
		 * table, the raw-data preview, the PDF table editor — none of which this route's branch order
		 * has anything to do with, and each of which brings its own provider and endpoint requirements.
		 * What this route decides is WHICH branch runs, so the assertion is that it reached the flow
		 * branch rather than the loading or error branch. Unmounting immediately keeps the lazy body
		 * from mounting after the test has finished and reporting an unhandled error for a component
		 * that is covered by its own suite.
		 */
		const expectHandsOffToTheImportFlow = (file: string) => {
			installStatementDetails({ data: statementDetails(file) })

			const { unmount } = renderRoute()

			expect(screen.getByText('Loading the import flow')).toBeInTheDocument()
			expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
			expect(screen.queryByRole('alert')).not.toBeInTheDocument()

			unmount()
		}

		it('hands a CSV statement off to a lazily-loaded flow', () => {
			expectHandsOffToTheImportFlow('/private/files/january.csv')
		})

		it('hands a PDF statement off to a lazily-loaded flow, whatever the extension case', () => {
			// `isPdf` lower-cases before testing the suffix, so an upper-cased extension still routes.
			expectHandsOffToTheImportFlow('/private/files/January.PDF')
		})
	})
})
