import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { createElement, type PropsWithChildren } from 'react'
import Fuse from 'fuse.js'
import { toast } from 'sonner'
import {
	TEST_BANK,
	TEST_BANK_ACCOUNT,
	TEST_COMPANY,
	TEST_CURRENCY,
	TEST_REFERENCE_NUMBER,
	TEST_TRANSACTION_AMOUNT,
	TEST_TRANSACTION_DATE,
	TEST_TRANSACTION_DESCRIPTION,
	TEST_TRANSACTION_RULE,
	createFrappeSDKMock,
	formatAlreadyReconciledMessage,
	frappeHookMutate,
	frappePostCall,
	frappeSDKMock,
	frappeContextValue,
	frappeSWRMutate,
	makeAlreadyReconciledError,
	makeAlternateLinkedPayment,
	makeBankAccountListRow,
	makeBankTransaction,
	makeBankTransactionPayment,
	makeBlankReferenceLinkedPayment,
	makeLinkedPayment,
	makeNullReferenceLinkedPayment,
	makeReconcileSuccessResponse,
	makeReconciledTransaction,
	makeRuleMatchedTransaction,
	makeSalesInvoiceLinkedPayment,
	makeSelectedBank,
	makeServerMessagesError,
	makeSuggestedLinkedPayment,
	makeUnreconciledTransaction
} from '@/test/factories'

// The module under test imports the SDK's hooks at module scope, so the package is replaced
// wholesale before it loads. These particular tests exercise only the pure grading helpers, but
// the mock has to be in place for the import itself to succeed, and it keeps the suite unable to
// reach a real transport if a later test drives a hook.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import {
	bankRecBankTransactionsKey,
	bankRecClosingBalanceAsPerStatementKey,
	bankRecClosingBalanceKey,
	bankRecUnreconciledTransactionsKey,
	getSearchResults,
	isFrappeErrorEnvelope,
	toDisplayError,
	useGetAccountClosingBalance,
	useGetAccountClosingBalanceAsPerStatement,
	useGetAccountOpeningBalance,
	useGetBankAccounts,
	useGetBankTransactions,
	useGetRuleForTransaction,
	useGetUnreconciledTransactions,
	useGetVouchersForTransaction,
	useIsTransactionWithdrawal,
	useReconcileTransaction,
	useRefreshImportedTransactions,
	useRefreshUnreconciledTransactions,
	useTransactionSearch,
	useUpdateActionLog,
	type UnreconciledTransaction
} from './utils'
import {
	bankRecActionLog,
	bankRecAmountFilter,
	bankRecDateAtom,
	bankRecErrorDialogAtom,
	bankRecMatchFilters,
	bankRecReconcileSettlingAtom,
	bankRecSearchText,
	bankRecSelectedTransactionAtom,
	bankRecTransactionTypeFilter,
	bankRecUnreconcileModalAtom,
	classifyImportAttempt,
	classifyParsedStatement,
	getImportAttempt,
	getPreImportFailures,
	IMPORT_ATTEMPT_MARKER_LIMIT,
	PRE_IMPORT_FAILURE_LIMIT,
	preImportFailureScopeKey,
	selectedBankAccountAtom,
	withCompletedImportAttemptsRetired,
	withImportAttempt,
	withoutImportAttempt,
	withPreImportFailure,
	withoutPreImportFailure,
	type ActionLog,
	type ImportAttemptMarkers
} from './bankRecAtoms'
import { selectedCompanyAtom } from '@/hooks/useCurrentCompany'

/**
 * The four reference columns `get_linked_payments` really projects, pinned on the FIXTURES the
 * suites build their vouchers from.
 *
 *   • Payment Entry    - the real `pe.reference_no` (`bank_reconciliation_tool.py:1359`)
 *   • Journal Entry    - `Max(je.cheque_no)`, NULL when no row in the group carries a cheque
 *                        number (`:1415`)
 *   • Sales Invoice    - the real `sip.reference_no` off `Sales Invoice Payment`, which is
 *                        NULLABLE rather than constant (`:1474`)
 *   • Purchase Invoice - `ConstantColumn("")`, so ALWAYS the empty string (`:1512`)
 *
 * `reference_date` is the constant empty string for BOTH invoice branches and can be NULL on the
 * Journal Entry branch.
 *
 * A blank is therefore the NORMAL shape of a purchase invoice row and a POSSIBLE shape of a sales
 * invoice row, not an edge case in either - which is why `LinkedPayment` types both columns
 * `string | null`. There is no grading helper to test: the suggested-match scoring is frozen and
 * inline in `MatchAndReconcile`, and it is exercised against these same fixtures in that suite.
 * What is pinned here is the CONTRACT, so a fixture that drifts back to "invoices have no
 * reference" - or a type that narrows back to `string` - fails immediately.
 */
describe('the reference columns get_linked_payments projects', () => {

	it('projects a real reference for a Payment Entry', () => {
		const paymentEntry = makeLinkedPayment()

		expect(paymentEntry.reference_no).toBe(TEST_REFERENCE_NUMBER)
		expect(paymentEntry.reference_date).toBe(TEST_TRANSACTION_DATE)
	})

	it('projects a CONSTANT blank reference and date for a Purchase Invoice', () => {
		const purchaseInvoice = makeBlankReferenceLinkedPayment()

		expect(purchaseInvoice.doctype).toBe('Purchase Invoice')
		expect(purchaseInvoice.reference_no).toBe('')
		expect(purchaseInvoice.reference_date).toBe('')
	})

	/*
	 * The Sales Invoice branch is the one that is NOT symmetric with Purchase Invoice: only its
	 * reference DATE is blanked, while `sip.reference_no` is projected for real and may or may not
	 * carry a value.
	 */
	it('projects a NULLABLE reference for a Journal Entry, because it is a Max() over cheque numbers', () => {
		const journalEntry = makeNullReferenceLinkedPayment()

		expect(journalEntry.doctype).toBe('Journal Entry')
		expect(journalEntry.reference_no).toBeNull()
	})

	it('projects a real, nullable reference and a blank date for a Sales Invoice', () => {
		const salesInvoice = makeSalesInvoiceLinkedPayment()

		expect(salesInvoice.doctype).toBe('Sales Invoice')
		expect(salesInvoice.reference_no).toBe(TEST_REFERENCE_NUMBER)
		expect(salesInvoice.reference_date).toBe('')
	})

	it("models the Sales Invoice branch's other real shape, an unrecorded reference", () => {
		// `sip.reference_no` is nullable, and this is the shape a fixture copied from the Purchase
		// Invoice branch would have modelled as `''` instead.
		const salesInvoice = makeSalesInvoiceLinkedPayment({ reference_no: null })

		expect(salesInvoice.reference_no).toBeNull()
	})

	it('types both columns as nullable, so no consumer can assume a string', () => {
		// Compile-time contract, asserted at runtime so the intent is visible in the report: assigning
		// null to either column has to remain legal.
		const nullBoth = makeSalesInvoiceLinkedPayment({ reference_no: null, reference_date: null })

		expect(nullBoth.reference_no).toBeNull()
		expect(nullBoth.reference_date).toBeNull()
	})
})

/*
 * `reconcile_vouchers` is a single server-side operation and its response is the only authority on
 * what was recorded, so the client may neither assert an outcome it cannot observe nor keep acting on
 * a snapshot it has been told is unreliable.
 */

const createDeferred = <T,>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolveFn) => {
		resolve = resolveFn
	})
	return { promise, resolve }
}

const FROM_DATE = '2024-01-01'
const TO_DATE = '2024-01-31'

const UNRECONCILED_KEY = `bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`
const ALL_TRANSACTIONS_KEY = `bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`

const SELECTED_TRANSACTION_ATOM = bankRecSelectedTransactionAtom(TEST_BANK_ACCOUNT)

/**
 * The endpoint the post-rejection authoritative read calls - the SAME one both transaction-list
 * queries use, which is the point: the read exists to obtain the rows those lists may no longer be
 * telling the truth about.
 */
const GET_BANK_TRANSACTIONS_METHOD =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions'

/**
 * The third argument the invalidation carries. Stated once, because "evict" and "revalidate" are
 * different operations with different behaviour for an UNSUBSCRIBED key, and only the former
 * applies without a subscriber.
 */
const EVICT_CACHE_ENTRY_ARGS = { revalidate: true, populateCache: true }

/** Configures what the server answers the authoritative read with. */
const serverReportsTransactions = (rows: UnreconciledTransaction[]) => {
	frappeContextValue.call.get.mockResolvedValue({ message: rows })
}

/**
 * A store seeded with the state the reconcile seam reads: the selected account, the date range
 * that composes both cache keys, and the company the bank-account list is fetched for. Seeding
 * the dates explicitly is what makes the key assertions exact rather than dependent on the
 * calendar month the suite happens to run in.
 */
const createSeededStore = () => {
	const store = createStore()
	store.set(selectedBankAccountAtom, makeSelectedBank())
	store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })
	store.set(selectedCompanyAtom, TEST_COMPANY)
	return store
}

const withStore = (store: ReturnType<typeof createStore>) =>
	({ children }: PropsWithChildren) => createElement(Provider, { store }, children)

describe('useReconcileTransaction — rejection is resolved against the server, not guessed', () => {
	let consoleError: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		consoleError.mockRestore()
	})

	describe('a rejection carrying no response', () => {
		// `frappe-js-sdk` reads `error.response.data` with no guard, so when no response came back
		// its own TypeError becomes the rejection value. There is no server text to preserve, and -
		// critically - no server ANSWER either.
		const transportFailure = new TypeError("Cannot read properties of undefined (reading 'data')")

		const runRejectedReconcile = async () => {
			const store = createSeededStore()
			const transaction = makeUnreconciledTransaction()
			store.set(SELECTED_TRANSACTION_ATOM, [transaction])
			frappePostCall.mockImplementation(() => Promise.reject(transportFailure))

			const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
			await act(async () => {
				result.current.reconcileTransaction(transaction, makeLinkedPayment())
			})
			return store
		}

		it('never claims that nothing was posted', async () => {
			const store = await runRejectedReconcile()
			const message = store.get(bankRecErrorDialogAtom)?.message ?? ''

			// The whole point of the substitute copy. A lost response proves only that the client
			// never learned the answer; the request may have been delivered, committed and
			// acknowledged into a connection that had already gone away. Asserting otherwise is the
			// client inventing a server-side fact, and it is the dangerous direction to be wrong in
			// for a financial post - a reviewer told nothing happened will repeat the action.
			expect(message).not.toMatch(/nothing was posted/i)
			expect(message).not.toMatch(/was not (posted|recorded|saved)/i)
			expect(message).not.toMatch(/no(thing)? (was )?(recorded|saved)/i)
		})

		it('states the outcome as unknown and sends the reviewer to the server for it', async () => {
			const store = await runRejectedReconcile()
			const message = store.get(bankRecErrorDialogAtom)?.message ?? ''

			expect(message).toMatch(/no response arrived from the server/i)
			expect(message).toMatch(/not known whether this request was recorded/i)
			expect(message).toMatch(/check the current state of the affected records/i)
		})

		it('does not invite a blind retry', async () => {
			const store = await runRejectedReconcile()
			const message = store.get(bankRecErrorDialogAtom)?.message ?? ''

			// "try again" - with no instruction to verify first - is exactly the prompt that turns
			// one indeterminate post into two.
			expect(message).not.toMatch(/try again/i)
		})

		it('reports the transport failure as HTTP 0 rather than inventing a status', async () => {
			const store = await runRejectedReconcile()
			const error = store.get(bankRecErrorDialogAtom)

			expect(error?.httpStatus).toBe(0)
			expect(error?.httpStatusText).toBe('Network Error')
			expect(error?.exception).toBe('')
		})

		/*
		 * The rejection is NOT copied to the console. It is surfaced in full to the reviewer through
		 * the dismissible dialog and the toast, so a console copy would add nothing but a second,
		 * unredacted record of a financial transport failure - a raw Frappe rejection carries the
		 * whole response envelope. Asserted as an absence so the log cannot come back unnoticed, and
		 * paired with the dialog assertion so "not logged" can never mean "not reported".
		 */
		it('does not copy the raw rejection reason to the console', async () => {
			const store = await runRejectedReconcile()

			expect(consoleError).not.toHaveBeenCalledWith(transportFailure)
			expect(store.get(bankRecErrorDialogAtom)).not.toBeNull()
		})
	})

	it('hands a genuine server envelope to the dialog BY IDENTITY', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])

		const serverRejection = makeAlreadyReconciledError(transaction.name)
		frappePostCall.mockImplementation(() => Promise.reject(serverRejection))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// Not cloned, not reshaped, not re-titled: the server's own object, so its wording and its
		// severity reach the reviewer verbatim.
		expect(store.get(bankRecErrorDialogAtom)).toBe(serverRejection)
		expect(store.get(bankRecErrorDialogAtom)?._server_messages).toContain(
			formatAlreadyReconciledMessage(transaction.name)
		)
	})

	it('EVICTS both transaction-list keys, byte for byte, and introduces no new key', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(transaction.name)))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// Emptied, not merely asked to revalidate. A bare `mutate(key)` runs the key's registered
		// revalidator, and an UNMOUNTED key has none - so the populated entry would survive
		// untouched and, with `revalidateIfStale` disabled on the unreconciled query, still be
		// served after a remount. Writing `undefined` is a cache WRITE, which applies with or
		// without a subscriber, and `revalidate: true` refills it immediately where one exists.
		expect(frappeSWRMutate).toHaveBeenCalledWith(UNRECONCILED_KEY, undefined, EVICT_CACHE_ENTRY_ARGS)
		expect(frappeSWRMutate).toHaveBeenCalledWith(ALL_TRANSACTIONS_KEY, undefined, EVICT_CACHE_ENTRY_ARGS)
		const revalidatedKeys = frappeSWRMutate.mock.calls.map(([key]) => key)
		expect(revalidatedKeys).toEqual([UNRECONCILED_KEY, ALL_TRANSACTIONS_KEY])
	})

	it('asks the SERVER for the transaction\'s true state, with the same arguments the list uses', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(transaction.name)))
		serverReportsTransactions([makeReconciledTransaction({ name: transaction.name })])

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// `all_transactions` is the load-bearing argument: without it the endpoint filters on
		// `unallocated_amount > 0`, so a transaction the server now considers reconciled would come
		// back MISSING rather than present with its true status.
		expect(frappeContextValue.call.get).toHaveBeenCalledWith(GET_BANK_TRANSACTIONS_METHOD, {
			bank_account: TEST_BANK_ACCOUNT,
			from_date: FROM_DATE,
			to_date: TO_DATE,
			all_transactions: true
		})
	})

	it('keeps the action closed until the refresh has landed, then reopens it', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(transaction.name)))

		// The refresh is held open, so the window between "the post failed" and "the server has been
		// re-read" becomes observable instead of collapsing into one microtask.
		const refresh = createDeferred<undefined>()
		frappeSWRMutate.mockImplementation(() => refresh.promise)

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })

		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// The post has settled and the dialog is already up - but the client is still holding the
		// pre-attempt snapshot, so the action must stay closed. This is the exact window in which a
		// second post would be fired at state the reviewer has just been told is unreliable.
		expect(store.get(bankRecErrorDialogAtom)).not.toBeNull()
		expect(result.current.loading).toBe(false)
		expect(result.current.isSettling).toBe(true)
		expect(store.get(bankRecReconcileSettlingAtom)).toBe(true)

		await act(async () => {
			refresh.resolve(undefined)
			await refresh.promise
		})

		expect(result.current.isSettling).toBe(false)
		expect(store.get(bankRecReconcileSettlingAtom)).toBe(false)
	})

	it('replaces the selection with the server\u2019s refreshed row, status and all', async () => {
		const store = createSeededStore()
		const staleSnapshot = makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00003' })
		store.set(SELECTED_TRANSACTION_ATOM, [staleSnapshot])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(staleSnapshot.name)))

		// What the server actually holds: the same transaction, already fully reconciled. The
		// authoritative read carries `all_transactions`, so it comes back PRESENT with its true
		// status rather than being filtered out.
		const serverRow = makeReconciledTransaction()
		serverReportsTransactions([serverRow])

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(staleSnapshot, makeLinkedPayment())
		})

		// Taken whole, so `status` and `unallocated_amount` - the two fields the confirm guard reads -
		// can only be the server's values. The guard now disables the action instead of the row
		// silently disappearing with no explanation.
		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([serverRow])
		expect(store.get(SELECTED_TRANSACTION_ATOM)[0].status).toBe('Reconciled')
		expect(store.get(SELECTED_TRANSACTION_ATOM)[0].unallocated_amount).toBe(0)
	})

	it('drops a selected entry the server no longer reports at all', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(transaction.name)))

		// An empty ARRAY is a real answer - the account and range genuinely hold no such row - and is
		// treated as one.
		serverReportsTransactions([])

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
	})

	it('leaves the selection untouched when the server could not be reached for its answer', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(transaction.name)))

		// The authoritative read failed in turn, so nothing was established. Clearing the selection on
		// the strength of a second failure would be discarding the reviewer's work over an absence of
		// information - and inventing a row would be worse.
		frappeContextValue.call.get.mockRejectedValue(new Error('read failed'))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([transaction])
	})

	it('reopens the action even when the read AND the eviction both fail', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(transaction.name)))
		frappeContextValue.call.get.mockRejectedValue(new Error('read failed'))
		frappeSWRMutate.mockImplementation(() => Promise.reject(new Error('revalidation failed')))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// The read swallows its own failure and `allSettled` absorbs the eviction's, so neither can
		// escape as an unhandled rejection or wedge the affordance closed forever - and the selection
		// is left as it was, because nothing authoritative came back.
		expect(result.current.isSettling).toBe(false)
		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([transaction])
	})
})

/*
 * Asserted against LITERAL strings, because these keys are a cross-module contract: four surfaces
 * outside this module spell them inline, and several of these queries disable `revalidateIfStale` and
 * `revalidateOnFocus`, so a key wrong by one character invalidates nothing and reports no error.
 */
describe('cache-key builders produce the exact existing key strings', () => {

	it('builds the unreconciled-transactions key', () => {
		expect(bankRecUnreconciledTransactionsKey('Test Bank - Test Company', '2024-01-01', '2024-01-31'))
			.toBe('bank-reconciliation-unreconciled-transactions-Test Bank - Test Company-2024-01-01-2024-01-31')
	})

	it('builds the all-transactions key', () => {
		expect(bankRecBankTransactionsKey('Test Bank - Test Company', '2024-01-01', '2024-01-31'))
			.toBe('bank-reconciliation-bank-transactions-Test Bank - Test Company-2024-01-01-2024-01-31')
	})

	it('builds the closing-balance key', () => {
		expect(bankRecClosingBalanceKey('Test Bank - Test Company', '2024-01-31'))
			.toBe('bank-reconciliation-account-closing-balance-Test Bank - Test Company-2024-01-31')
	})

	it('builds the closing-balance-as-per-statement key', () => {
		expect(bankRecClosingBalanceAsPerStatementKey('Test Bank - Test Company', '2024-01-31'))
			.toBe('bank-reconciliation-account-closing-balance-as-per-statement-Test Bank - Test Company-2024-01-31')
	})

	// The closing-balance and as-per-statement families share a prefix, which is exactly the kind
	// of near-collision a careless edit could turn into an actual collision.
	it('keeps the two balance families distinct', () => {
		const balance = bankRecClosingBalanceKey(TEST_BANK_ACCOUNT, TO_DATE)
		const statement = bankRecClosingBalanceAsPerStatementKey(TEST_BANK_ACCOUNT, TO_DATE)
		expect(balance).not.toBe(statement)
		expect(statement.startsWith('bank-reconciliation-account-closing-balance-as-per-statement-')).toBe(true)
	})

	it('agrees with the literal keys the reconcile path revalidates', () => {
		expect(bankRecUnreconciledTransactionsKey(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)).toBe(UNRECONCILED_KEY)
		expect(bankRecBankTransactionsKey(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)).toBe(ALL_TRANSACTIONS_KEY)
	})
})

/*
 * `Not Started` is the INITIAL status and `insert_transactions` advances it to `Completed` only as its
 * final act, so it is nonterminal for the whole duration of a synchronous import. Observing it after
 * a lost response distinguishes nothing, and calling it "failed" would invent a server-side fact that
 * sends the reviewer to re-import.
 */
describe('classifyImportAttempt', () => {

	it('treats a confirmed Completed as completed, even when the server also refused', () => {
		expect(classifyImportAttempt({ serverRejected: true, confirmedStatus: 'Completed' })).toBe('completed')
	})

	it('treats a confirmed Completed as completed after a lost response', () => {
		expect(classifyImportAttempt({ serverRejected: false, confirmedStatus: 'Completed' })).toBe('completed')
	})

	it('marks failed only when the server refused AND the log is confirmed not completed', () => {
		expect(classifyImportAttempt({ serverRejected: true, confirmedStatus: 'Not Started' })).toBe('failed')
	})

	// A nonterminal status observed after a lost response is not evidence of failure.
	it('does NOT mark failed when a lost response leaves the log at Not Started', () => {
		expect(classifyImportAttempt({ serverRejected: false, confirmedStatus: 'Not Started' })).toBe('unknown')
	})

	it('marks unknown when no status could be obtained at all', () => {
		expect(classifyImportAttempt({ serverRejected: false, confirmedStatus: undefined })).toBe('unknown')
	})

	// A server refusal whose follow-up read also failed: the refusal is real, but nothing confirms
	// the log's state, so the honest answer is still unknown.
	it('marks unknown when the server refused but the log could not be read', () => {
		expect(classifyImportAttempt({ serverRejected: true, confirmedStatus: undefined })).toBe('unknown')
	})

	it('never returns a status that asserts failure from an ambiguous observation', () => {
		const ambiguous = [
			{ serverRejected: false, confirmedStatus: undefined },
			{ serverRejected: false, confirmedStatus: 'Not Started' as const },
			{ serverRejected: true, confirmedStatus: undefined }
		]
		ambiguous.forEach((observation) => {
			expect(classifyImportAttempt(observation)).not.toBe('failed')
		})
	})
})

/*
 * Markers are bank-scoped because visibility and retention are both per-account: the importer list
 * queries one bank with its own row limit, so a flat map would count other accounts' markers against
 * that budget and could evict a marker whose row is on screen.
 */
describe('import-attempt marker storage is scoped per bank account', () => {

	const OTHER_BANK = 'Other Bank - Test Company'

	it('records a marker under its own bank', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(getImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1')).toBe('failed')
	})

	it('does not leak a marker into a different bank', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(getImportAttempt(markers, OTHER_BANK, 'LOG-1')).toBeUndefined()
	})

	it('returns undefined when no bank is selected', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(getImportAttempt(markers, undefined, 'LOG-1')).toBeUndefined()
	})

	it('keeps two banks\' markers independent', () => {
		let markers: ImportAttemptMarkers = {}
		markers = withImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		markers = withImportAttempt(markers, OTHER_BANK, 'LOG-2', 'unknown')
		expect(getImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1')).toBe('failed')
		expect(getImportAttempt(markers, OTHER_BANK, 'LOG-2')).toBe('unknown')
	})

	// Filling one bank to the cap must not disturb another bank's marker.
	it('caps per bank, so a busy account cannot evict another account\'s visible marker', () => {
		let markers: ImportAttemptMarkers = withImportAttempt({}, OTHER_BANK, 'KEEP-ME', 'failed')

		for (let index = 0; index < IMPORT_ATTEMPT_MARKER_LIMIT + 5; index++) {
			markers = withImportAttempt(markers, TEST_BANK_ACCOUNT, `LOG-${index}`, 'failed')
		}

		expect(getImportAttempt(markers, OTHER_BANK, 'KEEP-ME')).toBe('failed')
		expect(Object.keys(markers[TEST_BANK_ACCOUNT])).toHaveLength(IMPORT_ATTEMPT_MARKER_LIMIT)
	})

	it('evicts oldest-first within a bank and retains the newest', () => {
		let markers: ImportAttemptMarkers = {}
		for (let index = 0; index < IMPORT_ATTEMPT_MARKER_LIMIT + 1; index++) {
			markers = withImportAttempt(markers, TEST_BANK_ACCOUNT, `LOG-${index}`, 'failed')
		}
		expect(getImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-0')).toBeUndefined()
		expect(getImportAttempt(markers, TEST_BANK_ACCOUNT, `LOG-${IMPORT_ATTEMPT_MARKER_LIMIT}`)).toBe('failed')
	})

	it('returns the same object when re-recording an identical marker', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(withImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')).toBe(markers)
	})

	it('retires one marker and drops the bank entry once it is empty', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		const cleared = withoutImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1')
		expect(getImportAttempt(cleared, TEST_BANK_ACCOUNT, 'LOG-1')).toBeUndefined()
		expect(TEST_BANK_ACCOUNT in cleared).toBe(false)
	})

	it('is a no-op when retiring a marker that was never recorded', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(withoutImportAttempt(markers, TEST_BANK_ACCOUNT, 'ABSENT')).toBe(markers)
		expect(withoutImportAttempt(markers, OTHER_BANK, 'LOG-1')).toBe(markers)
	})

	// Server truth retires markers, and only for the bank whose logs were actually re-read.
	it('retires markers the server reports Completed, within that bank only', () => {
		let markers: ImportAttemptMarkers = {}
		markers = withImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1', 'unknown')
		markers = withImportAttempt(markers, OTHER_BANK, 'LOG-1', 'failed')

		const retired = withCompletedImportAttemptsRetired(markers, TEST_BANK_ACCOUNT, ['LOG-1'])

		expect(getImportAttempt(retired, TEST_BANK_ACCOUNT, 'LOG-1')).toBeUndefined()
		expect(getImportAttempt(retired, OTHER_BANK, 'LOG-1')).toBe('failed')
	})

	it('is a no-op when no retained marker is among the completed logs', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(withCompletedImportAttemptsRetired(markers, TEST_BANK_ACCOUNT, ['LOG-9'])).toBe(markers)
		expect(withCompletedImportAttemptsRetired(markers, OTHER_BANK, ['LOG-1'])).toBe(markers)
	})

	/*
	 * FM2's zero-row marker is retired when the same file later parses to rows - but an `invalid`
	 * marker and an attempt marker describe different things, so retiring one must not erase the
	 * other. That is what the narrowed form is for.
	 */
	it('retires a marker of one status only, leaving another status in place', () => {
		const invalidMarked = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'invalid')
		expect(getImportAttempt(withoutImportAttempt(invalidMarked, TEST_BANK_ACCOUNT, 'LOG-1', 'invalid'), TEST_BANK_ACCOUNT, 'LOG-1'))
			.toBeUndefined()

		const failureMarked = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(withoutImportAttempt(failureMarked, TEST_BANK_ACCOUNT, 'LOG-1', 'invalid')).toBe(failureMarked)
	})
})

/*
 * The FM2 zero-row classification. It reads the SERVER's own parse result - the log's status and the
 * number of transactions the server built from the mapping it detected - and adds nothing to it: an
 * empty file and a file whose columns were not recognised both arrive as zero, and the client's whole
 * contribution is to record that the list can display it.
 */
describe('classifyParsedStatement', () => {

	it('calls a file the server recognised no transactions in invalid', () => {
		expect(classifyParsedStatement({ status: 'Not Started', finalTransactionCount: 0 })).toBe('invalid')
	})

	it('calls a file with transactions nothing at all', () => {
		expect(classifyParsedStatement({ status: 'Not Started', finalTransactionCount: 3 })).toBeUndefined()
	})

	it('never marks a completed import, whatever its file now parses to', () => {
		// The import took effect, so the document is the record and there is no problem to report.
		expect(classifyParsedStatement({ status: 'Completed', finalTransactionCount: 0 })).toBeUndefined()
		expect(classifyParsedStatement({ status: 'Completed', finalTransactionCount: 3 })).toBeUndefined()
	})

	it('classifies on the count alone when no status came back', () => {
		expect(classifyParsedStatement({ finalTransactionCount: 0 })).toBe('invalid')
		expect(classifyParsedStatement({ finalTransactionCount: 1 })).toBeUndefined()
	})
})

/*
 * Pre-log failures - a chain that failed before any import log existed - are nested by COMPANY AND
 * BANK ACCOUNT and then by file name, because the same statement file name recurs across accounts and
 * months. Keyed by name alone, one account's failure followed the reviewer into another, a same-named
 * retry elsewhere erased it, and the suppression of the inline hook banners was global.
 */
describe('pre-log failure scoping', () => {

	const SCOPE = preImportFailureScopeKey(TEST_COMPANY, TEST_BANK_ACCOUNT)
	const OTHER_SCOPE = preImportFailureScopeKey(TEST_COMPANY, 'Second Bank - Test Company')
	const FILE_NAME = 'statement-jan.csv'
	const refusal = makeServerMessagesError('Invalid file type.')

	it('composes a key only when both the company and the account are known', () => {
		expect(SCOPE).toBe(`${TEST_COMPANY}::${TEST_BANK_ACCOUNT}`)
		expect(preImportFailureScopeKey(undefined, TEST_BANK_ACCOUNT)).toBeUndefined()
		expect(preImportFailureScopeKey(TEST_COMPANY, undefined)).toBeUndefined()
	})

	it('keeps two accounts\u2019 observations of the same file name apart', () => {
		let failures = withPreImportFailure({}, SCOPE, FILE_NAME, refusal)
		const otherRefusal = makeServerMessagesError('A statement for this period has already been imported.')
		failures = withPreImportFailure(failures, OTHER_SCOPE, FILE_NAME, otherRefusal)

		expect(getPreImportFailures(failures, SCOPE)).toEqual({ [FILE_NAME]: refusal })
		expect(getPreImportFailures(failures, OTHER_SCOPE)).toEqual({ [FILE_NAME]: otherRefusal })
	})

	it('retires within one scope only', () => {
		let failures = withPreImportFailure({}, SCOPE, FILE_NAME, refusal)
		failures = withPreImportFailure(failures, OTHER_SCOPE, FILE_NAME, refusal)

		const retired = withoutPreImportFailure(failures, SCOPE, FILE_NAME)

		expect(getPreImportFailures(retired, SCOPE)).toEqual({})
		expect(getPreImportFailures(retired, OTHER_SCOPE)).toEqual({ [FILE_NAME]: refusal })
	})

	it('drops a scope entirely once its last observation is retired', () => {
		const failures = withPreImportFailure({}, SCOPE, FILE_NAME, refusal)

		expect(Object.keys(withoutPreImportFailure(failures, SCOPE, FILE_NAME))).toEqual([])
	})

	it('answers an unknown or absent scope with an empty map', () => {
		expect(getPreImportFailures({}, SCOPE)).toEqual({})
		expect(getPreImportFailures({}, undefined)).toEqual({})
	})

	it('records nothing when there is no scope to record against', () => {
		// The Upload control is disabled until both selections are made, so this is unreachable from
		// the form - and a failure filed under no scope would be visible from every account.
		const failures = { [SCOPE as string]: { [FILE_NAME]: refusal } }

		expect(withPreImportFailure(failures, undefined, FILE_NAME, refusal)).toBe(failures)
		expect(withoutPreImportFailure(failures, undefined, FILE_NAME)).toBe(failures)
	})

	it('is a no-op when retiring an observation that was never recorded', () => {
		const failures = withPreImportFailure({}, SCOPE, FILE_NAME, refusal)

		expect(withoutPreImportFailure(failures, SCOPE, 'never-uploaded.csv')).toBe(failures)
		expect(withoutPreImportFailure(failures, OTHER_SCOPE, FILE_NAME)).toBe(failures)
	})

	it('bounds each scope, evicting that scope\u2019s oldest observation', () => {
		let failures: ReturnType<typeof withPreImportFailure> = {}

		for (let index = 0; index < PRE_IMPORT_FAILURE_LIMIT + 3; index++) {
			failures = withPreImportFailure(failures, SCOPE, `statement-${index}.csv`, refusal)
		}

		const retained = Object.keys(getPreImportFailures(failures, SCOPE))

		expect(retained).toHaveLength(PRE_IMPORT_FAILURE_LIMIT)
		// The newest is kept and the oldest is gone: a long session cannot grow this without limit.
		expect(retained).toContain(`statement-${PRE_IMPORT_FAILURE_LIMIT + 2}.csv`)
		expect(retained).not.toContain('statement-0.csv')
	})

	it('replaces an existing observation of the same file rather than accumulating one', () => {
		const superseded = makeServerMessagesError('The uploaded file could not be parsed.')
		let failures = withPreImportFailure({}, SCOPE, FILE_NAME, superseded)
		failures = withPreImportFailure(failures, SCOPE, FILE_NAME, refusal)

		expect(getPreImportFailures(failures, SCOPE)).toEqual({ [FILE_NAME]: refusal })
	})
})

/*
 * `useGetUnreconciledTransactions` runs with `revalidateIfStale` and `revalidateOnFocus` both
 * disabled, so remounting it - which navigating to the reconciliation page does - never refetches. A
 * populated entry for the imported range would be rendered in place of the new rows, so the exact
 * keys are mutated and awaited before navigation.
 */
describe('useRefreshImportedTransactions', () => {

	beforeEach(() => {
		frappeSWRMutate.mockClear()
		frappeSWRMutate.mockResolvedValue(undefined)
	})

	it('invalidates the four keys the imported range affects, byte-for-byte', async () => {
		const { result } = renderHook(() => useRefreshImportedTransactions())

		await act(async () => {
			await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([
			`bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`,
			`bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`,
			`bank-reconciliation-account-closing-balance-${TEST_BANK_ACCOUNT}-${TO_DATE}`,
			`bank-reconciliation-account-closing-balance-as-per-statement-${TEST_BANK_ACCOUNT}-${TO_DATE}`
		])
	})

	/*
	 * A bare `mutate(key)` is served by invoking the key's registered revalidator, and revalidators
	 * come from MOUNTED subscribers - so with the reconciliation page unmounted it silently fetches
	 * nothing and the populated entry survives, after which `revalidateIfStale: false` skips the mount
	 * fetch precisely because the entry still holds data. Passing `undefined` as the DATA argument is a
	 * cache WRITE, which applies with or without a subscriber, so every call carries three arguments.
	 */
	it('EMPTIES each entry rather than merely asking it to revalidate', async () => {
		const { result } = renderHook(() => useRefreshImportedTransactions())

		await act(async () => {
			await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(frappeSWRMutate).toHaveBeenCalledTimes(4)

		frappeSWRMutate.mock.calls.forEach((call) => {
			// Three arguments, not one: the length is what decides between a cache write and a
			// revalidate-only request inside SWR.
			expect(call).toHaveLength(3)
			const [, data, options] = call
			expect(data).toBeUndefined()
			// `revalidate` covers the case where a subscriber IS mounted, so the emptied entry is
			// refilled at once instead of waiting for a remount.
			expect(options).toEqual({ revalidate: true, populateCache: true })
		})
	})

	/**
	 * THE WAIT IS BOUNDED, and that bound is what stops a hung follow-up from stranding the caller.
	 *
	 * Neither `mutate` nor the SDK call under it accepts an `AbortSignal`, and the Axios instance
	 * sets no timeout, so a revalidation that never answers is a promise that never settles. This
	 * hook is awaited before the reviewer is navigated to the workbench, and the reconcile hook's
	 * equivalents are awaited while the confirm affordance is held closed - so an unbounded wait is a
	 * screen that never moves on. Every invalidation is still DISPATCHED unconditionally: the cache
	 * write always happens, only the waiting is capped.
	 */
	it('stops waiting on a revalidation that never answers, without rejecting', async () => {
		vi.useFakeTimers()
		try {
			// Never settles - the shape of a request with no timeout behind it.
			frappeSWRMutate.mockImplementation(() => new Promise<undefined>(() => undefined))

			const { result } = renderHook(() => useRefreshImportedTransactions())

			let settled = false
			const pending = result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE).then(() => {
				settled = true
			})

			// All four writes were issued regardless.
			expect(frappeSWRMutate).toHaveBeenCalledTimes(4)
			await vi.advanceTimersByTimeAsync(1_000)
			expect(settled).toBe(false)

			await vi.advanceTimersByTimeAsync(20_000)
			await pending

			// Resolved, not rejected: the caller is awaiting convergence, and a deadline that passes
			// simply means "stop waiting".
			expect(settled).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})

	/**
	 * A follow-up that rejects AFTER its deadline has passed still has a rejection to deliver, and
	 * nothing is left to await it - so it has to be absorbed at the point it is abandoned or it
	 * surfaces as an `unhandledrejection` on a screen that has already moved on.
	 */
	it('absorbs a rejection that arrives after the deadline has passed', async () => {
		vi.useFakeTimers()
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', onUnhandled)
		try {
			let rejectLate: (reason: unknown) => void = () => undefined
			frappeSWRMutate.mockImplementation(
				() => new Promise<undefined>((_resolve, reject) => { rejectLate = reject }))

			const { result } = renderHook(() => useRefreshImportedTransactions())
			const pending = result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)

			await vi.advanceTimersByTimeAsync(20_000)
			await expect(pending).resolves.toBeUndefined()

			rejectLate(new Error('revalidation answered far too late'))
			await vi.advanceTimersByTimeAsync(0)
			await Promise.resolve()

			expect(unhandled).toEqual([])
		} finally {
			process.off('unhandledRejection', onUnhandled)
			vi.useRealTimers()
		}
	})

	// Nothing but emptiness is written. A hook that supplied its own payload could put a
	// differently-parameterised response where a query's own answer belongs; the server stays the
	// only source of what is displayed.
	it('never writes data of its own into any entry', async () => {
		const { result } = renderHook(() => useRefreshImportedTransactions())

		await act(async () => {
			await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(frappeSWRMutate.mock.calls.every(([, data]) => data === undefined)).toBe(true)
	})

	// The dates are arguments, not atom reads, precisely so the range invalidated is the one the
	// import resolved rather than whatever the page was previously filtered to.
	it('builds the keys from the dates it is given, not from the date atom', async () => {
		const { result } = renderHook(() => useRefreshImportedTransactions())

		await act(async () => {
			await result.current(TEST_BANK_ACCOUNT, '2023-06-01', '2023-06-30')
		})

		const keys = frappeSWRMutate.mock.calls.map(([key]) => key)
		expect(keys[0]).toBe(`bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-2023-06-01-2023-06-30`)
		keys.forEach((key) => {
			expect(key).not.toContain(FROM_DATE)
			expect(key).not.toContain(TO_DATE)
		})
	})

	// A balance query failing must not stop the transaction lists refreshing - the page the caller
	// is continuing to takes its value from those lists.
	it('still refreshes the remaining keys when one revalidation rejects, and does not throw', async () => {
		frappeSWRMutate.mockRejectedValueOnce(new Error('balance unavailable'))

		const { result } = renderHook(() => useRefreshImportedTransactions())

		await act(async () => {
			await expect(result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)).resolves.toBeUndefined()
		})

		expect(frappeSWRMutate).toHaveBeenCalledTimes(4)
	})
})

/*
 * The error-normalisation boundary has to satisfy two properties that pull in opposite directions: a
 * genuine server envelope must survive UNTOUCHED, so the backend's own message, title and severity
 * are what the user reads; and anything that is not an envelope must never reach the user, because
 * for a lost response the SDK hands back its own `TypeError` about `error.response.data`, which says
 * nothing about whether the work was recorded.
 */
describe('error normalisation at the transport boundary', () => {

	const SDK_INTERNAL_TEXT = "Cannot read properties of undefined (reading 'data')"

	it('passes a genuine Frappe envelope through BY IDENTITY', () => {
		const envelope = makeServerMessagesError('The bank account is disabled. Please enable it')

		// toBe, not toEqual: a copy would be just as wrong as a rewrite, because it invites a
		// later "improvement" to the copied fields.
		expect(toDisplayError(envelope)).toBe(envelope)
	})

	it('converts a response-less SDK TypeError into indeterminate transport copy', () => {
		const sdkFailure = new TypeError(SDK_INTERNAL_TEXT)

		const displayed = toDisplayError(sdkFailure)

		expect(displayed.httpStatus).toBe(0)
		expect(displayed.httpStatusText).toBe('Network Error')
		expect(displayed.message).toContain('No response arrived from the server')
		expect(displayed.message).toContain('it is not known whether this request was recorded')
		expect(displayed.message).toContain('Check the current state of the affected records')
	})

	it('never leaks the SDK implementation text to the surface', () => {
		const rendered = JSON.stringify(toDisplayError(new TypeError(SDK_INTERNAL_TEXT)))

		expect(rendered).not.toContain(SDK_INTERNAL_TEXT)
		expect(rendered).not.toContain('Cannot read properties')
		expect(rendered).not.toContain('undefined')
		expect(rendered).not.toContain('TypeError')
		expect(rendered).not.toContain('.data')
	})

	it('never claims the action failed or was not recorded', () => {
		// The whole point of the copy: the outcome is UNKNOWN. Wording that asserts failure would
		// invite a blind retry of work that may already have been committed.
		const message = toDisplayError(new TypeError(SDK_INTERNAL_TEXT)).message.toLowerCase()

		expect(message).not.toContain('failed')
		expect(message).not.toContain('was not')
		expect(message).not.toContain('no changes')
	})

	it.each([
		['a plain Error', new Error('boom')],
		['a string', 'boom'],
		['undefined', undefined],
		['null', null],
		['an empty object', {}],
		['an object with only a message', { message: 'boom' }]
	])('treats %s as a lost response rather than an envelope', (_label, reason) => {
		expect(isFrappeErrorEnvelope(reason)).toBe(false)
		expect(toDisplayError(reason).httpStatus).toBe(0)
	})

	it('recognises an envelope carrying only the fallback error field', () => {
		// Frappe does not always populate _server_messages; the fallback path must still count as
		// a real server answer, or a genuine rejection would be relabelled as a transport loss.
		const envelope = { httpStatus: 417, httpStatusText: 'Expectation Failed', message: 'x', exception: '' }

		expect(isFrappeErrorEnvelope(envelope)).toBe(true)
		expect(toDisplayError(envelope)).toBe(envelope)
	})
})

/*
 * The transport contract: endpoints, parameters, cache keys and SWR options, asserted as LITERALS
 * rather than rebuilt from the module's own helpers - recomputing a value with the expression under
 * test proves only that the expression is deterministic. The cache keys are a cross-module contract,
 * and several of these queries switch `revalidateIfStale` and `revalidateOnFocus` off, so a key that
 * drifts by one character invalidates nothing while raising no error.
 */

const GET_BANK_TRANSACTIONS =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions'
const GET_LINKED_PAYMENTS =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_linked_payments'
const RECONCILE_VOUCHERS =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.reconcile_vouchers'
const GET_ACCOUNT_BALANCE =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_account_balance'

const GET_CLOSING_BALANCE_AS_PER_STATEMENT =
	'erpnext.accounts.doctype.bank_account.bank_account.get_closing_balance_as_per_statement'
const BANK_ACCOUNT_GET_LIST = 'erpnext.accounts.doctype.bank_account.bank_account.get_list'

const CLOSING_BALANCE_KEY = `bank-reconciliation-account-closing-balance-${TEST_BANK_ACCOUNT}-${TO_DATE}`
const CLOSING_BALANCE_AS_PER_STATEMENT_KEY =
	`bank-reconciliation-account-closing-balance-as-per-statement-${TEST_BANK_ACCOUNT}-${TO_DATE}`

/**
 * The voucher-list key. The trailing segment is the match filters JOINED WITH COMMAS, and it is
 * passed in already joined so the expectation states the literal suffix rather than re-running
 * the module's own `join(',')`.
 */
const vouchersKeyFor = (transactionName: string, joinedMatchFilters: string): string =>
	`bank-reconciliation-vouchers-${transactionName}-${FROM_DATE}-${TO_DATE}-${joinedMatchFilters}`

const DEFAULT_JOINED_MATCH_FILTERS = 'payment_entry,journal_entry'

/*
 * Every cache-key family this module is permitted to build; the set is fixed at five because other
 * modules spell the same keys inline and a sixth would silently orphan those writers. Ordered
 * longest-first, because the as-per-statement family is itself prefixed by the closing-balance
 * family and a shortest-match lookup would attribute it to the wrong one.
 */
const KEY_FAMILY_PREFIXES = [
	'bank-reconciliation-account-closing-balance-as-per-statement-',
	'bank-reconciliation-account-closing-balance-',
	'bank-reconciliation-unreconciled-transactions-',
	'bank-reconciliation-bank-transactions-',
	'bank-reconciliation-vouchers-'
]

const familyOf = (key: unknown): string | undefined =>
	typeof key === 'string' ? KEY_FAMILY_PREFIXES.find((prefix) => key.startsWith(prefix)) : undefined

interface AssertedSwrOptions {
	revalidateOnFocus?: boolean
	revalidateIfStale?: boolean
	onSuccess?: (data?: { message?: unknown[] }) => void
}

const swrOptionsOf = (options: unknown): AssertedSwrOptions => (options ?? {}) as AssertedSwrOptions

/*
 * The LAST matching `useFrappeGetCall` invocation rather than the first, because a hook may
 * legitimately render more than once and the final render is the state it settles in. Two hooks share
 * `get_bank_transactions` and two share `get_account_balance`, so each is rendered in isolation below
 * and the endpoint alone identifies the call.
 */
const lastGetCallFor = (method: string) => {
	const calls = frappeSDKMock.useFrappeGetCall.mock.calls.filter(([calledMethod]) => calledMethod === method)
	expect(calls.length).toBeGreaterThan(0)
	return calls[calls.length - 1]
}

const lastGetDocCall = () => {
	const calls = frappeSDKMock.useFrappeGetDoc.mock.calls
	expect(calls.length).toBeGreaterThan(0)
	return calls[calls.length - 1]
}

/**
 * Answers ONE endpoint with a payload and every other with the harness's "no data yet" response.
 *
 * Branching on the method rather than blanket-returning matters because a single render reaches
 * `useFrappeGetCall` several times with different endpoints, and a blanket answer would feed one
 * endpoint's payload to all of them.
 */
const answerGetCall = (method: string, data: unknown): void => {
	frappeSDKMock.useFrappeGetCall.mockImplementation((calledMethod) =>
		calledMethod === method
			? { data, error: undefined, isLoading: false, isValidating: false, mutate: frappeHookMutate }
			: { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: frappeHookMutate })
}

const createStoreWithoutBank = () => {
	const store = createStore()
	store.set(selectedBankAccountAtom, null)
	store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })
	store.set(selectedCompanyAtom, TEST_COMPANY)
	return store
}

describe('the balance queries', () => {

	/*
	 * `get_account_balance` is reached by two hooks with the SAME endpoint and DIFFERENT
	 * `till_date` values, which is the one thing about this pair worth pinning: the opening
	 * balance is the balance as at the day BEFORE the range starts, so a hook that passed
	 * `fromDate` would report the closing balance of the first day as the opening balance of the
	 * range and every subsequent figure would be off by one day's movement.
	 */
	it('asks for the opening balance as at the day BEFORE the range starts', () => {
		const store = createSeededStore()

		renderHook(() => useGetAccountOpeningBalance(), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(GET_ACCOUNT_BALANCE)

		expect(method).toBe(GET_ACCOUNT_BALANCE)
		expect(params).toEqual({
			bank_account: TEST_BANK_ACCOUNT,
			company: TEST_COMPANY,
			// FROM_DATE is 2024-01-01, so the day before is the last day of the previous year -
			// asserted as a literal precisely because that rollover is where an off-by-one hides.
			till_date: '2023-12-31'
		})
		// No explicit key: this query is content-addressed by SWR from its method and params, and
		// nothing mutates it by name.
		expect(swrKey).toBeUndefined()
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
	})

	it('asks for the closing balance as at the end of the range, under the closing-balance key', () => {
		const store = createSeededStore()

		renderHook(() => useGetAccountClosingBalance(), { wrapper: withStore(store) })

		const [method, params, swrKey] = lastGetCallFor(GET_ACCOUNT_BALANCE)

		expect(method).toBe(GET_ACCOUNT_BALANCE)
		expect(params).toEqual({
			bank_account: TEST_BANK_ACCOUNT,
			company: TEST_COMPANY,
			till_date: TO_DATE
		})
		expect(swrKey).toBe(CLOSING_BALANCE_KEY)
	})

	it('reads the statement closing balance from the bank account, under its own distinct key', () => {
		const store = createSeededStore()

		renderHook(() => useGetAccountClosingBalanceAsPerStatement(), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(GET_CLOSING_BALANCE_AS_PER_STATEMENT)

		expect(method).toBe(GET_CLOSING_BALANCE_AS_PER_STATEMENT)
		expect(params).toEqual({ bank_account: TEST_BANK_ACCOUNT, date: TO_DATE })
		expect(swrKey).toBe(CLOSING_BALANCE_AS_PER_STATEMENT_KEY)
		// Distinct from the ledger closing balance, even though both are "the closing balance":
		// one is what the ledger says, the other what the statement says, and the whole point of
		// the reconciliation is that they may disagree.
		expect(swrKey).not.toBe(CLOSING_BALANCE_KEY)
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
	})

	// The caller's config is spread AFTER the hook's own default, so a caller can opt back into
	// focus revalidation. That ordering is the contract; the reverse would silently ignore it.
	it('lets a caller override the default SWR configuration', () => {
		const store = createSeededStore()

		renderHook(() => useGetAccountClosingBalanceAsPerStatement({ revalidateOnFocus: true }), {
			wrapper: withStore(store)
		})

		expect(swrOptionsOf(lastGetCallFor(GET_CLOSING_BALANCE_AS_PER_STATEMENT)[3]).revalidateOnFocus).toBe(true)
	})
})

describe('the transaction-list queries', () => {

	it('lists unreconciled transactions for the selected account and range', () => {
		const store = createSeededStore()

		renderHook(() => useGetUnreconciledTransactions(), { wrapper: withStore(store) })

		const [method, params, swrKey] = lastGetCallFor(GET_BANK_TRANSACTIONS)

		expect(method).toBe(GET_BANK_TRANSACTIONS)
		expect(params).toEqual({
			bank_account: TEST_BANK_ACCOUNT,
			from_date: FROM_DATE,
			to_date: TO_DATE
		})
		expect(params).not.toHaveProperty('all_transactions')
		expect(swrKey).toBe(UNRECONCILED_KEY)
	})

	/*
	 * BOTH flags off is what makes every writer's explicit invalidation load-bearing: the entry
	 * does not refresh on focus and does not refresh on mount when already populated, so
	 * anything that changes bank transactions server-side - reconciling, importing a statement -
	 * has to mutate this key by name or the reviewer keeps looking at the previous answer.
	 */
	it('refreshes only when its key is mutated, never on focus and never merely because it is stale', () => {
		const store = createSeededStore()

		renderHook(() => useGetUnreconciledTransactions(), { wrapper: withStore(store) })

		const options = swrOptionsOf(lastGetCallFor(GET_BANK_TRANSACTIONS)[3])
		expect(options.revalidateOnFocus).toBe(false)
		expect(options.revalidateIfStale).toBe(false)
	})

	// A null key is SWR's "do not fetch" signal. Without it the query would run with
	// `bank_account: undefined` and cache the answer under a key containing the text "undefined".
	it('does not fetch unreconciled transactions at all when no bank account is selected', () => {
		const store = createStoreWithoutBank()

		renderHook(() => useGetUnreconciledTransactions(), { wrapper: withStore(store) })

		expect(lastGetCallFor(GET_BANK_TRANSACTIONS)[2]).toBeNull()
	})

	/*
	 * ⚠️ `all_transactions: true` is the single parameter that separates this query from the one
	 * above, and it is what makes the already-reconciled confirm guard genuinely user-visible
	 * rather than theoretical: it bypasses the server-side `unallocated_amount > 0` filter, so
	 * rows the server considers fully reconciled DO render in the "Bank Transactions" tab, with a
	 * confirm affordance that has to be disabled on the client.
	 */
	it('lists ALL transactions - reconciled ones included - for the Bank Transactions tab', () => {
		const store = createSeededStore()

		renderHook(() => useGetBankTransactions(), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(GET_BANK_TRANSACTIONS)

		expect(method).toBe(GET_BANK_TRANSACTIONS)
		expect(params).toEqual({
			bank_account: TEST_BANK_ACCOUNT,
			from_date: FROM_DATE,
			to_date: TO_DATE,
			all_transactions: true
		})
		expect(swrKey).toBe(ALL_TRANSACTIONS_KEY)
		// Deliberately no SWR configuration: this view keeps the library's defaults, unlike its
		// unreconciled sibling.
		expect(options).toBeUndefined()
	})

	it('does not fetch all transactions either when no bank account is selected', () => {
		const store = createStoreWithoutBank()

		renderHook(() => useGetBankTransactions(), { wrapper: withStore(store) })

		expect(lastGetCallFor(GET_BANK_TRANSACTIONS)[2]).toBeNull()
	})

	// The two lists must never collide in the cache: they are served by the same endpoint with
	// different filtering, so a shared key would have one answer overwriting the other.
	it('keeps the two transaction lists on separate cache keys', () => {
		expect(UNRECONCILED_KEY).not.toBe(ALL_TRANSACTIONS_KEY)
	})
})

describe('the candidate-voucher query', () => {

	it('asks for the linked payments of one transaction, keyed by transaction and filters', () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()

		renderHook(() => useGetVouchersForTransaction(transaction), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(GET_LINKED_PAYMENTS)

		expect(method).toBe(GET_LINKED_PAYMENTS)
		expect(params).toEqual({
			bank_transaction_name: transaction.name,
			document_types: ['payment_entry', 'journal_entry'],
			from_date: FROM_DATE,
			to_date: TO_DATE,
			filter_by_reference_date: 0
		})
		expect(swrKey).toBe(vouchersKeyFor(transaction.name, DEFAULT_JOINED_MATCH_FILTERS))
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
	})

	// Widening the filters must reach the server AND change the key, or the reviewer would be
	// shown the narrower cached list under a query they have just broadened.
	it('carries a widened filter set into both the request and the cache key', () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(bankRecMatchFilters, ['payment_entry', 'journal_entry', 'sales_invoice', 'purchase_invoice'])

		renderHook(() => useGetVouchersForTransaction(transaction), { wrapper: withStore(store) })

		const [, params, swrKey] = lastGetCallFor(GET_LINKED_PAYMENTS)

		expect(params).toMatchObject({
			document_types: ['payment_entry', 'journal_entry', 'sales_invoice', 'purchase_invoice']
		})
		expect(swrKey).toBe(
			vouchersKeyFor(transaction.name, 'payment_entry,journal_entry,sales_invoice,purchase_invoice')
		)
	})

	// Two transactions under review must not share a candidate list.
	it('keys the candidate list per transaction', () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction()
		const second = makeReconciledTransaction()

		renderHook(() => useGetVouchersForTransaction(first), { wrapper: withStore(store) })
		const firstKey = lastGetCallFor(GET_LINKED_PAYMENTS)[2]

		renderHook(() => useGetVouchersForTransaction(second), { wrapper: withStore(store) })
		const secondKey = lastGetCallFor(GET_LINKED_PAYMENTS)[2]

		expect(firstKey).toBe(vouchersKeyFor(first.name, DEFAULT_JOINED_MATCH_FILTERS))
		expect(secondKey).toBe(vouchersKeyFor(second.name, DEFAULT_JOINED_MATCH_FILTERS))
		expect(firstKey).not.toBe(secondKey)
	})
})


/*
 * Renders every keyed query in one pass, so the full set of cache keys is observable from a single
 * render. A named `use…` function because it genuinely is a custom hook - it calls seven hooks
 * unconditionally - which is what keeps the hook rules satisfied.
 */
const useEveryKeyedQuery = (transaction: UnreconciledTransaction): void => {
	useGetAccountClosingBalance()
	useGetAccountClosingBalanceAsPerStatement()
	useGetUnreconciledTransactions()
	useGetBankTransactions()
	useGetVouchersForTransaction(transaction)
	// Included so an unkeyed query cannot smuggle a key in unnoticed: both of these pass
	// `undefined` and are content-addressed by SWR from their method and parameters.
	useGetAccountOpeningBalance()
	useGetBankAccounts()
}

/*
 * The cache-key surface is CLOSED at five families. Each family is checked individually above, but
 * only a census can catch a SIXTH being introduced - and these keys are shared with modules that
 * spell them inline and cannot follow a rename.
 */
describe('the cache-key surface is closed at five families', () => {

	it('produces keys from all five families and from no other', () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()

		renderHook(() => useEveryKeyedQuery(transaction), { wrapper: withStore(store) })

		const declaredKeys = frappeSDKMock.useFrappeGetCall.mock.calls
			.map(([, , swrKey]) => swrKey)
			.filter((swrKey): swrKey is string => typeof swrKey === 'string')

		expect(declaredKeys.length).toBeGreaterThan(0)
		expect(declaredKeys.filter((key) => familyOf(key) === undefined)).toEqual([])
		expect(new Set(declaredKeys.map(familyOf)).size).toBe(KEY_FAMILY_PREFIXES.length)
		expect(KEY_FAMILY_PREFIXES).toHaveLength(5)
	})

	it('agrees with the exported builders on all four builder-backed families', () => {
		expect(familyOf(bankRecUnreconciledTransactionsKey(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)))
			.toBe('bank-reconciliation-unreconciled-transactions-')
		expect(familyOf(bankRecBankTransactionsKey(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)))
			.toBe('bank-reconciliation-bank-transactions-')
		expect(familyOf(bankRecClosingBalanceKey(TEST_BANK_ACCOUNT, TO_DATE)))
			.toBe('bank-reconciliation-account-closing-balance-')
		expect(familyOf(bankRecClosingBalanceAsPerStatementKey(TEST_BANK_ACCOUNT, TO_DATE)))
			.toBe('bank-reconciliation-account-closing-balance-as-per-statement-')
		expect(familyOf(vouchersKeyFor('ACC-BTN-2024-00001', DEFAULT_JOINED_MATCH_FILTERS)))
			.toBe('bank-reconciliation-vouchers-')
	})

	it('attributes a key from outside the five families to no family at all', () => {
		expect(familyOf('bank-reconciliation-something-new-Test Bank')).toBeUndefined()
		expect(familyOf(undefined)).toBeUndefined()
		expect(familyOf(null)).toBeUndefined()
	})
})

/*
 * `account_currency` is NOT a `Bank Account` field: the endpoint derives it per row by following
 * `Bank Account.account` to `Account.account_currency` after the query. That is why it is optional
 * here, and why the currency advisory treats its absence as "nothing to compare" rather than as a
 * mismatch.
 */
describe('useGetBankAccounts', () => {

	it('reads the company\'s accounts, unkeyed, and refreshes neither on focus nor when stale', () => {
		const store = createSeededStore()

		renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(BANK_ACCOUNT_GET_LIST)

		expect(method).toBe(BANK_ACCOUNT_GET_LIST)
		expect(params).toEqual({ company: TEST_COMPANY })
		// Unkeyed on purpose: SWR derives the key from method plus params, which is what lets
		// `useSelectedBankAccountCurrency` share this very entry instead of opening a second
		// request. That sharing is asserted in its own suite above.
		expect(swrKey).toBeUndefined()
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
		expect(swrOptionsOf(options).revalidateIfStale).toBe(false)
	})

	it('surfaces the derived account currency the endpoint attaches to each row', () => {
		const store = createSeededStore()
		answerGetCall(BANK_ACCOUNT_GET_LIST, { message: [makeBankAccountListRow()] })

		const { result } = renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

		expect(result.current.banks).toHaveLength(1)
		expect(result.current.banks[0].account_currency).toBe(TEST_CURRENCY)
		// The server's row is spread through rather than reconstructed field by field, so every
		// projected column reaches the picker - `account_subtype` included, which is projected by
		// this endpoint and is exactly the sort of column a hand-narrowed response would drop.
		expect(result.current.banks[0].name).toBe(TEST_BANK_ACCOUNT)
		expect(result.current.banks[0].bank).toBe(TEST_BANK)
		expect(result.current.banks[0].account_subtype).toBe('Current')
		expect(result.current.isLoading).toBe(false)
		expect(result.current.error).toBeUndefined()
	})

	// A row whose GL account has no currency must come back as `undefined`, not as a default:
	// inventing one here is what would let the advisory claim a mismatch that does not exist.
	it('leaves the currency undefined when the endpoint could not derive one', () => {
		const store = createSeededStore()
		answerGetCall(BANK_ACCOUNT_GET_LIST, { message: [makeBankAccountListRow({ account_currency: undefined })] })

		const { result } = renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

		expect(result.current.banks[0].account_currency).toBeUndefined()
	})

	it('reports an empty list rather than undefined before any answer has arrived', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

		expect(result.current.banks).toEqual([])
	})

	/*
	 * `onSuccess` is wired into the SWR configuration, so with the transport mocked it is invoked the
	 * way SWR would invoke it. The hook forwards `data?.message` - the ROWS - not the response
	 * envelope, which the bank picker would otherwise have to unwrap.
	 */
	it('forwards the fetched rows to its caller\'s onSuccess callback', () => {
		const store = createSeededStore()
		const rows = [makeBankAccountListRow()]
		const onSuccess = vi.fn<(data?: unknown[]) => void>()

		renderHook(() => useGetBankAccounts(onSuccess), { wrapper: withStore(store) })

		swrOptionsOf(lastGetCallFor(BANK_ACCOUNT_GET_LIST)[3]).onSuccess?.({ message: rows })

		expect(onSuccess).toHaveBeenCalledTimes(1)
		expect(onSuccess).toHaveBeenCalledWith(rows)
	})

	it('tolerates a success with no payload, and tolerates having no callback at all', () => {
		const store = createSeededStore()

		renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })
		const options = swrOptionsOf(lastGetCallFor(BANK_ACCOUNT_GET_LIST)[3])

		expect(() => options.onSuccess?.(undefined)).not.toThrow()
		expect(() => options.onSuccess?.({})).not.toThrow()
	})

	it('applies a caller\'s filter to the resolved rows', () => {
		const store = createSeededStore()
		answerGetCall(BANK_ACCOUNT_GET_LIST, {
			message: [
				makeBankAccountListRow({ name: 'Current - TC', is_credit_card: 0 }),
				makeBankAccountListRow({ name: 'Card - TC', is_credit_card: 1 })
			]
		})

		const { result } = renderHook(() => useGetBankAccounts(undefined, (bank) => bank.is_credit_card === 1), {
			wrapper: withStore(store)
		})

		expect(result.current.banks.map((bank) => bank.name)).toEqual(['Card - TC'])
	})
})

describe('bank logo resolution', () => {

	const logoFor = (bankName: string | undefined) => {
		const store = createSeededStore()
		answerGetCall(BANK_ACCOUNT_GET_LIST, { message: [makeBankAccountListRow({ bank: bankName })] })
		const { result } = renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })
		return result.current.banks[0]
	}

	it('matches a bank by its full name', () => {
		expect(logoFor('HDFC Bank').logo).toBe('HDFC.svg')
	})

	it('matches case-insensitively, since a bank name is free text', () => {
		expect(logoFor('hdfc bank').logo).toBe('HDFC.svg')
	})

	it('matches a keyword appearing inside a longer account label', () => {
		expect(logoFor('ICICI Bank - Corporate Salary Account').logo).toBe('ICICI.svg')
	})

	/*
	 * ⚠️ THE reason the longest keyword wins. "Banco de Finanzas" CONTAINS the three-letter
	 * keyword "anz", so a first-match or shortest-match lookup hands a Nicaraguan bank the
	 * Australia and New Zealand Banking Group logo. Preferring the longest match is what stops a
	 * short token inside an unrelated word beating a full bank name.
	 */
	it('prefers the longest keyword, so a short token inside another word cannot win', () => {
		const bank = logoFor('Banco de Finanzas')

		expect(bank.logo).toBe('Banco_de_Finanzas.svg')
		expect(bank.logo).not.toBe('ANZ.png')
		expect(bank.logoClassName).toBe('h-4.5')
	})

	it('carries the dark-mode variant and the invert flag when the entry declares them', () => {
		expect(logoFor('ICICI Bank').logoDark).toBe('ICICI-dark.svg')
		expect(logoFor('Macquarie Bank').darkModeInvert).toBe(true)
	})

	// No logo is a perfectly ordinary outcome - most banks in the world are not in the list - so
	// it must resolve to `undefined` rather than to a wrong logo or a thrown error.
	it('leaves every logo field undefined when nothing matches', () => {
		const bank = logoFor('Zephyr Municipal Cooperative')

		expect(bank.logo).toBeUndefined()
		expect(bank.logoDark).toBeUndefined()
		expect(bank.darkModeInvert).toBeUndefined()
		expect(bank.logoClassName).toBeUndefined()
	})

	// `bank` is optional on `Bank Account`, so an account with no bank must short-circuit rather
	// than run a substring search against nothing.
	it('resolves nothing when the account names no bank', () => {
		expect(logoFor(undefined).logo).toBeUndefined()
		expect(logoFor('').logo).toBeUndefined()
	})
})


/*
 * `reconcile_vouchers` is ONE server-side operation and its response is the sole authority on what
 * was recorded, so on the accepted path the client sends exactly the payload the endpoint declares,
 * records what came BACK, and invalidates the caches the server has just changed. Nothing is
 * computed locally.
 */

const undoActionOf = (options: unknown): { label?: unknown, onClick: () => void } | undefined =>
	(options as { action?: { label?: unknown, onClick: () => void } } | undefined)?.action

describe('useReconcileTransaction — the accepted post (TC4)', () => {

	let successToast: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		successToast = vi.spyOn(toast, 'success').mockReturnValue('toast-id')
		frappeSWRMutate.mockResolvedValue(undefined)
	})

	afterEach(() => {
		successToast.mockRestore()
	})

	/*
	 * The server's answer is a FULL `Bank Transaction` document - the reconcile hook's declared
	 * response type - so `unallocated_amount: 0` and `status: 'Reconciled'` are the SERVER reporting a
	 * completed reconciliation, not the client deciding one happened.
	 */
	const confirmMatch = async (serverAnswer = makeReconcileSuccessResponse()) => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		const voucher = makeSuggestedLinkedPayment(transaction)
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockResolvedValue(serverAnswer)

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, voucher)
		})

		return { store, transaction, voucher, serverAnswer }
	}

	it('posts to reconcile_vouchers, and to nothing else', async () => {
		await confirmMatch()

		expect(frappeSDKMock.useFrappePostCall).toHaveBeenCalledWith(RECONCILE_VOUCHERS)
		expect(frappePostCall).toHaveBeenCalledTimes(1)
	})

	/*
	 * ⚠️ The payload shape is the backend's contract, not the client's preference. `vouchers` is a
	 * JSON STRING rather than an array - the endpoint parses it server-side - and the inner keys
	 * are `payment_doctype`, `payment_name` and `amount`, with `amount` taken from the voucher's
	 * `paid_amount`. Every one of those is a name the server reads by; renaming any of them here
	 * would post an allocation the server silently ignores.
	 */
	it('sends exactly the payload the endpoint declares, with vouchers as a JSON string', async () => {
		const { transaction, voucher } = await confirmMatch()

		const [payload] = frappePostCall.mock.calls[0]

		expect(payload).toEqual({
			bank_transaction_name: transaction.name,
			vouchers: JSON.stringify([{
				payment_doctype: voucher.doctype,
				payment_name: voucher.name,
				amount: voucher.paid_amount
			}])
		})
		expect(typeof payload.vouchers).toBe('string')
	})

	it('allocates one voucher, by doctype, name and paid amount', async () => {
		const { voucher } = await confirmMatch()

		const [payload] = frappePostCall.mock.calls[0]
		const vouchers = JSON.parse(String(payload.vouchers)) as unknown[]

		expect(vouchers).toHaveLength(1)
		expect(vouchers[0]).toEqual({
			payment_doctype: 'Payment Entry',
			payment_name: voucher.name,
			amount: voucher.paid_amount
		})
	})

	it('posts the voucher the reviewer actually chose, not the suggested one', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		const suggested = makeSuggestedLinkedPayment(transaction)
		const chosen = makeAlternateLinkedPayment()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, chosen)
		})

		const vouchers = JSON.parse(String(frappePostCall.mock.calls[0][0].vouchers)) as unknown[]

		expect(vouchers[0]).toEqual({
			payment_doctype: 'Journal Entry',
			payment_name: chosen.name,
			amount: chosen.paid_amount
		})
		expect(chosen.name).not.toBe(suggested.name)
		expect(chosen.doctype).not.toBe(suggested.doctype)
	})

	/*
	 * The status update TC4 asks for is observable exactly here: the response document is what the
	 * refresh path is handed, and the audit entry records THAT document rather than the row the
	 * client was holding. So the log cannot claim a status the server did not report.
	 */
	it('records the SERVER\'S returned document in the action log, with the voucher it matched', async () => {
		const { store, voucher, serverAnswer } = await confirmMatch()

		const log = store.get(bankRecActionLog)

		expect(log).toHaveLength(1)
		expect(log[0].type).toBe('match')
		expect(log[0].isBulk).toBe(false)
		expect(log[0].timestamp).toBeGreaterThan(0)
		expect(log[0].items).toHaveLength(1)
		expect(log[0].items[0].bankTransaction).toBe(serverAnswer.message)
		expect(log[0].items[0].bankTransaction.status).toBe('Reconciled')
		expect(log[0].items[0].bankTransaction.unallocated_amount).toBe(0)
		expect(log[0].items[0].voucher).toEqual({
			reference_doctype: voucher.doctype,
			reference_name: voucher.name,
			reference_no: voucher.reference_no,
			reference_date: voucher.reference_date,
			posting_date: voucher.posting_date
		})
	})

	// A fully allocated transaction leaves the unreconciled list, so both the list and the ledger
	// closing balance it feeds have to be re-read from the server.
	it('revalidates the unreconciled list and the closing balance once the post is accepted', async () => {
		await confirmMatch()

		const revalidatedKeys = frappeSWRMutate.mock.calls.map(([key]) => key)

		expect(revalidatedKeys).toContain(UNRECONCILED_KEY)
		expect(revalidatedKeys).toContain(CLOSING_BALANCE_KEY)
		expect(revalidatedKeys.filter((key) => familyOf(key) === undefined)).toEqual([])
	})

	/*
	 * A PARTIAL allocation is a different outcome and takes a different branch: the transaction
	 * stays on the unreconciled list with a smaller unallocated amount, so its candidate-voucher
	 * list is now wrong too and has to be invalidated alongside the list and the balance.
	 */
	it('also revalidates the transaction\'s candidate vouchers when the allocation was partial', async () => {
		// One figure states the branch; the builder derives the allocated amount, the status and the
		// child allocation row from it, so the document cannot claim an allocation the server would
		// not have written.
		const { transaction } = await confirmMatch(
			makeReconcileSuccessResponse({ unallocated_amount: 2500 })
		)

		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([
			UNRECONCILED_KEY,
			CLOSING_BALANCE_KEY,
			vouchersKeyFor(transaction.name, DEFAULT_JOINED_MATCH_FILTERS)
		])
	})

	it('confirms the reconciliation to the reviewer and offers to undo it', async () => {
		const { store, transaction } = await confirmMatch()

		expect(successToast).toHaveBeenCalledTimes(1)
		expect(successToast.mock.calls[0][0]).toBe('Reconciled')

		const undo = undoActionOf(successToast.mock.calls[0][1])
		expect(undo?.label).toBe('Undo')

		// Undo does not itself reverse anything: it opens the unreconcile modal for this
		// transaction, which is where the reversal is confirmed and posted.
		expect(store.get(bankRecUnreconcileModalAtom)).toBe('')
		act(() => {
			undo?.onClick()
		})
		expect(store.get(bankRecUnreconcileModalAtom)).toBe(transaction.name)
	})

	// The confirm affordance is gated on `isSettling`, which must be back down once the accepted
	// path has finished - otherwise the row stays closed after a perfectly successful post.
	it('reopens the action once the accepted post has settled', async () => {
		const { store } = await confirmMatch()

		expect(store.get(bankRecReconcileSettlingAtom)).toBe(false)
	})

	/*
	 * ⚠️ THE F7 REGRESSION. The accepted path's refresh is asynchronous - it invalidates the list and
	 * the balance and then rebuilds the selection from what the list returns - and the settling flag
	 * every candidate row's action is gated on used to clear the moment the POST settled, because the
	 * refresh was started as a void call and never awaited. In that window the just-reconciled
	 * transaction and the voucher it had already consumed were both actionable again, against a
	 * snapshot the server had superseded.
	 *
	 * Holding the invalidation open makes the window observable: the flag must stay raised across it
	 * and come down only once the refresh has converged.
	 */
	it('keeps the action closed until the ACCEPTED path\'s refresh has converged', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

		const refresh = createDeferred<undefined>()
		frappeSWRMutate.mockImplementation(() => refresh.promise)

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })

		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// The post has been accepted and the reviewer has already been told so - but the lists have
		// not been re-read yet, so nothing may be offered against the old snapshot.
		expect(successToast).toHaveBeenCalledTimes(1)
		expect(result.current.loading).toBe(false)
		expect(result.current.isSettling).toBe(true)
		expect(store.get(bankRecReconcileSettlingAtom)).toBe(true)

		await act(async () => {
			refresh.resolve(undefined)
			await refresh.promise
		})

		expect(result.current.isSettling).toBe(false)
		expect(store.get(bankRecReconcileSettlingAtom)).toBe(false)
	})

	it('raises no error dialog on the accepted path', async () => {
		const { store } = await confirmMatch()

		expect(store.get(bankRecErrorDialogAtom)).toBeNull()
	})
})

/*
 * A refused or lost post must leave the transaction unreconciled with its state unchanged. The proof
 * is structural: the client never writes a reconciliation it has not read back, so there is no
 * optimistic write to roll back and no window in which a rolled-back write is observable.
 */
describe('a refused post leaves the client\'s state exactly as it was', () => {

	let consoleError: ReturnType<typeof vi.spyOn>
	let errorToast: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		errorToast = vi.spyOn(toast, 'error').mockReturnValue('toast-id')
		frappeSWRMutate.mockResolvedValue(undefined)
	})

	afterEach(() => {
		consoleError.mockRestore()
		errorToast.mockRestore()
	})

	const refuseConfirm = async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		const refusal = makeAlreadyReconciledError(transaction.name)
		frappePostCall.mockRejectedValue(refusal)

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		return { store, transaction, refusal }
	}

	/*
	 * ⚠️ THE assertion FM1 and C9 both reduce to. `toBe` is deliberate: the selected row is the
	 * SAME OBJECT it was before the attempt, so nothing was patched, merged or re-flagged. A
	 * client that had optimistically marked the row reconciled would fail this even if it then
	 * reverted, because the reverted copy would not be the original object.
	 */
	it('does not transition the row to reconciled, or touch it at all', async () => {
		const { store, transaction } = await refuseConfirm()

		const selection = store.get(SELECTED_TRANSACTION_ATOM)

		expect(selection).toHaveLength(1)
		expect(selection[0]).toBe(transaction)
		expect(selection[0].status).toBe('Unreconciled')
		expect(selection[0].status).not.toBe('Reconciled')
		expect(selection[0].unallocated_amount).toBe(TEST_TRANSACTION_AMOUNT)
	})

	// One refusal, one attempt. A client that retried on rejection is exactly how a refused post
	// becomes a duplicate posting against a transaction the server had already allocated.
	it('does not retry, so a refusal cannot become a duplicate posting', async () => {
		await refuseConfirm()

		expect(frappePostCall).toHaveBeenCalledTimes(1)
	})

	// The audit log records what the server DID. A refused attempt did nothing, so it records
	// nothing - a log entry here would assert a reconciliation that never happened.
	it('writes no action-log entry for work the server refused', async () => {
		const { store } = await refuseConfirm()

		expect(store.get(bankRecActionLog)).toEqual([])
	})

	it('surfaces the server\'s own refusal to the reviewer, verbatim', async () => {
		const { store, transaction, refusal } = await refuseConfirm()

		// Raw and unmodified, so the shared parser sees Frappe's native envelope and the server's
		// wording reaches the reviewer without client paraphrasing.
		expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
		expect(errorToast).toHaveBeenCalledTimes(1)
		expect(errorToast.mock.calls[0][0]).toBe('Error')
		expect(String((errorToast.mock.calls[0][1] as { description?: unknown } | undefined)?.description))
			.toContain(formatAlreadyReconciledMessage(transaction.name))
	})

	// FM3's "refresh status" half, part one: the two cached lists that between them display every
	// `status` and `unallocated_amount` the reviewer sees are EMPTIED, so neither can go on showing
	// the pre-attempt snapshot - including the one whose tab is unmounted and therefore has no
	// revalidator a bare `mutate(key)` could have run.
	it('evicts both cached transaction lists so a stale client is corrected', async () => {
		await refuseConfirm()

		expect(frappeSWRMutate.mock.calls).toEqual([
			[UNRECONCILED_KEY, undefined, EVICT_CACHE_ENTRY_ARGS],
			[ALL_TRANSACTIONS_KEY, undefined, EVICT_CACHE_ENTRY_ARGS]
		])
	})

	// Part two: the GUARD is rebuilt from a read that cannot be served from a cache at all.
	it('re-reads the transaction from the server rather than from either cache', async () => {
		await refuseConfirm()

		expect(frappeContextValue.call.get).toHaveBeenCalledTimes(1)
		expect(frappeContextValue.call.get).toHaveBeenCalledWith(
			GET_BANK_TRANSACTIONS_METHOD,
			expect.objectContaining({ bank_account: TEST_BANK_ACCOUNT, all_transactions: true })
		)
	})

	/*
	 * ⚠️ THE F5 REGRESSION, and the reason the read is imperative.
	 *
	 * The Bank Transactions tab is unmounted - Radix unmounts inactive tab content - so its cache key
	 * has NO registered revalidator. A bare `mutate(key)` on such a key does not fetch: it resolves
	 * with whatever the entry already holds, which here is the PRE-ATTEMPT snapshot in which the
	 * transaction is still `Unreconciled` with its full amount unallocated. Rebuilding the selection
	 * from that value put the stale row straight back, with a positive unallocated amount, and
	 * re-enabled Confirm on a transaction the server had just refused as already fully reconciled -
	 * inviting the reviewer to post again against state they had been told was unreliable.
	 *
	 * The server's answer must win outright, and the stale cache must not contribute to the guard at
	 * all.
	 */
	it('does not let an unmounted, stale cached list re-enable the action', async () => {
		const store = createSeededStore()
		const staleRow = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [staleRow])
		frappePostCall.mockRejectedValue(makeAlreadyReconciledError(staleRow.name))

		// What an UNSUBSCRIBED key's mutate does: hands back the cached entry, unfetched. The
		// unreconciled key answers correctly (the row is gone from it, because the server filters on
		// `unallocated_amount > 0`); the all-transactions key answers with the stale snapshot.
		frappeSWRMutate.mockImplementation((key) =>
			Promise.resolve(key === ALL_TRANSACTIONS_KEY ? { message: [staleRow] } : { message: [] })
		)

		// What the server actually holds.
		const serverRow = makeReconciledTransaction({ name: staleRow.name })
		serverReportsTransactions([serverRow])

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(staleRow, makeLinkedPayment())
		})

		const selection = store.get(SELECTED_TRANSACTION_ATOM)

		expect(selection).toHaveLength(1)
		expect(selection[0]).toBe(serverRow)
		// The two assertions the defect actually turned on: the guard reads `status` and
		// `unallocated_amount`, and both must be the server's.
		expect(selection[0].status).toBe('Reconciled')
		expect(selection[0].unallocated_amount).toBe(0)
		expect(selection[0]).not.toBe(staleRow)
	})

	/*
	 * The complement of the case above: a transaction the server still reports as partly unallocated
	 * stays selected, with the server's remaining figure, so the reviewer can carry on with it. The
	 * refresh corrects the row - it does not simply discard everything it touches.
	 */
	it('keeps a still-unreconciled transaction selected, with the server\'s remaining figure', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockRejectedValue(makeAlreadyReconciledError(transaction.name))

		const refreshed = makeUnreconciledTransaction({ unallocated_amount: 4000 })
		serverReportsTransactions([refreshed])

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)[0]).toBe(refreshed)
		expect(store.get(SELECTED_TRANSACTION_ATOM)[0].unallocated_amount).toBe(4000)
	})

	// The hook is instantiated during render, before a bank account has necessarily been chosen, so
	// the selection atom family has to tolerate an empty instance key rather than throwing.
	it('can be instantiated before any bank account has been selected', () => {
		const store = createStoreWithoutBank()

		expect(() => renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })).not.toThrow()
	})

	it('does not attempt the authoritative read with no bank account to read for', async () => {
		const store = createStoreWithoutBank()
		const transaction = makeUnreconciledTransaction()
		frappePostCall.mockRejectedValue(makeAlreadyReconciledError(transaction.name))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// A read without a bank account would ask the endpoint for a required argument it does not
		// have, so it is not attempted at all - and the outcome is reported as unestablished rather
		// than as an empty answer.
		expect(frappeContextValue.call.get).not.toHaveBeenCalled()
		expect(store.get(bankRecErrorDialogAtom)).not.toBeNull()
		expect(result.current.isSettling).toBe(false)
	})
})


/*
 * The reconcile response fixtures against the controller's own relations.
 *
 * Everything downstream of a confirm - which cache families are invalidated, whether the reviewer
 * advances, whether the confirm affordance closes - is decided by the allocation figures on the
 * document the server returns. A fixture that reports figures the controller could never have
 * written is therefore not a harmless simplification: it makes every assertion built on it a
 * statement about a document that cannot exist. These tests pin the relations themselves, so a
 * fixture drifting away from them fails HERE, once, instead of quietly weakening the suites that
 * consume it.
 *
 * The relations come from `bank_transaction.py`: `update_allocated_amount` (:109-116) recomputes
 * `allocated_amount` as the sum of the child rows and `unallocated_amount` as
 * `abs(withdrawal - deposit) - allocated_amount`, and `set_status` (:143-149) derives the status of
 * a submitted document from the unallocated amount alone.
 */
describe('the reconcile response document obeys the Bank Transaction allocation contract', () => {

	/** Relation 2, asserted the way the review asked for it, on whatever document is passed. */
	const expectAllocationToBalance = (transaction: ReturnType<typeof makeBankTransaction>) => {
		expect((transaction.allocated_amount ?? 0) + (transaction.unallocated_amount ?? 0)).toBe(
			Math.abs((transaction.withdrawal ?? 0) - (transaction.deposit ?? 0))
		)
	}

	it('reports a FULL allocation with a matching child row and a Reconciled status', () => {
		const transaction = makeReconcileSuccessResponse().message

		expect(transaction.allocated_amount).toBe(TEST_TRANSACTION_AMOUNT)
		expect(transaction.unallocated_amount).toBe(0)
		expect(transaction.status).toBe('Reconciled')
		expectAllocationToBalance(transaction)

		// The allocation physically lives in the child table, and the parent figure is its sum.
		expect(transaction.payment_entries).toHaveLength(1)
		expect(transaction.payment_entries?.[0]).toMatchObject({
			payment_document: 'Payment Entry',
			allocated_amount: TEST_TRANSACTION_AMOUNT,
			reconciliation_type: 'Matched'
		})
		expect(
			transaction.payment_entries?.reduce((total, row) => total + row.allocated_amount, 0)
		).toBe(transaction.allocated_amount)
	})

	it('derives the allocated amount, the status and the child row from a PARTIAL unallocated figure', () => {
		const transaction = makeReconcileSuccessResponse({ unallocated_amount: 2500 }).message

		expect(transaction.allocated_amount).toBe(TEST_TRANSACTION_AMOUNT - 2500)
		expect(transaction.status).toBe('Unreconciled')
		expectAllocationToBalance(transaction)
		expect(transaction.payment_entries?.[0]?.allocated_amount).toBe(TEST_TRANSACTION_AMOUNT - 2500)
	})

	it('reports an untouched transaction with no child rows at all', () => {
		// Nothing allocated means there is no allocation for a child row to record, which is the
		// state every freshly imported transaction is in.
		const transaction = makeBankTransaction({ allocated_amount: 0 })

		expect(transaction.unallocated_amount).toBe(TEST_TRANSACTION_AMOUNT)
		expect(transaction.status).toBe('Unreconciled')
		expect(transaction.payment_entries).toEqual([])
		expectAllocationToBalance(transaction)
	})

	it('balances a WITHDRAWAL row against its own amount rather than the deposit default', () => {
		const transaction = makeBankTransaction({ deposit: 0, withdrawal: 500 })

		expect(transaction.allocated_amount).toBe(500)
		expect(transaction.unallocated_amount).toBe(0)
		expect(transaction.status).toBe('Reconciled')
		expectAllocationToBalance(transaction)
	})

	it('takes the allocated amount from explicit child rows when they are supplied', () => {
		const transaction = makeBankTransaction({
			payment_entries: [
				makeBankTransactionPayment({ allocated_amount: 7500 }),
				makeBankTransactionPayment({
					name: 'btp-f6g7h8i9j0',
					idx: 2,
					payment_entry: 'ACC-JV-2024-00001',
					payment_document: 'Journal Entry',
					allocated_amount: 5000
				})
			]
		})

		expect(transaction.allocated_amount).toBe(TEST_TRANSACTION_AMOUNT)
		expect(transaction.unallocated_amount).toBe(0)
		expectAllocationToBalance(transaction)
	})

	/*
	 * The builder REFUSES an impossible document rather than silently reshaping it. Both refusals
	 * below are combinations the previous fixtures actually produced, and each one made a suite
	 * assert against a document the controller cannot emit.
	 */
	it('refuses a status the allocation contradicts', () => {
		expect(() => makeBankTransaction({ unallocated_amount: 2500, status: 'Reconciled' })).toThrow(
			/status "Unreconciled"/
		)
	})

	it('refuses allocation figures that do not add up to the transaction amount', () => {
		expect(() =>
			makeBankTransaction({ allocated_amount: TEST_TRANSACTION_AMOUNT, unallocated_amount: 2500 })
		).toThrow(/must equal abs\(withdrawal - deposit\)/)
	})

	it('refuses a parent allocation with no child row underneath it', () => {
		expect(() =>
			makeBankTransaction({ allocated_amount: TEST_TRANSACTION_AMOUNT, payment_entries: [] })
		).toThrow(/sum of payment_entries allocations/)
	})
})

/*
 * Post-reconcile housekeeping: which caches are invalidated, and which row is reviewed next. The
 * branch is chosen by the SERVER'S reported `unallocated_amount`, never by the client's own
 * arithmetic - a partial allocation leaves the transaction on the list, a full one takes it off.
 */
describe('useRefreshUnreconciledTransactions', () => {

	beforeEach(() => {
		frappeSWRMutate.mockResolvedValue(undefined)
	})

	it('invalidates the list, the balance and the transaction\'s own vouchers on a PARTIAL allocation', () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		act(() => {
			result.current(transaction, makeBankTransaction({ unallocated_amount: 2500 }))
		})

		// Three keys, in this order, and then it stops: the transaction is still under review, so
		// the selection is deliberately left where the reviewer put it.
		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([
			UNRECONCILED_KEY,
			CLOSING_BALANCE_KEY,
			vouchersKeyFor(transaction.name, DEFAULT_JOINED_MATCH_FILTERS)
		])
	})

	it('keys the partial-allocation voucher invalidation to the reviewer\'s current filters', () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(bankRecMatchFilters, ['payment_entry'])

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		act(() => {
			result.current(transaction, makeBankTransaction({ unallocated_amount: 2500 }))
		})

		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toContain(
			vouchersKeyFor(transaction.name, 'payment_entry')
		)
	})

	/*
	 * A FULL allocation retires the transaction, so the reviewer is moved on to the next row -
	 * and "next" means next in the list AS FILTERED AND SEARCHED, not next in the raw response.
	 * Anything else would jump the reviewer to a row their own filters had excluded.
	 */
	it('advances the selection to the next row the refreshed list still contains', async () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction()
		const second = makeRuleMatchedTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [first])
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [first, second] })
		frappeSWRMutate.mockResolvedValue({ message: [second] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(first, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([second])
		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([UNRECONCILED_KEY, CLOSING_BALANCE_KEY])
	})

	// The row taken from the REFRESHED response, not from the pre-reconcile list, so the newly
	// selected transaction carries the server's current status rather than a stale snapshot.
	it('selects the refreshed instance of that row rather than the stale one it was holding', async () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction()
		const staleSecond = makeRuleMatchedTransaction({ unallocated_amount: 9999 })
		const refreshedSecond = makeRuleMatchedTransaction({ unallocated_amount: 4321 })
		store.set(SELECTED_TRANSACTION_ATOM, [first])
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [first, staleSecond] })
		frappeSWRMutate.mockResolvedValue({ message: [refreshedSecond] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(first, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)[0]).toBe(refreshedSecond)
		expect(store.get(SELECTED_TRANSACTION_ATOM)[0].unallocated_amount).toBe(4321)
	})

	// The candidate next row may itself have been reconciled by someone else in the meantime. It
	// is then absent from the refreshed list, and the selection is cleared rather than pointed at
	// a row the server no longer offers.
	it('clears the selection when the next row is absent from the refreshed list', async () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction()
		const second = makeRuleMatchedTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [first])
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [first, second] })
		frappeSWRMutate.mockResolvedValue({ message: [] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(first, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
	})

	it('clears the selection when the reconciled row was the last one', async () => {
		const store = createSeededStore()
		const only = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [only])
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [only] })
		frappeSWRMutate.mockResolvedValue({ message: [] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(only, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
	})

	/*
	 * "Next" is computed over the list the reviewer is actually looking at. With a Credits-only
	 * filter in force, the debit row sitting between two credits must be skipped - selecting it
	 * would drop the reviewer onto a row their own filter had hidden.
	 */
	it('respects the reviewer\'s active filters when choosing the next row', async () => {
		const store = createSeededStore()
		const credit = makeUnreconciledTransaction({ name: 'CREDIT-1', withdrawal: 0, deposit: 1000 })
		const debit = makeUnreconciledTransaction({ name: 'DEBIT-1', withdrawal: 750, deposit: 0 })
		const laterCredit = makeUnreconciledTransaction({ name: 'CREDIT-2', withdrawal: 0, deposit: 1250 })
		store.set(SELECTED_TRANSACTION_ATOM, [credit])
		store.set(bankRecTransactionTypeFilter, 'Credits')
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [credit, debit, laterCredit] })
		frappeSWRMutate.mockResolvedValue({ message: [debit, laterCredit] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(credit, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([laterCredit])
	})

	/*
	 * The amount filter narrows the same list, so it narrows "next" too. A reviewer working a
	 * single statement figure must not be moved onto a row of a different amount just because it
	 * happens to sit next in the raw response.
	 */
	it('respects an active amount filter when choosing the next row', async () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction({ name: 'AMT-1', withdrawal: 0, deposit: 1500 })
		const otherAmount = makeUnreconciledTransaction({ name: 'AMT-OTHER', withdrawal: 0, deposit: 999 })
		const sameAmount = makeUnreconciledTransaction({ name: 'AMT-2', withdrawal: 0, deposit: 1500 })
		store.set(SELECTED_TRANSACTION_ATOM, [first])
		store.set(bankRecAmountFilter, { value: 1500, stringValue: '1500' })
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [first, otherAmount, sameAmount] })
		frappeSWRMutate.mockResolvedValue({ message: [otherAmount, sameAmount] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(first, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([sameAmount])
	})

	// The updated document is optional, and its absence means "nothing is known about the
	// allocation" - which takes the same path as a full allocation rather than the partial one.
	it('takes the full-allocation path when no updated document is supplied at all', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(transaction)
		})

		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([UNRECONCILED_KEY, CLOSING_BALANCE_KEY])
	})

	// Instantiated during render, so it has to be safe before a bank account exists: the selection
	// atom family is then addressed by an empty instance key rather than by an account name.
	it('can be instantiated, and invoked, before any bank account has been selected', async () => {
		const store = createStoreWithoutBank()
		const transaction = makeUnreconciledTransaction()

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(transaction, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(frappeSWRMutate.mock.calls.map(([key]) => key).filter((key) => familyOf(key) === undefined))
			.toEqual([])
	})

	// A refresh that resolves with nothing - no mounted fetcher for the key - must not throw while
	// looking for the next row inside a response that never arrived.
	it('survives a refresh that resolves without a payload', async () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction()
		const second = makeRuleMatchedTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [first])
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [first, second] })
		frappeSWRMutate.mockResolvedValue(undefined)

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })

		await act(async () => {
			await expect(Promise.resolve(result.current(first, makeBankTransaction({ unallocated_amount: 0 }))))
				.resolves.toBeUndefined()
		})
	})

	/*
	 * The refresh is AWAITED by the reconcile hook so its shared settling flag can span convergence,
	 * which makes "what happens when an invalidation rejects" a question with consequences: a
	 * rejection escaping here would both surface as an unhandled rejection and reject the caller's
	 * await, leaving the affordance closed after a reconciliation the server had ACCEPTED.
	 */
	it('resolves, and leaves the selection alone, when an invalidation rejects', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const store = createSeededStore()
		const first = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [first])
		const invalidationFailure = new Error('revalidation failed')
		frappeSWRMutate.mockRejectedValue(invalidationFailure)

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })

		await act(async () => {
			await expect(Promise.resolve(result.current(first, makeBankTransaction({ unallocated_amount: 0 }))))
				.resolves.toBeUndefined()
		})

		// Reported rather than swallowed - as a FIXED diagnostic rather than as the caught object,
		// which would put a whole Frappe response envelope in the browser console - and the
		// reviewer's selection is not discarded over a failed cache refresh.
		expect(consoleError).toHaveBeenCalledWith(
			'Bank reconciliation: the post-reconciliation transaction refresh did not complete.'
		)
		expect(consoleError).not.toHaveBeenCalledWith(invalidationFailure)
		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([first])
		consoleError.mockRestore()
	})
})

describe('useIsTransactionWithdrawal', () => {

	/*
	 * A bank transaction carries its amount in ONE of two columns and the row renders whichever is
	 * positive, so the classification and the displayed figure have to come from the same decision.
	 * Splitting them is how a debit ends up displaying a credit's amount.
	 */
	it('classifies a debit and reports the withdrawn amount', () => {
		const { result } = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: 750, deposit: 0 })))

		expect(result.current.isWithdrawal).toBe(true)
		expect(result.current.isDeposit).toBeFalsy()
		expect(result.current.amount).toBe(750)
	})

	it('classifies a credit and reports the deposited amount', () => {
		const { result } = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: 0, deposit: 1250 })))

		expect(result.current.isDeposit).toBe(true)
		expect(result.current.isWithdrawal).toBeFalsy()
		expect(result.current.amount).toBe(1250)
	})

	// Both columns are optional on the DocType, so an absent pair must classify as neither rather
	// than defaulting a transaction into one direction or the other.
	it('classifies a transaction with neither column as neither', () => {
		const { result } = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: undefined, deposit: undefined })))

		expect(result.current.isWithdrawal).toBeFalsy()
		expect(result.current.isDeposit).toBeFalsy()
		expect(result.current.amount).toBeUndefined()
	})

	// A zero in a column is not an amount: it is the empty column of a transaction whose value
	// sits in the other one.
	it('treats a zero as an empty column rather than as an amount', () => {
		const { result } = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: 0, deposit: 0 })))

		expect(result.current.isWithdrawal).toBeFalsy()
		expect(result.current.isDeposit).toBeFalsy()
	})
})

/*
 * TC2's client-side half. A rule-stamped transaction names the rule that matched it, and the
 * workbench reads that rule to show WHY the row was suggested. The document read must be
 * suppressed entirely for an unstamped row, or every unmatched transaction in the list would fire
 * a request for a document called `undefined`.
 */
describe('useGetRuleForTransaction', () => {

	it('reads the rule a stamped transaction names', () => {
		renderHook(() => useGetRuleForTransaction(makeRuleMatchedTransaction()))

		const [doctype, name, swrKey, options] = lastGetDocCall()

		expect(doctype).toBe('Bank Transaction Rule')
		expect(name).toBe(TEST_TRANSACTION_RULE)
		// `undefined` lets SWR derive the key from the doctype and name, so the fetch proceeds.
		expect(swrKey).toBeUndefined()
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
		expect(swrOptionsOf(options).revalidateIfStale).toBe(false)
	})

	it('does not read anything for a transaction no rule matched', () => {
		renderHook(() => useGetRuleForTransaction(makeUnreconciledTransaction()))

		const [doctype, name, swrKey] = lastGetDocCall()

		expect(doctype).toBe('Bank Transaction Rule')
		expect(name).toBeUndefined()
		// A null key is SWR's "do not fetch": no request is made for an unstamped row.
		expect(swrKey).toBeNull()
	})
})

/*
 * Debounced, and published into a SHARED atom rather than held locally, because the search string is
 * read by the transaction list, by the next-transaction selection above and by the bulk-action
 * surfaces; publishing per keystroke would re-filter a virtualised list per character.
 *
 * The hook's "initial value changed" re-sync block is provably unreachable: the ref is seeded with the
 * same empty-string constant it is compared against and is only ever reassigned that constant, so no
 * input can reach those two lines.
 */
describe('useTransactionSearch', () => {

	it('holds a keystroke back, then publishes it to the shared search atom', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useTransactionSearch(), { wrapper: withStore(store) })

		expect(result.current[0]).toBe('')

		act(() => {
			result.current[1]('acme')
		})
		// Debounced: the atom has NOT moved yet, which is the whole point of the hook.
		expect(store.get(bankRecSearchText)).toBe('')

		act(() => {
			result.current[1].flush()
		})
		expect(store.get(bankRecSearchText)).toBe('acme')
	})

	// The returned value is the atom's, so an input bound to it and a list filtered by it cannot
	// disagree about what is currently being searched for.
	it('reports the shared atom\'s current value', () => {
		const store = createSeededStore()
		store.set(bankRecSearchText, TEST_TRANSACTION_DESCRIPTION)

		const { result } = renderHook(() => useTransactionSearch(), { wrapper: withStore(store) })

		expect(result.current[0]).toBe(TEST_TRANSACTION_DESCRIPTION)
	})

	// A pending keystroke can be abandoned - the reviewer clearing the box or navigating away must
	// not have a stale search land afterwards.
	it('can abandon a keystroke that has not been published yet', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useTransactionSearch(), { wrapper: withStore(store) })

		act(() => {
			result.current[1]('abandoned')
			result.current[1].cancel()
		})

		expect(store.get(bankRecSearchText)).toBe('')
	})
})

/*
 * `getSearchResults` composes three independent narrowings - fuzzy search, direction and exact amount
 * - and also decides which row is reviewed next after a reconciliation, so it is load-bearing twice
 * over.
 */
describe('getSearchResults', () => {

	const debit = makeUnreconciledTransaction({
		name: 'ACC-BTN-2024-09001',
		withdrawal: 500,
		deposit: 0,
		unallocated_amount: 500,
		description: 'ATM cash withdrawal Bengaluru',
		reference_number: 'ATM-9001'
	})
	const credit = makeUnreconciledTransaction({
		name: 'ACC-BTN-2024-09002',
		withdrawal: 0,
		deposit: 750,
		unallocated_amount: 750,
		description: 'Salary credit from Globex',
		reference_number: 'SAL-9002'
	})
	const valueless = makeUnreconciledTransaction({
		name: 'ACC-BTN-2024-09003',
		withdrawal: 0,
		deposit: 0,
		unallocated_amount: 0,
		description: 'Adjustment placeholder',
		reference_number: 'ADJ-9003'
	})

	const rows = [debit, credit, valueless]

	const searchIndex = () => new Fuse(rows, {
		keys: ['description', 'reference_number'],
		threshold: 0.5,
		includeScore: true
	})

	const names = (results: UnreconciledTransaction[]) => results.map((transaction) => transaction.name)

	it('returns every row when there is no index to search', () => {
		expect(names(getSearchResults(null, 'anything', 'All', 0, rows))).toEqual(names(rows))
	})

	it('returns every row when the search box is empty', () => {
		expect(names(getSearchResults(searchIndex(), '', 'All', 0, rows))).toEqual(names(rows))
	})

	it('returns an empty list when there are no transactions at all', () => {
		expect(getSearchResults(null, '', 'All', 0, undefined)).toEqual([])
	})

	it('narrows to the fuzzy matches once a search string is given', () => {
		const results = getSearchResults(searchIndex(), 'Salary', 'All', 0, rows)

		expect(names(results)).toContain(credit.name)
		expect(names(results)).not.toContain(valueless.name)
	})

	it('searches the reference number as well as the description', () => {
		expect(names(getSearchResults(searchIndex(), 'ATM-9001', 'All', 0, rows))).toContain(debit.name)
	})

	it('keeps only debits under the Debits filter', () => {
		expect(names(getSearchResults(null, '', 'Debits', 0, rows))).toEqual([debit.name])
	})

	it('keeps only credits under the Credits filter', () => {
		expect(names(getSearchResults(null, '', 'Credits', 0, rows))).toEqual([credit.name])
	})

	// An unrecognised filter narrows to nothing rather than falling through to everything. Failing
	// closed is the safer default here: a reviewer sees an obviously empty list rather than an
	// unfiltered one they believe is filtered.
	it('narrows to nothing under a filter it does not recognise', () => {
		expect(getSearchResults(null, '', 'Something Else', 0, rows)).toEqual([])
	})

	it('matches an exact amount in the withdrawal column', () => {
		expect(names(getSearchResults(null, '', 'All', 500, rows))).toEqual([debit.name])
	})

	it('matches an exact amount in the deposit column', () => {
		expect(names(getSearchResults(null, '', 'All', 750, rows))).toEqual([credit.name])
	})

	// Exact, not "at least": the reviewer is looking for a specific figure off a statement line.
	it('does not match an amount that merely differs', () => {
		expect(getSearchResults(null, '', 'All', 501, rows)).toEqual([])
	})

	// A row with nothing in either column can never satisfy an amount filter, and must be dropped
	// rather than passed through for want of a column to compare.
	it('drops a row with no value in either column when an amount filter is set', () => {
		expect(names(getSearchResults(null, '', 'All', 500, rows))).not.toContain(valueless.name)
	})

	it('applies the direction and amount filters together', () => {
		expect(getSearchResults(null, '', 'Credits', 500, rows)).toEqual([])
		expect(names(getSearchResults(null, '', 'Debits', 500, rows))).toEqual([debit.name])
	})

	// Zero means "no amount filter", not "match a zero amount" - which is why the valueless row is
	// not selected by it.
	it('treats a zero amount filter as no amount filter', () => {
		expect(names(getSearchResults(null, '', 'All', 0, rows))).toEqual(names(rows))
	})
})

/*
 * The session action log is the reviewer's own audit trail for one sitting, which is why it is
 * prepended (newest first, matching how it is displayed) and capped (an unbounded log in session
 * storage grows for as long as the tab lives).
 */
describe('useUpdateActionLog', () => {

	const makeMatchAction = (timestamp: number): ActionLog => ({
		type: 'match',
		isBulk: false,
		timestamp,
		items: [{
			bankTransaction: makeBankTransaction(),
			voucher: {
				reference_doctype: 'Payment Entry',
				reference_name: 'ACC-PAY-2024-00001',
				reference_no: TEST_REFERENCE_NUMBER,
				reference_date: TEST_TRANSACTION_DATE,
				posting_date: TEST_TRANSACTION_DATE
			}
		}]
	})

	it('records an action', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useUpdateActionLog(), { wrapper: withStore(store) })
		act(() => {
			result.current(makeMatchAction(1))
		})

		expect(store.get(bankRecActionLog)).toHaveLength(1)
		expect(store.get(bankRecActionLog)[0].timestamp).toBe(1)
	})

	it('puts the newest action first', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useUpdateActionLog(), { wrapper: withStore(store) })
		act(() => {
			result.current(makeMatchAction(1))
			result.current(makeMatchAction(2))
			result.current(makeMatchAction(3))
		})

		expect(store.get(bankRecActionLog).map((action) => action.timestamp)).toEqual([3, 2, 1])
	})

	// The cap retires the OLDEST entries, so a long session keeps the actions a reviewer might
	// still want to undo and discards the ones they have moved well past.
	it('caps the log at a hundred actions, discarding the oldest', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useUpdateActionLog(), { wrapper: withStore(store) })
		act(() => {
			for (let timestamp = 1; timestamp <= 101; timestamp++) {
				result.current(makeMatchAction(timestamp))
			}
		})

		const log = store.get(bankRecActionLog)

		expect(log).toHaveLength(100)
		expect(log[0].timestamp).toBe(101)
		expect(log[99].timestamp).toBe(2)
		expect(log.map((action) => action.timestamp)).not.toContain(1)
	})
})
