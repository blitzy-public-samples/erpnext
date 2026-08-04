import { BankAccount } from "@/types/Accounts/BankAccount";
import { getDatesForTimePeriod } from "@/lib/date";
import { atom } from "jotai";
import { atomWithStorage, createJSONStorage } from "jotai/utils";
import { atomFamily } from 'jotai-family'
import { UnreconciledTransaction } from "./utils";
import { BankTransaction } from "@/types/Accounts/BankTransaction";
import { PaymentEntry } from "@/types/Accounts/PaymentEntry";
import { JournalEntry } from "@/types/Accounts/JournalEntry";
import { FrappeError } from "frappe-react-sdk";

export interface SelectedBank extends Pick<BankAccount, 'name' | 'bank' | 'is_credit_card' | 'company' | 'account_name' | 'bank_account_no' | 'account' | 'account_type' | 'integration_id' | 'is_default' | 'last_integration_date'> {
    logo?: string,
    logoDark?: string,
    darkModeInvert?: boolean,
    logoClassName?: string,
    account_currency?: string
}
export const selectedBankAccountAtom = atomWithStorage<SelectedBank | null>('bank-rec-selected-bank', null, undefined, {
    getOnInit: true
})

export const bankRecDateAtom = atomWithStorage<{ fromDate: string, toDate: string }>("bank-rec-date", {
    fromDate: getDatesForTimePeriod('This Month').fromDate,
    toDate: getDatesForTimePeriod('This Month').toDate
})

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const bankRecClosingBalanceAtom = atomFamily((_id: string) => {
    return atom<{ value: number, stringValue: string | number | undefined }>({
        value: 0,
        stringValue: '0.00'
    })
})

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const bankRecSelectedTransactionAtom = atomFamily((_id: string) => {
    return atom<UnreconciledTransaction[]>([])
})

/** Action Modals */
export const bankRecTransferModalAtom = atom(false)
export const bankRecRecordPaymentModalAtom = atom(false)
export const bankRecRecordJournalEntryModalAtom = atom(false)

export const bankRecUnreconcileModalAtom = atom<string>('')

export const bankRecMatchFilters = atomWithStorage<string[]>('bank-rec-match-filters', ['payment_entry', 'journal_entry'])

export const bankRecSearchText = atom<string>('')
export const bankRecAmountFilter = atom<{ value: number, stringValue?: string | number }>({
    value: 0,
    stringValue: '0.00'
})
export const bankRecTransactionTypeFilter = atom<string>('All')

export interface ActionLog {
    type: 'match' | 'payment' | 'transfer' | 'bank_entry'
    isBulk: boolean
    timestamp: number,
    items: ActionLogItem[],
    bulkCommonData?: {
        party_type?: string,
        party?: string,
        account?: string,
        bank_account?: string,
    }
}

export interface ActionLogItem {
    bankTransaction: BankTransaction,
    voucher: {
        reference_doctype: string,
        reference_name: string,
        reference_no?: string,
        reference_date?: string,
        posting_date: string,
        doc?: PaymentEntry | JournalEntry
    },
}

const actionLogStorage = createJSONStorage<ActionLog[]>(() => sessionStorage)

export const bankRecActionLog = atomWithStorage<ActionLog[]>('bank-rec-action-log', [], actionLogStorage, {
    getOnInit: true,
})

/*
 * Failure-path state (FM1, FM2). Two atoms, and deliberately PLAIN IN-MEMORY ones rather than the
 * `atomWithStorage`/`createJSONStorage` their neighbours above use: each records a single observation
 * of a single request, and a reload re-reads the server, so a dialog or a per-file marker that
 * survived one would assert something nobody has re-checked.
 *
 * `bankRecErrorDialogAtom` is shared by all three dialog mount points - the reconciliation workbench,
 * the CSV statement-import step and the statement-importer list page - which live in two different
 * route trees; one atom is what guarantees those surfaces can never show conflicting error state.
 */

/**
 * The rejection the shared dismissible `BankRecErrorDialog` is currently reporting, or `null` when the
 * dialog renders nothing - the same falsy-means-closed convention `bankRecUnreconcileModalAtom` uses.
 *
 * The value is the Frappe error EXACTLY as the SDK handed it over, never reshaped: `ErrorBanner` parses
 * `_server_messages` itself and picks its severity from the server's own `indicator`, so passing the
 * object through by identity is what makes the server's wording - for example
 * `"Bank Transaction {0} is already fully reconciled"` - reach the reviewer verbatim.
 */
export const bankRecErrorDialogAtom = atom<FrappeError | null>(null)

/**
 * Per-file import failures, keyed by `Bank Statement Import Log` name, holding the raw rejection the
 * server refused the import with so the rendering layer parses it through the same shared path.
 *
 * FM2 requires the import status view to indicate failure per file, and this is the only place that
 * marker can live: `Bank Statement Import Log` offers exactly two status values - `Not Started` and
 * `Completed` - and carries no error field of any kind. Because the import executes synchronously and
 * rolls back on failure, a refused import simply leaves the log at `Not Started`, indistinguishable
 * from one merely waiting to be imported. The marker is therefore written from the observed
 * synchronous rejection and read by the importer list to render its third badge state.
 */
export const bankRecImportFailuresAtom = atom<Record<string, FrappeError>>({})
