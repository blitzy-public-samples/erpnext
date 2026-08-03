/**
 * `StatementDetails` — the statement-import review step shared by the CSV and PDF flows.
 *
 * WHAT THIS SUITE OWNS
 *   • TC1 — importing a statement produces the expected transaction list: the preview table
 *     renders exactly what the SERVER parsed, the Import control posts the one document method,
 *     and the reconciliation range, cache invalidation and navigation all follow the server's
 *     own copy of the saved document.
 *   • FM2 — a malformed or refused import surfaces the BACKEND's error instead of discarding it,
 *     records a per-file marker, and creates no transaction client-side.
 *   • The realtime import-progress subscription.
 *   • The module-private `ConflictingTransactions` component.
 *
 * FM1, FM3, FM4 and FM5 belong to the reconciliation workbench and are covered beside it; they
 * are deliberately not restated here.
 *
 * ─── Why the fixtures are composed rather than built by a factory ───────────────────────
 * `@/test/factories` intentionally exposes no `GetStatementDetailsResponse` builder, so the
 * prop is composed HERE from the factory's import-log builder plus inline
 * `conflicting_transactions` / `final_transactions` / `date_format` / `raw_data` / `currency`,
 * typed against the interface the endpoint actually declares (`../import_utils`). Typing it
 * that way is what makes "never invent a field" mechanically enforced by `tsc -b` rather than
 * merely promised. The optional `pdf_tables` is omitted, because this component never reads it.
 *
 * ─── Two render gates that silently decide what exists ─────────────────────────────────
 *   1. The Import control exists only while `doc.status !== 'Completed'`, and is disabled when
 *      `final_transactions` is empty.
 *   2. `ConflictingTransactions` and the preview table render only while
 *      `doc.status === 'Not Started'`, and the former early-returns on an empty array.
 * The base fixture therefore uses `status: 'Not Started'` with both arrays non-empty, so both
 * gates are open; every variant is derived from it.
 *
 * ─── Instrumentation notes that are easy to get wrong ──────────────────────────────────
 *   • Toasts emit NO DOM here. `<Toaster />` is mounted once, in `src/App.tsx`, and this suite
 *     renders the component directly — so `sonner` is mocked and the toast CALLS are asserted.
 *   • The post-call hook is mocked per METHOD, not blanket: this component's own
 *     `run_doc_method` call and the `run_rule_evaluation` call that
 *     `useWaitForRuleEvaluation` makes would otherwise share one spy and be indistinguishable.
 *   • A rejecting `call` does NOT populate the hook's own `error` member, so the inline
 *     `ErrorBanner` is exercised by overriding that hook's RETURN — a separate seam from the
 *     dialog, which is driven by the rejection.
 *   • `useGetBankAccounts` reads `data.message`, so the bank list has to be supplied
 *     explicitly or the account cells render blank.
 *   • The rejection path re-reads the log through `FrappeContext`'s `db.getDoc` before it
 *     records anything, and `classifyImportAttempt` needs BOTH a genuine envelope and a
 *     confirmed non-completed status before it will say `failed`. Each of those branches has
 *     its own test.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	TEST_ALTERNATE_CURRENCY,
	TEST_BANK_ACCOUNT,
	TEST_BANK_LEDGER_ACCOUNT,
	TEST_COMPANY,
	TEST_CURRENCY,
	createFrappeSDKMock,
	emitFrappeEvent,
	frappeContextValue,
	frappeCreateDoc,
	frappeHookMutate,
	frappeSDKMock,
	frappeSWRMutate,
	frappeUpdateDoc,
	getFrappeEventListener,
	makeBankStatementImportLog,
	makeErrorMessageError,
	makeFrappeError,
	makeImportSuccessResponse,
	makeSelectedBank,
	makeServerMessagesError
} from '@/test/factories'
import { TooltipProvider } from '@/components/ui/tooltip'
import { selectedCompanyAtom } from '@/hooks/useCurrentCompany'
import type { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'

/**
 * Toast spies, hoisted so the `vi.mock` factory below — which the transform lifts above every
 * import — can close over them. Asserting the CALL is the only option available: the toaster
 * itself is mounted in `App.tsx`, which this suite never renders, so a toast produces no DOM
 * to query. Only `success` and `error` are stubbed, because those are the only members this
 * component's module graph reaches.
 */
const { toastError, toastSuccess } = vi.hoisted(() => ({
	toastError: vi.fn<(message: string) => void>(),
	toastSuccess: vi.fn<(message: string) => void>()
}))

vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))

// The ONE shared SDK mock. Declared here so the transform hoists it above the subject import;
// the factory runs lazily, on first import of the mocked module. Hand-rolling a mock instead
// would omit `useSWRConfig`, which this component's graph destructures through
// `../../BankReconciliation/utils`, and the module would fail to evaluate.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import StatementDetails from './StatementDetails'
import type { GetStatementDetailsResponse } from '../import_utils'
import {
	bankRecDateAtom,
	bankRecErrorDialogAtom,
	bankRecImportFailuresAtom,
	type ImportAttemptMarkers
} from '../../BankReconciliation/bankRecAtoms'
import { bankRecUnreconciledTransactionsKey } from '../../BankReconciliation/utils'

/** The realtime channel the import step subscribes to. */
const IMPORT_PROGRESS_CHANNEL = 'bank-rec-statement-import-progress'

/** The document method the component posts through, and the whitelisted method it names. */
const RUN_DOC_METHOD = 'run_doc_method'
const INSERT_TRANSACTIONS = 'insert_transactions'

/** The statement's own range, as the server detected it while parsing the file. */
const STATEMENT_START_DATE = '2024-01-01'
const STATEMENT_END_DATE = '2024-01-31'

/**
 * The range the SAVED document comes back with, deliberately DIFFERENT from the range on the
 * fixture the component was rendered with. The import resolves the statement's dates
 * server-side, so the continuation must follow the server's copy — using the local one would
 * point the reconciliation page at a range the new transactions may not fall in.
 */
const CONFIRMED_START_DATE = '2024-01-04'
const CONFIRMED_END_DATE = '2024-01-29'

/** The range the reconciliation page is filtered to before the import moves it. */
const PREVIOUS_START_DATE = '2023-12-01'
const PREVIOUS_END_DATE = '2023-12-31'

/** A second bank account, used only to prove markers are scoped per account. */
const OTHER_BANK_ACCOUNT = 'Second Bank - Test Company'

/** Another of this bank's logs, used to prove the marker map is extended and not replaced. */
const SIBLING_IMPORT_LOG_NAME = 'f6e5d4c3b2'

/** Text rendered by the route the component navigates to once an import is confirmed. */
const RECONCILIATION_SENTINEL = 'Reconciliation workbench'

/**
 * The transactions the SERVER parsed out of the file. Exactly one of `withdrawal`/`deposit` is
 * positive on each row, matching how a statement line is actually shaped, and `reference` is
 * spelt as the endpoint spells it — not `reference_number`, which is the CONFLICTING row's
 * spelling.
 */
const FINAL_TRANSACTIONS: GetStatementDetailsResponse['final_transactions'] = [
	{
		date: '2024-01-05',
		withdrawal: 0,
		deposit: 48250.5,
		description: 'NEFT credit from ACME Traders',
		reference: 'NEFT/2024/000145',
		transaction_type: 'NEFT'
	},
	{
		date: '2024-01-18',
		withdrawal: 12500,
		deposit: 0,
		description: 'RTGS debit to Globex Supplies',
		reference: 'RTGS/2024/000891',
		transaction_type: 'RTGS'
	},
	{
		date: '2024-01-27',
		withdrawal: 3400.25,
		deposit: 0,
		description: 'Bank charges for January',
		reference: 'CHG/2024/000012'
	}
]

/**
 * Existing `Bank Transaction` records the server found in the same account and range. All seven
 * declared fields are present on each, because none of them is optional.
 *
 * The second row is denominated in the harness's OTHER registered currency and carries a blank
 * `reference_number`. Both details are load-bearing: a conflicting row is formatted in its OWN
 * currency rather than the statement's, and a blank reference renders as a dash.
 */
const CONFLICTING_TRANSACTIONS: GetStatementDetailsResponse['conflicting_transactions'] = [
	{
		name: 'ACC-BTN-2024-00007',
		date: '2024-01-18',
		withdrawal: 12500,
		deposit: 0,
		description: 'RTGS debit to Globex Supplies',
		reference_number: 'RTGS/2024/000891',
		currency: TEST_CURRENCY
	},
	{
		name: 'ACC-BTN-2024-00008',
		date: '2024-01-27',
		withdrawal: 9875.25,
		deposit: 0,
		description: 'Card settlement recorded in a second currency',
		reference_number: '',
		currency: TEST_ALTERNATE_CURRENCY
	}
]

/** The parsed grid the raw-data preview pane is fed. Header row first, exactly as the file. */
const RAW_DATA: GetStatementDetailsResponse['raw_data'] = [
	['Date', 'Description', 'Reference', 'Withdrawal', 'Deposit'],
	['05-01-2024', 'NEFT credit from ACME Traders', 'NEFT/2024/000145', '', '48250.50'],
	['18-01-2024', 'RTGS debit to Globex Supplies', 'RTGS/2024/000891', '12500.00', ''],
	['27-01-2024', 'Bank charges for January', 'CHG/2024/000012', '3400.25', '']
]

/** The strftime pattern the server reports having detected in the file. */
const DETECTED_DATE_FORMAT = '%d-%m-%Y'

/**
 * An import log carrying every optional field this screen renders. Totals agree with
 * {@link FINAL_TRANSACTIONS} — two debits summing to 15,900.25 and one credit of 48,250.50 —
 * so the rendered figures are the ones the file would really produce.
 *
 * `status` is overridden to `'Not Started'` because the factory's default is `'Completed'`,
 * which closes both render gates.
 */
const makeImportLog = (overrides: Partial<BankStatementImportLog> = {}): BankStatementImportLog =>
	makeBankStatementImportLog({
		status: 'Not Started',
		start_date: STATEMENT_START_DATE,
		end_date: STATEMENT_END_DATE,
		number_of_transactions: FINAL_TRANSACTIONS.length,
		total_debits: 15900.25,
		total_credits: 48250.5,
		total_debit_transactions: 2,
		total_credit_transactions: 1,
		detected_amount_format: 'Separate columns for withdrawal and deposit',
		detected_date_format: DETECTED_DATE_FORMAT,
		...overrides
	})

/** The endpoint's response, composed here because no builder for this shape exists. */
const makeStatementDetails = (
	overrides: Partial<GetStatementDetailsResponse> = {}
): GetStatementDetailsResponse => ({
	doc: makeImportLog(),
	conflicting_transactions: CONFLICTING_TRANSACTIONS,
	final_transactions: FINAL_TRANSACTIONS,
	date_format: DETECTED_DATE_FORMAT,
	raw_data: RAW_DATA,
	currency: TEST_CURRENCY,
	...overrides
})

/* ─── Instrumentation ─────────────────────────────────────────────────────────────────── */

/** This component's own document-method call. */
const importCall = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>()

/**
 * The rule-evaluation call `useWaitForRuleEvaluation` makes on the success continuation. Kept
 * SEPARATE from {@link importCall} so "the import was posted exactly once" is a statement about
 * the import and not about however many other posts the continuation happens to make.
 */
const ruleEvaluationCall = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>()

/** Every SWR-backed read this suite configures answers with the same five-member shape. */
const queryResponse = (data: unknown) => ({
	data,
	error: undefined,
	isLoading: false,
	isValidating: false,
	mutate: frappeHookMutate
})

/**
 * Installs the post-call hook, branching on the METHOD so the import call and the
 * rule-evaluation call are distinguishable.
 *
 * `hookError` and `loading` describe the import hook only, and exist because they are the hook's
 * OWN members: a rejected `call` leaves `error` null, so the inline banner and the in-flight
 * label can only be reached by returning them from here.
 */
const installPostCallHook = ({
	hookError = null,
	loading = false
}: {
	hookError?: ReturnType<typeof makeFrappeError> | null
	loading?: boolean
} = {}) => {
	frappeSDKMock.useFrappePostCall.mockImplementation((method) => ({
		call: method === RUN_DOC_METHOD ? importCall : ruleEvaluationCall,
		result: null,
		loading: method === RUN_DOC_METHOD ? loading : false,
		error: method === RUN_DOC_METHOD ? hookError : null,
		isCompleted: false,
		reset: vi.fn<() => void>(() => undefined)
	}))
}

/**
 * Answers the bank-account list with one row whose `name` MATCHES the log's `bank_account`,
 * which is what the component looks the account up by. Any other endpoint answers empty.
 */
const installBankAccountList = (rows: unknown[] = [makeSelectedBank()]) => {
	frappeSDKMock.useFrappeGetCall.mockImplementation((method) =>
		method.endsWith('bank_account.get_list') ? queryResponse({ message: rows }) : queryResponse(undefined)
	)
}

/**
 * Renders the step inside the providers production gives it, on the route the importer reaches
 * it by.
 *
 * `TooltipProvider` is required rather than decorative — the tooltip primitive is Radix's
 * `Tooltip.Root`, whose provider context has no default, so the info tooltips in the details
 * table throw without it. `MemoryRouter` is required because the step renders a `Link` and calls
 * `useNavigate`; the sentinel route is what makes navigation observable WITHOUT mocking the
 * hook, so the assertion stays about behaviour rather than about implementation.
 *
 * The jotai store is created per render and seeded explicitly. The harness performs no global
 * atom reset, and `bankRecDateAtom` is backed by `localStorage`, so an isolated store is what
 * keeps one test's range out of the next one's.
 */
const renderStatementDetails = (
	data: GetStatementDetailsResponse,
	seed?: (store: ReturnType<typeof createStore>) => void
) => {
	const store = createStore()
	store.set(selectedCompanyAtom, TEST_COMPANY)
	store.set(bankRecDateAtom, { fromDate: PREVIOUS_START_DATE, toDate: PREVIOUS_END_DATE })
	seed?.(store)

	const utils = render(
		<TooltipProvider>
			<Provider store={store}>
				<MemoryRouter initialEntries={[`/statement-importer/${data.doc.name}`]}>
					<Routes>
						<Route path="/statement-importer/:id" element={<StatementDetails data={data} />} />
						<Route path="/" element={<div>{RECONCILIATION_SENTINEL}</div>} />
					</Routes>
				</MemoryRouter>
			</Provider>
		</TooltipProvider>
	)

	return { ...utils, store }
}

/** Resolves the table owning a given caption, so assertions can be scoped to one of them. */
const tableWithCaption = (caption: string): HTMLElement => {
	const table = screen.getByText(caption).closest('table')
	expect(table).not.toBeNull()
	return table as HTMLElement
}

/**
 * Resolves the row carrying a given label. Scoping matters more than it looks: a formatted
 * amount in the details table can be BYTE-IDENTICAL to one in the preview table below it, so an
 * unscoped text query is ambiguous by construction rather than by accident.
 */
const rowLabelled = (label: string): HTMLElement => {
	const row = screen.getByText(label).closest('tr')
	expect(row).not.toBeNull()
	return row as HTMLElement
}

/** Clicks the Import control for a fixture with the given number of parsed transactions. */
const clickImport = async (transactionCount: number = FINAL_TRANSACTIONS.length) => {
	await userEvent.click(screen.getByRole('button', { name: `Import ${transactionCount} transactions` }))
}

/**
 * Stubs the two counts the bounded rule-evaluation wait reads, ANSWERED BY DOCTYPE.
 *
 * The wait asks two different questions of `getCount`, and a single blanket value cannot serve both.
 * It first asks how many `Bank Transaction Rule` documents exist and returns immediately when the
 * answer is zero - because the server-side evaluator does exactly the same thing, so on a site with
 * no rules nothing will ever be stamped and there is nothing to trigger or wait for. Only then does
 * it poll `Bank Transaction` for rows in the imported range still awaiting evaluation.
 *
 * So a blanket `mockResolvedValue(0)` silently takes the no-rules short circuit and the trigger is
 * never dispatched at all. The default below states the case these tests are about: rules DO exist,
 * and the range has already drained - so evaluation is re-triggered exactly once and the poll
 * converges on its first attempt without ever waiting on a timer.
 */
const installRuleEvaluationCounts = ({ rules = 1, pending = 0 }: { rules?: number, pending?: number } = {}) => {
	frappeContextValue.db.getCount.mockImplementation(async (doctype: string) =>
		doctype === 'Bank Transaction Rule' ? rules : pending)
}

/** Every write seam that could create a record client-side. None of them may ever be reached. */
const expectNoClientSideWrites = () => {
	expect(frappeCreateDoc).not.toHaveBeenCalled()
	expect(frappeUpdateDoc).not.toHaveBeenCalled()
	expect(frappeContextValue.db.createDoc).not.toHaveBeenCalled()
	expect(frappeContextValue.db.updateDoc).not.toHaveBeenCalled()
	expect(frappeContextValue.db.setValue).not.toHaveBeenCalled()
	expect(frappeContextValue.db.deleteDoc).not.toHaveBeenCalled()
}

/* ─── Suite ───────────────────────────────────────────────────────────────────────────── */

describe('StatementDetails', () => {
	beforeEach(() => {
		// Installed per test rather than at module scope: the harness's shared teardown resets
		// every SDK spy, which discards implementations along with recorded calls.
		importCall.mockReset()
		ruleEvaluationCall.mockReset()
		ruleEvaluationCall.mockResolvedValue({ message: null })
		installPostCallHook()
		installBankAccountList()
		installRuleEvaluationCounts()
	})

	afterEach(() => {
		toastSuccess.mockReset()
		toastError.mockReset()
	})

	/* ─── TC1, first half: the list the server parsed is what the reviewer sees ─────── */

	describe('TC1 — the parsed statement is presented for review', () => {
		it('renders the detected statement details from the server document', () => {
			renderStatementDetails(makeStatementDetails())

			expect(screen.getByText('Statement Details')).toBeInTheDocument()

			// Resolved by matching the list row against the log's `bank_account`.
			expect(screen.getByText('Test Bank Current Account')).toBeInTheDocument()
			expect(screen.getByText(TEST_BANK_LEDGER_ACCOUNT)).toBeInTheDocument()

			// `file.split('/').pop()` — the display name, never the stored path.
			expect(screen.getByText('statement.csv')).toBeInTheDocument()

			expect(screen.getByText('1st January 2024 to 31st January 2024')).toBeInTheDocument()
			expect(screen.getByText('Separate columns for withdrawal and deposit')).toBeInTheDocument()

			// Scoped to its own row, because the count also appears as a row index in the
			// preview table below.
			expect(within(rowLabelled('Number of Transactions')).getByRole('cell')).toHaveTextContent('3')
		})

		it('renders the totals and the closing balance in the statement currency', () => {
			renderStatementDetails(makeStatementDetails())

			expect(rowLabelled('Total Debits')).toHaveTextContent('₹ 15,900.25')
			expect(rowLabelled('Total Debits')).toHaveTextContent('(2 transactions)')

			expect(rowLabelled('Total Credits')).toHaveTextContent('₹ 48,250.50')
			expect(rowLabelled('Total Credits')).toHaveTextContent('(1 transaction)')

			// The heading interpolates the server's end date; it is deliberately unguarded in
			// the component, so a fixture without `end_date` would render an empty date here.
			expect(rowLabelled('Closing Balance as of 31st January 2024')).toHaveTextContent('₹ 152,300.75')
		})

		it('lists every parsed transaction, in the order the server returned them', () => {
			renderStatementDetails(makeStatementDetails())

			const preview = tableWithCaption('Transactions to be imported into the system')
			// One header row plus one row per parsed transaction.
			expect(within(preview).getAllByRole('row')).toHaveLength(FINAL_TRANSACTIONS.length + 1)

			const firstRow = within(preview).getByText('NEFT credit from ACME Traders').closest('tr')
			expect(firstRow).not.toBeNull()
			const firstRowCells = within(firstRow as HTMLElement).getAllByRole('cell')
			expect(firstRowCells.map((cell) => cell.textContent)).toEqual([
				'1',
				'05-01-2024',
				'NEFT credit from ACME Traders',
				'NEFT/2024/000145',
				'₹ 0.00',
				'₹ 48,250.50'
			])

			const lastRow = within(preview).getByText('Bank charges for January').closest('tr')
			expect(lastRow).not.toBeNull()
			const lastRowCells = within(lastRow as HTMLElement).getAllByRole('cell')
			expect(lastRowCells.map((cell) => cell.textContent)).toEqual([
				'3',
				'27-01-2024',
				'Bank charges for January',
				'CHG/2024/000012',
				'₹ 3,400.25',
				'₹ 0.00'
			])

			expect(
				screen.getByText('3 transactions will be imported into the system. Please review the details below and click the \'Import\' button to proceed.')
			).toBeInTheDocument()
		})

		it('offers an enabled Import control labelled with the parsed count', () => {
			renderStatementDetails(makeStatementDetails())

			expect(screen.getByRole('button', { name: 'Import 3 transactions' })).toBeEnabled()
			expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/statement-importer')
		})

		it('renders a dash when the server resolved no date range for the file', () => {
			renderStatementDetails(
				makeStatementDetails({
					doc: makeImportLog({ start_date: undefined, end_date: undefined })
				})
			)

			expect(within(rowLabelled('Transaction Dates')).getByRole('cell')).toHaveTextContent('-')
			expect(screen.queryByText('1st January 2024 to 31st January 2024')).not.toBeInTheDocument()
		})

		it('counts a lone debit or credit in the singular', () => {
			// The mirror of the base fixture, so both arms of both counts are exercised.
			renderStatementDetails(
				makeStatementDetails({
					doc: makeImportLog({
						total_debits: 3400.25,
						total_credits: 60750.5,
						total_debit_transactions: 1,
						total_credit_transactions: 2
					})
				})
			)

			expect(rowLabelled('Total Debits')).toHaveTextContent('(1 transaction)')
			expect(rowLabelled('Total Credits')).toHaveTextContent('(2 transactions)')
		})

		it('uses singular copy when the file yielded a single transaction', () => {
			renderStatementDetails(makeStatementDetails({ final_transactions: [FINAL_TRANSACTIONS[0]] }))

			expect(screen.getByRole('button', { name: 'Import 1 transactions' })).toBeEnabled()
			expect(
				screen.getByText('We\'ve found 1 transaction in the statement file that will be imported into the system. Please review the details below and click the \'Import\' button to proceed.')
			).toBeInTheDocument()
		})
	})


	/* ─── TC1, second half: confirming the import ───────────────────────────────────── */

	describe('TC1 — importing posts one server-side operation and follows its answer', () => {
		it('posts insert_transactions for the document under review and nothing else', async () => {
			const data = makeStatementDetails()
			importCall.mockResolvedValue(
				makeImportSuccessResponse([
					makeImportLog({
						status: 'Completed',
						start_date: CONFIRMED_START_DATE,
						end_date: CONFIRMED_END_DATE
					})
				])
			)

			renderStatementDetails(data)
			await clickImport()

			await waitFor(() => {
				expect(importCall).toHaveBeenCalledTimes(1)
			})
			expect(importCall).toHaveBeenCalledWith({ docs: data.doc, method: INSERT_TRANSACTIONS })
			// By identity: the document under review is posted as-is, never a rebuilt copy.
			expect(importCall.mock.calls[0][0].docs).toBe(data.doc)

			// Only the server creates transactions.
			expectNoClientSideWrites()
		})

		it("moves the reconciliation range to the range the SERVER resolved, then navigates", async () => {
			const data = makeStatementDetails()
			importCall.mockResolvedValue(
				makeImportSuccessResponse([
					makeImportLog({
						status: 'Completed',
						start_date: CONFIRMED_START_DATE,
						end_date: CONFIRMED_END_DATE
					})
				])
			)

			const { store } = renderStatementDetails(data)
			await clickImport()

			expect(await screen.findByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()

			expect(store.get(bankRecDateAtom)).toEqual({
				fromDate: CONFIRMED_START_DATE,
				toDate: CONFIRMED_END_DATE
			})
			expect(toastSuccess).toHaveBeenCalledWith('Bank statement imported.')
			expect(toastError).not.toHaveBeenCalled()
			expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
		})

		it('invalidates the imported range before handing over, so the new rows cannot be missed', async () => {
			const data = makeStatementDetails()
			importCall.mockResolvedValue(
				makeImportSuccessResponse([
					makeImportLog({
						status: 'Completed',
						start_date: CONFIRMED_START_DATE,
						end_date: CONFIRMED_END_DATE
					})
				])
			)

			renderStatementDetails(data)
			await clickImport()

			expect(await screen.findByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()

			// The unreconciled query does not revalidate on mount, so the entry for the imported
			// range has to be EMPTIED or the reconciliation page renders a stale list.
			//
			// The three-argument form is what makes that true, and it is asserted here rather than
			// merely implied: a bare `mutate(key)` is a revalidate REQUEST, which SWR serves by
			// invoking the key's registered revalidator - and revalidators are registered by mounted
			// subscribers. At this moment the reconciliation page is not mounted, so there is none,
			// the call resolves having fetched nothing, and the populated entry survives. Passing
			// `undefined` as the DATA argument is a cache WRITE instead, which applies with or
			// without a subscriber and leaves the entry holding nothing, so the query fetches when
			// it mounts even under this application's `revalidateIfStale: false`. See
			// `EVICT_CACHE_ENTRY` in the reconciliation hook layer.
			expect(frappeSWRMutate).toHaveBeenCalledWith(
				bankRecUnreconciledTransactionsKey(TEST_BANK_ACCOUNT, CONFIRMED_START_DATE, CONFIRMED_END_DATE),
				undefined,
				{ revalidate: true, populateCache: true }
			)
			// Rule evaluation is re-triggered post-commit so suggested matches are present.
			expect(ruleEvaluationCall).toHaveBeenCalledTimes(1)
		})

		it('retires this log\'s attempt marker and leaves every other account\'s alone', async () => {
			const data = makeStatementDetails()
			const seeded: ImportAttemptMarkers = {
				[TEST_BANK_ACCOUNT]: { [data.doc.name]: 'failed', [SIBLING_IMPORT_LOG_NAME]: 'unknown' },
				[OTHER_BANK_ACCOUNT]: { 'c3b2a1f6e5': 'failed' }
			}
			importCall.mockResolvedValue(
				makeImportSuccessResponse([
					makeImportLog({
						status: 'Completed',
						start_date: CONFIRMED_START_DATE,
						end_date: CONFIRMED_END_DATE
					})
				])
			)

			const { store } = renderStatementDetails(data, (s) => s.set(bankRecImportFailuresAtom, seeded))
			await clickImport()

			expect(await screen.findByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()

			expect(store.get(bankRecImportFailuresAtom)).toEqual({
				[TEST_BANK_ACCOUNT]: { [SIBLING_IMPORT_LOG_NAME]: 'unknown' },
				[OTHER_BANK_ACCOUNT]: { 'c3b2a1f6e5': 'failed' }
			})
		})

		it('leaves the reconciliation range untouched when the saved document carries no dates', async () => {
			const data = makeStatementDetails()
			importCall.mockResolvedValue(
				makeImportSuccessResponse([
					makeImportLog({ status: 'Completed', start_date: undefined, end_date: undefined })
				])
			)

			const { store } = renderStatementDetails(data)
			await clickImport()

			expect(await screen.findByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()

			expect(store.get(bankRecDateAtom)).toEqual({
				fromDate: PREVIOUS_START_DATE,
				toDate: PREVIOUS_END_DATE
			})
			// With no range to refresh there is nothing to wait for either.
			expect(ruleEvaluationCall).not.toHaveBeenCalled()
			expect(toastSuccess).toHaveBeenCalledWith('Bank statement imported.')
		})

		it('still completes when the response carries no documents at all', async () => {
			const data = makeStatementDetails()
			importCall.mockResolvedValue({})

			const { store } = renderStatementDetails(data)
			await clickImport()

			expect(await screen.findByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
			expect(store.get(bankRecDateAtom)).toEqual({
				fromDate: PREVIOUS_START_DATE,
				toDate: PREVIOUS_END_DATE
			})
		})

		it('blocks a second submission while the post is in flight', () => {
			installPostCallHook({ loading: true })
			renderStatementDetails(makeStatementDetails())

			expect(screen.getByRole('button', { name: 'Importing...' })).toBeDisabled()
			expect(screen.queryByRole('button', { name: 'Import 3 transactions' })).not.toBeInTheDocument()
		})

		/*
		 * THE WINDOW BETWEEN THE SERVER'S ANSWER AND THE HAND-OFF, which neither of the two signals
		 * the control originally read describes truthfully:
		 *
		 *   - `data` is the parent's `get_statement_details` response and is never revalidated here,
		 *     so `data.doc.status` still reads `Not Started` after the server has recorded the import.
		 *   - the post hook's `loading` answers only "is the request in flight?", and flips back the
		 *     instant the response lands - which is BEFORE the continuation (the bounded
		 *     rule-evaluation wait, then the cache invalidation) has finished.
		 *
		 * Between the two, an ENABLED "Import 3 transactions" reappeared for work the server had
		 * already committed and invited a re-click. Re-clicking could never double-post - the server
		 * refuses a completed log - but the affordance said the opposite of what was true. The
		 * assertions below land INSIDE that window by holding the continuation open on its first
		 * await, the rule count.
		 */
		it('never re-offers the action between the server\'s answer and the hand-off', async () => {
			importCall.mockResolvedValue(
				makeImportSuccessResponse([
					makeImportLog({
						status: 'Completed',
						start_date: CONFIRMED_START_DATE,
						end_date: CONFIRMED_END_DATE
					})
				])
			)

			let releaseRuleCount: (value: number) => void = () => undefined
			frappeContextValue.db.getCount.mockImplementation(
				() => new Promise<number>((resolve) => { releaseRuleCount = resolve }))

			renderStatementDetails(makeStatementDetails())
			await clickImport()

			// The post has resolved and the continuation is parked on the rule count: precisely the
			// window in which the control used to reappear.
			await waitFor(() => expect(importCall).toHaveBeenCalledTimes(1))

			expect(screen.queryByRole('button', { name: 'Import 3 transactions' })).not.toBeInTheDocument()
			expect(screen.queryByText(RECONCILIATION_SENTINEL)).not.toBeInTheDocument()

			// Releasing it lets the continuation finish, proving the window was transient rather
			// than a deadlock this assertion happened to catch.
			await act(async () => {
				releaseRuleCount(0)
			})

			expect(await screen.findByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
		})

		// Once the server has CONFIRMED, the action is not merely closed - it is replaced by the same
		// green badge the server-derived status renders. That is the strongest form of closed: there
		// is nothing left to click at all.
		it('is replaced by the completed badge as soon as the server confirms', async () => {
			importCall.mockResolvedValue(
				makeImportSuccessResponse([
					makeImportLog({
						status: 'Completed',
						start_date: CONFIRMED_START_DATE,
						end_date: CONFIRMED_END_DATE
					})
				])
			)

			let releaseRuleCount: (value: number) => void = () => undefined
			frappeContextValue.db.getCount.mockImplementation(
				() => new Promise<number>((resolve) => { releaseRuleCount = resolve }))

			renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(screen.getByText('Completed')).toBeInTheDocument()
			})
			expect(screen.queryByRole('button', { name: /Import \d+ transactions/ })).not.toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Importing...' })).not.toBeInTheDocument()

			await act(async () => {
				releaseRuleCount(0)
			})
			expect(await screen.findByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
		})
	})


	/* ─── FM2: the backend's error is surfaced, never discarded ──────────────────────── */

	describe('FM2 — a refused import surfaces the backend error and creates nothing', () => {
		/** The wording a real `frappe.throw` from the import would carry. */
		const PARSE_FAILURE_MESSAGE =
			'No tables could be detected in this file. Please check the file and try again.'

		/** Markers already held for OTHER files, which a new marker must extend and not replace. */
		const seededMarkers = (): ImportAttemptMarkers => ({
			[TEST_BANK_ACCOUNT]: { [SIBLING_IMPORT_LOG_NAME]: 'unknown' },
			[OTHER_BANK_ACCOUNT]: { 'c3b2a1f6e5': 'failed' }
		})

		it("renders the server's own message verbatim in the shared dismissible dialog", async () => {
			const data = makeStatementDetails()
			const serverError = makeServerMessagesError(PARSE_FAILURE_MESSAGE)
			importCall.mockRejectedValue(serverError)
			// The authoritative re-read: the server confirms the log did NOT complete.
			frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))

			const { store } = renderStatementDetails(data)
			await clickImport()

			const dialog = await screen.findByRole('alertdialog')
			// The heading is outcome-neutral chrome; the AUTHORITATIVE text is the message.
			expect(within(dialog).getByText('Something went wrong')).toBeInTheDocument()
			expect(within(dialog).getByText(PARSE_FAILURE_MESSAGE)).toBeInTheDocument()

			// Held by identity — the envelope reaches the user exactly as the server sent it.
			expect(store.get(bankRecErrorDialogAtom)).toBe(serverError)

			// The log was re-read before anything was recorded.
			expect(frappeContextValue.db.getDoc).toHaveBeenCalledWith(
				'Bank Statement Import Log',
				data.doc.name
			)
		})

		it('records a failed marker for this file without disturbing the others', async () => {
			const data = makeStatementDetails()
			importCall.mockRejectedValue(makeServerMessagesError(PARSE_FAILURE_MESSAGE))
			frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))

			const { store } = renderStatementDetails(data, (s) =>
				s.set(bankRecImportFailuresAtom, seededMarkers())
			)
			await clickImport()

			await screen.findByRole('alertdialog')

			expect(store.get(bankRecImportFailuresAtom)).toEqual({
				[TEST_BANK_ACCOUNT]: {
					[SIBLING_IMPORT_LOG_NAME]: 'unknown',
					[data.doc.name]: 'failed'
				},
				[OTHER_BANK_ACCOUNT]: { 'c3b2a1f6e5': 'failed' }
			})
		})

		it('keeps the transient toast as well — the dialog is additive, not a replacement', async () => {
			importCall.mockRejectedValue(makeServerMessagesError(PARSE_FAILURE_MESSAGE))
			frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))

			renderStatementDetails(makeStatementDetails())
			await clickImport()

			await screen.findByRole('alertdialog')

			expect(toastError).toHaveBeenCalledWith('There was an error while importing the bank statement.')
			expect(toastSuccess).not.toHaveBeenCalled()
		})

		it('claims no success: no navigation, no completed badge, and the import stays offered', async () => {
			importCall.mockRejectedValue(makeServerMessagesError(PARSE_FAILURE_MESSAGE))
			frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))

			renderStatementDetails(makeStatementDetails())
			await clickImport()

			await screen.findByRole('alertdialog')

			// Text queries rather than role queries while the dialog is open: an alert dialog
			// marks the rest of the page inert, so the page behind it is intentionally absent
			// from the accessibility tree.
			expect(screen.queryByText(RECONCILIATION_SENTINEL)).not.toBeInTheDocument()
			expect(screen.queryByText('Completed')).not.toBeInTheDocument()
			// The statement details are unchanged: the step still describes the file as parsed.
			expect(screen.getByText('1st January 2024 to 31st January 2024')).toBeInTheDocument()

			// Once acknowledged, the same import is offered again — a refusal is recoverable.
			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})
			expect(screen.getByRole('button', { name: 'Import 3 transactions' })).toBeEnabled()
		})

		it('creates no transaction client-side and posts nothing beyond the one refused call', async () => {
			importCall.mockRejectedValue(makeServerMessagesError(PARSE_FAILURE_MESSAGE))
			frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))

			const { store } = renderStatementDetails(makeStatementDetails())
			await clickImport()

			await screen.findByRole('alertdialog')

			expect(importCall).toHaveBeenCalledTimes(1)
			// The success continuation — and therefore its rule-evaluation post — never ran.
			expect(ruleEvaluationCall).not.toHaveBeenCalled()
			expectNoClientSideWrites()

			// NO OPTIMISTIC MUTATION: nothing was applied ahead of the server's answer, so the
			// reconciliation range still points where it did before the attempt.
			expect(store.get(bankRecDateAtom)).toEqual({
				fromDate: PREVIOUS_START_DATE,
				toDate: PREVIOUS_END_DATE
			})
		})

		it('dismisses on request, leaving the recorded marker in place', async () => {
			const data = makeStatementDetails()
			importCall.mockRejectedValue(makeServerMessagesError(PARSE_FAILURE_MESSAGE))
			frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))

			const { store } = renderStatementDetails(data)
			await clickImport()
			await screen.findByRole('alertdialog')

			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})
			expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			// Dismissing the message does not un-record what was observed about the file.
			expect(store.get(bankRecImportFailuresAtom)).toEqual({
				[TEST_BANK_ACCOUNT]: { [data.doc.name]: 'failed' }
			})
		})

		/**
		 * `getErrorMessages` resolves in a fixed order, and an import can be refused through
		 * more than one of those envelope shapes. Both of the ones a `frappe.throw` and a
		 * framework-level validation actually produce are covered.
		 */
		it('surfaces a refusal that arrives in _error_message rather than _server_messages', async () => {
			const message = 'Not permitted to import into this bank account'
			const serverError = makeErrorMessageError(message)
			importCall.mockRejectedValue(serverError)
			frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))

			const { store } = renderStatementDetails(makeStatementDetails())
			await clickImport()

			const dialog = await screen.findByRole('alertdialog')
			expect(within(dialog).getByText(message)).toBeInTheDocument()
			expect(store.get(bankRecErrorDialogAtom)).toBe(serverError)
		})

		/**
		 * A rejection with NO response is a statement about the connection, not about the
		 * server. The client must not claim the import failed — it does not know — so the
		 * marker is `unknown` and the copy is outcome-indeterminate.
		 */
		it('reports an unknown outcome, not a failure, when no response arrived', async () => {
			const data = makeStatementDetails()
			// What `frappe-js-sdk` itself throws when it reads `error.response.data` and the
			// response is missing.
			importCall.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'data')"))
			// The confirming read cannot answer either.
			frappeContextValue.db.getDoc.mockRejectedValue(new Error('Request failed'))
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

			const { store } = renderStatementDetails(data)
			await clickImport()

			const dialog = await screen.findByRole('alertdialog')
			expect(
				within(dialog).getByText('No response arrived from the server, so it is not known whether this request was recorded. Check the current state of the affected records before repeating the action.')
			).toBeInTheDocument()

			// A substitute envelope, because there was no server text to preserve.
			expect(store.get(bankRecErrorDialogAtom)?.httpStatus).toBe(0)
			expect(store.get(bankRecImportFailuresAtom)).toEqual({
				[TEST_BANK_ACCOUNT]: { [data.doc.name]: 'unknown' }
			})
			// The failed confirmation was reported rather than swallowed.
			expect(consoleError).toHaveBeenCalled()
			consoleError.mockRestore()
		})

		/**
		 * `Not Started` is the log's INITIAL value and only advances to `Completed` as the
		 * import's last act, so observing it after a lost response proves nothing. Recording
		 * failure there would invite a re-import of work that may already exist.
		 */
		it('will not call it a failure on a nonterminal status alone', async () => {
			const data = makeStatementDetails()
			importCall.mockRejectedValue(new TypeError('Network request failed'))
			frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))

			const { store } = renderStatementDetails(data)
			await clickImport()

			await screen.findByRole('alertdialog')

			expect(store.get(bankRecImportFailuresAtom)).toEqual({
				[TEST_BANK_ACCOUNT]: { [data.doc.name]: 'unknown' }
			})
		})

		/**
		 * Server truth outranks the envelope that arrived with it: if the confirming read says
		 * the import completed, it completed, and nothing is surfaced as an error.
		 */
		it('treats a confirmed Completed log as success, even after a rejection', async () => {
			const data = makeStatementDetails()
			importCall.mockRejectedValue(makeServerMessagesError('Connection reset before the response'))
			frappeContextValue.db.getDoc.mockResolvedValue(
				makeImportLog({
					status: 'Completed',
					start_date: CONFIRMED_START_DATE,
					end_date: CONFIRMED_END_DATE
				})
			)

			const { store } = renderStatementDetails(data, (s) =>
				s.set(bankRecImportFailuresAtom, seededMarkers())
			)
			await clickImport()

			expect(await screen.findByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()

			expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			expect(toastError).not.toHaveBeenCalled()
			expect(toastSuccess).toHaveBeenCalledWith('Bank statement imported.')
			// The range comes from the CONFIRMED document, which is the one the import wrote.
			expect(store.get(bankRecDateAtom)).toEqual({
				fromDate: CONFIRMED_START_DATE,
				toDate: CONFIRMED_END_DATE
			})
			// No marker belongs to a completed import.
			expect(store.get(bankRecImportFailuresAtom)).toEqual({
				[TEST_BANK_ACCOUNT]: { [SIBLING_IMPORT_LOG_NAME]: 'unknown' },
				[OTHER_BANK_ACCOUNT]: { 'c3b2a1f6e5': 'failed' }
			})
		})

		/**
		 * The rejection handler is asynchronous, so its own failure is caught terminally rather
		 * than left to escape. An unhandled rejection in a posting screen is a defect class of
		 * its own — the run reports a failure with no bearing on the flow, and any work the
		 * handler had left to do is abandoned silently. Provoked through the notification seam,
		 * which is the first thing the handler touches.
		 */
		it('contains a failure inside its own rejection handler', async () => {
			const data = makeStatementDetails()
			importCall.mockRejectedValue(makeServerMessagesError(PARSE_FAILURE_MESSAGE))
			frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))
			const handlerFailure = new Error('Notification surface unavailable')
			toastError.mockImplementationOnce(() => {
				throw handlerFailure
			})
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

			const { store } = renderStatementDetails(data)
			await clickImport()

			await waitFor(() => {
				expect(consoleError).toHaveBeenCalledWith(handlerFailure)
			})
			// Nothing was half-recorded, and the step is still usable.
			expect(store.get(bankRecImportFailuresAtom)).toEqual({})
			expect(screen.getByRole('button', { name: 'Import 3 transactions' })).toBeEnabled()
			consoleError.mockRestore()
		})

		/**
		 * FM2's zero-row case: a file the server parsed without raising, but from which it
		 * recognised no transactions. The status is accurate and no marker is involved, so the
		 * reason has to be stated in the page itself.
		 */
		it('states why an unreadable file cannot be imported, and disables the control', () => {
			renderStatementDetails(
				makeStatementDetails({ final_transactions: [], conflicting_transactions: [] })
			)

			expect(screen.getByRole('button', { name: 'Import 0 transactions' })).toBeDisabled()

			const alert = screen.getByRole('alert')
			expect(alert).toHaveTextContent('No transactions found in this statement')
			expect(alert).toHaveTextContent('It may be empty, or its columns may not have been recognised.')
			expect(alert).toHaveClass('text-ink-red-3')
		})

		/**
		 * The post hook's OWN error member, which a rejected `call` never populates. It is
		 * normalised through the same shared layer as the dialog, so an inline banner and the
		 * dialog can never disagree about the same rejection.
		 */
		it("renders the post call's own error inline, through the shared banner", () => {
			installPostCallHook({ hookError: makeServerMessagesError('This bank account is disabled') })

			renderStatementDetails(makeStatementDetails({ conflicting_transactions: [] }))

			const banner = screen.getByRole('alert')
			// Frappe's placeholder title, collapsed by the shared banner's own heading rule.
			expect(banner).toHaveTextContent('There was an error.')
			expect(banner).toHaveTextContent('This bank account is disabled')
		})
	})


	/* ─── The realtime import-progress subscription ──────────────────────────────────── */

	describe('realtime import progress', () => {
		it('subscribes to the import-progress channel', () => {
			renderStatementDetails(makeStatementDetails())

			expect(frappeSDKMock.useFrappeEventListener).toHaveBeenCalledWith(
				IMPORT_PROGRESS_CHANNEL,
				expect.any(Function)
			)
			expect(getFrappeEventListener(IMPORT_PROGRESS_CHANNEL)).toBeTypeOf('function')
		})

		it('renders nothing until the server pushes a figure', () => {
			renderStatementDetails(makeStatementDetails())

			// The block is gated on a positive count, so a zero-progress render shows no bar.
			expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
			expect(screen.queryByText('Importing 0 transactions')).not.toBeInTheDocument()
		})

		it('reports the count the server pushed', () => {
			renderStatementDetails(makeStatementDetails())

			// `act` is the caller's responsibility: the captured handler sets React state.
			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 50 })
			})

			expect(screen.getByText('Importing 50 transactions')).toBeInTheDocument()
			expect(screen.getByRole('progressbar')).toBeInTheDocument()
		})

		it('follows each subsequent push', () => {
			renderStatementDetails(makeStatementDetails())

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 50 })
			})
			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 120 })
			})

			expect(screen.getByText('Importing 120 transactions')).toBeInTheDocument()
			expect(screen.queryByText('Importing 50 transactions')).not.toBeInTheDocument()
		})
	})

	/* ─── ConflictingTransactions ────────────────────────────────────────────────────── */

	describe('ConflictingTransactions', () => {
		const PLURAL_WARNING =
			'We\'ve found 2 existing transactions in the system that conflict with the transactions in the statement file. Are you sure you want to proceed with the import?'

		it('warns, in red, about the existing transactions the server matched', () => {
			renderStatementDetails(makeStatementDetails())

			const alert = screen.getByRole('alert')
			expect(alert).toHaveTextContent('Conflicting Transactions')
			expect(alert).toHaveTextContent(PLURAL_WARNING)
			expect(alert).toHaveClass('text-ink-red-3')

			// Advisory only: the import remains available, because the server decides.
			expect(screen.getByRole('button', { name: 'Import 3 transactions' })).toBeEnabled()
		})

		it('renders nothing at all when the server reports no conflicts', () => {
			renderStatementDetails(makeStatementDetails({ conflicting_transactions: [] }))

			expect(screen.queryByText('Conflicting Transactions')).not.toBeInTheDocument()
			expect(screen.queryByRole('alert')).not.toBeInTheDocument()
			// The rest of the step is unaffected.
			expect(screen.getByText('Preview Transactions')).toBeInTheDocument()
		})

		it('uses singular copy and a singular control for one conflict', async () => {
			renderStatementDetails(
				makeStatementDetails({ conflicting_transactions: [CONFLICTING_TRANSACTIONS[0]] })
			)

			expect(screen.getByRole('alert')).toHaveTextContent(
				'We\'ve found 1 existing transaction in the system that conflicts with the transactions in the statement file. Are you sure you want to proceed with the import?'
			)

			await userEvent.click(screen.getByRole('button', { name: 'View transaction' }))

			const dialog = await screen.findByRole('dialog')
			expect(within(dialog).getAllByRole('link')).toHaveLength(1)
		})

		it('lists each conflicting transaction in its own currency, on demand', async () => {
			renderStatementDetails(makeStatementDetails())

			// The rows live behind a dialog, so nothing is rendered until it is opened.
			expect(
				screen.queryByText('Existing transactions in the system belonging to the same bank account and date range')
			).not.toBeInTheDocument()

			await userEvent.click(screen.getByRole('button', { name: 'View transactions' }))

			const dialog = await screen.findByRole('dialog')
			expect(
				within(dialog).getByText('Existing transactions in the system belonging to the same bank account and date range')
			).toBeInTheDocument()
			expect(within(dialog).getByText(PLURAL_WARNING)).toBeInTheDocument()

			const firstRow = within(dialog).getByText('RTGS debit to Globex Supplies').closest('tr')
			expect(firstRow).not.toBeNull()
			expect(within(firstRow as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
				'18-01-2024',
				'RTGS debit to Globex Supplies',
				'RTGS/2024/000891',
				'₹ 12,500.00',
				'₹ 0.00',
				''
			])

			// The second row is formatted in ITS OWN currency, not the statement's, and its
			// blank reference renders as a dash rather than as an empty cell.
			const secondRow = within(dialog)
				.getByText('Card settlement recorded in a second currency')
				.closest('tr')
			expect(secondRow).not.toBeNull()
			expect(within(secondRow as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
				'27-01-2024',
				'Card settlement recorded in a second currency',
				'-',
				'$ 9,875.25',
				'$ 0.00',
				''
			])
		})

		it('links each conflicting transaction to its record in a new tab', async () => {
			renderStatementDetails(makeStatementDetails())

			await userEvent.click(screen.getByRole('button', { name: 'View transactions' }))
			const dialog = await screen.findByRole('dialog')

			const links = within(dialog).getAllByRole('link')
			expect(links.map((link) => link.getAttribute('href'))).toEqual([
				'/desk/bank-transaction/ACC-BTN-2024-00007',
				'/desk/bank-transaction/ACC-BTN-2024-00008'
			])
			links.forEach((link) => {
				expect(link).toHaveAttribute('target', '_blank')
				expect(link).toHaveAttribute('rel', 'noopener noreferrer')
			})

			// Radix opens a tooltip immediately on focus, with no hover delay to wait out.
			act(() => {
				links[0].focus()
			})
			expect(await screen.findByRole('tooltip')).toHaveTextContent(
				'Open ACC-BTN-2024-00007 in a new tab'
			)
		})

		it('closes again without touching anything', async () => {
			renderStatementDetails(makeStatementDetails())

			await userEvent.click(screen.getByRole('button', { name: 'View transactions' }))
			const dialog = await screen.findByRole('dialog')

			// Scoped to the footer: the dialog primitive also renders its own corner dismiss
			// control, which carries the same accessible name.
			const footer = dialog.querySelector('[data-slot="dialog-footer"]')
			expect(footer).not.toBeNull()
			await userEvent.click(within(footer as HTMLElement).getByRole('button', { name: 'Close' }))

			await waitFor(() => {
				expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
			})
			expect(importCall).not.toHaveBeenCalled()
			expectNoClientSideWrites()
		})
	})

	/* ─── An already-completed log ───────────────────────────────────────────────────── */

	describe('a log the server has already completed', () => {
		it('shows the completed badge instead of an import control', () => {
			renderStatementDetails(makeStatementDetails({ doc: makeImportLog({ status: 'Completed' }) }))

			const badge = screen.getByText('Completed')
			expect(badge).toHaveAttribute('data-slot', 'badge')
			expect(badge).toHaveAttribute('data-theme', 'green')

			expect(screen.queryByRole('button', { name: 'Import 3 transactions' })).not.toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Importing...' })).not.toBeInTheDocument()
		})

		it('hides the review block, because there is nothing left to review', () => {
			renderStatementDetails(makeStatementDetails({ doc: makeImportLog({ status: 'Completed' }) }))

			expect(screen.queryByText('Preview Transactions')).not.toBeInTheDocument()
			expect(screen.queryByText('Conflicting Transactions')).not.toBeInTheDocument()
			// The detected details themselves remain readable.
			expect(screen.getByText('Statement Details')).toBeInTheDocument()
			expect(screen.getByText('Closing Balance as of 31st January 2024')).toBeInTheDocument()
		})

		it('states no zero-row warning for a completed log', () => {
			renderStatementDetails(
				makeStatementDetails({
					doc: makeImportLog({ status: 'Completed' }),
					final_transactions: []
				})
			)

			expect(screen.queryByText('No transactions found in this statement')).not.toBeInTheDocument()
		})
	})

	/* ─── The bank-account lookup ────────────────────────────────────────────────────── */

	describe('the bank-account lookup', () => {
		it('renders no account details when the list does not contain this account', () => {
			installBankAccountList([makeSelectedBank({ name: OTHER_BANK_ACCOUNT })])

			renderStatementDetails(makeStatementDetails())

			// Crash-safe: the row simply has nothing to show, and the rest of the step renders.
			expect(screen.queryByText(TEST_BANK_LEDGER_ACCOUNT)).not.toBeInTheDocument()
			expect(screen.getByText('statement.csv')).toBeInTheDocument()
		})

		it('renders no account details before the list has arrived', () => {
			frappeSDKMock.useFrappeGetCall.mockImplementation(() => queryResponse(undefined))

			renderStatementDetails(makeStatementDetails())

			expect(screen.queryByText('Test Bank Current Account')).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Import 3 transactions' })).toBeEnabled()
		})
	})
})
