import { ActionLog, bankRecActionLog, bankRecAmountFilter, bankRecDateAtom, bankRecErrorDialogAtom, bankRecMatchFilters, bankRecReconcileSettlingAtom, bankRecSearchText, bankRecSelectedTransactionAtom, bankRecTransactionTypeFilter, bankRecUnreconcileModalAtom, SelectedBank, selectedBankAccountAtom } from './bankRecAtoms'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useContext, useMemo } from 'react'
import { FrappeContext, FrappeError, SWRConfiguration, useFrappeGetCall, useFrappeGetDoc, useFrappePostCall, useSWRConfig, type FrappeConfig } from 'frappe-react-sdk'
import { BankTransaction } from '@/types/Accounts/BankTransaction'
import { BankAccount } from '@/types/Accounts/BankAccount'
import dayjs from 'dayjs'
import { toast } from 'sonner'
import { BANK_LOGOS } from './logos'
import { getErrorMessage } from '@/lib/frappe'
import { useCurrentCompany } from '@/hooks/useCurrentCompany'
import _ from '@/lib/translate'
import { BankTransactionRule } from '@/types/Accounts/BankTransactionRule'
import { useRef } from 'react'
import type { DebouncedState } from 'usehooks-ts'
import { useDebounceCallback } from 'usehooks-ts'
import Fuse from 'fuse.js'

/**
 * Narrows an `unknown` rejection reason to "this came back from Frappe". A promise can reject
 * with anything at all, so the reason is narrowed before any envelope field is dereferenced.
 * Membership is tested with `in`, so nothing is copied, rewritten or coerced: a genuine
 * envelope is recognised and then used exactly as the server sent it.
 */
export const isFrappeErrorEnvelope = (reason: unknown): reason is FrappeError =>
    typeof reason === 'object' && reason !== null &&
    ('_server_messages' in reason || '_error_message' in reason || 'exception' in reason || 'httpStatus' in reason)

/**
 * The single layer every surface displaying a rejected call resolves through, so the dismissible
 * dialog and the transient toast can never disagree. A server envelope is returned BY IDENTITY -
 * not cloned, reshaped or stripped - which keeps the server's own text and severity reaching the
 * user verbatim. A substitute is produced only when the rejection carries no envelope at all,
 * which happens when no usable RESPONSE came back: `frappe-js-sdk` reads `error.response.data`
 * without a guard, so its own `TypeError` becomes the rejection value, and there is no server
 * text to preserve in that case.
 *
 * The substitute copy is deliberately OUTCOME-INDETERMINATE. A missing response proves only that
 * the client never learned the answer - it does NOT prove the server never received or never
 * applied the request. A request can be delivered, committed and acknowledged into a connection
 * that has already gone away (timeout, reset, proxy hang-up, tab suspension), so any wording
 * along the lines of "nothing was posted" would be the client asserting a server-side fact it
 * cannot observe. For a financial post that assertion is the dangerous direction to be wrong in:
 * a reviewer told nothing happened will confidently repeat the action. The copy therefore reports
 * exactly what is known - no response arrived - names the outcome as unknown, and directs the
 * reviewer to the server's own record instead of inviting a blind retry. FM1's rule that the
 * backend response is the sole source of truth cuts both ways: with no response there is no
 * truth to report, only a state to go and read.
 *
 * Pure and idempotent: nothing here retries, refetches, mutates application state or
 * truncates server text, and resolving an already-resolved error returns the same value. It makes
 * no claim about what any caller does next, so every caller can safely reuse it.
 */
export const toDisplayError = (reason: unknown): FrappeError => isFrappeErrorEnvelope(reason) ? reason : {
    httpStatus: 0,
    httpStatusText: 'Network Error',
    message: _('No response arrived from the server, so it is not known whether this request was recorded. Check the current state of the affected records before repeating the action.'),
    exception: ''
}

export const useGetAccountOpeningBalance = () => {

    const companyID = useCurrentCompany()
    const bankAccount = useAtomValue(selectedBankAccountAtom)

    const dates = useAtomValue(bankRecDateAtom)

    const args = useMemo(() => {

        return {
            bank_account: bankAccount?.name,
            company: companyID,
            till_date: dayjs(dates.fromDate).subtract(1, 'days').format('YYYY-MM-DD'),
        }

    }, [companyID, bankAccount?.name, dates.fromDate])

    return useFrappeGetCall('erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_account_balance', args, undefined, {
        revalidateOnFocus: false
    })
}

/**
 * Builders for the SWR cache keys of the bank-reconciliation queries.
 *
 * WHY THESE EXIST. Several of these queries deliberately disable `revalidateIfStale` and
 * `revalidateOnFocus`, which means a cache entry does NOT refresh itself just because something
 * elsewhere changed the underlying data - it refreshes only when somebody mutates that exact key.
 * Writers therefore have to reproduce the key EXACTLY, and a key that differs by a single
 * character silently invalidates nothing at all: the call succeeds, no error is raised, and the
 * stale list simply stays on screen. That failure is invisible at both compile time and run time,
 * which is precisely why the strings are built in one place and asserted against literals in the
 * test suite rather than retyped at each call site.
 *
 * The produced strings are BYTE-IDENTICAL to the literals these queries have always used - that
 * is a hard compatibility requirement, not a nicety, because the same keys are also written by
 * surfaces outside this module (the action log, the balance panel, the unreconcile modal and the
 * clearance summary) which continue to spell them inline. A change to the format here would
 * silently orphan those writers, so the format must not be "improved".
 */
export const bankRecClosingBalanceKey = (bankAccountName: string | undefined, toDate: string): string =>
    `bank-reconciliation-account-closing-balance-${bankAccountName}-${toDate}`

export const bankRecClosingBalanceAsPerStatementKey = (bankAccountName: string | undefined, toDate: string): string =>
    `bank-reconciliation-account-closing-balance-as-per-statement-${bankAccountName}-${toDate}`

export const bankRecUnreconciledTransactionsKey = (bankAccountName: string | undefined, fromDate: string, toDate: string): string =>
    `bank-reconciliation-unreconciled-transactions-${bankAccountName}-${fromDate}-${toDate}`

export const bankRecBankTransactionsKey = (bankAccountName: string | undefined, fromDate: string, toDate: string): string =>
    `bank-reconciliation-bank-transactions-${bankAccountName}-${fromDate}-${toDate}`

export const useGetAccountClosingBalance = () => {

    const companyID = useCurrentCompany()
    const bankAccount = useAtomValue(selectedBankAccountAtom)

    const dates = useAtomValue(bankRecDateAtom)

    const args = useMemo(() => {

        return {
            bank_account: bankAccount?.name,
            company: companyID,
            till_date: dates.toDate,
        }

    }, [companyID, bankAccount?.name, dates.toDate])

    return useFrappeGetCall('erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_account_balance', args,
        bankRecClosingBalanceKey(bankAccount?.name, dates.toDate),
        {
            revalidateOnFocus: false
        }
    )

}

/**
 * Hook to fetch the closing balance set in the database for the given bank and date
 */
export const useGetAccountClosingBalanceAsPerStatement = (swrConfig: SWRConfiguration = {}) => {

    const dates = useAtomValue(bankRecDateAtom)
    const bankAccount = useAtomValue(selectedBankAccountAtom)

    return useFrappeGetCall<{ message: { balance: number, date?: string } }>("erpnext.accounts.doctype.bank_account.bank_account.get_closing_balance_as_per_statement", {
        bank_account: bankAccount?.name,
        date: dates.toDate
    }, bankRecClosingBalanceAsPerStatementKey(bankAccount?.name, dates.toDate), {
        revalidateOnFocus: false,
        ...swrConfig
    })
}

export type UnreconciledTransaction = Pick<BankTransaction, 'name' | 'matched_transaction_rule' | 'date' | 'withdrawal' | 'deposit' | 'currency' | 'description' | 'status' | 'transaction_type' | 'reference_number' | 'party_type' | 'party' | 'bank_account' | 'company' | 'unallocated_amount'>

/**
 * The endpoint both transaction lists are served by - once filtered to the unreconciled rows and
 * once with `all_transactions` - and the same one the post-rejection authoritative read calls
 * imperatively.
 *
 * Named once because those three callers MUST agree: the imperative read exists precisely to obtain
 * the rows the cached lists may no longer be telling the truth about, so a read pointed at a
 * different endpoint - or at a misspelt one - would answer a different question while looking
 * correct.
 */
const GET_BANK_TRANSACTIONS_METHOD =
    'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions'

export const useGetUnreconciledTransactions = () => {
    const bankAccount = useAtomValue(selectedBankAccountAtom)
    const dates = useAtomValue(bankRecDateAtom)
    return useFrappeGetCall<{ message: UnreconciledTransaction[] }>(GET_BANK_TRANSACTIONS_METHOD, {
        bank_account: bankAccount?.name,
        from_date: dates.fromDate,
        to_date: dates.toDate
    }, bankAccount ? bankRecUnreconciledTransactionsKey(bankAccount?.name, dates.fromDate, dates.toDate) : null, {
        // NOTE: with both of these disabled this entry only ever refreshes when a writer mutates
        // this exact key. Anything that changes bank transactions server-side - reconciling, and
        // importing a statement - must therefore invalidate it explicitly, which is what
        // `useRefreshImportedTransactions` and the reconcile rejection path below exist to do.
        revalidateOnFocus: false,
        revalidateIfStale: false
    })
}

export interface LinkedPayment {
    rank: number,
    doctype: string,
    name: string,
    paid_amount: number,
    /**
     * NOT always a usable string, which is why this is `string | null` rather than `string`.
     * `get_linked_payments` unions four voucher types and each supplies this column
     * differently: Payment Entry selects the real `reference_no`; Purchase Invoice selects
     * `ConstantColumn("")`, so it is ALWAYS the empty string; Sales Invoice selects
     * `sip.reference_no`, which is nullable; and Journal Entry selects
     * `Max(je.cheque_no)`, which is NULL whenever no row in the group carries a cheque
     * number. The key is always present - it is in the projection - so this is nullable
     * rather than optional.
     */
    reference_no: string | null,
    /**
     * Same story: Payment Entry supplies a real date, both invoice branches supply
     * `ConstantColumn("")`, and the Journal Entry branch can yield NULL.
     */
    reference_date: string | null,
    posting_date: string,
    party_type?: string,
    party?: string,
    currency: string
}

/*
 * NOTE - there are deliberately no reference/date GRADING helpers here.
 *
 * The suggested-match scoring is a FROZEN behaviour that lives inline in `MatchAndReconcile`'s
 * `VoucherItem`, and exported graders beside the type above are how it came to be rewritten once
 * already. The projection quirks they existed to absorb are documented on `LinkedPayment` instead,
 * where every consumer sees them, and the nullable typing forces each one to decide what a missing
 * reference means at its own call site rather than inheriting a decision made here.
 */

export const useGetBankTransactions = () => {
    const bankAccount = useAtomValue(selectedBankAccountAtom)
    const dates = useAtomValue(bankRecDateAtom)
    return useFrappeGetCall<{ message: BankTransaction[] }>(GET_BANK_TRANSACTIONS_METHOD, {
        bank_account: bankAccount?.name,
        from_date: dates.fromDate,
        to_date: dates.toDate,
        all_transactions: true
    }, bankAccount ? bankRecBankTransactionsKey(bankAccount?.name, dates.fromDate, dates.toDate) : null)
}


export const useGetVouchersForTransaction = (transaction: UnreconciledTransaction) => {

    const dates = useAtomValue(bankRecDateAtom)

    const matchFilters = useAtomValue(bankRecMatchFilters)

    return useFrappeGetCall<{ message: LinkedPayment[] }>('erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_linked_payments', {
        bank_transaction_name: transaction.name,
        document_types: matchFilters ?? ['payment_entry', 'journal_entry'],
        from_date: dates.fromDate,
        to_date: dates.toDate,
        filter_by_reference_date: 0
    }, `bank-reconciliation-vouchers-${transaction.name}-${dates.fromDate}-${dates.toDate}-${matchFilters.join(',')}`, {
        revalidateOnFocus: false
    })
}

/**
 * Common hook to refresh the unreconciled transactions list after a transaction is reconciled
 * @returns function to call to refresh the unreconciled transactions list AFTER the operation is done
 */
export const useRefreshUnreconciledTransactions = () => {

    const selectedBank = useAtomValue(selectedBankAccountAtom)
    const dates = useAtomValue(bankRecDateAtom)
    const matchFilters = useAtomValue(bankRecMatchFilters)
    const setSelectedTransaction = useSetAtom(bankRecSelectedTransactionAtom(selectedBank?.name || ''))

    const { mutate } = useSWRConfig()

    const searchString = useAtomValue(bankRecSearchText)
    const typeFilter = useAtomValue(bankRecTransactionTypeFilter)
    const amountFilter = useAtomValue(bankRecAmountFilter)

    const { data: unreconciledTransactions } = useGetUnreconciledTransactions()

    /** 
     * This function should be called after a transaction is reconciled
     * It will get the next unreconciled transaction and select it
     * And then refresh the balance + unreconciled transactions list
     *
     * RETURNS A PROMISE that settles only once every invalidation it issued has completed and, on
     * the full-allocation branch, once the selection has been rebuilt from the refreshed list. A
     * caller that gates an affordance on "the outcome is still settling" must AWAIT it: this used to
     * be a `void` function that started the refresh and returned immediately, so the reconcile
     * hook's shared settling flag cleared in its `finally` while the list was still being re-read -
     * leaving the just-reconciled transaction and the voucher it consumed actionable against a
     * snapshot the client had already superseded. Nothing about WHICH keys are invalidated, or the
     * order they are issued in, changes: they are still dispatched synchronously and in the same
     * sequence, and only the settling of the returned promise is new.
     */
    const onReconcileTransaction = async (transaction: UnreconciledTransaction, updatedTransaction?: BankTransaction): Promise<void> => {

        // If the updated transaction has an unallocated amount of 0, then we need to select the next unreconciled transaction
        if (updatedTransaction && updatedTransaction?.unallocated_amount !== 0) {
            // Issued together and awaited as a set, so the branch converges before the caller
            // reopens anything. `allSettled`, because one key failing must not leave the others
            // unawaited - and because a failed revalidation is not a reason to reject a
            // reconciliation the server has already accepted.
            await withDeadline(Promise.allSettled([
                mutate(bankRecUnreconciledTransactionsKey(selectedBank?.name, dates.fromDate, dates.toDate)),
                mutate(bankRecClosingBalanceKey(selectedBank?.name, dates.toDate)),
                // Update the matching vouchers for the selected transaction
                mutate(`bank-reconciliation-vouchers-${transaction.name}-${dates.fromDate}-${dates.toDate}-${matchFilters.join(',')}`)
            ]))
            return
        }

        // From unreconciled transactions list, first apply the filters based on the search criteria and other filters

        const searchIndex = unreconciledTransactions ? new Fuse(unreconciledTransactions.message, {
            keys: ['description', 'reference_number'],
            threshold: 0.5,
            includeScore: true
        }) : null

        const results = getSearchResults(searchIndex, searchString, typeFilter, amountFilter.value, unreconciledTransactions?.message)

        const currentIndex = results.findIndex(t => t.name === transaction.name)
        let nextTransaction = null

        if (currentIndex !== -1) {
            // Check if there is a next transaction
            if (currentIndex < (results.length || 0) - 1) {
                nextTransaction = results[currentIndex + 1]
            }
        }

        // We need to select the next unreconciled transaction for a better UX
        //
        // Both invalidations are DISPATCHED here, in the order they always were, and only awaited
        // afterwards - so the calls a suite (or SWR) observes are unchanged, while the promise this
        // function returns still covers the selection being rebuilt from the refreshed list.
        const listRefresh = mutate(bankRecUnreconciledTransactionsKey(selectedBank?.name, dates.fromDate, dates.toDate))
        const balanceRefresh = mutate(bankRecClosingBalanceKey(selectedBank?.name, dates.toDate))

        await withDeadline(listRefresh
            .then(res => {
                if (nextTransaction) {
                    // Check if next transaction is there in the response
                    const nextTransactionObj = res?.message.find((t: UnreconciledTransaction) => t.name === nextTransaction.name)
                    if (nextTransactionObj) {
                        setSelectedTransaction([nextTransactionObj])
                    } else {
                        // If the next transaction is not there in the response, we need to clear the selection
                        setSelectedTransaction([])
                    }
                } else {
                    // If there is no next transaction, we need to clear the selection
                    setSelectedTransaction([])
                }
            })
            // A refresh that fails in turn leaves the selection where it is rather than rejecting:
            // the reconciliation itself succeeded, and the caller is awaiting convergence, not an
            // outcome. Reported so it is never silent.
            // Reported as a FIXED diagnostic rather than as the caught object: these rejections
            // carry the whole Frappe response envelope, and a reconciliation's transport detail does
            // not belong in a browser console. The reviewer is told through the dialog and the toast;
            // the console only records that a contained follow-up did not finish.
            .catch(() => console.error('Bank reconciliation: the post-reconciliation transaction refresh did not complete.')))

        await withDeadline(balanceRefresh.catch(() => console.error('Bank reconciliation: the post-reconciliation balance refresh did not complete.')))
    }

    return onReconcileTransaction

}

/**
 * The invalidation form these keys require: EMPTY the cache entry rather than ask it to revalidate.
 *
 * WHY A BARE `mutate(key)` IS NOT ENOUGH - AND WHY IT FAILS SILENTLY. SWR's keyed mutate treats a
 * call with no data argument as "revalidate this key", which it performs by invoking the key's
 * registered revalidator. Revalidators are registered by MOUNTED subscribers. At the moment a
 * statement import finishes, the reconciliation page is not mounted - the importer is - so the
 * imported range's keys have NO revalidator, the revalidate request has nothing to run, and the
 * populated entry is left exactly as it was. The call still resolves, so nothing anywhere reports
 * a problem. Then `useGetUnreconciledTransactions` mounts with `revalidateIfStale` disabled, and
 * SWR skips its mount fetch precisely BECAUSE the entry still holds data. The page renders the
 * pre-import list, and the reviewer is shown a statement whose new transactions are missing.
 *
 * Passing `undefined` as the DATA argument is what changes the outcome: that is a cache WRITE, so
 * it applies with or without a subscriber, and it leaves the entry holding no data. SWR's mount
 * check is "fetch if there is no data OR if stale revalidation is enabled", so an emptied entry
 * refetches on mount even under this application's `revalidateIfStale: false` configuration. The
 * in-app hand-off is thereby made to behave exactly like the full page reload that always showed
 * the correct list.
 *
 * `revalidate: true` covers the other case in the same call: when a subscriber IS mounted, the
 * emptied entry is refilled immediately rather than waiting for a remount. `populateCache: true`
 * is SWR's default and is stated explicitly because it is the load-bearing half of the fix.
 */
/**
 * How long the client is prepared to WAIT on a follow-up request before it stops waiting.
 *
 * Follow-ups are the cache invalidations and the authoritative re-read that run after a
 * reconciliation or a statement import has already been answered. They are awaited for a reason -
 * the confirm affordance stays closed until they converge, so the reviewer is never offered an
 * action against a snapshot the server has superseded - and that is exactly why they need a bound.
 * Neither the SDK's `call.get` nor `useSWRConfig().mutate` accepts an `AbortSignal`, and the
 * underlying Axios instance sets no timeout, so a request that never answers is a promise that
 * never settles: the affordance would sit disabled reading "Checking..." forever, on a screen whose
 * whole job is to let an accountant post.
 */
const FOLLOW_UP_REQUEST_DEADLINE_MS = 15_000

/**
 * Races a follow-up against {@link FOLLOW_UP_REQUEST_DEADLINE_MS} and NEVER rejects.
 *
 * Expiry is not an error to report: the work was already done and acknowledged by the server, and
 * the caller is awaiting convergence rather than an outcome - so a deadline that passes simply
 * means "stop waiting", and every caller's own no-rows / no-snapshot path then applies unchanged.
 *
 * Two details are load-bearing. The timer is cleared in `finally`, so a fast follow-up does not
 * hold the event loop open for the rest of the window - which in a test run would keep the
 * environment alive past the assertion. And the abandoned promise gets a no-op `catch`, because a
 * request that rejects AFTER its deadline has passed still has an unhandled rejection to deliver,
 * and that surfaces as an `unhandledrejection` on a screen that has already moved on.
 */
export const withDeadline = async <T,>(work: Promise<T>): Promise<T | undefined> => {
    work.catch(() => undefined)

    let timer: ReturnType<typeof setTimeout> | undefined

    try {
        return await Promise.race([
            work,
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), FOLLOW_UP_REQUEST_DEADLINE_MS)
            })
        ])
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer)
        }
    }
}

const EVICT_CACHE_ENTRY = { revalidate: true, populateCache: true } as const

/**
 * Empties every transaction-list and balance cache entry a statement import invalidates, for the
 * date range the import actually resolved, so the next render of that range reads the server.
 *
 * WHY AWAITING THIS MATTERS. `useGetUnreconciledTransactions` runs with `revalidateIfStale` and
 * `revalidateOnFocus` both disabled, so remounting it - which is exactly what navigating to the
 * reconciliation page does - does NOT refetch while its entry still holds data. The entries
 * therefore have to be emptied (see `EVICT_CACHE_ENTRY` above for why revalidation alone is not
 * enough), and that has to happen BEFORE navigation, or the caller races the very refresh it asked
 * for.
 *
 * The DATES ARE PASSED IN, deliberately, rather than read from `bankRecDateAtom`. The import
 * resolves the statement's own start and end dates server-side and returns them on the saved
 * document, and it is those dates the caller writes into the atom and navigates to. Reading the
 * atom here would risk building keys from the previous range - the one being navigated away from -
 * and invalidating entries nobody is about to look at while leaving the one about to be rendered
 * untouched. Passing them makes the caller state which range it means.
 *
 * All four keys are EXISTING families, built by the same builders the query hooks use, so no key
 * text changes and no sixth family appears. Nothing is written into the cache except emptiness:
 * this hook never supplies data of its own, so it cannot put a differently-parameterised response
 * where a query's own answer belongs, and the server stays the only source of what is displayed.
 *
 * `allSettled`, because a balance query failing must not prevent the transaction lists from
 * refreshing; the caller is continuing to a page whose value comes mostly from those lists.
 */
export const useRefreshImportedTransactions = () => {

    const { mutate } = useSWRConfig()

    return useCallback(async (bankAccountName: string, fromDate: string, toDate: string): Promise<void> => {
        // Every invalidation is DISPATCHED unconditionally, so the cache WRITE always happens; only
        // the WAIT for the revalidations they trigger is bounded.
        await withDeadline(Promise.allSettled([
            mutate(bankRecUnreconciledTransactionsKey(bankAccountName, fromDate, toDate), undefined, EVICT_CACHE_ENTRY),
            mutate(bankRecBankTransactionsKey(bankAccountName, fromDate, toDate), undefined, EVICT_CACHE_ENTRY),
            mutate(bankRecClosingBalanceKey(bankAccountName, toDate), undefined, EVICT_CACHE_ENTRY),
            mutate(bankRecClosingBalanceAsPerStatementKey(bankAccountName, toDate), undefined, EVICT_CACHE_ENTRY)
        ]))
    }, [mutate])
}

/**
 * Reads the server's CURRENT view of this bank account's transactions for the selected date range,
 * imperatively and unconditionally - the whole set, including rows the unreconciled query filters
 * out.
 *
 * WHY AN IMPERATIVE READ, AND NOT `mutate(key)`. SWR's keyed mutate performs a revalidation by
 * invoking the key's registered revalidator, and revalidators are registered by MOUNTED
 * subscribers. With no subscriber there is nothing to invoke, so the call resolves with whatever
 * the cache currently holds and reports no problem at all. The all-transactions list lives in a
 * different tab of the workbench, and Radix unmounts inactive tab content, so at the moment a
 * confirm is refused that key routinely has NO subscriber - and its cached rows are the
 * PRE-ATTEMPT snapshot, in which the transaction is still `Unreconciled` with a positive
 * unallocated amount. Feeding that back into the selection is what let a stale row survive an
 * "already fully reconciled" refusal and re-enable Confirm, which is the exact stale-client case
 * FM3 exists to close.
 *
 * A `call.get` cannot be served from a cache, so what it returns is the server's answer or nothing.
 * It is also the same read the workbench's own "Bank Transactions" tab performs - same endpoint,
 * same arguments, `all_transactions` included - so the rows come back with an identical projection
 * and a transaction the server now considers reconciled is PRESENT in them, carrying its true
 * `status` and `unallocated_amount`, rather than merely missing.
 *
 * Never rejects. A failed read means the client could not establish the server's view, which the
 * caller must handle as "unknown" rather than as an empty result; `undefined` says exactly that,
 * while an empty ARRAY is a real answer and is treated as one.
 */
const useAuthoritativeTransactionRead = () => {

    const { call: frappeCall } = useContext(FrappeContext) as FrappeConfig

    const selectedBank = useAtomValue(selectedBankAccountAtom)

    const dates = useAtomValue(bankRecDateAtom)

    return useCallback(async (): Promise<UnreconciledTransaction[] | undefined> => {

        if (!selectedBank?.name) {
            return undefined
        }

        try {
            const response = await frappeCall.get<{ message: UnreconciledTransaction[] }>(
                GET_BANK_TRANSACTIONS_METHOD,
                {
                    bank_account: selectedBank.name,
                    from_date: dates.fromDate,
                    to_date: dates.toDate,
                    all_transactions: true
                }
            )

            return response?.message
        } catch {
            // Reported, not thrown: the caller is already surfacing the original rejection, and a
            // second failure must not replace that message with this one. Fixed diagnostic only;
            // see the note above.
            console.error('Bank reconciliation: the authoritative transaction re-read did not complete.')
            return undefined
        }

    }, [frappeCall, selectedBank?.name, dates.fromDate, dates.toDate])
}

export const useReconcileTransaction = () => {

    const { call, loading } = useFrappePostCall<{ message: BankTransaction }>('erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.reconcile_vouchers')

    const onReconcileTransaction = useRefreshUnreconciledTransactions()

    const setBankRecUnreconcileModalAtom = useSetAtom(bankRecUnreconcileModalAtom)

    const addToActionLog = useUpdateActionLog()

    const selectedBank = useAtomValue(selectedBankAccountAtom)

    const dates = useAtomValue(bankRecDateAtom)

    const { mutate } = useSWRConfig()

    const setBankRecErrorDialog = useSetAtom(bankRecErrorDialogAtom)

    /**
     * The subscriber-independent read the rejection path resolves the transaction's true state
     * with. Held here rather than called inside the handler because it is a hook.
     */
    const readTransactionsFromServer = useAuthoritativeTransactionRead()

    /**
     * The selection the reviewer is acting on. It is written from the SAME atom-family instance
     * `useRefreshUnreconciledTransactions` uses, so the success path and the rejection path can
     * never end up updating two different selections for one bank account.
     */
    const setSelectedTransaction = useSetAtom(bankRecSelectedTransactionAtom(selectedBank?.name || ''))

    /**
     * True from the instant a post is dispatched until its outcome has been RESOLVED AGAINST THE
     * SERVER - which, on a rejection, means after the authoritative refresh has landed and the
     * selection has been rebuilt from it.
     *
     * It exists because `loading` from `useFrappePostCall` answers a narrower question ("is a
     * request in flight?") and flips back to `false` the moment the promise settles. On a
     * rejection that is strictly too early: at that point the client knows only that its own
     * attempt failed, and still holds the pre-attempt snapshot of the transaction. Leaving the
     * affordance live in that window invites a second post against state the client has not yet
     * re-read - exactly the stale-client case FM3 is about. It is raised BEFORE `call()` rather
     * than inside the rejection handler so there is no render, however brief, in which the request
     * has settled and nothing is holding the action closed.
     *
     * Shared through an atom rather than held in local state because this hook is instantiated once
     * per candidate voucher row against a single selected transaction; see the atom's own note.
     */
    const [isSettling, setIsSettling] = useAtom(bankRecReconcileSettlingAtom)

    /**
     * Re-establishes the server's own view after a rejection, and rebuilds the selection from it.
     *
     * TWO SEPARATE JOBS, deliberately not conflated - conflating them is what F5 was:
     *
     *  1. LEARN the truth, for the guard. Done with {@link useAuthoritativeTransactionRead}, an
     *     imperative `call.get` that cannot be served from a cache. The previous version instead
     *     read the RETURN VALUE of a bare `mutate(key)`, which for an unsubscribed key is simply
     *     the current cache contents - so the pre-attempt snapshot of the all-transactions list
     *     (transaction still `Unreconciled`, unallocated amount still positive) could override a
     *     correct, freshly fetched unreconciled result, keep the stale row selected, and re-enable
     *     Confirm on a transaction the server had just refused as already reconciled.
     *  2. INVALIDATE what is DISPLAYED. Both list keys are emptied with the same
     *     {@link EVICT_CACHE_ENTRY} treatment a statement import uses, because eviction is the only
     *     form that applies WITHOUT a subscriber: a mounted list refills immediately, and an
     *     unmounted one cannot later serve rows from before the attempt - which matters because
     *     `useGetUnreconciledTransactions` disables both `revalidateOnFocus` and
     *     `revalidateIfStale`, so a populated entry would otherwise survive a remount untouched.
     *
     * Both keys are EXISTING families, built by the same builders the query hooks use, so no sixth
     * cache key appears and no key text changes. Nothing but emptiness is ever written into the
     * cache, so this cannot put a differently-parameterised payload where a query's own answer
     * belongs. `allSettled`, so one key failing does not prevent the other from being invalidated,
     * and the whole thing is awaited so the caller can keep the action closed until it finishes.
     */
    const refreshFromServerAfterRejection = async () => {

        // Asked FIRST, and independently of the cache, so what the guard is rebuilt from is the
        // server's answer rather than a by-product of an invalidation.
        // Bounded like every other follow-up: `undefined` from an expiry is the same "nothing was
        // established" answer the read's own failure path already returns, and the no-snapshot
        // branch below handles it identically.
        const authoritativeRows = await withDeadline(readTransactionsFromServer())

        await withDeadline(Promise.allSettled([
            mutate(bankRecUnreconciledTransactionsKey(selectedBank?.name, dates.fromDate, dates.toDate), undefined, EVICT_CACHE_ENTRY),
            mutate(bankRecBankTransactionsKey(selectedBank?.name, dates.fromDate, dates.toDate), undefined, EVICT_CACHE_ENTRY)
        ]))

        // The read failed, so the client did not establish anything. The selection is then left
        // EXACTLY as it is: rebuilding it from nothing would either invent state or silently discard
        // the reviewer's selection on the strength of a second failure. The affordance stays closed
        // for this attempt regardless, and the server remains the authority on any further one. An
        // empty array is NOT this case - a list that legitimately came back empty is authoritative
        // and does clear the selection below.
        if (!authoritativeRows) {
            return
        }

        // Replace every entry with the server's current row, and drop the ones the server no longer
        // reports for this account and date range. Nothing is merged or patched: the refreshed row
        // is taken whole, so `status` and `unallocated_amount` - the two fields the confirm guard
        // reads - can only ever be the server's own values.
        //
        // Because the read carries `all_transactions`, a transaction the server now considers
        // reconciled comes back PRESENT rather than missing, so the row is kept with its true status
        // and the guard disables the action against it. A row the server genuinely no longer reports
        // for this range is dropped, and the action is simply no longer offered. Neither outcome
        // leaves a stale row behind still claiming to be reconcilable.
        setSelectedTransaction((currentSelection) => currentSelection.flatMap((selected) => {
            const refreshed = authoritativeRows.find((row) => row.name === selected.name)
            return refreshed ? [refreshed] : []
        }))
    }

    const reconcileTransaction = (transaction: UnreconciledTransaction, voucher: LinkedPayment) => {

        setIsSettling(true)

        call({
            bank_transaction_name: transaction.name,
            vouchers: JSON.stringify([{
                "payment_doctype": voucher.doctype,
                "payment_name": voucher.name,
                "amount": voucher.paid_amount
            }])
        }).then((res) => {
            addToActionLog({
                type: 'match',
                timestamp: (new Date()).getTime(),
                isBulk: false,
                items: [
                    {
                        bankTransaction: res.message,
                        voucher: {
                            reference_doctype: voucher.doctype,
                            reference_name: voucher.name,
                            reference_no: voucher.reference_no,
                            reference_date: voucher.reference_date,
                            posting_date: voucher.posting_date,
                        }
                    }
                ]
            })
            // Raised BEFORE the refresh is awaited, so the confirmation does not wait on the
            // network - the same ordering the rejection path uses for its message.
            toast.success(_("Reconciled"), {
                duration: 4000,
                closeButton: true,
                action: {
                    label: _("Undo"),
                    onClick: () => setBankRecUnreconcileModalAtom(transaction.name)
                },
                actionButtonStyle: {
                    backgroundColor: "rgb(0, 138, 46)"
                }
            })
            // RETURNED into the chain, so `isSettling` in the `finally` below cannot clear until the
            // transaction lists have been re-read and the selection rebuilt from them. Returning it
            // is the whole fix: this was previously called as a void function, so the shared flag
            // cleared while the refresh was still in flight and the reconciled transaction - and the
            // voucher just consumed - were briefly actionable again against the superseded snapshot.
            return onReconcileTransaction(transaction, res.message)
        }).catch((reason: unknown) => {
            // NOT logged. The rejection is surfaced in full to the reviewer through the dialog and
            // the toast below, so a console copy would add nothing but a second, unredacted record
            // of a financial transport failure.
            //
            // Stored raw so the shared dialog parses the server's own envelope; only a rejection that
            // brought back no usable response is substituted, and then there is no server text to
            // preserve. The dialog and the toast read the same resolved value, so they cannot
            // disagree. Both are raised BEFORE the refresh is awaited so neither waits on the
            // network: the reviewer is told immediately, and the state work then settles behind the
            // message. Nothing is mutated optimistically at any point - the client never writes a
            // reconciliation it did not read back from the server.
            const displayError = toDisplayError(reason)
            setBankRecErrorDialog(displayError)
            toast.error(_("Error"), {
                duration: 5000,
                description: getErrorMessage(displayError)
            })
            // AWAITED, and returned into the promise chain, so `isSettling` below cannot clear until
            // the server's own view has been re-read and the selection rebuilt from it. Only the two
            // transaction-list keys are revalidated, because between them they own every `status` /
            // `unallocated_amount` the confirm affordance reads.
            return refreshFromServerAfterRejection()
        }).finally(() => {
            // Reached after the success branch's synchronous work, and after the rejection branch's
            // awaited refresh - so on the path that matters the action reopens only once the client
            // is holding the server's answer rather than its own guess.
            setIsSettling(false)
        })
    }

    /**
     * `loading` keeps its original meaning - a post is in flight - so the caller's progress label is
     * unchanged. `isSettling` is the wider window the caller must gate the ACTION on; it is exposed
     * separately rather than folded into `loading` so a rejection being resolved is not mislabelled
     * as a reconciliation still being attempted.
     */
    return { reconcileTransaction, loading, isSettling }

}

/**
 * One row of `bank_account.get_list`. The `Pick` names every field that endpoint projects -
 * `is_default` included, which is also what it orders by (`is_default desc`), so the first row
 * of the list is the company's default account. `account_currency` is listed separately because
 * it is NOT a `Bank Account` field: the endpoint derives it per row from the linked
 * `Account.account_currency` after the query, which is why it is optional here.
 *
 * EXPORTED so a test fixture can be typed by this contract instead of restating it. The
 * projection is deliberately NOT the same shape as `SelectedBank`, which models the PERSISTED
 * selection: that one carries `integration_id` (which this endpoint does not project) and omits
 * `account_subtype` (which it does), so a fixture built from the wrong one silently asserts
 * against a response the server cannot produce.
 */
export interface BankAccountWithCurrency extends Pick<BankAccount, 'name' | 'bank' | 'account_name' | 'is_credit_card' | 'is_default' | 'company' | 'account' | 'account_type' | 'account_subtype' | 'bank_account_no' | 'last_integration_date'> {
    account_currency?: string
}

type BankLogoEntry = (typeof BANK_LOGOS)[number]

/** Prefer the longest keyword match so short tokens (e.g. "anz" in "finanzas") do not beat full bank names. */
function findBankLogoForName(bankName: string | undefined | null): BankLogoEntry | undefined {
    if (!bankName) return undefined
    const haystack = bankName.toLowerCase()
    let best: BankLogoEntry | undefined
    let bestKeywordLen = 0
    for (const entry of BANK_LOGOS) {
        for (const keyword of entry.keywords) {
            const needle = keyword.toLowerCase()
            if (needle.length === 0) continue
            if (haystack.includes(needle) && needle.length > bestKeywordLen) {
                bestKeywordLen = needle.length
                best = entry
            }
        }
    }
    return best
}

export const useGetBankAccounts = (onSuccess?: (data?: Omit<SelectedBank, 'logo'>[]) => void, filterFn?: (bank: SelectedBank) => boolean) => {

    const company = useCurrentCompany()

    const { data, isLoading, error } = useFrappeGetCall<{ message: BankAccountWithCurrency[] }>('erpnext.accounts.doctype.bank_account.bank_account.get_list', {
        company: company
    }, undefined, {
        revalidateOnFocus: false,
        revalidateIfStale: false,
        onSuccess: (data) => {
            onSuccess?.(data?.message)
        }
    })

    const banks = useMemo(() => {
        // Match the bank account to the logo
        const banksWithLogos = data?.message.map((bank) => {
            const logo = findBankLogoForName(bank.bank)
            return {
                ...bank,
                logo: logo?.logo,
                logoDark: logo?.logoDark,
                darkModeInvert: logo?.darkModeInvert,
                logoClassName: logo?.logoClassName
            }
        }) ?? []

        if (filterFn) {
            return banksWithLogos.filter(filterFn)
        }

        return banksWithLogos
    }, [data, filterFn])

    return {
        banks,
        isLoading,
        error
    }

}

export const useIsTransactionWithdrawal = (transaction: UnreconciledTransaction) => {
    return useMemo(() => {
        const isWithdrawal = transaction.withdrawal && transaction.withdrawal > 0
        const isDeposit = transaction.deposit && transaction.deposit > 0

        return {
            amount: isWithdrawal ? transaction.withdrawal : transaction.deposit,
            isWithdrawal,
            isDeposit
        }
    }, [transaction])
}

export const useGetRuleForTransaction = (transaction: UnreconciledTransaction) => {

    return useFrappeGetDoc<BankTransactionRule>('Bank Transaction Rule', transaction.matched_transaction_rule,
        transaction.matched_transaction_rule ? undefined : null, {
        revalidateOnFocus: false,
        revalidateIfStale: false
    }
    )
}

/** Hook to handle the search input while maintaining debouncing and global state. */
export function useTransactionSearch(): [string, DebouncedState<(value: string) => void>] {
    const delay = 500
    const unwrappedInitialValue = ''
    const eq = (left: string, right: string) => left === right
    const [debouncedValue, setDebouncedValue] = useAtom(bankRecSearchText)
    const previousValueRef = useRef<string | undefined>(unwrappedInitialValue)

    const updateDebouncedValue = useDebounceCallback(
        setDebouncedValue,
        delay,
    )

    // Update the debounced value if the initial value changes
    if (!eq(previousValueRef.current as string, unwrappedInitialValue)) {
        updateDebouncedValue(unwrappedInitialValue)
        previousValueRef.current = unwrappedInitialValue
    }

    return [debouncedValue, updateDebouncedValue]
}

/** Utility function to get the search results based on the search index, search string, type filter, amount filter and unreconciled transactions */
export const getSearchResults = (
    /** Fuse index of the unreconciled transactions */
    searchIndex: Fuse<UnreconciledTransaction> | null,
    /** Search string */
    search: string,
    /** Type filter */
    typeFilter: string,
    /** Amount filter */
    amountFilter: number,
    /** Unreconciled transactions */
    unreconciledTransactions?: UnreconciledTransaction[]) => {

    let r = []
    if (!searchIndex || !search) {
        r = unreconciledTransactions ?? []
    } else {
        r = searchIndex.search(search).map((result) => result.item)
    }

    if (typeFilter !== 'All') {
        r = r.filter((transaction) => {
            if (typeFilter === 'Debits') {
                return transaction.withdrawal && transaction.withdrawal > 0
            }
            if (typeFilter === 'Credits') {
                return transaction.deposit && transaction.deposit > 0
            }
        })
    }

    if (amountFilter > 0) {
        r = r.filter((transaction) => {
            if (transaction.withdrawal && transaction.withdrawal > 0) {
                return transaction.withdrawal === amountFilter
            }
            if (transaction.deposit && transaction.deposit > 0) {
                return transaction.deposit === amountFilter
            }
            return false
        })
    }

    return r
}

export const useUpdateActionLog = () => {

    const setActionLog = useSetAtom(bankRecActionLog)

    const addToActionLog = (action: ActionLog) => {
        // Store at max 100 actions
        setActionLog((prev) => {
            const newActions = [action, ...prev]
            if (newActions.length > 100) {
                return newActions.slice(0, 100)
            }
            return newActions
        })
    }

    return addToActionLog
}