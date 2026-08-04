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
	frappeSDKMock,
	frappeUpdateDoc,
	getFrappeEventListener,
	makeBankAccountListRow,
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
	bankRecImportFailuresAtom
} from '../../BankReconciliation/bankRecAtoms'

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

/*
 * The response as the SPA's own `GetStatementDetailsResponse` declares it: `doc`, `date_format`,
 * `conflicting_transactions`, `final_transactions`, `raw_data` and the response-level `currency` the
 * screen formats its amounts with.
 *
 * `currency` defaults to {@link TEST_CURRENCY} and is overridden in the non-default-currency test, so
 * a screen formatting with the SYSTEM default instead of the response value is detectable rather than
 * hidden behind two values that happen to agree.
 */
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
		 * ⚠️ THE F2 REGRESSION, and the reason it needs a NON-DEFAULT currency to be visible at all.
		 *
		 * Every figure on this screen used to be formatted with a response-level `currency` member
		 * that `get_statement_details` does not send (it returns `doc`, `date_format`,
		 * `conflicting_transactions`, `final_transactions` and `raw_data`). The value was therefore
		 * always `undefined`, and `formatCurrency` fell back to the system default - which an
		 * INR-only fixture cannot detect, because the fallback happened to be right. A statement on a
		 * USD bank account reported every one of its amounts with the wrong symbol.
		 *
		 * The document's own `currency` is the authority: a native read-only field populated from the
		 * bank account's GL account currency. Nothing here supplies a top-level key - the interface no
		 * longer has one - so a screen that regressed to reading it would fall back to `₹` and fail.
		 */
		it('formats every amount in the RESPONSE currency, not the system default', () => {
			renderStatementDetails(makeStatementDetails({ currency: TEST_ALTERNATE_CURRENCY }))

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
			expect(postEndpointsUsed()).toEqual([RUN_DOC_METHOD])
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

		it('hands over even when the response carries no document at all', async () => {
			// `run_doc_method` always appends the document it ran the method on, so this is a degenerate
			// response rather than an expected one - but the client reads it defensively and must not
			// throw on the way through. It simply has no range to apply.
			importCall.mockResolvedValue({ docs: [] })

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
			expect(screen.queryByText('Importing 0 transactions')).not.toBeInTheDocument()
		})

		/*
		 * The label and the bar are both driven from the single `progress` figure the server pushes, so
		 * this asserts what the component actually renders for a given push rather than an ideal
		 * wording. `insert_transactions` publishes `round(rows_inserted / total_rows * 100)` per row and
		 * a final push carrying `total` as well; the bar is `max={100}`.
		 */
		it('renders the figure the server pushed, alongside the bar', () => {
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
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 33 })
			})
			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 67 })
			})

			expect(screen.getByText('Importing 67 transactions')).toBeInTheDocument()
			expect(screen.queryByText('Importing 33 transactions')).not.toBeInTheDocument()
		})

		/**
		 * The server's final push carries both members (`{ progress: 100, total: N }`), which is the
		 * shape that made the count/percentage confusion easy to miss: `total` is the count, and it
		 * is the only count on the channel.
		 */
		it("accepts the server's final push, which carries the row total alongside the figure", () => {
			renderStatementDetails(makeStatementDetails())

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 100, total: 300 })
			})

			expect(screen.getByText('Importing 100 transactions')).toBeInTheDocument()
			// 300 is the ROW COUNT and must never be rendered as the progress figure.
			expect(screen.queryByText('Importing 300 transactions')).not.toBeInTheDocument()
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
