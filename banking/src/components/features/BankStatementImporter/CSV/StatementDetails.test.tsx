/*
 * The statement-import review step shared by the CSV and PDF flows.
 *
 * Two render gates silently decide what exists in the tree: the Import control renders only while
 * `doc.status !== 'Completed'` and is disabled when `final_transactions` is empty, and the preview
 * table and `ConflictingTransactions` render only while `doc.status === 'Not Started'`. The base
 * fixture opens both gates and every variant is derived from it.
 *
 * Three instrumentation constraints are easy to get wrong:
 *   • Toasts emit NO DOM here, because `<Toaster />` is mounted in `src/App.tsx` and this suite
 *     renders the component directly, so `sonner` is mocked and the toast CALLS are asserted.
 *   • A rejecting `call` does not populate the hook's own `error` member, so the inline `ErrorBanner`
 *     is exercised by overriding that hook's RETURN - a separate seam from the dialog, which is driven
 *     by the rejection the component's own `.catch` receives.
 *   • `useGetBankAccounts` reads `data.message`, so the bank list has to be supplied explicitly or the
 *     account cells render blank.
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
const { toastError, toastSuccess, toastWarning } = vi.hoisted(() => ({
	toastError: vi.fn<(message: string) => void>(),
	toastSuccess: vi.fn<(message: string) => void>(),
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
 * The whitelisted rule evaluator, retained as the subject of a negative assertion: import triggers rule
 * evaluation server-side, so this client surface must not issue a second evaluator call.
 */
const RUN_RULE_EVALUATION = 'erpnext.accounts.doctype.bank_transaction_rule.bank_transaction_rule.run_rule_evaluation'
const INSERT_TRANSACTIONS = 'insert_transactions'

const STATEMENT_START_DATE = '2024-01-01'
const STATEMENT_END_DATE = '2024-01-31'

const SAVED_START_DATE = '2024-01-04'
const SAVED_END_DATE = '2024-01-29'

const PREVIOUS_START_DATE = '2023-12-01'
const PREVIOUS_END_DATE = '2023-12-31'

const OTHER_BANK_ACCOUNT = 'Second Bank - Test Company'

const RECONCILIATION_SENTINEL = 'Reconciliation workbench'

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
 * The prop this step consumes, composed from the shared import-log builder plus the members the screen
 * reads. Typed against `GetStatementDetailsResponse`, so a member the endpoint does not return cannot
 * be invented here without a compile error.
 *
 * THE STATEMENT CURRENCY IS ON `doc`, NOT AT THE TOP LEVEL. `get_statement_details` returns exactly
 * `doc`, `date_format`, `conflicting_transactions`, `final_transactions`, `raw_data` and - for PDFs
 * only - `pdf_tables`; `pdf_tables` is omitted because this component never reads it. An earlier
 * revision of this fixture supplied a top-level `currency` that the endpoint never sends, which made
 * the screen's `data.currency` reads look correct here while being `undefined` in production.
 */
const RESPONSE_CURRENCY = TEST_CURRENCY

const makeStatementDetails = (
	overrides: Partial<GetStatementDetailsResponse> = {}
): GetStatementDetailsResponse => ({
	doc: makeImportLog({ currency: RESPONSE_CURRENCY }),
	conflicting_transactions: CONFLICTING_TRANSACTIONS,
	final_transactions: FINAL_TRANSACTIONS,
	date_format: DETECTED_DATE_FORMAT,
	raw_data: RAW_DATA,
	...overrides
})

const importCall = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>()

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
 * Answers the bank-account list with one row whose `name` MATCHES the log's `bank_account`, which is
 * what the component looks the account up by. Any other endpoint answers empty.
 *
 * The row comes from the ENDPOINT builder, not the persisted-selection builder: the two projections
 * differ in both directions, so the selection fixture would answer with a row the server cannot
 * produce.
 */
const installBankAccountList = (rows: unknown[] = [makeBankAccountListRow()]) => {
	frappeSDKMock.useFrappeGetCall.mockImplementation((method) =>
		method.endsWith('bank_account.get_list') ? queryResponse({ message: rows }) : queryResponse(undefined)
	)
}

/*
 * `TooltipProvider` is required rather than decorative: Radix's tooltip context has no default, so the
 * details table's info tooltips throw without it. `MemoryRouter` is required because the step renders a
 * `Link` and calls `useNavigate`, and the sentinel route makes navigation observable without mocking
 * the hook. The store is per render because `bankRecDateAtom` is backed by `localStorage` and the
 * harness performs no global atom reset.
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

const installRuleEvaluationCounts = ({ rules = 1, pending = 0 }: { rules?: number, pending?: number } = {}) => {
	frappeContextValue.db.getCount.mockImplementation(async (doctype: string) =>
		doctype === 'Bank Transaction Rule' ? rules : pending)
}

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

			await waitFor(() => {
				expect(importCall).toHaveBeenCalledTimes(1)
			})
			expect(importCall).toHaveBeenCalledWith({ docs: data.doc, method: INSERT_TRANSACTIONS })

			expect(postEndpointsUsed()).toEqual([RUN_DOC_METHOD])
			expect(postEndpointsUsed()).not.toContain(RUN_RULE_EVALUATION)
			expect(otherPostCall).not.toHaveBeenCalled()
		})

		it('never posts to the globally-scoped rule evaluator, on either outcome', async () => {
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




		it('records no failure marker for an import the server accepted', async () => {
			importCall.mockResolvedValue({ docs: [makeImportLog({ status: 'Completed' })] })

			const { store } = renderStatementDetails(makeStatementDetails())
			await clickImport()

			await waitFor(() => {
				expect(screen.getByText(RECONCILIATION_SENTINEL)).toBeInTheDocument()
			})
			expect(Object.keys(store.get(bankRecImportFailuresAtom))).toHaveLength(0)
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

		/*
		 * A CLIENT-SIDE GUARD, NOT THE FM2 EMPTY-FILE PATH. Reaching this screen at all means the file
		 * already parsed: `Bank Statement Import Log` runs `get_data` / `prepare_pdf_tables` in
		 * `before_insert`, so a genuinely empty or malformed file is refused during creation, on the
		 * upload surface, and no detail screen is ever rendered for it. That refusal is covered
		 * end-to-end in `pages/BankStatementImporter.test.tsx`.
		 *
		 * What this covers is the narrower case of a file that parsed but yielded no rows - so there is
		 * nothing to post, and the control is withheld rather than dispatched.
		 */
		it('withholds the control for a parsed file the server recognised no transactions in', async () => {
			renderStatementDetails(makeStatementDetails({ final_transactions: [], conflicting_transactions: [] }))

			expect(screen.getByRole('button', { name: 'Import 0 transactions' })).toBeDisabled()

			// Disabled means DISPATCHES NOTHING, which is the property that actually matters.
			await userEvent.click(screen.getByRole('button', { name: 'Import 0 transactions' }))
			expect(importCall).not.toHaveBeenCalled()
			expectNoClientSideWrites()
		})
	})

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

		it('records the RAW error as a per-file marker keyed by this import log', async () => {
			const { store, data, error } = await refuseImport()

			await waitFor(() => {
				expect(store.get(bankRecImportFailuresAtom)[data.doc.name]).toBe(error)
			})
			expect(Object.keys(store.get(bankRecImportFailuresAtom))).toEqual([data.doc.name])
		})

		it('replaces the marker record rather than mutating it, so the list re-renders', async () => {
			const data = makeStatementDetails()
			importCall.mockRejectedValue(makeServerMessagesError(REFUSAL))

			const seededRecord = {}
			const { store } = renderStatementDetails(data, (seeded) => {
				seeded.set(bankRecImportFailuresAtom, seededRecord)
			})
			await clickImport()

			await waitFor(() => {
				expect(Object.keys(store.get(bankRecImportFailuresAtom))).toHaveLength(1)
			})
			// A mutated record would be the same reference and jotai would publish nothing.
			expect(store.get(bankRecImportFailuresAtom)).not.toBe(seededRecord)
			expect(Object.keys(seededRecord)).toHaveLength(0)
		})

		it('leaves a marker recorded for another file alone', async () => {
			const data = makeStatementDetails()
			const otherLog = makeImportLog({ name: 'other-import-log' })
			const otherFailures = makeImportFailures(otherLog, 'a different refusal')
			importCall.mockRejectedValue(makeServerMessagesError(REFUSAL))

			const { store } = renderStatementDetails(data, (seeded) => {
				seeded.set(bankRecImportFailuresAtom, otherFailures)
			})
			await clickImport()

			await waitFor(() => {
				expect(Object.keys(store.get(bankRecImportFailuresAtom))).toHaveLength(2)
			})
			expect(store.get(bankRecImportFailuresAtom)[otherLog.name]).toBe(otherFailures[otherLog.name])
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
			expect(store.get(bankRecImportFailuresAtom)[data.doc.name]).toBeDefined()
		})

		it('surfaces a refusal that arrives in _error_message rather than _server_messages', async () => {
			await refuseImport(makeErrorMessageError('Not permitted') as ReturnType<typeof makeServerMessagesError>)

			expect(await screen.findByRole('alertdialog')).toHaveTextContent('Not permitted')
		})

		it("renders the post call's own error inline, through the shared banner", async () => {
			// The hook's OWN `error` member, which a rejected `call` never populates - so this path is
			// reachable only from the hook, and it renders through the same shared banner the dialog composes.
			installPostCallHook({ hookError: makeServerMessagesError('This bank account is disabled') })

			renderStatementDetails(makeStatementDetails({ conflicting_transactions: [] }))

			const banner = screen.getByRole('alert')
			expect(banner).toHaveTextContent('There was an error.')
			expect(banner).toHaveTextContent('This bank account is disabled')
		})
	})


	/*
	 * THE SERVER'S `progress` IS A PERCENTAGE, NOT A ROW COUNT. `insert_transactions` publishes
	 * `{ progress: round(done / total * 100) }` after each row and then ONE terminal
	 * `{ progress: 100, total: <rows> }`. `total` is therefore the only figure in this channel that is
	 * a transaction count, and it arrives exactly once, at the end.
	 *
	 * Events also carry no import-log identity, so this screen accepts them only while an attempt IT
	 * started has not yet settled. Each test below therefore starts a real import first.
	 */
	describe('realtime import progress', () => {
	/*
	 * The bar's FILL, read off the indicator's inline transform, which is `translateX(-(100 - value)%)`.
	 *
	 * Asserted here rather than through `aria-valuenow`, because the shared `ui/progress` primitive
	 * destructures `value` and never forwards it to the Radix root: the root therefore always reports
	 * itself indeterminate with no `aria-valuenow` at all, whatever value it is given. That is a defect
	 * in a design-system primitive this project treats as reference-only, so it is documented rather
	 * than fixed, and the transform is what remains observable.
	 */
	const indicatorTransform = (): string | undefined =>
		screen
			.getByRole('progressbar')
			.querySelector<HTMLElement>('[data-slot="progress-indicator"]')?.style.transform

		/** Dispatches Import against a post that never settles, so the attempt stays in flight. */
		const startAnImportThatStaysInFlight = async () => {
			let settle: () => void = () => undefined
			importCall.mockImplementation(() => new Promise<never>(() => {
				settle = () => undefined
			}))
			void settle

			renderStatementDetails(makeStatementDetails())
			await userEvent.click(screen.getByRole('button', { name: 'Import 3 transactions' }))
		}

		it('subscribes to the import-progress channel', () => {
			renderStatementDetails(makeStatementDetails())

			expect(frappeSDKMock.useFrappeEventListener).toHaveBeenCalledWith(
				IMPORT_PROGRESS_CHANNEL,
				expect.any(Function)
			)
			expect(getFrappeEventListener(IMPORT_PROGRESS_CHANNEL)).toBeTypeOf('function')
		})

		it('shows the bar reset to zero the moment an import is dispatched', async () => {
			await startAnImportThatStaysInFlight()

			expect(screen.getByRole('progressbar')).toBeInTheDocument()
			expect(indicatorTransform()).toBe('translateX(-100%)')
			expect(screen.getByText('Importing... 0% complete')).toBeInTheDocument()
		})

		it('reports each pushed figure as a PERCENTAGE, not a transaction count', async () => {
			await startAnImportThatStaysInFlight()

			// `act` is the caller's responsibility: the captured handler sets React state.
			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 33 })
			})
			expect(screen.getByText('Importing... 33% complete')).toBeInTheDocument()
			expect(indicatorTransform()).toBe('translateX(-67%)')
			// The old copy claimed 33 transactions had been written, which the payload never said.
			expect(screen.queryByText('Importing 33 transactions')).not.toBeInTheDocument()

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 67 })
			})
			expect(screen.getByText('Importing... 67% complete')).toBeInTheDocument()
			expect(screen.queryByText('Importing... 33% complete')).not.toBeInTheDocument()
		})

		it('states a transaction count only from the terminal event, which is the only one carrying it', async () => {
			await startAnImportThatStaysInFlight()

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 50 })
			})
			expect(screen.getByText('Importing... 50% complete')).toBeInTheDocument()

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 100, total: 3 })
			})
			expect(screen.getByText('Imported 3 transactions.')).toBeInTheDocument()
			expect(indicatorTransform()).toBe('translateX(-0%)')
			expect(screen.queryByText(/% complete/)).not.toBeInTheDocument()
		})

		it('renders nothing before an import is dispatched', () => {
			renderStatementDetails(makeStatementDetails())

			expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
			expect(screen.queryByText(/% complete/)).not.toBeInTheDocument()
		})

		it('IGNORES a figure that arrives outside an attempt this screen started', () => {
			renderStatementDetails(makeStatementDetails())

			// A concurrent import of a DIFFERENT log, or a straggler from a settled attempt: the payload
			// carries no log identity, so an ungated listener would paint this screen with it.
			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 42 })
			})

			expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
			expect(screen.queryByText('Importing... 42% complete')).not.toBeInTheDocument()
		})

		it('clears the bar when the import is refused, because the rollback undid the progress', async () => {
			importCall.mockRejectedValue(makeServerMessagesError('This bank account is disabled'))

			renderStatementDetails(makeStatementDetails())
			await userEvent.click(screen.getByRole('button', { name: 'Import 3 transactions' }))

			await waitFor(() => {
				expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
			})
			expect(screen.queryByText(/% complete/)).not.toBeInTheDocument()
		})

		it('ignores a straggler that arrives after the attempt was refused', async () => {
			importCall.mockRejectedValue(makeServerMessagesError('This bank account is disabled'))

			renderStatementDetails(makeStatementDetails())
			await userEvent.click(screen.getByRole('button', { name: 'Import 3 transactions' }))
			await waitFor(() => {
				expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
			})

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 90 })
			})

			// A superseded attempt cannot repopulate a failed screen.
			expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
		})

		it('clamps a figure outside 0-100 rather than rendering an impossible bar', async () => {
			await startAnImportThatStaysInFlight()

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 120 })
			})

			expect(screen.getByText('Importing... 100% complete')).toBeInTheDocument()
			expect(indicatorTransform()).toBe('translateX(-0%)')

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: -5 })
			})

			expect(screen.getByText('Importing... 0% complete')).toBeInTheDocument()
			expect(indicatorTransform()).toBe('translateX(-100%)')
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
