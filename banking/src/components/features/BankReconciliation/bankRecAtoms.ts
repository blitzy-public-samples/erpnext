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

// Keep transient reconciliation errors in memory so stale dialogs and per-file
// failure markers do not survive a page reload.

/**
 * Drives the shared, dismissible `BankRecErrorDialog`.
 *
 * This atom carries the server's OWN error envelope, unmodified. Both writers
 * (`useReconcileTransaction` and the statement-import step) store what the transport handed
 * them; a substitute object is used only when the rejection never reached the server, in which
 * case there is no server text to preserve. The server's wording must reach the user verbatim,
 * because it is the sole authority on what was and was not recorded.
 *
 * TRUST BOUNDARY: safety is enforced at the RENDER SINKS, not here, and in two independent
 * places. `BankRecErrorDialog` renders every parsed message as PLAIN TEXT, so no markup in an
 * error can be interpreted; and `ui/markdown.tsx` applies an allow-list sanitiser after
 * `rehypeRaw`, which covers the inline `ErrorBanner` call sites that do render markdown. Either
 * one alone would close the hole; both are present deliberately.
 *
 * Memory-only storage keeps a stale dialog from surviving a page reload; it is not what makes
 * the content safe.
 */
export const bankRecErrorDialogAtom = atom<FrappeError | null>(null)

/**
 * What the client managed to establish about one import ATTEMPT.
 *
 *  - `failed`  - the server was asked afterwards and reported a status other than
 *    `Completed`, so the import demonstrably did not take effect.
 *  - `unknown` - the attempt was rejected but the server could not be asked, or did not
 *    answer with a status. The client does not know what happened and must not claim it does:
 *    a rejected request may still have been applied with only the response lost.
 */
export type ImportAttemptStatus = 'failed' | 'unknown'

/**
 * Transient, session-scoped markers for import attempts, keyed by `Bank Statement Import Log`
 * NAME. They exist only because that DocType persists no error field and its status
 * enumeration has just two values, so a synchronous import that rolls back leaves nothing at
 * all behind for the list to read.
 *
 * SERVER AUTHORITY: a marker is an OBSERVATION, never a verdict. It is written only after the
 * server has been asked what the log actually says, and it is RETIRED as soon as any
 * authoritative read reports `Completed` - by the import step itself and again by the importer
 * list, which re-fetches the logs from the server. Every consumer must let the fetched
 * `status` win, so a stale marker can never outrank server truth.
 *
 * No error object is retained here - a marker is one of two string literals. The message
 * belongs to `bankRecErrorDialogAtom`, which is cleared on dismissal; keeping a rejection
 * payload in this longer-lived map would hand an untrusted value a second and much
 * longer-lived path to a render. The writer also BOUNDS the map, evicting oldest-first at
 * `IMPORT_FAILURE_LIMIT`, so a long session cannot grow it without limit.
 */
export const bankRecImportFailuresAtom = atom<Record<string, ImportAttemptStatus>>({})
