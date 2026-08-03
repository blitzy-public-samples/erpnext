/*
 * The statement-import review step shared by the CSV and PDF flows.
 *
 * Two render gates decide what exists in the tree: the Import control renders only while
 * `doc.status !== 'Completed'` and is disabled when `final_transactions` is empty; the preview table
 * and `ConflictingTransactions` render only while `doc.status === 'Not Started'`. The base fixture
 * opens both gates and every variant is derived from it.
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
 *   • A RESOLVED post call is not by itself a successful import. Only a response carrying a
 *     document whose `status` is `Completed` confirms one, so `importCall.mockResolvedValue(...)`
 *     must supply such a document for any test that expects the success continuation — and the
 *     shapes that do NOT (no `docs`, an empty `docs`, a nonterminal status) take the same
 *     server-consulting path a rejection does. Both are covered.
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
	makeBankAccountListRow,
	makeBankStatementImportLog,
	makeErrorMessageError,
	makeFrappeError,
	makeImportSuccessResponse,
	makeServerMessagesError
} from '@/test/factories'
import { TooltipProvider } from '@/components/ui/tooltip'
import { selectedCompanyAtom } from '@/hooks/useCurrentCompany'
import type { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'

/*
 * Hoisted so the `vi.mock` factory below can close over them. The toaster is mounted in `App.tsx`,
 * which this suite never renders, so a toast produces no DOM and the CALL is the only observable.
 */
const { toastError, toastSuccess } = vi.hoisted(() => ({
	toastError: vi.fn<(message: string) => void>(),
	toastSuccess: vi.fn<(message: string) => void>()
}))

vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))

// The ONE shared SDK mock: a hand-rolled one would omit `useSWRConfig`, which this component's graph
// destructures through `../../BankReconciliation/utils`, and the module would fail to evaluate.
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

const IMPORT_PROGRESS_CHANNEL = 'bank-rec-statement-import-progress'

const RUN_DOC_METHOD = 'run_doc_method'
const INSERT_TRANSACTIONS = 'insert_transactions'

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

const PREVIOUS_START_DATE = '2023-12-01'
const PREVIOUS_END_DATE = '2023-12-31'

const OTHER_BANK_ACCOUNT = 'Second Bank - Test Company'

const SIBLING_IMPORT_LOG_NAME = 'f6e5d4c3b2'

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

/*
 * The second row is denominated in the harness's OTHER registered currency and carries a blank
 * `reference_number`: a conflicting row is formatted in its OWN currency rather than the
 * statement's, and a blank reference renders as a dash.
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

const RAW_DATA: GetStatementDetailsResponse['raw_data'] = [
	['Date', 'Description', 'Reference', 'Withdrawal', 'Deposit'],
	['05-01-2024', 'NEFT credit from ACME Traders', 'NEFT/2024/000145', '', '48250.50'],
	['18-01-2024', 'RTGS debit to Globex Supplies', 'RTGS/2024/000891', '12500.00', ''],
	['27-01-2024', 'Bank charges for January', 'CHG/2024/000012', '3400.25', '']
]

const DETECTED_DATE_FORMAT = '%d-%m-%Y'

// `status` is overridden because the factory defaults to `'Completed'`, which closes both render
// gates.
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

const importCall = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>()

/**
 * The rule-evaluation call `useWaitForRuleEvaluation` makes on the success continuation. Kept
 * SEPARATE from {@link importCall} so "the import was posted exactly once" is a statement about
 * the import and not about however many other posts the continuation happens to make.
 */
const ruleEvaluationCall = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>()

const queryResponse = (data: unknown) => ({
	data,
	error: undefined,
	isLoading: false,
	isValidating: false,
	mutate: frappeHookMutate
})

/*
 * Branches on the METHOD so the import call and the rule-evaluation call stay distinguishable.
 * `hookError` and `loading` are the import hook's OWN members: a rejected `call` leaves `error` null,
 * so the inline banner and the in-flight label are reachable only by returning them from here.
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
 *
 * The default row comes from the ENDPOINT builder, not from the persisted-selection builder: the
 * two projections differ in both directions (`integration_id` is on the selection but not in this
 * endpoint's `SELECT`; `account_subtype` is in the `SELECT` but not on the selection), so the
 * selection fixture would answer with a row the server cannot produce.
 */
const installBankAccountList = (rows: unknown[] = [makeBankAccountListRow()]) => {
	frappeSDKMock.useFrappeGetCall.mockImplementation((method) =>
		method.endsWith('bank_account.get_list') ? queryResponse({ message: rows }) : queryResponse(undefined)
	)
}

/*
 * `TooltipProvider` is required rather than decorative: Radix's tooltip context has no default, so
 * the details table's info tooltips throw without it. `MemoryRouter` is required because the step
 * renders a `Link` and calls `useNavigate`, and the sentinel route makes navigation observable
 * without mocking the hook. The store is per render because `bankRecDateAtom` is backed by
 * `localStorage` and the harness performs no global atom reset.
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

const clickImport = async (transactionCount: number = FINAL_TRANSACTIONS.length) => {
	await userEvent.click(screen.getByRole('button', { name: `Import ${transactionCount} transactions` }))
}

/*
 * Answered BY DOCTYPE, because the bounded wait asks `getCount` two different questions: how many
 * `Bank Transaction Rule` documents exist, returning immediately when the answer is zero, and then
 * how many `Bank Transaction` rows in the range still await evaluation. A blanket
 * `mockResolvedValue(0)` takes the no-rules short circuit and never dispatches the trigger.
 */
const installRuleEvaluationCounts = ({ rules = 1, pending = 0 }: { rules?: number, pending?: number } = {}) => {
	frappeContextValue.db.getCount.mockImplementation(async (doctype: string) =>
		doctype === 'Bank Transaction Rule' ? rules : pending)
}

const expectNoClientSideWrites = () => {
	expect(frappeCreateDoc).not.toHaveBeenCalled()
	expect(frappeUpdateDoc).not.toHaveBeenCalled()
	expect(frappeContextValue.db.createDoc).not.toHaveBeenCalled()
	expect(frappeContextValue.db.updateDoc).not.toHaveBeenCalled()
	expect(frappeContextValue.db.setValue).not.toHaveBeenCalled()
	expect(frappeContextValue.db.deleteDoc).not.toHaveBeenCalled()
}

describe('StatementDetails', () => {
	beforeEach(() => {
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

	describe('TC1 — the parsed statement is presented for review', () => {
		it('renders the detected statement details from the server document', () => {
			renderStatementDetails(makeStatementDetails())

			expect(screen.getByText('Statement Details')).toBeInTheDocument()

			expect(screen.getByText('Test Bank Current Account')).toBeInTheDocument()
			expect(screen.getByText(TEST_BANK_LEDGER_ACCOUNT)).toBeInTheDocument()

			expect(screen.getByText('statement.csv')).toBeInTheDocument()

			expect(screen.getByText('1st January 2024 to 31st January 2024')).toBeInTheDocument()
			expect(screen.getByText('Separate columns for withdrawal and deposit')).toBeInTheDocument()

			expect(within(rowLabelled('Number of Transactions')).getByRole('cell')).toHaveTextContent('3')
		})

		it('renders the totals and the closing balance in the statement currency', () => {
			renderStatementDetails(makeStatementDetails())

			expect(rowLabelled('Total Debits')).toHaveTextContent('₹ 15,900.25')
			expect(rowLabelled('Total Debits')).toHaveTextContent('(2 transactions)')

			expect(rowLabelled('Total Credits')).toHaveTextContent('₹ 48,250.50')
			expect(rowLabelled('Total Credits')).toHaveTextContent('(1 transaction)')

			expect(rowLabelled('Closing Balance as of 31st January 2024')).toHaveTextContent('₹ 152,300.75')
		})

		it('lists every parsed transaction, in the order the server returned them', () => {
			renderStatementDetails(makeStatementDetails())

			const preview = tableWithCaption('Transactions to be imported into the system')
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
			expect(importCall.mock.calls[0][0].docs).toBe(data.doc)

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

			// A bare `mutate(key)` is a revalidate REQUEST, which SWR serves through the key's
			// registered revalidator - and revalidators come from mounted subscribers. The
			// reconciliation page is not mounted here, so that form would fetch nothing and the
			// populated entry would survive. The three-argument form is a cache WRITE, which applies
			// with or without a subscriber and leaves the entry empty under `revalidateIfStale:
			// false`.
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
			expect(ruleEvaluationCall).not.toHaveBeenCalled()
			expect(toastSuccess).toHaveBeenCalledWith('Bank statement imported.')
		})

		/**
		 * A 200 IS NOT A CONFIRMATION.
		 *
		 * `run_doc_method` returns the document it ran the method on (`frappe/handler.py:340`), and
		 * the import's LAST act is to set the status to `Completed` and save
		 * (`bank_statement_import_log.py:568-569`). A response therefore confirms an import only if
		 * it carries a document that says so — and one that does not cannot have come from an import
		 * that took effect, whatever the HTTP status was.
		 *
		 * Each shape below used to be treated as SUCCESS: the Import control was retired, a success
		 * toast was raised, the reconciliation range was moved and the reviewer was handed off to a
		 * workbench that had nothing new in it. For a financial import that is the dangerous
		 * direction to be wrong in — a reviewer told the statement is in will not import it again,
		 * and the transactions are simply missing.
		 *
		 * It is not reported as a FAILURE either, because that is equally unknowable from the client:
		 * the request may have been applied with only the acknowledgement lost or rewritten. Every
		 * case is settled the same way a rejection is — ask the server what the log says and let THAT
		 * decide — so the outcome is `unknown`, the copy is outcome-indeterminate, and the reviewer is
		 * sent to the record rather than invited to re-import blindly.
		 */
		describe('a response that confirms nothing is treated as neither success nor failure', () => {

			/** The wording of the indeterminate report, which no case below may claim success over. */
			const UNCONFIRMED_MESSAGE =
				'The server did not confirm this import, so it is not known whether the transactions were recorded. Open this import to check its current state before importing the file again.'

			/** Every response shape that carries no confirming document. */
			const unconfirmedResponses: [string, unknown][] = [
				['no docs member at all', {}],
				['an empty docs array', { docs: [] }],
				['a document that still reports a nonterminal status', {
					docs: [makeImportLog({
						status: 'Not Started',
						start_date: CONFIRMED_START_DATE,
						end_date: CONFIRMED_END_DATE
					})]
				}]
			]

			it.each(unconfirmedResponses)(
				'claims no success for %s',
				async (_label, response) => {
					const data = makeStatementDetails()
					importCall.mockResolvedValue(response)
					// The authoritative re-read: the server says this log did not complete.
					frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))

					const { store } = renderStatementDetails(data)
					await clickImport()

					// The indeterminate report is raised, which is also what proves the continuation ran.
					const dialog = await screen.findByRole('alertdialog')
					expect(within(dialog).getByText(UNCONFIRMED_MESSAGE)).toBeInTheDocument()

					// NOT a success: no hand-off, no success toast, no completed badge.
					expect(screen.queryByText(RECONCILIATION_SENTINEL)).not.toBeInTheDocument()
					expect(toastSuccess).not.toHaveBeenCalled()
					expect(screen.queryByText('Completed')).not.toBeInTheDocument()
					expect(toastError).toHaveBeenCalledWith('The import could not be confirmed.')

					// NO OPTIMISTIC MUTATION: the reconciliation range is untouched, even for the
					// third shape, whose document carries a range the client could otherwise have
					// helped itself to.
					expect(store.get(bankRecDateAtom)).toEqual({
						fromDate: PREVIOUS_START_DATE,
						toDate: PREVIOUS_END_DATE
					})

					// The SERVER was consulted before anything was recorded.
					expect(frappeContextValue.db.getDoc).toHaveBeenCalledWith(
						'Bank Statement Import Log',
						data.doc.name
					)

					// `unknown`, never `failed`: nothing was refused, so the client has not been told
					// the import did not happen — only that it could not establish that it did.
					expect(store.get(bankRecImportFailuresAtom)).toEqual({
						[TEST_BANK_ACCOUNT]: { [data.doc.name]: 'unknown' }
					})

					// Nothing was created client-side, and the success continuation's own post never ran.
					expect(ruleEvaluationCall).not.toHaveBeenCalled()
					expectNoClientSideWrites()
					expect(importCall).toHaveBeenCalledTimes(1)
				}
			)

			it('re-offers the import once the indeterminate report is acknowledged', async () => {
				// The one path on which the control may legitimately reopen: the client did not
				// establish that the import took effect, so a retry is the reviewer's to make. The
				// server refuses a log it has already completed, so a retry cannot double-import.
				importCall.mockResolvedValue({})
				frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))

				renderStatementDetails(makeStatementDetails())
				await clickImport()

				await screen.findByRole('alertdialog')
				await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

				await waitFor(() => {
					expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
				})
				expect(screen.getByRole('button', { name: 'Import 3 transactions' })).toBeEnabled()
			})

			/**
			 * The settlement handler's own terminator. It matters for a reason beyond tidiness: the
			 * unconfirmed path runs INSIDE the `.then`, so a failure in it would otherwise fall into
			 * the `.catch` that handles a rejected import — re-running the whole settlement and
			 * judging this handler's own failure as though the SERVER had refused the import. The
			 * single `getDoc` is what proves it does not: a second settlement would consult the log
			 * again.
			 *
			 * The failure is injected at the transient toast because that is the first thing the
			 * handler does after the server has been consulted, so nothing about the classification
			 * has to be disturbed to reach it.
			 */
			it('reports a failure inside its own handler without re-settling the attempt', async () => {
				importCall.mockResolvedValue({})
				frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))
				toastError.mockImplementation(() => { throw new Error('Toaster unavailable') })
				const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

				renderStatementDetails(makeStatementDetails())
				await clickImport()

				await waitFor(() => {
					expect(consoleError).toHaveBeenCalled()
				})
				// Consulted ONCE: the attempt was settled once, not settled and then re-settled.
				expect(frappeContextValue.db.getDoc).toHaveBeenCalledTimes(1)
				// And still no success was claimed for a response that confirmed nothing.
				expect(screen.queryByText(RECONCILIATION_SENTINEL)).not.toBeInTheDocument()
				expect(toastSuccess).not.toHaveBeenCalled()

				consoleError.mockRestore()
			})

			/**
			 * SERVER TRUTH DECIDES, in the direction that matters as much as the other: an import
			 * whose acknowledgement was lost or rewritten DID happen, and the confirming read is what
			 * says so. Reporting that as unconfirmed would send a reviewer to re-import work that
			 * already exists.
			 */
			it('completes on the confirming read when the response itself carried nothing', async () => {
				const data = makeStatementDetails()
				importCall.mockResolvedValue({})
				frappeContextValue.db.getDoc.mockResolvedValue(
					makeImportLog({
						status: 'Completed',
						start_date: CONFIRMED_START_DATE,
						end_date: CONFIRMED_END_DATE
					})
				)

				const { store } = renderStatementDetails(data)
				await clickImport()

				expect(await screen.findByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
				expect(toastSuccess).toHaveBeenCalledWith('Bank statement imported.')
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

				// The range comes from the SERVER's copy of the document — the one the import wrote —
				// not from the stale fixture this screen was rendered with.
				expect(store.get(bankRecDateAtom)).toEqual({
					fromDate: CONFIRMED_START_DATE,
					toDate: CONFIRMED_END_DATE
				})
				// And no marker is left behind for an import that did complete.
				expect(store.get(bankRecImportFailuresAtom)).toEqual({})
			})
		})

		it('blocks a second submission while the post is in flight', () => {
			installPostCallHook({ loading: true })
			renderStatementDetails(makeStatementDetails())

			expect(screen.getByRole('button', { name: 'Importing...' })).toBeDisabled()
			expect(screen.queryByRole('button', { name: 'Import 3 transactions' })).not.toBeInTheDocument()
		})

		/*
		 * Neither signal the control can read describes the window between the server's answer and
		 * the hand-off: `data.doc.status` still reads `Not Started` because the parent response is
		 * never revalidated here, and the post hook's `loading` flips back the instant the response
		 * lands - before the continuation (the bounded rule-evaluation wait, then the cache
		 * invalidation) has finished. The assertions below land inside that window by holding the
		 * continuation open on its first await, the rule count.
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

			await waitFor(() => expect(importCall).toHaveBeenCalledTimes(1))

			expect(screen.queryByRole('button', { name: 'Import 3 transactions' })).not.toBeInTheDocument()
			expect(screen.queryByText(RECONCILIATION_SENTINEL)).not.toBeInTheDocument()

			await act(async () => {
				releaseRuleCount(0)
			})

			expect(await screen.findByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
		})

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


	describe('FM2 — a refused import surfaces the backend error and creates nothing', () => {
		const PARSE_FAILURE_MESSAGE =
			'No tables could be detected in this file. Please check the file and try again.'

		const seededMarkers = (): ImportAttemptMarkers => ({
			[TEST_BANK_ACCOUNT]: { [SIBLING_IMPORT_LOG_NAME]: 'unknown' },
			[OTHER_BANK_ACCOUNT]: { 'c3b2a1f6e5': 'failed' }
		})

		it("renders the server's own message verbatim in the shared dismissible dialog", async () => {
			const data = makeStatementDetails()
			const serverError = makeServerMessagesError(PARSE_FAILURE_MESSAGE)
			importCall.mockRejectedValue(serverError)
			frappeContextValue.db.getDoc.mockResolvedValue(makeImportLog({ status: 'Not Started' }))

			const { store } = renderStatementDetails(data)
			await clickImport()

			const dialog = await screen.findByRole('alertdialog')
			expect(within(dialog).getByText('Something went wrong')).toBeInTheDocument()
			expect(within(dialog).getByText(PARSE_FAILURE_MESSAGE)).toBeInTheDocument()

			expect(store.get(bankRecErrorDialogAtom)).toBe(serverError)

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
			expect(screen.getByText('1st January 2024 to 31st January 2024')).toBeInTheDocument()

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
			expect(ruleEvaluationCall).not.toHaveBeenCalled()
			expectNoClientSideWrites()

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
			importCall.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'data')"))
			frappeContextValue.db.getDoc.mockRejectedValue(new Error('Request failed'))
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

			const { store } = renderStatementDetails(data)
			await clickImport()

			const dialog = await screen.findByRole('alertdialog')
			expect(
				within(dialog).getByText('No response arrived from the server, so it is not known whether this request was recorded. Check the current state of the affected records before repeating the action.')
			).toBeInTheDocument()

			expect(store.get(bankRecErrorDialogAtom)?.httpStatus).toBe(0)
			expect(store.get(bankRecImportFailuresAtom)).toEqual({
				[TEST_BANK_ACCOUNT]: { [data.doc.name]: 'unknown' }
			})
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
			expect(store.get(bankRecDateAtom)).toEqual({
				fromDate: CONFIRMED_START_DATE,
				toDate: CONFIRMED_END_DATE
			})
			expect(store.get(bankRecImportFailuresAtom)).toEqual({
				[TEST_BANK_ACCOUNT]: { [SIBLING_IMPORT_LOG_NAME]: 'unknown' },
				[OTHER_BANK_ACCOUNT]: { 'c3b2a1f6e5': 'failed' }
			})
		})

		/*
		 * The rejection handler is asynchronous, so a failure inside it has to be caught terminally
		 * rather than escaping as an unhandled rejection. Provoked through the notification seam,
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
			expect(banner).toHaveTextContent('There was an error.')
			expect(banner).toHaveTextContent('This bank account is disabled')
		})
	})


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

	describe('the bank-account lookup', () => {
		it('renders no account details when the list does not contain this account', () => {
			installBankAccountList([makeBankAccountListRow({ name: OTHER_BANK_ACCOUNT })])

			renderStatementDetails(makeStatementDetails())

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
