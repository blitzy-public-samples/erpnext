import { BankAccount } from "@/types/Accounts/BankAccount";
import { getDatesForTimePeriod } from "@/lib/date";
import { atom } from "jotai";
import type { SetStateAction } from "jotai";
import { atomWithStorage, createJSONStorage } from "jotai/utils";
import { atomFamily } from 'jotai-family'
import { UnreconciledTransaction } from "./utils";
import { BankTransaction } from "@/types/Accounts/BankTransaction";
import { PaymentEntry } from "@/types/Accounts/PaymentEntry";
import { JournalEntry } from "@/types/Accounts/JournalEntry";
import type { FrappeError } from "frappe-react-sdk";

export interface SelectedBank extends Pick<BankAccount, 'name' | 'bank' | 'is_credit_card' | 'company' | 'account_name' | 'bank_account_no' | 'account' | 'account_type' | 'integration_id' | 'is_default' | 'last_integration_date'> {
    logo?: string,
    logoDark?: string,
    darkModeInvert?: boolean,
    logoClassName?: string,
    /**
     * Optional AND nullable, unlike the endpoint projection it is copied from: this is a persisted
     * snapshot, so it may predate the key entirely (`undefined`) as well as carry the endpoint's own
     * `null` for an account whose GL account has no currency.
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

/**
 * The identity of a selection: the bank account AND the date range it was made in.
 *
 * Keying on the account alone made a selection outlive the range it belonged to. Moving from August to
 * July kept an August row selected, so the workbench went on offering live create-and-reconcile actions
 * for a transaction that was no longer in the list at all.
 */
export const selectedTransactionScopeKey = (
    bankAccount: string | undefined | null,
    dates: { fromDate: string, toDate: string }
) => `${bankAccount ?? ''}::${dates.fromDate}::${dates.toDate}`

/** One shared identity for "nothing selected", so a scope change cannot churn consumers that watch it. */
const NO_SELECTION: UnreconciledTransaction[] = []

/**
 * The selection AND the scope it was made in, held together in one atom deliberately.
 *
 * A keyed family would retain a selection per scope, so leaving a scope and coming back would replay
 * whatever had been selected there before, however stale - the account-keyed family it replaced did
 * exactly that, resurrecting a previous selection on switching banks back. Stamping the single retained
 * selection with its scope makes that impossible: a scope change orphans it, and it is never read again.
 */
const bankRecScopedSelectionAtom = atom<{ scope: string, transactions: UnreconciledTransaction[] }>({
    scope: '',
    transactions: NO_SELECTION
})

/**
 * The rows under review in the CURRENT scope, read and written without naming that scope.
 *
 * A derived atom rather than a hook, so that changing the account or the date range switches scope
 * everywhere at once - the workbench, the three creation modals and the reconcile hook all read this one
 * atom, and none of them has to remember to compose the key the same way.
 */
export const bankRecSelectedTransactionsAtom = atom(
    (get) => {
        const scope = selectedTransactionScopeKey(get(selectedBankAccountAtom)?.name, get(bankRecDateAtom))
        const held = get(bankRecScopedSelectionAtom)

        // Out of scope means gone, not hidden: nothing can read it back.
        return held.scope === scope ? held.transactions : NO_SELECTION
    },
    (get, set, update: SetStateAction<UnreconciledTransaction[]>) => {
        const scope = selectedTransactionScopeKey(get(selectedBankAccountAtom)?.name, get(bankRecDateAtom))
        const held = get(bankRecScopedSelectionAtom)

        // An updater function composes on the CURRENT scope's selection, never on another scope's.
        const base = held.scope === scope ? held.transactions : NO_SELECTION
        const transactions = typeof update === 'function' ? update(base) : update

        set(bankRecScopedSelectionAtom, { scope, transactions })
    }
)

/** Action Modals */
export const bankRecTransferModalAtom = atom(false)
export const bankRecRecordPaymentModalAtom = atom(false)
export const bankRecRecordJournalEntryModalAtom = atom(false)

export const bankRecUnreconcileModalAtom = atom<string>('')

export const bankRecMatchFilters = atomWithStorage<string[]>('bank-rec-match-filters', ['payment_entry', 'journal_entry'])

export const bankRecSearchText = atom<string>('')
/**
 * The amount filter: the number it filters on, and the text the field displays.
 *
 * The text starts EMPTY, not at `'0.00'`. A pre-filled zero looked identical to the placeholder while
 * actually being a typed value, so a reviewer's first keystroke appended to it, and "the box has
 * something in it" could not be used to decide whether there was anything to reset. `Clear Filters`
 * returns it to this same empty state, so at-rest and after-reset are now the one state rather than two.
 */
export const bankRecAmountFilter = atom<{ value: number, stringValue?: string | number }>({
    value: 0,
    stringValue: ''
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
 * Failure-path state. In-memory by default, unlike the persisted atoms above: each records one
 * observation of one request, and a reload re-reads the server, so a value that survived a reload
 * would generally assert something nothing has re-checked. The import-failure map below is the one
 * documented exception, for the reason given on it.
 */

/** The rejection the shared dismissible `BankRecErrorDialog` is reporting; `null` closes it. */
export const bankRecErrorDialogAtom = atom<FrappeError | null>(null)

const importFailureStorage = createJSONStorage<Record<string, FrappeError>>(() => sessionStorage)

/**
 * Import failures observed in this session, keyed by `Bank Statement Import Log` name. The DocType has
 * no error field and only `Not Started`/`Completed`, and a failed import rolls back, so a failure is
 * not recoverable from the row itself - which is exactly why it has to be recorded here.
 *
 * PERSISTED, unlike its neighbours, and the reason it is the exception rather than a contradiction:
 * the general rule holds because a reload re-reads the server and the server can answer. Here it
 * cannot - it persists nothing about the refusal and reports the row as one nobody has tried yet - so
 * dropping the marker on reload does not defer to the server, it simply loses the only record that the
 * import was refused, and the reviewer comes back to a row that looks untouched. Nor is the marker
 * unchecked: `StatementImportLog` re-validates every marker against the fetched rows on each load and
 * retires any the server has overtaken, so the server still has the last word - it just gets it a
 * moment later rather than by default.
 *
 * `sessionStorage`, not `localStorage`: an observation about a request belongs to the sitting that made
 * it. Surviving a reload and a navigation is the requirement; surviving a browser restart, days later,
 * would be asserting something about a file nobody remembers uploading.
 *
 * Holds the raw `FrappeError`, which the SDK produces as a plain object of primitives and therefore
 * round-trips through JSON intact - so the persisted marker still renders through the same shared error
 * path as the live one.
 */
export const bankRecImportFailuresAtom = atomWithStorage<Record<string, FrappeError>>(
    'bank-rec-import-failures',
    {},
    importFailureStorage,
    { getOnInit: true }
)

/** A refusal the reviewer has already been shown, kept so the reason outlives the dialog. */
export interface BankRecRefusal {
    /** The rejection exactly as the SDK produced it, so the server's own wording can be re-rendered. */
    error: FrappeError
    /** The transaction the refused attempt was made against. */
    transactionName: string
    /** Whether the server answered - a refusal - as opposed to the request never reaching an answer. */
    refused: boolean
}

/**
 * The last refused reconciliation, which survives dismissing the dialog.
 *
 * Dismissing the dialog used to take the only explanation with it: the reviewer was left looking at a
 * pane whose selected row had silently disappeared, with nothing on screen saying why. This keeps the
 * reason in place until they dismiss it themselves or start another attempt. In memory only - a reload
 * re-reads the server, so a refusal that outlived one would be asserting something nothing had
 * re-checked.
 */
export const bankRecLastRefusalAtom = atom<BankRecRefusal | null>(null)
