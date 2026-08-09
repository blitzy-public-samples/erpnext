import BankPicker from "@/components/features/BankReconciliation/BankPicker"
import BankRecErrorDialog from "@/components/features/BankReconciliation/BankRecErrorDialog"
import { bankRecImportFailuresAtom, bankRecUploadRefusalsAtom, MAX_UPLOAD_REFUSALS, selectedBankAccountAtom, uploadRefusalKey } from "@/components/features/BankReconciliation/bankRecAtoms"
import type { BankRecUploadRefusal } from "@/components/features/BankReconciliation/bankRecAtoms"
import CompanySelector from "@/components/features/BankReconciliation/CompanySelector"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import ErrorBanner from "@/components/ui/error-banner"
import { FileDropzone } from "@/components/ui/file-dropzone"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { H2, Paragraph } from "@/components/ui/typography"
import { useCurrentCompany } from "@/hooks/useCurrentCompany"
import { formatDate } from "@/lib/date"
import { flt, formatCurrency } from "@/lib/numbers"
import { makeClientRefusal } from "@/lib/frappe"
import _ from "@/lib/translate"
import { cn } from "@/lib/utils"
import { BankStatementImportLog } from "@/types/Accounts/BankStatementImportLog"
import { FrappeContext, useFrappeCreateDoc, useFrappeFileUpload, useFrappeGetDocList, useFrappeUpdateDoc } from "frappe-react-sdk"
import type { FrappeConfig, FrappeError } from "frappe-react-sdk"
import { useAtom, useAtomValue } from "jotai"
import { ListIcon, Loader2Icon } from "lucide-react"
import { useContext, useEffect, useState } from "react"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"
import { bankRecErrorDialogAtom } from "@/components/features/BankReconciliation/bankRecAtoms"


/**
 * The statement formats this surface accepts, in the shape react-dropzone wants.
 *
 * Module-level and SINGLE-SOURCE deliberately. The prose beside the dropzone used to name the formats
 * independently of this map and had fallen out of step with it - it said "CSV, XLSX and PDF" while the
 * map has always also accepted `.xls`, so a reviewer holding a perfectly importable `.xls` was told the
 * app would not take it. The copy is now DERIVED from the map below, so the two cannot disagree again.
 *
 * XML is commented out here rather than absent: MT-940/XML ingestion exists only on the legacy desk
 * importer and is explicitly out of scope for this surface, and the comment is what stops it being
 * re-added by accident.
 */
const STATEMENT_ACCEPT: Record<string, string[]> = {
    'text/csv': ['.csv'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
    'application/vnd.ms-excel': ['.xls'],
    'application/pdf': ['.pdf'],
    // 'application/xml': ['.xml'],
}

/** Ties the unmet-prerequisites text to the Upload button, so a screen reader reads them together. */
const UPLOAD_REQUIREMENTS_ID = 'bank-statement-upload-requirements'

/** "CSV, XLSX, XLS and PDF" - built from {@link STATEMENT_ACCEPT} so the prose cannot drift from it. */
const SUPPORTED_STATEMENT_FORMATS = (() => {
    const extensions = Object.values(STATEMENT_ACCEPT)
        .flat()
        .map((extension) => extension.replace('.', '').toUpperCase())

    if (extensions.length < 2) {
        return extensions.join('')
    }

    return `${extensions.slice(0, -1).join(', ')} ${_("and")} ${extensions[extensions.length - 1]}`
})()

const BankStatementImporter = () => {

    const selectedCompany = useCurrentCompany()

    const [selectedBankAccount] = useAtom(selectedBankAccountAtom)

    const [files, setFiles] = useState<File[]>([])
    const [password, setPassword] = useState("")

    /*
     * Typed with the two fields this page actually reads off the created `File`, rather than left as
     * the hook's default `any`: `file_url` is what the import log is created against, and `name` is
     * what the placeholder attachment is discarded by below.
     */
    const { upload, error, loading } = useFrappeFileUpload<{ name: string, file_url: string }>()

    const { db } = useContext(FrappeContext) as FrappeConfig

    const navigate = useNavigate()
    const { createDoc, loading: createLoading, error: createError } = useFrappeCreateDoc<BankStatementImportLog>()
    const { updateDoc, error: updateError } = useFrappeUpdateDoc()

    const [bankRecErrorDialog, setBankRecErrorDialog] = useAtom(bankRecErrorDialogAtom)

    /*
     * Every upload this sitting has refused, keyed by the identity of the file it refused.
     *
     * This deliberately does NOT go in `bankRecImportFailuresAtom`: that map is keyed by `Bank Statement
     * Import Log` name and pruned against the fetched rows, and a refusal here happens before creation
     * succeeds - there is no name to key it against and no row to hang it from. So the FILE is the key.
     *
     * It used to be a single component-local file name, cleared at the top of every attempt and lost on
     * any change of selection or reload - which meant the record of a refusal was destroyed by the two
     * things a reviewer does next: pick another file, or reload the list to see what happened. The
     * server keeps no record either, because no import log was created, so nothing else in the system
     * remembered the attempt at all.
     */
    const [uploadRefusals, setUploadRefusals] = useAtom(bankRecUploadRefusalsAtom)

    /**
     * Record a refusal against the file it refused, retiring the oldest once the bound is reached.
     *
     * Keyed by name+size+modification time, so correcting the file and uploading it again starts clean
     * while re-selecting the same unrefused-since file re-shows what it earned.
     */
    const recordUploadRefusal = (file: File | undefined, refusal: FrappeError) => {
        if (!file) {
            return
        }

        const key = uploadRefusalKey(file)

        setUploadRefusals((existing) => {
            const next: Record<string, BankRecUploadRefusal> = {
                ...existing,
                [key]: { fileName: file.name, error: refusal, at: Date.now() }
            }

            const keys = Object.keys(next)
            if (keys.length <= MAX_UPLOAD_REFUSALS) {
                return next
            }

            // Oldest first, so what is dropped is the least recent rather than whichever the object
            // happened to enumerate first.
            const retire = keys
                .sort((a, b) => next[a].at - next[b].at)
                .slice(0, keys.length - MAX_UPLOAD_REFUSALS)

            return Object.fromEntries(Object.entries(next).filter(([name]) => !retire.includes(name)))
        })
    }

    /** The refusal recorded against the file currently chosen, if that file has one. */
    const selectedFileRefusal = files[0] ? uploadRefusals[uploadRefusalKey(files[0])] : undefined

    /*
     * Whether an upload attempt is in flight, tracked HERE rather than read off the hooks.
     *
     * The hooks cannot answer this on their own. An attempt is a chain of up to three requests - save the
     * PDF password, upload the file, create the import log - and each hook's `loading` covers only its own
     * leg, so between legs every one of them reads false while the attempt is very much still running.
     * That left the Upload button live during the password leg, so a second click could start a second
     * attempt over the top of the first.
     *
     * It also gives the per-file failure indicator something honest to gate on: a file being retried is
     * not a file that has failed, so the marker is suppressed for the duration - suppressed, not deleted,
     * because nothing about the previous attempt has been disproved until this one answers.
     */
    const [attemptInFlight, setAttemptInFlight] = useState(false)

    const isUploading = attemptInFlight || loading || createLoading

    /**
     * Whether this rejection is the one this sitting just produced, as opposed to one restored from
     * storage.
     *
     * By IDENTITY, deliberately, and that is the whole of the distinction. The three SDK hooks and the
     * shared modal all hold the very object the chain rejected with, so `===` identifies a LIVE refusal;
     * a refusal read back out of session storage after a reload is a different object however identical
     * its contents. The durable banner is for the restored case only - within the sitting that caused it,
     * the refusal is already being reported by the dismissible banner above and by the modal, and a third
     * copy of one sentence is not more informative.
     *
     * Dismissal is deliberately NOT consulted here. Putting the inline banner away is the reviewer's
     * decision about this attempt, and re-rendering the same words underneath as soon as they act on it
     * would be overruling them.
     */
    const isLiveRefusal = (candidate?: FrappeError | null) =>
        Boolean(candidate) && (
            candidate === bankRecErrorDialog
            || candidate === error
            || candidate === createError
            || candidate === updateError
        )

    /**
     * What Upload is still waiting for, named so it can be said out loud rather than merely implied by a
     * disabled control. In the order the form asks for them, so the list reads as a route through it.
     */
    const missingPrerequisites = [
        !selectedCompany ? _("Company") : null,
        !selectedBankAccount ? _("Bank Account") : null,
        files.length === 0 ? _("Bank Statement") : null,
    ].filter((requirement): requirement is string => Boolean(requirement))

    /**
     * The refusals from this sitting, most recent first, EXCLUDING the chosen file's own.
     *
     * The chosen file's refusal is shown against the file itself just below the dropzone; these are the
     * others, which is what stops choosing a second file from erasing the record of the first.
     */
    const otherRefusals = Object.entries(uploadRefusals)
        .filter(([key]) => !files[0] || key !== uploadRefusalKey(files[0]))
        .map(([, refusal]) => refusal)
        .sort((a, b) => b.at - a.at)

    /*
     * One refusal, one presentation.
     *
     * A rejection from the upload chain is reported through the shared modal, and the very same object
     * also lands on the failing hook's `error` member, which renders an inline banner below - so a single
     * refusal announced itself twice at once, and the banner mounting behind the modal pushed the rest of
     * the form down while the reviewer was still reading the modal.
     *
     * Suppressed by IDENTITY, not removed. The banner still renders for every error, this one included,
     * from the moment the modal is dismissed - which is what keeps the server's words on the page
     * afterwards. Comparing with `===` on the object the hook is holding is what makes that precise: a
     * genuinely separate later failure is a different object and is never hidden by a stale modal.
     */
    const isReportedInDialog = (candidate?: FrappeError | null) =>
        Boolean(candidate) && candidate === bankRecErrorDialog

    /*
     * Whether the reviewer has dismissed the inline banners below. The three SDK hooks keep their own
     * `error` until their next call, so a refusal stayed on the page indefinitely with no way to clear
     * it - the reviewer could change the file and the account and still be reading the previous
     * attempt's banner. Dismissal is per ATTEMPT rather than per banner because all three describe the
     * same attempt, and it is re-armed at the start of the next one below, so dismissing can never
     * hide a fresh refusal.
     */
    const [inlineErrorsDismissed, setInlineErrorsDismissed] = useState(false)

    const isPdf = files[0]?.name?.toLowerCase().endsWith(".pdf") ?? false

    /*
     * Discards the attachment the upload created against the PLACEHOLDER docname below.
     *
     * The upload has to name a parent document, but the import log does not exist yet and names itself
     * by hash when it is inserted, so the client's placeholder name is discarded by the server and the
     * attachment is left pointing at a document that will never exist. Meanwhile the framework attaches
     * the statement to the real log as part of inserting it, from the `file` field's own value - so a
     * successful import ends up with TWO rows for one statement, one of them permanently dangling.
     *
     * Order matters and is the whole safety argument. Frappe removes a file from disk only when no
     * other `File` row shares its content hash, so discarding the placeholder AFTER the log exists
     * removes the row and keeps the statement; discarding it when creation was REFUSED removes both,
     * which is correct because nothing references the bytes. Either way the import itself is
     * unaffected: the server resolves the statement by `file_url`, never by the attachment link.
     *
     * Best-effort by design. A failed cleanup is untidy, not incorrect, and the reviewer is either
     * being taken to a successfully created import log or already being told why one was refused;
     * interrupting either with a housekeeping error would be the worse outcome.
     */
    const discardPlaceholderAttachment = (fileName?: string) => {
        if (!fileName) {
            return
        }

        db.deleteDoc("File", fileName).catch((cleanupError: FrappeError) => {
            console.error("Could not discard the placeholder statement attachment:", cleanupError)
        })
    }

    const onUpload = () => {

        if (!selectedBankAccount) {
            return
        }

        setInlineErrorsDismissed(false)

        const id = `new-bank-statement-import-log-${Date.now()}`

        const attemptedFile = files[0]

        /*
         * Refused HERE rather than by the server, because the server's answer to this is worse than no
         * answer. Frappe's `File.before_insert` reads the uploaded bytes off disk and raises `OSError`
         * for a zero-length file, which arrives as an HTTP 500 with a Python traceback and no import
         * log - a crash, shown to a reviewer whose actual mistake was picking an empty file, with
         * nothing left afterwards to say an attempt was even made.
         *
         * So the one thing that is knowable without asking is checked without asking. The refusal is
         * built in the server's own message shape (`makeClientRefusal`), so it reaches the reviewer
         * through the same dialog, the same banner and the same durable per-file marker as any refusal
         * the server issues - and, being recorded against the file, it survives choosing another file
         * and reloading the page, which the 500 never did.
         *
         * Note what this does NOT do: it does not attempt to validate the CONTENT. Whether a file is a
         * readable statement is the server's judgement and stays the server's - `get_data` refuses an
         * unreadable or row-less one with its own titled message. Only emptiness is decided here,
         * because emptiness is the case the server cannot answer without crashing.
         */
        if (attemptedFile && attemptedFile.size === 0) {
            const refusal = makeClientRefusal(
                _("{0} is empty - it contains no data at all. Export the statement from your bank again and upload the new file.", [attemptedFile.name]),
                _("Empty File")
            )

            setBankRecErrorDialog(refusal)
            recordUploadRefusal(attemptedFile, refusal)
            toast.error(_("The bank statement could not be uploaded."))
            return
        }

        /*
         * The attachment the upload creates, once it exists. Held here rather than threaded through the
         * chain because BOTH endings need it - the success handler and the rejection handler - and it is
         * only knowable after the upload leg has resolved.
         */
        let placeholderAttachment: string | undefined

        // For protected PDFs, persist the password on the Bank Account so it is reused for
        // every statement of this account (and is available before the import doc is created).
        const ensurePassword = isPdf && password
            ? updateDoc("Bank Account", selectedBankAccount.name, { statement_password: password })
            : Promise.resolve()

        setAttemptInFlight(true)

        ensurePassword.then(() => upload(files[0], {
            isPrivate: true,
            doctype: "Bank Statement Import Log",
            docname: id,
            fieldname: 'file'
        })).then((file) => {
            placeholderAttachment = file.name
            return createDoc("Bank Statement Import Log",
                // @ts-expect-error - not filling everything else
                {
                    name: id,
                    file: file.file_url,
                    bank_account: selectedBankAccount.name
                })
        }).then((doc) => {
            // The log now owns its own attachment, so the placeholder one is a duplicate row hanging
            // off a name that will never exist. See `discardPlaceholderAttachment` above for why this
            // is safe here and why it cannot happen any earlier.
            discardPlaceholderAttachment(placeholderAttachment)
            // Cleared BEFORE navigating: `navigate` unmounts this form, and setting state afterwards
            // would be a write to a component that no longer exists.
            setAttemptInFlight(false)
            navigate(`/statement-importer/${doc.name}`)
        }).catch((uploadError: FrappeError) => {
            // A refused attempt leaves nothing behind either: no log was created, so no other row
            // references the statement and both the row and the bytes go.
            discardPlaceholderAttachment(placeholderAttachment)
            /*
             * THIS is where a malformed or unreadable statement is refused, and the handler is attached
             * to the WHOLE chain because either of the first two links can be the one to refuse it:
             *
             *   - `upload_file` rejects when the framework's own `File.before_insert` refuses the
             *     content - `check_content` runs `pdf_contains_js`, so a file claiming to be a PDF that
             *     is not one fails right here, before any import log is even attempted;
             *   - `createDoc` rejects when `Bank Statement Import Log.before_insert` cannot parse a file
             *     the framework accepted (`get_data` / `prepare_pdf_tables`), or when `validate`
             *     refuses the bank account.
             *
             * Either way no import log is created, so there is no detail screen to report on and no row
             * to hang a failure marker from - the upload form is the only place the reviewer can be
             * told. Without this handler the rejection was unhandled and the form simply looked idle.
             *
             * The shared dismissible dialog reports the server's own words; the inline banners above
             * keep them on the page after it is dismissed. The wording below stays neutral about WHICH
             * link refused, because that is what the dialog is for.
             *
             * Recording the refusal against the FILE is what completes FM2's per-file failure indicator
             * for this path: the modal is transient and the list on the right can only badge rows the
             * server actually has, so without it a refused statement left no trace once the modal was
             * gone. It is recorded in session-scoped storage rather than component state, so the record
             * survives choosing another file and reloading the page - the two things a reviewer does
             * next, both of which used to destroy it.
             */
            setAttemptInFlight(false)
            setBankRecErrorDialog(uploadError)
            recordUploadRefusal(attemptedFile, uploadError)
            toast.error(_("The bank statement could not be uploaded."))
        })
    }

    return (
        /*
         * Stacks below `xl` instead of holding a fixed 52/48 split at every width. The two panes are an
         * upload FORM and the account's import HISTORY, and at anything narrower than a wide desktop the
         * split gave each of them roughly 190px: the history table was unreadable, and the right pane
         * overpainted the form's own controls - so the reviewer could reach Upload without being able to
         * see what they were uploading against. `min-w-0` on both is what actually lets them shrink; a
         * flex child defaults to its content's minimum width and would otherwise force the row wider than
         * the viewport. `xl` matches the breakpoint the reconciliation panes stack at, so the two surfaces
         * change shape together.
         */
        <div className="flex flex-col xl:flex-row px-4">
            <div className="w-full xl:w-[52%] min-w-0">
                {/* Three independent conditions decide whether a refusal is on the page inline, and each
                    answers a different question.

                    `inlineErrorsDismissed` is the reviewer's own answer: a banner they closed stays
                    closed until the next attempt, which resets it at the top of `onUpload`.

                    `isReportedInDialog` is suppression by IDENTITY while the very same object is on
                    screen in the shared modal - one refusal must announce itself once, not twice, and the
                    banner mounting behind the modal pushed the rest of the form down while the reviewer
                    was still reading it. It is suppression rather than removal: the banner returns the
                    moment the modal is dismissed, which is what keeps the server's words on the page
                    afterwards. A genuinely separate later failure is a different object and is never
                    hidden by a stale modal. */}
                {!inlineErrorsDismissed && <>
                    {error && !isReportedInDialog(error) && <ErrorBanner error={error} onDismiss={() => setInlineErrorsDismissed(true)} />}
                    {createError && !isReportedInDialog(createError) && <ErrorBanner error={createError} onDismiss={() => setInlineErrorsDismissed(true)} />}
                    {updateError && !isReportedInDialog(updateError) && <ErrorBanner error={updateError} onDismiss={() => setInlineErrorsDismissed(true)} />}
                </>}
                <div className="py-2 flex flex-col gap-6">
                    <div className="flex flex-col gap-2">
                        <Label>{_("Company")}<span className="text-ink-red-3">*</span></Label>
                        <div className="min-w-56 w-fit flex flex-col">
                            <CompanySelector />
                        </div>
                    </div>
                    {selectedCompany && <div className="flex flex-col gap-2">
                        <Label>{_("Bank Account")}<span className="text-ink-red-3">*</span></Label>
                        <div className="">
                            <BankPicker className="w-full flex-wrap" />
                        </div>
                    </div>
                    }
                    {selectedBankAccount && <div className="flex flex-col gap-4 pe-4">
                        <div className="flex justify-between">
                            <div className="flex flex-col gap-2">
                                <Label>{_("Bank Statement")}<span className="text-ink-red-3">*</span></Label>
                                <p
                                    data-slot="form-description"
                                    className={cn("text-ink-gray-5 text-xs")}
                                >
                                    {_("Upload your bank statement file to start the import process. We support {0} files.", [SUPPORTED_STATEMENT_FORMATS])}
                                </p>
                            </div>
                            <div>
                                <StatementInstructions />
                            </div>
                        </div>

                        <FileDropzone
                            setFiles={setFiles}
                            files={files}
                            className="p-8"
                            inputId="bank-statement-file"
                            accept={STATEMENT_ACCEPT}
                            multiple={false}
                        />

                        {/* FM2's per-file failure indicator for a statement that was refused before any
                            import log existed. Keyed on the file's identity, so it describes THIS file
                            rather than the form: a corrected file is a different key and starts clean,
                            while re-selecting the same unmodified file re-shows what it earned - which is
                            what makes the indicator durable rather than merely sticky.

                            Same `solid` red token language as the per-row badge in Previous Imports, so
                            one failure reads the same way wherever it is shown.

                            Deliberately NOT a live region. The modal announced this refusal already and
                            took focus for it, and the inline banner above carries `role="alert"`; a third
                            announcement of the same words would only talk over them. This is the durable
                            visual trace, which is precisely what the transient surfaces cannot be. */}
                        {selectedFileRefusal && !isUploading &&
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <Badge variant="solid" theme="red">{_("Failed")}</Badge>
                                    <span className="text-ink-gray-6 text-p-sm wrap-anywhere">
                                        {_("{0} was refused and nothing was imported from it. Correct it or choose another, then upload again.", [selectedFileRefusal.fileName])}
                                    </span>
                                </div>
                                {/* The server's own words for this file - but ONLY when nothing else on
                                    screen is already carrying them.

                                    Still one refusal, one presentation. Within the sitting that made it,
                                    the refusal is on the failing hook's `error` (which the banner above
                                    renders) or in the shared modal, and repeating it here would be the
                                    third copy of one sentence. What this covers is the case none of those
                                    reach: a refusal RESTORED from session storage after a reload or a
                                    navigation, where the hooks are empty and the modal is long gone, and
                                    the persisted marker is the only thing left that knows why.

                                    Compared by IDENTITY, which is what makes the distinction exact - a
                                    live object is the same object the hook and the modal hold, a restored
                                    one is a different object however identical its contents. */}
                                {!isLiveRefusal(selectedFileRefusal.error) &&
                                    <ErrorBanner error={selectedFileRefusal.error} />}
                            </div>}

                        {isPdf && <div className="flex flex-col gap-2">
                            <Label htmlFor="pdf-password">{_("PDF Password")}</Label>
                            <Input
                                id="pdf-password"
                                type="password"
                                autoComplete="off"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={_("Only if the PDF is password protected")}
                                className="max-w-sm"
                            />
                            <p data-slot="form-description" className={cn("text-ink-gray-5 text-p-sm")}>
                                {_("Leave blank to use the password already saved for this bank account (if any). It is stored encrypted and reused for future statements.")}
                            </p>
                        </div>}
                    </div>}

                    {/* Every OTHER file this sitting refused, most recent first.
                        This is the half of FM2 that choosing a second file used to destroy: the record of
                        the first. A refusal here is not attached to anything the server holds - no import
                        log was created - so if the form does not carry it, nothing does. Kept compact and
                        subordinate: the chosen file's own refusal is shown in full above; these are a
                        one-line reminder each, with the time they happened, so a reviewer working through
                        several statements can still see which of them failed. */}
                    {otherRefusals.length > 0 && <div className="flex flex-col gap-2">
                        {/*
                            `h2`, not `h3`. The four bank cards are `div[role="button"]`, and ARIA
                            treats a button's subtree as presentational - so the level-2 heading inside
                            each card is dropped from the accessibility tree entirely. Measured on this
                            route: the AT-facing heading outline ran h1 -> h3 with nothing at level 2,
                            because the only level-2 headings were the ones being discarded. Levels 2
                            here and on "Previous Imports" close that gap without changing a pixel;
                            `border-0 p-0` cancels the `H2` underline and padding (measured: the
                            unmodified `H2` renders a 1px bottom border and 8px bottom padding, this
                            renders 0px of both), and the size utilities that follow win in twMerge.
                        */}
                        <H2 className="border-0 p-0 text-sm text-ink-gray-6">{_("Other files refused in this session")}</H2>
                        <ul className="flex flex-col gap-1.5">
                            {otherRefusals.map((refusal) => (
                                <li key={`${refusal.fileName}-${refusal.at}`} className="flex items-center gap-2 flex-wrap">
                                    <Badge variant="solid" theme="red">{_("Failed")}</Badge>
                                    <span className="text-ink-gray-6 text-p-sm wrap-anywhere">{refusal.fileName}</span>
                                    <span className="text-ink-gray-5 text-p-xs">
                                        {formatDate(new Date(refusal.at), 'Do MMM YYYY, h:mm a')}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>}

                    <div className="flex flex-col gap-2 px-4 items-end">
                        {/*
                          * Why the button is not simply disabled and silent.
                          *
                          * Upload needs a company, a bank account and a file, and it used to be a bare
                          * `disabled` for any of them: a reviewer - and especially one using a screen
                          * reader, for whom a disabled control is announced as unavailable and nothing
                          * more - was left to work out which of the three was missing. The reason is now
                          * stated in text, tied to the control by `aria-describedby`, so it is read out
                          * with the button rather than having to be hunted for.
                          *
                          * `role="status"` rather than `alert`: nothing has been refused here, the form is
                          * simply incomplete, and interrupting for that would be shouting.
                          */}
                        {missingPrerequisites.length > 0 && <p
                            id={UPLOAD_REQUIREMENTS_ID}
                            role="status"
                            className="text-ink-gray-5 text-p-sm">
                            {_("Before uploading, choose: {0}.", [missingPrerequisites.join(', ')])}
                        </p>}
                        <Button
                            onClick={onUpload}
                            size='md'
                            aria-describedby={missingPrerequisites.length > 0 ? UPLOAD_REQUIREMENTS_ID : undefined}
                            disabled={missingPrerequisites.length > 0 || isUploading}>
                            {isUploading ? <Loader2Icon className="size-4 animate-spin" /> : null}
                            {isUploading ? _("Uploading...") : _("Upload")}
                        </Button>
                    </div>
                </div>
            </div>
            {/* The divider follows the layout: a start border while the panes sit side by side, a top
                border once they are stacked, so it always separates them along the axis they meet on. */}
            <div className="w-full xl:w-[48%] min-w-0 border-t xl:border-t-0 xl:border-s border-outline-gray-2 pt-4 xl:pt-0 xl:ps-4">
                {selectedBankAccount && <StatementImportLog />}
            </div>

            {/* Mounted here as well as inside the reconciliation workbench because this page sits in a
                different route tree; both mounts read the one atom. */}
            <BankRecErrorDialog />
        </div>
    )
}

const StatementInstructions = () => {
    return <Dialog>
        <DialogTrigger asChild>
            <Button variant='outline' size='sm'>{_("View Instructions")}</Button>
        </DialogTrigger>
        <DialogContent size="7xl">
            <DialogHeader>
                <DialogTitle>{_("Statement Import Instructions")}</DialogTitle>
                <DialogDescription>{_("We support uploading CSV, XLSX, XLS and PDF files. Please make sure the file contains the correct columns.")}</DialogDescription>
            </DialogHeader>
            <Paragraph className="text-sm">{_("The file should contain the following columns with a distinct header row. You can upload most bank statements as is without changing the columns.")}</Paragraph>
            <Paragraph className="text-sm text-ink-gray-6">{_("For PDF statements, we auto-detect the tables on each page. You can then confirm each detected table, map its columns, and exclude anything that is not transactions (e.g. ads or summaries). Password-protected PDFs are supported - the password is saved on the bank account and reused.")}</Paragraph>
            {/*
              * Named, because this table is wider than the dialog at every supported width and therefore
              * always becomes a keyboard-focusable scroll region. Without a name of its own it announces
              * itself with the primitive's generic fallback, which says nothing about what it contains.
              */}
            <Table containerLabel={_("Supported statement columns")}>
                <TableHeader>
                    <TableRow>
                        <TableHead>{_("Column Name")}</TableHead>
                        <TableHead>{_("Maps To")}</TableHead>
                        <TableHead>{_("Description")}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    <TableRow>
                        <TableCell>Date/Transaction Date/Value Date</TableCell>
                        <TableCell>{_("Date")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_("The date of the transaction")}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Amount</TableCell>
                        <TableCell>{_("Amount")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_('This can contain "CR"/"DR" values or positive/negative values. You could also have a separate column for CR/DR.')}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Withdrawal/Deposit</TableCell>
                        <TableCell>{_("Withdrawal")}/{_("Deposit")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_("The withdrawal or deposit amounts - only required if there's no amount column.")}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Description/Particulars/Remarks/Narration/Detail</TableCell>
                        <TableCell>{_("Description")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_("The description of the transaction")}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Reference/Ref/Transaction ID/Cheque/Check</TableCell>
                        <TableCell>{_("Reference")}</TableCell>
                        <TableCell className="text-ink-gray-5">{_("The reference number of the transaction")}</TableCell>
                    </TableRow>
                </TableBody>
            </Table>
            <DialogFooter>
                <DialogClose asChild>
                    <Button variant='outline'>{_("Close")}</Button>
                </DialogClose>
            </DialogFooter>
        </DialogContent>
    </Dialog>
}

const StatementImportLog = () => {

    const bankAccount = useAtomValue(selectedBankAccountAtom)

    const { data, error } = useFrappeGetDocList<BankStatementImportLog>("Bank Statement Import Log", {
        // `currency` is projected because the Closing Balance cell below formats a monetary value with it.
        // Without it that cell fell back to the browser/company default, so a statement imported on a
        // foreign-currency account was listed with the WRONG symbol against the right number - the same
        // mislabelling the statement detail screen already avoids by formatting from `doc.currency`.
        fields: ["name", "file", "status", "number_of_transactions", "start_date", "end_date", "closing_balance", "currency", "creation"],
        filters: [["bank_account", "=", bankAccount?.name ?? ""]],
        orderBy: {
            field: "creation",
            order: "desc"
        },
        limit: 10
    }, bankAccount ? undefined : null, {
        revalidateOnFocus: false
    })

    const navigate = useNavigate()

    /*
     * The per-file failure markers the statement-import step records, keyed by `Bank Statement Import
     * Log` name. They cannot come from the row itself: the DocType carries no error field and offers
     * only `Not Started` and `Completed`, and a failed import rolls back, so the row reads exactly as
     * one nobody has tried yet. The third badge state below renders from these markers.
     *
     * They are strictly SUBORDINATE to the server: a marker is an observation this session made about a
     * request, while `status` is what the server persisted. Wherever the two disagree the server wins,
     * both in the badge below and in the prune here.
     */
    const [importFailures, setImportFailures] = useAtom(bankRecImportFailuresAtom)

    /*
     * Retire markers the fetched rows have overtaken - a log the server now reports as `Completed`, or
     * one that has disappeared from this account's list. Without this a marker recorded once would
     * outlive its cause for the whole session, since nothing else in the SPA ever removes one.
     */
    useEffect(() => {
        if (!data) return

        setImportFailures((failures) => {
            const marked = Object.keys(failures)
            if (marked.length === 0) return failures

            const stale = new Set(marked)
            const listed = new Map(data.map((row) => [row.name, row.status]))

            for (const name of marked) {
                // A log outside this account's page of results is not evidence of anything: keep it.
                if (listed.has(name) && listed.get(name) !== "Completed") stale.delete(name)
                else if (!listed.has(name)) stale.delete(name)
            }

            if (stale.size === 0) return failures
            return Object.fromEntries(Object.entries(failures).filter(([name]) => !stale.has(name)))
        })
    }, [data, setImportFailures])

    const onViewDetails = (name: string) => {
        navigate(`/statement-importer/${name}`)
    }

    return (
        <div className="flex flex-col gap-4">
            <H2 className="border-0 p-0 text-base">{_("Previous Imports")}</H2>

            {error && <ErrorBanner error={error} />}

            {data && data.length > 0 ? (

                /*
                  * Six columns of non-wrapping text do not fit a narrow pane, and the browser resolved
                  * that by pushing the last of them - the FILE, the one thing that identifies which
                  * statement a row is - off the edge of a scroll container nobody knew to scroll. So the
                  * columns are ranked: the three that answer "which import is this and did it work" are
                  * always present, and the three that quantify it appear once there is room. Nothing is
                  * lost at any width - the detail page carries all of it - and the filename is now always
                  * on screen.
                  */
                <Table containerLabel={_("Previous imports")}>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{_("Imported On")}</TableHead>
                            <TableHead>{_("Status")}</TableHead>
                            <TableHead className="hidden md:table-cell whitespace-normal">{_("Transaction Dates")}</TableHead>
                            <TableHead className="hidden md:table-cell text-end whitespace-normal">{_("Number of Transactions")}</TableHead>
                            <TableHead className="hidden md:table-cell text-end whitespace-normal">{_("Closing Balance")}</TableHead>
                            <TableHead>{_("File")}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data?.map((item) => (
                            <TableRow key={item.name} onClick={() => onViewDetails(item.name)} className="cursor-pointer hover:bg-surface-gray-2">
                                {/*
                                  * The row's click target is duplicated as a real link on the date, so the
                                  * detail page is reachable by keyboard and its destination is visible on
                                  * hover. A `tr` cannot carry `role="button"` without breaking the table's
                                  * own row semantics, and an aria-less focusable row announces nothing, so
                                  * a link in the first cell is the honest affordance. The row handler stays
                                  * for pointer convenience; the link stops its own click propagating so the
                                  * navigation happens once.
                                  */}
                                <TableCell>
                                    {/*
                                        Named for the import it opens, not just the day it was made. Ten
                                        imports made on the same day produced ten links all reading
                                        "9th Aug 2026", and a screen-reader user listing the page's links
                                        hears that name ten times with no way to tell them apart - the
                                        distinguishing detail lives in adjacent cells they are not
                                        reading. The visible date is kept and the name is EXTENDED with
                                        the statement's file name, so the accessible name still contains
                                        the visible label and the two cannot contradict each other.
                                    */}
                                    <Link
                                        to={`/statement-importer/${item.name}`}
                                        onClick={(event) => event.stopPropagation()}
                                        aria-label={_("{0} - open import of {1}", [
                                            formatDate(item.creation, 'Do MMM YYYY'),
                                            item.file?.split('/').pop() ?? item.name
                                        ])}
                                        className="underline underline-offset-4 rounded focus-visible:shadow-focus-gray focus-visible:outline-none">
                                        {formatDate(item.creation, 'Do MMM YYYY')}
                                    </Link>
                                </TableCell>
                                {/* The server's `Completed` is checked FIRST, so an authoritative
                                    success always outranks a marker left by an earlier failed attempt.
                                    `solid` red rather than the default `subtle`: subtle red on the dark
                                    surface measures 4.407:1, under the 4.5:1 WCAG AA floor for this
                                    text size, whereas solid puts `ink-red-1` on `surface-red-5`.

                                    Two different things produce the failed state, and only one of them
                                    is a session marker:

                                      - `importFailures[name]` is an import this session ATTEMPTED and
                                        the server refused. Not recoverable from the row (the import
                                        rolls back and the DocType persists no error), which is why it
                                        has to be remembered client-side.

                                      - zero parsed transactions is the DURABLE case, and it is derived
                                        from the row itself. A statement the parser could make nothing
                                        of is inserted with `number_of_transactions = 0` and left at
                                        `Not Started`, so it used to be listed in neutral grey - visually
                                        identical to a statement nobody had got round to importing yet -
                                        and it read the same way after a reload, in a new tab, and for a
                                        different reviewer. Being derived from what the server returns,
                                        this half of the indicator needs no marker and cannot be lost. */}
                                <TableCell>{item.status === "Completed"
                                    ? <Badge theme="green">{item.status}</Badge>
                                    : importFailures[item.name] || item.number_of_transactions === 0
                                        ? <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Badge variant="solid" theme="red">{_("Failed")}</Badge>
                                            </TooltipTrigger>
                                            <TooltipContent>
                                                {item.number_of_transactions === 0
                                                    ? _("No transactions could be read from this file, so there is nothing to import. Open it to correct the header row or the column mapping, or upload a corrected statement.")
                                                    : _("This statement was refused when it was imported and nothing was created from it. Open it to see why.")}
                                            </TooltipContent>
                                        </Tooltip>
                                        : <Badge theme="gray">{item.status}</Badge>}</TableCell>
                                <TableCell className="hidden md:table-cell whitespace-normal">
                                    {item.start_date && item.end_date ? (
                                        <span>{formatDate(item.start_date, 'Do MMM YYYY')} to {formatDate(item.end_date, 'Do MMM YYYY')}</span>
                                    ) : (
                                        <span>-</span>
                                    )}
                                </TableCell>
                                <TableCell className="hidden md:table-cell text-end">{item.number_of_transactions}</TableCell>
                                {/* Each statement's OWN currency, not a default: this list can mix
                                    accounts, and the detail screen already formats from the same field. */}
                                <TableCell className="hidden md:table-cell text-end font-numeric">{formatCurrency(flt(item.closing_balance, 2), item.currency)}</TableCell>
                                {/* Bank portals export long, sometimes mixed-script filenames, and an
                                    unconstrained one stretched the row until the columns before it were
                                    unreadable - so from `md` up the name is capped at 12rem and truncated
                                    on one line, with the whole of it in `title`.

                                    Below `md` it WRAPS instead, and the cell drops the primitive's default
                                    `whitespace-nowrap` to let it. That is the difference between a column
                                    that fits and one that does not: `break-all` gives the column a
                                    min-content width of a single character, so the table's auto layout can
                                    hand it whatever is left after the date and the status and let it wrap
                                    inside that, rather than insisting on the full name and pushing the
                                    column off the edge of the container. A cap here would not do - two
                                    statements from the same bank often differ only in their last few
                                    characters, so a name truncated to a narrow column would render two
                                    different rows identically. Wrapping keeps every character. */}
                                <TableCell className="whitespace-normal">
                                    <a
                                        href={item.file}
                                        title={item.file.split('/').pop()}
                                        onClick={(event) => event.stopPropagation()}
                                        target="_blank"
                                        className="block break-all md:break-normal md:max-w-[12rem] md:truncate underline underline-offset-4 rounded focus-visible:shadow-focus-gray focus-visible:outline-none">
                                        {item.file.split('/').pop()}
                                    </a>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>)
                : <Empty>
                    <EmptyHeader>
                        <EmptyMedia>
                            <ListIcon />
                        </EmptyMedia>
                        <EmptyTitle>{_("No bank statements imported yet")}</EmptyTitle>
                    </EmptyHeader>
                </Empty>}
        </div>
    )
}
export default BankStatementImporter