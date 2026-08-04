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
 * ─── Instrumentation notes that are easy to get wrong ──────────────────────────
 *   • Toasts emit NO DOM here. `<Toaster />` is mounted once, in `src/App.tsx`, and this suite
 *     renders the component directly — so `sonner` is mocked and the toast CALLS are asserted.
 *   • A rejecting `call` does NOT populate the hook's own `error` member, so the inline
 *     `ErrorBanner` is exercised by overriding that hook's RETURN — a separate seam from the
 *     dialog, which is driven by the rejection the component's own `.catch` receives.
 *   • `useGetBankAccounts` reads `data.message`, so the bank list has to be supplied
 *     explicitly or the account cells render blank.
 *   • The import is ONE server call and the server is the whole of the authority: the component
 *     consults nothing else, re-reads no document to second-guess the answer, and classifies
 *     nothing. A resolved call is a success and continues to the reconciliation view; a rejected
 *     call opens the shared dialog with the server's error passed through unmodified and records
 *     that one import log as failed. Those are the only two outcomes, and each has its own test.
 */


import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	TEST_ALTERNATE_CURRENCY,
	TEST_BANK_LEDGER_ACCOUNT,
	TEST_COMPANY,
	TEST_CURRENCY,
	createFrappeSDKMock,
	emitFrappeEvent,
	frappeContextValue,
	frappeCreateDoc,
	frappeHookMutate,
	frappeSWRMutate,
	frappeSDKMock,
	frappeUpdateDoc,
	getFrappeEventListener,
	makeBankAccountListRow,
	TEST_BANK_ACCOUNT,
	makeBankStatementImportLog,
	makeErrorMessageError,
	makeFrappeError,
	makeImportFailures,
	makeServerMessagesError
} from '@/test/factories'
import { TooltipProvider } from '@/components/ui/tooltip'
import { selectedCompanyAtom } from '@/hooks/useCurrentCompany'
import type { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'

/*
 * Hoisted so the `vi.mock` factory below can close over them. The toaster is mounted in `App.tsx`,
 * which this suite never renders, so a toast produces no DOM and the CALL is the only observable.
 */
const { toastError, toastSuccess, toastWarning } = vi.hoisted(() => ({
	toastError: vi.fn<(message: string) => void>(),
	toastSuccess: vi.fn<(message: string) => void>(),
	// The UNCONFIRMED-outcome channel. It is a distinct member rather than a reuse of `error`, because
	// the client observed no refusal and must not announce one; omitting it from this mock made
	// `toast.warning` throw, which the rejection handler then reported as a server refusal. The options
	// argument is typed because the unconfirmed-outcome copy carries its explanation in `description`.
	toastWarning: vi.fn<(message: string, options?: { description?: string }) => void>()
}))

vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess, warning: toastWarning } }))

// The ONE shared SDK mock: a hand-rolled one would omit `useSWRConfig`, which this component's graph
// destructures through `../../BankReconciliation/utils`, and the module would fail to evaluate.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import StatementDetails from './StatementDetails'
import type { GetStatementDetailsResponse } from '../import_utils'
import {
	bankRecDateAtom,
	bankRecErrorDialogAtom,
	bankRecImportFailuresAtom
} from '../../BankReconciliation/bankRecAtoms'

const IMPORT_PROGRESS_CHANNEL = 'bank-rec-statement-import-progress'

const RUN_DOC_METHOD = 'run_doc_method'
/**
 * The whitelisted rule evaluator, spelt exactly as the server exposes it — and asserted here as an
 * endpoint this surface MUST NOT CALL.
 *
 * Evaluation of the rows an import created is server-owned: `insert_transactions` queues it through
 * `enqueue_rule_evaluation(bank_account=self.bank_account)` after saving the log and after the rows
 * commit, so the worker is guaranteed to see them and the scope comes from the log rather than from a
 * client. `run_rule_evaluation` itself now requires `Bank Transaction` WRITE permission, which makes it
 * a manager-level action rather than something a review surface should fire implicitly.
 *
 * A client-side call was present at one point and has been removed, so the constant is retained
 * purely as the negative assertion's subject.
 */
const RUN_RULE_EVALUATION = 'erpnext.accounts.doctype.bank_transaction_rule.bank_transaction_rule.run_rule_evaluation'
const INSERT_TRANSACTIONS = 'insert_transactions'

const STATEMENT_START_DATE = '2024-01-01'
const STATEMENT_END_DATE = '2024-01-31'

/**
 * The range the SAVED document comes back with, deliberately DIFFERENT from the range on the
 * fixture the component was rendered with. The import resolves the statement's dates
 * server-side, so the continuation must follow the server's copy — using the local one would
 * point the reconciliation page at a range the new transactions may not fall in.
 */
const SAVED_START_DATE = '2024-01-04'
const SAVED_END_DATE = '2024-01-29'

const PREVIOUS_START_DATE = '2023-12-01'
const PREVIOUS_END_DATE = '2023-12-31'

const OTHER_BANK_ACCOUNT = 'Second Bank - Test Company'

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

/**
 * The hash name the SERVER minted for this import log. `Bank Statement Import Log` is
 * `autoname: hash`, so the name is never something the client chose — and it is the key the per-file
 * failure marker is recorded under, which is why it is named here rather than inlined.
 */
const IMPORT_LOG_NAME = makeBankStatementImportLog().name

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

/**
 * The response as `get_statement_details` actually returns it: `doc`, `date_format`,
 * `conflicting_transactions`, `final_transactions`, `raw_data` and — for a PDF — `pdf_tables`.
 * The statement currency is a field of the DOCUMENT (`doc.currency`), populated read-only from the
 * bank account's GL account currency; see {@link makeImportLog}.
 *
 * ⚠️ THE TOP-LEVEL `currency` MEMBER IS A TRAP, AND IT IS THE ONLY GUARANTEE LEFT.
 * `GetStatementDetailsResponse` DECLARES a top-level `currency` that `get_statement_details` never
 * returns, and that declaration is why `formatCurrency(…, data.currency)` once type-checked while
 * resolving to `undefined` at runtime — silently formatting every statement figure in the system
 * default currency instead of the statement's own. `import_utils.ts` is not a path this work may
 * change (Agent Action Plan sections 0.8.1.6 and 0.9.1: it is not among the authorised files), so the
 * declaration stays and the compiler CANNOT be the guarantee here.
 *
 * This sentinel is therefore load-bearing rather than belt-and-braces. It is a value no currency
 * formatter can mistake for a real code, so any screen that reads the phantom field — statically, or
 * dynamically through an index access, a spread into a currency argument or a `Record<string,
 * unknown>` hop — renders it and fails loudly, instead of silently falling back to the system default
 * the way an omitted key does. That silent fallback is exactly how the original defect stayed
 * invisible. Every figure on the page must resolve through `data.doc.currency`.
 */
const PHANTOM_RESPONSE_CURRENCY = 'NOT-A-CURRENCY'

const makeStatementDetails = (
	overrides: Partial<GetStatementDetailsResponse> = {}
): GetStatementDetailsResponse => ({
	doc: makeImportLog(),
	conflicting_transactions: CONFLICTING_TRANSACTIONS,
	final_transactions: FINAL_TRANSACTIONS,
	date_format: DETECTED_DATE_FORMAT,
	raw_data: RAW_DATA,
	...overrides,
	// Resolved AFTER the spread, so a `Partial` override cannot widen the declared `string` to
	// `string | undefined`, while an explicit override still wins over the sentinel.
	currency: overrides.currency ?? PHANTOM_RESPONSE_CURRENCY
})

const importCall = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>()

/**
 * A second post spy, kept SEPARATE from {@link importCall} and wired to every method OTHER than
 * `run_doc_method`. It exists so "the import was posted exactly once" is a statement about the
 * import itself, and so any other post this surface were ever made to issue would show up as a call
 * on this spy rather than silently inflating the import's own count.
 */
const otherPostCall = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>()

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
		call: method === RUN_DOC_METHOD ? importCall : otherPostCall,
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

/** Every distinct endpoint the component has instantiated a post hook for. */
const postEndpointsUsed = (): string[] => [
	...new Set(frappeSDKMock.useFrappePostCall.mock.calls.map(([method]) => method))
]

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
		otherPostCall.mockReset()
		otherPostCall.mockResolvedValue({ message: null })
		installPostCallHook()
		installBankAccountList()
		installRuleEvaluationCounts()
	})

	afterEach(() => {
		toastSuccess.mockReset()
		toastError.mockReset()
		toastWarning.mockReset()
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

		/*
		 * ⚠️ THE CURRENCY-CONTRACT REGRESSION, and the reason it needs a NON-DEFAULT currency to be
		 * visible at all.
		 *
		 * Every figure on this screen used to be formatted with a RESPONSE-LEVEL `currency` member that
		 * `get_statement_details` does not send: it returns `doc`, `date_format`,
		 * `conflicting_transactions`, `final_transactions`, `raw_data` and (for PDFs) `pdf_tables`, and
		 * nothing else. The value was therefore always `undefined`, and `formatCurrency` fell back to
		 * the system default - which an INR-only fixture cannot detect, because the fallback happened to
		 * be right. A statement on a USD bank account reported every one of its amounts with the wrong
		 * symbol, immediately before the reviewer committed them.
		 *
		 * `doc.currency` is the authority: a native read-only field populated from the bank account's GL
		 * account currency, and the same value `insert_transactions` stamps on every Bank Transaction it
		 * creates. The fixture supplies the phantom top-level key as well, set to a sentinel, so a
		 * regression to reading it is a FAILURE rather than an invisible fallback.
		 */
		it('formats every amount in the DOCUMENT currency, not the system default', () => {
			renderStatementDetails(
				makeStatementDetails({ doc: makeImportLog({ currency: TEST_ALTERNATE_CURRENCY }) })
			)

			expect(rowLabelled('Total Debits')).toHaveTextContent('$ 15,900.25')
			expect(rowLabelled('Total Credits')).toHaveTextContent('$ 48,250.50')
			expect(rowLabelled('Closing Balance as of 31st January 2024')).toHaveTextContent('$ 152,300.75')

			// The preview rows are the same figures the import will create, so they carry the same
			// currency - and the system default must appear nowhere on the screen.
			const preview = tableWithCaption('Transactions to be imported into the system')
			const firstRow = within(preview).getByText('NEFT credit from ACME Traders').closest('tr')
			expect(within(firstRow as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent))
				.toEqual([
					'1',
					'05-01-2024',
					'NEFT credit from ACME Traders',
					'NEFT/2024/000145',
					'$ 0.00',
					'$ 48,250.50'
				])

			expect(rowLabelled('Total Debits')).not.toHaveTextContent('₹')
			expect(rowLabelled('Closing Balance as of 31st January 2024')).not.toHaveTextContent('₹')

			// ...and the phantom response-level member reached nothing.
			expect(rowLabelled('Total Debits')).not.toHaveTextContent(PHANTOM_RESPONSE_CURRENCY)
			expect(preview).not.toHaveTextContent(PHANTOM_RESPONSE_CURRENCY)
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
			importCall.mockResolvedValue({ docs: [makeImportLog({ status: 'Completed' })] })

			renderStatementDetails(data)
			await clickImport()

			// ONE call, on the generic document-method bridge, naming the document and the method.
			// Confirm/post is a single server-side operation, so the client's whole contribution is
			// exactly this request.
			await waitFor(() => {
				expect(importCall).toHaveBeenCalledTimes(1)
			})
			expect(importCall).toHaveBeenCalledWith({ docs: data.doc, method: INSERT_TRANSACTIONS })

			// The import is ONE server-side operation on the document-method bridge, and it is the ONLY
			// endpoint this surface posts to. `toEqual` on a single-element list is the whole point: it
			// fails if any further endpoint is ever instantiated here, which is what keeps the
			// globally-scoped rule evaluator out (see RUN_RULE_EVALUATION and the negative assertion
			// below). No endpoint is added anywhere.
			expect(postEndpointsUsed()).toEqual([RUN_DOC_METHOD])
			expect(postEndpointsUsed()).not.toContain(RUN_RULE_EVALUATION)
			expect(otherPostCall).not.toHaveBeenCalled()
		})

		it('never posts to the globally-scoped rule evaluator, on either outcome', async () => {
			/*
			 * SEC-07. The endpoint authorises an unscoped background write across every company and every
			 * bank account on `Bank Transaction` READ permission alone, so an importer that triggers it
			 * escalates a read into a system-wide write. Both outcomes are checked because a call placed
			 * on the success path only is still a call, and because the constant alone would be satisfied
			 * by a suite that never drove an import at all.
			 */
			importCall.mockResolvedValue({
				docs: [makeImportLog({
					status: 'Completed',
					start_date: SAVED_START_DATE,
					end_date: SAVED_END_DATE
				})]
			})

			renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
			})

			expect(postEndpointsUsed()).not.toContain(RUN_RULE_EVALUATION)
			expect(otherPostCall).not.toHaveBeenCalled()
		})

		it('never posts to the globally-scoped rule evaluator when the import is refused', async () => {
			importCall.mockRejectedValue(makeServerMessagesError('Invalid Bank Account'))

			const { store } = renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).not.toBeNull()
			})

			expect(postEndpointsUsed()).not.toContain(RUN_RULE_EVALUATION)
			expect(otherPostCall).not.toHaveBeenCalled()
		})

		it('moves the reconciliation range to the range the SERVER resolved, then navigates', async () => {
			// The saved document carries the range the server derived while parsing, which is not the
			// range the reconciliation page happened to be filtered to. Reading it off the response is
			// what points the reviewer at the rows that were just created.
			importCall.mockResolvedValue({
				docs: [makeImportLog({
					status: 'Completed',
					start_date: SAVED_START_DATE,
					end_date: SAVED_END_DATE
				})]
			})

			const { store } = renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
			})
			expect(store.get(bankRecDateAtom)).toEqual({
				fromDate: SAVED_START_DATE,
				toDate: SAVED_END_DATE
			})
			expect(toastSuccess).toHaveBeenCalledWith('Bank statement imported.')
		})

		it('leaves the reconciliation range untouched when the saved document carries no dates', async () => {
			// A statement the server could resolve no range for must not overwrite the reviewer's own
			// filter with two empty values.
			importCall.mockResolvedValue({
				docs: [makeImportLog({ status: 'Completed', start_date: undefined, end_date: undefined })]
			})

			const { store } = renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
			})
			expect(store.get(bankRecDateAtom)).toEqual({
				fromDate: PREVIOUS_START_DATE,
				toDate: PREVIOUS_END_DATE
			})
		})

		/*
		 * ⚠️ AN UNCONFIRMED OUTCOME IS NOT A SUCCESS, and the two cases below are the ones that used to
		 * be treated as one.
		 *
		 * A fulfilled promise says only that the request completed. `run_doc_method` appends the
		 * document AFTER running the method and `insert_transactions` sets `status = "Completed"` and
		 * saves as its last act, so a `Completed` doc in the response is the server SAYING the import
		 * committed - while an empty `docs` array, or a doc still at `Not Started`, says nothing of the
		 * kind. Announcing success and navigating on those sent the reviewer to a list that would not
		 * contain the import, with a toast asserting it had happened.
		 *
		 * It is equally not a FAILURE: no refusal was observed, so no per-file failure marker may be
		 * written. It is reported through the WARNING channel and the reviewer is kept on this page -
		 * where the statement's own status badge is the server's answer.
		 *
		 * And it is reported as a TOAST, never through the shared dismissible dialog. That dialog renders
		 * whatever `_server_messages` it is handed, so putting a client-authored envelope into it would
		 * present words the server never said on the one surface whose entire purpose is to carry the
		 * server's own.
		 */
		it('does NOT announce success when the response carries no document at all', async () => {
			importCall.mockResolvedValue({ docs: [] })

			const { store } = renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(toastWarning).toHaveBeenCalledTimes(1)
			})

			expect(screen.queryByText(RECONCILIATION_SENTINEL)).not.toBeInTheDocument()
			expect(toastSuccess).not.toHaveBeenCalled()
			expect(store.get(bankRecDateAtom)).toEqual({
				fromDate: PREVIOUS_START_DATE,
				toDate: PREVIOUS_END_DATE
			})
			// No refusal was observed, so nothing claims one: no error toast, no per-file marker, and no
			// dialog carrying a message the server did not send.
			expect(toastError).not.toHaveBeenCalled()
			expect(store.get(bankRecImportFailuresAtom).size).toBe(0)
			expect(store.get(bankRecErrorDialogAtom)).toBeNull()
		})

		it('does NOT announce success when the returned document is still Not Started', async () => {
			importCall.mockResolvedValue({ docs: [makeImportLog({ status: 'Not Started' })] })

			const { store } = renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(toastWarning).toHaveBeenCalledTimes(1)
			})

			expect(screen.queryByText(RECONCILIATION_SENTINEL)).not.toBeInTheDocument()
			expect(toastSuccess).not.toHaveBeenCalled()
			expect(store.get(bankRecImportFailuresAtom).size).toBe(0)
			expect(store.get(bankRecErrorDialogAtom)).toBeNull()
		})

		it('describes the unknown outcome honestly, without claiming either result', async () => {
			importCall.mockResolvedValue({ docs: [] })

			renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(toastWarning).toHaveBeenCalledTimes(1)
			})

			// The copy must say that transactions MAY have been created, since the client genuinely
			// cannot tell, and it must not read as either a success or a refusal.
			expect(toastWarning.mock.calls[0][0]).toBe('The import could not be confirmed.')
			const description = (toastWarning.mock.calls[0][1] as { description: string }).description
			expect(description).toContain('may or may not have been created')
			expect(description).toContain('Reload this page to see its current status')
		})

		it('neither evaluates rules nor refreshes caches for an unconfirmed outcome', async () => {
			// Both follow-ups exist to prepare a review of rows the server confirmed. Firing them for an
			// outcome nobody confirmed would enqueue work and evict caches on a guess.
			importCall.mockResolvedValue({ docs: [] })

			renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(toastWarning).toHaveBeenCalledTimes(1)
			})

			expect(otherPostCall).not.toHaveBeenCalled()
			expect(frappeSWRMutate).not.toHaveBeenCalled()
		})

		/*
		 * ══════════════════════════════════════════════════════════════════════════════════════════
		 * THE HANDOVER TO REVIEW  (TC1 and TC2)
		 *
		 * An import that commits is only half of "the imported transactions appear in the unreconciled
		 * list with their suggested matches". Two server-side facts stand between the commit and the
		 * reviewer seeing it, and the client has to account for both:
		 *
		 *  TC1  `useGetUnreconciledTransactions` is configured `revalidateIfStale: false` and
		 *       `revalidateOnFocus: false`. If an entry already exists for the (bank, from, to) triple
		 *       the import resolved to, SWR serves it and issues NO request — so navigating straight to
		 *       the workbench showed a list fetched BEFORE the import, without any of the new rows. For
		 *       the very common case of importing a statement covering the range already on screen, the
		 *       import appeared to have done nothing at all.
		 *
		 *  TC2  is deliberately NOT this client's job. `insert_transactions` queues evaluation itself,
		 *       scoped to the log's own bank account, after the log is saved and after the imported rows
		 *       commit — so the worker is guaranteed to see them and the first review has its suggested
		 *       matches. The whitelisted endpoint is a manager-level action requiring `Bank Transaction`
		 *       WRITE permission, so this surface does not call it; the negative assertions below are
		 *       what keep the client out of it.
		 * ══════════════════════════════════════════════════════════════════════════════════════════ */
		describe('the handover to review', () => {

			const completedImport = () => {
				importCall.mockResolvedValue({
					docs: [makeImportLog({
						status: 'Completed',
						start_date: SAVED_START_DATE,
						end_date: SAVED_END_DATE
					})]
				})
			}

			it('evicts every cache key the workbench reads for the range the SERVER resolved', async () => {
				completedImport()

				renderStatementDetails(makeStatementDetails())
				await clickImport()

				await waitFor(() => {
					expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
				})

				// The keys are the ones `utils.ts` constructs, character for character, and they are
				// keyed on the SERVER's range — not on the range this page happened to be filtered to.
				const revalidated = frappeSWRMutate.mock.calls.map(([key]) => key)
				expect(revalidated).toContain(
					`bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-${SAVED_START_DATE}-${SAVED_END_DATE}`
				)
				expect(revalidated).toContain(
					`bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${SAVED_START_DATE}-${SAVED_END_DATE}`
				)
				expect(revalidated).toContain(
					`bank-reconciliation-account-closing-balance-${TEST_BANK_ACCOUNT}-${SAVED_END_DATE}`
				)
				expect(revalidated).toContain(
					`bank-reconciliation-account-closing-balance-as-per-statement-${TEST_BANK_ACCOUNT}-${SAVED_END_DATE}`
				)
			})

			/*
			 * THE CALL SHAPE IS THE FIX, so it is asserted as such rather than left implied.
			 *
			 * `mutate(key)` and `mutate(key, undefined, { revalidate: true })` are DIFFERENT OPERATIONS in
			 * SWR, not two spellings of one: the first only notifies revalidators that a MOUNTED hook has
			 * registered, while the second writes `data: undefined` into the cache entry first. The
			 * workbench hooks are unmounted at this moment, so only the second does anything at all. The
			 * real-cache regression below proves that difference against SWR itself; this pins the shape
			 * the page actually uses, so a "simplification" back to one argument fails here.
			 */
			it('passes the eviction arguments, not a bare revalidation request', async () => {
				completedImport()

				renderStatementDetails(makeStatementDetails())
				await clickImport()

				await waitFor(() => {
					expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
				})

				expect(frappeSWRMutate).toHaveBeenCalledTimes(4)
				for (const call of frappeSWRMutate.mock.calls) {
					expect(call).toHaveLength(3)
					// `undefined` data with `populateCache` left at its default is what clears the entry.
					expect(call[1]).toBeUndefined()
					expect(call[2]).toEqual({ revalidate: true })
				}
			})

			it('evicts BEFORE navigating, so the workbench never mounts on the stale entry', async () => {
				completedImport()
				// ONE held promise returned for every key. Four separate promises would leave the
				// `Promise.all` waiting on three nobody resolves, and the test would fail for a reason
				// that had nothing to do with the ordering it is asserting.
				let releaseRefresh!: () => void
				const heldRefresh = new Promise<undefined>((resolve) => {
					releaseRefresh = () => resolve(undefined)
				})
				frappeSWRMutate.mockImplementation(() => heldRefresh)

				renderStatementDetails(makeStatementDetails())
				await clickImport()

				await waitFor(() => {
					expect(frappeSWRMutate).toHaveBeenCalled()
				})
				// Held open: the reviewer has not been moved yet.
				expect(screen.queryByText(RECONCILIATION_SENTINEL)).not.toBeInTheDocument()

				await act(async () => {
					releaseRefresh()
					await heldRefresh
				})

				await waitFor(() => {
					expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
				})
			})

			it('navigates anyway when an eviction fails, rather than withholding the handover', async () => {
				completedImport()
				frappeSWRMutate.mockRejectedValue(new Error('network'))

				renderStatementDetails(makeStatementDetails())
				await clickImport()

				await waitFor(() => {
					expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
				})
				expect(toastSuccess).toHaveBeenCalledWith('Bank statement imported.')
			})

			it('does not evict anything when the server resolved no range', async () => {
				// With no range there is no key to name, and evicting a guess would discard a cache entry
				// for a range the import may have nothing to do with.
				importCall.mockResolvedValue({
					docs: [makeImportLog({ status: 'Completed', start_date: undefined, end_date: undefined })]
				})

				renderStatementDetails(makeStatementDetails())
				await clickImport()

				await waitFor(() => {
					expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
				})
				expect(frappeSWRMutate).not.toHaveBeenCalled()
			})

			it('hands the reviewer over even when every eviction is refused', async () => {
				// The eviction improves the FIRST look at the list; it is not a precondition for it. The
				// rows exist on the server either way, and blocking the handover would trade a possibly
				// stale list for no list at all — so the reviewer is moved, and the list they land on is
				// whatever SWR is holding.
				completedImport()
				frappeSWRMutate.mockRejectedValue(new Error('offline'))

				renderStatementDetails(makeStatementDetails())
				await clickImport()

				await waitFor(() => {
					expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
				})
				expect(toastSuccess).toHaveBeenCalledWith('Bank statement imported.')
			})
		})

		/*
		 * ══════════════════════════════════════════════════════════════════════════════════════════
		 * THE REGRESSION, AGAINST A REAL SWR CACHE AND A REAL ROUTE TRANSITION  (CR-01, TC1)
		 *
		 * The assertions above observe the CALL the page makes. They cannot observe what SWR does with
		 * it, and that is exactly where the defect lived: `mutate(key)` was called for every key, every
		 * call resolved, and the reviewer still arrived at a list without the rows they had just
		 * imported. A suite that only checks the calls is satisfied by the broken version.
		 *
		 * So these two cases use the REAL SWR primitives - obtained through `vi.importActual` on the
		 * SDK, which re-exports them, so the test drives the same implementation the app does - and
		 * reproduce the actual sequence: a workbench query configured exactly as
		 * `useGetUnreconciledTransactions` is (`revalidateIfStale: false`, `revalidateOnFocus: false`),
		 * mounted, resolved, UNMOUNTED as the reviewer navigates away, then invalidated, then REMOUNTED
		 * as they return.
		 *
		 * The pair is deliberately symmetric: one shows the old call shape leaving the stale entry in
		 * place with no refetch, the other shows the shape the page now uses clearing it and forcing
		 * one. Without the first, the second proves nothing about the bug.
		 *
		 * Keys are unique per test because these share SWR's process-wide default cache; there is no
		 * `SWRConfig` provider, and there does not need to be one.
		 * ══════════════════════════════════════════════════════════════════════════════════════════ */
		describe('a real SWR cache across the route transition', () => {

			type SDK = typeof import('frappe-react-sdk')
			let realUseSWR: SDK['useSWR']
			let realUseSWRConfig: SDK['useSWRConfig']

			beforeEach(async () => {
				const actual = await vi.importActual<SDK>('frappe-react-sdk')
				realUseSWR = actual.useSWR
				realUseSWRConfig = actual.useSWRConfig
			})

			/** The keyed global `mutate`, reachable only from inside a component. */
			const captureMutate = (): { current: ReturnType<SDK['useSWRConfig']>['mutate'] } => {
				const captured = { current: undefined as unknown as ReturnType<SDK['useSWRConfig']>['mutate'] }
				const Probe = () => {
					captured.current = realUseSWRConfig().mutate
					return null
				}
				render(<Probe />)
				return captured
			}

			/**
			 * Mounts one query with the workbench's own SWR options and reports what it is showing.
			 *
			 * The options are the load-bearing part: `revalidateIfStale: false` is what makes a cached
			 * entry authoritative on mount, and it is precisely why an entry that was merely "revalidated"
			 * while nothing was subscribed is served again unchanged.
			 */
			const mountQuery = (key: string, fetcher: () => Promise<string[]>) => {
				const seen: (string[] | undefined)[] = []
				const Workbench = () => {
					const { data } = realUseSWR(key, fetcher, {
						revalidateIfStale: false,
						revalidateOnFocus: false
					})
					seen.push(data)
					return <span data-testid="rows">{(data ?? []).join(',')}</span>
				}
				return { seen, ...render(<Workbench />) }
			}

			it('leaves the stale rows in place when only a bare revalidation is requested', async () => {
				// THE DEFECT, reproduced. This is what `mutate(key)` did.
				const key = `swr-regression-bare-${Date.now()}`
				const fetcher = vi.fn<() => Promise<string[]>>()
					.mockResolvedValueOnce(['before the import'])
					.mockResolvedValue(['before the import', 'the imported row'])

				const first = mountQuery(key, fetcher)
				await waitFor(() => {
					expect(screen.getByTestId('rows')).toHaveTextContent('before the import')
				})
				// The reviewer navigates to the importer: the query is no longer subscribed, so there is no
				// revalidator registered for this key.
				first.unmount()

				const mutate = captureMutate()
				await act(async () => {
					await mutate.current(key)
				})

				// Back to the workbench.
				mountQuery(key, fetcher)
				await waitFor(() => {
					expect(screen.getByTestId('rows')).toHaveTextContent('before the import')
				})

				// One fetch in total, and the imported row is nowhere: the import looked as though it had
				// done nothing at all.
				expect(fetcher).toHaveBeenCalledTimes(1)
				expect(screen.getByTestId('rows')).not.toHaveTextContent('the imported row')
			})

			it('clears the entry and refetches on remount when the imported range is EVICTED', async () => {
				// THE FIX. The exact arguments `refreshImportedRange` now passes.
				const key = `swr-regression-evict-${Date.now()}`
				const fetcher = vi.fn<() => Promise<string[]>>()
					.mockResolvedValueOnce(['before the import'])
					.mockResolvedValue(['before the import', 'the imported row'])

				const first = mountQuery(key, fetcher)
				await waitFor(() => {
					expect(screen.getByTestId('rows')).toHaveTextContent('before the import')
				})
				first.unmount()

				const mutate = captureMutate()
				await act(async () => {
					await mutate.current(key, undefined, { revalidate: true })
				})

				mountQuery(key, fetcher)

				// A second fetch, and the row the import created is on screen.
				await waitFor(() => {
					expect(screen.getByTestId('rows')).toHaveTextContent('the imported row')
				})
				expect(fetcher).toHaveBeenCalledTimes(2)
			})
		})

		/*
		 * FM2: THE MARKER IS A VERDICT ON ONE ATTEMPT, so a new attempt has to retire it.
		 *
		 * `Bank Statement Import Log` has two status values and no error field, so a refused import
		 * rolls back and leaves the row at `Not Started` — indistinguishable from one nobody has tried.
		 * The session marker is the only per-file failure signal that can exist, and precisely because
		 * it is not server state, nothing else will ever clear it.
		 */
		describe('retiring the per-file failure marker', () => {

			const seedFailure = (store: ReturnType<typeof createStore>) => {
				store.set(bankRecImportFailuresAtom, new Map([[IMPORT_LOG_NAME, 'Invalid Bank Account']]))
			}

			it('clears a previous failure as soon as a retry is dispatched', async () => {
				// Cleared at the START of the retry, not at its end: while the new attempt is in flight
				// the importer list must not keep asserting a failure that is being actively re-tested.
				importCall.mockReturnValue(new Promise(() => { /* never settles */ }))

				const { store } = renderStatementDetails(makeStatementDetails(), seedFailure)
				expect(store.get(bankRecImportFailuresAtom).get(IMPORT_LOG_NAME)).toBe('Invalid Bank Account')

				await clickImport()

				await waitFor(() => {
					expect(store.get(bankRecImportFailuresAtom).has(IMPORT_LOG_NAME)).toBe(false)
				})
			})

			it('leaves it cleared after a retry the server confirms', async () => {
				importCall.mockResolvedValue({ docs: [makeImportLog({ status: 'Completed' })] })

				const { store } = renderStatementDetails(makeStatementDetails(), seedFailure)
				await clickImport()

				await waitFor(() => {
					expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
				})
				expect(store.get(bankRecImportFailuresAtom).size).toBe(0)
			})

			it('records the NEW message when the retry is refused again', async () => {
				importCall.mockRejectedValue(makeServerMessagesError('The bank account is disabled'))

				const { store } = renderStatementDetails(makeStatementDetails(), seedFailure)
				await clickImport()

				await waitFor(() => {
					expect(store.get(bankRecImportFailuresAtom).get(IMPORT_LOG_NAME))
						.toBe('The bank account is disabled')
				})
				// The stale message is gone rather than accumulated alongside the new one.
				expect(store.get(bankRecImportFailuresAtom).size).toBe(1)
			})

			it('does not disturb a marker recorded against a DIFFERENT statement', async () => {
				importCall.mockResolvedValue({ docs: [makeImportLog({ status: 'Completed' })] })
				const otherLog = 'bsil-other-file'

				const { store } = renderStatementDetails(makeStatementDetails(), (s) => {
					s.set(bankRecImportFailuresAtom, new Map([
						[IMPORT_LOG_NAME, 'Invalid Bank Account'],
						[otherLog, 'No tables detected']
					]))
				})
				await clickImport()

				await waitFor(() => {
					expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
				})
				expect(store.get(bankRecImportFailuresAtom).has(IMPORT_LOG_NAME)).toBe(false)
				expect(store.get(bankRecImportFailuresAtom).get(otherLog)).toBe('No tables detected')
			})
		})

		it('records no failure marker for an import the server accepted', async () => {
			importCall.mockResolvedValue({ docs: [makeImportLog({ status: 'Completed' })] })

			const { store } = renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
			})
			expect(store.get(bankRecImportFailuresAtom).size).toBe(0)
			expect(store.get(bankRecErrorDialogAtom)).toBeNull()
		})

		it('creates nothing client-side: only the server-side import inserts transactions', async () => {
			importCall.mockResolvedValue({ docs: [makeImportLog({ status: 'Completed' })] })

			renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(importCall).toHaveBeenCalledTimes(1)
			})
			expectNoClientSideWrites()
		})

		it('blocks a second submission while the post is in flight', () => {
			installPostCallHook({ loading: true })

			renderStatementDetails(makeStatementDetails())

			const control = screen.getByRole('button', { name: 'Importing...' })
			expect(control).toBeDisabled()
			expect(screen.queryByRole('button', { name: /^Import \d+ transactions$/ })).not.toBeInTheDocument()
		})

		it('withholds the control for a file the server recognised no transactions in', () => {
			// Nothing to post, so nothing is offered. This is the ORIGINAL guard on the control and is
			// unrelated to the failure marker below, which describes a refused ATTEMPT.
			renderStatementDetails(makeStatementDetails({ final_transactions: [], conflicting_transactions: [] }))

			expect(screen.getByRole('button', { name: 'Import 0 transactions' })).toBeDisabled()
		})
	})

	/*
	 * FM2. A malformed or empty statement file, a disabled or non-company bank account, a missing PDF
	 * password, an unreadable file type or an insufficiently privileged user all make
	 * `insert_transactions` throw, and the whole request rolls back. The rejection callback used to
	 * take NO argument at all, so the server's own account of the refusal was discarded and the
	 * reviewer saw only a generic toast.
	 */
	describe('FM2 — a refused import surfaces the backend error and creates nothing', () => {

		const REFUSAL = 'The bank account is disabled. Please enable it'

		const refuseImport = async (error: ReturnType<typeof makeServerMessagesError> = makeServerMessagesError(REFUSAL)) => {
			const data = makeStatementDetails()
			importCall.mockRejectedValue(error)

			const rendered = renderStatementDetails(data)
			await clickImport()

			return { ...rendered, data, error }
		}

		it("renders the server's own message verbatim in the shared dismissible dialog", async () => {
			await refuseImport()

			const dialog = await screen.findByRole('alertdialog')
			expect(dialog).toHaveTextContent(REFUSAL)
			expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
		})

		it('holds the error object UNMODIFIED, so the shared parser sees Frappe\'s own envelope', async () => {
			const { store, error } = await refuseImport()

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBe(error)
			})
		})

		it('records a per-file failure marker keyed by this import log', async () => {
			// The only place a per-file failure can live: `Bank Statement Import Log` offers just
			// `Not Started` and `Completed`, carries no error field, and a refused import rolls back -
			// so the row would otherwise look exactly like one merely waiting to be imported.
			const { store, data } = await refuseImport()

			await waitFor(() => {
				expect(store.get(bankRecImportFailuresAtom).get(data.doc.name)).toContain(REFUSAL)
			})
			expect(store.get(bankRecImportFailuresAtom).size).toBe(1)
		})

		it('replaces the marker map rather than mutating it, so the list re-renders', async () => {
			const data = makeStatementDetails()
			importCall.mockRejectedValue(makeServerMessagesError(REFUSAL))

			const seededMap = new Map<string, string>()
			const { store } = renderStatementDetails(data, (seeded) => {
				seeded.set(bankRecImportFailuresAtom, seededMap)
			})
			await clickImport()

			await waitFor(() => {
				expect(store.get(bankRecImportFailuresAtom).size).toBe(1)
			})
			// A mutated Map would be the same reference and jotai would publish nothing.
			expect(store.get(bankRecImportFailuresAtom)).not.toBe(seededMap)
			expect(seededMap.size).toBe(0)
		})

		it('leaves a marker recorded for another file alone', async () => {
			const data = makeStatementDetails()
			const otherLog = makeImportLog({ name: 'other-import-log' })
			importCall.mockRejectedValue(makeServerMessagesError(REFUSAL))

			const { store } = renderStatementDetails(data, (seeded) => {
				seeded.set(bankRecImportFailuresAtom, makeImportFailures(otherLog, 'a different refusal'))
			})
			await clickImport()

			await waitFor(() => {
				expect(store.get(bankRecImportFailuresAtom).size).toBe(2)
			})
			expect(store.get(bankRecImportFailuresAtom).get(otherLog.name)).toBe('a different refusal')
		})

		it('keeps the transient toast as well — the dialog is additive, not a replacement', async () => {
			await refuseImport()

			await waitFor(() => {
				expect(toastError).toHaveBeenCalledTimes(1)
			})
			expect(toastError).toHaveBeenCalledWith('There was an error while importing the bank statement.')
			expect(toastSuccess).not.toHaveBeenCalled()
		})

		it('claims no success: no navigation, and the import stays offered', async () => {
			await refuseImport()

			await screen.findByRole('alertdialog')

			expect(screen.queryByText(RECONCILIATION_SENTINEL)).not.toBeInTheDocument()
			// `hidden: true` because Radix marks the page behind an open alert dialog `aria-hidden`;
			// the control is still mounted and still enabled, which is the point being asserted.
			expect(screen.getByRole('button', {
				name: `Import ${FINAL_TRANSACTIONS.length} transactions`,
				hidden: true
			})).toBeEnabled()
		})

		it('creates no transaction client-side and posts nothing beyond the one refused call', async () => {
			await refuseImport()

			await screen.findByRole('alertdialog')

			expect(importCall).toHaveBeenCalledTimes(1)
			expectNoClientSideWrites()
		})

		it('dismisses on request, leaving the recorded marker in place', async () => {
			const user = userEvent.setup()
			const { store, data } = await refuseImport()

			await user.click(await screen.findByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
			// The dialog is transient; the row has to keep saying the import failed after it is gone.
			expect(store.get(bankRecImportFailuresAtom).get(data.doc.name)).toContain(REFUSAL)
		})

		it('surfaces a refusal that arrives in _error_message rather than _server_messages', async () => {
			await refuseImport(makeErrorMessageError('Not permitted') as ReturnType<typeof makeServerMessagesError>)

			expect(await screen.findByRole('alertdialog')).toHaveTextContent('Not permitted')
		})

		it("renders the post call's own error inline, through the shared banner", async () => {
			// The hook's OWN `error` member, which a rejected `call` never populates - so this path is
			// reachable only from the hook. It renders inline through the same shared banner the dialog
			// composes, so the two cannot disagree about the same rejection.
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
			expect(screen.queryByText(/Importing transactions/)).not.toBeInTheDocument()
		})

		/*
		 * ⚠️ `progress` IS A PERCENTAGE, NOT A COUNT, and the label used to say otherwise.
		 *
		 * `insert_transactions` publishes `{"progress": round(rows_inserted / total_rows * 100)}` after
		 * each row and one final `{"progress": 100, "total": <rows>}`. The label rendered that figure as
		 * "Importing {progress} transactions", so a 30-row statement announced "Importing 3 transactions"
		 * at the first row and "Importing 100 transactions" at the last - a number that was neither the
		 * count nor recognisable as a percentage, and which OVERSTATED the work for any statement of
		 * fewer than 100 rows. `total` is the only row count the channel carries.
		 */
		it('renders the pushed figure as a PERCENTAGE, alongside the bar', () => {
			renderStatementDetails(makeStatementDetails())

			// `act` is the caller's responsibility: the captured handler sets React state.
			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 50 })
			})

			expect(screen.getByText('Importing transactions... 50% complete')).toBeInTheDocument()
			// The regression spelling, pinned as absent: 50 is not a number of transactions.
			expect(screen.queryByText('Importing 50 transactions')).not.toBeInTheDocument()
			expect(screen.getByRole('progressbar')).toBeInTheDocument()
		})

		it('follows each subsequent push', () => {
			renderStatementDetails(makeStatementDetails())

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 33 })
			})
			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 67 })
			})

			expect(screen.getByText('Importing transactions... 67% complete')).toBeInTheDocument()
			expect(screen.queryByText('Importing transactions... 33% complete')).not.toBeInTheDocument()
		})

		/**
		 * The server's final push carries both members (`{ progress: 100, total: N }`), which is the
		 * shape that made the count/percentage confusion easy to miss. Once `total` has arrived the
		 * label can state BOTH quantities, each as what it is.
		 */
		it("reports the row total from the server's final push, distinctly from the percentage", () => {
			renderStatementDetails(makeStatementDetails())

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 100, total: 300 })
			})

			expect(screen.getByText('Imported 300 transactions (100% complete)')).toBeInTheDocument()
			// The regression spelling: 100 is the percentage and must never be shown as a count.
			expect(screen.queryByText('Importing 100 transactions')).not.toBeInTheDocument()
		})

		it('keeps the row total once it has arrived, and does not invent one before', () => {
			renderStatementDetails(makeStatementDetails())

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 40 })
			})
			// Before the final push there is NO count on the channel, so none is stated.
			expect(screen.getByText('Importing transactions... 40% complete')).toBeInTheDocument()

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 100, total: 30 })
			})
			expect(screen.getByText('Imported 30 transactions (100% complete)')).toBeInTheDocument()
		})

		it('caps the bar at the maximum it declares, whatever figure arrives', () => {
			renderStatementDetails(makeStatementDetails())

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 120 })
			})

			// The bar's own contract is what bounds the visual: it declares `max={100}`, and Radix omits
			// `aria-valuenow` altogether for a value outside that range rather than announcing an
			// impossible one.
			const bar = screen.getByRole('progressbar')
			expect(bar).toHaveAttribute('aria-valuemax', '100')
			expect(bar).not.toHaveAttribute('aria-valuenow')
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
