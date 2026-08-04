/*
 * Colocated suite for the statement-importer page.
 *
 * WHAT IT PROVES.
 *   • TC1 — a statement import produces the expected list. This page's slice of that scenario is
 *     the "Previous Imports" table: every cell the row projects, in the order the SERVER returned
 *     the rows, plus the click-through to one log's detail view.
 *   • FM2 — the per-file failure indicator, in BOTH of the forms this page actually carries:
 *       – the per-ROW status chip, driven by a bank-scoped attempt marker, for a failure that
 *         happened after the import log existed; and
 *       – the per-FILE banner, driven by a file-keyed map, for a failure that happened BEFORE any
 *         log existed and therefore has no row to attach to.
 *     Both are read-only renderings of what the client observed; neither creates a transaction and
 *     neither overrides the document. The authoritative server `status` is asserted to WIN over a
 *     stale marker, and a stale marker is asserted to be RETIRED once the server reports the
 *     import as completed.
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
import { Suspense } from 'react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import {
	TEST_ALTERNATE_CURRENCY,
	TEST_BANK_ACCOUNT,
	TEST_COMPANY,
	TEST_CURRENCY,
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
	makeWarningServerMessagesError
} from '@/test/factories'

// The page imports four SDK hooks at module scope and its subtree reaches `useSWRConfig` through
// `BankPicker -> utils.ts`, so the package is replaced wholesale to keep every one of those seams
// resolvable and unable to reach a real transport.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankStatementImporter from './BankStatementImporter'
import ViewBankStatementImportLog from './ViewBankStatementImportLog'
import type { GetStatementDetailsResponse } from '@/components/features/BankStatementImporter/import_utils'
import {
	bankRecErrorDialogAtom,
	bankRecImportFailuresAtom,
	bankRecPreImportFailuresAtom,
	preImportFailureScopeKey,
	selectedBankAccountAtom,
	type ImportAttemptMarkers
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
const PREVIOUSLY_CREATED_LOG = 'g2ajb73e1l'

const SELECTED_BANK = makeSelectedBank()

/**
 * The scope key a pre-log failure is recorded under, composed through the application's own builder
 * so a fixture cannot key the map differently from the page that reads it.
 *
 * The company defaults to the harness's boot company, which is what `selectedCompanyAtom` initialises
 * itself from, so the default arguments describe the account this suite actually renders.
 */
const preImportFailureScope = (
	bankAccountName: string = SELECTED_BANK.name,
	companyName: string = TEST_COMPANY
): string => {
	const key = preImportFailureScopeKey(companyName, bankAccountName)

	if (!key) {
		throw new Error('A pre-log failure scope requires both a company and a bank account')
	}

	return key
}

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

/**
 * Markers for two of those four logs, nested by bank account exactly as the atom is. Built by
 * merging the shared factory's output rather than by hand, so the key derivation — the bank key is
 * read off each log's own `bank_account` — cannot drift from the rows it marks.
 */
const ATTEMPT_MARKERS: ImportAttemptMarkers = {
	[TEST_BANK_ACCOUNT]: {
		...makeImportFailures(FAILED_LOG, 'failed')[TEST_BANK_ACCOUNT],
		...makeImportFailures(INDETERMINATE_LOG, 'unknown')[TEST_BANK_ACCOUNT]
	}
}

interface ImporterScenario {
	/** What the list query answers with. `undefined` is the pre-arrival state, not a loading state. */
	logs?: BankStatementImportLog[]
	listError?: FrappeErrorFixture
	markers?: ImportAttemptMarkers
	dialogError?: FrappeErrorFixture
	/**
	 * Pre-log failures, nested by SCOPE (company + bank account) and then by file name, exactly as
	 * the atom is. Build the outer key with {@link preImportFailureScope} so a fixture cannot key it
	 * differently from the page.
	 */
	preImportFailures?: Record<string, Record<string, FrappeErrorFixture>>
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

/** The one query the page is allowed to recover an uncertain create with. */
const recoveryLookupFor = (fileUrl: string) => ({
	filters: [['file', '=', fileUrl]],
	fields: ['name'],
	orderBy: { field: 'creation', order: 'desc' },
	limit: 1
})

/**
 * Answers the recovery lookup the way the SERVER would: only for a query that filters on the exact
 * `file` url the upload returned, and only with the identity the server itself assigned. Every other
 * query gets `[]` — "no such log".
 *
 * ⚠️ ARGUMENT-SENSITIVE ON PURPOSE, AND THAT IS THE WHOLE POINT OF IT.
 *
 * A mock that resolved to a log regardless of its arguments would let the page recover by ANY key —
 * including a `new-bank-statement-import-log-…` name it minted itself, which a hash-autonamed
 * document can never be found under (see {@link SERVER_NAMED_LOG}). The suite would then pass while
 * production misread an applied create as never having happened, deleted the stored statement and
 * invited a retry that imported the same statement twice. Keying the answer to the statement's own
 * server-assigned url is what makes that mistake fail here: a lookup by anything else reads as
 * absence, and every assertion that follows from a hand-off then fails.
 *
 * Absence is expressed as an EMPTY ARRAY rather than a rejection because that is what a list query
 * does — which is also why the page uses one: a document read's 404 is indistinguishable from a
 * permission failure, while `[]` is a definite answer.
 */
const installImportLogRecoveryLookup = (fileUrl: string, foundLogName: string | null) => {
	frappeContextValue.db.getDocList.mockImplementation((doctype, args) =>
		Promise.resolve(
			doctype === IMPORT_LOG_DOCTYPE &&
				foundLogName !== null &&
				JSON.stringify(args) === JSON.stringify(recoveryLookupFor(fileUrl))
				? [{ name: foundLogName }]
				: []
		)
	)
}

/** Every argument the page has ever handed the recovery lookup, as one searchable string. */
const everyRecoveryLookupArgument = (): string =>
	JSON.stringify(frappeContextValue.db.getDocList.mock.calls)

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

// A store PER TEST is required because the harness performs no global atom reset and
// `selectedBankAccountAtom` is backed by `localStorage`.
const renderImporter = ({
	logs,
	listError,
	markers,
	dialogError,
	preImportFailures,
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
	if (preImportFailures) {
		store.set(bankRecPreImportFailuresAtom, preImportFailures)
	}

	const utils = render(
		<Provider store={store}>
			{/* The page mounts no local provider, so the `Unknown` chip's tooltip throws without this
			  * one; `App.tsx` supplies it outside the router in production. */}
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
	 * attribute is NOT stable across the four states. The `Unknown` chip is wrapped in a
	 * `TooltipTrigger asChild` so it can carry its explanation; Radix merges the trigger's own props
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
		 * ⚠️ THE F3 REGRESSION. The closing balance was formatted with no currency at all, so
		 * `formatCurrency` fell back to the SYSTEM default - invisible on an INR account, wrong on
		 * every other: a historical balance in USD was labelled `₹`.
		 *
		 * The log's own `currency` is the authority, and it has to be FETCHED to be usable. The query
		 * here answers with only the fields the page asked for, exactly as the server does, so a page
		 * that renders `item.currency` without projecting it gets `undefined` and falls back - failing
		 * this test rather than passing on a fixture's generosity.
		 */
		it('renders a historical balance in the LOG\u2019s currency, which it therefore has to project', () => {
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
			expect(row.queryByText(/₹/)).not.toBeInTheDocument()
		})

		it('renders a default-currency balance in that currency, from the same projected field', () => {
			renderImporter({ logs: [COMPLETED_LOG], projectQueriedFieldsOnly: true })

			// COMPLETED_LOG carries the harness's default currency, so this is the case the previous
			// implementation happened to get right - asserted here so the two are known to differ by
			// the field's VALUE rather than by which code path renders them.
			expect(COMPLETED_LOG.currency).toBe(TEST_CURRENCY)
			expect(within(rowFor(COMPLETED_LOG)).getByText('₹ 152,300.75')).toBeInTheDocument()
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
			// Exactly the nine fields the row projects — no `password`-bearing or unrelated field is
			// fetched "just in case", and none the row needs is missing. `currency` is one of the
			// nine because the row renders a monetary figure: without it `formatCurrency` falls back
			// to the system default and an account in another currency reports the wrong symbol.
			expect(args?.fields).toEqual([
				'name',
				'file',
				'status',
				'currency',
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
			// Pinned because the page compensates for it elsewhere: server truth retires client
			// markers from THIS fetch, so a change of revalidation policy changes when that happens.
			renderImporter({ logs: ALL_LOGS })

			const [, , , options] = importLogQueryCall()

			expect(options).toEqual({ revalidateOnFocus: false })
		})
	})

	describe('per-row status chip (FM2)', () => {

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
		})

		/**
		 * The failure indicator itself. It is driven from a marker rather than from the document
		 * because `Bank Statement Import Log` persists no error field and its status never advances
		 * past `Not Started` when a synchronous import rolls back — so the marker is the only
		 * failure signal that exists.
		 */
		it('marks a log the server refused as Failed', () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const badge = statusBadgeIn(rowFor(FAILED_LOG))

			expect(badge).toHaveAttribute('data-theme', 'red')
			// Solid rather than the subtle default, so the 12px label clears the WCAG AA contrast
			// floor in dark mode as well as light.
			expect(badge).toHaveAttribute('data-variant', 'solid')
			expect(badge).toHaveTextContent('Failed')
		})

		/*
		 * ⚠️ THE F4 REGRESSION - the per-file indicator for a file the SERVER could read no
		 * transactions from.
		 *
		 * The zero-row case used to be reported on the detail screen only: the Import control was
		 * disabled there and an inline alert explained why. `Bank Statement Import Log` has two status
		 * values and no error field, so the log stays at `Not Started` forever and THIS list presented
		 * an unusable file exactly like one merely waiting to be imported - the reviewer had to open
		 * each one to find out. FM2 requires the indicator here, so the server's own parse result is
		 * recorded as an `invalid` marker and rendered as a state of its own.
		 */
		it('marks a log whose file the server read no transactions from', () => {
			renderImporter({
				logs: [NOT_STARTED_LOG],
				markers: makeImportFailures(NOT_STARTED_LOG, 'invalid')
			})

			const badge = statusBadgeIn(rowFor(NOT_STARTED_LOG))

			expect(badge).toHaveAttribute('data-theme', 'red')
			expect(badge).toHaveAttribute('data-variant', 'solid')
			expect(badge).toHaveTextContent('No Transactions')
			// A statement about the FILE, not about an attempt: nothing was tried and nothing was
			// refused, so it must not read as either.
			expect(badge).not.toHaveTextContent('Failed')
			expect(badge).not.toHaveTextContent('Not Started')
		})

		it('explains the unusable file on the chip itself, and not by colour alone', async () => {
			renderImporter({
				logs: [NOT_STARTED_LOG],
				markers: makeImportFailures(NOT_STARTED_LOG, 'invalid')
			})

			const badge = statusBadgeIn(rowFor(NOT_STARTED_LOG))

			expect(badge.getAttribute('aria-label')).toContain('No Transactions')
			expect(badge.getAttribute('aria-label')).toContain('could not read any transactions from this file')
			expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
			// Reachable by keyboard as well as pointer, for the same reason as the indeterminate chip:
			// `asChild` hands the trigger role to a span, which Radix leaves out of the tab order.
			expect(badge.tabIndex).toBe(0)

			await userEvent.hover(badge)
			await waitFor(() => {
				expect(screen.getAllByText(/could not read any transactions from this file/).length)
					.toBeGreaterThan(0)
			})
		})

		it('lets an authoritative Completed status beat an invalid marker too', () => {
			// An import that took effect is history, not a problem - whatever the file turned out to
			// contain, the document is the record.
			renderImporter({
				logs: [COMPLETED_LOG],
				markers: makeImportFailures(COMPLETED_LOG, 'invalid')
			})

			const badge = statusBadgeIn(rowFor(COMPLETED_LOG))

			expect(badge).toHaveAttribute('data-theme', 'green')
			expect(badge).toHaveTextContent('Completed')
			expect(badge).not.toHaveTextContent('No Transactions')
		})

		/**
		 * "The client could not establish what happened" is a different claim from "the import did
		 * not happen", so it renders distinctly. `orange` is the compound variant that resolves to
		 * the amber surface tokens; the Badge primitive exposes no literal amber theme.
		 */
		it('distinguishes an indeterminate attempt from a refused one', () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const badge = statusBadgeIn(rowFor(INDETERMINATE_LOG))

			expect(badge).toHaveAttribute('data-theme', 'orange')
			expect(badge).toHaveTextContent('Unknown')
			expect(badge).not.toHaveTextContent('Failed')
		})

		/*
		 * `Unknown` is the one label that cannot carry its own meaning: it says only that the client
		 * could not find out, and the rest of the sentence lived in a dialog raised at the moment of
		 * the attempt, which the marker outlives. The explanation therefore has to travel with the
		 * chip for pointer, keyboard and assistive-technology users alike.
		 */
		describe('the indeterminate chip explains itself', () => {

			it('carries the whole explanation as its accessible name', () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				const label = statusBadgeIn(rowFor(INDETERMINATE_LOG)).getAttribute('aria-label')

				expect(label).toBeTruthy()
				expect(label).toContain('Unknown')
				expect(label).toContain('did not finish')
				// Outcome-INDETERMINATE wording, deliberately: the client not learning the answer is
				// not evidence the import did not happen, and calling it a failure would invite a
				// re-import of work that may already exist.
				expect(label).toContain('could not be established whether the server recorded it')
				expect(label).not.toMatch(/\bfailed\b/i)
			})

			it('carries a glyph, so it is not distinguished by colour alone', () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				const icon = statusBadgeIn(rowFor(INDETERMINATE_LOG)).querySelector('svg')

				expect(icon).toBeTruthy()
				expect(icon).toHaveAttribute('aria-hidden', 'true')
			})

			/*
			 * Radix renders a focusable button for a tooltip trigger BY DEFAULT, but `asChild` hands
			 * that role to the Badge span and Radix adds no `tabIndex` of its own - so without an
			 * explicit one the explanation is reachable by POINTER ONLY and a sighted keyboard-only
			 * reviewer has no route to it at all.
			 */
			it('is a keyboard tab stop, unlike the chips whose labels speak for themselves', () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				// The two chips carrying an explanation - this one and `No Transactions` - are tab
				// stops. `Completed`, `Failed` and `Not Started` each say what happened in the label
				// itself, so they add no tab stop for a reviewer to pass through.
				expect(statusBadgeIn(rowFor(INDETERMINATE_LOG)).tabIndex).toBe(0)
				expect(statusBadgeIn(rowFor(COMPLETED_LOG)).hasAttribute('tabindex')).toBe(false)
				expect(statusBadgeIn(rowFor(FAILED_LOG)).hasAttribute('tabindex')).toBe(false)
				expect(statusBadgeIn(rowFor(NOT_STARTED_LOG)).hasAttribute('tabindex')).toBe(false)
			})

			it('shows the explanation on hover', async () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				await userEvent.hover(statusBadgeIn(rowFor(INDETERMINATE_LOG)))

				await waitFor(() => {
					expect(screen.getAllByText(/could not be established whether the server recorded it/).length)
						.toBeGreaterThan(0)
				})
			})

			it('shows the same explanation on keyboard focus, with no pointer involved', async () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				const chip = statusBadgeIn(rowFor(INDETERMINATE_LOG))
				chip.focus()

				expect(chip).toHaveFocus()

				await waitFor(() => {
					expect(screen.getAllByText(/could not be established whether the server recorded it/).length)
						.toBeGreaterThan(0)
				})

				await waitFor(() => {
					expect(chip.getAttribute('aria-describedby')).toBeTruthy()
				})

				await userEvent.keyboard('{Escape}')
			})
		})

		it('leaves rows with no marker untouched', () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const unmarked = statusBadgeIn(rowFor(NOT_STARTED_LOG))

			expect(unmarked).not.toHaveAttribute('data-theme', 'red')
			expect(unmarked).not.toHaveAttribute('data-theme', 'orange')
		})

		/**
		 * Markers are nested by bank account, so one recorded against a DIFFERENT account must not
		 * reach this list. A flat map would have leaked here.
		 */
		it("ignores a marker recorded against another bank account", () => {
			renderImporter({
				logs: [NOT_STARTED_LOG],
				markers: makeImportFailures(
					makeBankStatementImportLog({
						name: NOT_STARTED_LOG.name,
						bank_account: 'Second Bank - Test Company'
					}),
					'failed'
				)
			})

			expect(statusBadgeIn(rowFor(NOT_STARTED_LOG))).toHaveAttribute('data-theme', 'gray')
		})

		/*
		 * A marker is an observation of one attempt; the document is the record. A fetched
		 * `Completed` status therefore wins, and the stale marker is retired so it cannot outlive the
		 * condition it described.
		 */
		it('lets an authoritative Completed status beat a stale failure marker, and retires it', async () => {
			const { store } = renderImporter({
				logs: [COMPLETED_LOG],
				markers: makeImportFailures(COMPLETED_LOG, 'failed')
			})

			const badge = statusBadgeIn(rowFor(COMPLETED_LOG))
			expect(badge).toHaveAttribute('data-theme', 'green')
			expect(badge).toHaveTextContent('Completed')
			expect(badge).not.toHaveTextContent('Failed')

			await waitFor(() => {
				expect(store.get(bankRecImportFailuresAtom)).toEqual({})
			})
		})

		it('retires only the completed log of the account this list queried', async () => {
			const { store } = renderImporter({
				logs: [COMPLETED_LOG],
				markers: {
					[TEST_BANK_ACCOUNT]: {
						...makeImportFailures(COMPLETED_LOG, 'failed')[TEST_BANK_ACCOUNT],
						...makeImportFailures(FAILED_LOG, 'failed')[TEST_BANK_ACCOUNT]
					}
				}
			})

			await waitFor(() => {
				expect(store.get(bankRecImportFailuresAtom)).toEqual({
					[TEST_BANK_ACCOUNT]: { [FAILED_LOG.name]: 'failed' }
				})
			})
		})
	})


	describe('per-file failure banner for a failure before any import log exists (FM2)', () => {

		/**
		 * The upload chain can fail while saving the statement password, while uploading the file or
		 * while creating the log — and in each case NO document exists, so no row could carry the
		 * outcome. The failure is attributed to the file name instead, which is the only identifier
		 * the attempt has.
		 */
		it("names the file and renders the server's own words for it", () => {
			const fileName = 'hdfc-statement-jan-2024.csv'
			const message = 'The uploaded file contains no transaction rows.'

			renderImporter({
				logs: [],
				preImportFailures: { [preImportFailureScope()]: { [fileName]: makeServerMessagesError(message) } }
			})

			expect(screen.getByText(`${fileName} could not be uploaded.`)).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()
		})

		it('creates no rows of its own — the list stays as the server reported it', () => {
			renderImporter({
				logs: [],
				preImportFailures: {
					[preImportFailureScope()]: {
						'hdfc-statement-jan-2024.csv': makeServerMessagesError('Invalid file type.')
					}
				}
			})

			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})

		/**
		 * Once a failure is attributed to a file, the unattributed hook banner is suppressed: it
		 * would otherwise print the identical normalised envelope a second time, without the file
		 * name that makes it useful.
		 */
		it('suppresses the unattributed hook banner it would otherwise duplicate', () => {
			const attributed = 'The uploaded file could not be parsed.'
			const unattributed = 'Unattributed upload-hook rejection.'

			renderImporter({
				logs: [],
				preImportFailures: { [preImportFailureScope()]: { 'hdfc-statement-jan-2024.csv': makeServerMessagesError(attributed) } },
				uploadError: makeServerMessagesError(unattributed)
			})

			expect(screen.getByText(attributed)).toBeInTheDocument()
			expect(screen.queryByText(unattributed)).not.toBeInTheDocument()
			expect(screen.getAllByRole('alert')).toHaveLength(1)
		})

		it('still shows the hook banner when no failure has been attributed to a file', () => {
			const unattributed = 'Unattributed upload-hook rejection.'

			renderImporter({ logs: [], uploadError: makeServerMessagesError(unattributed) })

			expect(screen.getByText(unattributed)).toBeInTheDocument()
			expect(screen.getByRole('alert')).toBeInTheDocument()
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
	 * These drive the page's OWN upload handler, because that handler is where the pre-log failure
	 * marker is written: seeding the atom proves the rendering, but only running the chain proves the
	 * attribution.
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
		 * FM2 end to end for the pre-log case: an empty or malformed file is refused by the SERVER,
		 * and the refusal is reported against the file by name, in the server's own words, with no
		 * row invented for it and no transaction created.
		 */
		it("attributes a server refusal to the file and repeats the server's words", async () => {
			const message = 'The uploaded statement contains no transactions.'
			frappeFileUpload.mockRejectedValue(makeServerMessagesError(message))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(
				await screen.findByText('hdfc-statement-jan-2024.csv could not be uploaded.')
			).toBeInTheDocument()

			const dialog = await screen.findByRole('alertdialog')
			expect(within(dialog).getByText(message)).toBeInTheDocument()

			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
			expect(frappeCreateDoc).not.toHaveBeenCalled()
		})

		/**
		 * A rejection carrying NO server envelope is a statement about the connection, not about the
		 * server. The page must therefore report an indeterminate outcome rather than claim the
		 * import failed — and must not leak the SDK's own `TypeError` text to the user.
		 */
		it('reports an outcome it cannot establish as indeterminate, not as a failure', async () => {
			const sdkInternalText = "Cannot read properties of undefined (reading 'data')"
			frappeFileUpload.mockRejectedValue(new TypeError(sdkInternalText))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(
				await screen.findByText('hdfc-statement-jan-2024.csv could not be uploaded.')
			).toBeInTheDocument()

			const dialog = await screen.findByRole('alertdialog')
			expect(
				within(dialog).getByText(/it is not known whether this request was recorded/)
			).toBeInTheDocument()
			expect(screen.queryByText(sdkInternalText)).not.toBeInTheDocument()
		})

		/**
		 * A retry supersedes whatever the previous attempt observed. The marker is keyed by file
		 * name and dropped before the retry is dispatched, so one file can never accumulate two
		 * reports and a superseded message cannot linger next to its replacement.
		 */
		it('supersedes a previous report when the same file is retried', async () => {
			const firstRefusal = 'The uploaded statement contains no transactions.'
			const secondRefusal = 'A statement for this period has already been imported.'

			frappeFileUpload
				.mockRejectedValueOnce(makeServerMessagesError(firstRefusal))
				.mockRejectedValueOnce(makeServerMessagesError(secondRefusal))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
			expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
			expect(screen.getAllByText(firstRefusal).length).toBeGreaterThan(0)

			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(screen.getAllByText(secondRefusal).length).toBeGreaterThan(0)
			})
			expect(screen.queryByText(firstRefusal)).not.toBeInTheDocument()
			expect(screen.getAllByText(/could not be uploaded\.$/)).toHaveLength(1)
		})

		/**
		 * A failure in the password step has no banner of its own, so it must still be attributed.
		 * That the chain also STOPS there — nothing uploaded, no log created — is asserted under
		 * "the upload chain's call contract" below, where the step's arguments live.
		 */
		it('attributes a failure in the statement-password step to the file as well', async () => {
			const message = 'Not permitted to update Bank Account.'
			frappeUpdateDoc.mockRejectedValue(makeServerMessagesError(message))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())

			const passwordField = screen.getByLabelText('PDF Password')
			await userEvent.type(passwordField, PLACEHOLDER_PDF_PASSPHRASE)
			expect(passwordField).toHaveValue(PLACEHOLDER_PDF_PASSPHRASE)

			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(
				await screen.findByText('hdfc-statement-jan-2024.pdf could not be uploaded.')
			).toBeInTheDocument()
			expect(within(await screen.findByRole('alertdialog')).getByText(message)).toBeInTheDocument()
		})

		/**
		 * A failure in the LAST step is the one with something already on the server: the file has
		 * been uploaded and only the log is missing. It must still be attributed and must still not
		 * hand the reviewer to a document that does not exist.
		 */
		it('attributes a failure in the log-creation step to the file as well', async () => {
			const message = 'Not permitted to create Bank Statement Import Log.'
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockRejectedValue(makeServerMessagesError(message))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(
				await screen.findByText('hdfc-statement-jan-2024.csv could not be uploaded.')
			).toBeInTheDocument()
			expect(within(await screen.findByRole('alertdialog')).getByText(message)).toBeInTheDocument()

			// No hand-off to a log that was never created.
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
		})
	})

	/* ── What becomes of a statement the server has already stored (F6, CWE-459) ─────── */

	/**
	 * ⚠️ THE ORPHANED-STATEMENT REGRESSION.
	 *
	 * The chain's middle step puts the reviewer's bank statement into file storage as a PRIVATE File;
	 * the last step creates the log that points at it. When the upload succeeded and only the create
	 * failed, the previous version left that File on the server belonging to nothing - and uploaded
	 * afresh on every retry, so each attempt stored another copy of the same customer statement and
	 * nothing ever removed any of them.
	 *
	 * What must happen instead depends on what the failure actually establishes, which is why the
	 * distinction between a server REFUSAL and a lost response is load-bearing here as well.
	 */
	describe('a stored statement is never left orphaned', () => {

		const uploadedFile = makeFileUploadResponse({ name: 'file-orphan-check', file_url: '/private/files/statement.csv' })

		const driveFailedUpload = async (options: { withFile?: File } = {}) => {
			const rendered = renderImporter({ logs: [] })

			await chooseStatementFile(rendered.container, options.withFile ?? csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			return rendered
		}

		it('deletes the stored statement when the server definitively refuses the log', async () => {
			frappeFileUpload.mockResolvedValue(uploadedFile)
			frappeCreateDoc.mockRejectedValue(makeServerMessagesError('Not permitted to create Bank Statement Import Log.'))
			frappeContextValue.db.deleteDoc.mockResolvedValue({ message: 'ok' })

			await driveFailedUpload()

			// The refusal came with a server envelope, so the log definitively does not exist and the
			// statement it would have belonged to has nothing left to belong to.
			await waitFor(() => {
				expect(frappeContextValue.db.deleteDoc).toHaveBeenCalledWith('File', uploadedFile.name)
			})
			// The server said no, so its answer is not second-guessed with a further read.
			expect(frappeContextValue.db.getDoc).not.toHaveBeenCalled()
		})

		it('re-uses the stored statement on a retry instead of uploading a second copy', async () => {
			frappeFileUpload.mockResolvedValue(uploadedFile)
			// A rejection with NO envelope: the client never learned whether the create landed.
			frappeCreateDoc.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'data')"))
			// ...and the reconciling read cannot settle it either.
			frappeContextValue.db.getDocList.mockRejectedValue(new TypeError('no response'))

			await driveFailedUpload()

			// Dismissed first: the error dialog is modal, so the form beneath it is inert until then.
			await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()
			})

			// Nothing is deleted while the outcome is unknown: the File may belong to a log that does
			// exist, and removing it would strip the statement off a real document.
			expect(frappeContextValue.db.deleteDoc).not.toHaveBeenCalled()

			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(frappeCreateDoc).toHaveBeenCalledTimes(2)
			})

			// ONE stored copy across both attempts, and both creates point at that SAME server url, so
			// the log that finally exists carries the statement already on the server.
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			const creates = frappeCreateDoc.mock.calls.map(([, doc]) => doc as { name?: string, file?: string })
			expect(creates.map((doc) => doc.file)).toEqual([uploadedFile.file_url, uploadedFile.file_url])

			// NEITHER create names the document. Asserting the two names merely MATCH would be
			// satisfied by both sending the same minted id — the defect itself — so what is asserted is
			// that no name is sent at all and the server assigns the identity both times.
			for (const doc of creates) {
				expect(doc).not.toHaveProperty('name')
			}
			expect(everyRecoveryLookupArgument()).not.toContain('new-bank-statement-import-log')
		})

		/**
		 * ⚠️ THE RESIDUAL DUPLICATE WINDOW, closed at the other end of the same question.
		 *
		 * An upload is only ever held for reuse when the previous chain ended WITHOUT establishing
		 * whether its create landed. Recovering at failure time cannot help there — by definition the
		 * server could not be asked — so the retry itself has to ask before it presses on. Without
		 * that, a reviewer whose first create actually applied gets a SECOND import log for the same
		 * statement, which is exactly the duplicate this whole block exists to prevent.
		 */
		it('recovers the earlier log on a retry instead of creating a second one for the same statement', async () => {
			frappeFileUpload.mockResolvedValue(uploadedFile)
			frappeCreateDoc.mockRejectedValue(new TypeError('no response'))
			// Unanswerable at failure time, so the upload is retained and the control reopens.
			frappeContextValue.db.getDocList.mockRejectedValue(new TypeError('no response'))

			await driveFailedUpload()

			await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()
			})

			// By the time the reviewer retries, the server can be reached again — and it turns out the
			// first create HAD applied.
			installImportLogRecoveryLookup(uploadedFile.file_url, PREVIOUSLY_CREATED_LOG)

			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			// The retry hands the reviewer to the log that already exists...
			await waitFor(() => {
				expect(screen.getByText(detailViewFor(PREVIOUSLY_CREATED_LOG))).toBeInTheDocument()
			})
			// ...creates no second one for the same statement, and stores no second copy of it.
			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(frappeContextValue.db.deleteDoc).not.toHaveBeenCalled()
		})

		/**
		 * ⚠️ THE ARGUMENT THAT MATTERS IS THE FILE ITSELF.
		 *
		 * The reuse branch exists to avoid storing a second copy of the SAME statement, and its only
		 * safety condition is the file-identity check. If that check were wrong — or absent — the
		 * February upload would be skipped and February's import log would be created from JANUARY's
		 * stored statement: the wrong customer statement imported against the reviewer's account,
		 * silently, with a correct-looking file name on screen.
		 *
		 * Asserting merely that a second upload happened, or that some generated argument changed,
		 * cannot see that. The two `File` objects are therefore compared BY IDENTITY, and then member
		 * by member so a failure names which part of the identity drifted rather than only that one
		 * did. The two statements differ in name, in content and therefore in size, so a stale
		 * January re-upload cannot satisfy any of it.
		 */
		it('uploads the NEWLY chosen file after a failure, never the previous one', async () => {
			const januaryStatement = csvStatementFile()
			const februaryStatement = csvStatementFile(
				'hdfc-statement-feb-2024.csv',
				'2024-02-19,RTGS credit received,98765.40'
			)

			frappeFileUpload.mockResolvedValue(uploadedFile)
			frappeCreateDoc.mockRejectedValue(new TypeError('no response'))
			// Unanswerable, so the first attempt's upload is RETAINED for reuse — which is precisely
			// the state in which a different file could be created from a previous file's upload.
			frappeContextValue.db.getDocList.mockRejectedValue(new TypeError('no response'))

			const { container } = await driveFailedUpload({ withFile: januaryStatement })

			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
			// A different statement must never be created from the previous one's upload.
			await chooseStatementFile(container, februaryStatement)
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(frappeFileUpload).toHaveBeenCalledTimes(2)
			})

			const [firstUploaded] = frappeFileUpload.mock.calls[0]
			const [secondUploaded] = frappeFileUpload.mock.calls[1]

			// The exact objects the reviewer chose, in the order they were chosen.
			expect(firstUploaded).toBe(januaryStatement)
			expect(secondUploaded).toBe(februaryStatement)
			expect(secondUploaded).not.toBe(firstUploaded)

			// Spelled out, so a re-upload of the stale statement under a fresh name still fails.
			expect(secondUploaded.name).toBe('hdfc-statement-feb-2024.csv')
			expect(secondUploaded.size).toBe(februaryStatement.size)
			expect(secondUploaded.size).not.toBe(januaryStatement.size)
			expect(secondUploaded.lastModified).toBe(februaryStatement.lastModified)
			expect(await secondUploaded.text()).toBe(await februaryStatement.text())
			expect(await secondUploaded.text()).not.toBe(await januaryStatement.text())

			// And neither upload names a document, so neither can be attached to one that will never
			// exist. See the "PRIVATELY, and attached to no document" assertion for why.
			for (const [, args] of frappeFileUpload.mock.calls) {
				expect(args.isPrivate).toBe(true)
				expect(args).not.toHaveProperty('docname')
			}
		})

		/**
		 * ⚠️ THE HASH-AUTONAME RECOVERY REGRESSION — the one this whole block turns on.
		 *
		 * A create can LAND and still reject: the request is applied and its acknowledgement is lost
		 * on the way back. The only safe way out of that is to ask the server what it actually holds —
		 * and the previous version asked the wrong question. It read back the
		 * `new-bank-statement-import-log-…` name this form had generated, which
		 * `Bank Statement Import Log`'s hash autoname rule had already discarded, so the read could
		 * only ever answer 404. An applied create was therefore reported as "never happened", the
		 * stored statement was deleted, and the reviewer was invited to retry — producing a SECOND
		 * import log for a statement already imported once, and with it a duplicate set of bank
		 * transactions.
		 *
		 * What must happen instead is a lookup by the one identity both sides agree on: the
		 * server-assigned url of the stored statement, which is exactly what the create writes onto
		 * the log. The mock answers ONLY that query, so this test fails if recovery searches by a
		 * minted name, by the File's document name, or by anything else.
		 */
		it('hands the reviewer to the log the SERVER named, when a lost response turns out to have created it', async () => {
			frappeFileUpload.mockResolvedValue(uploadedFile)
			frappeCreateDoc.mockRejectedValue(new TypeError('no response'))
			// The create DID land — under the name the server minted, which this client never saw.
			installImportLogRecoveryLookup(uploadedFile.file_url, PREVIOUSLY_CREATED_LOG)

			const { store } = await driveFailedUpload()

			// The reviewer lands on THAT log, by name, exactly where the success path would have taken
			// them. A hard-coded destination, the previous row's name or `undefined` cannot satisfy it.
			await waitFor(() => {
				expect(screen.getByText(detailViewFor(PREVIOUSLY_CREATED_LOG))).toBeInTheDocument()
			})

			// Reached by asking about the statement's own server-assigned url — once, with exactly
			// these arguments.
			expect(frappeContextValue.db.getDocList).toHaveBeenCalledTimes(1)
			expect(frappeContextValue.db.getDocList).toHaveBeenCalledWith(
				IMPORT_LOG_DOCTYPE,
				recoveryLookupFor(uploadedFile.file_url)
			)

			// And never by a name this client invented, which a hash-autonamed document cannot have.
			expect(everyRecoveryLookupArgument()).not.toContain('new-bank-statement-import-log')
			// Nor by a document read, whose 404 cannot distinguish "absent" from "could not ask".
			expect(frappeContextValue.db.getDoc).not.toHaveBeenCalled()

			// Nothing is orphaned — the statement belongs to a log that exists — so there is no error,
			// no file marked, and above all nothing deleted.
			expect(frappeContextValue.db.deleteDoc).not.toHaveBeenCalled()
			expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			expect(store.get(bankRecPreImportFailuresAtom)).toEqual({})
		})

		it('deletes the stored statement when the server reports no log for it', async () => {
			frappeFileUpload.mockResolvedValue(uploadedFile)
			frappeCreateDoc.mockRejectedValue(new TypeError('no response'))
			// A list query reports "none" as an EMPTY ARRAY, so absence arrives as DATA and settles the
			// question the other way round.
			installImportLogRecoveryLookup(uploadedFile.file_url, null)
			frappeContextValue.db.deleteDoc.mockResolvedValue({ message: 'ok' })

			await driveFailedUpload()

			await waitFor(() => {
				expect(frappeContextValue.db.deleteDoc).toHaveBeenCalledWith('File', uploadedFile.name)
			})
			expect(frappeContextValue.db.getDocList).toHaveBeenCalledWith(
				IMPORT_LOG_DOCTYPE,
				recoveryLookupFor(uploadedFile.file_url)
			)
			expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
			// There is no log, so there is nothing to hand the reviewer off to.
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		it('keeps the stored statement for reuse when the deletion itself fails', async () => {
			frappeFileUpload.mockResolvedValue(uploadedFile)
			frappeCreateDoc.mockRejectedValue(makeServerMessagesError('Not permitted to create Bank Statement Import Log.'))
			frappeContextValue.db.deleteDoc.mockRejectedValue(makeServerMessagesError('Not permitted to delete File.'))
			// The server refused the create outright, so no log exists for this statement — and the
			// retry's own preflight has to hear that from the server rather than assume it.
			installImportLogRecoveryLookup(uploadedFile.file_url, null)

			await driveFailedUpload()

			await waitFor(() => {
				expect(frappeContextValue.db.deleteDoc).toHaveBeenCalledTimes(1)
			})
			// A definitive refusal is not second-guessed with a read: the server already said no.
			expect(frappeContextValue.db.getDocList).not.toHaveBeenCalled()

			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(frappeCreateDoc).toHaveBeenCalledTimes(2)
			})

			// The copy is still on the server, so the retry re-uses it rather than adding a second.
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
		})

		it('has nothing to account for when the upload itself never landed', async () => {
			frappeFileUpload.mockRejectedValue(makeServerMessagesError('Invalid file type.'))

			await driveFailedUpload()

			expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
			// No statement reached the server, so there is nothing to reconcile and nothing to remove.
			expect(frappeContextValue.db.getDoc).not.toHaveBeenCalled()
			expect(frappeContextValue.db.deleteDoc).not.toHaveBeenCalled()
		})
	})

	/* ── Pre-log failures belong to the account they happened under (F8) ─────────────── */

	/**
	 * ⚠️ THE MISATTRIBUTION REGRESSION. Pre-log failures were keyed by FILE NAME alone, which is not
	 * an identity: the same statement name recurs across accounts and months. The consequences were
	 * all misattributions of financial context - one account's failure stayed on screen after
	 * switching to another, a same-named retry under a second account overwrote the first account's
	 * observation, and the suppression of the unattributed hook banners was computed across the whole
	 * map, so ONE stale marker anywhere silenced the inline error everywhere.
	 */
	describe('pre-log failures are scoped to the account they happened under', () => {

		const OTHER_BANK = 'Second Bank - Test Company'
		const SHARED_FILE_NAME = 'hdfc-statement-jan-2024.csv'

		it("shows this account's failure and not another account's", () => {
			renderImporter({
				logs: [],
				preImportFailures: {
					[preImportFailureScope()]: { [SHARED_FILE_NAME]: makeServerMessagesError('This account\u2019s refusal.') },
					[preImportFailureScope(OTHER_BANK)]: { 'other-statement.csv': makeServerMessagesError('Another account\u2019s refusal.') }
				}
			})

			expect(screen.getByText('This account\u2019s refusal.')).toBeInTheDocument()
			expect(screen.queryByText('Another account\u2019s refusal.')).not.toBeInTheDocument()
			expect(screen.queryByText('other-statement.csv could not be uploaded.')).not.toBeInTheDocument()
		})

		it('does not suppress this account\u2019s hook banner because another account has a failure', () => {
			const unattributed = 'Unattributed upload-hook rejection.'

			renderImporter({
				logs: [],
				preImportFailures: {
					[preImportFailureScope(OTHER_BANK)]: { [SHARED_FILE_NAME]: makeServerMessagesError('Another account\u2019s refusal.') }
				},
				uploadError: makeServerMessagesError(unattributed)
			})

			// Nothing has been attributed to a file IN THIS ACCOUNT, so the inline banner is the only
			// report the reviewer would get - suppressing it would leave the failure unreported.
			expect(screen.getByText(unattributed)).toBeInTheDocument()
		})

		it('records a failure under the current company and account', async () => {
			frappeFileUpload.mockRejectedValue(makeServerMessagesError('Invalid file type.'))

			const { container, store } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(Object.keys(store.get(bankRecPreImportFailuresAtom))).toEqual([preImportFailureScope()])
			})
			expect(Object.keys(store.get(bankRecPreImportFailuresAtom)[preImportFailureScope()]))
				.toEqual([SHARED_FILE_NAME])
		})

		it('retires only this account\u2019s observation of a same-named file on retry', async () => {
			const otherAccountsRefusal = makeServerMessagesError('Another account\u2019s refusal.')
			frappeFileUpload.mockRejectedValue(makeServerMessagesError('Invalid file type.'))

			const { container, store } = renderImporter({
				logs: [],
				preImportFailures: {
					[preImportFailureScope(OTHER_BANK)]: { [SHARED_FILE_NAME]: otherAccountsRefusal }
				}
			})

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(store.get(bankRecPreImportFailuresAtom)[preImportFailureScope()]).toBeDefined()
			})

			// The retry cleared its own scope's entry and re-recorded it; the other account's
			// observation of a file that merely shares a name is untouched.
			expect(store.get(bankRecPreImportFailuresAtom)[preImportFailureScope(OTHER_BANK)])
				.toEqual({ [SHARED_FILE_NAME]: otherAccountsRefusal })
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

		it('saves the passphrase on the SELECTED bank account, and only there', async () => {
			await uploadProtectedPdf()

			// One write, to one account, carrying one field. A wrong `docname` here would store this
			// account's passphrase against another company's bank account.
			expect(frappeUpdateDoc).toHaveBeenCalledTimes(1)
			expect(frappeUpdateDoc).toHaveBeenCalledWith(
				'Bank Account',
				SELECTED_BANK.name,
				{ statement_password: PLACEHOLDER_PDF_PASSPHRASE }
			)
		})

		/**
		 * ⚠️ PRIVATE, AND ATTACHED TO NOTHING — the second half of the hash-autoname defect.
		 *
		 * The upload used to be attached to the `new-bank-statement-import-log-…` name this form
		 * minted, on the assumption that the log would be created under it. It never is: the autoname
		 * rule discards that name, and the framework's relink (`relink_mismatched_files`) only runs
		 * for a save carrying Frappe's internal `__temporary_name`, which the Desk form sets and the
		 * REST resource endpoint the SDK posts to does not. So the customer's statement stayed attached
		 * to a document name that would never exist, AND `attach_files_to_document` — finding no
		 * UNATTACHED File for that url — inserted a SECOND File row for the real log. One orphaned copy
		 * of a bank statement plus one duplicate, on every single import.
		 *
		 * Uploading with no attachment target is what lets that same framework hook associate the file
		 * correctly: on the log's insert it matches the File whose attachment columns are all NULL and
		 * points it at the FINAL document, field and privacy. So the absence of these three arguments
		 * is the fix, and is asserted as such.
		 */
		it('uploads the chosen file PRIVATELY, and attached to no document at all', async () => {
			await uploadProtectedPdf()

			expect(frappeFileUpload).toHaveBeenCalledTimes(1)

			const [uploadedFile, args] = frappeFileUpload.mock.calls[0]

			// The file the user chose, not a re-read or a re-encoding of it.
			expect(uploadedFile).toBeInstanceOf(File)
			expect(uploadedFile.name).toBe('hdfc-statement-jan-2024.pdf')

			// `isPrivate` is the whole of the access control on the stored statement: a public file
			// URL is readable by anyone who has it, signed in or not.
			expect(args.isPrivate).toBe(true)
			// An unattached upload otherwise lands in `Home`, so the folder is named explicitly and the
			// stored statement stays where attachments live.
			expect(args.folder).toBe('Home/Attachments')

			// No attachment target of any kind — the condition the framework hook matches on.
			expect(args).not.toHaveProperty('doctype')
			expect(args).not.toHaveProperty('docname')
			expect(args).not.toHaveProperty('fieldname')
			// And nothing resembling a client-minted document name anywhere in the request.
			expect(JSON.stringify(args)).not.toContain('new-bank-statement-import-log')
		})

		it('creates the log WITHOUT naming it, for the selected account, from the url the server returned', async () => {
			await uploadProtectedPdf()

			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).toHaveBeenCalledWith(IMPORT_LOG_DOCTYPE, {
				// The URL the SERVER returned for the stored file — private, and never a client-built
				// path. It is also the only key the log can later be recovered by, which is why the
				// create must carry exactly the url the upload answered with.
				file: makeFileUploadResponse().file_url,
				bank_account: SELECTED_BANK.name
			})

			/*
			 * ⚠️ NO `name` KEY AT ALL.
			 *
			 * `Bank Statement Import Log` is hash-autonamed, so a supplied name is discarded on the
			 * way in — sending one changed nothing on the server and everything on the client, which
			 * then believed its own guess and read the document back by it. The payload equality above
			 * already forbids extra keys; this states the requirement outright so a regression reads as
			 * what it is rather than as an incidental shape mismatch.
			 */
			const [, createdPayload] = frappeCreateDoc.mock.calls[0]
			expect(createdPayload).not.toHaveProperty('name')
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

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			expect(screen.queryByLabelText('PDF Password')).not.toBeInTheDocument()

			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
			await screen.findByText(detailViewFor('BSIL-2024-00012'))

			expect(frappeUpdateDoc).not.toHaveBeenCalled()
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

			expect(frappeUpdateDoc).not.toHaveBeenCalled()
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
		})

		it('STOPS when the passphrase cannot be saved — nothing is uploaded and no log is created', async () => {
			// Pressing on would upload a protected statement the server has no password for, and
			// create a log whose import can only fail — after the reviewer has been navigated to it.
			frappeUpdateDoc.mockRejectedValue(makeServerMessagesError('Not permitted to update Bank Account.'))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())
			await userEvent.type(screen.getByLabelText('PDF Password'), PLACEHOLDER_PDF_PASSPHRASE)
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await screen.findByRole('alertdialog')

			expect(frappeFileUpload).not.toHaveBeenCalled()
			expect(frappeCreateDoc).not.toHaveBeenCalled()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		it('STOPS when the upload is refused — no log is created for a file that was not stored', async () => {
			frappeFileUpload.mockRejectedValue(makeServerMessagesError('Invalid file type.'))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await screen.findByRole('alertdialog')

			expect(frappeCreateDoc).not.toHaveBeenCalled()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})
	})

	/* ── Single flight across the whole chain ────────────────────────────────────────── */

	/**
	 * ONE CLICK, ONE CHAIN.
	 *
	 * The chain is three sequential server operations, and the control used to be held closed by the
	 * upload hook's and the create hook's own in-flight flags only. Neither describes the FIRST
	 * operation: the update hook's `loading` was never read, so for the whole duration of a
	 * protected-PDF passphrase save the control was enabled. A second click there started a second
	 * chain from the beginning, each chain uploaded its own copy of the statement, and BOTH completed —
	 * leaving two import logs for one file, each separately named by the server, with no same-file
	 * de-duplication anywhere to reconcile them. Importing from each then creates every transaction
	 * twice.
	 *
	 * FM4 forbids client-side de-duplication of transactions, which is exactly why this matters: the
	 * duplicates are not going to be cleaned up downstream. The single click has to stay single.
	 *
	 * Each test below holds one step of the chain open with a deferred promise — the only way to
	 * observe the window rather than race it — and then asserts both halves: the control is closed,
	 * and each operation ran at most once.
	 */
	describe('single flight across the whole chain', () => {

		/** A promise this test resolves by hand, so one step of the chain can be held open. */
		const deferred = <T,>() => {
			let resolve: (value: T) => void = () => undefined
			const promise = new Promise<T>((res) => { resolve = res })

			return { promise, resolve }
		}

		const uploadButton = (): HTMLElement => screen.getByRole('button', { name: /Upload/ })

		/**
		 * Clicks Upload again while a chain is in flight.
		 *
		 * `pointerEventsCheck` is disabled because the control carries
		 * `disabled:pointer-events-none`, which makes user-event refuse the interaction outright and
		 * report the harness's own objection instead of exercising the page. Turning the check off
		 * lets the click be delivered exactly as a rapid second press would deliver it, and leaves
		 * the page — not the test helper — to be the thing that refuses it.
		 */
		const clickUploadAgain = async (): Promise<void> => {
			await userEvent.click(uploadButton(), { pointerEventsCheck: 0 })
		}

		it('starts no second chain while the passphrase save is pending', async () => {
			const passwordSave = deferred<unknown>()
			frappeUpdateDoc.mockReturnValue(passwordSave.promise)
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00014' }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())
			await userEvent.type(screen.getByLabelText('PDF Password'), PLACEHOLDER_PDF_PASSPHRASE)
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			// THE WINDOW: the passphrase save is in flight and neither hook flag says so.
			expect(frappeUpdateDoc).toHaveBeenCalledTimes(1)
			expect(uploadButton()).toBeDisabled()
			expect(screen.getByRole('button', { name: 'Uploading...' })).toBeInTheDocument()

			await clickUploadAgain()
			await clickUploadAgain()

			// No second chain: the passphrase is not written twice, and nothing has run ahead.
			expect(frappeUpdateDoc).toHaveBeenCalledTimes(1)
			expect(frappeFileUpload).not.toHaveBeenCalled()
			expect(frappeCreateDoc).not.toHaveBeenCalled()

			// Releasing the step lets the ONE chain finish, proving the window was transient.
			await act(async () => {
				passwordSave.resolve(makeSelectedBank())
			})

			expect(await screen.findByText(detailViewFor('BSIL-2024-00014'))).toBeInTheDocument()
			expect(frappeUpdateDoc).toHaveBeenCalledTimes(1)
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
		})

		it('starts no second chain while the file upload is pending', async () => {
			const fileUpload = deferred<ReturnType<typeof makeFileUploadResponse>>()
			frappeFileUpload.mockReturnValue(fileUpload.promise)
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00015' }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => expect(frappeFileUpload).toHaveBeenCalledTimes(1))
			expect(uploadButton()).toBeDisabled()

			await clickUploadAgain()

			// One upload, and no log created from a file that has not finished being stored.
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).not.toHaveBeenCalled()

			await act(async () => {
				fileUpload.resolve(makeFileUploadResponse())
			})

			expect(await screen.findByText(detailViewFor('BSIL-2024-00015'))).toBeInTheDocument()
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
		})

		it('starts no second chain while the import log is being created', async () => {
			// The most expensive window to lose: a second chain here creates a SECOND log for the
			// same statement, and both survive.
			const logCreation = deferred<ReturnType<typeof makeBankStatementImportLog>>()
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockReturnValue(logCreation.promise)

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => expect(frappeCreateDoc).toHaveBeenCalledTimes(1))
			expect(uploadButton()).toBeDisabled()

			await clickUploadAgain()

			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)

			await act(async () => {
				logCreation.resolve(makeBankStatementImportLog({ name: 'BSIL-2024-00016' }))
			})

			expect(await screen.findByText(detailViewFor('BSIL-2024-00016'))).toBeInTheDocument()
			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
		})

		it('refuses a second entry dispatched inside the SAME batch as the first', async () => {
			/*
			 * The check-then-act race itself, which the `disabled` attribute cannot close: it is
			 * applied by a later render, and both handlers below run against the closure of the render
			 * that is already on screen. A guard reading component STATE would therefore see `false`
			 * twice and admit both chains. Two clicks are dispatched inside one `act` scope so they
			 * are processed before any re-render, which is the only way to reach that case.
			 */
			const fileUpload = deferred<ReturnType<typeof makeFileUploadResponse>>()
			frappeFileUpload.mockReturnValue(fileUpload.promise)
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00017' }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())

			const button = uploadButton()
			await act(async () => {
				button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
				button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
			})

			expect(frappeFileUpload).toHaveBeenCalledTimes(1)

			await act(async () => {
				fileUpload.resolve(makeFileUploadResponse())
			})

			// One file stored, one log created, one hand-off.
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
			expect(await screen.findByText(detailViewFor('BSIL-2024-00017'))).toBeInTheDocument()
		})

		it('reopens the control only for a chain that created nothing', async () => {
			// A refused chain leaves no log, so the retry is the reviewer's to make and the control
			// must come back. This is the counterpart to the tests above: the guard closes the window,
			// it does not lock the form.
			frappeFileUpload.mockRejectedValue(makeServerMessagesError('Invalid file type.'))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await screen.findByRole('alertdialog')

			// Dismissed first: an open alert dialog marks the rest of the page inert, so the control
			// is deliberately absent from the accessibility tree until the reviewer has acknowledged
			// the refusal.
			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})

			expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()

			// And a retry genuinely dispatches again rather than being swallowed by a stuck guard.
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => expect(frappeFileUpload).toHaveBeenCalledTimes(2))
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
})

/*
 * ─── FM2 END TO END: a backend outcome becomes a per-file indicator on THIS list ────────
 *
 * The cases above prove the list CONSUMES a marker. These prove one gets PRODUCED, by driving the
 * real producers rather than seeding the terminal state - which is the difference between "the chip
 * renders when told to" and "an empty or malformed statement is actually flagged".
 *
 * Both required outcomes are covered, and they fail in different places:
 *
 *   • the server parses the file and reports NO transactions in it. `get_statement_details` succeeds,
 *     the log's status is the truthful `Not Started`, and the statement-details step mounts - so the
 *     producer is that step.
 *   • the server REFUSES to produce the details at all, because parsing the file raised. The
 *     statement-details step never mounts, so its producer is unreachable and the detail-route owner
 *     has to be the one to record the outcome.
 *
 * Each test walks the reviewer's actual path: list -> row -> detail view -> Back -> list, and asserts
 * the row's chip is a plain `Not Started` BEFORE the visit and `Failed` after it. Asserting the
 * "before" state is what makes the "after" state attributable to the visit rather than to a fixture.
 */

const UNREADABLE_LOG = makeBankStatementImportLog({
	name: 'BSIL-2024-00005',
	file: '/files/hdfc-statement-may-2024.csv',
	status: 'Not Started',
	creation: '2024-05-06 11:20:00.000000',
	start_date: '2024-05-01',
	end_date: '2024-05-31',
	number_of_transactions: 0,
	closing_balance: 0
})

const GET_STATEMENT_DETAILS = 'erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log.get_statement_details'

/**
 * A `get_statement_details` response the server parsed successfully but found nothing importable in.
 * Every member is one the endpoint actually returns - the statement's currency is on `doc`, and there
 * is no top-level `currency`, because that is not part of the response.
 */
const zeroRowStatementDetails = (log: BankStatementImportLog): GetStatementDetailsResponse => ({
	doc: log,
	conflicting_transactions: [],
	final_transactions: [],
	date_format: '%d-%m-%Y',
	raw_data: []
})

/**
 * Renders the importer list with the REAL detail-route owner behind `:id`, so a click on a row mounts
 * the producer instead of a probe.
 *
 * `detailsResponse` and `detailsError` are the two shapes `get_statement_details` can answer with;
 * `rawLog` is what a direct document read returns, which is how the detail-route owner learns the bank
 * account and status when the parse-based endpoint has refused.
 */
const renderImporterWithRealDetailRoute = ({
	logs,
	detailsResponse,
	detailsError,
	detailsLoading = false,
	rawLog,
	markers
}: {
	logs: BankStatementImportLog[]
	detailsResponse?: GetStatementDetailsResponse
	detailsError?: FrappeErrorFixture
	detailsLoading?: boolean
	rawLog?: BankStatementImportLog
	markers?: ImportAttemptMarkers
}) => {
	installImportLogQuery(logs)

	frappeSDKMock.useFrappeGetCall.mockImplementation((method) => {
		if (method === GET_STATEMENT_DETAILS) {
			return {
				data: detailsResponse ? { message: detailsResponse } : undefined,
				error: detailsError,
				isLoading: detailsLoading,
				isValidating: false,
				mutate: frappeHookMutate
			}
		}
		return listQueryResponse()
	})

	frappeSDKMock.useFrappeGetDoc.mockImplementation((doctype) => ({
		data: doctype === IMPORT_LOG_DOCTYPE ? rawLog : undefined,
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: frappeHookMutate
	}))

	const store = createStore()
	store.set(selectedBankAccountAtom, SELECTED_BANK)
	if (markers) {
		store.set(bankRecImportFailuresAtom, markers)
	}

	const utils = render(
		<Provider store={store}>
			<TooltipProvider>
				<MemoryRouter initialEntries={[IMPORTER_ROUTE]}>
					<Routes>
						<Route path={IMPORTER_ROUTE}>
							<Route index element={<BankStatementImporter />} />
							{/*
							  * The real owner of this route in `App.tsx`, mounted here for the same
							  * reason: it is the only component that exists when the parse-based
							  * endpoint refuses, so it is the only place the outcome can be recorded.
							  * On the refusal path its lazy children are never reached, because that
							  * branch returns before them; on the zero-row path they ARE, so the
							  * boundary below is the one the container supplies in production.
							  */}
							<Route
								path=":id"
								element={
									/*
									 * The Suspense boundary `BankStatementImporterContainer` supplies in
									 * production, reproduced here for the same reason: the owner's
									 * success branch renders a lazily loaded import step.
									 */
									<Suspense fallback={<div>Loading import…</div>}>
										<ViewBankStatementImportLog />
									</Suspense>
								}
							/>
						</Route>
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</Provider>
	)

	return { ...utils, store }
}

describe('FM2 — a malformed or empty statement is flagged per file on the importer list', () => {

	const openRowAndReturn = async (log: BankStatementImportLog, assertDetailView: () => void) => {
		const user = userEvent.setup()

		// Before the visit: an ordinary, unflagged row.
		const badgeBefore = statusBadgeIn(rowFor(log))
		expect(badgeBefore).toHaveTextContent('Not Started')
		expect(badgeBefore).toHaveAttribute('data-theme', 'gray')

		await user.click(rowFor(log))
		await waitFor(assertDetailView)

		await user.click(screen.getByRole('link', { name: 'Back' }))
		await waitFor(() => {
			expect(screen.getByText('Previous Imports')).toBeInTheDocument()
		})
	}

	/**
	 * An EMPTY statement, in the form the backend actually reports one: the parse succeeded, so the
	 * detail route loads normally and the import step mounts - but the server found no transactions in
	 * the file, so there is nothing to import and never will be. That fact used to live only on the
	 * detail page, leaving the reviewer's route back showing an ordinary unflagged row.
	 *
	 * This walks the whole chain the reviewer walks: the list, the real detail-route owner, its lazily
	 * loaded import step, and back. Nothing is seeded.
	 */
	it('flags a file the server parsed but found no transactions in', async () => {
		const { store } = renderImporterWithRealDetailRoute({
			logs: [UNREADABLE_LOG],
			detailsResponse: zeroRowStatementDetails(UNREADABLE_LOG)
		})

		await openRowAndReturn(UNREADABLE_LOG, () => {
			expect(screen.getByText('No transactions found in this statement')).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Import 0 transactions' })).toBeDisabled()
		})

		/*
		 * `invalid`, not `failed`. The marker vocabulary distinguishes a statement about the FILE
		 * from a statement about an ATTEMPT: the server read this file and reported nothing
		 * importable in it (`invalid`, produced only through `classifyParsedStatement`), which is a
		 * permanent property of the file, whereas `failed` means the server refused a request. Both
		 * render a red per-file indicator, so FM2 is satisfied either way, but the reviewer is told
		 * which of the two it is - and only `invalid` carries the "there is nothing to import"
		 * explanation.
		 */
		expect(store.get(bankRecImportFailuresAtom)).toEqual(makeImportFailures(UNREADABLE_LOG, 'invalid'))

		const badgeAfter = statusBadgeIn(rowFor(UNREADABLE_LOG))
		expect(badgeAfter).toHaveTextContent('No Transactions')
		expect(badgeAfter).toHaveAttribute('data-theme', 'red')
	})

	/**
	 * The server refused to produce the statement's details, which is what a genuinely malformed file
	 * does: `get_statement_details` parses before it answers, so it raises and the import step never
	 * mounts at all. The reviewer sees the backend's own wording on the detail page, and the file is
	 * flagged on the list they return to.
	 */
	it('flags a file whose details the server refused to produce', async () => {
		const refusal = makeServerMessagesError('Please install pandas to import bank statements')

		const { store } = renderImporterWithRealDetailRoute({
			logs: [UNREADABLE_LOG],
			detailsError: refusal,
			rawLog: UNREADABLE_LOG
		})

		await openRowAndReturn(UNREADABLE_LOG, () => {
			// The backend's own message, not a client paraphrase.
			expect(screen.getByText('Please install pandas to import bank statements')).toBeInTheDocument()
		})

		// The marker was produced by the visit, scoped to this bank and this log.
		expect(store.get(bankRecImportFailuresAtom)).toEqual(makeImportFailures(UNREADABLE_LOG, 'failed'))

		const badgeAfter = statusBadgeIn(rowFor(UNREADABLE_LOG))
		expect(badgeAfter).toHaveTextContent('Failed')
		expect(badgeAfter).toHaveAttribute('data-theme', 'red')
	})

	/**
	 * A rejection carrying NO envelope is a statement about the connection, not about the server, so
	 * the outcome is `unknown` rather than `failed` - the client did not learn what happened and must
	 * not claim it did. The row is still flagged, distinctly, so the reviewer knows to go and look.
	 */
	it('reports an indeterminate outcome when the refusal carried no server envelope', async () => {
		const { store } = renderImporterWithRealDetailRoute({
			logs: [UNREADABLE_LOG],
			detailsError: new TypeError("Cannot read properties of undefined (reading 'data')") as unknown as FrappeErrorFixture,
			rawLog: UNREADABLE_LOG
		})

		await openRowAndReturn(UNREADABLE_LOG, () => {
			expect(screen.getByRole('alert')).toBeInTheDocument()
		})

		expect(store.get(bankRecImportFailuresAtom)).toEqual(makeImportFailures(UNREADABLE_LOG, 'unknown'))

		const badgeAfter = statusBadgeIn(rowFor(UNREADABLE_LOG))
		expect(badgeAfter).toHaveTextContent('Unknown')
		expect(badgeAfter).toHaveAttribute('data-theme', 'orange')
	})

	/**
	 * ⚠️ THE ORDERING HAZARD BETWEEN THE TWO PRODUCERS, CLOSED.
	 *
	 * React runs a child's effects BEFORE its parent's. Had the detail-route owner also retired
	 * markers when the details load, it would have run after the import step's zero-row effect and
	 * undone that marker on the very render that wrote it - and the bug would have been invisible in
	 * any test where the owner happens to hold no document. Here it explicitly DOES hold one, so the
	 * retirement branch would fire if it existed.
	 */
	it('keeps the zero-row marker even when the detail route also holds the document', async () => {
		const { store } = renderImporterWithRealDetailRoute({
			logs: [UNREADABLE_LOG],
			detailsResponse: zeroRowStatementDetails(UNREADABLE_LOG),
			rawLog: UNREADABLE_LOG
		})

		await openRowAndReturn(UNREADABLE_LOG, () => {
			expect(screen.getByText('No transactions found in this statement')).toBeInTheDocument()
		})

		expect(store.get(bankRecImportFailuresAtom)).toEqual(makeImportFailures(UNREADABLE_LOG, 'invalid'))
		expect(statusBadgeIn(rowFor(UNREADABLE_LOG))).toHaveTextContent('No Transactions')
	})

	/**
	 * A marker must never outlive the condition it described. Once whatever made the server refuse the
	 * details has been dealt with and the file reads normally, the row must stop claiming a failure -
	 * so the loaded case retires the marker the refused case wrote.
	 */
	it('retires a marker once the server can read the file again', async () => {
		const readableDetails: GetStatementDetailsResponse = {
			...zeroRowStatementDetails(UNREADABLE_LOG),
			final_transactions: [{
				date: '2024-05-04',
				withdrawal: 0,
				deposit: 1200,
				description: 'Salary credit',
				reference: 'NEFT/2024/000900'
			}]
		}

		const { store } = renderImporterWithRealDetailRoute({
			logs: [UNREADABLE_LOG],
			detailsResponse: readableDetails,
			markers: makeImportFailures(UNREADABLE_LOG, 'failed')
		})

		// The stale marker is what the reviewer starts from.
		expect(statusBadgeIn(rowFor(UNREADABLE_LOG))).toHaveTextContent('Failed')

		const user = userEvent.setup()
		await user.click(rowFor(UNREADABLE_LOG))
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Import 1 transactions' })).toBeEnabled()
		})

		await user.click(screen.getByRole('link', { name: 'Back' }))
		await waitFor(() => {
			expect(screen.getByText('Previous Imports')).toBeInTheDocument()
		})

		expect(store.get(bankRecImportFailuresAtom)).toEqual({})
		const badge = statusBadgeIn(rowFor(UNREADABLE_LOG))
		expect(badge).toHaveTextContent('Not Started')
		expect(badge).toHaveAttribute('data-theme', 'gray')
	})

	/**
	 * Loading and "nothing yet" are transient states of the detail route, and neither may be mistaken
	 * for an outcome: no marker may be recorded for either, or a reviewer would be told a file failed
	 * while its details were merely still arriving.
	 */
	it('records nothing while the details are still loading', async () => {
		const { store } = renderImporterWithRealDetailRoute({
			logs: [UNREADABLE_LOG],
			detailsLoading: true,
			rawLog: UNREADABLE_LOG
		})

		const user = userEvent.setup()
		await user.click(rowFor(UNREADABLE_LOG))

		await waitFor(() => {
			expect(screen.getByText('Loading...')).toBeInTheDocument()
		})
		expect(store.get(bankRecImportFailuresAtom)).toEqual({})
	})

	/**
	 * Server truth outranks a refusal, exactly as it does everywhere else in this model: if the
	 * document says the import completed, it completed, and no marker may be recorded however the
	 * parse-based endpoint behaved afterwards. The classifier enforces this, so the page cannot get it
	 * wrong on its own.
	 */
	it('records nothing when the document says the import already completed', async () => {
		const completedButUnreadable = makeBankStatementImportLog({
			...UNREADABLE_LOG,
			status: 'Completed'
		})

		const { store } = renderImporterWithRealDetailRoute({
			logs: [completedButUnreadable],
			detailsError: makeServerMessagesError('Please install pandas to import bank statements'),
			rawLog: completedButUnreadable
		})

		const user = userEvent.setup()
		await user.click(rowFor(completedButUnreadable))

		await waitFor(() => {
			expect(screen.getByRole('alert')).toBeInTheDocument()
		})
		expect(store.get(bankRecImportFailuresAtom)).toEqual({})
	})

	/**
	 * The PDF branch of the detail route reaches the same import step through a different wrapper, so
	 * the zero-row producer has to work there too - the format of the file has nothing to do with
	 * whether the server found transactions in it.
	 */
	it('flags an unreadable PDF statement through the PDF branch of the detail route', async () => {
		const pdfLog = makeBankStatementImportLog({
			...UNREADABLE_LOG,
			file: '/files/hdfc-statement-may-2024.pdf'
		})

		const { store } = renderImporterWithRealDetailRoute({
			logs: [pdfLog],
			detailsResponse: { ...zeroRowStatementDetails(pdfLog), pdf_tables: [] }
		})

		await openRowAndReturn(pdfLog, () => {
			expect(screen.getByText('No transactions found in this statement')).toBeInTheDocument()
		})

		expect(store.get(bankRecImportFailuresAtom)).toEqual(makeImportFailures(pdfLog, 'invalid'))
		expect(statusBadgeIn(rowFor(pdfLog))).toHaveTextContent('No Transactions')
	})

	it('records nothing when the details response carries neither data nor an error', async () => {
		const { store } = renderImporterWithRealDetailRoute({
			logs: [UNREADABLE_LOG],
			rawLog: UNREADABLE_LOG
		})

		const user = userEvent.setup()
		await user.click(rowFor(UNREADABLE_LOG))

		await waitFor(() => {
			expect(screen.queryByText('Previous Imports')).not.toBeInTheDocument()
		})
		expect(store.get(bankRecImportFailuresAtom)).toEqual({})
	})

	/**
	 * A log the server reports as `Completed` is never flagged, whatever a client marker says. This is
	 * the precedence rule the whole marker model rests on, asserted here against a marker the list is
	 * given rather than one it produced.
	 */
	it('lets a fetched Completed status outrank a stale marker', () => {
		renderImporter({ logs: [COMPLETED_LOG], markers: makeImportFailures(COMPLETED_LOG, 'failed') })

		const badge = statusBadgeIn(rowFor(COMPLETED_LOG))
		expect(badge).toHaveTextContent('Completed')
		expect(badge).toHaveAttribute('data-theme', 'green')
	})
})
