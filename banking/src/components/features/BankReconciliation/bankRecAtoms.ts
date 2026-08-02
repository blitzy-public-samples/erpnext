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
import { BankStatementImportLog } from "@/types/Accounts/BankStatementImportLog";

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
        // Nullable, not merely optional: when the logged voucher came from
        // `get_linked_payments`, these carry that endpoint's own values, and it supplies a
        // constant empty string for both invoice branches and can supply NULL for a Journal
        // Entry. The log records what the server said rather than laundering NULL into
        // `undefined`.
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
 * TRUST BOUNDARY: safety is enforced at the RENDER SINK, not here. Every consumer of this
 * atom - the dialog and the ~20 inline call sites alike - renders through the shared
 * `ErrorBanner`, and therefore through `ui/markdown.tsx`, which applies an allow-list
 * sanitiser AFTER `rehypeRaw`: scripts, styles, frames, media, form controls, every `on*`
 * handler, `style`, and (to close CWE-451 UI redress, since this application's utility classes
 * ship in the stylesheet) `class` and `id` are all removed, and links survive only when they
 * point back at this application. One sanitiser on the single shared path is deliberate - a
 * second, divergent renderer here is exactly what would let the dialog and a banner disagree
 * about the same rejection.
 *
 * Memory-only storage keeps a stale dialog from surviving a page reload; it is not what makes
 * the content safe.
 */
export const bankRecErrorDialogAtom = atom<FrappeError | null>(null)

/**
 * True while a reconciliation attempt's outcome is still being established against the server -
 * from the moment the post is dispatched until, on a rejection, the transaction lists have been
 * re-read and the selection rebuilt from them.
 *
 * It is SHARED rather than local to the hook because `useReconcileTransaction` is instantiated once
 * per candidate voucher row, while all of those rows confirm the SAME selected transaction. A flag
 * held inside one hook instance would close only the row that was clicked and leave every sibling
 * row offering the identical action against a snapshot the client has just been told is unreliable.
 * One atom closes them all, which is the only version of that guarantee worth having.
 *
 * Memory-only, and deliberately not persisted: a reload starts from the server's state, so a flag
 * describing an attempt from a previous page life would be describing nothing.
 */
export const bankRecReconcileSettlingAtom = atom(false)

/**
 * What the client managed to establish about one import ATTEMPT.
 *
 *  - `failed`  - the SERVER ITSELF refused the import, and a follow-up read confirmed the log is
 *    still not `Completed`. Both halves are required. This is the only status that asserts the
 *    import did not take effect.
 *  - `unknown` - the attempt did not succeed, but nothing observed amounts to the server saying
 *    so. The client does not know what happened and must not claim it does.
 */
export type ImportAttemptStatus = 'failed' | 'unknown'

/**
 * Import-attempt markers, keyed by BANK ACCOUNT name and then by `Bank Statement Import Log` name.
 *
 * WHY BANK-SCOPED. The importer list is a per-bank query with its own row limit, so both
 * visibility and lifetime of a marker are properties of one bank account, not of the session. A
 * single flat map bounded by the list's page size conflated the two: markers from other accounts
 * counted against the budget, so switching accounts could evict a marker whose row was still on
 * screen, and the eviction was silent. Nesting by bank makes the cap mean what it says - "as many
 * markers as this bank's list can show" - and makes retirement operate only on the account whose
 * logs were actually re-read.
 */
export type ImportAttemptMarkers = Record<string, Record<string, ImportAttemptStatus>>

/**
 * How many markers are retained PER BANK ACCOUNT. Matched to the importer list's `limit`, which is
 * now a sound comparison because both sides count the same thing: rows for one account.
 */
export const IMPORT_ATTEMPT_MARKER_LIMIT = 10

/**
 * What the client observed about a rejected import attempt, as inputs to the classification below.
 *
 * `serverRejected` means the rejection carried a genuine Frappe error envelope - the server
 * received the request, refused it, and said so. A rejection with no envelope means no usable
 * response came back at all, which is a statement about the connection and NOT about the server.
 *
 * `confirmedStatus` is the status a follow-up read of the log obtained, or `undefined` when no
 * status could be obtained.
 */
export type ImportAttemptObservation = {
    serverRejected: boolean
    confirmedStatus?: BankStatementImportLog['status']
}

/**
 * Decides what an import attempt may be recorded as. This is the ONLY sanctioned way to arrive at
 * an `ImportAttemptStatus`, which is why it takes a structured observation rather than a status: a
 * caller cannot express "mark this failed" directly, only "here is what I saw".
 *
 * Returns `'completed'` when the import in fact succeeded and no marker belongs, or an
 * `ImportAttemptStatus` otherwise.
 *
 * THE RULE, AND WHY `Not Started` IS NOT A FAILURE. `Not Started` is the INITIAL value of the
 * status field, and `insert_transactions` only advances it to `Completed` as its very last act,
 * after writing the transactions. It is therefore a NONTERMINAL state for the whole duration of a
 * synchronous import, and observing it says nothing on its own - the import may have rolled back,
 * may still be running, or may have committed with only the response lost. Treating it as failure
 * because a response went missing is the client inventing a server-side fact, and it is the
 * dangerous direction to be wrong in: a reviewer told the import failed will re-import, and a
 * re-import that finds the first one did land creates duplicate work.
 *
 * So `failed` requires the server to have actually refused. Absent that, anything short of a
 * confirmed `Completed` is `unknown`.
 */
export const classifyImportAttempt = (observation: ImportAttemptObservation): ImportAttemptStatus | 'completed' => {

    // Server truth outranks everything, including an envelope that arrived alongside it: if the
    // log says the import completed, it completed.
    if (observation.confirmedStatus === 'Completed') {
        return 'completed'
    }

    // The server answered with a refusal AND the log confirms it is not completed. Only now is
    // "this import did not take effect" something the client has been told rather than guessed.
    if (observation.serverRejected && observation.confirmedStatus !== undefined) {
        return 'failed'
    }

    return 'unknown'
}

/** Records a marker for one log within one bank, evicting that bank's oldest beyond the limit. */
export const withImportAttempt = (
    markers: ImportAttemptMarkers,
    bankAccountName: string,
    importLogName: string,
    status: ImportAttemptStatus
): ImportAttemptMarkers => {

    const forBank = markers[bankAccountName] ?? {}

    if (forBank[importLogName] === status) {
        return markers
    }

    const others = Object.keys(forBank).filter((name) => name !== importLogName)
    const retained = others.slice(Math.max(0, others.length + 1 - IMPORT_ATTEMPT_MARKER_LIMIT))

    const cappedForBank: Record<string, ImportAttemptStatus> = {}
    retained.forEach((name) => { cappedForBank[name] = forBank[name] })
    cappedForBank[importLogName] = status

    return { ...markers, [bankAccountName]: cappedForBank }
}

/** Retires one log's marker. A marker must never outlive the condition it described. */
export const withoutImportAttempt = (
    markers: ImportAttemptMarkers,
    bankAccountName: string,
    importLogName: string
): ImportAttemptMarkers => {

    const forBank = markers[bankAccountName]

    if (forBank === undefined || forBank[importLogName] === undefined) {
        return markers
    }

    const remaining = Object.fromEntries(Object.entries(forBank).filter(([name]) => name !== importLogName))

    if (Object.keys(remaining).length === 0) {
        return Object.fromEntries(Object.entries(markers).filter(([name]) => name !== bankAccountName))
    }

    return { ...markers, [bankAccountName]: remaining }
}

/**
 * Retires every marker in ONE bank whose log an authoritative read reports as `Completed`.
 *
 * Scoped to a single bank because that is the scope of the read that justifies it: a list query
 * for one account is evidence about that account's logs and about nothing else.
 */
export const withCompletedImportAttemptsRetired = (
    markers: ImportAttemptMarkers,
    bankAccountName: string,
    completedLogNames: string[]
): ImportAttemptMarkers => {

    const forBank = markers[bankAccountName]

    if (forBank === undefined) {
        return markers
    }

    const stale = completedLogNames.filter((name) => forBank[name] !== undefined)

    if (stale.length === 0) {
        return markers
    }

    const remaining = Object.fromEntries(Object.entries(forBank).filter(([name]) => !stale.includes(name)))

    if (Object.keys(remaining).length === 0) {
        return Object.fromEntries(Object.entries(markers).filter(([name]) => name !== bankAccountName))
    }

    return { ...markers, [bankAccountName]: remaining }
}

/** Reads one log's marker. Returns `undefined` when nothing was recorded for it. */
export const getImportAttempt = (
    markers: ImportAttemptMarkers,
    bankAccountName: string | undefined,
    importLogName: string
): ImportAttemptStatus | undefined => bankAccountName ? markers[bankAccountName]?.[importLogName] : undefined

/**
 * Transient, session-scoped markers for import attempts, nested by bank account and then by
 * `Bank Statement Import Log` name. They exist only because that DocType persists no error field
 * and its status enumeration has just two values, so a synchronous import that rolls back leaves
 * nothing at all behind for the list to read.
 *
 * SERVER AUTHORITY: a marker is an OBSERVATION, never a verdict. It is written only after the
 * server has been asked what the log actually says, and it is RETIRED as soon as any
 * authoritative read reports `Completed` - by the import step itself and again by the importer
 * list, which re-fetches the logs from the server. Every consumer must let the fetched
 * `status` win, so a stale marker can never outrank server truth.
 *
 * WRITE ONLY THROUGH THE HELPERS ABOVE. `classifyImportAttempt` decides what may be recorded and
 * `withImportAttempt` / `withoutImportAttempt` / `withCompletedImportAttemptsRetired` perform the
 * transitions. Writing a literal status straight into this map is what allowed an ambiguous
 * `Not Started` to be promoted to `failed`; routing every write through a function that takes an
 * OBSERVATION rather than a verdict removes the opportunity to do it again.
 *
 * No error object is retained here - a marker is one of two string literals. The message
 * belongs to `bankRecErrorDialogAtom`, which is cleared on dismissal; keeping a rejection
 * payload in this longer-lived map would hand an untrusted value a second and much
 * longer-lived path to a render. The helpers also BOUND the map per bank at
 * `IMPORT_ATTEMPT_MARKER_LIMIT`, so a long session cannot grow it without limit.
 */
export const bankRecImportFailuresAtom = atom<ImportAttemptMarkers>({})

/**
 * Files that failed BEFORE any import log existed, keyed by the file name the user chose.
 *
 * The upload flow uploads the file, then creates the log, then navigates. A rejection in either of
 * the first two steps means there is no document, hence no row in the importer list and nothing a
 * log-keyed marker could ever attach to - yet FM2 requires an empty or malformed file to be
 * reported per file. This map is that report, and it is keyed by file name because that is the only
 * identifier the failure has.
 *
 * Memory-only and cleared as soon as the same file is retried, so it describes only the attempt the
 * user can still see in the form.
 */
export const bankRecPreImportFailuresAtom = atom<Record<string, FrappeError>>({})
