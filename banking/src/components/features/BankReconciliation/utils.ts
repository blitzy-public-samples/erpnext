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


export const useGetUnreconciledTransactions = () => {
    const bankAccount = useAtomValue(selectedBankAccountAtom)
    const dates = useAtomValue(bankRecDateAtom)
    return useFrappeGetCall<{ message: UnreconciledTransaction[] }>('erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions', {
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

/** How strongly a voucher's reference agrees with the transaction under review. */
export type VoucherReferenceMatch = 'full' | 'partial' | 'none'

/**
 * Trims, and treats null/undefined as blank, so every comparison below operates on a value
 * that is either meaningful or empty - never on whitespace that merely looks meaningful.
 */
const normalizeReference = (value: string | null | undefined): string => (value ?? '').trim()

/**
 * Grades a voucher's reference against the transaction's own reference candidates (its
 * reference number and its description).
 *
 * A BLANK reference on either side is evidence of NOTHING and can never produce a match.
 * That rule is the whole point of this function. Two of the four voucher types
 * `get_linked_payments` returns supply `reference_no` as a constant empty string and a third
 * can supply NULL, so blanks are not an edge case here - they are the normal shape of an
 * invoice row. Compared naively, a blank sails through as a match twice over: `'' === ''`
 * reads as an exact match against a transaction that also has no reference, and - far worse -
 * `String.prototype.includes('')` is ALWAYS true, so every blank-reference voucher scored as
 * a partial match against every transaction. Because a partial match is one of the three
 * disjuncts that promote the first voucher to "suggested", an amount-only coincidence was
 * being presented to the reviewer as a rule-quality suggestion, in green, with a solid
 * Reconcile button. Requiring a trimmed, non-blank reference on both sides removes that
 * false signal without weakening any genuine one.
 *
 * Case is deliberately NOT folded: bank references are identifiers, and the backend's own
 * matching is case-sensitive.
 */
export const matchVoucherReference = (
    voucherReference: string | null | undefined,
    transactionCandidates: (string | null | undefined)[]
): VoucherReferenceMatch => {
    const reference = normalizeReference(voucherReference)
    if (reference.length === 0) return 'none'

    const candidates = transactionCandidates
        .map(normalizeReference)
        .filter((candidate) => candidate.length > 0)

    if (candidates.some((candidate) => candidate === reference)) return 'full'
    if (candidates.some((candidate) => candidate.includes(reference))) return 'partial'
    return 'none'
}

/**
 * Compares a voucher date against the transaction date under the same blank-is-not-evidence
 * rule. `reference_date` arrives as `""` for both invoice branches and can be NULL for a
 * Journal Entry, while `BankTransaction.date` is itself optional - so a bare `===` reports a
 * match whenever both sides happen to be absent, which is the same false signal in a
 * different column.
 */
export const matchVoucherDate = (
    voucherDate: string | null | undefined,
    transactionDate: string | null | undefined
): boolean => {
    const voucher = normalizeReference(voucherDate)
    const transaction = normalizeReference(transactionDate)
    return voucher.length > 0 && voucher === transaction
}

export const useGetBankTransactions = () => {
    const bankAccount = useAtomValue(selectedBankAccountAtom)
    const dates = useAtomValue(bankRecDateAtom)
    return useFrappeGetCall<{ message: BankTransaction[] }>('erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions', {
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
     */
    const onReconcileTransaction = (transaction: UnreconciledTransaction, updatedTransaction?: BankTransaction) => {

        // If the updated transaction has an unallocated amount of 0, then we need to select the next unreconciled transaction
        if (updatedTransaction && updatedTransaction?.unallocated_amount !== 0) {
            mutate(bankRecUnreconciledTransactionsKey(selectedBank?.name, dates.fromDate, dates.toDate))
            mutate(bankRecClosingBalanceKey(selectedBank?.name, dates.toDate))
            // Update the matching vouchers for the selected transaction
            mutate(`bank-reconciliation-vouchers-${transaction.name}-${dates.fromDate}-${dates.toDate}-${matchFilters.join(',')}`)
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
        mutate(bankRecUnreconciledTransactionsKey(selectedBank?.name, dates.fromDate, dates.toDate))
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
        mutate(bankRecClosingBalanceKey(selectedBank?.name, dates.toDate))
    }

    return onReconcileTransaction

}

/**
 * How long the client is prepared to wait for the rule-evaluation worker to finish stamping the
 * transactions an import just created, and how often it asks. Bounded on purpose: the wait is a
 * convenience, never a correctness requirement, so it must always end.
 */
const RULE_EVALUATION_POLL_INTERVAL_MS = 700
const RULE_EVALUATION_POLL_ATTEMPTS = 8

/**
 * Waits, within a bound, for rule evaluation to have been applied to the bank transactions in a
 * date range - then reports whether it converged.
 *
 * WHY THIS IS NEEDED. `insert_transactions` calls the whitelisted `run_rule_evaluation`, which
 * enqueues the evaluator with `frappe.enqueue(...)`. That defaults to `enqueue_after_commit=False`,
 * so the job is queued immediately, BEFORE the request-level commit that makes the imported
 * transactions visible to other connections. A worker that picks the job up promptly runs
 * `_run_rule_evaluation`, whose query finds none of the new rows, and returns having stamped
 * nothing. The import then commits. The result is transactions that are permanently unevaluated
 * until some later trigger, and a reviewer looking at a freshly imported statement with no
 * suggested matches on it.
 *
 * WHY THE FIX IS HERE AND NOT IN THE BACKEND. Passing `enqueue_after_commit=True` would fix this at
 * source, but that is a change to existing backend behaviour on a shared, already-whitelisted
 * method, and it is not within the authorised change surface for this work: the only backend file in
 * scope is a test module. So this is resolved from the client, using an endpoint the application
 * already calls, and nothing about the server is altered.
 *
 * HOW. Re-invoking `run_rule_evaluation` from here is what makes this deterministic rather than a
 * hopeful wait. This call happens strictly AFTER the import's HTTP response has been received,
 * which means the import transaction has already committed; the job this enqueues therefore cannot
 * fail to see the imported rows the way the server-side call could. It is also safe to repeat:
 * `_run_rule_evaluation` selects only transactions with `is_rule_evaluated = 0`, so a re-run stamps
 * the stragglers and does no work at all when there are none, and the endpoint asks only for read
 * permission on Bank Transaction.
 *
 * The poll then watches the authoritative field the evaluator writes. `is_rule_evaluated` goes to 1
 * for every transaction the evaluator considers, whether or not a rule matched, so a count of zero
 * remaining is a positive statement that evaluation has been applied to this range - not an
 * inference from a matched-rule count, which would be indistinguishable from "no rule matched".
 *
 * WHY IT ASKS HOW MANY RULES EXIST FIRST. The evaluator's own first act is to read every
 * `Bank Transaction Rule` and `return` immediately if there are none - WITHOUT stamping anything.
 * On a site with no rules, therefore, `is_rule_evaluated` stays 0 for every imported transaction
 * no matter how many times the evaluator runs, the exit condition below is unreachable, and the
 * poll can only ever exhaust its full bound. That is not a slow wait, it is a wait that is
 * guaranteed to fail, and it delayed EVERY import on a default site by the whole bound while the
 * reviewer looked at a screen that had already finished its work. There is also nothing to
 * trigger in that state, so the re-invocation is skipped along with the poll.
 *
 * The rule count deliberately carries NO filters, because the evaluator's query carries none
 * either: it considers every rule, disabled or not, so any narrowing here could disagree with the
 * server about whether there is work to wait for. A count that cannot be READ is a different
 * matter - `Bank Transaction Rule` is a separate permission grant from the `Bank Transaction` read
 * this endpoint requires - and is NOT treated as "no rules": the bounded trigger and poll run as
 * before, because failing to read the count is not evidence about the site's configuration.
 *
 * Returns `true` when the range drained or when there is no rule that could ever stamp it, `false`
 * when the bound expired or the pending count could not be read. It NEVER rejects and never blocks
 * indefinitely: a caller that gets `false` has simply learned that suggested matches may still be
 * arriving, which is a display concern, not an error.
 */
export const useWaitForRuleEvaluation = () => {

    const { db } = useContext(FrappeContext) as FrappeConfig
    const { call: runRuleEvaluation } = useFrappePostCall('erpnext.accounts.doctype.bank_transaction_rule.bank_transaction_rule.run_rule_evaluation')

    return useCallback(async (bankAccountName: string, fromDate: string, toDate: string): Promise<boolean> => {

        // Nothing can stamp these transactions, so there is nothing to trigger and nothing that
        // waiting could ever observe. Reported as converged because that is the honest answer to
        // the question the caller is asking - no suggested match is still on its way.
        try {
            const ruleCount = await db.getCount('Bank Transaction Rule')

            if (ruleCount === 0) {
                return true
            }
        } catch (ruleCountError) {
            // Unreadable, not absent. Fall through to the bounded wait rather than assume either way.
            console.error(ruleCountError)
        }

        // Enqueued post-commit, so unlike the server-side call this one is guaranteed to see the
        // rows the import just created. A failure here is not fatal: the scheduled evaluation will
        // still get to them, so the poll below is attempted regardless.
        try {
            await runRuleEvaluation({})
        } catch (triggerError) {
            console.error(triggerError)
        }

        for (let attempt = 0; attempt < RULE_EVALUATION_POLL_ATTEMPTS; attempt++) {

            try {
                // Mirrors the evaluator's own selection (`status`, `docstatus`, `is_rule_evaluated`)
                // and narrows it to the imported range, so the count answers a question about this
                // import rather than about the whole account.
                const pending = await db.getCount('Bank Transaction', [
                    ['bank_account', '=', bankAccountName],
                    ['date', 'between', [fromDate, toDate]],
                    ['docstatus', '=', 1],
                    ['status', '=', 'Unreconciled'],
                    ['is_rule_evaluated', '=', 0]
                ])

                if (pending === 0) {
                    return true
                }
            } catch (countError) {
                // The count is unavailable, so convergence cannot be established. Reported as not
                // converged rather than retried blindly.
                console.error(countError)
                return false
            }

            await new Promise((resolve) => setTimeout(resolve, RULE_EVALUATION_POLL_INTERVAL_MS))
        }

        return false

    }, [db, runRuleEvaluation])
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
        await Promise.allSettled([
            mutate(bankRecUnreconciledTransactionsKey(bankAccountName, fromDate, toDate), undefined, EVICT_CACHE_ENTRY),
            mutate(bankRecBankTransactionsKey(bankAccountName, fromDate, toDate), undefined, EVICT_CACHE_ENTRY),
            mutate(bankRecClosingBalanceKey(bankAccountName, toDate), undefined, EVICT_CACHE_ENTRY),
            mutate(bankRecClosingBalanceAsPerStatementKey(bankAccountName, toDate), undefined, EVICT_CACHE_ENTRY)
        ])
    }, [mutate])
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
     * Re-reads the server's own view of the two transaction lists and rebuilds the selection from
     * whatever came back. Called only after a rejection.
     *
     * Both keys are EXISTING families and are re-derived here as the literal strings the query
     * hooks build, so no sixth cache key appears and no key text changes. `allSettled` is used so
     * a refresh that fails in turn is observed rather than escaping as an unhandled rejection, and
     * the whole thing is awaited so the caller can keep the action closed until it finishes.
     *
     * Both keys are served by the SAME endpoint (`get_bank_transactions`, once with
     * `all_transactions`), so their rows carry an identical projection and can be searched as one
     * pool. The unreconciled rows are consulted first purely so a still-unreconciled transaction
     * resolves against the narrower, more specific list.
     */
    const refreshFromServerAfterRejection = async () => {

        const [unreconciledResult, allTransactionsResult] = await Promise.allSettled([
            mutate<{ message: UnreconciledTransaction[] }>(bankRecUnreconciledTransactionsKey(selectedBank?.name, dates.fromDate, dates.toDate)),
            mutate<{ message: BankTransaction[] }>(bankRecBankTransactionsKey(selectedBank?.name, dates.fromDate, dates.toDate))
        ])

        const unreconciledRows = unreconciledResult.status === 'fulfilled' ? unreconciledResult.value?.message : undefined
        const allTransactionRows = allTransactionsResult.status === 'fulfilled' ? allTransactionsResult.value?.message : undefined

        // No authoritative snapshot came back at all - both refreshes failed, or neither key had a
        // mounted fetcher to serve them. The selection is then left EXACTLY as it is: rebuilding it
        // from nothing would either invent state or silently discard the reviewer's selection on the
        // strength of a second failure. An empty array is not "nothing": a list that legitimately
        // came back empty is authoritative and does clear the selection below.
        if (!unreconciledRows && !allTransactionRows) {
            return
        }

        const refreshedRows: UnreconciledTransaction[] = [...(unreconciledRows ?? []), ...(allTransactionRows ?? [])]

        // Replace every entry with the server's current row, and drop the ones the server no longer
        // reports for this account and date range. Nothing is merged or patched: the refreshed row
        // is taken whole, so `status` and `unallocated_amount` - the two fields the confirm guard
        // reads - can only ever be the server's own values.
        //
        // Both outcomes are safe, and which one occurs depends on what the refreshed pool contains.
        // A transaction the server now reports as reconciled is absent from the unreconciled list by
        // construction (that endpoint filters on `unallocated_amount > 0`) but present in the
        // all-transactions list, so where that view is also live the row is KEPT with its true
        // status and the guard disables the action; where it is not, the row is dropped and the
        // action is simply no longer offered. Neither path leaves a stale row behind still claiming
        // to be reconcilable, which is the only outcome that would matter.
        setSelectedTransaction((currentSelection) => currentSelection.flatMap((selected) => {
            const refreshed = refreshedRows.find((row) => row.name === selected.name)
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
            onReconcileTransaction(transaction, res.message)
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
        }).catch((reason: unknown) => {
            console.error(reason)
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

/**
 * The account currency of the currently selected bank account, read from the SERVER'S CURRENT
 * bank-account list rather than from the stored selection.
 *
 * Why this exists at all: `selectedBankAccountAtom` is an `atomWithStorage` over `localStorage`
 * with `getOnInit`, so the selected bank is a SNAPSHOT of a row as it looked whenever it was last
 * chosen - potentially days or weeks earlier, on another browser session. `account_currency` is
 * also the most likely field on that row to have moved on without the snapshot noticing, because
 * it is not a `Bank Account` field at all: `bank_account.get_list` derives it per row from the
 * linked `Account.account_currency` after the query, so editing the GL account - or repointing the
 * bank account at a different one - changes it with nothing written to the stored copy. Deciding a
 * currency comparison from that snapshot can therefore report a mismatch that no longer exists, or
 * miss one that now does. Neither is acceptable for a value a reviewer is being asked to act on.
 *
 * Why it is a second hook rather than a parameter on `useGetBankAccounts`: it shares that hook's
 * SWR ENTRY instead of opening a second request. `useFrappeGetCall` derives its cache key as
 * `` `${method}?${encodeQueryData(params)}` `` whenever the explicit `swrKey` argument is
 * `undefined`, so passing the identical method and the identical `{ company }` params produces a
 * byte-identical key - the same cached entry, the same in-flight request, deduped by SWR. No sixth
 * cache-key family is introduced and no extra network call is made.
 *
 * `revalidateIfStale` is deliberately LEFT AT ITS DEFAULT here, unlike on `useGetBankAccounts`
 * where it is switched off. That single difference is what makes this value fresh: mounting this
 * hook revalidates the shared entry, so every consumer of that entry - this hook, the bank picker,
 * and the picker's rehydration of the stored selection - sees the server's current rows.
 * `revalidateOnFocus` stays off to match the sibling hook, so focus behaviour is unchanged.
 *
 * Returns `undefined` while the list is loading, when the selected account is not in it, and when
 * the endpoint could not derive a currency for that row. Callers must treat `undefined` as
 * "nothing to compare" - never as a mismatch.
 */
export const useSelectedBankAccountCurrency = (): string | undefined => {

    const company = useCurrentCompany()
    const selectedBank = useAtomValue(selectedBankAccountAtom)

    const { data } = useFrappeGetCall<{ message: BankAccountWithCurrency[] }>('erpnext.accounts.doctype.bank_account.bank_account.get_list', {
        company: company
    }, undefined, {
        revalidateOnFocus: false
    })

    return useMemo(
        () => data?.message?.find((bank) => bank.name === selectedBank?.name)?.account_currency,
        [data, selectedBank?.name]
    )
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