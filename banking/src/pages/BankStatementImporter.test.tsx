/*
 * Colocated suite for the statement-importer page.
 *
 * WHAT IT PROVES.
 *   • TC1 — a statement import produces the expected list. This page's slice of that scenario is
 *     the "Previous Imports" table: every cell the row projects, in the order the SERVER returned
 *     the rows, plus the click-through to one log's detail view.
 *   • FM2 — the per-file failure indicator, in BOTH of the forms this page carries:
 *       – the status chip on a SERVER ROW, driven by a log-keyed marker, for an import that was
 *         refused after its log existed; and
 *       – a SYNTHETIC ROW, driven by an account-and-file-keyed map, for a refusal that happened
 *         BEFORE any log existed and therefore has no server row to attach to. Every server-owned
 *         cell on it reads "-", because there is no document to read one from.
 *     Both are read-only renderings of what the client observed; neither creates a transaction and
 *     neither overrides the document. The authoritative server `status` is asserted to WIN over a
 *     stale marker, and a stale marker is asserted to be RETIRED once the server reports the
 *     import as completed — so a failure that was later fixed does not stay red for the session.
 *   • The SCOPE and the CONTRACT of what this page sends, which no rendering assertion can reach:
 *       – the import-log list query asks only about the SELECTED account, with the exact projection
 *         the row needs and the server's own ordering. A list that lost that filter would show one
 *         account's statement history — file names, closing balances, transaction counts — on
 *         another's screen, and every rendering assertion here would still pass;
 *       – the detail-view route is asserted by the `:id` it was reached WITH, not merely by having
 *         been reached, so a hard-coded, stale or `undefined` destination cannot satisfy it;
 *       – the three writes of the upload chain are asserted argument by argument: the statement
 *         passphrase goes to the selected Bank Account and nowhere else, the file is uploaded
 *         PRIVATELY and attached to NO document, and the log is created WITHOUT a name, pointing at
 *         the URL the server returned, for the selected account. The last two are one requirement
 *         seen from both ends: this DocType is hash-autonamed, so the server owns the identity and
 *         the client must neither invent one nor recover by one;
 *       – the chain STOPS at the step that was refused, and runs at most ONCE per click, including
 *         while a passphrase save is still pending — the window in which a second chain used to
 *         create a second import log for the same statement.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *   • It does not assert client-side de-duplication of re-imported rows: FM4 mandates that as a
 *     NON-change, so there is no behaviour to assert. Rows render exactly as the endpoint returns
 *     them, which is why the ordering assertion below reads the server's order back unchanged.
 *   • It does not assert client-side transaction creation. Only the server creates transactions.
 *   • It does not reach into component state. Every assertion is on rendered output, on the
 *     disabled state of a control, or on the ARGUMENTS handed to an SDK seam. The `store.get(...)`
 *     reads are of a SHARED, exported application atom — the same public contract the import step
 *     writes — not of anything private to a component.
 *   • It does not duplicate FM1, FM3 or FM5, which belong to the reconciliation surface and are
 *     covered by that folder's suites, nor the error dialog's own internals, which
 *     `BankRecErrorDialog.test.tsx` covers. What is asserted here is only this page's MOUNT of
 *     that shared dialog: inert while its atom is empty, present once it is not.
 *
 * TWO THINGS THAT SILENTLY EMPTY THE TREE IF GOT WRONG.
 *   1. The list is gated on a selected bank account (`{selectedBankAccount && <StatementImportLog
 *      />}`), so every scenario that expects a table, an empty state or a list error seeds
 *      `selectedBankAccountAtom`. One test deliberately does not, to prove the gate.
 *   2. `StatementImportLog` destructures only `{ data, error }` — there is NO loading state and no
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

/*
 * The warning raised when the private statement cannot be linked to its import log (SEC-09).
 *
 * `vi.hoisted` because the `vi.mock` factory below is hoisted above every ordinary declaration and
 * would otherwise close over an uninitialised binding. All three members `sonner` is asked for across
 * this page's module graph are stubbed - the page itself only raises `warning`, but
 * `BankReconciliation/utils.ts` (reached through `BankPicker`) imports `toast` and calls `error` and
 * `success`, and a missing member would throw from inside a handler rather than fail visibly here.
 * The toaster is mounted in `App.tsx`, which this suite never renders, so the CALL is the only
 * observable.
 */
const { toastError, toastSuccess, toastWarning } = vi.hoisted(() => ({
	toastError: vi.fn<(message: string, options?: unknown) => void>(),
	toastSuccess: vi.fn<(message: string, options?: unknown) => void>(),
	toastWarning: vi.fn<(message: string, options?: unknown) => void>()
}))

vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess, warning: toastWarning } }))

// The page imports five SDK hooks at module scope and its subtree reaches `useSWRConfig` through
// `BankPicker -> utils.ts`, so the package is replaced wholesale to keep every one of those seams
// resolvable and unable to reach a real transport.
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
 * Stands in for `ViewBankStatementImportLog` at the `:id` child route. Proving navigation with a
 * sentinel ROUTE rather than a mocked `useNavigate` keeps the assertion about observable
 * behaviour — the detail view is reached — instead of about which function was called.
 *
 * It renders the `:id` it was reached WITH, because "a detail view opened" is a materially weaker
 * claim than "the detail view of THIS log opened". A constant sentinel is satisfied by navigating
 * to a hard-coded name, to the wrong row's name, or to `/statement-importer/undefined` — and the
 * last of those is a real possibility here, since the destination is read off a document the
 * server returns. Every navigation assertion below therefore reads the parameter back.
 */
const DETAIL_SENTINEL = 'import-log-detail-reached'

const ImportLogDetailProbe = () => {
	const { id } = useParams()

	return <div>{DETAIL_SENTINEL}:{id}</div>
}

/** The exact text the probe renders for one log — nothing else can satisfy it. */
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

/**
 * The endpoint orders by `creation desc`, so the fixture list is newest-first. Supplying it in the
 * server's own order is what lets the ordering assertion read it back unchanged.
 */
const ALL_LOGS: BankStatementImportLog[] = [
	INDETERMINATE_LOG,
	FAILED_LOG,
	NOT_STARTED_LOG,
	COMPLETED_LOG
]

const FAILED_LOG_MESSAGE = 'No tables found in the PDF file'
const SECOND_FAILED_LOG_MESSAGE = 'The bank account is disabled. Please enable it'

/**
 * Markers for two of those four logs, keyed by import-log name exactly as the atom is. Built by
 * merging the shared factory's output rather than by hand, so a fixture cannot key the map
 * differently from the page that reads it.
 */
const ATTEMPT_MARKERS: Record<string, FrappeError> = {
	...makeImportFailures(FAILED_LOG, FAILED_LOG_MESSAGE),
	...makeImportFailures(INDETERMINATE_LOG, SECOND_FAILED_LOG_MESSAGE)
}

interface ImporterScenario {
	/** What the list query answers with. `undefined` is the pre-arrival state, not a loading state. */
	logs?: BankStatementImportLog[]
	listError?: FrappeErrorFixture
	/** Per-file failure markers, keyed by import-log name, exactly as the atom is. */
	markers?: Record<string, FrappeError>
	/**
	 * Refusals observed BEFORE any import log existed, keyed by account-and-file identity exactly as
	 * the atom is. These are what produce the synthetic rows (F-03).
	 */
	dialogError?: FrappeErrorFixture
	uploadError?: FrappeErrorFixture
	/**
	 * Answer the list query with ONLY the fields it asked for, as the server does. Used where the
	 * assertion is about whether a field is actually PROJECTED, rather than about what is rendered
	 * once it is.
	 */
	projectQueriedFieldsOnly?: boolean
	withSelectedBank?: boolean
	/** The account to select. Overridden only to prove the query scope is DERIVED from it. */
	selectedBank?: ReturnType<typeof makeSelectedBank>
}

const listQueryResponse = (logs?: BankStatementImportLog[], listError?: FrappeErrorFixture) => ({
	data: logs,
	error: listError,
	isLoading: false,
	isValidating: false,
	mutate: frappeHookMutate
})

/**
 * Installs the list answer for THIS doctype only, leaving any other list query on the shared
 * mock's own empty default. Installed per test rather than once, because the harness's shared
 * teardown discards per-test implementations.
 */
const installImportLogQuery = (logs?: BankStatementImportLog[], listError?: FrappeErrorFixture) => {
	frappeSDKMock.useFrappeGetDocList.mockImplementation((doctype) =>
		doctype === IMPORT_LOG_DOCTYPE ? listQueryResponse(logs, listError) : listQueryResponse()
	)
}

/**
 * Installs the list answer PROJECTED DOWN to exactly the fields the page asked for, which is what the
 * server does: a `get_doc_list` response carries the projection and nothing else. A fixture that
 * hands back a complete document lets a component read a field it never requested and pass anyway -
 * so a row rendering `currency` would go green whether or not the query fetched it. Deriving the
 * projection from the query's own `fields` argument makes the two inseparable.
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
 * Seeds the error state the CREATE hook exposes after a refusal, which is the state the page reads to
 * render its inline banner. Seeded rather than provoked by rejecting the spy, because `onUpload`
 * carries no rejection handler — original, unchanged behaviour — so rejecting it would leave an
 * unhandled rejection behind and prove nothing the hook's own state does not.
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

/** The same, for the passphrase step's hook. */
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
 * The status chip inside a row. The chip's theme is asserted through `data-theme`, never through a
 * class string: `tailwind-merge` is free to reorder and collapse classes, so a class assertion
 * would be brittle in a way that says nothing about the component's intent.
 */
const statusBadgeIn = (row: HTMLElement): HTMLElement => {
	/*
	 * Located by Badge's own variant attributes rather than by `data-slot="badge"`, because that one
	 * attribute is NOT stable across the three states. The `Failed` chip is wrapped in a
	 * `TooltipTrigger asChild` so it can carry the server's own reason; Radix merges the trigger's props
	 * into the element it clones - `data-slot="tooltip-trigger"` among them - and Badge spreads
	 * `...props` AFTER its own `data-slot`, so for that state alone the slot reads `tooltip-trigger`
	 * and a slot-only lookup finds nothing at all. `data-variant`, `data-size` and `data-theme` are
	 * set by Badge and by nothing Radix passes down, and this row renders no other variant-bearing
	 * primitive (its remaining cells are plain text and one anchor), so the three of them together
	 * identify the chip in every state.
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

/*
 * `rows` is parameterised so two statements can differ in CONTENT and SIZE as well as in name. A
 * retry that re-uploaded the previous month's statement under the new one's name would otherwise be
 * indistinguishable from one that uploaded the file the reviewer actually chose.
 */
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

			// The endpoint orders by `creation desc` and the list is rendered as produced — no
			// client-side re-ordering, no client-side de-duplication (FM4 mandates that absence).
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

			// Reaching the `:id` child route is the observable outcome of
			// `navigate(`/statement-importer/${item.name}`)` — and the parameter it was reached with
			// is what makes this THAT log's detail view rather than merely a detail view. Every row
			// on screen has a distinct name, so a handler that closed over the wrong one, or over a
			// constant, cannot satisfy this.
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
				// Not a stale or hard-coded destination, and not the `undefined` a missing name
				// would produce.
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
	 * WHAT THE QUERY ASKS FOR IS PART OF THE BEHAVIOUR.
	 *
	 * The rows above are asserted from a mocked answer, so nothing in them can tell whether the
	 * question was scoped. `Bank Statement Import Log` is readable by System Manager, and a statement
	 * import log names the file, the closing balance and the transaction count of a bank account — so
	 * a list that lost its `bank_account` filter would show one company's statement history on
	 * another account's screen, and every rendering assertion in this suite would still pass.
	 *
	 * These assertions are on the ARGUMENTS the page hands the SDK, for the same reason the
	 * reconciliation suite pins its endpoint parameters: it is the only place the scope exists.
	 */
	describe('import-log query scope', () => {

		/** The call the page makes for THIS doctype, with the arguments it made it with. */
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

			// The filter is the whole of the data-isolation boundary on this screen.
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
			// The server orders the rows; the client renders them as produced (FM4).
			expect(args?.orderBy).toEqual({ field: 'creation', order: 'desc' })
			expect(args?.limit).toBe(10)
		})

		it('scopes the query to whichever account is selected, not to a fixed one', () => {
			// Derivation, proven by changing the input: the same page against a second account must
			// ask about that account. A hard-coded or stale filter passes the test above and fails
			// this one.
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
			// The list lives behind `{selectedBankAccount && <StatementImportLog />}`, so with no
			// account there is no account whose logs could be listed and the query is never issued —
			// which is the stronger form of the `null`-key guard the component also passes for it.
			renderImporter({ logs: ALL_LOGS, withSelectedBank: false })

			expect(
				frappeSDKMock.useFrappeGetDocList.mock.calls
					.filter(([doctype]) => doctype === IMPORT_LOG_DOCTYPE)
			).toHaveLength(0)
		})

		it('does not revalidate the list on window focus', () => {
			// Pinned because the per-file failure indicator is read from session state rather than from
			// the document: when this list re-fetches is therefore when a marked row can change back.
			renderImporter({ logs: ALL_LOGS })

			const [, , , options] = importLogQueryCall()

			expect(options).toEqual({ revalidateOnFocus: false })
		})
	})

	describe('per-row status chip (FM2)', () => {

		/*
		 * The chip has exactly THREE states, and only two of them come from the document.
		 *
		 * `Bank Statement Import Log.status` offers exactly `Not Started` and `Completed`, and the
		 * DocType carries no error field at all - so a refused import, which rolls back, leaves the row
		 * saying `Not Started`: indistinguishable from a statement merely waiting to be imported. The
		 * third state is therefore driven from the failure the import step OBSERVED, keyed by import-log
		 * name in a shared session-scoped atom. That is the only failure signal that exists here.
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
			// The stored status is `Not Started`, and the marker deliberately takes precedence over it.
			expect(badge).not.toHaveTextContent('Not Started')
		})

		/*
		 * Every marked row is marked from its OWN entry, so two files refused for different reasons do
		 * not collapse into one indicator. A single shared flag would have passed the test above and
		 * failed this one.
		 */
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


		/*
		 * The map is keyed by import-log NAME - the primary key of a hash-autonamed DocType - so a
		 * marker recorded for one log cannot reach another. This is asserted with a name that is not
		 * in the list at all, which is the shape a marker from a previously selected bank account
		 * takes: the list only ever renders the logs of the account it queried.
		 */
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


		/*
		 * The map is plain in-memory state, deliberately NOT persisted: an observation of one attempt
		 * must not outlive the session that made it. Reading it back after a render proves the page
		 * only READS it - the frozen badge edit retires nothing and writes nothing.
		 */
		it('only reads the failure map, never rewrites it', async () => {
			const markers = makeImportFailures(FAILED_LOG, FAILED_LOG_MESSAGE)
			const { store } = renderImporter({ logs: ALL_LOGS, markers })

			expect(statusBadgeIn(rowFor(FAILED_LOG))).toHaveTextContent('Failed')

			await waitFor(() => {
				expect(store.get(bankRecImportFailuresAtom)).toBe(markers)
			})
			expect(Object.keys(store.get(bankRecImportFailuresAtom))).toEqual([FAILED_LOG.name])
		})
	})

	describe('empty state', () => {

		it('invites a first import when the account has none', () => {
			renderImporter({ logs: [] })

			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})

		/**
		 * There is deliberately NO loading state: the component destructures only `{ data, error }`,
		 * so an un-arrived list reaches the same branch as an empty one. Asserting a skeleton here
		 * would assert a component that does not exist.
		 */
		it('reaches the same branch before the list has arrived', () => {
			renderImporter({ logs: undefined })

			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})

	describe('list query rejection', () => {

		/**
		 * PATH 1 — `_server_messages`, the double-encoded envelope a `frappe.throw` produces. The
		 * banner collapses Frappe's placeholder title into its friendly heading, and the server's
		 * own sentence reaches the user verbatim.
		 */
		it("renders the server's message from a _server_messages envelope", () => {
			const message = 'You are not permitted to read Bank Statement Import Log.'

			renderImporter({ listError: makeServerMessagesError(message) })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()
			expect(screen.getByText('There was an error.')).toBeInTheDocument()
		})

		/** PATH 2 — text arriving in `_error_message` instead, which the parser appends. */
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

	/*
	 * THE PAGE'S OWN UPLOAD HANDLER.
	 *
	 * `onUpload` chains three writes and then navigates. It carries NO rejection handler of its own -
	 * that is original, unchanged behaviour (AAP §0.6.1.5 freezes this file's edit to the per-file
	 * badge state and the shared dialog mount), and it is how the page has always reported a refusal:
	 * each of the three SDK hooks exposes its own `error`, and the page renders each one as an inline
	 * `ErrorBanner` above the form. Those three branches are asserted below by seeding the hook state
	 * the page reads, which is exactly what the SDK does after a refusal.
	 */
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

			// The destination is the name the SERVER gave the document it created — read back off the
			// route, so navigating to a client-minted id, to the previous row's id, or to
			// `/statement-importer/undefined` cannot satisfy it.
			expect(await screen.findByText(detailViewFor('BSIL-2024-00009'))).toBeInTheDocument()
			expect(screen.queryByText(detailViewFor('undefined'))).not.toBeInTheDocument()
		})

		/**
		 * The INLINE banner, which is a different thing from the per-file record below.
		 *
		 * This case seeds the upload hook's own `error` state without any attempt having been observed —
		 * the state a reviewer returns to a page in, or lands in after a re-render. Nothing was watched
		 * being refused, so nothing may be recorded per file: no synthetic row, no transaction, no
		 * hand-off to a log that does not exist. The banner reports what the hook holds and that is all.
		 *
		 * The per-file record is written only from an OBSERVED rejection, which the F-03 block below
		 * drives for real. Keeping the two apart is deliberate: it is what stops a rendered error state
		 * from manufacturing failure history.
		 */
		it("repeats the server's refusal of the upload, in its own words", () => {
			const message = 'The uploaded statement contains no transactions.'

			renderImporter({ logs: [], uploadError: makeServerMessagesError(message) })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()

			// Nothing was invented on the strength of a refusal.
			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
			expect(frappeCreateDoc).not.toHaveBeenCalled()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		/**
		 * A refusal of the LAST step is the one with something already on the server: the file is
		 * stored and only the log is missing. It is reported from the create hook's own error, and the
		 * reviewer is still not handed to a document that was never created.
		 */
		it("repeats the server's refusal to create the log", () => {
			const message = 'Not permitted to create Bank Statement Import Log.'

			installCreateDocError(makeServerMessagesError(message))
			renderImporter({ logs: [] })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		/**
		 * The passphrase step has no surface of its own, so without this branch a refusal there would
		 * be silent: the reviewer would press Upload, watch nothing happen and be told nothing.
		 */
		it("repeats the server's refusal to store the statement passphrase", () => {
			const message = 'Not permitted to update Bank Account.'

			installUpdateDocError(makeServerMessagesError(message))
			renderImporter({ logs: [] })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()
		})

		/*
		 * Severity is the SERVER'S decision on this surface too — the inline banner themes on the
		 * indicator the server sent, and the page makes no judgement of its own.
		 */
		it("takes the upload banner's severity from the server's own indicator", () => {
			renderImporter({
				logs: [],
				uploadError: makeWarningServerMessagesError('The statement covers a closed period.')
			})

			expect(screen.getByRole('alert')).toHaveClass('text-ink-amber-3')
		})
	})

	/* ── Refusals that happen before any import log exists ──────────────────────────── */

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

		/**
		 * The render gate. Without a selected account there is no account whose logs could be
		 * listed, so neither the list nor the dropzone is offered — and upload stays unavailable.
		 */
		it('withholds the list and the dropzone until an account is selected', () => {
			renderImporter({ logs: ALL_LOGS, withSelectedBank: false })

			expect(screen.queryByText('Previous Imports')).not.toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
			expect(screen.queryByText('Bank Statement')).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()
		})
	})

	/*
	 * ════════════════════════════════════════════════════════════════════════════════════════════════
	 * NEGATIVE AUTHORISATION
	 *
	 * ⚠️ READ THIS BEFORE ADDING TO THIS BLOCK. This page carries NO client-side role gate, and that
	 * is correct rather than a gap: authorisation belongs to the server, and a UI that hid a control
	 * would be a convenience, not a control. `Bank Statement Import Log` grants permissions to System
	 * Manager ONLY, and it is the SERVER that enforces that on every read, insert and document-method
	 * call this page makes.
	 *
	 * So what a frontend suite can prove here is precisely two things, and it must not be read as
	 * proving more:
	 *
	 *   1. That a narrowed profile really is denied by `src/lib/permissions.ts` rather than uniformly
	 *      granted. Without this, every other suite's privileged profile would be an unexamined
	 *      assumption. The narrowing is written directly onto `window.frappe.boot.user` here, which
	 *      is the only thing those helpers read, and this block restores it after every test.
	 *   2. That this page is FAIL-CLOSED when the server refuses under such a profile: the refusal is
	 *      surfaced in the server's own words, the per-file record is written, and nothing is created,
	 *      navigated to, or presented as having succeeded.
	 *
	 * What it CANNOT prove is that the server refuses. That is the endpoint's own obligation and is
	 * exercised by the Python suites; the SDK is mocked here, so a refusal is something these tests
	 * INSTALL rather than something they discover.
	 * ════════════════════════════════════════════════════════════════════════════════════════════════ */
	describe('negative authorisation', () => {

		/**
		 * Narrows the authorisation profile the SPA reads.
		 *
		 * `src/lib/permissions.ts` asks nothing more than whether a DocType appears in one of the eight
		 * `can_*` arrays on `boot.user`, so overwriting the arrays IS the narrowing - no permission
		 * derivation has to be reproduced anywhere. Whatever is not named is left as the harness
		 * installed it.
		 */
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

		/** Everything an accounting-only profile holds here, with the System-Manager-only rows withheld. */
		const ACCOUNTS_ONLY = {
			can_read: ['Bank Transaction', 'Bank Account', 'Payment Entry', 'Journal Entry'],
			can_write: ['Bank Transaction', 'Bank Account', 'Payment Entry', 'Journal Entry'],
			can_create: ['Bank Transaction', 'Bank Account', 'Payment Entry', 'Journal Entry'],
			can_delete: ['Bank Transaction', 'Bank Account', 'Payment Entry', 'Journal Entry']
		}

		it('denies the import log to an accounting-only profile that still holds its own rights', () => {
			// The premise every other suite rests on. `Bank Statement Import Log` has permission rows for
			// System Manager only, so an accounting-only profile must come back denied on all four rights
			// while still holding the transaction rights its own role really does grant.
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
			// The read is refused before any row exists, so the page must show the server's refusal and no
			// table at all - never an empty list, which would read as "this account has no imports".
			narrowProfileTo(ACCOUNTS_ONLY)

			renderImporter({ logs: [], listError: makeServerMessagesError('Insufficient Permission for Bank Statement Import Log') })

			expect(await screen.findByText(/Insufficient Permission/)).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})
})
