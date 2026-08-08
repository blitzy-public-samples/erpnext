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
	frappeContextValue,
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
	makeTransportFailureError,
	makeWarningServerMessagesError,
	TEST_ALTERNATE_CURRENCY,
	TEST_CURRENCY,
	TRANSPORT_FAILURE_MESSAGE
} from '@/test/factories'
import { formatCurrency } from '@/lib/numbers'

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
import { formatDate } from '@/lib/date'
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

/**
 * The date text the row renders, which is also the accessible name of the link to the import's detail
 * page. Formatted through the app's own helper so the expectation cannot drift from the rendering.
 */
const displayedDate = (log: BankStatementImportLog): string =>
	formatDate(log.creation, 'Do MMM YYYY')

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
		// Every upload attempt ends by discarding the placeholder attachment, on both endings, so the
		// operation is configured for the whole suite rather than per test.
		frappeContextValue.db.deleteDoc.mockResolvedValue({ message: 'ok' } as never)
	})

	describe('previous imports list (TC1)', () => {

		it('renders one row per log the server returned, in the order it returned them', () => {
			renderImporter({ logs: ALL_LOGS })

			expect(screen.getByText('Previous Imports')).toBeInTheDocument()

			// Scoped to the table, because the bank picker renders a link of its own when the
			// account list is empty — a document-wide link query would collect that too.
			const table = within(screen.getByRole('table'))

			expect(table.getAllByRole('row')).toHaveLength(ALL_LOGS.length + 1)

			/*
			 * Narrowed to the FILE links. Each row now carries two: the imported-on date links to the
			 * detail page - which is what makes the row's action reachable from a keyboard, since a `tr`
			 * cannot honestly be a button - and the filename links to the stored file itself. Only the
			 * latter opens in a new tab, which is what distinguishes them here.
			 */
			const renderedFileNames = table
				.getAllByRole('link')
				.filter((link) => link.getAttribute('target') === '_blank')
				.map((link) => link.textContent)

			expect(renderedFileNames).toEqual(ALL_LOGS.map(displayedFileName))
		})

		it('reaches each import from the keyboard, not by clicking the row alone', () => {
			// The row's own click handler is a pointer convenience. Before this the detail page had no
			// keyboard path at all: no focusable element in the row led to it.
			renderImporter({ logs: [COMPLETED_LOG] })

			const dateLink = screen.getByRole('link', {
				name: displayedDate(COMPLETED_LOG)
			})

			expect(dateLink).toHaveAttribute('href', `${IMPORTER_ROUTE}/${COMPLETED_LOG.name}`)
		})

		it('keeps the filename readable rather than letting it stretch the row', () => {
			/*
			 * Bank portals export long, sometimes mixed-script filenames. An unconstrained one widened the
			 * row until the columns before it were unreadable, so from `md` up it is capped and truncated
			 * on one line - and the whole name is still available, in `title`.
			 *
			 * Below `md` it wraps instead, and both halves of that are asserted: `break-all` on the link,
			 * which is what gives the column a min-content width of one character so the table's auto
			 * layout can shrink it to whatever the date and status leave over, and `whitespace-normal` on
			 * the cell, without which the primitive's default `whitespace-nowrap` would forbid the wrap.
			 * Measured in a real browser, the 12rem cap alone left the column 49px wider than the pane at
			 * 390px, which put the filename off the edge of a scroll container nobody knew to scroll.
			 */
			const longName = 'HDFC-Bank-Statement-01-04-2024-to-30-04-2024-account-50100XXXXXX987.csv'
			const log = makeBankStatementImportLog({
				name: 'BSIL-2024-01111',
				file: `/private/files/${longName}`
			})

			renderImporter({ logs: [log] })

			const fileLink = screen.getByRole('link', { name: longName })

			expect(fileLink).toHaveAttribute('title', longName)
			// Capped and single-line from `md` up.
			expect(fileLink.className).toContain('md:truncate')
			expect(fileLink.className).toMatch(/md:max-w-/)
			// Shrinkable and wrapping below it - no unprefixed cap, so nothing forces the column wide.
			expect(fileLink.className).toContain('break-all')
			expect(fileLink.className).not.toMatch(/(^|\s)max-w-/)
			expect(fileLink.className).not.toMatch(/(^|\s)truncate/)

			const fileCell = fileLink.closest('td')
			expect(fileCell).not.toBeNull()
			expect(fileCell?.className).toContain('whitespace-normal')
		})

		it('keeps the three identifying columns at every width and defers the three quantifying ones', () => {
			/*
			 * jsdom applies no stylesheet, so which columns are VISIBLE at 390px cannot be measured here -
			 * that is measured in a real browser. What is pinned is the ranking itself: six columns of
			 * non-wrapping text do not fit a narrow pane, and the browser resolved that by pushing the FILE
			 * column - the one thing identifying which statement a row is - off the edge of a scroll
			 * container nobody knew to scroll. Imported On, Status and File are unconditional; the three
			 * that merely quantify the import wait for room.
			 */
			renderImporter({ logs: [COMPLETED_LOG] })

			const headers = screen.getAllByRole('columnheader')
			const deferred = headers.filter((header) => header.className.includes('hidden'))

			expect(deferred.map((header) => header.textContent)).toEqual([
				'Transaction Dates',
				'Number of Transactions',
				'Closing Balance'
			])
			expect(deferred.every((header) => header.className.includes('md:table-cell'))).toBe(true)

			for (const label of ['Imported On', 'Status', 'File']) {
				const header = headers.find((candidate) => candidate.textContent === label)
				expect(header?.className).not.toContain('hidden')
			}
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
			// Exactly the nine fields the row renders — no `password`-bearing or unrelated field is
			// fetched "just in case". `currency` earns its place because the Closing Balance cell formats
			// money with each statement's OWN currency; omitting it made that column fall back to the
			// company/browser default, so a foreign-currency statement showed the right number under the
			// wrong symbol.
			expect(args?.fields).toEqual([
				'name',
				'file',
				'status',
				'number_of_transactions',
				'start_date',
				'end_date',
				'closing_balance',
				'currency',
				'creation'
			])
			expect(args?.orderBy).toEqual({ field: 'creation', order: 'desc' })
			expect(args?.limit).toBe(10)
		})

		it("formats each log's Closing Balance in that log's OWN currency", () => {
			/*
			 * This list can mix accounts, and the cell used to be formatted with no currency at all - so it
			 * fell back to the company/browser default and a foreign-currency statement showed the right
			 * number under the wrong symbol. The detail screen formats the same value from the same field
			 * and got it right, which is what made the two screens contradict each other.
			 *
			 * Two logs in DIFFERENT currencies are rendered together, because a single-currency assertion
			 * cannot tell a per-row value apart from a constant.
			 */
			const homeCurrencyLog = makeBankStatementImportLog({
				name: 'BSIL-2024-00010',
				file: '/files/home-currency.csv',
				closing_balance: 1000,
				currency: TEST_CURRENCY
			})
			const foreignCurrencyLog = makeBankStatementImportLog({
				name: 'BSIL-2024-00011',
				file: '/files/foreign-currency.csv',
				closing_balance: 1111.11,
				currency: TEST_ALTERNATE_CURRENCY
			})

			renderImporter({ logs: [homeCurrencyLog, foreignCurrencyLog] })

			expect(rowFor(homeCurrencyLog).textContent)
				.toContain(formatCurrency(1000, TEST_CURRENCY))
			expect(rowFor(foreignCurrencyLog).textContent)
				.toContain(formatCurrency(1111.11, TEST_ALTERNATE_CURRENCY))

			// And the two are genuinely different renderings, not the same string twice.
			expect(formatCurrency(1111.11, TEST_ALTERNATE_CURRENCY))
				.not.toBe(formatCurrency(1111.11, TEST_CURRENCY))
		})

		it('labels each closing balance in the currency that statement was imported in', () => {
			// The same guarantee as above, pinned against a LITERAL rendering rather than against the
			// formatter, so the two cannot drift together: a statement carries its own currency, which
			// need not be the company's, and formatting the balance without it printed the company symbol
			// against another currency's number - the right figure under the wrong label, on the very row
			// that leads to the detail view where the same mislabelling was already corrected.
			const usdLog = makeBankStatementImportLog({
				name: 'BSIL-2024-00009',
				file: '/files/chase-statement-jan-2024.csv',
				status: 'Completed',
				creation: '2024-01-20 11:00:00.000000',
				number_of_transactions: 3,
				closing_balance: 1234.5,
				currency: 'USD'
			})

			renderImporter({ logs: [usdLog] })

			const row = screen.getByText('chase-statement-jan-2024.csv').closest('tr')
			expect(row).not.toBeNull()
			expect(row).toHaveTextContent('$ 1,234.50')
			expect(row).not.toHaveTextContent('\u20b9')
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

			/*
			 * The server still reports this log as `Not Started`, so nothing has overtaken the marker and
			 * it survives intact.
			 *
			 * By VALUE rather than by reference, and the reason is worth stating: the atom is backed by
			 * session storage so that a refusal survives a reload, and `atomWithStorage` re-reads the
			 * stored JSON when the atom mounts - which yields an equal but freshly parsed object. That one
			 * extra commit on mount is inherent to every persisted atom in this store (the selected bank,
			 * the date range, the action log), and what matters here is that the prune left the marker's
			 * CONTENT alone.
			 */
			await waitFor(() => {
				expect(store.get(bankRecImportFailuresAtom)).toEqual(markers)
			})
			expect(Object.keys(store.get(bankRecImportFailuresAtom))).toEqual([FAILED_LOG.name])
		})

		/*
		 * A MARKER OUTLIVES THE PAGE THAT RECORDED IT.
		 *
		 * This is the whole of the finding. `Bank Statement Import Log` has no error field, offers only
		 * `Not Started` and `Completed`, and a refused import rolls back - so the server persists nothing
		 * about the refusal and reports the row as one nobody has tried yet. A marker held only in memory
		 * therefore disappeared the moment the reviewer navigated away or reloaded, and they came back to a
		 * row that looked untouched with no way to learn otherwise.
		 *
		 * Session storage rather than local storage: an observation about a request belongs to the sitting
		 * that made it. Surviving a reload and a navigation is the requirement; surviving a browser restart
		 * days later would be asserting something about a file nobody remembers uploading.
		 */
		describe('durability', () => {

			const STORAGE_KEY = 'bank-rec-import-failures'

			it('still marks the import Failed after the page is reloaded', async () => {
				const markers = makeImportFailures(FAILED_LOG, FAILED_LOG_MESSAGE)
				const first = renderImporter({ logs: ALL_LOGS, markers })

				expect(statusBadgeIn(rowFor(FAILED_LOG))).toHaveTextContent('Failed')

				// A fresh store with nothing seeded into it is exactly what a reload produces: the atom's
				// only remaining source is what the previous page left behind.
				first.unmount()
				renderImporter({ logs: ALL_LOGS })

				await waitFor(() => {
					expect(statusBadgeIn(rowFor(FAILED_LOG))).toHaveTextContent('Failed')
				})
			})

			it('writes the refusal to session storage under its own key', () => {
				renderImporter({
					logs: ALL_LOGS,
					markers: makeImportFailures(FAILED_LOG, FAILED_LOG_MESSAGE)
				})

				const stored = sessionStorage.getItem(STORAGE_KEY)

				expect(stored).not.toBeNull()
				expect(JSON.parse(stored ?? '{}')).toHaveProperty(FAILED_LOG.name)
			})

			it('keeps the server\'s own words in the stored record, so a reloaded page can still say why', () => {
				renderImporter({
					logs: ALL_LOGS,
					markers: makeImportFailures(FAILED_LOG, FAILED_LOG_MESSAGE)
				})

				// The raw Frappe rejection is a plain object of primitives, so it round-trips through JSON
				// intact - which is what lets a reloaded marker render through the same shared error path as
				// a live one instead of degrading to a bare "something failed".
				const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')

				expect(JSON.stringify(stored[FAILED_LOG.name])).toContain(FAILED_LOG_MESSAGE)
			})

			it('leaves the server traceback out of storage, and keeps everything the reviewer reads', () => {
				/*
				 * A site running with `developer_mode` on returns its whole Python traceback on `exc` -
				 * stack frames, module paths, absolute filesystem paths. Nothing renders it: the shared
				 * parser reads `_server_messages`, `_error_message`, `exception`, `httpStatus` and
				 * `message`, so persisting `exc` put a traceback into browser storage for no reader.
				 * What the reviewer actually sees has to survive the round trip unchanged, which is the
				 * second half of this assertion and the reason the field is dropped rather than the
				 * record being reduced to a flag.
				 */
				const TRACEBACK = [
					'Traceback (most recent call last):',
					'  File "apps/frappe/frappe/app.py", line 114, in application',
					'  File "apps/erpnext/erpnext/accounts/doctype/bank_statement_import_log/bank_statement_import_log.py", line 489'
				].join('\n')

				renderImporter({
					logs: ALL_LOGS,
					markers: {
						[FAILED_LOG.name]: makeServerMessagesError(FAILED_LOG_MESSAGE, { exc: TRACEBACK })
					}
				})

				const raw = sessionStorage.getItem(STORAGE_KEY) ?? ''

				expect(raw).not.toContain('Traceback')
				expect(raw).not.toContain('apps/frappe')
				expect(raw).not.toContain('apps/erpnext')
				expect(JSON.parse(raw)[FAILED_LOG.name]).not.toHaveProperty('exc')

				// The reviewer-facing half, unchanged: the server's own sentence, its severity, and the
				// status the marker is keyed to.
				expect(raw).toContain(FAILED_LOG_MESSAGE)
				expect(JSON.parse(raw)[FAILED_LOG.name]).toMatchObject({
					httpStatus: 417,
					exc_type: 'ValidationError'
				})
				expect(statusBadgeIn(rowFor(FAILED_LOG))).toHaveTextContent('Failed')
			})

			it('does not confuse an import log NAMED exc with a traceback', () => {
				// The map's own keys are import-log names, and the log names are server-generated hashes,
				// so `exc` is a name a log can have. Dropping the field by key alone would take that whole
				// marker with it; only the string field is a traceback.
				const oddlyNamedLog = makeBankStatementImportLog({
					name: 'exc',
					file: '/files/oddly-named.csv',
					status: 'Not Started',
					number_of_transactions: 0,
					closing_balance: 0
				})

				renderImporter({
					logs: [...ALL_LOGS, oddlyNamedLog],
					markers: makeImportFailures(oddlyNamedLog, FAILED_LOG_MESSAGE)
				})

				expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')).toHaveProperty('exc')
				expect(statusBadgeIn(rowFor(oddlyNamedLog))).toHaveTextContent('Failed')
			})

			it('does not outlive the sitting - nothing is written to local storage', () => {
				renderImporter({
					logs: ALL_LOGS,
					markers: makeImportFailures(FAILED_LOG, FAILED_LOG_MESSAGE)
				})

				expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
			})

			it('retires an overtaken marker from storage too, so a reload cannot resurrect it', async () => {
				// Persistence must not defeat the server's authority: if the prune only cleared memory, the
				// next load would read the stale marker straight back out of storage.
				renderImporter({
					logs: ALL_LOGS,
					markers: makeImportFailures(COMPLETED_LOG, FAILED_LOG_MESSAGE)
				})

				await waitFor(() => {
					expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({})
				})
			})
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

	/* ── The banners the reviewer can put away, and the failure nobody phrased ──────── */

	/*
	 * Two defects the QA report caught on ONE screen.
	 *
	 * The banners are fed by the three SDK hooks' own `error` members, which each hold their value
	 * until that hook is called again. A refusal therefore stayed on the page with no way to clear it:
	 * the reviewer could change the file, change the account, dismiss the dialog, and still be reading
	 * the previous attempt's banner with no control to remove it.
	 *
	 * And when the failure is a TRANSPORT one - the request never reaching the server - the SDK's own
	 * handler throws while handling it, because it spreads `error.response.data` without checking that
	 * a response exists. The rejection the page receives is that internal `TypeError`, and its text
	 * ("Cannot read properties of undefined (reading 'data')") was shown TWICE for one failure: in the
	 * dialog and in the banner. Both render through the shared parser, so both are fixed at once, and
	 * these tests assert it on the surface where the reviewer met it.
	 */
	describe('an upload that never reaches the server, and putting the message away', () => {

		/** Drives the transport failure through the real chain: upload rejects, hook exposes the error. */
		const abortUpload = async (error: FrappeErrorFixture = makeTransportFailureError()) => {
			frappeFileUpload.mockRejectedValue(error)
			installFileUploadError(error)

			const rendered = renderImporter({ logs: [] })
			await chooseStatementFile(rendered.container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			return rendered
		}

		it('never shows the SDK\'s internal message, in the dialog or in the banner', async () => {
			await abortUpload()

			const dialog = await screen.findByRole('alertdialog')
			expect(dialog).not.toHaveTextContent(TRANSPORT_FAILURE_MESSAGE)
			expect(screen.getByRole('alert')).not.toHaveTextContent(TRANSPORT_FAILURE_MESSAGE)
			expect(screen.queryByText(new RegExp(TRANSPORT_FAILURE_MESSAGE, 'i'))).not.toBeInTheDocument()
		})

		it('tells the reviewer what to do about it instead', async () => {
			await abortUpload()

			const dialog = await screen.findByRole('alertdialog')
			expect(within(dialog).getByText(/network connection/i)).toBeInTheDocument()
			expect(within(dialog).getByText(/could not be reached/i)).toBeInTheDocument()
		})

		it('claims nothing about what the server did with a request it never answered', async () => {
			await abortUpload()

			const dialog = await screen.findByRole('alertdialog')
			expect(within(dialog).getByText(/may or may not have been applied/i)).toBeInTheDocument()
		})

		it('writes no failure marker and opens no detail view, because no log was created', async () => {
			const { store } = await abortUpload()

			await screen.findByRole('alertdialog')
			expect(frappeCreateDoc).not.toHaveBeenCalled()
			expect(store.get(bankRecImportFailuresAtom)).toEqual({})
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		it('lets the reviewer put the inline banner away once the dialog is gone', async () => {
			await abortUpload()

			await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})

			// The banner outlives the dialog by design, and now carries its own way out.
			await userEvent.click(screen.getByRole('button', { name: 'Dismiss message' }))

			expect(screen.queryByRole('alert')).not.toBeInTheDocument()
			// Dismissing reports nothing and retries nothing: it only stops showing the message.
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()
		})

		it('brings the banner back for the NEXT attempt, so dismissing cannot hide a fresh refusal', async () => {
			await abortUpload()

			await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})
			await userEvent.click(screen.getByRole('button', { name: 'Dismiss message' }))
			expect(screen.queryByRole('alert')).not.toBeInTheDocument()

			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(await screen.findByRole('alert')).toBeInTheDocument()
			expect(frappeFileUpload).toHaveBeenCalledTimes(2)
		})

		it('offers no dismiss control on the banners that are not the upload form\'s', () => {
			// The prop is opt-in: the import-log list's own banner reports why the list is missing, so
			// clearing it would leave an empty panel with no explanation.
			renderImporter({ listError: makeServerMessagesError('Not permitted to read the logs.') })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Dismiss message' })).not.toBeInTheDocument()
		})
	})

	/* ── The attachment the upload has to invent a parent for ────────────────────────── */

	/*
	 * An upload must name a parent document, but the import log does not exist yet and names itself by
	 * hash on insert, so the placeholder name the client sends is discarded and the attachment is left
	 * pointing at a document that never comes into being. The framework separately attaches the
	 * statement to the real log while inserting it, reading the `file` field's own value - so one
	 * statement finished with TWO `File` rows, one of them permanently dangling, on every import.
	 *
	 * The order of the cleanup is the safety argument, and is asserted below rather than assumed:
	 * Frappe removes a file from disk only when no other row shares its content hash, so discarding the
	 * placeholder after the log exists takes the row and leaves the statement, while discarding it after
	 * a refusal takes both - correctly, since nothing references the bytes. Verified against a real
	 * bench: deleting the placeholder row left the canonical row and the file on disk intact.
	 */
	describe('the placeholder attachment an upload has to create', () => {

		const uploadedFile = makeFileUploadResponse()

		const uploadStatement = async () => {
			const rendered = renderImporter({ logs: [] })
			await chooseStatementFile(rendered.container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
			return rendered
		}

		it('discards it once the log owns an attachment of its own', async () => {
			frappeFileUpload.mockResolvedValue(uploadedFile)
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00009' }))

			await uploadStatement()

			expect(await screen.findByText(detailViewFor('BSIL-2024-00009'))).toBeInTheDocument()
			await waitFor(() => {
				expect(frappeContextValue.db.deleteDoc).toHaveBeenCalledWith('File', uploadedFile.name)
			})
			expect(frappeContextValue.db.deleteDoc).toHaveBeenCalledTimes(1)
		})

		it('discards it only AFTER the log exists, never before', async () => {
			// Reversed, this would take the statement off disk with it: at that moment the placeholder is
			// the only row holding the content hash.
			frappeFileUpload.mockResolvedValue(uploadedFile)
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00009' }))

			await uploadStatement()

			await waitFor(() => {
				expect(frappeContextValue.db.deleteDoc).toHaveBeenCalled()
			})
			expect(frappeCreateDoc.mock.invocationCallOrder[0])
				.toBeLessThan(frappeContextValue.db.deleteDoc.mock.invocationCallOrder[0])
		})

		it('discards it when creation was refused, so a refused attempt leaves nothing behind', async () => {
			const refusal = makeServerMessagesError('No tables found in the PDF file')
			frappeFileUpload.mockResolvedValue(uploadedFile)
			frappeCreateDoc.mockRejectedValue(refusal)
			installCreateDocError(refusal)

			await uploadStatement()

			await screen.findByRole('alertdialog')
			await waitFor(() => {
				expect(frappeContextValue.db.deleteDoc).toHaveBeenCalledWith('File', uploadedFile.name)
			})
		})

		it('discards nothing when the upload never produced an attachment', async () => {
			const refusal = makeServerMessagesError('Stream has ended unexpectedly')
			frappeFileUpload.mockRejectedValue(refusal)
			installFileUploadError(refusal)

			await uploadStatement()

			await screen.findByRole('alertdialog')
			expect(frappeContextValue.db.deleteDoc).not.toHaveBeenCalled()
		})

		it('keeps a failed cleanup to itself: the import still opens and nothing new is reported', async () => {
			// Housekeeping is not the reviewer's problem. A dangling row is untidy; interrupting a
			// successful import to say so would be worse.
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

			try {
				frappeFileUpload.mockResolvedValue(uploadedFile)
				frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00009' }))
				frappeContextValue.db.deleteDoc.mockRejectedValue(
					makeServerMessagesError('Not permitted to delete File') as never
				)

				await uploadStatement()

				expect(await screen.findByText(detailViewFor('BSIL-2024-00009'))).toBeInTheDocument()
				await waitFor(() => {
					expect(consoleError).toHaveBeenCalled()
				})
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
				expect(screen.queryByRole('alert')).not.toBeInTheDocument()
				expect(toastError).not.toHaveBeenCalled()
			} finally {
				consoleError.mockRestore()
			}
		})

		it('leaves the rest of the flow alone: one upload, one log, one navigation', async () => {
			frappeFileUpload.mockResolvedValue(uploadedFile)
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00009' }))

			await uploadStatement()

			expect(await screen.findByText(detailViewFor('BSIL-2024-00009'))).toBeInTheDocument()
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
			// The upload still names the placeholder parent the server expects; only the leftover row
			// afterwards is new behaviour.
			expect(frappeFileUpload).toHaveBeenCalledWith(
				expect.any(File),
				expect.objectContaining({
					isPrivate: true,
					doctype: IMPORT_LOG_DOCTYPE,
					docname: expect.stringMatching(/^new-bank-statement-import-log-\d+$/),
					fieldname: 'file'
				})
			)
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

		/*
		 * The refusal happens before any import log exists, so the Previous Imports table has no row to
		 * badge - the table can only ever badge what the server actually has. That left the form itself
		 * as the only place a per-file failure could be shown, and until it was shown there, dismissing
		 * the modal erased every trace that the statement had been rejected at all.
		 */
		describe('marks the refused file on the form itself', () => {

			const failureIndicator = (): HTMLElement | null => {
				const badge = screen
					.queryAllByText('Failed')
					.find((node) => node.getAttribute('data-slot') === 'badge')

				return badge?.parentElement ?? null
			}

			it('names the file it refused, so the marker is about that file and not the form', async () => {
				await refuseCreation()
				await screen.findByRole('alertdialog')

				const indicator = failureIndicator()
				expect(indicator).not.toBeNull()
				expect(indicator).toHaveTextContent('hdfc-statement-jan-2024.csv')
				expect(indicator).toHaveTextContent('nothing was imported from it')
			})

			it('outlives the modal, which is the whole point of it', async () => {
				await refuseCreation()

				await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
				await waitFor(() => {
					expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
				})

				expect(failureIndicator()).not.toBeNull()
			})

			it('is absent until something is actually refused', async () => {
				const { container } = renderImporter({ logs: [] })
				await chooseStatementFile(container, csvStatementFile())

				expect(failureIndicator()).toBeNull()
			})

			it('retires when a different file is chosen, because it described the old one', async () => {
				const { container } = await refuseCreation()

				// Dismissed first because the modal is genuinely modal: Radix takes pointer events off the
				// background, so the dropzone is unreachable until it is gone - as it should be.
				await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
				await waitFor(() => {
					expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
				})
				expect(failureIndicator()).not.toBeNull()

				await chooseStatementFile(container, csvStatementFile('barclays-statement-feb-2024.csv'))

				expect(failureIndicator()).toBeNull()
			})

			it('retires the moment a retry is dispatched, rather than lingering over it', async () => {
				await refuseCreation()
				await screen.findByRole('alertdialog')
				expect(failureIndicator()).not.toBeNull()

				await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
				await waitFor(() => {
					expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
				})

				/*
				 * A retry that never settles. Asserting against a SUCCESSFUL retry would prove nothing
				 * here, because success navigates away and unmounts the whole form - the marker would be
				 * gone whether the dispatch cleared it or not. Leaving the retry in flight is what pins
				 * the actual behaviour: the marker is retired when the attempt goes out.
				 */
				frappeCreateDoc.mockReset()
				frappeCreateDoc.mockReturnValue(new Promise(() => undefined))

				await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

				await waitFor(() => {
					expect(failureIndicator()).toBeNull()
				})
				expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
			})

			it('stays out of the log-keyed marker map, which has no key for it', async () => {
				const { store } = await refuseCreation()
				await screen.findByRole('alertdialog')

				expect(failureIndicator()).not.toBeNull()
				// The marker map is keyed by import log name and pruned against fetched rows; this refusal
				// produced neither, so putting it there would key it against nothing.
				expect(store.get(bankRecImportFailuresAtom)).toEqual({})
			})
		})

		/*
		 * One refusal, one presentation. The rejected promise reaches the modal, and the SAME object also
		 * lands on the create hook's `error` member, which renders the inline banner - so the refusal
		 * announced itself twice simultaneously, and the banner mounting behind the modal pushed the form
		 * down while the modal was still being read.
		 */
		describe('reports the refusal once at a time, not three times at once', () => {

			/*
			 * Counted out of the DOM rather than through `getAllByRole('alert')`, and that is not a
			 * shortcut - it is the only way to see this at all. Radix marks the background `aria-hidden`
			 * while the modal is open, so a role query cannot observe the duplicate banner even when it is
			 * rendered: every assertion phrased that way passes whether the bug is present or not
			 * (confirmed by reverting the fix). The duplication is visual, so the DOM is what has to be
			 * measured. `aria-hidden` hides a thing from assistive technology; it does not unpaint it, and
			 * it certainly does not stop it pushing the rest of the form down as it mounts.
			 */
			const renderedBanners = (): HTMLElement[] =>
				Array.from(document.querySelectorAll<HTMLElement>('[data-slot="alert"]'))

			const isInsideDialog = (banner: HTMLElement): boolean =>
				banner.closest('[data-slot="alert-dialog-content"]') !== null

			it('does not repeat the modal\'s message in a banner behind it', async () => {
				await refuseCreation()
				await screen.findByRole('alertdialog')

				// Exactly one banner is painted, and it is the modal's own.
				const banners = renderedBanners()
				expect(banners).toHaveLength(1)
				expect(isInsideDialog(banners[0])).toBe(true)
				expect(banners[0]).toHaveTextContent(REFUSAL)
			})

			it('hands the banner back the moment the modal is dismissed', async () => {
				await refuseCreation()

				await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
				await waitFor(() => {
					expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
				})

				// Still exactly one - but now the page's own, which is what carries the server's words
				// forward once the transient surface has gone.
				const banners = renderedBanners()
				expect(banners).toHaveLength(1)
				expect(isInsideDialog(banners[0])).toBe(false)
				expect(banners[0]).toHaveTextContent(REFUSAL)
				expect(screen.getByRole('alert')).toHaveTextContent(REFUSAL)
			})

			/*
			 * Suppression is by identity for exactly this reason: a stale value left in the dialog atom
			 * must never silence a different, genuinely separate failure.
			 */
			it('never silences a DIFFERENT error just because the modal holds one', () => {
				const shownInDialog = makeServerMessagesError('The modal is reporting this one')
				const shownInBanner = makeServerMessagesError('This is a separate failure')

				installCreateDocError(shownInBanner)
				renderImporter({ logs: [], dialogError: shownInDialog })

				expect(screen.getByText('This is a separate failure')).toBeInTheDocument()
			})
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
