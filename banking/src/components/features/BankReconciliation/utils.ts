import { ActionLog, bankRecActionLog, bankRecAmountFilter, bankRecDateAtom, bankRecErrorDialogAtom, bankRecMatchFilters, bankRecSearchText, bankRecSelectedTransactionAtom, bankRecTransactionTypeFilter, bankRecUnreconcileModalAtom, SelectedBank, selectedBankAccountAtom } from './bankRecAtoms'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useMemo } from 'react'
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

    return useFrappeGetCall<{ message: { balance: number, date?: string } }>("erpnext.accounts.doctype.bank_account.bank_account.get_closing_balance_as_per_statement", {
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

    const reconcileTransaction = (transaction: UnreconciledTransaction, voucher: LinkedPayment) => {

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
            console.error(error)
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
        })
    }

    return { reconcileTransaction, loading }

}

interface BankAccountWithCurrency extends Pick<BankAccount, 'name' | 'bank' | 'account_name' | 'is_credit_card' | 'company' | 'account' | 'account_type' | 'account_subtype' | 'bank_account_no' | 'last_integration_date'> {
    /**
     * Derived, not stored: `bank_account.get_list` follows `Bank Account.account` to
     * `Account.account_currency` and attaches the result to every row. The key is always present, and
     * `Account.account_currency` is itself nullable, so a literal `null` is part of the contract.
     */
    account_currency?: string | null
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
 * The account currency of the CURRENTLY SELECTED bank account, resolved from the live
 * `bank_account.get_list` response rather than from the persisted selection.
 *
 * The distinction is the whole point of this hook. `selectedBankAccountAtom` is an `atomWithStorage`
 * over localStorage with `getOnInit: true`, and `BankPicker` deliberately leaves the stored row
 * alone whenever the account it names is still present in a fresh response - so the snapshot's
 * `account_currency` is written once and then never refreshed for as long as the account exists. If
 * an administrator repoints the bank account at an account in a different currency, or changes
 * `Account.account_currency`, the snapshot keeps the old code indefinitely. Any comparison made
 * against it can therefore contradict the server's own view, which for the FM5 currency advisory
 * means warning about a mismatch that no longer exists, or staying silent about one that does.
 *
 * Reading through `useGetBankAccounts` costs nothing extra: it is the same SWR entry `BankPicker` and
 * the balance panels already subscribe to, so this deduplicates onto the existing request rather than
 * issuing another one, and it resolves the value down exactly the path the server uses -
 * `Bank Account.account` -> `Account.account_currency`.
 *
 * Returns `undefined` while the list is loading, when the request failed, or when the selected
 * account is no longer in it - all three mean "the current currency is not known", which callers must
 * treat as nothing to compare rather than as a mismatch.
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