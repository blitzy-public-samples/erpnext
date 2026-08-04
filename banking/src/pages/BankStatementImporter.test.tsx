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

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	TEST_ALTERNATE_CURRENCY,
	TEST_CURRENCY,
	createFrappeSDKMock,
	frappeCreateDoc,
	frappeDeleteDoc,
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
import { installRoleProfile } from '@/test/setup'
import {
	canCreateDocument,
	canDeleteDocument,
	canReadDocument,
	canWriteDocument
} from '@/lib/permissions'
import {
	bankRecErrorDialogAtom,
	bankRecImportFailuresAtom,
	bankRecPreLogImportFailuresAtom,
	preLogImportFailureKey,
	selectedBankAccountAtom,
	type PreLogImportFailure
} from '@/components/features/BankReconciliation/bankRecAtoms'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'

type FrappeErrorFixture = ReturnType<typeof makeFrappeError>

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

/*
 * ⚠️ AN IMPORT LOG'S NAME COMES FROM THE SERVER. NEVER FROM THIS CLIENT.
 *
 * `Bank Statement Import Log` is hash-autonamed — `"autoname": "hash"`, `"naming_rule": "Random"` —
 * and Frappe's `set_new_name` clears whatever `name` an insert supplies for every rule except
 * `prompt` and `UUID` before minting its own. So a name this page constructed is not merely a poor
 * key for the document: it is a key the document CANNOT have, and a read for it can only ever 404.
 *
 * The two identities below are shaped like the ten-character value `make_autoname("hash")` actually
 * produces, so no assertion in this suite can be satisfied by a string the page could have built for
 * itself. They are the only names the upload-chain and recovery scenarios use.
 *
 * (The `BSIL-…`-shaped names in the list fixtures above are arbitrary row identities standing in for
 * whatever the server holds; nothing asserts a naming RULE from them.)
 */
const SERVER_NAMED_LOG = 'e7d6a0odkj'

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
const ATTEMPT_MARKERS: Map<string, string> = new Map([
	...makeImportFailures(FAILED_LOG, FAILED_LOG_MESSAGE),
	...makeImportFailures(INDETERMINATE_LOG, SECOND_FAILED_LOG_MESSAGE)
])

interface ImporterScenario {
	/** What the list query answers with. `undefined` is the pre-arrival state, not a loading state. */
	logs?: BankStatementImportLog[]
	listError?: FrappeErrorFixture
	/** Per-file failure markers, keyed by import-log name, exactly as the atom is. */
	markers?: Map<string, string>
	/**
	 * Refusals observed BEFORE any import log existed, keyed by account-and-file identity exactly as
	 * the atom is. These are what produce the synthetic rows (F-03).
	 */
	preLogFailures?: Map<string, PreLogImportFailure>
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

/**
 * Reports the update hook as mid-write with no chain running, which is the state F-12's second half is
 * about: `updateDoc`'s `loading` had to become part of the disabled expression, and that is only
 * observable independently of the chain guard by driving the hook's own flag.
 */
const installUpdateDocLoading = () => {
	frappeSDKMock.useFrappeUpdateDoc.mockImplementation(() => ({
		updateDoc: frappeUpdateDoc,
		loading: true,
		error: null,
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
	preLogFailures,
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
	if (preLogFailures) {
		store.set(bankRecPreLogImportFailuresAtom, preLogFailures)
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

const pdfStatementFile = (name = 'hdfc-statement-jan-2024.pdf'): File =>
	new File(['%PDF-1.7 statement'], name, { type: 'application/pdf' })

const PLACEHOLDER_PDF_PASSPHRASE = 'not-a-real-passphrase'

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

		/*
		 * ⚠️ F-13. The closing balance is rendered in THE STATEMENT'S OWN currency.
		 *
		 * It used to be rendered in the system default, because the list query projected no `currency`
		 * field and `formatCurrency(flt(item.closing_balance, 2))` was called without one — so a
		 * statement on a USD bank account had its balance printed with a rupee symbol and Indian digit
		 * grouping. That is the single figure a reviewer uses to decide whether an import tallies against
		 * the paper statement, and it was silently wrong: no error, no warning, just the wrong money.
		 *
		 * `Bank Statement Import Log.currency` is a Link to Currency populated read-only from the bank
		 * account's GL account, so the value was always available; it simply was not asked for.
		 *
		 * `projectQueriedFieldsOnly` makes the mocked query answer with ONLY the fields the page
		 * requested, exactly as the server does. That is what gives this test its force: it fails unless
		 * the projection is fixed TOO, because a row reading `item.currency` off an unprojected field
		 * gets `undefined` and falls straight back to the default. Neither half of the fix passes alone.
		 */
		it("renders the closing balance in the statement's own currency, not the system default", () => {
			const foreignCurrencyLog = makeBankStatementImportLog({
				name: 'BSIL-2024-00009',
				file: '/files/citi-usd-statement-jan-2024.csv',
				status: 'Completed',
				currency: TEST_ALTERNATE_CURRENCY,
				creation: '2024-01-20 11:00:00.000000',
				closing_balance: 152300.75
			})

			renderImporter({ logs: [foreignCurrencyLog], projectQueriedFieldsOnly: true })

			const row = within(rowFor(foreignCurrencyLog))

			expect(row.getByText('$ 152,300.75')).toBeInTheDocument()
			// The old behaviour, now explicitly excluded: the same amount under the default symbol.
			expect(row.queryByText('₹ 152,300.75')).not.toBeInTheDocument()
		})

		it('renders a default-currency balance in that currency too, from the same code path', () => {
			renderImporter({ logs: [COMPLETED_LOG], projectQueriedFieldsOnly: true })

			// COMPLETED_LOG carries the harness's default currency. Paired with the test above — same
			// amount, same code path, two currencies, two symbols — this is what shows the currency is
			// READ from the row rather than being a second hard-coded constant.
			expect(COMPLETED_LOG.currency).toBe(TEST_CURRENCY)
			expect(within(rowFor(COMPLETED_LOG)).getByText('₹ 152,300.75')).toBeInTheDocument()
			expect(within(rowFor(COMPLETED_LOG)).queryByText('$ 152,300.75')).not.toBeInTheDocument()
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
			// Exactly the nine fields the row renders — no `password`-bearing or unrelated field is
			// fetched "just in case". F-13: `currency` is among them, and it is what the closing balance
			// is formatted with.
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
			expect(args?.fields).toContain('currency')
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
		 * ⚠️ F-11. THE SERVER OUTRANKS THE MARKER, and the marker is RETIRED once it does.
		 *
		 * The marker used to win unconditionally, which inverted the authority: a marker is one
		 * session's memory of one refusal, while `Completed` is the committed record `insert_transactions`
		 * writes as its last act. So a statement that was refused and then imported successfully - on a
		 * retry, in another tab, or by another user - went on showing a red `Failed` chip for the rest of
		 * the session, with this client contradicting the database about a financial import that
		 * demonstrably exists. Worse, the row still linked through to a detail view showing `Completed`,
		 * so the two surfaces disagreed with each other.
		 *
		 * Outranking it for rendering is only half the fix: a marker the server has contradicted is not
		 * merely outvoted, it is WRONG, and leaving it in the shared atom leaves a false entry for
		 * anything else that reads the map. So it is deleted where the authoritative status is observed.
		 */
		describe('an authoritative Completed status (F-11)', () => {

			/** A log the client remembers refusing, which the server now reports as imported. */
			const RETRIED_LOG = makeBankStatementImportLog({
				name: 'BSIL-2024-00005',
				file: '/files/hdfc-statement-may-2024.csv',
				status: 'Completed',
				creation: '2024-05-04 12:00:00.000000',
				start_date: '2024-05-01',
				end_date: '2024-05-31',
				number_of_transactions: 31,
				closing_balance: 98000
			})

			const markerForRetriedLog = () =>
				makeImportFailures(RETRIED_LOG, 'Please attach a valid file to import')

			it('wins over a stale failure marker', () => {
				renderImporter({ logs: [RETRIED_LOG], markers: markerForRetriedLog() })

				const badge = statusBadgeIn(rowFor(RETRIED_LOG))

				expect(badge).toHaveAttribute('data-theme', 'green')
				expect(badge).toHaveTextContent('Completed')
				expect(badge).not.toHaveTextContent('Failed')
			})

			it('leaves no failed chip anywhere on the page', () => {
				renderImporter({ logs: [RETRIED_LOG], markers: markerForRetriedLog() })

				// Including the reason, which must not survive as a tooltip on a green chip.
				expect(screen.queryByText('Failed')).not.toBeInTheDocument()
				expect(screen.queryByText('Please attach a valid file to import')).not.toBeInTheDocument()
			})

			/*
			 * ⚠️ THE PRECEDENCE GUARD ON ITS OWN, WITH RETIREMENT UNABLE TO HELP IT.
			 *
			 * This case exists because of something the revert experiment exposed: the two tests above
			 * pass even with the precedence check removed, because retirement deletes the marker in an
			 * effect BEFORE the assertion runs. They prove retirement; they do not prove precedence, and
			 * a reader would reasonably assume otherwise.
			 *
			 * Here the marker is written AFTER the first render has settled. The retirement effect depends
			 * on the list `data`, whose reference is unchanged by a marker write, so it does not re-run —
			 * and the chip renders with a `Completed` status and a live marker, which is the one state
			 * where the precedence check alone decides the outcome.
			 *
			 * It is a reachable state, not a contrived one: the list is read once and then held (it does
			 * not revalidate on focus), so any refusal observed after that read lands on a row whose
			 * status the client already has — a re-import of an already-imported statement refused for
			 * some other reason, or a refusal in one tab against a log another tab completed.
			 */
			it('wins over a marker that arrives after the list was read', async () => {
				const { store } = renderImporter({ logs: [RETRIED_LOG] })

				expect(statusBadgeIn(rowFor(RETRIED_LOG))).toHaveTextContent('Completed')

				await act(async () => {
					store.set(bankRecImportFailuresAtom, markerForRetriedLog())
				})

				// The marker is genuinely present — this is not a test that forgot to seed it.
				expect(store.get(bankRecImportFailuresAtom).has(RETRIED_LOG.name)).toBe(true)
				// And the server's committed record still wins.
				const badge = statusBadgeIn(rowFor(RETRIED_LOG))
				expect(badge).toHaveAttribute('data-theme', 'green')
				expect(badge).toHaveTextContent('Completed')
				expect(screen.queryByText('Failed')).not.toBeInTheDocument()
			})

			it('still marks a NOT-Completed row whose marker arrives the same way', async () => {
				// The discriminating half: the guard must be conditional on `Completed`, not a blanket
				// "ignore markers after the first render".
				const { store } = renderImporter({ logs: [NOT_STARTED_LOG] })

				await act(async () => {
					store.set(bankRecImportFailuresAtom, makeImportFailures(NOT_STARTED_LOG, FAILED_LOG_MESSAGE))
				})

				expect(statusBadgeIn(rowFor(NOT_STARTED_LOG))).toHaveAttribute('data-theme', 'red')
				expect(statusBadgeIn(rowFor(NOT_STARTED_LOG))).toHaveTextContent('Failed')
			})

			it('retires the contradicted marker from the shared atom', async () => {
				const { store } = renderImporter({ logs: [RETRIED_LOG], markers: markerForRetriedLog() })

				// Written before the render, and gone after it: retirement happens where the
				// authoritative status is actually observed, not merely at paint time.
				await waitFor(() => {
					expect(store.get(bankRecImportFailuresAtom).has(RETRIED_LOG.name)).toBe(false)
				})
			})

			it('retires ONLY the contradicted marker, leaving other files marked', async () => {
				// The discriminating case: a blanket clear would satisfy the test above and lose a
				// genuine, still-true failure recorded against a different statement.
				const markers = new Map([
					[RETRIED_LOG.name, 'Please attach a valid file to import'],
					[FAILED_LOG.name, FAILED_LOG_MESSAGE]
				])

				const { store } = renderImporter({ logs: [RETRIED_LOG, FAILED_LOG], markers })

				await waitFor(() => {
					expect(store.get(bankRecImportFailuresAtom).has(RETRIED_LOG.name)).toBe(false)
				})
				expect(store.get(bankRecImportFailuresAtom).get(FAILED_LOG.name)).toBe(FAILED_LOG_MESSAGE)

				// And the still-refused statement keeps saying so.
				expect(statusBadgeIn(rowFor(FAILED_LOG))).toHaveAttribute('data-theme', 'red')
				expect(statusBadgeIn(rowFor(RETRIED_LOG))).toHaveAttribute('data-theme', 'green')
			})

			it('does not disturb the map when there is nothing to retire', () => {
				// Identity, not equality: returning a fresh Map on every pass would notify every
				// subscriber of the atom on every render and re-enter the effect that wrote it.
				const markers = makeImportFailures(FAILED_LOG, FAILED_LOG_MESSAGE)

				const { store } = renderImporter({ logs: [COMPLETED_LOG, FAILED_LOG], markers })

				expect(store.get(bankRecImportFailuresAtom)).toBe(markers)
			})
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
		 * A marker holds no meaning of its own beyond "this one was refused", so the reason has to
		 * travel with the chip. `Bank Statement Import Log` persists nothing about it, and the dialog
		 * that carried it was raised at the moment of the attempt and dismissed long before this list
		 * was next read - so if the chip does not carry it, it is gone.
		 */
		describe('the failed chip carries the server\'s own reason', () => {

			it('names the reason in its accessible name, so it is not colour alone', () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				const label = statusBadgeIn(rowFor(FAILED_LOG)).getAttribute('aria-label')

				expect(label).toBeTruthy()
				expect(label).toContain('Failed')
				// Verbatim, as the server phrased it - the client paraphrases nothing.
				expect(label).toContain(FAILED_LOG_MESSAGE)
			})

			it("distinguishes two refusals by the server's own wording", () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				expect(statusBadgeIn(rowFor(FAILED_LOG)).getAttribute('aria-label'))
					.toContain(FAILED_LOG_MESSAGE)
				expect(statusBadgeIn(rowFor(INDETERMINATE_LOG)).getAttribute('aria-label'))
					.toContain(SECOND_FAILED_LOG_MESSAGE)
			})

			it('shows the reason on hover', async () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				await userEvent.hover(statusBadgeIn(rowFor(FAILED_LOG)))

				await waitFor(() => {
					expect(screen.getAllByText(FAILED_LOG_MESSAGE).length).toBeGreaterThan(0)
				})
			})

			/*
			 * Radix renders a focusable button for a tooltip trigger BY DEFAULT, but `asChild` hands
			 * that role to the Badge span and Radix adds no `tabIndex` of its own - so without an
			 * explicit one the reason is reachable by POINTER ONLY and a keyboard-only reviewer has no
			 * route to it at all.
			 */
			it('shows the same reason on keyboard focus, with no pointer involved', async () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				const chip = statusBadgeIn(rowFor(FAILED_LOG))
				expect(chip.tabIndex).toBe(0)

				// Wrapped because focusing the trigger is what opens the tooltip, and that open is a
				// React state update the test itself caused.
				await act(async () => {
					chip.focus()
				})
				expect(chip).toHaveFocus()

				await waitFor(() => {
					expect(screen.getAllByText(FAILED_LOG_MESSAGE).length).toBeGreaterThan(0)
				})

				await userEvent.keyboard('{Escape}')
			})

			/*
			 * The chips whose labels already say what happened add NO tab stop, so a reviewer tabbing
			 * the list does not pass through one stop per row for no information.
			 */
			it('is the only chip that is a tab stop', () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				expect(statusBadgeIn(rowFor(COMPLETED_LOG)).hasAttribute('tabindex')).toBe(false)
				expect(statusBadgeIn(rowFor(NOT_STARTED_LOG)).hasAttribute('tabindex')).toBe(false)
			})

			/*
			 * ⚠️ F-21. A TAB STOP WITHOUT A FOCUS TREATMENT IS WORSE THAN NO TAB STOP.
			 *
			 * Making the chip focusable (above) put it in the tab order; it did not make focus VISIBLE
			 * there. `Badge` is a plain span, so it carries none of the focus styling `Button` has, and
			 * the chip sits inside a click-through table row - so a keyboard reviewer tabbing the list
			 * arrived on it with nothing on screen changing at all, which is WCAG 2.4.7 and is the exact
			 * scenario the tab stop was added to serve.
			 *
			 * Asserted as the tokenized utility rather than as a computed style, deliberately, and this is
			 * the one place in this suite where a class assertion is the right instrument:
			 *   • `focus-visible:` is a pseudo-class variant, so `getComputedStyle` in jsdom reports
			 *     nothing for it whether or not the treatment exists - a computed-style assertion here
			 *     would pass vacuously.
			 *   • the design system's requirement IS the token: `shadow-focus-red` resolves to
			 *     `--focus-shadow-red`, and `Button` uses the identical utility for its red theme. A
			 *     hand-rolled ring of the same appearance would be a design-system violation, and an
			 *     assertion on appearance could not tell the two apart.
			 */
			it('shows a tokenized focus ring, so keyboard focus is visible on it', () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				const chip = statusBadgeIn(rowFor(FAILED_LOG))

				// The system's red focus ring, the same token `Button` uses.
				expect(chip).toHaveClass('focus-visible:shadow-focus-red')
				// Paired with, never used alone: this replaces the UA outline rather than removing it.
				expect(chip).toHaveClass('focus-visible:outline-none')
				// The ring is animated by Badge's own base class, so the treatment is not an abrupt jump.
				expect(chip.className).toContain('transition-[color,box-shadow]')
			})

			it('applies the treatment only on keyboard focus, not on every render', () => {
				// `focus-visible:` and not `focus:`: the chip is inside a row that is click-through, so a
				// bare `focus:` ring would flash on every pointer click of the row as well.
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				const className = statusBadgeIn(rowFor(FAILED_LOG)).className

				expect(className).not.toMatch(/(^|\s)focus:shadow-focus-red/)
				expect(className).not.toMatch(/(^|\s)focus:outline-none/)
			})

			it('adds no focus treatment to the chips that are not focusable', () => {
				// A ring on a non-tab-stop would be dead styling, and would suggest a reachability that
				// does not exist.
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				for (const log of [COMPLETED_LOG, NOT_STARTED_LOG]) {
					expect(statusBadgeIn(rowFor(log))).not.toHaveClass('focus-visible:shadow-focus-red')
				}
			})
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
			expect([...store.get(bankRecImportFailuresAtom)]).toEqual([[FAILED_LOG.name, FAILED_LOG_MESSAGE]])
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

	/* ── F-03: refusals that happen before any import log exists ─────────────────────── */

	/**
	 * ⚠️ F-03. THE FAILURES WITH NO ROW TO ATTACH TO.
	 *
	 * The whole first half of the upload chain runs before a `Bank Statement Import Log` exists: the
	 * passphrase save onto the `Bank Account`, the private `File` upload, and the log insert itself. Every
	 * refusal available there is one the reviewer most needs explaining — no permission on the DocType
	 * (it is System Manager only), a disabled or mis-configured bank account, a file storage would not
	 * take, an empty or unreadable statement, a wrong PDF password.
	 *
	 * Before this, the chain had NO rejection handler at all. Each of those refusals produced nothing but
	 * whichever generic inline banner happened to be rendered, which vanished on the next render, and left
	 * no per-file record whatsoever — so a reviewer who uploaded three statements and had one refused had
	 * no way to tell afterwards WHICH one. FM2 requires the import status view to indicate failure per
	 * file; there was no file to indicate against, because the row that would carry it is exactly what
	 * failed to come into being.
	 *
	 * These cases drive REAL rejections through the chain, so they fail unless the handler exists.
	 */
	describe('a refusal before any log exists (F-03)', () => {

		const REFUSAL = 'Bank Account HDFC - Test Company is disabled. Please enable it.'

		/**
		 * Runs the chain to completion with the named step refusing, and returns the exact `File` it was
		 * driven with.
		 *
		 * Returning the file matters: `new File(...)` stamps `lastModified` at construction, so two calls
		 * to `csvStatementFile()` produce files that differ in identity. The record's key folds
		 * `lastModified` in on purpose — it is part of what distinguishes a retry of the SAME statement
		 * from a different one — so a test that re-derived the file would be asserting about a different
		 * upload. Re-selecting one file from disk is what these cases mean, and reusing the instance is
		 * what expresses it.
		 */
		const uploadRefusedAt = async (
			step: 'passphrase' | 'upload' | 'create',
			{ file = csvStatementFile(), passphrase = false } = {}
		) => {
			const refusal = makeServerMessagesError(REFUSAL)

			frappeUpdateDoc.mockResolvedValue(makeSelectedBank())
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: SERVER_NAMED_LOG }))

			if (step === 'passphrase') frappeUpdateDoc.mockRejectedValue(refusal)
			if (step === 'upload') frappeFileUpload.mockRejectedValue(refusal)
			if (step === 'create') frappeCreateDoc.mockRejectedValue(refusal)

			const rendered = renderImporter({ logs: [] })

			await chooseStatementFile(rendered.container, file)
			if (passphrase) {
				await userEvent.type(screen.getByLabelText('PDF Password'), PLACEHOLDER_PDF_PASSPHRASE)
			}
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			return { ...rendered, file }
		}

		it('surfaces the refusal through the shared dismissible dialog', async () => {
			await uploadRefusedAt('upload')

			const dialog = await screen.findByRole('alertdialog')

			// The server's own words, verbatim — the page paraphrases nothing.
			expect(within(dialog).getByText(REFUSAL)).toBeInTheDocument()
			expect(within(dialog).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
		})

		it('records a per-file failed row for the statement that has no log', async () => {
			await uploadRefusedAt('upload')

			// The indicator FM2 requires, for a file the server never gave a document to.
			const chip = await screen.findByText('Failed')
			const row = chip.closest<HTMLElement>('[data-slot="table-row"]')

			expect(row).not.toBeNull()
			// Identified by the only identity the reviewer can see: the file they chose.
			expect(within(row!).getByText('hdfc-statement-jan-2024.csv')).toBeInTheDocument()
			expect(chip).toHaveAttribute('aria-label', `Failed: ${REFUSAL}`)
		})

		it('invents no document data on that row', async () => {
			await uploadRefusedAt('upload')

			const row = (await screen.findByText('Failed')).closest<HTMLElement>('[data-slot="table-row"]')!

			// There is no document, so there is no import date, no range, no count and no balance.
			// Four dashes, not a fabricated zero balance or an empty date that reads as a real one.
			expect(within(row).getAllByText('-')).toHaveLength(4)
			// And no link, which would offer a download of a file that was never stored.
			expect(within(row).queryByRole('link')).not.toBeInTheDocument()
		})

		it('survives dismissing the dialog, which is the whole point of recording it', async () => {
			await uploadRefusedAt('upload')

			await screen.findByRole('alertdialog')
			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})

			// The dialog was raised at the moment of the attempt; the row is what remains afterwards.
			expect(screen.getByText('Failed')).toBeInTheDocument()
		})

		it('records a refusal of the passphrase save, which has no surface of its own', async () => {
			await uploadRefusedAt('passphrase', { file: pdfStatementFile(), passphrase: true })

			expect(await screen.findByText('Failed')).toBeInTheDocument()
			// The chain stopped at the refused step: nothing was uploaded and nothing was created.
			expect(frappeFileUpload).not.toHaveBeenCalled()
			expect(frappeCreateDoc).not.toHaveBeenCalled()
		})

		it('records a refusal to create the log, when the file is already stored', async () => {
			await uploadRefusedAt('create')

			expect(await screen.findByText('Failed')).toBeInTheDocument()
			// The file did reach storage, and the reviewer is still not handed to a log that
			// was never created.
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		it('keys the record by account and file, and scopes the row to the account on screen', async () => {
			const { store, file } = await uploadRefusedAt('upload')

			await screen.findByText('Failed')

			const recorded = [...store.get(bankRecPreLogImportFailuresAtom)]

			expect(recorded).toHaveLength(1)
			const [key, failure] = recorded[0]

			// The key is derived from the account AND the chosen file, so a retry of the same file
			// replaces this verdict while a different statement records its own.
			expect(key).toBe(preLogImportFailureKey(SELECTED_BANK.name, file))
			// Not merely account-scoped: a second statement on the same account keys differently.
			expect(key).not.toBe(preLogImportFailureKey(SELECTED_BANK.name, csvStatementFile('feb.csv')))
			expect(failure).toEqual({
				bankAccount: SELECTED_BANK.name,
				fileName: 'hdfc-statement-jan-2024.csv',
				message: REFUSAL
			})
		})

		it("does not show one account's pre-log failure on another account's screen", () => {
			// Recorded against a DIFFERENT bank account. The list is per-account, and a refusal on one
			// account says nothing about another — showing it here would be the same data-isolation
			// break the list filter exists to prevent.
			const otherAccountFailure: PreLogImportFailure = {
				bankAccount: 'Second Bank - Test Company',
				fileName: 'icici-statement-jan-2024.csv',
				message: REFUSAL
			}

			renderImporter({
				logs: [],
				preLogFailures: new Map([['second-account-key', otherAccountFailure]])
			})

			expect(screen.queryByText('Failed')).not.toBeInTheDocument()
			expect(screen.queryByText('icici-statement-jan-2024.csv')).not.toBeInTheDocument()
			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
		})

		it('retires the record when the same file is retried', async () => {
			const { container, store, file } = await uploadRefusedAt('upload')

			await screen.findByText('Failed')
			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

			// A fresh attempt at the same file must not leave a verdict standing while it is being
			// re-tested — the marker records one observation, and that observation is now stale.
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: SERVER_NAMED_LOG }))

			await chooseStatementFile(container, file)
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(await screen.findByText(detailViewFor(SERVER_NAMED_LOG))).toBeInTheDocument()
			expect(store.get(bankRecPreLogImportFailuresAtom).size).toBe(0)
		})

		it('replaces the record with the new reason when the retry is refused differently', async () => {
			const { container, store, file } = await uploadRefusedAt('upload')

			await screen.findByText('Failed')
			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

			const secondRefusal = 'No tables found in the PDF file'
			frappeFileUpload.mockRejectedValue(makeServerMessagesError(secondRefusal))

			await chooseStatementFile(container, file)
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect([...store.get(bankRecPreLogImportFailuresAtom).values()])
					.toEqual([expect.objectContaining({ message: secondRefusal })])
			})
			// One row, carrying the CURRENT reason — not two rows for one file.
			expect(screen.getAllByText('Failed')).toHaveLength(1)
			expect(await screen.findByText(secondRefusal)).toBeInTheDocument()
		})

		it('records nothing about transactions, because the client creates none', async () => {
			const { store } = await uploadRefusedAt('upload')

			await screen.findByText('Failed')

			// FM2: only the server creates Bank Transactions, and this path is reached when it did not.
			expect(frappeCreateDoc).not.toHaveBeenCalled()
			// The record carries the reason and the file's name, and nothing that looks like data.
			expect([...store.get(bankRecPreLogImportFailuresAtom).values()][0])
				.not.toHaveProperty('number_of_transactions')
		})

		it('leaves the button usable again, so a refusal is retryable', async () => {
			await uploadRefusedAt('upload')

			// Dismissed first, and not incidentally: the dialog is MODAL, so while it is open Radix
			// marks the page beneath it `aria-hidden` and disables pointer events on the body. The
			// control is therefore unreachable by design until the reviewer acknowledges the refusal —
			// which is also why "the guard was released" has to be asserted after the dismissal rather
			// than through the dialog.
			await screen.findByRole('alertdialog')
			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})

			// The single-flight guard is released on BOTH outcomes; a chain that failed and left the
			// control disabled would strand the reviewer with no way to try again.
			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()
			})
		})
	})

	/* ── The upload chain's call contract ────────────────────────────────────────────── */

	/**
	 * WHAT THE CHAIN SENDS, AND IN WHAT ORDER.
	 *
	 * The three operations of the upload chain are the most sensitive writes this SPA makes: one
	 * persists a statement PASSPHRASE on a Bank Account, one puts a customer's bank statement into
	 * file storage, and one creates the document the import will then run from. The rendering
	 * assertions above are satisfied by any arguments at all — they only ever observe that the chain
	 * resolved — so the arguments are asserted here, at the seam, because there is nowhere else they
	 * are visible.
	 *
	 * Each assertion below corresponds to something that would be a real defect and would otherwise
	 * be invisible: a passphrase written against the WRONG account, a statement uploaded PUBLICLY or
	 * attached to nothing, a log created for a DIFFERENT account or pointing at a different file than
	 * the one uploaded, the passphrase travelling somewhere it does not belong, and the chain pressing
	 * on after a step was refused.
	 */
	describe("the upload chain's call contract", () => {

		/** Runs the whole chain for a PDF with a passphrase typed, resolving every step. */
		const uploadProtectedPdf = async (): Promise<void> => {
			frappeUpdateDoc.mockResolvedValue(makeSelectedBank())
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			// The create answers with the identity the SERVER assigned — see SERVER_NAMED_LOG.
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: SERVER_NAMED_LOG }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())
			await userEvent.type(screen.getByLabelText('PDF Password'), PLACEHOLDER_PDF_PASSPHRASE)
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(screen.getByText(detailViewFor(SERVER_NAMED_LOG))).toBeInTheDocument()
			})
		}

		/**
		 * The chain issues TWO document updates through one hook — the passphrase onto the `Bank
		 * Account`, and the `File` relink that F-15 added — so every assertion about either has to name
		 * the doctype it means. Selecting by doctype rather than by call index also keeps these
		 * assertions independent of the order the two writes happen to be issued in.
		 */
		const updateCallsFor = (doctype: string) =>
			frappeUpdateDoc.mock.calls.filter(([called]) => called === doctype)

		it('saves the passphrase on the SELECTED bank account, and only there', async () => {
			await uploadProtectedPdf()

			// One write, to one account, carrying one field. A wrong name here would store this
			// account's passphrase against another company's bank account.
			expect(updateCallsFor('Bank Account')).toHaveLength(1)
			expect(frappeUpdateDoc).toHaveBeenCalledWith(
				'Bank Account',
				SELECTED_BANK.name,
				{ statement_password: PLACEHOLDER_PDF_PASSPHRASE }
			)
		})

		/**
		 * PRIVATE, and — ⚠️ F-15 — UNATTACHED.
		 *
		 * `isPrivate` is the whole of the access control on a stored bank statement: a public file url is
		 * readable by anyone who has it, signed in or not.
		 *
		 * The absence of `doctype`/`docname`/`fieldname` is the fix. The upload used to be attached to a
		 * client-minted `new-bank-statement-import-log-<timestamp>` name, on the assumption that the log
		 * would be created under it. It never was: `Bank Statement Import Log` is hash-autonamed, and
		 * Frappe's `set_new_name` discards a client-supplied name for every mode except `prompt` — so the
		 * server minted a hash and the `File` was left with `attached_to_name` pointing at a document that
		 * would never exist. The identity is now the server's to mint, and the file is relinked to it
		 * afterwards (asserted below).
		 */
		it('uploads the chosen file PRIVATELY and UNATTACHED, leaving the identity to the server', async () => {
			await uploadProtectedPdf()

			expect(frappeFileUpload).toHaveBeenCalledTimes(1)

			const [uploadedFile, args] = frappeFileUpload.mock.calls[0]

			// The file the user chose, not a re-read or a re-encoding of it.
			expect(uploadedFile).toBeInstanceOf(File)
			expect(uploadedFile.name).toBe('hdfc-statement-jan-2024.pdf')

			expect(args.isPrivate).toBe(true)
			// No attachment target is claimed up front, because none is known yet.
			expect(args.docname).toBeUndefined()
			expect(args.doctype).toBeUndefined()
			expect(args.fieldname).toBeUndefined()
			// And in particular, no invented one — the exact shape that produced the orphan.
			expect(JSON.stringify(args)).not.toContain('new-bank-statement-import-log')
		})

		it('creates the log for the selected account, from the url the server returned', async () => {
			await uploadProtectedPdf()

			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)

			const [createdDoctype, createdPayload] = frappeCreateDoc.mock.calls[0]

			expect(createdDoctype).toBe(IMPORT_LOG_DOCTYPE)
			// The URL the SERVER returned for the stored file — private, and never a client-built path.
			expect(createdPayload).toMatchObject({
				file: makeFileUploadResponse().file_url,
				bank_account: SELECTED_BANK.name
			})
			/*
			 * ⚠️ F-15: NO `name` IS SUPPLIED. Sending one was not merely useless, it was the source of
			 * the orphaned attachment: the server discards it under `autoname: hash`, so the client and
			 * the server disagreed about the log's identity from the moment it was created.
			 */
			expect(createdPayload).not.toHaveProperty('name')
			expect(JSON.stringify(createdPayload)).not.toContain('new-bank-statement-import-log')
		})

		/**
		 * ⚠️ F-15, the half that repairs the linkage: the private `File` is pointed at the name the
		 * SERVER chose, using the update `File.validate_attachment_references` permits.
		 *
		 * Without this the statement is stored and importable but is not among the log's attachments and
		 * does not share its lifecycle — deleting the log leaves the private file behind.
		 */
		it('relinks the private file to the identity the server minted', async () => {
			await uploadProtectedPdf()

			expect(updateCallsFor('File')).toHaveLength(1)

			const [, fileName, patch] = updateCallsFor('File')[0]

			// The File document the upload answered with — not its url, and not the statement's filename.
			expect(fileName).toBe(makeFileUploadResponse().name)
			expect(patch).toEqual({
				attached_to_doctype: IMPORT_LOG_DOCTYPE,
				attached_to_name: SERVER_NAMED_LOG,
				attached_to_field: 'file'
			})
		})

		it('relinks to the created log, not to a fixed or stale name', async () => {
			// Derivation, proven by changing the input: a second run against a different server-minted
			// name must relink to THAT name. A hard-coded target passes the test above and fails here.
			const otherName = 'BSIL-SERVER-OTHER-0002'

			frappeUpdateDoc.mockResolvedValue(makeSelectedBank())
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: otherName }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await screen.findByText(detailViewFor(otherName))

			expect(updateCallsFor('File')[0][2]).toMatchObject({ attached_to_name: otherName })
		})

		/*
		 * ════════════════════════════════════════════════════════════════════════════════════════════
		 * SEC-09 — THE UPLOADED PRIVATE FILE HAS A LIFECYCLE, AND THE CHAIN OWES IT ONE
		 *
		 * `file` is `reqd: 1` on `Bank Statement Import Log`, so the statement MUST be uploaded before
		 * the log that owns it can exist. That leaves two windows, and each one used to be a way for a
		 * private copy of the reviewer's bank statement to escape every lifecycle that would ever remove
		 * it again:
		 *
		 *   • the log insert is REFUSED — the `File` is left attached to nothing, invisible in the UI,
		 *     outside any log's erasure path, and nobody is told it exists; and
		 *   • the RELINK is refused — the `File` is stored and the import works, but the statement is
		 *     not among the log's attachments, so deleting the log does not take it with it, and the
		 *     only record of that was a development-only console line.
		 *
		 * The previous version of this suite asserted the second case showed NOTHING at all, which made
		 * expected behaviour out of a lifecycle defect. Both windows are specified below instead.
		 * ════════════════════════════════════════════════════════════════════════════════════════════ */

		/** Every `deleteDoc` call made against one doctype. */
		const deleteCallsFor = (doctype: string) =>
			frappeDeleteDoc.mock.calls.filter(([called]) => called === doctype)

		it('deletes the unattached private file when the import log cannot be created', async () => {
			const refusal = makeServerMessagesError('Not permitted to create Bank Statement Import Log')
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockRejectedValue(refusal)

			const { container, store } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
			})

			// The orphan is removed, and it is the File the UPLOAD returned — not its url, and not the
			// statement's own filename.
			expect(deleteCallsFor('File')).toHaveLength(1)
			expect(deleteCallsFor('File')[0][1]).toBe(makeFileUploadResponse().name)

			// The reviewer is told what the SERVER refused, never about the cleanup: the insert failure is
			// the actionable one, and the file is something they never knew existed.
			expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
			expect(screen.queryByText(detailViewFor(SERVER_NAMED_LOG))).not.toBeInTheDocument()
		})

		it('reports the SERVER\'s refusal even when the cleanup is itself refused', async () => {
			// The cleanup is best-effort. Its own failure must not displace the message the reviewer can
			// act on, and must not turn a refused import into a refused delete.
			const refusal = makeServerMessagesError('Invalid Bank Account')
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockRejectedValue(refusal)
			frappeDeleteDoc.mockRejectedValue(makeServerMessagesError('Not permitted to delete File'))

			const { container, store } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
			})

			// The pre-log failure row records the ORIGINAL refusal, so the chip's tooltip and the dialog
			// agree, and neither mentions the delete.
			const failures = store.get(bankRecPreLogImportFailuresAtom)
			expect(failures.size).toBe(1)
			expect([...failures.values()][0].message).toContain('Invalid Bank Account')
			expect([...failures.values()][0].message).not.toContain('delete')
		})

		it('does not delete the file when the log WAS created', async () => {
			// Non-vacuous companion to the two above: the cleanup must be reachable only from the failure
			// branch. A delete on the success path would destroy the statement the import is about to read.
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: SERVER_NAMED_LOG }))
			frappeUpdateDoc.mockResolvedValue(makeSelectedBank())

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await screen.findByText(detailViewFor(SERVER_NAMED_LOG))

			expect(frappeDeleteDoc).not.toHaveBeenCalled()
		})

		it('RETRIES a refused relink once before giving up on it', async () => {
			// The two plausible causes have opposite prognoses — a lost connection or a lock contended by
			// the insert that has only just committed succeeds on a second attempt, while a missing write
			// permission fails identically — so one retry distinguishes them for the cost of one request.
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: SERVER_NAMED_LOG }))
			frappeUpdateDoc.mockRejectedValue(makeServerMessagesError('Not permitted to edit File'))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await screen.findByText(detailViewFor(SERVER_NAMED_LOG))

			expect(updateCallsFor('File')).toHaveLength(2)
			// Both attempts target the same File and the same server-minted log.
			expect(updateCallsFor('File')[1][1]).toBe(makeFileUploadResponse().name)
			expect(updateCallsFor('File')[1][2]).toMatchObject({ attached_to_name: SERVER_NAMED_LOG })
		})

		it('stops retrying as soon as the relink succeeds', async () => {
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: SERVER_NAMED_LOG }))
			frappeUpdateDoc
				.mockRejectedValueOnce(makeServerMessagesError('Document has been modified'))
				.mockResolvedValue(makeSelectedBank())

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await screen.findByText(detailViewFor(SERVER_NAMED_LOG))

			expect(updateCallsFor('File')).toHaveLength(2)
			// A transient refusal is recovered, so there is nothing left to warn about.
			expect(toastWarning).not.toHaveBeenCalled()
		})

		it('surfaces an ACTIONABLE warning when the relink cannot be completed', async () => {
			// The replacement for the assertion that used to demand silence here. The reviewer's upload
			// succeeded and the import is unaffected, so this is a warning rather than an error — but it
			// has to name the log, because that identity is what lets somebody attach the file by hand and
			// bring it back inside the log's erasure lifecycle.
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: SERVER_NAMED_LOG }))
			frappeUpdateDoc.mockRejectedValue(makeServerMessagesError('Not permitted to edit File'))

			const { container, store } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await screen.findByText(detailViewFor(SERVER_NAMED_LOG))

			expect(toastWarning).toHaveBeenCalledTimes(1)
			const [warning, options] = toastWarning.mock.calls[0]
			expect(warning).toBe('The statement file could not be linked to its import log.')
			expect((options as { description: string }).description).toContain(SERVER_NAMED_LOG)

			// Still NOT an import failure: the log exists, its `file` field holds the url, and the import
			// reads that url. Marking the file Failed would assert a refusal that did not happen, and
			// blocking the hand-off would strand a reviewer whose upload in fact succeeded.
			expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			expect(store.get(bankRecPreLogImportFailuresAtom).size).toBe(0)
			expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			expect(screen.queryByText('Failed')).not.toBeInTheDocument()
		})

		it('navigates to the name the SERVER returned, never to a client-minted one', async () => {
			await uploadProtectedPdf()

			expect(screen.getByText(detailViewFor(SERVER_NAMED_LOG))).toBeInTheDocument()
			// The identity that used to be minted here is now nowhere in the chain at all.
			expect(screen.queryByText(/new-bank-statement-import-log/)).not.toBeInTheDocument()
		})

		it('keeps the passphrase out of the upload and out of the import log', async () => {
			await uploadProtectedPdf()

			// The passphrase belongs to the Bank Account, which stores it encrypted, and to nothing
			// else. Serialising each payload is the only way to prove it is absent from ALL of it
			// rather than merely absent from the field somebody thought to check.
			const uploadArgs = JSON.stringify(frappeFileUpload.mock.calls[0][1])
			const createPayload = JSON.stringify(frappeCreateDoc.mock.calls[0][1])

			expect(uploadArgs).not.toContain(PLACEHOLDER_PDF_PASSPHRASE)
			expect(createPayload).not.toContain(PLACEHOLDER_PDF_PASSPHRASE)
			expect(createPayload).not.toContain('statement_password')

			// Nor does it reach the route, where it would land in browser history.
			expect(screen.queryByText(new RegExp(PLACEHOLDER_PDF_PASSPHRASE))).not.toBeInTheDocument()
		})

		it('never writes a passphrase for a statement that has no password field', async () => {
			// The field is offered for PDFs only, so a CSV upload must not touch the Bank Account at
			// all — writing a blank passphrase would clear the one the account already had.
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00012' }))
			// Configured so the F-15 relink SUCCEEDS first time. Left unconfigured it rejects, which the
			// relink then retries once — making the `File` call count a statement about the retry rather
			// than about the passphrase this test is actually about.
			frappeUpdateDoc.mockResolvedValue(makeSelectedBank())

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			expect(screen.queryByLabelText('PDF Password')).not.toBeInTheDocument()

			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
			await screen.findByText(detailViewFor('BSIL-2024-00012'))

			// Scoped to the doctype rather than to the hook: the chain legitimately updates `File` on
			// every path (the F-15 relink), so "no passphrase was written" is a claim about `Bank
			// Account` specifically. A blanket assertion here would have to be deleted rather than
			// tightened, and would stop guarding anything.
			expect(updateCallsFor('Bank Account')).toHaveLength(0)
			expect(updateCallsFor('File')).toHaveLength(1)
		})

		it('writes no passphrase for a PDF whose password field was left blank', async () => {
			// Blank means "use whatever the account already has", so there is nothing to save.
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00013' }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())
			expect(screen.getByLabelText('PDF Password')).toHaveValue('')

			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
			await screen.findByText(detailViewFor('BSIL-2024-00013'))

			expect(updateCallsFor('Bank Account')).toHaveLength(0)
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
		})

		/*
		 * SEQUENCING, asserted without a rejection.
		 *
		 * Each step must await the previous one: uploading a protected statement the server has no
		 * password for creates a log whose import can only fail, and creating a log for a file that was
		 * never stored hands the reviewer a document pointing at nothing. Holding a step unsettled
		 * proves the chain is chained rather than fired in parallel, and it isolates the sequencing
		 * question from the failure-handling one: a refusal would also exercise the F-03 handler and the
		 * dialog it raises, which are asserted on their own terms elsewhere.
		 */
		it('uploads nothing until the passphrase has been stored', async () => {
			frappeUpdateDoc.mockReturnValue(new Promise(() => undefined))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())
			await userEvent.type(screen.getByLabelText('PDF Password'), PLACEHOLDER_PDF_PASSPHRASE)
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(frappeUpdateDoc).toHaveBeenCalledTimes(1)
			expect(frappeFileUpload).not.toHaveBeenCalled()
			expect(frappeCreateDoc).not.toHaveBeenCalled()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		it('creates no log until the statement has been stored', async () => {
			frappeFileUpload.mockReturnValue(new Promise(() => undefined))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).not.toHaveBeenCalled()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		it('navigates only once the log itself has been created', async () => {
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockReturnValue(new Promise(() => undefined))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
			})
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
			expect(screen.getByText('Previous Imports')).toBeInTheDocument()
		})

		/*
		 * ⚠️ F-12. ONE CHAIN PER CLICK, INCLUDING THROUGH THE WINDOW NO HOOK FLAG COVERS.
		 *
		 * The chain's first step may be a server round-trip — the PDF passphrase save — and for the whole
		 * of it none of the hook `loading` flags is set: `upload` has not been called, `createDoc` has not
		 * been called, and `updateDoc`'s own flag was not even read. The button was therefore LIVE while a
		 * chain was already running, and a second click ran a second complete chain: a second private
		 * `File` uploaded and a second `Bank Statement Import Log` created for one statement, of which the
		 * reviewer was navigated to exactly one and never learned about the other. The orphan then sat in
		 * the list at `Not Started`, inviting someone to import the same statement twice.
		 *
		 * Two independent mechanisms are asserted below because the fix needs both, and each covers a case
		 * the other cannot:
		 *   • the DISABLED state stops a click a human could make, and is what makes the state visible;
		 *   • the REF stops two clicks dispatched in one tick, which the disabled state cannot, because
		 *     React has not re-rendered between them and a state read would hand the second click the
		 *     pre-click snapshot.
		 */
		describe('at most one chain per click (F-12)', () => {

			/** Leaves the passphrase save unsettled: the chain is open, no hook flag says so. */
			const openChainOnPendingPassphrase = async () => {
				frappeUpdateDoc.mockReturnValue(new Promise(() => undefined))

				const { container } = renderImporter({ logs: [] })

				await chooseStatementFile(container, pdfStatementFile())
				await userEvent.type(screen.getByLabelText('PDF Password'), PLACEHOLDER_PDF_PASSPHRASE)
				await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

				return container
			}

			it('disables the control while a chain is open, which no hook flag reports', async () => {
				await openChainOnPendingPassphrase()

				// Every hook is reporting `loading: false` here — the shared mock's default — so this
				// assertion can only pass on state that tracks the CHAIN rather than any single request.
				expect(screen.getByRole('button', { name: 'Uploading...' })).toBeDisabled()
				expect(screen.queryByRole('button', { name: 'Upload' })).not.toBeInTheDocument()
			})

			it('ignores a second click while the passphrase save is still pending', async () => {
				await openChainOnPendingPassphrase()

				await userEvent.click(screen.getByRole('button', { name: 'Uploading...' }))

				// One passphrase write, and — decisively — the second chain never got past its first step.
				expect(updateCallsFor('Bank Account')).toHaveLength(1)
				expect(frappeFileUpload).not.toHaveBeenCalled()
				expect(frappeCreateDoc).not.toHaveBeenCalled()
			})

			/*
			 * THE RACE ITSELF, and the only case the disabled attribute cannot cover.
			 *
			 * Both clicks are dispatched inside ONE `act`, so React re-renders after both have already
			 * run and the DOM still says `disabled={false}` when the second arrives. That is the real
			 * double-submit: a double-click, a stuck pointer, an assistive tool that re-fires. Only a
			 * synchronously mutated ref stops it.
			 */
			it('starts one chain for two clicks delivered in the same tick', async () => {
				frappeFileUpload.mockReturnValue(new Promise(() => undefined))

				const { container } = renderImporter({ logs: [] })

				await chooseStatementFile(container, csvStatementFile())

				const button = screen.getByRole('button', { name: 'Upload' })
				expect(button).toBeEnabled()

				await act(async () => {
					button.click()
					button.click()
				})

				expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			})

			it('starts one chain for three clicks in the same tick, on the passphrase path too', async () => {
				// The longer path, and more clicks: a guard that merely de-duplicated adjacent pairs, or
				// that only covered the upload step, passes the test above and fails here.
				frappeUpdateDoc.mockReturnValue(new Promise(() => undefined))

				const { container } = renderImporter({ logs: [] })

				await chooseStatementFile(container, pdfStatementFile())
				await userEvent.type(screen.getByLabelText('PDF Password'), PLACEHOLDER_PDF_PASSPHRASE)

				const button = screen.getByRole('button', { name: 'Upload' })

				await act(async () => {
					button.click()
					button.click()
					button.click()
				})

				expect(updateCallsFor('Bank Account')).toHaveLength(1)
			})

			it('releases the guard once a chain has settled, so the next statement can be uploaded', async () => {
				frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
				frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: SERVER_NAMED_LOG }))

				const { container } = renderImporter({ logs: [] })

				await chooseStatementFile(container, csvStatementFile())
				await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

				await screen.findByText(detailViewFor(SERVER_NAMED_LOG))

				// A guard that were never released would leave the page permanently unusable, which is a
				// worse failure than the one it was added to prevent.
				expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			})

			it("disables the control while the update hook itself reports a write", async () => {
				/*
				 * The other half of F-12: `updateDoc`'s `loading` is now part of the disabled expression.
				 * Asserted through the hook's own state, because it is reachable independently of the
				 * chain — a re-render arriving mid-write must not present the control as idle.
				 *
				 * A FILE HAS TO BE CHOSEN FIRST, and that is not incidental setup: `files.length === 0` is
				 * the first term of the same disabled expression, so without a file the control is
				 * disabled for a reason that has nothing to do with the flag under test, and the assertion
				 * passes whether or not `updateLoading` is in the expression at all. This is exactly how
				 * the first version of this test managed to be vacuous.
				 */
				installUpdateDocLoading()

				const { container } = renderImporter({ logs: [] })

				await chooseStatementFile(container, csvStatementFile())

				expect(screen.getByRole('button', { name: 'Uploading...' })).toBeDisabled()
			})

			it('is otherwise enabled once a file is chosen, so the guard above is not the file check', async () => {
				// The control case for the one above: same setup, hook idle, control enabled. Together they
				// show the disabled state tracks the write rather than the file.
				const { container } = renderImporter({ logs: [] })

				await chooseStatementFile(container, csvStatementFile())

				expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()
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
	 *   1. That the harness models the REAL DocPerm rows, so a narrowed profile is genuinely denied
	 *      rather than uniformly granted. Without this, every other suite's privileged profile would be
	 *      an unexamined assumption.
	 *   2. That this page is FAIL-CLOSED when the server refuses under such a profile: the refusal is
	 *      surfaced in the server's own words, the per-file record is written, and nothing is created,
	 *      navigated to, or presented as having succeeded.
	 *
	 * What it CANNOT prove is that the server refuses. That is the endpoint's own obligation and is
	 * exercised by the Python suites; the SDK is mocked here, so a refusal is something these tests
	 * INSTALL rather than something they discover.
	 * ════════════════════════════════════════════════════════════════════════════════════════════════ */
	describe('negative authorisation', () => {

		it('models the real DocPerm rows, so an Accounts User is genuinely denied the import log', () => {
			// The premise every other suite rests on. `Bank Statement Import Log` has permission rows for
			// System Manager only, so an accounting-only profile must come back denied on all four rights
			// while still holding the transaction rights its own role really does grant.
			installRoleProfile(['Accounts User'])

			expect(canReadDocument(IMPORT_LOG_DOCTYPE)).toBe(false)
			expect(canWriteDocument(IMPORT_LOG_DOCTYPE)).toBe(false)
			expect(canCreateDocument(IMPORT_LOG_DOCTYPE)).toBe(false)
			expect(canDeleteDocument(IMPORT_LOG_DOCTYPE)).toBe(false)

			// Non-vacuous: the profile is narrowed, not empty.
			expect(canReadDocument('Bank Transaction')).toBe(true)
		})

		it('denies by default when no role is held at all', () => {
			installRoleProfile([])

			expect(canReadDocument(IMPORT_LOG_DOCTYPE)).toBe(false)
			expect(canReadDocument('Bank Transaction')).toBe(false)
			expect(canReadDocument('Bank Account')).toBe(false)
		})

		it('grants the import log to System Manager, which is the only role that has it', () => {
			// The positive control for the two above: if this failed, "denied" would prove nothing.
			installRoleProfile(['System Manager'])

			expect(canReadDocument(IMPORT_LOG_DOCTYPE)).toBe(true)
			expect(canCreateDocument(IMPORT_LOG_DOCTYPE)).toBe(true)
		})

		it('is FAIL-CLOSED when the server refuses the upload chain under a narrowed profile', async () => {
			/*
			 * The behaviour that matters. Under an Accounts-User profile the server refuses the
			 * `Bank Statement Import Log` insert, and this page must report exactly that and nothing more:
			 * the refusal in the server's own words, a per-file record so the list shows the failure, no
			 * navigation to a log that does not exist, and no orphan private file left behind.
			 */
			installRoleProfile(['Accounts User'])

			const refusal = makeServerMessagesError('Insufficient Permission for Bank Statement Import Log')
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockRejectedValue(refusal)

			const { container, store } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
			})

			// The server's own wording, not a paraphrase.
			const failures = store.get(bankRecPreLogImportFailuresAtom)
			expect(failures.size).toBe(1)
			expect([...failures.values()][0].message).toContain('Insufficient Permission')

			// Nothing was reached that a refusal should not reach.
			expect(screen.queryByText(detailViewFor(SERVER_NAMED_LOG))).not.toBeInTheDocument()
			expect(frappeDeleteDoc).toHaveBeenCalledWith('File', makeFileUploadResponse().name)
		})

		it('is FAIL-CLOSED when the server refuses the log LIST under a narrowed profile', async () => {
			// The read is refused before any row exists, so the page must show the server's refusal and no
			// table at all - never an empty list, which would read as "this account has no imports".
			installRoleProfile(['Accounts User'])

			renderImporter({ logs: [], listError: makeServerMessagesError('Insufficient Permission for Bank Statement Import Log') })

			expect(await screen.findByText(/Insufficient Permission/)).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})
})
