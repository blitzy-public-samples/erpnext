import { ActionLog, bankRecActionLog, bankRecAmountFilter, bankRecDateAtom, bankRecErrorDialogAtom, bankRecMatchFilters, bankRecSearchText, bankRecSelectedTransactionAtom, bankRecTransactionTypeFilter, bankRecUnreconcileModalAtom, SelectedBank, selectedBankAccountAtom } from './bankRecAtoms'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useMemo } from 'react'
import { SWRConfiguration, useFrappeGetCall, useFrappeGetDoc, useFrappePostCall, useSWRConfig } from 'frappe-react-sdk'
import type { FrappeError } from 'frappe-react-sdk'
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

export interface LinkedPayment {
    rank: number,
    doctype: string,
    name: string,
    paid_amount: number,
    reference_no: string,
    reference_date: string,
    posting_date: string,
    party_type?: string,
    party?: string,
    currency: string
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

/**
 * Whether a rejection carries a response the server actually sent.
 *
 * The SDK builds its rejection from `error.response.data` and stamps `httpStatus` onto it, so a
 * numeric `httpStatus` means the server answered and that answer was read. Because `frappe.throw`
 * rolls the whole request back, such an answer is a **refusal**: nothing was posted.
 *
 * Without a response there is nothing to stamp - the SDK's own `error.response.data` access throws
 * first - so a request that never reached a readable answer lands here as an ordinary `Error`. It may
 * have been applied and its response lost, so its outcome is unknown and must not be reported as a
 * refusal.
 */
export const isServerRefusal = (error: unknown): boolean =>
    typeof (error as FrappeError | null)?.httpStatus === 'number'

export const useReconcileTransaction = () => {

    const { call, loading } = useFrappePostCall<{ message: BankTransaction }>('erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.reconcile_vouchers')

    const onReconcileTransaction = useRefreshUnreconciledTransactions()

    const setBankRecUnreconcileModalAtom = useSetAtom(bankRecUnreconcileModalAtom)

    const addToActionLog = useUpdateActionLog()

    const setBankRecErrorDialog = useSetAtom(bankRecErrorDialogAtom)
    const selectedBank = useAtomValue(selectedBankAccountAtom)
    const dates = useAtomValue(bankRecDateAtom)
    const matchFilters = useAtomValue(bankRecMatchFilters)
    const setSelectedTransaction = useSetAtom(bankRecSelectedTransactionAtom(selectedBank?.name || ''))
    const { mutate } = useSWRConfig()

    /**
     * Re-read the server after a post that did not succeed, and make the client agree with what came
     * back.
     *
     * Revalidating the lists alone is not enough: the selected transaction is held in its own atom, so
     * a row that the server now reports differently - or no longer reports as unreconciled at all -
     * would otherwise stay selected exactly as it was, and every guard computed from it (the
     * already-reconciled check on Reconcile among them) would keep reading the stale copy.
     */
    const convergeWithServer = async (transaction: UnreconciledTransaction) => {
        const [unreconciled] = await Promise.allSettled([
            mutate(`bank-reconciliation-unreconciled-transactions-${selectedBank?.name}-${dates.fromDate}-${dates.toDate}`),
            mutate(`bank-reconciliation-bank-transactions-${selectedBank?.name}-${dates.fromDate}-${dates.toDate}`),
            mutate(`bank-reconciliation-vouchers-${transaction.name}-${dates.fromDate}-${dates.toDate}-${matchFilters.join(',')}`),
        ])

        if (unreconciled.status !== 'fulfilled') {
            // The re-read itself failed, so there is no authoritative answer to converge on. Leaving the
            // selection untouched is the honest outcome: replacing it with a guess would be worse than
            // showing the user what they last saw alongside the error the dialog is already reporting.
            return
        }

        const rows: UnreconciledTransaction[] = unreconciled.value?.message ?? []
        setSelectedTransaction((previous) => previous
            .map((selected) => rows.find((row) => row.name === selected.name))
            .filter((row): row is UnreconciledTransaction => Boolean(row)))
    }

    const reconcileTransaction = (transaction: UnreconciledTransaction, voucher: LinkedPayment) => {

        /*
         * `then(onPosted, onNotPosted)` rather than `then(...).catch(...)`: a `catch` chained after the
         * success handler also catches whatever that handler throws, which would report a reconciliation
         * the server already committed as a backend refusal. The trailing `catch` below is therefore
         * reached only for a failure that happened AFTER the server's answer was known, and says so.
         */
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
        }, (error) => {
            console.error(error)

            /*
             * A readable server answer is a refusal, and only then may the client say nothing was
             * posted. Anything else never reached an answer, so the wording stays outcome-neutral: the
             * request may have been applied and its response lost, and the re-read below is what settles
             * it rather than this message.
             */
            const refused = isServerRefusal(error)
            toast.error(refused ? _("Reconciliation refused") : _("Could not confirm the reconciliation"), {
                duration: 5000,
                description: refused
                    ? getErrorMessage(error)
                    : _("The server did not answer, so it is not yet known whether this reconciliation was recorded. The transaction has been re-read below.")
            })

            /*
             * The rejection is handed to the shared dialog exactly as the SDK produced it - `ErrorBanner`
             * parses `_server_messages` and picks its severity from the server's own indicator, so
             * passing it through by identity is what makes the server's wording reach the reviewer
             * verbatim. Nothing is mutated optimistically anywhere, before or after.
             */
            setBankRecErrorDialog(error)
            return convergeWithServer(transaction)
        }).catch((error) => {
            /*
             * Reached only when one of the handlers above threw - i.e. after the server's answer was
             * already known. Presented outcome-neutrally and NOT routed to the error dialog, because
             * this is a client-side follow-up failure and not something the server said.
             */
            console.error(error)
            toast.error(_("The view could not be refreshed"), {
                duration: 5000,
                description: _("Reload the page to see the current state of this bank account. The server remains the authority on what was recorded.")
            })
        })
    }

    return { reconcileTransaction, loading }

}

interface BankAccountWithCurrency extends Pick<BankAccount, 'name' | 'bank' | 'account_name' | 'is_credit_card' | 'company' | 'account' | 'account_type' | 'account_subtype' | 'bank_account_no' | 'last_integration_date'> {
    /**
     * Present on every row and nullable, which is what `bank_account.get_list` actually returns: it
     * attaches this key in an unconditional loop after the query, from `Account.account_currency`,
     * which is itself nullable. Optional would allow a response this endpoint cannot produce and would
     * erase the difference from {@link SelectedBank}, where a stored snapshot may genuinely predate the
     * key.
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
 * The selected bank account's currency **as the server currently reports it**.
 *
 * Deliberately not read from `selectedBankAccountAtom`: that atom is `localStorage`-backed and is only
 * rewritten when the selection changes, so re-selecting the same account name replays a snapshot that
 * can be arbitrarily old. A currency advisory computed from it could contradict the very rule the
 * server applies.
 *
 * `bank_account.get_list` resolves `Bank Account.account` -> `Account.account_currency`, which is the
 * identical lookup `Bank Transaction.validate_currency` uses, so a value read from here cannot disagree
 * with the server. `undefined` means "not known yet, or the account carries no currency" - never
 * "different" - and the caller must treat it as nothing to compare.
 */
export const useSelectedBankAccountCurrency = (): string | undefined => {

    const selectedBank = useAtomValue(selectedBankAccountAtom)
    const { banks, isLoading } = useGetBankAccounts()

    return useMemo(() => {
        // Until the list has arrived there is no current answer, and the persisted snapshot is exactly
        // the value this hook exists to avoid.
        if (isLoading) return undefined

        const current = banks?.find((bank) => bank.name === selectedBank?.name)
        return current?.account_currency ?? undefined
    }, [banks, isLoading, selectedBank?.name])
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