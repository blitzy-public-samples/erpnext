import { ActionLog, bankRecActionLog, bankRecAmountFilter, bankRecDateAtom, bankRecErrorDialogAtom, bankRecMatchFilters, bankRecReconcileInFlightAtom, bankRecSearchText, bankRecSelectedTransactionAtom, bankRecTransactionTypeFilter, bankRecUnreconcileModalAtom, SelectedBank, selectedBankAccountAtom } from './bankRecAtoms'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { useEffect, useMemo } from 'react'
import { SWRConfiguration, useFrappeGetCall, useFrappeGetDoc, useFrappePostCall, useSWRConfig } from 'frappe-react-sdk'
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
        `bank-reconciliation-account-closing-balance-${bankAccount?.name}-${dates.toDate}`,
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

    // `date` is REQUIRED and NULLABLE, exactly as the endpoint models it: `bank_account.py:194-196`
    // returns `{"balance": …, "date": <Bank Account Balance.date>}` when a row exists and
    // `{"balance": 0, "date": None}` when none does - the key is always present, and `null` is a
    // value it really carries. Typing it `date?: string` told callers the opposite in both
    // directions, so a `null` could be handed to code that had been promised only a string.
    return useFrappeGetCall<{ message: { balance: number, date: string | null } }>("erpnext.accounts.doctype.bank_account.bank_account.get_closing_balance_as_per_statement", {
        bank_account: bankAccount?.name,
        date: dates.toDate
    }, `bank-reconciliation-account-closing-balance-as-per-statement-${bankAccount?.name}-${dates.toDate}`, {
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
    }, bankAccount ? `bank-reconciliation-unreconciled-transactions-${bankAccount?.name}-${dates.fromDate}-${dates.toDate}` : null, {
        revalidateOnFocus: false,
        revalidateIfStale: false
    })
}

/**
 * One candidate voucher as `get_linked_payments` returns it.
 *
 * `check_matching` runs FIVE branch queries - Bank Transaction, Payment Entry, Journal Entry, Sales
 * Invoice and Purchase Invoice - concatenates their rows and returns them sorted by `rank`
 * DESCENDING. `rank` itself is a per-branch sum of match indicators plus one, so its ceiling differs
 * by branch (Bank Transaction 5; Payment Entry and Sales Invoice 4; Journal Entry and Purchase
 * Invoice 3) and it is comparable only as an ordering, never as a score out of a fixed maximum.
 *
 * The `| null` unions below are not defensive padding - each one is a column some branch really can
 * project as NULL, and the client used to be told otherwise:
 *  - `reference_no`: Bank Transaction sends `reference_number`, Payment Entry `reference_no`,
 *    Journal Entry `Max(cheque_no)` and Sales Invoice `Sales Invoice Payment.reference_no`, all
 *    nullable. Only the Purchase Invoice branch is guaranteed non-null, and only because it sends a
 *    constant empty string.
 *  - `reference_date`: nullable on Payment Entry and Journal Entry (`Max(cheque_date)`); a constant
 *    empty string on both invoice branches.
 *  - `party` / `party_type`: nullable on the Bank Transaction, Payment Entry and Journal Entry
 *    branches; constants on the invoice branches.
 *  - `currency`: nullable on Bank Transaction, Payment Entry (`paid_to/from_account_currency`) and
 *    Journal Entry (`Max(account_currency)`).
 */
export interface LinkedPayment {
    rank: number,
    doctype: string,
    name: string,
    paid_amount: number,
    reference_no: string | null,
    reference_date: string | null,
    posting_date: string,
    party_type?: string | null,
    party?: string | null,
    currency?: string | null
}

export const useGetBankTransactions = () => {
    const bankAccount = useAtomValue(selectedBankAccountAtom)
    const dates = useAtomValue(bankRecDateAtom)
    return useFrappeGetCall<{ message: BankTransaction[] }>('erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions', {
        bank_account: bankAccount?.name,
        from_date: dates.fromDate,
        to_date: dates.toDate,
        all_transactions: true
    }, bankAccount ? `bank-reconciliation-bank-transactions-${bankAccount?.name}-${dates.fromDate}-${dates.toDate}` : null)
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
            mutate(`bank-reconciliation-unreconciled-transactions-${selectedBank?.name}-${dates.fromDate}-${dates.toDate}`)
            mutate(`bank-reconciliation-account-closing-balance-${selectedBank?.name}-${dates.toDate}`)
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
        mutate(`bank-reconciliation-unreconciled-transactions-${selectedBank?.name}-${dates.fromDate}-${dates.toDate}`)
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
        mutate(`bank-reconciliation-account-closing-balance-${selectedBank?.name}-${dates.toDate}`)
    }

    return onReconcileTransaction

}

export const useReconcileTransaction = () => {

    const { call, loading } = useFrappePostCall<{ message: BankTransaction }>('erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.reconcile_vouchers')

    const onReconcileTransaction = useRefreshUnreconciledTransactions()

    const setBankRecUnreconcileModalAtom = useSetAtom(bankRecUnreconcileModalAtom)

    const addToActionLog = useUpdateActionLog()

    // FM1/FM3: the rejection path raises the shared dismissible dialog, clears the selection the
    // refused attempt was made against, and revalidates the two authoritative reads. Nothing is
    // mutated optimistically anywhere in this hook, which is what makes "a failure leaves the
    // transaction unreconciled with its state unchanged" true by construction rather than by rollback.
    const setErrorDialog = useSetAtom(bankRecErrorDialogAtom)
    const selectedBank = useAtomValue(selectedBankAccountAtom)
    const dates = useAtomValue(bankRecDateAtom)
    const setSelectedTransaction = useSetAtom(bankRecSelectedTransactionAtom(selectedBank?.name || ''))
    const { mutate } = useSWRConfig()

    /*
     * FM1/TC6: the SHARED single-flight guard, and the reason it is read from the jotai store rather
     * than from a subscribed value.
     *
     * `loading` above belongs to THIS hook instance, and every candidate voucher row instantiates the
     * hook for itself - so `loading` tells a row about its own request and nothing about any other
     * row's. Two candidates for the same transaction could therefore each dispatch a
     * `reconcile_vouchers` post while the other was still open, and the server would allocate against
     * whatever the transaction had left when each arrived: the outcome would depend on interleaving
     * rather than on what the reviewer chose.
     *
     * `inFlight` (subscribed) is what the ROWS render their disabled state from. `store.get`/`store.set`
     * is what the guard itself uses, because a subscribed value is a snapshot of the last render and
     * two dispatches in one tick would both read `null` from it. A jotai store write is synchronous
     * and immediately visible to the next `store.get`, so the check-and-set below is genuinely atomic
     * with respect to anything running on this thread.
     */
    const store = useStore()
    const inFlight = useAtomValue(bankRecReconcileInFlightAtom)

    const reconcileTransaction = (transaction: UnreconciledTransaction, voucher: LinkedPayment) => {

        // Refuse rather than queue. A second post is not a request the reviewer needs served later -
        // it is a request made without knowing the outcome of the first, and the first's response is
        // what re-reads the transaction's true remaining allocation.
        if (store.get(bankRecReconcileInFlightAtom) !== null) {
            return
        }
        store.set(bankRecReconcileInFlightAtom, transaction.name)

        call({
            bank_transaction_name: transaction.name,
            vouchers: JSON.stringify([{
                // These two fields are the whole of what the server consumes: `add_payment_entries`
                // reads `payment_doctype` and `payment_name` and appends the child row with
                // `allocated_amount: 0.0`, then `allocate_payment_entries` derives the real
                // allocation from the voucher's GL entries and its existing allocations against other
                // transactions. `amount` is sent for backwards compatibility with the legacy Desk
                // tool's payload and is IGNORED - the client does not and must not control allocation.
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
        }).catch((error) => {
            /*
             * A FIXED, redacted diagnostic (CWE-532/CWE-209). This used to be `console.error(error)`,
             * which dumped the whole `FrappeError` - including `exc`, the server's full Python
             * traceback, and `exception`, which names the failing module and line. A browser console
             * is readable by anything running in the page and is routinely captured by session
             * recorders and error-reporting SDKs, so that turned every refusal into an unintended
             * disclosure of server internals alongside the transaction identifier.
             *
             * Only the transaction name and the error's own type are logged, and only outside
             * production: the reviewer's authoritative account of the failure is the dialog below,
             * which carries the server's message and nothing else.
             */
            if (import.meta.env.DEV) {
                console.error('[bank-rec] reconcile_vouchers refused', {
                    bank_transaction: transaction.name,
                    exc_type: error?.exc_type ?? 'unknown'
                })
            }

            toast.error(_("Error"), {
                duration: 5000,
                description: getErrorMessage(error)
            })

            /*
             * FM1: raise the dismissible dialog with the server's error passed through UNMODIFIED,
             * so `ErrorBanner` parses `_server_messages` itself and the backend's own wording - for
             * example "Bank Transaction {0} is already fully reconciled" - reaches the reviewer
             * verbatim. Reshaping it here would break that parser.
             */
            setErrorDialog(error)

            /*
             * FM3, and it FAILS CLOSED.
             *
             * The refused attempt was made against a snapshot the server has just contradicted, so
             * that snapshot may not be allowed to authorise a second attempt. Clearing the selection
             * withdraws the Reconcile affordance outright - the voucher panel is rendered only while
             * a transaction is selected - so the action cannot be re-fired until the reviewer
             * re-selects a row, and re-selecting can only come from the refreshed list below and
             * issues a fresh `get_linked_payments`.
             *
             * This is deliberately NOT gated on the revalidation succeeding. A guard that waited for
             * an authoritative read and then reopened the action if the read failed would reopen it
             * in precisely the state where the client knows least. Withdrawing the affordance first
             * means an unavailable server costs the reviewer one extra click, never a post against
             * state nobody could confirm.
             */
            setSelectedTransaction([])

            /*
             * Revalidate the two reads whose rows drive the already-reconciled guard. The key strings
             * are the ones `useGetUnreconciledTransactions` and `useGetBankTransactions` construct
             * above and must stay character-identical to them; no new cache-key family is introduced.
             * Rejections are swallowed for the same reason as above - the affordance is already
             * closed, so a failed refresh has nothing left to protect.
             */
            mutate(`bank-reconciliation-unreconciled-transactions-${selectedBank?.name}-${dates.fromDate}-${dates.toDate}`)
                .catch(() => { /* refresh failure changes nothing: the selection is already cleared */ })
            mutate(`bank-reconciliation-bank-transactions-${selectedBank?.name}-${dates.fromDate}-${dates.toDate}`)
                .catch(() => { /* as above */ })
        }).finally(() => {
            /*
             * Released on BOTH outcomes, and only here. Releasing in the success handler alone would
             * strand the guard closed forever after a refusal - the reviewer could never reconcile
             * anything again without a reload - and releasing before the handlers ran would reopen the
             * affordance while the selection was still the contradicted snapshot the FM3 clear exists
             * to withdraw. `finally` runs after both, so the ordering is: server answers -> state is
             * brought in line with that answer -> the affordance reopens.
             */
            store.set(bankRecReconcileInFlightAtom, null)
        })
    }

    return {
        reconcileTransaction,
        /** This hook instance's own request, which is what draws the initiating row's spinner. */
        loading,
        /**
         * Whether ANY reconcile post is open, for the transaction it is open for. Every candidate
         * control must disable on this rather than on `loading`, or a second post can be dispatched
         * from a different row while the first is still unanswered.
         */
        inFlightTransaction: inFlight,
        isReconcileInFlight: inFlight !== null
    }

}

interface BankAccountWithCurrency extends Pick<BankAccount, 'name' | 'bank' | 'account_name' | 'is_credit_card' | 'company' | 'account' | 'account_type' | 'account_subtype' | 'bank_account_no' | 'last_integration_date'> {
    /**
     * Derived, not stored: `bank_account.get_list` follows `Bank Account.account` to
     * `Account.account_currency` and attaches the result to EVERY row (`bank_account.py:173-176`
     * assigns it in an unconditional loop).
     *
     * REQUIRED and NULLABLE, therefore - not optional. The key is always present, and
     * `Account.account_currency` is itself nullable, so a literal `null` is part of the contract while
     * an absent key is not. Declaring it optional modelled the wrong two possibilities: it let a
     * consumer treat a missing key as the normal case, and it let the persisted-selection shape (where
     * the key genuinely can be absent, because an old localStorage snapshot predates it) pass for an
     * endpoint row.
     */
    account_currency: string | null
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
        // Deliberately left as-is. These two flags are what make the already-reconciled guard in
        // `MatchAndReconcile` a real requirement rather than a theoretical one, and the plan this work
        // implements preserves them; the staleness they introduce is compensated for by the
        // rehydration below rather than by turning revalidation back on.
        revalidateOnFocus: false,
        revalidateIfStale: false,
        onSuccess: (data) => {
            onSuccess?.(data?.message)
        }
    })

    /*
     * REHYDRATION of the persisted selection, and the single authoritative reason this exists.
     *
     * `selectedBankAccountAtom` is an `atomWithStorage` over localStorage with `getOnInit: true`, and
     * `BankPicker` deliberately leaves the stored row ALONE whenever the account it names is still
     * present in a fresh response - it only ever writes when it has to choose an account. So the
     * stored row's fields, `account_currency` among them, are written once and then never refreshed
     * for as long as that account exists. If an administrator repoints the bank account at a GL
     * account in a different currency, or changes `Account.account_currency`, every consumer reading
     * the persisted row keeps the OLD code indefinitely - which for the FM5 advisory means warning
     * about a mismatch that no longer exists, or staying silent about one that now does, and for
     * amount formatting means rendering figures under the wrong currency symbol.
     *
     * Centralising the fix here rather than in `BankPicker` is what makes it complete: this hook is
     * the single subscriber to `bank_account.get_list`, so every consumer of the selection - the
     * workbench rows, the balance panels, the importer surfaces - is corrected at once, and no screen
     * is left reading a value another screen has already refreshed.
     *
     * Written only when the authoritative row DIFFERS from the stored one, compared field by field
     * through a stable serialisation. Without that test this would write on every render of every
     * consumer and re-render all of them; with it, the write happens once per genuine change and then
     * converges. The client-side logo members are preserved rather than recomputed, since they are not
     * part of the endpoint's projection.
     */
    const setSelectedBank = useSetAtom(selectedBankAccountAtom)
    const authoritativeRows = data?.message
    const store = useStore()

    useEffect(() => {
        if (!authoritativeRows) return

        const persisted = store.get(selectedBankAccountAtom)
        if (!persisted) return

        const authoritative = authoritativeRows.find((bank) => bank.name === persisted.name)
        if (!authoritative) return

        const refreshed: SelectedBank = { ...persisted, ...authoritative }

        if (JSON.stringify(refreshed) === JSON.stringify(persisted)) return

        setSelectedBank(refreshed)
    }, [authoritativeRows, setSelectedBank, store])

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
 * The account currency of the CURRENTLY SELECTED bank account — the ONE authoritative value every
 * consumer in this feature must resolve currency through, for both formatting and comparison.
 *
 * It reads the live `bank_account.get_list` response rather than the persisted selection directly.
 * The persisted row is now rehydrated from that same response by `useGetBankAccounts` above, so the
 * two agree; reading through this hook is nevertheless what callers should do, because it is
 * `undefined` in exactly the cases where the current currency is NOT KNOWN and a caller must not
 * pretend otherwise: while the list is loading, after a failed read, and when the selected account is
 * no longer in the response. All three mean "nothing to compare" — never "mismatch" — since an
 * advisory that is wrong in either direction is worse than none.
 *
 * Reading through `useGetBankAccounts` costs nothing extra: it is the same SWR entry `BankPicker` and
 * the balance panels already subscribe to, so this deduplicates onto the existing request rather than
 * issuing another one, and it resolves the value down exactly the path the server uses -
 * `Bank Account.account` -> `Account.account_currency`.
 */
export const useSelectedBankAccountCurrency = (): string | undefined => {

    const selectedBank = useAtomValue(selectedBankAccountAtom)

    const { banks } = useGetBankAccounts()

    return useMemo(
        () => banks?.find((bank) => bank.name === selectedBank?.name)?.account_currency ?? undefined,
        [banks, selectedBank?.name]
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