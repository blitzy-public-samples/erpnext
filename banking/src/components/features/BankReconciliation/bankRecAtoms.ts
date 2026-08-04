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

/** One observed refusal of an upload that never got as far as producing an import log. */
export interface PreLogImportFailure {
    /** The `Bank Account` the upload was attempted against. */
    bankAccount: string
    /** The chosen file's name, as the browser reported it - the only identity the reviewer can see. */
    fileName: string
    /** The server's own words, parsed by the shared error parser. */
    message: string
}

/**
 * Import failures that happened BEFORE a `Bank Statement Import Log` existed, keyed by
 * {@link preLogImportFailureKey}.
 *
 * WHY A SECOND MAP RATHER THAN A KEY IN THE ONE ABOVE. The map above is keyed by log name, and these
 * failures are defined by NOT HAVING ONE. The whole first half of the upload chain runs before any
 * log is created - saving a PDF password onto the `Bank Account`, uploading the private `File`, and
 * the `Bank Statement Import Log` insert itself - and every refusal available there is a refusal the
 * reviewer most needs explaining: no permission on the bank account (the DocType is System Manager
 * only), a disabled or mis-configured account, a file the storage layer rejected, a file that is
 * empty or unreadable, a PDF whose password is wrong. None of those could be recorded per file,
 * because the row they would attach to is exactly what failed to come into being. Mixing a synthetic
 * key into a map the importer list membership-tests by log name would also make "is this log known
 * to have failed?" answerable by something that is not a log name.
 *
 * These entries are what the importer list renders as extra rows above the server's own, so a
 * pre-log refusal still produces the per-file failure indicator FM2 requires instead of vanishing
 * once the generic hook banner is replaced by the next render.
 *
 * PLAIN IN-MEMORY for the same reason as every other atom in this block: it records one observation
 * of one failed request, and a reload re-reads the server.
 */
export const bankRecPreLogImportFailuresAtom = atom<Map<string, PreLogImportFailure>>(new Map())

/**
 * The identity of an upload attempt: the bank account it targeted, plus enough of the chosen file to
 * tell one selection from another.
 *
 * `name` alone is not an identity - re-exporting a statement produces the same file name with
 * different contents - so `size` and `lastModified` are folded in. They are the only other
 * properties a browser `File` exposes without reading it, and together they distinguish a retry of
 * the SAME file (which must replace the previous verdict) from a genuinely different upload (which
 * must not).
 *
 * Joined with NUL rather than a printable separator: a file name may legally contain any of the
 * characters a reader would reach for first, and a name carrying the separator could otherwise
 * collide with a different account/file pair.
 */
export const preLogImportFailureKey = (
    bankAccount: string,
    file: Pick<File, 'name' | 'size' | 'lastModified'>
) => [bankAccount, file.name, file.size, file.lastModified].join('\u0000')

/**
 * The `Bank Transaction` a `reconcile_vouchers` post is CURRENTLY IN FLIGHT for, or `null` when
 * none is. It is the single-flight guard for the only financial write this feature performs.
 *
 * WHY THIS CANNOT BE HOOK STATE. `useReconcileTransaction` exposes a `loading` flag from
 * `useFrappePostCall`, and that flag is per HOOK INSTANCE - but every candidate voucher row calls
 * the hook for itself, so each row owns a private `loading` and learns nothing about any other
 * row's request. A reviewer could therefore start a post from the suggested match and, while it was
 * still open, start a SECOND post for the same transaction from another candidate. Both would be
 * accepted by the client and both would reach the server, which allocates against whatever the
 * transaction still has unallocated at the moment each arrives - so the outcome depended on
 * interleaving rather than on intent. Lifting the fact of "a post is open" into shared state is what
 * makes that impossible, because every row reads the same value.
 *
 * WHY IT HOLDS A NAME RATHER THAN A BOOLEAN. The name is what lets the guard be reported precisely
 * and asserted precisely, and it keeps a stale write from an unrelated transaction from silencing a
 * fresh one.
 *
 * PLAIN IN-MEMORY, for the same reason as the two atoms above: it describes one request that is open
 * right now. A reload cannot leave a request open, so a persisted value could only ever be a lie
 * that permanently disabled the affordance.
 *
 * NOTE FOR CALLERS: reading this through `useAtomValue` is correct for RENDERING the disabled state,
 * but it is NOT sufficient for the guard itself - a React state read is a snapshot of the last
 * render, so two clicks dispatched in one tick would both see `null`. The hook therefore
 * check-and-sets it SYNCHRONOUSLY through the jotai store (`useStore`), which is the only read that
 * cannot be stale.
 */
export const bankRecReconcileInFlightAtom = atom<string | null>(null)