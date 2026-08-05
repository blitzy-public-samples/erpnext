/*
 * Covers the import-log list, the upload flow, the per-log failure badge, the query scope, and this
 * page's mount of the shared error dialog.
 *
 * Two things silently empty the tree if got wrong:
 *   1. The list is gated on a selected bank account, so every scenario expecting a table, an empty
 *      state or a list error seeds `selectedBankAccountAtom`. One test deliberately does not, to prove
 *      the gate.
 *   2. `StatementImportLog` destructures only `{ data, error }` - there is no loading state and no
 *      skeleton, so `data: []` and `data: undefined` reach the SAME empty branch.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	createFrappeSDKMock,
	frappeCreateDoc,
	frappeFileUpload,
	frappeHookMutate,
	frappeSDKMock,
	frappeUpdateDoc,
	makeBankStatementImportLog,
	makeErrorMessageError,
	makeFileUploadResponse,
	makeFrappeError,
	makeImportFailures,
	makeSelectedBank,
	makeServerMessagesError,
	makeWarningServerMessagesError
} from '@/test/factories'

// `vi.hoisted` because the `vi.mock` factory below is lifted above every ordinary declaration and
// would otherwise close over an uninitialised binding. The stub covers every `toast` member this
// page's module graph can reach, since a missing one would throw from inside a handler.
const { toastError, toastSuccess, toastWarning } = vi.hoisted(() => ({
	toastError: vi.fn<(message: string, options?: unknown) => void>(),
	toastSuccess: vi.fn<(message: string, options?: unknown) => void>(),
	toastWarning: vi.fn<(message: string, options?: unknown) => void>()
}))

vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess, warning: toastWarning } }))

// The page imports five SDK hooks at module scope and its subtree reaches `useSWRConfig` through
// `BankPicker -> utils.ts`, so the package is replaced wholesale to keep every one of those seams
// resolvable.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankStatementImporter from './BankStatementImporter'
import {
	canCreateDocument,
	canDeleteDocument,
	canReadDocument,
	canWriteDocument
} from '@/lib/permissions'
import {
	bankRecErrorDialogAtom,
	bankRecImportFailuresAtom,
	selectedBankAccountAtom
} from '@/components/features/BankReconciliation/bankRecAtoms'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'

type FrappeErrorFixture = ReturnType<typeof makeFrappeError>
type FrappeError = FrappeErrorFixture

const IMPORT_LOG_DOCTYPE = 'Bank Statement Import Log'

const IMPORTER_ROUTE = '/statement-importer'

/**
 * Stands in for the detail view at the `:id` child route. A sentinel ROUTE rather than a mocked
 * `useNavigate` keeps the assertion about observable behaviour, and it renders the `:id` it was reached
 * WITH, because "a detail view opened" is materially weaker than "the detail view of THIS log opened" -
 * a constant sentinel would also be satisfied by `/statement-importer/undefined`.
 */
const DETAIL_SENTINEL = 'import-log-detail-reached'

const ImportLogDetailProbe = () => {
	const { id } = useParams()

	return <div>{DETAIL_SENTINEL}:{id}</div>
}

const detailViewFor = (logName: string): string => `${DETAIL_SENTINEL}:${logName}`
const SELECTED_BANK = makeSelectedBank()

/*
 * Each row carries a slash-bearing `file` so `file.split('/').pop()` yields a real displayed name.
 * `status` uses only the two values the DocType declares; it has no third value and no error field,
 * which is why every failure state below comes from a client-side marker instead.
 */

const COMPLETED_LOG = makeBankStatementImportLog({
	name: 'BSIL-2024-00001',
	file: '/files/hdfc-statement-jan-2024.csv',
	status: 'Completed',
	creation: '2024-01-15 10:30:00.000000',
	start_date: '2024-01-01',
	end_date: '2024-01-31',
	number_of_transactions: 24,
	closing_balance: 152300.75
})

const NOT_STARTED_LOG = makeBankStatementImportLog({
	name: 'BSIL-2024-00002',
	file: '/files/hdfc-statement-feb-2024.xlsx',
	status: 'Not Started',
	creation: '2024-02-14 09:05:11.000000',
	start_date: undefined,
	end_date: undefined,
	number_of_transactions: 0,
	closing_balance: 0
})

const FAILED_LOG = makeBankStatementImportLog({
	name: 'BSIL-2024-00003',
	file: '/files/hdfc-statement-mar-2024.pdf',
	status: 'Not Started',
	creation: '2024-03-12 08:15:42.000000',
	start_date: '2024-03-01',
	end_date: '2024-03-31',
	number_of_transactions: 0,
	closing_balance: 0
})

const INDETERMINATE_LOG = makeBankStatementImportLog({
	name: 'BSIL-2024-00004',
	file: '/files/hdfc-statement-apr-2024.csv',
	status: 'Not Started',
	creation: '2024-04-08 16:42:03.000000',
	start_date: '2024-04-01',
	end_date: '2024-04-30',
	number_of_transactions: 0,
	closing_balance: 0
})

const ALL_LOGS: BankStatementImportLog[] = [
	INDETERMINATE_LOG,
	FAILED_LOG,
	NOT_STARTED_LOG,
	COMPLETED_LOG
]

const FAILED_LOG_MESSAGE = 'No tables found in the PDF file'
const SECOND_FAILED_LOG_MESSAGE = 'The bank account is disabled. Please enable it'

const ATTEMPT_MARKERS: Record<string, FrappeError> = {
	...makeImportFailures(FAILED_LOG, FAILED_LOG_MESSAGE),
	...makeImportFailures(INDETERMINATE_LOG, SECOND_FAILED_LOG_MESSAGE)
}

interface ImporterScenario {
	logs?: BankStatementImportLog[]
	listError?: FrappeErrorFixture
	markers?: Record<string, FrappeError>
	dialogError?: FrappeErrorFixture
	uploadError?: FrappeErrorFixture
	/**
	 * Answer the list query with ONLY the fields it asked for, as the server does. Used where the
	 * assertion is about whether a field is actually PROJECTED rather than about what is rendered.
	 */
	projectQueriedFieldsOnly?: boolean
	withSelectedBank?: boolean
	selectedBank?: ReturnType<typeof makeSelectedBank>
}

const listQueryResponse = (logs?: BankStatementImportLog[], listError?: FrappeErrorFixture) => ({
	data: logs,
	error: listError,
	isLoading: false,
	isValidating: false,
	mutate: frappeHookMutate
})

const installImportLogQuery = (logs?: BankStatementImportLog[], listError?: FrappeErrorFixture) => {
	frappeSDKMock.useFrappeGetDocList.mockImplementation((doctype) =>
		doctype === IMPORT_LOG_DOCTYPE ? listQueryResponse(logs, listError) : listQueryResponse()
	)
}

/**
 * Installs the list answer PROJECTED DOWN to exactly the fields the page asked for, which is what the
 * server does. A fixture handing back a complete document would let a component read a field it never
 * requested and pass anyway; deriving the projection from the query's own `fields` argument makes the
 * two inseparable.
 */
const installProjectedImportLogQuery = (logs: BankStatementImportLog[]) => {
	frappeSDKMock.useFrappeGetDocList.mockImplementation((doctype, args) => {
		if (doctype !== IMPORT_LOG_DOCTYPE) {
			return listQueryResponse()
		}

		const requested = (args?.fields ?? []) as (keyof BankStatementImportLog)[]

		// A projection is a PARTIAL document by definition, so it is widened through `unknown`: the
		// list hook is typed with the full DocType, and pretending a nine-field row satisfies that
		// interface directly is exactly the lie this helper exists to avoid telling the component.
		const projected = logs.map((log) =>
			Object.fromEntries(
				requested
					.filter((field) => log[field] !== undefined)
					.map((field) => [field, log[field]])
			) as unknown as BankStatementImportLog
		)

		return listQueryResponse(projected)
	})
}

const installFileUploadError = (uploadError: FrappeErrorFixture) => {
	frappeSDKMock.useFrappeFileUpload.mockImplementation(() => ({
		upload: frappeFileUpload,
		progress: 0,
		loading: false,
		error: uploadError,
		isCompleted: false,
		reset: () => undefined
	}))
}

/**
 * Seeds the error state the CREATE hook exposes after a refusal, which is what the page reads to render
 * its inline banner. Seeded rather than provoked by rejecting the spy, because `onUpload` carries no
 * rejection handler, so rejecting it would leave an unhandled rejection behind.
 */
const installCreateDocError = (createError: FrappeErrorFixture) => {
	frappeSDKMock.useFrappeCreateDoc.mockImplementation(() => ({
		createDoc: frappeCreateDoc,
		loading: false,
		error: createError,
		isCompleted: false,
		reset: () => undefined
	}))
}

const installUpdateDocError = (updateError: FrappeErrorFixture) => {
	frappeSDKMock.useFrappeUpdateDoc.mockImplementation(() => ({
		updateDoc: frappeUpdateDoc,
		loading: false,
		error: updateError,
		isCompleted: false,
		reset: () => undefined
	}))
}


// A store PER TEST is required because the harness performs no global atom reset and
// `selectedBankAccountAtom` is backed by `localStorage`.
const renderImporter = ({
	logs,
	listError,
	markers,
	dialogError,
	uploadError,
	projectQueriedFieldsOnly = false,
	withSelectedBank = true,
	selectedBank = SELECTED_BANK
}: ImporterScenario = {}) => {
	if (projectQueriedFieldsOnly) {
		installProjectedImportLogQuery(logs ?? [])
	} else {
		installImportLogQuery(logs, listError)
	}

	if (uploadError) {
		installFileUploadError(uploadError)
	}

	const store = createStore()

	if (withSelectedBank) {
		store.set(selectedBankAccountAtom, selectedBank)
	}
	if (markers) {
		store.set(bankRecImportFailuresAtom, markers)
	}
	if (dialogError) {
		store.set(bankRecErrorDialogAtom, dialogError)
	}
	const utils = render(
		<Provider store={store}>
			{/* The page mounts a provider only inside the failed chip, so the alert dialog's own
			  * tooltips would throw without this one; `App.tsx` supplies it outside the router in
			  * production. */}
			<TooltipProvider>
				<MemoryRouter initialEntries={[IMPORTER_ROUTE]}>
					<Routes>
						<Route path={IMPORTER_ROUTE}>
							<Route index element={<BankStatementImporter />} />
							<Route path=":id" element={<ImportLogDetailProbe />} />
						</Route>
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</Provider>
	)

	return { ...utils, store }
}

const displayedFileName = (log: BankStatementImportLog): string =>
	log.file.split('/').pop() ?? log.file

const rowFor = (log: BankStatementImportLog): HTMLElement => {
	const link = screen.getByRole('link', { name: displayedFileName(log) })
	const row = link.closest<HTMLElement>('[data-slot="table-row"]')

	if (!row) {
		throw new Error(`No table row was rendered for import log ${log.name}`)
	}

	return row
}

/**
 * The status chip inside a row. Its theme is asserted through `data-theme`, never through a class
 * string: `tailwind-merge` is free to reorder and collapse classes.
 */
const statusBadgeIn = (row: HTMLElement): HTMLElement => {
	/*
	 * Located by Badge's own variant attributes: `data-variant`, `data-size` and `data-theme` are set by
	 * Badge and by nothing else in this row, whose remaining cells are plain text and one anchor.
	 */
	const badge = row.querySelector<HTMLElement>('[data-variant][data-size][data-theme]')

	if (!badge) {
		throw new Error('The row rendered no status badge')
	}

	return badge
}

/**
 * Selects a statement through the dropzone's own file input, which is how a real selection reaches
 * the page: `react-dropzone` wires that input through `getInputProps`, so a change event on it is
 * the genuine entry point rather than a shortcut around the component.
 */
const chooseStatementFile = async (container: HTMLElement, file: File): Promise<void> => {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]')

	if (!input) {
		throw new Error('The statement dropzone rendered no file input')
	}

	await userEvent.upload(input, file)
}

const csvStatementFile = (
	name = 'hdfc-statement-jan-2024.csv',
	rows = '2024-01-15,NEFT credit,12500'
): File => new File([`Date,Description,Amount\n${rows}\n`], name, { type: 'text/csv' })

describe('BankStatementImporter', () => {

	/*
	 * The toast spies live outside the SDK mock, so `resetFrappeSDKMock` in the shared harness does not
	 * reach them. Reset here rather than in `afterEach` so a per-test implementation installed inside a
	 * test is discarded along with the history, matching the convention the harness documents.
	 */
	beforeEach(() => {
		toastError.mockReset()
		toastSuccess.mockReset()
		toastWarning.mockReset()
	})

	describe('previous imports list (TC1)', () => {

		it('renders one row per log the server returned, in the order it returned them', () => {
			renderImporter({ logs: ALL_LOGS })

			expect(screen.getByText('Previous Imports')).toBeInTheDocument()

			// Scoped to the table, because the bank picker renders a link of its own when the
			// account list is empty — a document-wide link query would collect that too.
			const table = within(screen.getByRole('table'))

			expect(table.getAllByRole('row')).toHaveLength(ALL_LOGS.length + 1)

			const renderedFileNames = table.getAllByRole('link').map((link) => link.textContent)

			expect(renderedFileNames).toEqual(ALL_LOGS.map(displayedFileName))
		})

		it('labels all six columns the row projects', () => {
			renderImporter({ logs: [COMPLETED_LOG] })

			const headers = screen
				.getAllByRole('columnheader')
				.map((header) => header.textContent)

			expect(headers).toEqual([
				'Imported On',
				'Status',
				'Transaction Dates',
				'Number of Transactions',
				'Closing Balance',
				'File'
			])
		})

		it('renders every projected cell of a fully populated row', () => {
			renderImporter({ logs: [COMPLETED_LOG] })

			const row = within(rowFor(COMPLETED_LOG))

			expect(row.getByText('15th Jan 2024')).toBeInTheDocument()
			expect(row.getByText('1st Jan 2024 to 31st Jan 2024')).toBeInTheDocument()
			expect(row.getByText('24')).toBeInTheDocument()
			expect(row.getByText(/152,300\.75/)).toBeInTheDocument()

			const fileLink = row.getByRole('link', { name: 'hdfc-statement-jan-2024.csv' })
			expect(fileLink).toHaveAttribute('href', COMPLETED_LOG.file)
			expect(fileLink).toHaveAttribute('target', '_blank')
		})

		it('falls back to a dash when a log carries no statement date range', () => {
			renderImporter({ logs: [NOT_STARTED_LOG] })

			const row = within(rowFor(NOT_STARTED_LOG))

			expect(row.getByText('-')).toBeInTheDocument()
			expect(row.getByText('14th Feb 2024')).toBeInTheDocument()
		})

		it('opens the detail view for the log whose row is clicked', async () => {
			renderImporter({ logs: ALL_LOGS })

			await userEvent.click(rowFor(FAILED_LOG))

			expect(await screen.findByText(detailViewFor(FAILED_LOG.name))).toBeInTheDocument()
			expect(screen.queryByText('Previous Imports')).not.toBeInTheDocument()
		})

		it('opens each row on its own log, never a neighbour and never nothing', async () => {
			// Run per row rather than once, because a single-row assertion is also satisfied by a
			// handler that ignores its argument when only one candidate exists.
			for (const log of [COMPLETED_LOG, NOT_STARTED_LOG, INDETERMINATE_LOG]) {
				const { unmount } = renderImporter({ logs: ALL_LOGS })

				await userEvent.click(rowFor(log))

				expect(await screen.findByText(detailViewFor(log.name))).toBeInTheDocument()
				ALL_LOGS.filter((other) => other.name !== log.name).forEach((other) => {
					expect(screen.queryByText(detailViewFor(other.name))).not.toBeInTheDocument()
				})
				expect(screen.queryByText(detailViewFor('undefined'))).not.toBeInTheDocument()

				unmount()
			}
		})
	})

	/* ── The list query itself: scope, projection and ordering ───────────────────────── */

	/**
	 * What the query asks for is part of the behaviour. The rows above are asserted from a mocked answer,
	 * so nothing in them can tell whether the question was scoped - and a list that lost its
	 * `bank_account` filter would show one account's statement history on another account's screen while
	 * every rendering assertion here still passed. These assertions are on the ARGUMENTS the page hands
	 * the SDK, the only place that scope exists.
	 */
	describe('import-log query scope', () => {

		const importLogQueryCall = () => {
			const call = frappeSDKMock.useFrappeGetDocList.mock.calls
				.find(([doctype]) => doctype === IMPORT_LOG_DOCTYPE)

			if (!call) {
				throw new Error('The page issued no import-log list query')
			}

			return call
		}

		it("asks only for the selected account's logs, newest first, ten at a time", () => {
			renderImporter({ logs: ALL_LOGS })

			const [, args] = importLogQueryCall()

			expect(args?.filters).toEqual([['bank_account', '=', SELECTED_BANK.name]])
			// Exactly the eight fields the row renders — no `password`-bearing or unrelated field is
			// fetched "just in case".
			expect(args?.fields).toEqual([
				'name',
				'file',
				'status',
				'number_of_transactions',
				'start_date',
				'end_date',
				'closing_balance',
				'creation'
			])
			expect(args?.orderBy).toEqual({ field: 'creation', order: 'desc' })
			expect(args?.limit).toBe(10)
		})

		it('scopes the query to whichever account is selected, not to a fixed one', () => {
			const secondBank = makeSelectedBank({
				name: 'Second Bank - Test Company',
				account_name: 'Second Bank Savings'
			})

			renderImporter({ logs: [], selectedBank: secondBank })

			const [, args] = importLogQueryCall()

			expect(args?.filters).toEqual([['bank_account', '=', 'Second Bank - Test Company']])
			expect(args?.filters).not.toEqual([['bank_account', '=', SELECTED_BANK.name]])
		})

		it('asks nothing at all until an account has been selected', () => {
			renderImporter({ logs: ALL_LOGS, withSelectedBank: false })

			expect(
				frappeSDKMock.useFrappeGetDocList.mock.calls
					.filter(([doctype]) => doctype === IMPORT_LOG_DOCTYPE)
			).toHaveLength(0)
		})

		it('does not revalidate the list on window focus', () => {
			renderImporter({ logs: ALL_LOGS })

			const [, , , options] = importLogQueryCall()

			expect(options).toEqual({ revalidateOnFocus: false })
		})
	})

	describe('per-row status chip (FM2)', () => {

		/*
		 * The chip has three states and only two of them come from the document: `status` offers exactly
		 * `Not Started` and `Completed` and the DocType carries no error field, so a failed import - which
		 * rolls back - leaves the row indistinguishable from one merely waiting. The third state is driven
		 * from the failure the import step observed, keyed by import-log name in a shared session atom.
		 */

		it("renders the server's own status when the import completed", () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const badge = statusBadgeIn(rowFor(COMPLETED_LOG))

			expect(badge).toHaveAttribute('data-theme', 'green')
			expect(badge).toHaveTextContent('Completed')
		})

		it('renders the raw server status for a log the client has observed nothing about', () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const badge = statusBadgeIn(rowFor(NOT_STARTED_LOG))

			expect(badge).toHaveAttribute('data-theme', 'gray')
			expect(badge).toHaveTextContent('Not Started')
			expect(badge).not.toHaveTextContent('Failed')
		})

		it('marks a log the server refused as Failed', () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const badge = statusBadgeIn(rowFor(FAILED_LOG))

			expect(badge).toHaveAttribute('data-theme', 'red')
			expect(badge).toHaveTextContent('Failed')
			expect(badge).not.toHaveTextContent('Not Started')
		})

		it('marks each refused log from its own entry', () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			for (const log of [FAILED_LOG, INDETERMINATE_LOG]) {
				const badge = statusBadgeIn(rowFor(log))

				expect(badge).toHaveAttribute('data-theme', 'red')
				expect(badge).toHaveTextContent('Failed')
			}

			expect(statusBadgeIn(rowFor(COMPLETED_LOG))).toHaveTextContent('Completed')
			expect(statusBadgeIn(rowFor(NOT_STARTED_LOG))).toHaveTextContent('Not Started')
		})

		it('leaves rows with no marker untouched', () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const unmarked = statusBadgeIn(rowFor(NOT_STARTED_LOG))

			expect(unmarked).not.toHaveAttribute('data-theme', 'red')
			expect(unmarked).toHaveAttribute('data-theme', 'gray')
		})


		it('ignores a marker recorded against a log this list did not return', () => {
			renderImporter({
				logs: [NOT_STARTED_LOG],
				markers: makeImportFailures(
					makeBankStatementImportLog({
						name: 'l9d1c4f7ba',
						bank_account: 'Second Bank - Test Company'
					}),
					'The bank account is disabled. Please enable it'
				)
			})

			expect(statusBadgeIn(rowFor(NOT_STARTED_LOG))).toHaveAttribute('data-theme', 'gray')
			expect(screen.queryByText('Failed')).not.toBeInTheDocument()
		})


		it('leaves a still-applicable marker exactly as it found it', async () => {
			const markers = makeImportFailures(FAILED_LOG, FAILED_LOG_MESSAGE)
			const { store } = renderImporter({ logs: ALL_LOGS, markers })

			expect(statusBadgeIn(rowFor(FAILED_LOG))).toHaveTextContent('Failed')

			// The server still reports this log as `Not Started`, so nothing has overtaken the marker and
			// the identical object survives - no needless re-render of every consumer.
			await waitFor(() => {
				expect(store.get(bankRecImportFailuresAtom)).toBe(markers)
			})
			expect(Object.keys(store.get(bankRecImportFailuresAtom))).toEqual([FAILED_LOG.name])
		})

		/*
		 * A MARKER IS SUBORDINATE TO THE SERVER. It records what one request did; `status` records what
		 * the server persisted. A log that failed once and then imported cleanly - directly, from another
		 * tab, or from the Desk - comes back `Completed`, and the session marker must not go on
		 * contradicting that for the rest of the session.
		 */
		describe('an authoritative Completed outranks a stale marker', () => {
			const staleMarkerOnCompletedLog = makeImportFailures(COMPLETED_LOG, FAILED_LOG_MESSAGE)

			it('renders Completed, not Failed', () => {
				renderImporter({ logs: ALL_LOGS, markers: staleMarkerOnCompletedLog })

				const badge = statusBadgeIn(rowFor(COMPLETED_LOG))

				expect(badge).toHaveAttribute('data-theme', 'green')
				expect(badge).toHaveTextContent('Completed')
				expect(badge).not.toHaveTextContent('Failed')
			})

			it('retires the overtaken marker instead of keeping it for the session', async () => {
				const { store } = renderImporter({ logs: ALL_LOGS, markers: staleMarkerOnCompletedLog })

				await waitFor(() => {
					expect(store.get(bankRecImportFailuresAtom)).toEqual({})
				})
			})

			it('retires only the overtaken entry, leaving every still-valid marker in place', async () => {
				const { store } = renderImporter({
					logs: ALL_LOGS,
					markers: { ...ATTEMPT_MARKERS, ...staleMarkerOnCompletedLog }
				})

				await waitFor(() => {
					expect(Object.keys(store.get(bankRecImportFailuresAtom)).sort()).toEqual(
						[FAILED_LOG.name, INDETERMINATE_LOG.name].sort()
					)
				})
				expect(statusBadgeIn(rowFor(FAILED_LOG))).toHaveTextContent('Failed')
				expect(statusBadgeIn(rowFor(INDETERMINATE_LOG))).toHaveTextContent('Failed')
				expect(statusBadgeIn(rowFor(COMPLETED_LOG))).toHaveTextContent('Completed')
			})

			it('keeps a marker for a log outside this page of results, which is evidence of nothing', async () => {
				const offListMarker = makeImportFailures(
					makeBankStatementImportLog({ name: 'BSIL-2023-09999' }),
					FAILED_LOG_MESSAGE
				)
				const { store } = renderImporter({ logs: [COMPLETED_LOG], markers: offListMarker })

				await waitFor(() => {
					expect(statusBadgeIn(rowFor(COMPLETED_LOG))).toHaveTextContent('Completed')
				})
				expect(Object.keys(store.get(bankRecImportFailuresAtom))).toEqual(['BSIL-2023-09999'])
			})

			it('prunes nothing while the list has not arrived', async () => {
				const { store } = renderImporter({ logs: undefined, markers: staleMarkerOnCompletedLog })

				// `data: undefined` is indistinguishable from an empty list in this component, so an
				// unguarded prune would discard every marker before any evidence existed.
				await waitFor(() => {
					expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
				})
				expect(store.get(bankRecImportFailuresAtom)).toEqual(staleMarkerOnCompletedLog)
			})
		})
	})

	describe('empty state', () => {

		it('invites a first import when the account has none', () => {
			renderImporter({ logs: [] })

			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})

		it('reaches the same branch before the list has arrived', () => {
			renderImporter({ logs: undefined })

			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})

	describe('list query rejection', () => {

		it("renders the server's message from a _server_messages envelope", () => {
			const message = 'You are not permitted to read Bank Statement Import Log.'

			renderImporter({ listError: makeServerMessagesError(message) })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()
			expect(screen.getByText('There was an error.')).toBeInTheDocument()
		})

		it("renders the server's message from an _error_message envelope", () => {
			const message = 'The linked bank account has been disabled.'

			renderImporter({ listError: makeErrorMessageError(message) })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()
		})

		/**
		 * Severity is the SERVER'S decision: the banner themes on the indicator the server sent and
		 * makes no judgement of its own. The theme lives in the class list only for `Alert`, which
		 * is why this one assertion reads a token class rather than a data attribute.
		 */
		it("takes severity from the server's own indicator", () => {
			const { unmount } = renderImporter({
				listError: makeWarningServerMessagesError('The statement covers a closed period.')
			})
			expect(screen.getByRole('alert')).toHaveClass('text-ink-amber-3')
			unmount()

			renderImporter({ listError: makeServerMessagesError('Permission denied.') })
			expect(screen.getByRole('alert')).toHaveClass('text-ink-red-3')
		})

		it('reports the rejection without claiming the account has imports', () => {
			renderImporter({ listError: makeServerMessagesError('Permission denied.') })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})

	describe('shared error dialog mount', () => {

		it('is inert while the shared atom holds no error', () => {
			renderImporter({ logs: ALL_LOGS })

			expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull()
		})

		/**
		 * The dialog is PORTALED to `document.body`, outside the container `render` returns, so it
		 * is queried through `screen`.
		 */
		it("shows the server's own words once the shared atom carries an error", () => {
			const message = 'The statement could not be imported because the file is empty.'

			renderImporter({ logs: ALL_LOGS, dialogError: makeServerMessagesError(message) })

			const dialog = screen.getByRole('alertdialog')

			expect(dialog).toBeInTheDocument()
			expect(within(dialog).getByText(message)).toBeInTheDocument()
			expect(within(dialog).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
		})

		it('dismisses without disturbing the list behind it', async () => {
			renderImporter({
				logs: [COMPLETED_LOG],
				dialogError: makeServerMessagesError('The statement could not be imported.')
			})

			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})

			expect(statusBadgeIn(rowFor(COMPLETED_LOG))).toHaveTextContent('Completed')
		})
	})

	describe('statement upload', () => {

		it('enables upload once a statement has been chosen', async () => {
			const { container } = renderImporter({ logs: [] })

			expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()

			await chooseStatementFile(container, csvStatementFile())

			expect(screen.getByText('hdfc-statement-jan-2024.csv')).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()
		})

		it('opens the new import log once the server has created it', async () => {
			const createdLog = makeBankStatementImportLog({ name: 'BSIL-2024-00009' })

			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(createdLog)

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(await screen.findByText(detailViewFor('BSIL-2024-00009'))).toBeInTheDocument()
			expect(screen.queryByText(detailViewFor('undefined'))).not.toBeInTheDocument()
		})

		it("repeats the server's refusal of the upload, in its own words", () => {
			const message = 'The uploaded statement contains no transactions.'

			renderImporter({ logs: [], uploadError: makeServerMessagesError(message) })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()

			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
			expect(frappeCreateDoc).not.toHaveBeenCalled()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		it("repeats the server's refusal to create the log", () => {
			const message = 'Not permitted to create Bank Statement Import Log.'

			installCreateDocError(makeServerMessagesError(message))
			renderImporter({ logs: [] })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		it("repeats the server's refusal to store the statement passphrase", () => {
			const message = 'Not permitted to update Bank Account.'

			installUpdateDocError(makeServerMessagesError(message))
			renderImporter({ logs: [] })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()
		})

		it("takes the upload banner's severity from the server's own indicator", () => {
			renderImporter({
				logs: [],
				uploadError: makeWarningServerMessagesError('The statement covers a closed period.')
			})

			expect(screen.getByRole('alert')).toHaveClass('text-ink-amber-3')
		})
	})

	/* ── Refusals that happen before any import log exists ──────────────────────────── */

	/*
	 * FM2's EMPTY / MALFORMED FILE PATH, END TO END, ON THE SURFACE WHERE IT ACTUALLY HAPPENS.
	 *
	 * `Bank Statement Import Log` parses the statement in `before_insert` - `get_data` for spreadsheets,
	 * `prepare_pdf_tables` for PDFs - so an empty file, an unreadable one, a wrong file type, a
	 * password-protected PDF without its password, or a PDF with no detectable tables is refused DURING
	 * CREATION. No import log is written, so there is no detail screen to show the error on and no row
	 * to hang a Failed badge from. The upload form is the only place the reviewer can be told.
	 *
	 * The tests above install the create hook's `error` MEMBER, which renders the inline banner. These
	 * drive the actual promise REJECTION, which is a different path: before it was handled the rejection
	 * was unhandled and the reviewer was left looking at an apparently idle form.
	 */
	describe('a statement the server cannot read is refused before any log exists (FM2)', () => {

		const REFUSAL = 'No tables found in the PDF file'

		const refuseCreation = async (
			error: FrappeErrorFixture = makeServerMessagesError(REFUSAL),
			file: File = csvStatementFile()
		) => {
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockRejectedValue(error)
			installCreateDocError(error)

			const rendered = renderImporter({ logs: [] })
			await chooseStatementFile(rendered.container, file)
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			return { ...rendered, error }
		}

		it("reports the server's own words in the shared dismissible dialog", async () => {
			await refuseCreation()

			const dialog = await screen.findByRole('alertdialog')

			expect(within(dialog).getByText(REFUSAL)).toBeInTheDocument()
			expect(within(dialog).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
		})

		it('hands the rejection to the dialog UNMODIFIED, so the shared parser sees Frappe\'s envelope', async () => {
			const { store, error } = await refuseCreation()

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBe(error)
			})
		})

		it('records NO failure marker, because no import log was created to key one against', async () => {
			const { store } = await refuseCreation()

			await screen.findByRole('alertdialog')
			expect(store.get(bankRecImportFailuresAtom)).toEqual({})
		})

		it('claims no success: no detail view is opened, and the form is usable again once dismissed', async () => {
			await refuseCreation()

			await screen.findByRole('alertdialog')
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()

			// The dialog is modal, so Radix hides the form from the accessibility tree while it is open -
			// the control is only assertable after dismissal, which is also when the reviewer can retry.
			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})
			expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		it('raises the transient toast as well - the dialog is additive, not a replacement', async () => {
			await refuseCreation()

			await screen.findByRole('alertdialog')
			expect(toastError).toHaveBeenCalledWith('The bank statement could not be uploaded.')
			expect(toastSuccess).not.toHaveBeenCalled()
		})

		it('keeps the inline banner too, so the message survives dismissing the dialog', async () => {
			await refuseCreation()

			await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})
			expect(screen.getByRole('alert')).toHaveTextContent(REFUSAL)
		})

		it('creates nothing client-side: the refusal wrote no transactions and no log', async () => {
			await refuseCreation()

			await screen.findByRole('alertdialog')
			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).toHaveBeenCalledWith(IMPORT_LOG_DOCTYPE, expect.any(Object))
			// The list is still the server's, unchanged: no optimistic row was invented for the attempt.
			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})

		it('surfaces a refusal that arrives in _error_message rather than _server_messages', async () => {
			const message = 'The uploaded file is empty.'
			await refuseCreation(makeErrorMessageError(message))

			expect(within(await screen.findByRole('alertdialog')).getByText(message)).toBeInTheDocument()
		})

		/*
		 * The FIRST link can be the one to refuse it. The framework's own `File.before_insert` runs
		 * `check_content` -> `pdf_contains_js`, so a file claiming to be a PDF that is not one is
		 * rejected by `upload_file` itself and `createDoc` is never reached. Verified against the real
		 * server, which answers that case with HTTP 500 from `pypdf`.
		 */
		it('reports a refusal from the UPLOAD leg, before creation is even attempted', async () => {
			const message = 'Stream has ended unexpectedly'
			const error = makeServerMessagesError(message)

			frappeFileUpload.mockRejectedValue(error)
			installFileUploadError(error)

			const { container, store } = renderImporter({ logs: [] })
			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			const dialog = await screen.findByRole('alertdialog')
			expect(within(dialog).getByText(message)).toBeInTheDocument()

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBe(error)
			})
			// The chain stopped at the first link: nothing was created and nothing was navigated to.
			expect(frappeCreateDoc).not.toHaveBeenCalled()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
			expect(store.get(bankRecImportFailuresAtom)).toEqual({})
		})

		it('handles the rejection, leaving no unhandled promise behind', async () => {
			const unhandled = vi.fn<(event: PromiseRejectionEvent) => void>()
			window.addEventListener('unhandledrejection', unhandled)

			try {
				await refuseCreation()
				await screen.findByRole('alertdialog')
				// One microtask turn past the point the chain settles.
				await Promise.resolve()

				expect(unhandled).not.toHaveBeenCalled()
			} finally {
				window.removeEventListener('unhandledrejection', unhandled)
			}
		})
	})

	describe('page shell', () => {

		it('asks for a company and a bank account before anything else', () => {
			renderImporter({ logs: [] })

			expect(screen.getByText('Company')).toBeInTheDocument()
			expect(screen.getByText('Bank Account')).toBeInTheDocument()
		})

		it('offers the statement dropzone once an account is selected', () => {
			renderImporter({ logs: [] })

			expect(screen.getByText('Bank Statement')).toBeInTheDocument()
			expect(screen.getByText('Drop a file here, or click to select a file')).toBeInTheDocument()
		})

		it('keeps upload unavailable until a file has been chosen', () => {
			renderImporter({ logs: [] })

			expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()
		})

		it('explains the expected statement columns on request', async () => {
			renderImporter({ logs: [] })

			await userEvent.click(screen.getByRole('button', { name: 'View Instructions' }))

			const instructions = screen.getByRole('dialog')

			expect(within(instructions).getByText('Statement Import Instructions')).toBeInTheDocument()
			expect(within(instructions).getByText('Column Name')).toBeInTheDocument()
			expect(within(instructions).getByText('Maps To')).toBeInTheDocument()
		})

		it('withholds the list and the dropzone until an account is selected', () => {
			renderImporter({ logs: ALL_LOGS, withSelectedBank: false })

			expect(screen.queryByText('Previous Imports')).not.toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
			expect(screen.queryByText('Bank Statement')).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()
		})
	})

	/*
	 * This page carries NO client-side role gate, and that is correct rather than a gap: authorisation
	 * belongs to the server, and a UI that hid a control would be a convenience rather than a control.
	 *
	 * So a frontend suite can prove exactly two things here. First, that a narrowed profile really is
	 * denied by `src/lib/permissions.ts` rather than uniformly granted - without which every other
	 * suite's privileged profile would be an unexamined assumption. The narrowing is written directly
	 * onto `window.frappe.boot.user`, the only thing those helpers read, and this block restores it after
	 * every test. Second, that this page is FAIL-CLOSED when the server refuses under such a profile.
	 *
	 * What it cannot prove is that the server refuses: the SDK is mocked here, so a refusal is something
	 * these tests INSTALL rather than discover.
	 */
	describe('negative authorisation', () => {

		const narrowProfileTo = (rights: Partial<Record<'can_read' | 'can_write' | 'can_create' | 'can_delete' | 'can_cancel', string[]>>) => {
			Object.assign(window.frappe.boot.user, rights)
		}

		/**
		 * Those arrays are shared, mutable state reachable through a global, so this block restores
		 * what it narrowed instead of relying on the harness to rebuild the profile. The snapshot is
		 * taken per test and the captured arrays are put back by identity, which is what keeps the
		 * narrowing local to the test that applied it - and what keeps the positive control below
		 * genuinely a control.
		 */
		const NARROWED_RIGHTS = ['can_read', 'can_write', 'can_create', 'can_delete', 'can_cancel'] as const
		let installedRights: Partial<Record<(typeof NARROWED_RIGHTS)[number], string[]>> = {}

		beforeEach(() => {
			installedRights = {}
			NARROWED_RIGHTS.forEach((right) => {
				installedRights[right] = window.frappe.boot.user[right]
			})
		})

		afterEach(() => {
			Object.assign(window.frappe.boot.user, installedRights)
		})

		const ACCOUNTS_ONLY = {
			can_read: ['Bank Transaction', 'Bank Account', 'Payment Entry', 'Journal Entry'],
			can_write: ['Bank Transaction', 'Bank Account', 'Payment Entry', 'Journal Entry'],
			can_create: ['Bank Transaction', 'Bank Account', 'Payment Entry', 'Journal Entry'],
			can_delete: ['Bank Transaction', 'Bank Account', 'Payment Entry', 'Journal Entry']
		}

		it('denies the import log to an accounting-only profile that still holds its own rights', () => {
			narrowProfileTo(ACCOUNTS_ONLY)

			expect(canReadDocument(IMPORT_LOG_DOCTYPE)).toBe(false)
			expect(canWriteDocument(IMPORT_LOG_DOCTYPE)).toBe(false)
			expect(canCreateDocument(IMPORT_LOG_DOCTYPE)).toBe(false)
			expect(canDeleteDocument(IMPORT_LOG_DOCTYPE)).toBe(false)

			// Non-vacuous: the profile is narrowed, not empty.
			expect(canReadDocument('Bank Transaction')).toBe(true)
		})

		it('denies by default when no role is held at all', () => {
			narrowProfileTo({ can_read: [], can_write: [], can_create: [], can_delete: [] })

			expect(canReadDocument(IMPORT_LOG_DOCTYPE)).toBe(false)
			expect(canReadDocument('Bank Transaction')).toBe(false)
			expect(canReadDocument('Bank Account')).toBe(false)
		})

		it('grants the import log under the harness profile, which is the positive control', () => {
			// The positive control for the two above: if this failed, "denied" would prove nothing. No
			// narrowing is applied, so this is the profile every other test in this file runs under.

			expect(canReadDocument(IMPORT_LOG_DOCTYPE)).toBe(true)
			expect(canCreateDocument(IMPORT_LOG_DOCTYPE)).toBe(true)
		})

		it('is FAIL-CLOSED when the server refuses the log LIST under a narrowed profile', async () => {
			narrowProfileTo(ACCOUNTS_ONLY)

			renderImporter({ logs: [], listError: makeServerMessagesError('Insufficient Permission for Bank Statement Import Log') })

			expect(await screen.findByText(/Insufficient Permission/)).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})
})
