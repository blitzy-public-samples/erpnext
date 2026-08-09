import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FrappeError } from 'frappe-react-sdk'
import { act, renderHook, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { createElement, type PropsWithChildren } from 'react'
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
	makeServerMessagesError,
	makeBankAccountListRow,
	makeBankTransaction,
	makeLinkedPayment,
	makeReconcileSuccessResponse,
	makeReconciledTransaction,
	makeRuleMatchedTransaction,
	makeSelectedBank,
	makeSuggestedLinkedPayment,
	makeUnreconciledTransaction
} from '@/test/factories'

// The module under test imports the SDK's hooks at module scope, so the package is replaced wholesale
// before it loads; the mock has to be in place for the import itself to succeed.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import {
	createTransactionSearchIndex,
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
	useTransactionSearch,
	useUpdateActionLog,
	type UnreconciledTransaction
} from './utils'
import {
	bankRecActionLog,
	bankRecAmountFilter,
	bankRecDateAtom,
	bankRecErrorDialogAtom,
	bankRecLastRefusalAtom,
	bankRecMatchFilters,
	bankRecSearchText,
	bankRecSelectedTransactionsAtom,
	bankRecTransactionTypeFilter,
	bankRecUnreconcileModalAtom,
	selectedBankAccountAtom,
	type ActionLog
} from './bankRecAtoms'
import { selectedCompanyAtom } from '@/hooks/useCurrentCompany'
import { canCancelDocument, canReadDocument, canWriteDocument } from '@/lib/permissions'



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

const SELECTED_TRANSACTION_ATOM = bankRecSelectedTransactionsAtom

/**
 * A store seeded with the state the reconcile seam reads. Seeding the dates explicitly is what makes
 * the key assertions exact rather than dependent on the calendar month the suite runs in.
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
 * The transport contract is asserted as LITERALS rather than rebuilt from the module's own helpers,
 * because recomputing a value with the expression under test proves only that it is deterministic. The
 * cache keys are a cross-module contract, and several of these queries switch revalidation off, so a
 * key that drifts by one character invalidates nothing while raising no error.
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

const answerGetCall = (method: string, data: unknown, error?: FrappeError): void => {
	frappeSDKMock.useFrappeGetCall.mockImplementation((calledMethod) =>
		calledMethod === method
			? { data, error, isLoading: false, isValidating: false, mutate: frappeHookMutate }
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

	/*
	 * A null SWR key is what SUPPRESSES the request, and for these two hooks that is load-bearing rather
	 * than tidy: `get_account_balance` takes `company` as a REQUIRED positional argument, so a call made
	 * without one is not an empty answer but an HTTP 500 `TypeError: ... missing 1 required positional
	 * argument: 'company'`, complete with a traceback. A bank account without a company is a reachable
	 * state - `selectedBankAccountAtom` reads storage on init, and for one render this atom did not.
	 */
	it.each([
		['the opening balance', useGetAccountOpeningBalance],
		['the closing balance', useGetAccountClosingBalance]
	])('withholds %s entirely while no company is known', (_label, useBalance) => {
		/*
		 * BOTH company sources have to be empty, which is exactly the state the defect needed:
		 * `useCurrentCompany` falls back to the signed-in user's default company, and the real account
		 * this was observed on - Administrator - simply has no default company set. The harness stubs one,
		 * so it is removed here and restored immediately afterwards.
		 */
		const defaults = (window.frappe.boot as { user: { defaults: Record<string, unknown> } }).user.defaults
		const stubbedCompany = defaults.company
		delete defaults.company

		try {
			const store = createStore()
			store.set(selectedBankAccountAtom, makeSelectedBank())
			store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })
			store.set(selectedCompanyAtom, '')

			renderHook(() => useBalance(), { wrapper: withStore(store) })

			const [, params, swrKey] = lastGetCallFor(GET_ACCOUNT_BALANCE)
			// The arguments still carry the bank account, so the request was genuinely assembled and only
			// the key held it back - which is what makes this a suppression rather than an accident.
			expect((params as { bank_account?: string }).bank_account).toBe(TEST_BANK_ACCOUNT)
			expect(swrKey).toBeNull()
		} finally {
			defaults.company = stubbedCompany
		}
	})

	it.each([
		['the opening balance', useGetAccountOpeningBalance],
		['the closing balance', useGetAccountClosingBalance]
	])('withholds %s entirely while no bank account is selected', (_label, useBalance) => {
		const store = createStoreWithoutBank()

		renderHook(() => useBalance(), { wrapper: withStore(store) })

		const [, , swrKey] = lastGetCallFor(GET_ACCOUNT_BALANCE)
		expect(swrKey).toBeNull()
	})

	it('reads the statement closing balance from the bank account, under its own distinct key', () => {
		const store = createSeededStore()

		renderHook(() => useGetAccountClosingBalanceAsPerStatement(), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(GET_CLOSING_BALANCE_AS_PER_STATEMENT)

		expect(method).toBe(GET_CLOSING_BALANCE_AS_PER_STATEMENT)
		expect(params).toEqual({ bank_account: TEST_BANK_ACCOUNT, date: TO_DATE })
		expect(swrKey).toBe(CLOSING_BALANCE_AS_PER_STATEMENT_KEY)
		expect(swrKey).not.toBe(CLOSING_BALANCE_KEY)
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
	})

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
	 * With both flags off the entry refreshes neither on focus nor on mount, so anything that changes
	 * bank transactions server-side has to mutate this key by name or the reviewer keeps looking at the
	 * previous answer.
	 */
	it('refreshes only when its key is mutated, never on focus and never merely because it is stale', () => {
		const store = createSeededStore()

		renderHook(() => useGetUnreconciledTransactions(), { wrapper: withStore(store) })

		const options = swrOptionsOf(lastGetCallFor(GET_BANK_TRANSACTIONS)[3])
		expect(options.revalidateOnFocus).toBe(false)
		expect(options.revalidateIfStale).toBe(false)
	})

	it('does not fetch unreconciled transactions at all when no bank account is selected', () => {
		const store = createStoreWithoutBank()

		renderHook(() => useGetUnreconciledTransactions(), { wrapper: withStore(store) })

		expect(lastGetCallFor(GET_BANK_TRANSACTIONS)[2]).toBeNull()
	})

	/*
	 * `all_transactions` bypasses the server's unallocated-amount filter for the separate
	 * Bank Transactions tab.
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
		expect(options).toBeUndefined()
	})

	it('does not fetch all transactions either when no bank account is selected', () => {
		const store = createStoreWithoutBank()

		renderHook(() => useGetBankTransactions(), { wrapper: withStore(store) })

		expect(lastGetCallFor(GET_BANK_TRANSACTIONS)[2]).toBeNull()
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
	useGetAccountOpeningBalance()
	useGetBankAccounts()
}

/*
 * The cache-key surface is CLOSED at five families. Each is checked individually above, but only a
 * census can catch a SIXTH being introduced, and these keys are shared with modules that spell them
 * inline and cannot follow a rename.
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

})

/*
 * `account_currency` is NOT a `Bank Account` field: the endpoint derives it per row by following
 * `Bank Account.account` to `Account.account_currency` in an unconditional loop after the query. So on
 * an ENDPOINT row the key is always PRESENT and its value NULLABLE - required-nullable, not optional -
 * and a null means "nothing to compare". The persisted selection is the shape where the key genuinely
 * can be absent.
 */
describe('useGetBankAccounts', () => {

	it('reads the company\'s accounts, unkeyed, and refreshes neither on focus nor when stale', () => {
		const store = createSeededStore()

		renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(BANK_ACCOUNT_GET_LIST)

		expect(method).toBe(BANK_ACCOUNT_GET_LIST)
		expect(params).toEqual({ company: TEST_COMPANY })
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
		expect(result.current.banks[0].name).toBe(TEST_BANK_ACCOUNT)
		expect(result.current.banks[0].bank).toBe(TEST_BANK)
		expect(result.current.banks[0].account_subtype).toBe('Current')
		expect(result.current.isLoading).toBe(false)
		expect(result.current.error).toBeUndefined()
	})

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

	it('leaves every logo field undefined when nothing matches', () => {
		const bank = logoFor('Zephyr Municipal Cooperative')

		expect(bank.logo).toBeUndefined()
		expect(bank.logoDark).toBeUndefined()
		expect(bank.darkModeInvert).toBeUndefined()
		expect(bank.logoClassName).toBeUndefined()
	})

	it('resolves nothing when the account names no bank', () => {
		expect(logoFor(undefined).logo).toBeUndefined()
		expect(logoFor('').logo).toBeUndefined()
	})
})



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

	it('confirms the reconciliation to the reviewer and offers to undo it', async () => {
		const { store, transaction } = await confirmMatch()

		expect(successToast).toHaveBeenCalledTimes(1)
		expect(successToast.mock.calls[0][0]).toBe('Reconciled')

		const undo = undoActionOf(successToast.mock.calls[0][1])
		expect(undo?.label).toBe('Undo')

		expect(store.get(bankRecUnreconcileModalAtom)).toBe('')
		act(() => {
			undo?.onClick()
		})
		expect(store.get(bankRecUnreconcileModalAtom)).toBe(transaction.name)
	})

	/*
	 * Holding the invalidation open makes the ordering observable: until it resolves nothing has been
	 * written to the selection, and when it does the selection is replaced by what the server returned -
	 * here nothing, because a fully allocated transaction leaves the unreconciled list.
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

	/*
	 * The action log is the one place the reconciled document is retained after the post, so it is where
	 * "the server's answer, not a locally assembled one" is observable. The allocation figures and the
	 * status are asserted to be the ones the RESPONSE carried rather than any value computed from the
	 * request, which is what makes the log an audit trail rather than a restatement of what was asked for.
	 */
	it("logs the server's own reconciled document, with its allocation figures untouched", async () => {
		const serverAnswer = makeReconcileSuccessResponse({ unallocated_amount: 2500 })
		const { store, voucher } = await confirmMatch(serverAnswer)

		const log = store.get(bankRecActionLog)
		expect(log).toHaveLength(1)
		expect(log[0]).toMatchObject({ type: 'match', isBulk: false })

		// The identical object the response carried, not a copy the client rebuilt.
		expect(log[0].items[0].bankTransaction).toBe(serverAnswer.message)
		expect(log[0].items[0].bankTransaction.allocated_amount).toBe(TEST_TRANSACTION_AMOUNT - 2500)
		expect(log[0].items[0].bankTransaction.unallocated_amount).toBe(2500)
		expect(log[0].items[0].bankTransaction.status).toBe('Unreconciled')

		// The voucher side comes from what the reviewer chose, which is the client's to supply.
		expect(log[0].items[0].voucher).toMatchObject({
			reference_doctype: voucher.doctype,
			reference_name: voucher.name
		})
	})
})
describe('a refused post leaves the client\'s state exactly as it was', () => {

	let consoleError: ReturnType<typeof vi.spyOn>
	let errorToast: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		errorToast = vi.spyOn(toast, 'error').mockReturnValue('toast-id')
		frappeSWRMutate.mockResolvedValue(undefined)
		// The convergence re-reads the all-transactions list imperatively (see the dedicated block
		// below), so this seam is configured for every test here: the imperative default REJECTS when
		// unconfigured, and the keyed `mutate` is a spy that never consumes the promise it is handed.
		frappeContextValue.call.get.mockResolvedValue({ message: [] })
	})

	afterEach(() => {
		consoleError.mockRestore()
		errorToast.mockRestore()
	})

	/**
	 * Drive one refused confirmation.
	 *
	 * `refreshedRows` is what the revalidated unreconciled query answers with, i.e. the server's current
	 * copy of the account. It defaults to a row whose amounts the server has moved on from, so the
	 * convergence assertions below are about the client adopting the server's answer rather than about
	 * it happening to keep what it already had.
	 */
	const refuseConfirm = async (
		{
			refusal,
			refreshedRows
		}: {
			refusal?: unknown
			refreshedRows?: UnreconciledTransaction[]
		} = {}
	) => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		const rejection = refusal ?? makeAlreadyReconciledError(transaction.name)
		frappePostCall.mockRejectedValue(rejection)

		const serverRows = refreshedRows ?? [
			makeUnreconciledTransaction({ unallocated_amount: TEST_TRANSACTION_AMOUNT / 2 })
		]
		frappeSWRMutate.mockImplementation((key) =>
			Promise.resolve(key === UNRECONCILED_KEY ? { message: serverRows } : undefined))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		return { store, transaction, refusal: rejection, serverRows }
	}

	it('never writes a reconciled status anywhere, for any row', async () => {
		const { store, transaction } = await refuseConfirm()

		expect(transaction.status).toBe('Unreconciled')
		expect(transaction.unallocated_amount).toBe(TEST_TRANSACTION_AMOUNT)

		// Whatever ends up selected came out of the server's answer, and the client wrote no status of
		// its own onto it.
		expect(store.get(SELECTED_TRANSACTION_ATOM)?.[0].status).toBe('Unreconciled')
	})

	/*
	 * The selected transaction lives in its own atom, so revalidating the lists is not by itself enough:
	 * every guard the reviewer sees - the already-reconciled check on Reconcile among them - is computed
	 * from that atom, and a copy left behind from before the refusal would keep those guards reading a
	 * row the server has already moved past.
	 */
	it('replaces the selection with the server\'s current copy of the row', async () => {
		const { store, serverRows } = await refuseConfirm()

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual(serverRows)
		expect(store.get(SELECTED_TRANSACTION_ATOM)?.[0].unallocated_amount)
			.toBe(TEST_TRANSACTION_AMOUNT / 2)
	})

	it('clears the selection when the server no longer reports the row as unreconciled', async () => {
		// A row that has been reconciled elsewhere drops out of `get_bank_transactions`, which filters on
		// `unallocated_amount > 0` - so its absence is the server saying it is no longer reconcilable.
		const { store } = await refuseConfirm({ refreshedRows: [] })

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
	})

	it('leaves the selection alone when the re-read itself fails', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockRejectedValue(makeAlreadyReconciledError(transaction.name))
		frappeSWRMutate.mockRejectedValue(new Error('offline'))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// No authoritative answer arrived, so guessing would be worse than showing what the reviewer last
		// saw beside the error the dialog is already reporting.
		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([transaction])
		// The rejected revalidations are contained: nothing escapes as an unhandled rejection, and the
		// follow-up toast is NOT raised, because `Promise.allSettled` absorbs them.
		expect(errorToast).toHaveBeenCalledTimes(1)
	})

	it('does not retry, so a refusal cannot become a duplicate posting', async () => {
		await refuseConfirm()

		expect(frappePostCall).toHaveBeenCalledTimes(1)
	})

	it('writes no action-log entry for work the server refused', async () => {
		const { store } = await refuseConfirm()

		expect(store.get(bankRecActionLog)).toEqual([])
	})

	it('surfaces the server\'s own refusal to the reviewer, verbatim', async () => {
		const { store, transaction, refusal } = await refuseConfirm()

		expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
		expect(errorToast).toHaveBeenCalledTimes(1)
		// The server answered, so the client is entitled to call it a refusal.
		expect(errorToast.mock.calls[0][0]).toBe('Reconciliation refused')
		expect(String((errorToast.mock.calls[0][1] as { description?: unknown } | undefined)?.description))
			.toContain(formatAlreadyReconciledMessage(transaction.name))
	})

	/*
	 * WHAT LEAVES THE APPLICATION ABOUT A REFUSAL, AND TO WHOM.
	 *
	 * These are three different audiences with three different entitlements: the dialog is for the
	 * reviewer and gets the server's words in full; the toast is a plain-text surface and gets the same
	 * words with only the markup it cannot render removed; the console is read by anyone who opens
	 * DevTools on a financial application and gets what identifies the failure and nothing that
	 * describes the server.
	 */
	describe('what it publishes about a refusal', () => {

		// Shortened but shaped exactly like the real thing: `frappe.throw` returns `exc` as a traceback
		// naming absolute paths inside both apps.
		const TRACEBACK = [
			'Traceback (most recent call last):',
			'  File "apps/frappe/frappe/app.py", line 114, in application',
			'  File "apps/erpnext/erpnext/accounts/doctype/bank_transaction/bank_transaction.py", line 161',
			'frappe.exceptions.ValidationError: Transaction currency mismatch'
		].join('\n')

		const CURRENCY_REFUSAL =
			'Transaction currency: <strong>USD</strong> cannot be different from Bank Account(<strong>QA Checking - QA Bank</strong>) currency: <strong>INR</strong>'

		const refuseWithTraceback = () => refuseConfirm({
			refusal: makeServerMessagesError(CURRENCY_REFUSAL, {
				exc: TRACEBACK,
				exc_type: 'ValidationError'
			})
		})

		it("keeps the server's traceback and filesystem paths out of the console", async () => {
			await refuseWithTraceback()

			expect(consoleError).toHaveBeenCalledTimes(1)
			const logged = JSON.stringify(consoleError.mock.calls[0][0])

			expect(logged).not.toContain('Traceback')
			expect(logged).not.toContain('apps/frappe')
			expect(logged).not.toContain('apps/erpnext')
			expect(logged).not.toContain('bank_transaction.py')
			expect(logged).not.toContain('frappe.exceptions')
		})

		it('still says enough to identify which call failed and why', async () => {
			await refuseWithTraceback()
			const logged = consoleError.mock.calls[0][0] as Record<string, unknown>

			expect(String(logged.scope)).toContain('reconcile_vouchers')
			expect(logged.httpStatus).toBe(417)
			expect(logged.exc_type).toBe('ValidationError')
			// The reviewer-facing messages, which the dialog is showing anyway.
			expect(JSON.stringify(logged.messages)).toContain('cannot be different')
			// The two fields that carried the disclosure are absent, not merely unused.
			expect(logged).not.toHaveProperty('exc')
			expect(logged).not.toHaveProperty('exception')
		})

		it('summarises a failure that never reached the server by name instead', async () => {
			await refuseConfirm({ refusal: new TypeError('Network request failed') })

			const logged = consoleError.mock.calls[0][0] as Record<string, unknown>

			expect(logged.name).toBe('TypeError')
			expect(logged.message).toBe('Network request failed')
			// Nothing to report about a response that never arrived.
			expect(logged).not.toHaveProperty('httpStatus')
		})

		/*
		 * The server's own messages carry inline HTML - `validate_currency` wraps all three of its values
		 * in `<strong>`. The dialog renders that as emphasis; a toast description is a plain string child,
		 * so the identical text arrived there with its tags visible as characters.
		 */
		it('renders the toast description as text, because a toast cannot render markup', async () => {
			await refuseWithTraceback()

			const description = String(
				(errorToast.mock.calls[0][1] as { description?: unknown } | undefined)?.description
			)

			expect(description).toContain(
				'Transaction currency: USD cannot be different from Bank Account(QA Checking - QA Bank) currency: INR'
			)
			expect(description).not.toContain('<strong>')
			expect(description).not.toContain('</strong>')
			expect(description).not.toMatch(/[<>]/)
		})

		it('coalesces a repeat refusal onto one toast instead of stacking an identical second', async () => {
			await refuseWithTraceback()
			await refuseWithTraceback()

			expect(errorToast).toHaveBeenCalledTimes(2)
			const first = (errorToast.mock.calls[0][1] as { id?: unknown } | undefined)?.id
			const second = (errorToast.mock.calls[1][1] as { id?: unknown } | undefined)?.id

			expect(first).toBe('bank-rec-reconcile-rejected')
			expect(second).toBe(first)
		})
	})

	/*
	 * The two cached lists that between them display every `status` and `unallocated_amount` the
	 * reviewer sees, plus the voucher list for the row under review, are revalidated with the EXACT key
	 * strings the query hooks construct - so re-selecting a row can only come from the server's current
	 * answer.
	 */
	it('revalidates every keyed read the workbench shows, on their existing keys', async () => {
		const { transaction } = await refuseConfirm()

		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([
			UNRECONCILED_KEY,
			ALL_TRANSACTIONS_KEY,
			vouchersKeyFor(transaction.name, DEFAULT_JOINED_MATCH_FILTERS),
			// The balance tiles too: a refreshed list beside figures computed before the server did
			// whatever it did is two answers disagreeing on one screen.
			CLOSING_BALANCE_KEY,
			CLOSING_BALANCE_AS_PER_STATEMENT_KEY
		])
	})

	/*
	 * Two reads are deliberately NOT revalidated, and both follow anyway. The opening balance is the
	 * balance BEFORE the range, which a reconciliation inside the range cannot move; and the reconciled
	 * count is derived from the unreconciled list, which is revalidated above. Neither has a cache key of
	 * its own, and inventing one would add a sixth key family that other modules do not spell.
	 */
	it('introduces no new cache-key family while converging', async () => {
		await refuseConfirm()

		frappeSWRMutate.mock.calls.forEach(([key]) => {
			expect(KEY_FAMILY_PREFIXES.some((prefix) => String(key).startsWith(prefix))).toBe(true)
		})
	})

	/*
	 * The dialog is modal and momentary. Dismissing it took the only explanation with it - and in the
	 * case this path exists for, convergence has just removed the row the reviewer was working on, so
	 * they were left looking at an empty pane with nothing saying why.
	 */
	it('keeps the refusal where dismissing the dialog cannot reach it', async () => {
		const { store, transaction, refusal } = await refuseConfirm()

		const kept = store.get(bankRecLastRefusalAtom)
		// The identical rejection object, so the banner can re-render the server's own words.
		expect(kept?.error).toBe(refusal)
		expect(kept?.transactionName).toBe(transaction.name)
		// The server answered, so the client may state that nothing was posted.
		expect(kept?.refused).toBe(true)

		// Closing the dialog is exactly what must NOT take the explanation with it.
		store.set(bankRecErrorDialogAtom, null)
		expect(store.get(bankRecLastRefusalAtom)?.error).toBe(refusal)
	})

	it('marks an unanswered request as an unknown outcome rather than a refusal', async () => {
		const { store } = await refuseConfirm({ refusal: new Error('Network request failed') })

		expect(store.get(bankRecLastRefusalAtom)?.refused).toBe(false)
	})

	it('clears the previous explanation when another attempt begins', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockRejectedValue(makeAlreadyReconciledError(transaction.name))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})
		expect(store.get(bankRecLastRefusalAtom)).not.toBeNull()

		// An attempt that never resolves: the explanation must go at the START of the attempt, or an
		// in-flight one sits beneath the reason the LAST attempt failed.
		frappePostCall.mockReturnValue(new Promise(() => undefined))
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		expect(store.get(bankRecLastRefusalAtom)).toBeNull()
	})

	/*
	 * The all-transactions list is the one cache that CANNOT be corrected by asking SWR to revalidate.
	 * SWR revalidates a key through the revalidators its mounted subscribers registered, and that list
	 * is rendered only by the "Bank Transactions" tab - unmounted whenever a reconciliation is being
	 * confirmed - so a bare `mutate(key)` returns the stale entry and never reaches the network. It is
	 * therefore re-read imperatively, through the SAME endpoint, arguments and cache key the query hook
	 * uses, which is what makes the correction independent of which tab happens to be open.
	 *
	 * This supersedes an earlier expectation that the hook makes NO imperative read of its own. That
	 * expectation described a deliberate design - the hook asserts nothing about the row and lets SWR
	 * answer - but it was measured to leave the "Bank Transactions" tab showing a pre-attempt copy of a
	 * row the server had already moved on from, which is the defect this read exists to close.
	 */
	it('re-reads the all-transactions list imperatively, because SWR alone would not', async () => {
		await refuseConfirm()

		expect(frappeContextValue.call.get).toHaveBeenCalledTimes(1)
		expect(frappeContextValue.call.get).toHaveBeenCalledWith(GET_BANK_TRANSACTIONS, {
			bank_account: TEST_BANK_ACCOUNT,
			from_date: FROM_DATE,
			to_date: TO_DATE,
			all_transactions: true
		})
	})

	it('writes that answer onto the all-transactions key itself, without revalidating it again', async () => {
		const refreshed = { message: [makeReconciledTransaction()] }
		frappeContextValue.call.get.mockResolvedValue(refreshed)

		await refuseConfirm()

		const write = frappeSWRMutate.mock.calls.find(([key]) => key === ALL_TRANSACTIONS_KEY)
		expect(write).toBeDefined()
		// The answer is handed to SWR as the new value for that key, so a tab mounting later reads the
		// server's current copy rather than the pre-attempt one.
		await expect(write?.[1]).resolves.toBe(refreshed)
		// `revalidate: false`, so the imperative read is the ONLY request for this key - a mounted
		// subscriber does not turn the correction into two round trips.
		expect(write?.[2]).toEqual({ revalidate: false })
	})

	it('issues no imperative read when no bank account is selected, because that list is not keyed', async () => {
		const store = createStoreWithoutBank()
		const transaction = makeUnreconciledTransaction()
		frappePostCall.mockRejectedValue(makeAlreadyReconciledError(transaction.name))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		expect(frappeContextValue.call.get).not.toHaveBeenCalled()
	})

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
 * A rejection is not automatically proof that nothing was posted. The SDK builds its rejection from
 * `error.response.data` and stamps `httpStatus` onto it, so a numeric `httpStatus` means the server
 * answered and - because `frappe.throw` rolls the request back - that answer was a refusal. With no
 * response there is nothing to stamp: the SDK's own property access throws first, so the rejection
 * arrives as a plain `Error`. Such a request may have been applied and its response lost, and the
 * client must not claim otherwise.
 */
describe('a post whose outcome the server never reported is not called a refusal', () => {

	let consoleError: ReturnType<typeof vi.spyOn>
	let errorToast: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		errorToast = vi.spyOn(toast, 'error').mockReturnValue('toast-id')
		frappeSWRMutate.mockResolvedValue(undefined)
		frappeContextValue.call.get.mockResolvedValue({ message: [] })
	})

	afterEach(() => {
		consoleError.mockRestore()
		errorToast.mockRestore()
	})

	const attemptWithLostResponse = async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		// Exactly what the SDK leaves behind when there is no response to read: an ordinary Error, with
		// no `httpStatus`, no `_server_messages` and no `exception`.
		const lostResponse = new TypeError("Cannot read properties of undefined (reading 'data')")
		frappePostCall.mockRejectedValue(lostResponse)

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		return { store, transaction, lostResponse }
	}

	it('reports the outcome as unknown rather than as a refusal', async () => {
		await attemptWithLostResponse()

		expect(errorToast).toHaveBeenCalledTimes(1)
		expect(errorToast.mock.calls[0][0]).toBe('Could not confirm the reconciliation')
		const description = String(
			(errorToast.mock.calls[0][1] as { description?: unknown } | undefined)?.description
		)
		expect(description).toContain('not yet known')
		// The two claims a client cannot support without a server answer.
		expect(description).not.toContain('refused')
		expect(description).not.toContain('was not recorded')
	})

	it('still routes the rejection to the shared dialog, by identity', async () => {
		const { store, lostResponse } = await attemptWithLostResponse()

		expect(store.get(bankRecErrorDialogAtom)).toBe(lostResponse)
	})

	it('re-reads the server, because only the server can settle the outcome', async () => {
		const { transaction } = await attemptWithLostResponse()

		// The same convergence as a refusal, balance tiles included: the outcome is unknown, so
		// everything this account displays has to come from a fresh read rather than from before.
		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([
			UNRECONCILED_KEY,
			ALL_TRANSACTIONS_KEY,
			vouchersKeyFor(transaction.name, DEFAULT_JOINED_MATCH_FILTERS),
			CLOSING_BALANCE_KEY,
			CLOSING_BALANCE_AS_PER_STATEMENT_KEY
		])
	})

	it('does not retry an attempt whose outcome is unknown', async () => {
		await attemptWithLostResponse()

		expect(frappePostCall).toHaveBeenCalledTimes(1)
	})

	it('writes no action-log entry for an attempt it cannot vouch for', async () => {
		const { store } = await attemptWithLostResponse()

		expect(store.get(bankRecActionLog)).toEqual([])
	})
})

/*
 * A `catch` chained after the success handler also catches whatever that handler throws. Reporting
 * such a failure as a backend refusal would tell the reviewer that a reconciliation the server had
 * already committed was rejected, which is the opposite of the truth.
 */
describe('a failure after a successful post is not attributed to the server', () => {

	let consoleError: ReturnType<typeof vi.spyOn>
	let errorToast: ReturnType<typeof vi.spyOn>
	let successToast: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		errorToast = vi.spyOn(toast, 'error').mockReturnValue('toast-id')
		successToast = vi.spyOn(toast, 'success').mockImplementation(() => {
			throw new Error('the view could not be updated')
		})
	})

	afterEach(() => {
		consoleError.mockRestore()
		errorToast.mockRestore()
		successToast.mockRestore()
	})

	const succeedThenFailLocally = async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())
		frappeSWRMutate.mockResolvedValue({ message: [] })

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		return { store }
	}

	it('reports a refresh failure and never calls it a refusal', async () => {
		await succeedThenFailLocally()

		expect(errorToast).toHaveBeenCalledTimes(1)
		expect(errorToast.mock.calls[0][0]).toBe('The view could not be refreshed')
		expect(errorToast.mock.calls[0][0]).not.toBe('Reconciliation refused')
	})

	it('does not open the error dialog, because the server said nothing', async () => {
		const { store } = await succeedThenFailLocally()

		expect(store.get(bankRecErrorDialogAtom)).toBeNull()
	})

	it('does not re-post, so a local failure cannot become a duplicate posting', async () => {
		await succeedThenFailLocally()

		expect(frappePostCall).toHaveBeenCalledTimes(1)
	})
})


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

	it('classifies a transaction with neither column as neither, and its amount as zero', () => {
		const { result } = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: undefined, deposit: undefined })))

		expect(result.current.isWithdrawal).toBe(false)
		expect(result.current.isDeposit).toBe(false)
		expect(result.current.direction).toBe('none')
		// Zero rather than undefined: the caller has to be able to SHOW this amount, and a row with no
		// amount in either column has an amount of zero. Reported as absent, it rendered as nothing at
		// all - or, guarded on, as a bare `0`.
		expect(result.current.amount).toBe(0)
	})

	it('treats a zero as an empty column rather than as an amount', () => {
		const { result } = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: 0, deposit: 0 })))

		expect(result.current.isWithdrawal).toBe(false)
		expect(result.current.isDeposit).toBe(false)
		expect(result.current.direction).toBe('none')
		expect(result.current.amount).toBe(0)
	})

	it('names the direction of a debit and of a credit', () => {
		const debit = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: 750, deposit: 0 })))
		expect(debit.result.current.direction).toBe('withdrawal')

		const credit = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: 0, deposit: 1250 })))
		expect(credit.result.current.direction).toBe('deposit')
	})

	it('reports genuine booleans, not the numbers a truthiness test leaves behind', () => {
		const { result } = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: 0, deposit: 1250 })))

		// `transaction.withdrawal && transaction.withdrawal > 0` evaluated to the NUMBER 0 here, which a
		// caller rendering the flag put on screen as a bare `0`.
		expect(typeof result.current.isWithdrawal).toBe('boolean')
		expect(typeof result.current.isDeposit).toBe('boolean')
	})
})

describe('useGetRuleForTransaction', () => {

	it('reads the rule a stamped transaction names', () => {
		renderHook(() => useGetRuleForTransaction(makeRuleMatchedTransaction()))

		const [doctype, name, swrKey, options] = lastGetDocCall()

		expect(doctype).toBe('Bank Transaction Rule')
		expect(name).toBe(TEST_TRANSACTION_RULE)
		expect(swrKey).toBeUndefined()
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
		expect(swrOptionsOf(options).revalidateIfStale).toBe(false)
	})

	it('withholds the request entirely while no company is known', () => {
		/*
		 * `company` is a REQUIRED positional argument of `bank_account.get_list`, so asking without one
		 * does not answer an empty list - it answers an unhandled HTTP 500 reading `get_list() missing 1
		 * required positional argument: 'company'`, which every consumer of this hook renders as a raw
		 * server traceback. A null key is how the request is withheld until there is a company to ask
		 * about, and both of `useCurrentCompany`'s sources have to be emptied to reach that state: the
		 * persisted selection, and the signed-in user's own default company.
		 */
		const store = createStore()
		store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })
		store.set(selectedCompanyAtom, '')

		const bootDefaults = window.frappe!.boot!.user!.defaults as Record<string, unknown>
		const previousDefaultCompany = bootDefaults.company
		bootDefaults.company = ''

		try {
			const { result } = renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

			const [, , swrKey] = lastGetCallFor(BANK_ACCOUNT_GET_LIST)
			expect(swrKey).toBeNull()

			// And the caller is handed an ordinary empty result rather than an error to render.
			expect(result.current.banks).toEqual([])
			expect(result.current.error).toBeUndefined()
		} finally {
			bootDefaults.company = previousDefaultCompany
		}
	})

	it('does not read anything for a transaction no rule matched', () => {
		renderHook(() => useGetRuleForTransaction(makeUnreconciledTransaction()))

		const [doctype, name, swrKey] = lastGetDocCall()

		expect(doctype).toBe('Bank Transaction Rule')
		expect(name).toBeUndefined()
		expect(swrKey).toBeNull()
	})
})

describe('useTransactionSearch', () => {

	it('holds a keystroke back, then publishes it to the shared search atom', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useTransactionSearch(), { wrapper: withStore(store) })

		expect(result.current[0]).toBe('')

		act(() => {
			result.current[1]('acme')
		})
		expect(store.get(bankRecSearchText)).toBe('')

		act(() => {
			result.current[1].flush()
		})
		expect(store.get(bankRecSearchText)).toBe('acme')
	})

	it('reports the shared atom\'s current value', () => {
		const store = createSeededStore()
		store.set(bankRecSearchText, TEST_TRANSACTION_DESCRIPTION)

		const { result } = renderHook(() => useTransactionSearch(), { wrapper: withStore(store) })

		expect(result.current[0]).toBe(TEST_TRANSACTION_DESCRIPTION)
	})

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

	/*
	 * Built through the SAME factory the workbench uses, so the search this asserts on is the search
	 * that ships. It used to be a hand-written Fuse index that happened to repeat the production
	 * options, which meant a change to how the app searches could not fail a single test here.
	 */
	const searchIndex = () => createTransactionSearchIndex(rows)

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

	/*
	 * The precision half of the search contract, and the reason the threshold was tightened.
	 *
	 * A reference that appears nowhere in the data used to be answered with a long list of approximate
	 * rows - measured against the real workbench, 36 of them for a six-character query with zero literal
	 * matches - and a reviewer has no way to tell an approximation from a match. On a screen where the
	 * next click posts money against whichever row was believed, that is the whole of the risk.
	 */
	it('answers a reference that is in none of the rows with nothing', () => {
		expect(getSearchResults(searchIndex(), 'FQA-P7', 'All', 0, rows)).toEqual([])
	})

	it('still finds a reference that was mistyped by a character', () => {
		expect(names(getSearchResults(searchIndex(), 'ATM-9002', 'All', 0, rows))).toContain(debit.name)
	})

	/*
	 * Descriptions are long and the identifying part of one is rarely at the front. Fuse penalises a
	 * match by its distance from the start of the field unless told not to, so before `ignoreLocation`
	 * a term at the end of a description scored badly - which is exactly what made the threshold look
	 * like it had to be loose.
	 */
	it('matches a term at the END of a long description, not only the beginning', () => {
		expect(names(getSearchResults(searchIndex(), 'Bengaluru', 'All', 0, rows))).toContain(debit.name)
	})

	it('ignores a fragment too short to identify anything', () => {
		expect(getSearchResults(searchIndex(), 'AT', 'All', 0, rows)).toEqual([])
	})

	it('keeps only debits under the Debits filter', () => {
		expect(names(getSearchResults(null, '', 'Debits', 0, rows))).toEqual([debit.name])
	})

	it('keeps only credits under the Credits filter', () => {
		expect(names(getSearchResults(null, '', 'Credits', 0, rows))).toEqual([credit.name])
	})

	it('narrows to nothing under a filter it does not recognise', () => {
		expect(getSearchResults(null, '', 'Something Else', 0, rows)).toEqual([])
	})

	it('matches an exact amount in the withdrawal column', () => {
		expect(names(getSearchResults(null, '', 'All', 500, rows))).toEqual([debit.name])
	})

	it('matches an exact amount in the deposit column', () => {
		expect(names(getSearchResults(null, '', 'All', 750, rows))).toEqual([credit.name])
	})

	it('does not match an amount that merely differs', () => {
		expect(getSearchResults(null, '', 'All', 501, rows)).toEqual([])
	})

	it('drops a row with no value in either column when an amount filter is set', () => {
		expect(names(getSearchResults(null, '', 'All', 500, rows))).not.toContain(valueless.name)
	})

	it('applies the direction and amount filters together', () => {
		expect(getSearchResults(null, '', 'Credits', 500, rows)).toEqual([])
		expect(names(getSearchResults(null, '', 'Debits', 500, rows))).toEqual([debit.name])
	})

	it('treats a zero amount filter as no amount filter', () => {
		expect(names(getSearchResults(null, '', 'All', 0, rows))).toEqual(names(rows))
	})
})

/*
 * The session action log is prepended (newest first, matching how it is displayed) and capped, because
 * an unbounded log in session storage grows for as long as the tab lives.
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

/*
 * This hook layer applies no client-side permission check, and that is correct: the endpoints are
 * authorised by the SERVER, and a client that pre-judged a permission would be adding a convenience
 * rather than a control. The SDK is mocked here, so a refusal is something these tests INSTALL rather
 * than discover; proving that the server refuses is the Python suites' job.
 *
 * What is provable is that a refusal under a NARROWED profile is handled exactly as any other refusal:
 * fail-closed, with the server's own words, and with nothing mutated.
 */
describe('a refusal under a narrowed role profile is handled exactly like any other refusal', () => {

	const seedForReconcile = () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(bankRecSelectedTransactionsAtom, [transaction])
		return { store, transaction, voucher: makeSuggestedLinkedPayment(transaction) }
	}

	const narrowProfileTo = (rights: Partial<Record<'can_read' | 'can_write' | 'can_cancel', string[]>>) => {
		Object.assign(window.frappe.boot.user, rights)
	}

	/**
	 * Those arrays are shared, mutable state reachable through a global, so this block restores what
	 * it narrowed instead of relying on the harness to rebuild the profile. The snapshot is taken per
	 * test and the captured arrays are put back by identity, which keeps a narrowing local to the
	 * test that applied it.
	 */
	const NARROWED_RIGHTS = ['can_read', 'can_write', 'can_cancel'] as const
	let installedRights: Partial<Record<(typeof NARROWED_RIGHTS)[number], string[]>> = {}

	/*
	 * The toast spy is installed and restored by the hooks rather than at the end of each test body: a
	 * failing assertion aborts the body, so a trailing `mockRestore()` would leave a live spy on the
	 * shared `toast` module for every test that follows.
	 */
	let errorToast: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		installedRights = {}
		NARROWED_RIGHTS.forEach((right) => {
			installedRights[right] = window.frappe.boot.user[right]
		})
		errorToast = vi.spyOn(toast, 'error').mockReturnValue('toast-id')
		frappeSWRMutate.mockResolvedValue({ message: [] })
		frappeContextValue.call.get.mockResolvedValue({ message: [] })
	})

	afterEach(() => {
		Object.assign(window.frappe.boot.user, installedRights)
		errorToast.mockRestore()
	})

	const ACCOUNTS_ONLY = {
		can_read: ['Bank Transaction', 'Bank Account', 'Payment Entry'],
		can_write: ['Bank Transaction', 'Bank Account', 'Payment Entry'],
		can_cancel: ['Payment Entry']
	}

	it('reads a narrowed profile straight off boot.user, so a denial is genuinely a denial', () => {
		narrowProfileTo(ACCOUNTS_ONLY)

		expect(canReadDocument('Bank Transaction')).toBe(true)
		expect(canWriteDocument('Bank Transaction')).toBe(true)
		expect(canCancelDocument('Bank Transaction')).toBe(false)
	})

	it('surfaces a PERMISSION refusal in the server\'s own words, changing nothing else', async () => {
		narrowProfileTo(ACCOUNTS_ONLY)

		const refusal = makeServerMessagesError('Insufficient Permission for Bank Transaction')
		const { store, transaction, voucher } = seedForReconcile()
		frappePostCall.mockRejectedValue(refusal)

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			await result.current.reconcileTransaction(transaction, voucher)
		})

		await waitFor(() => {
			expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
		})
		expect(errorToast.mock.calls[0][1]?.description).toContain('Insufficient Permission')

		// A permission refusal converges like any other: the re-read reports the row as no longer
		// reconcilable by this user, so the stale selection is dropped rather than kept.
		expect(store.get(bankRecSelectedTransactionsAtom)).toEqual([])
		expect(store.get(bankRecActionLog)).toEqual([])
	})

	it('does not retry a refused post, whatever the reason for the refusal', async () => {
		narrowProfileTo(ACCOUNTS_ONLY)

		const { store, transaction, voucher } = seedForReconcile()
		frappePostCall.mockRejectedValue(makeServerMessagesError('Insufficient Permission for Bank Transaction'))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			await result.current.reconcileTransaction(transaction, voucher)
		})

		expect(frappePostCall).toHaveBeenCalledTimes(1)
		await waitFor(() => {
			expect(store.get(bankRecErrorDialogAtom)).not.toBeNull()
		})
	})

	it('holds no role at all and still reports a refusal rather than swallowing it', async () => {
		narrowProfileTo({ can_read: [], can_write: [], can_cancel: [] })

		const refusal = makeServerMessagesError('Not permitted')
		const { store, transaction, voucher } = seedForReconcile()
		frappePostCall.mockRejectedValue(refusal)

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			await result.current.reconcileTransaction(transaction, voucher)
		})

		await waitFor(() => {
			expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
		})
	})
})
