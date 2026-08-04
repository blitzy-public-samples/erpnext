import { BankAccount } from "@/types/Accounts/BankAccount";
import { getDatesForTimePeriod } from "@/lib/date";
import type { FrappeError } from "frappe-react-sdk";
import { atom } from "jotai";
import { atomWithStorage, createJSONStorage } from "jotai/utils";
import { atomFamily } from 'jotai-family'
import { UnreconciledTransaction } from "./utils";
import { BankTransaction } from "@/types/Accounts/BankTransaction";
import { PaymentEntry } from "@/types/Accounts/PaymentEntry";
import { JournalEntry } from "@/types/Accounts/JournalEntry";

export interface SelectedBank extends Pick<BankAccount, 'name' | 'bank' | 'is_credit_card' | 'company' | 'account_name' | 'bank_account_no' | 'account' | 'account_type' | 'integration_id' | 'is_default' | 'last_integration_date'> {
    logo?: string,
    logoDark?: string,
    darkModeInvert?: boolean,
    logoClassName?: string,
    /**
     * The GL account currency `bank_account.get_list` attaches per row by following
     * `Bank Account.account` -> `Account.account_currency`. It is not a native `Bank Account`
     * field, which is why it is optional here.
     *
     * `null` is part of the type because it is part of the payload: the endpoint always attaches
     * the key, and `Account.account_currency` is itself nullable, so a row can legitimately carry
     * a literal `null`. Typing it away would let a `null` be handed to a consumer that had been
     * told it could only ever be a string.
     */
    account_currency?: string | null
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
        // `null` as well as absent: a matched entry copies these straight off the candidate voucher,
        // and `get_linked_payments` projects both as nullable columns on the Bank Transaction,
        // Payment Entry and Journal Entry branches. Coercing the null away at the copy site would
        // record "no reference supplied" for a voucher whose reference the server reported as unset.
        reference_no?: string | null,
        reference_date?: string | null,
        posting_date: string,
        doc?: PaymentEntry | JournalEntry
    },
}

const actionLogStorage = createJSONStorage<ActionLog[]>(() => sessionStorage)

export const bankRecActionLog = atomWithStorage<ActionLog[]>('bank-rec-action-log', [], actionLogStorage, {
    getOnInit: true,
})

/* ------------------------------------------------------------------------------------------------
 * Failure-path state (FM1, FM2, FM3)
 *
 * Both atoms below are PLAIN IN-MEMORY atoms, and that deliberately diverges from every atom above
 * them: the bank selection, date range and match filters are `atomWithStorage` over localStorage and
 * the action log is `createJSONStorage` over sessionStorage. Neither of these may be persisted,
 * because both describe a single observation of a single failed request. A reload re-reads the
 * server, so a dialog or a marker that survived it would be asserting something about state nobody
 * has re-checked.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The rejection currently being reported by the shared dismissible error dialog, or `null` when the
 * dialog renders nothing - the same falsy-means-closed convention the modal atoms above use.
 *
 * The value is the Frappe error EXACTLY as the SDK handed it over, never reshaped: `ErrorBanner`
 * parses `_server_messages` itself and picks its own severity from the server's `indicator`, so
 * passing the object through by identity is what makes the server's own wording - for example
 * `"Bank Transaction {0} is already fully reconciled"` - reach the reviewer verbatim.
 *
 * One atom serves all three mount sites (the reconciliation workbench, the importer list and the
 * statement-import step), which live in different route trees, so the surfaces can never show
 * conflicting error state.
 */
export const bankRecErrorDialogAtom = atom<FrappeError | null>(null)

/**
 * Per-file import failures, keyed by `Bank Statement Import Log` name, holding the message the
 * server rejected the import with.
 *
 * FM2 requires the import status view to indicate failure per file, and this map is the only place
 * that can live: `Bank Statement Import Log` offers exactly two status values - `Not Started` and
 * `Completed` - and carries no error field of any kind. Because the import executes synchronously
 * and rolls back on failure, a refused import simply leaves the log at `Not Started`, indistinguishable
 * from one merely waiting to be imported. The marker is written from the observed synchronous
 * rejection and read by the importer list to render its third badge state.
 *
 * A `Map`, not a plain object. The keys are values the server minted, but they index a structure the
 * importer list reads with a membership test, and a plain `{}` answers that test for `__proto__`,
 * `constructor` and `toString` whether or not anything was ever recorded under them. A `Map` has no
 * inherited keys, so membership means exactly what it says, and it needs no separate escaping or
 * composite-key encoding to stay collision-free.
 */
export const bankRecImportFailuresAtom = atom<Map<string, string>>(new Map())