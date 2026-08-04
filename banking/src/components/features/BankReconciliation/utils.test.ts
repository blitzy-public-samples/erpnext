import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { createElement, type PropsWithChildren } from 'react'
import Fuse from 'fuse.js'
import { toast } from 'sonner'
import {
	TEST_BANK,
	TEST_ALTERNATE_CURRENCY,
	TEST_BANK_ACCOUNT,
	TEST_BANK_LEDGER_ACCOUNT,
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
	makeSuggestedLinkedPayment,
	makeUnreconciledTransaction
} from '@/test/factories'

// The module under test imports the SDK's hooks at module scope, so the package is replaced
// wholesale before it loads. These particular tests exercise only the pure grading helpers, but
// the mock has to be in place for the import itself to succeed, and it keeps the suite unable to
// reach a real transport if a later test drives a hook.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import {
	getSearchResults,
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
	useRefreshUnreconciledTransactions,
	useSelectedBankAccountCurrency,
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
	bankRecReconcileInFlightAtom,
	bankRecSearchText,
	bankRecSelectedTransactionAtom,
	bankRecTransactionTypeFilter,
	bankRecUnreconcileModalAtom,
	selectedBankAccountAtom,
	type ActionLog,
	type SelectedBank
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

	/*
	 * The key strings themselves, spelled out. There is deliberately no exported builder to compare
	 * against: every hook composes its key inline, and the rejection handler composes the two it
	 * revalidates the same way. Restating them here is what makes a drift between the two composition
	 * sites - which would silently revalidate a key nothing is subscribed to - fail as a test rather
	 * than as an unrefreshed list.
	 */
	it('composes each family\'s key from the account and the date range, character for character', () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()

		renderHook(() => useEveryKeyedQuery(transaction), { wrapper: withStore(store) })

		const declaredKeys = frappeSDKMock.useFrappeGetCall.mock.calls
			.map(([, , swrKey]) => swrKey)
			.filter((swrKey): swrKey is string => typeof swrKey === 'string')

		expect(declaredKeys).toContain(`bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`)
		expect(declaredKeys).toContain(`bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`)
		expect(declaredKeys).toContain(`bank-reconciliation-account-closing-balance-${TEST_BANK_ACCOUNT}-${TO_DATE}`)
		expect(declaredKeys).toContain(`bank-reconciliation-account-closing-balance-as-per-statement-${TEST_BANK_ACCOUNT}-${TO_DATE}`)
		expect(declaredKeys).toContain(vouchersKeyFor(transaction.name, DEFAULT_JOINED_MATCH_FILTERS))
	})

	it('attributes a key from outside the five families to no family at all', () => {
		expect(familyOf('bank-reconciliation-something-new-Test Bank')).toBeUndefined()
		expect(familyOf(undefined)).toBeUndefined()
		expect(familyOf(null)).toBeUndefined()
	})
})

/*
 * `account_currency` is NOT a `Bank Account` field: the endpoint derives it per row by following
 * `Bank Account.account` to `Account.account_currency` after the query, in an unconditional loop
 * (`bank_account.py:173-176`). So on an ENDPOINT row the key is always PRESENT and its value is
 * NULLABLE - required-nullable, not optional - and the currency advisory treats a null as "nothing to
 * compare" rather than as a mismatch. The persisted selection is the shape where the key genuinely can
 * be absent, because a localStorage snapshot may predate it.
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
		// request. That sharing is asserted in its own suite below.
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

	// A row whose GL account has no currency arrives as a literal `null` - the endpoint attaches the
	// key regardless - and must be passed through as such rather than defaulted: inventing a currency
	// here is what would let the advisory claim a mismatch that does not exist.
	it('passes through the literal null the endpoint sends when it could not derive a currency', () => {
		const store = createSeededStore()
		answerGetCall(BANK_ACCOUNT_GET_LIST, { message: [makeBankAccountListRow({ account_currency: null })] })

		const { result } = renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

		expect(result.current.banks[0].account_currency).toBeNull()
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

	/*
	 * ══════════════════════════════════════════════════════════════════════════════════════════════
	 * REHYDRATION OF THE PERSISTED SELECTION
	 *
	 * The defect this closes is a LIFECYCLE one, and it cannot be seen by a test that seeds both
	 * sources with the same value. `selectedBankAccountAtom` is `atomWithStorage` over localStorage
	 * with `getOnInit: true`, and `BankPicker` deliberately leaves the stored row ALONE whenever the
	 * account it names is still present in a response - it writes only when it has to CHOOSE an
	 * account. So the stored row's fields were written once and then never refreshed for the life of
	 * that account: repointing the bank account at a GL account in another currency, or editing
	 * `Account.account_currency`, changed the server's answer and not the snapshot, and every consumer
	 * reading the snapshot kept the old value indefinitely.
	 *
	 * Each test below seeds a snapshot that DISAGREES with the endpoint's answer, which is the only
	 * arrangement that can tell an implementation which refreshes from one which does not.
	 * ══════════════════════════════════════════════════════════════════════════════════════════════ */
	describe('rehydrating the persisted selection from the endpoint', () => {

		const storeWithStaleSelection = (overrides: Partial<SelectedBank> = {}) => {
			const store = createStore()
			store.set(selectedCompanyAtom, TEST_COMPANY)
			store.set(selectedBankAccountAtom, makeSelectedBank({
				account_currency: TEST_ALTERNATE_CURRENCY,
				...overrides
			}))
			return store
		}

		it('refreshes the stored account currency from the authoritative row', async () => {
			const store = storeWithStaleSelection()
			answerGetCall(BANK_ACCOUNT_GET_LIST, {
				message: [makeBankAccountListRow({ name: TEST_BANK_ACCOUNT, account_currency: TEST_CURRENCY })]
			})

			renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)?.account_currency).toBe(TEST_CURRENCY)
			})
			expect(store.get(selectedBankAccountAtom)?.account_currency).not.toBe(TEST_ALTERNATE_CURRENCY)
		})

		it('refreshes every other projected field too, not only the currency', async () => {
			const store = storeWithStaleSelection({ account_name: 'Renamed since', account: 'Old GL - TC' })
			answerGetCall(BANK_ACCOUNT_GET_LIST, {
				message: [makeBankAccountListRow({
					name: TEST_BANK_ACCOUNT,
					account_currency: TEST_CURRENCY,
					account_name: 'Test Bank Current Account',
					account: TEST_BANK_LEDGER_ACCOUNT
				})]
			})

			renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)?.account_name).toBe('Test Bank Current Account')
			})
			expect(store.get(selectedBankAccountAtom)?.account).toBe(TEST_BANK_LEDGER_ACCOUNT)
		})

		it('preserves the members the endpoint does NOT project', async () => {
			// `integration_id` is on the persisted shape and is not projected by this endpoint, and the
			// logo members are resolved client-side. Overwriting the row wholesale would erase all of
			// them, so the refresh MERGES onto the snapshot rather than replacing it.
			const store = storeWithStaleSelection({ integration_id: 'plaid-abc-123', logo: 'HDFC.svg' })
			answerGetCall(BANK_ACCOUNT_GET_LIST, {
				message: [makeBankAccountListRow({ name: TEST_BANK_ACCOUNT, account_currency: TEST_CURRENCY })]
			})

			renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)?.account_currency).toBe(TEST_CURRENCY)
			})
			expect(store.get(selectedBankAccountAtom)?.integration_id).toBe('plaid-abc-123')
			expect(store.get(selectedBankAccountAtom)?.logo).toBe('HDFC.svg')
		})

		it('propagates a literal null, so a currency that was REMOVED is not remembered', async () => {
			const store = storeWithStaleSelection({ account_currency: TEST_CURRENCY })
			answerGetCall(BANK_ACCOUNT_GET_LIST, {
				message: [makeBankAccountListRow({ name: TEST_BANK_ACCOUNT, account_currency: null })]
			})

			renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)?.account_currency).toBeNull()
			})
		})

		it('CONVERGES — it writes once and then stops, however often it re-renders', async () => {
			/*
			 * The identity guard, and it is load-bearing rather than an optimisation. This hook is
			 * rendered by several consumers at once and its effect runs on each of them, so a write
			 * that did not first check for a difference would set a NEW object every time, re-render
			 * every consumer, and run the effect again - an unbounded loop rather than a refresh.
			 *
			 * Exactly ONE write is expected here — the refresh itself — and what must not happen is a
			 * second, which is what is asserted.
			 */
			const store = storeWithStaleSelection()
			answerGetCall(BANK_ACCOUNT_GET_LIST, {
				message: [makeBankAccountListRow({ name: TEST_BANK_ACCOUNT, account_currency: TEST_CURRENCY })]
			})

			const { rerender } = renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })
			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)?.account_currency).toBe(TEST_CURRENCY)
			})

			const converged = store.get(selectedBankAccountAtom)

			// Counting starts only once the refresh has landed, so what is measured is exclusively
			// whether the effect keeps going — the loop, not the fix.
			const writesAfterConvergence: (SelectedBank | null)[] = []
			const unsubscribe = store.sub(selectedBankAccountAtom, () => {
				writesAfterConvergence.push(store.get(selectedBankAccountAtom))
			})

			// Re-render repeatedly, and mount a SECOND consumer of the same hook against the same
			// store — the production arrangement, and the one an unguarded write would loop on.
			rerender()
			rerender()
			renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })
			await act(async () => {
				await Promise.resolve()
			})

			// Nothing after the refresh CHANGES the value. `atomWithStorage` re-emits its own
			// localStorage sync, so a notification is not by itself evidence of a rewrite — the
			// content is. An unguarded write would produce a materially different object on every
			// effect run instead.
			for (const value of writesAfterConvergence) {
				expect(value).toEqual(converged)
			}

			// ...and it has STOPPED, which is the anti-loop property proper: an unguarded write
			// re-renders every consumer, which runs the effect again, which writes again, without
			// bound. Two further flushes must add nothing.
			const settled = writesAfterConvergence.length
			await act(async () => { await Promise.resolve() })
			await act(async () => { await Promise.resolve() })
			expect(writesAfterConvergence).toHaveLength(settled)

			expect(store.get(selectedBankAccountAtom)).toEqual(converged)
			expect(store.get(selectedBankAccountAtom)?.account_currency).toBe(TEST_CURRENCY)

			unsubscribe()
		})

		it('leaves the snapshot alone when the selected account is absent from the response', async () => {
			// Absence is not evidence about the selected account - the response may be for another
			// company, or the account may be newly disabled. Overwriting or clearing the snapshot here
			// would discard the reviewer's selection on a payload that says nothing about it; that
			// decision belongs to the bank picker, which owns choosing an account.
			const store = storeWithStaleSelection()
			answerGetCall(BANK_ACCOUNT_GET_LIST, {
				message: [makeBankAccountListRow({ name: 'Other Bank - Test Company', account_currency: TEST_CURRENCY })]
			})

			renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })
			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)?.name).toBe(TEST_BANK_ACCOUNT)
			})

			expect(store.get(selectedBankAccountAtom)?.account_currency).toBe(TEST_ALTERNATE_CURRENCY)
		})

		it('writes nothing at all when no account is selected', async () => {
			const store = createStore()
			store.set(selectedCompanyAtom, TEST_COMPANY)
			answerGetCall(BANK_ACCOUNT_GET_LIST, { message: [makeBankAccountListRow()] })

			renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })
			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)).toBeNull()
			})
		})

		it('writes nothing before the endpoint has answered', () => {
			const store = storeWithStaleSelection()

			renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

			// An unanswered read is not an authority. Clearing or defaulting the snapshot here would
			// blank the selection on every cold start.
			expect(store.get(selectedBankAccountAtom)?.account_currency).toBe(TEST_ALTERNATE_CURRENCY)
		})

		it('makes the currency reader agree with the refreshed snapshot, so no consumer can disagree', async () => {
			// The point of centralising the refresh here: a consumer reading the live value and a
			// consumer reading the snapshot must arrive at the same answer.
			const store = storeWithStaleSelection()
			answerGetCall(BANK_ACCOUNT_GET_LIST, {
				message: [makeBankAccountListRow({ name: TEST_BANK_ACCOUNT, account_currency: TEST_CURRENCY })]
			})

			const { result } = renderHook(() => useSelectedBankAccountCurrency(), { wrapper: withStore(store) })

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)?.account_currency).toBe(TEST_CURRENCY)
			})
			expect(result.current).toBe(TEST_CURRENCY)
			expect(result.current).toBe(store.get(selectedBankAccountAtom)?.account_currency)
		})
	})
})

/*
 * ─── THE CURRENT ACCOUNT CURRENCY, AND WHY IT IS NOT THE PERSISTED ONE ──────────────────────────
 *
 * `selectedBankAccountAtom` is `atomWithStorage` over localStorage with `getOnInit: true`, and
 * `BankPicker` deliberately leaves the stored row alone whenever the account it names is still
 * present in a fresh response. So the stored `account_currency` is written once and then never
 * refreshed for the life of that account: repointing the bank account at an account in another
 * currency, or editing `Account.account_currency`, changes the server's answer and not the snapshot.
 *
 * This hook exists so the FM5 advisory reads the server's answer instead. Every test below seeds the
 * persisted snapshot with a DIFFERENT currency from the endpoint's, which is the only arrangement
 * that can tell the two sources apart.
 */
describe('useSelectedBankAccountCurrency', () => {

	const STALE_PERSISTED_CURRENCY = TEST_ALTERNATE_CURRENCY

	const renderCurrency = (rows?: unknown[]) => {
		const store = createStore()
		store.set(selectedCompanyAtom, TEST_COMPANY)
		store.set(selectedBankAccountAtom, makeSelectedBank({ account_currency: STALE_PERSISTED_CURRENCY }))

		if (rows !== undefined) {
			answerGetCall(BANK_ACCOUNT_GET_LIST, { message: rows })
		}

		return renderHook(() => useSelectedBankAccountCurrency(), { wrapper: withStore(store) })
	}

	it('returns the currency the CURRENT endpoint row carries, not the persisted one', () => {
		const { result } = renderCurrency([makeBankAccountListRow({ account_currency: TEST_CURRENCY })])

		expect(result.current).toBe(TEST_CURRENCY)
		expect(result.current).not.toBe(STALE_PERSISTED_CURRENCY)
	})

	it('reads that row through the SAME request the bank picker already makes', () => {
		renderCurrency([makeBankAccountListRow({ account_currency: TEST_CURRENCY })])

		// One unkeyed call to the list endpoint, for this company. SWR derives the key from method
		// plus params, so this hook deduplicates onto the picker's entry rather than opening a second
		// request for the same rows.
		const [method, params, swrKey] = lastGetCallFor(BANK_ACCOUNT_GET_LIST)
		expect(method).toBe(BANK_ACCOUNT_GET_LIST)
		expect(params).toEqual({ company: TEST_COMPANY })
		expect(swrKey).toBeUndefined()
	})

	it('is undefined while the list has not answered', () => {
		const { result } = renderCurrency()

		// "Not known" - which the advisory must read as nothing to compare. Falling back to the
		// persisted value here is exactly the defect this hook exists to remove.
		expect(result.current).toBeUndefined()
	})

	it('is undefined when the endpoint attaches a literal null', () => {
		const { result } = renderCurrency([makeBankAccountListRow({ account_currency: null })])

		// `Account.account_currency` is nullable and the endpoint always attaches the key, so `null`
		// is a real payload. It is normalised to `undefined` so callers have one absence to handle.
		expect(result.current).toBeUndefined()
	})

	it('is undefined when the selected account is absent from the current list', () => {
		const { result } = renderCurrency([
			makeBankAccountListRow({ name: 'Other Bank - Test Company', account_currency: TEST_CURRENCY })
		])

		expect(result.current).toBeUndefined()
	})

	it('is undefined when no bank account is selected at all', () => {
		const store = createStore()
		store.set(selectedCompanyAtom, TEST_COMPANY)
		answerGetCall(BANK_ACCOUNT_GET_LIST, { message: [makeBankAccountListRow()] })

		const { result } = renderHook(() => useSelectedBankAccountCurrency(), { wrapper: withStore(store) })

		expect(result.current).toBeUndefined()
	})

	it('picks the row matching the selection out of several accounts', () => {
		const { result } = renderCurrency([
			makeBankAccountListRow({ name: 'Other Bank - Test Company', account_currency: 'EUR' }),
			makeBankAccountListRow({ name: TEST_BANK_ACCOUNT, account_currency: TEST_CURRENCY })
		])

		expect(result.current).toBe(TEST_CURRENCY)
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
	 * ══════════════════════════════════════════════════════════════════════════════════════════════
	 * THE SINGLE-FLIGHT GUARD, at the hook's own boundary
	 *
	 * `loading` is per HOOK INSTANCE, and every candidate voucher row instantiates the hook for
	 * itself, so it can never be the guard: it tells a row about its own request and nothing about a
	 * sibling's. The guard is therefore SHARED STATE, and it is checked and set through the jotai
	 * store rather than through a subscribed value, because a subscribed read is a snapshot of the
	 * last render and two dispatches in one tick would both see it empty.
	 *
	 * The component-level consequence - two candidate rows, one held request, one dispatch - is
	 * asserted in `MatchAndReconcile.test.tsx`. What is asserted here is the contract those rows
	 * depend on.
	 * ══════════════════════════════════════════════════════════════════════════════════════════════ */
	describe('the shared single-flight guard', () => {

		const seedForReconcile = () => {
			const store = createSeededStore()
			const transaction = makeUnreconciledTransaction()
			store.set(SELECTED_TRANSACTION_ATOM, [transaction])
			return { store, transaction, voucher: makeSuggestedLinkedPayment(transaction) }
		}

		it('starts idle, so a store nobody has posted from permits a post', () => {
			expect(createStore().get(bankRecReconcileInFlightAtom)).toBeNull()
		})

		it('records the transaction under post and reports it to every consumer', async () => {
			const { store, transaction, voucher } = seedForReconcile()
			frappePostCall.mockReturnValue(new Promise(() => { /* never settles */ }))

			const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })

			expect(result.current.isReconcileInFlight).toBe(false)

			await act(async () => {
				result.current.reconcileTransaction(transaction, voucher)
			})

			expect(store.get(bankRecReconcileInFlightAtom)).toBe(transaction.name)
			expect(result.current.isReconcileInFlight).toBe(true)
			expect(result.current.inFlightTransaction).toBe(transaction.name)
		})

		it('refuses a second dispatch while the first is unanswered', async () => {
			const { store, transaction, voucher } = seedForReconcile()
			frappePostCall.mockReturnValue(new Promise(() => { /* never settles */ }))

			const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })

			await act(async () => {
				result.current.reconcileTransaction(transaction, voucher)
				result.current.reconcileTransaction(transaction, voucher)
			})

			// Both dispatches happen inside ONE act block, so React batches them and the handler runs
			// twice with no re-render in between - which is exactly the case a guard derived from
			// rendered state would miss.
			expect(frappePostCall).toHaveBeenCalledTimes(1)
		})

		it('refuses a dispatch from a SEPARATE hook instance, which is the real defect', async () => {
			// Two instances is what a voucher panel actually renders. Sharing the store is what makes
			// the second instance see the first's open request.
			const { store, transaction, voucher } = seedForReconcile()
			const alternate = makeAlternateLinkedPayment()
			frappePostCall.mockReturnValue(new Promise(() => { /* never settles */ }))

			const first = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
			const second = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })

			await act(async () => {
				first.result.current.reconcileTransaction(transaction, voucher)
			})
			await act(async () => {
				second.result.current.reconcileTransaction(transaction, alternate)
			})

			expect(frappePostCall).toHaveBeenCalledTimes(1)
			expect(String(frappePostCall.mock.calls[0][0].vouchers)).toContain(voucher.name)
			expect(second.result.current.isReconcileInFlight).toBe(true)
		})

		it('releases the guard once the post is ACCEPTED', async () => {
			const { store, transaction, voucher } = seedForReconcile()
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse({ unallocated_amount: 2500 }))

			const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
			await act(async () => {
				await result.current.reconcileTransaction(transaction, voucher)
			})

			await waitFor(() => {
				expect(store.get(bankRecReconcileInFlightAtom)).toBeNull()
			})

			// ...and a further post is permitted, which is what a partial allocation requires.
			await act(async () => {
				result.current.reconcileTransaction(transaction, voucher)
			})
			expect(frappePostCall).toHaveBeenCalledTimes(2)
		})

		it('releases the guard once the post is REFUSED, so the reviewer is not locked out', async () => {
			// Releasing only on success would leave the guard closed for the rest of the session after
			// any refusal - a self-inflicted denial of the whole feature.
			const { store, transaction, voucher } = seedForReconcile()
			frappePostCall.mockRejectedValue(makeAlreadyReconciledError(transaction.name))
			const errorToast = vi.spyOn(toast, 'error').mockReturnValue('toast-id')

			const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
			await act(async () => {
				await result.current.reconcileTransaction(transaction, voucher)
			})

			await waitFor(() => {
				expect(store.get(bankRecReconcileInFlightAtom)).toBeNull()
			})

			errorToast.mockRestore()
		})

		it('releases only AFTER the refusal has been reported and the selection withdrawn', async () => {
			// Ordering matters: reopening the affordance before the FM3 clear had run would leave it
			// pointed at the very snapshot the server had just contradicted.
			const { store, transaction, voucher } = seedForReconcile()
			frappePostCall.mockRejectedValue(makeAlreadyReconciledError(transaction.name))
			const errorToast = vi.spyOn(toast, 'error').mockReturnValue('toast-id')

			const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
			await act(async () => {
				await result.current.reconcileTransaction(transaction, voucher)
			})

			await waitFor(() => {
				expect(store.get(bankRecReconcileInFlightAtom)).toBeNull()
			})
			expect(store.get(bankRecErrorDialogAtom)).not.toBeNull()
			expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])

			errorToast.mockRestore()
		})
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

	/*
	 * The accepted path rebuilds the selection from the REFRESHED list rather than from the snapshot it
	 * posted against, and it does so only once that list has been re-read. Holding the invalidation
	 * open makes the ordering observable: until it resolves nothing has been written to the selection,
	 * and when it does the selection is replaced by what the server returned - here nothing, because a
	 * fully allocated transaction leaves the unreconciled list.
	 */
	it('rebuilds the selection only from the refreshed list, once it has converged', async () => {
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

		// The post has been accepted and the reviewer has already been told so - but the list has not
		// been re-read, so nothing has been written from it.
		expect(successToast).toHaveBeenCalledTimes(1)
		expect(result.current.loading).toBe(false)
		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([transaction])

		await act(async () => {
			refresh.resolve(undefined)
			await refresh.promise
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
	})

	it('raises no error dialog on the accepted path', async () => {
		const { store } = await confirmMatch()

		expect(store.get(bankRecErrorDialogAtom)).toBeNull()
	})
})
/*
 * A refused or lost post must leave the transaction unreconciled with its state unchanged, and must
 * not leave the action available against the snapshot the server has just contradicted.
 *
 * The first half is structural: the client never writes a reconciliation it has not read back, so
 * there is no optimistic write to roll back and no window in which a rolled-back write is
 * observable. The second half is the FAIL-CLOSED handling asserted below - the selection is emptied,
 * which withdraws the Reconcile affordance outright, and it is emptied WITHOUT WAITING to see whether
 * the follow-up revalidation succeeds.
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
	 * ⚠️ THE assertion FM1 reduces to. Nothing was patched, merged or re-flagged anywhere: the only
	 * write the rejection path makes to transaction state is to EMPTY the selection, and an emptied
	 * selection cannot claim a status.
	 */
	it('never writes a reconciled status anywhere, for any row', async () => {
		const { store, transaction } = await refuseConfirm()

		// The row object itself is untouched - the hook received it and did not mutate it.
		expect(transaction.status).toBe('Unreconciled')
		expect(transaction.unallocated_amount).toBe(TEST_TRANSACTION_AMOUNT)

		// And no row is left selected claiming otherwise.
		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
	})

	/*
	 * ⚠️ THE FAIL-CLOSED assertion, and the reason the selection is cleared rather than refreshed.
	 *
	 * The refused attempt was made against a snapshot the server has contradicted, so that snapshot
	 * may not be allowed to authorise a second attempt. Emptying the selection withdraws the
	 * Reconcile affordance outright, because the voucher panel is rendered only while a transaction is
	 * selected - and re-selecting can only come from the refreshed list.
	 */
	it('empties the selection, withdrawing the affordance the refusal invalidated', async () => {
		const { store } = await refuseConfirm()

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
	})

	/*
	 * ...and it does so EVEN WHEN THE REFRESH ITSELF FAILS. This is the case the guard exists for: the
	 * client has been told its snapshot is unreliable and cannot obtain a reliable one. A guard that
	 * waited for an authoritative read and released on failure would reopen the action in precisely
	 * the state where the client knows least.
	 */
	it('stays closed when the follow-up revalidation rejects', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockRejectedValue(makeAlreadyReconciledError(transaction.name))
		frappeSWRMutate.mockRejectedValue(new Error('revalidation unavailable'))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
		// The rejected revalidation is handled rather than left to become an unhandled rejection.
		expect(frappeSWRMutate).toHaveBeenCalledTimes(2)
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

	/*
	 * FM3's "refresh status" half. The two cached lists that between them display every `status` and
	 * `unallocated_amount` the reviewer sees are revalidated, with the EXACT key strings the query
	 * hooks construct - so re-selecting a row can only come from the server's current answer, and no
	 * sixth cache-key family is introduced.
	 */
	it('revalidates both cached transaction lists, on their existing keys', async () => {
		await refuseConfirm()

		expect(frappeSWRMutate.mock.calls).toEqual([
			[UNRECONCILED_KEY],
			[ALL_TRANSACTIONS_KEY]
		])
	})

	it('makes no imperative read of its own, because it asserts nothing about the row', async () => {
		await refuseConfirm()

		// The rejection path does not need to know the row's new state: it withdrew the action
		// regardless. Reading the document here would be inventing a second source of truth for a
		// guard that is already closed.
		expect(frappeContextValue.call.get).not.toHaveBeenCalled()
	})

	// The hook is instantiated during render, before a bank account has necessarily been chosen, so
	// the selection atom family has to tolerate an empty instance key rather than throwing.
	it('can be instantiated before any bank account has been selected', () => {
		const store = createStoreWithoutBank()

		expect(() => renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })).not.toThrow()
	})

	it('still reports the refusal when no bank account is selected', async () => {
		const store = createStoreWithoutBank()
		const transaction = makeUnreconciledTransaction()
		frappePostCall.mockRejectedValue(makeAlreadyReconciledError(transaction.name))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		expect(store.get(bankRecErrorDialogAtom)).not.toBeNull()
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
