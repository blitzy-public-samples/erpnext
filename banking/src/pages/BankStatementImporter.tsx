import BankPicker from "@/components/features/BankReconciliation/BankPicker"
import { bankRecErrorDialogAtom, bankRecImportFailuresAtom, bankRecPreImportFailuresAtom, getImportAttempt, getPreImportFailures, preImportFailureScopeKey, selectedBankAccountAtom, withCompletedImportAttemptsRetired, withPreImportFailure, withoutPreImportFailure, type ImportAttemptStatus } from "@/components/features/BankReconciliation/bankRecAtoms"
import BankRecErrorDialog from "@/components/features/BankReconciliation/BankRecErrorDialog"
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
import { H3, Paragraph } from "@/components/ui/typography"
import { isFrappeErrorEnvelope, toDisplayError } from "@/components/features/BankReconciliation/utils"
import { useCurrentCompany } from "@/hooks/useCurrentCompany"
import { formatDate } from "@/lib/date"
import { flt, formatCurrency } from "@/lib/numbers"
import _ from "@/lib/translate"
import { cn } from "@/lib/utils"
import { BankStatementImportLog } from "@/types/Accounts/BankStatementImportLog"
import { FrappeContext, useFrappeCreateDoc, useFrappeFileUpload, useFrappeGetDocList, useFrappeUpdateDoc, type FrappeConfig } from "frappe-react-sdk"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { AlertCircleIcon, CircleHelpIcon, ListIcon, Loader2Icon } from "lucide-react"
import { useContext, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"


const BankStatementImporter = () => {

    const selectedCompany = useCurrentCompany()

    const [selectedBankAccount] = useAtom(selectedBankAccountAtom)

    const setErrorDialog = useSetAtom(bankRecErrorDialogAtom)

    /*
     * FM2 pre-log failures, nested by company + bank account and then by file name. There is no
     * import log to key them by, and the FILE NAME alone is not enough: this form is
     * company-and-account specific, so a failure keyed by name only followed the reviewer into other
     * accounts, was overwritten by a same-named retry under a different account, and - because the
     * suppression below was computed from the whole map - silenced the inline hook banners
     * everywhere. Everything read and written here is scoped to the account the form is actually on.
     */
    const [preImportFailures, setPreImportFailures] = useAtom(bankRecPreImportFailuresAtom)

    const [files, setFiles] = useState<File[]>([])
    const [password, setPassword] = useState("")

    const { upload, error, loading } = useFrappeFileUpload()

    const navigate = useNavigate()
    const { createDoc, loading: createLoading, error: createError } = useFrappeCreateDoc<BankStatementImportLog>()
    const { updateDoc, error: updateError } = useFrappeUpdateDoc()

    // Used to reconcile server state after an upload chain whose outcome the response did not
    // establish: whether the import log exists, and - when it definitively does not - to remove the
    // private statement file that would otherwise be left attached to nothing.
    const { db } = useContext(FrappeContext) as FrappeConfig

    const isPdf = files[0]?.name?.toLowerCase().endsWith(".pdf") ?? false

    /**
     * SINGLE FLIGHT over the WHOLE upload chain.
     *
     * The chain is three server operations - save the statement password, upload the file, create the
     * import log - and the Upload control was held closed by `loading || createLoading`, which are the
     * upload hook's and the create hook's own in-flight flags. Neither covers the FIRST step: the
     * update hook's `loading` was never read, so for the entire duration of a protected-PDF password
     * save the control was enabled and a second click started a SECOND chain from the beginning. Each
     * chain uploads its own copy of the statement and creates its own log - the server names each one
     * separately and nothing de-duplicates them afterwards - so the same statement can then be
     * imported twice, once from each. The hook flags also go quiet in the gaps BETWEEN steps, which is
     * a second, narrower version of the same window.
     *
     * A single local flag closes all of it, because it is raised before the first dispatch and stays
     * raised across every await in between. Deliberately NOT derived from the hooks: their flags
     * describe individual requests, and what has to be prevented is a second CHAIN.
     *
     * It is lowered only when the chain ends without a log having been created - the one state in
     * which retrying is legitimate. A chain that reaches the log navigates away, so the control must
     * not reopen behind it. Local state, not an atom: this describes one form's attempt, not
     * application state, and it must not survive a remount.
     *
     * TWO members, for two different jobs. The state drives what the control LOOKS like, and can only
     * do that job: a state value is read from the closure of the render that produced the click
     * handler, so two clicks dispatched inside ONE React batch both see `false` and both proceed -
     * the check-then-act race the `disabled` attribute cannot close either, since it is applied by a
     * later render. The ref is written synchronously and read back immediately, so the second click
     * sees the first one's decision. The ref DECIDES; the state DISPLAYS.
     */
    const [isUploading, setIsUploading] = useState(false)
    const uploadInFlight = useRef(false)

    /**
     * What has ALREADY been stored on the server by a chain that then failed, and can therefore be
     * reused instead of stored a second time.
     *
     * The chain's second step uploads the statement as a PRIVATE File and its third creates the log
     * that points at it. When the upload succeeded and only the create failed, the File is on the
     * server with nothing pointing at it - and the previous version neither reused nor removed it,
     * so each retry stored another copy of a customer's bank statement and nothing ever cleaned any
     * of them up (CWE-459).
     *
     * Holding the upload lets a retry re-use the same stored File, so there is at most one stored
     * copy per file, and lets a definitive refusal delete it. `fileKey` is what makes the reuse
     * safe: it identifies the exact file the upload was of, so a reviewer who picks a DIFFERENT file
     * gets a fresh upload rather than the previous one silently re-used under a new log.
     *
     * `fileUrl` is the SERVER-ASSIGNED url of the stored statement, and it doubles as the only
     * stable identity this chain has: see {@link findImportLogForStatement} for why no client-side
     * identifier can serve that purpose for this DocType.
     *
     * A ref, not state: it is read and written inside the chain, and a re-render must not be able to
     * hand a second entry a stale copy of it.
     */
    const pendingUpload = useRef<{
        fileKey: string
        fileUrl: string
        fileDocName: string
    } | null>(null)

    /** Identifies a chosen file well enough to tell it apart from any other the reviewer might pick. */
    const fileIdentity = (file: File | undefined): string =>
        file ? `${file.name}:${file.size}:${file.lastModified}` : ''

    /**
     * The scope every pre-log failure of THIS form is recorded under and read back from. `undefined`
     * until both selections are made, which is also the state in which the Upload control is
     * disabled - so no failure can be recorded without a scope to record it against.
     */
    const preImportFailureScope = preImportFailureScopeKey(selectedCompany, selectedBankAccount?.name)

    /** Only this account's failures. Another account's observation is not this account's business. */
    const scopedPreImportFailures = getPreImportFailures(preImportFailures, preImportFailureScope)

    // Whether a failure has already been attributed to a specific file IN THIS ACCOUNT. Used only to
    // keep the unattributed hook banners from repeating a message the per-file surface already
    // shows - which is why it must be scoped: computed across the whole map, one stale marker under
    // any account suppressed the inline error for every other.
    const hasAttributedFailure = Object.keys(scopedPreImportFailures).length > 0

    /**
     * Asks the server which import log - if any - was created from the statement stored at
     * `fileUrl`. Returns that log's REAL name, `null` when the server answered definitively that
     * none exists, and `undefined` when it could not be asked - which must NOT be read as "absent".
     *
     * The three-way answer decides whether the stored File may be deleted: deleting one that
     * belongs to a log which does exist would strip the statement off a real document.
     *
     * ⚠️ WHY THE LOOKUP IS BY FILE URL AND NOT BY A NAME THIS CLIENT CHOSE.
     * `Bank Statement Import Log` is hash-autonamed (`"autoname": "hash"`, `"naming_rule":
     * "Random"`). Frappe's `set_new_name` clears any `name` an insert supplies for every autoname
     * rule except `prompt` and `UUID`, then mints its own - so the server ALWAYS names this
     * document itself and a client-minted identifier is never a key it can be found under. The
     * previous version asked `getDoc` for the name this form had generated, which the create had
     * already discarded: that read could only ever answer 404, so a create whose acknowledgement
     * was merely LOST was reported as "never happened", the stored statement was deleted, and the
     * reviewer was invited to retry - producing a SECOND import log for a statement that had
     * already been imported once.
     *
     * `file` is the correct correlation key because it is server-assigned (the url comes back from
     * the upload), unique to this one stored statement, and is exactly what the create writes onto
     * the log - so a log created from this upload is discoverable by it and one created from any
     * other upload is not. Newest-first with a limit of one, so a url that somehow carries more
     * than one log resolves to the most recent rather than to an arbitrary row.
     *
     * Any rejection - a lost response, a permission failure - leaves the question open. There is
     * deliberately no 404 special case: a list query answers "none" with an EMPTY ARRAY, so
     * absence arrives as data rather than as an error, and every error therefore means the client
     * did not learn the answer.
     */
    const findImportLogForStatement = async (fileUrl: string): Promise<string | null | undefined> => {
        try {
            const matches = await db.getDocList<Pick<BankStatementImportLog, "name">>("Bank Statement Import Log", {
                filters: [["file", "=", fileUrl]],
                fields: ["name"],
                orderBy: { field: "creation", order: "desc" },
                limit: 1
            })
            return matches[0]?.name ?? null
        } catch {
            // A FIXED diagnostic, never the caught object: a Frappe rejection carries the whole
            // response envelope, and a bank statement's transport detail does not belong in a
            // browser console. Announced all the same, so a swallowed failure is never silent.
            console.error('Bank statement import: an existing import log for this statement could not be looked up.')
            return undefined
        }
    }

    /**
     * Removes a private statement File the server stored for a log that definitively does not exist.
     * Reports whether it is gone: if the delete itself fails the upload is KEPT in
     * {@link pendingUpload}, so the next retry re-uses that one copy rather than storing another.
     */
    const discardStoredStatement = async (fileDocName: string): Promise<boolean> => {
        try {
            await db.deleteDoc("File", fileDocName)
            return true
        } catch {
            // Fixed diagnostic only; see the note above.
            console.error('Bank statement import: the stored statement file could not be discarded, so it is kept for the next retry.')
            return false
        }
    }

    /**
     * Decides what to do about an upload that reached the server while the chain as a whole did not
     * finish, and returns whether the reviewer was handed off to an existing log.
     *
     *  - the log EXISTS (the response was lost, but the create landed) -> nothing is orphaned; the
     *    reviewer is taken to that log, which is where the success path would have taken them.
     *  - the log definitively does NOT exist -> the stored statement belongs to nothing, so it is
     *    deleted. Only if the deletion fails is the upload retained for reuse.
     *  - the outcome cannot be established -> NOTHING is deleted and the upload is retained, so a
     *    retry re-uses the one stored copy instead of adding another. Deleting here could remove the
     *    statement from a log that does exist.
     *
     * A definitive server refusal of the create is not probed: the server said it did not happen.
     */
    const settleStoredStatement = async (
        pending: { fileKey: string, fileUrl: string, fileDocName: string },
        serverRefusedCreate: boolean
    ): Promise<boolean> => {

        // Asked by the statement's own server-assigned url, so the answer is the log's REAL name -
        // the only identity this document has, and the one the hand-off below must navigate to.
        const existingLog = serverRefusedCreate ? null : await findImportLogForStatement(pending.fileUrl)

        if (typeof existingLog === 'string') {
            pendingUpload.current = null
            navigate(`/statement-importer/${existingLog}`)
            return true
        }

        if (existingLog === null) {
            const discarded = await discardStoredStatement(pending.fileDocName)
            pendingUpload.current = discarded ? null : pending
            return false
        }

        // Outcome unknown: keep the upload so a retry re-uses it, and delete nothing.
        pendingUpload.current = pending
        return false
    }

    const onUpload = () => {

        if (!selectedBankAccount) {
            return
        }

        // Belt to the disabled control's braces. A `disabled` attribute is the right affordance but it
        // is not the guarantee: it is applied by a LATER render, so it cannot close the window between
        // two clicks that arrive in the same batch, and it does not exist at all for a programmatic
        // call. The ref is read here, before anything is dispatched, so a second entry is refused on
        // the strength of the first one's own write rather than on a re-render having happened.
        if (uploadInFlight.current) {
            return
        }

        // Raised BEFORE the first dispatch, so there is no window - however brief - in which a chain
        // is under way and nothing is holding the control closed. The ref is set first and
        // synchronously: it is what the guard above reads.
        uploadInFlight.current = true
        setIsUploading(true)

        const chosenFile = files[0]
        const fileKey = fileIdentity(chosenFile)

        /*
         * A previous chain for THIS EXACT FILE that already stored it on the server. Reusing it is
         * what keeps a retry from putting a second copy of the same bank statement into file storage.
         *
         * The identity check is the safety condition: a different file must never be created from a
         * previous file's upload.
         */
        const reusableUpload = pendingUpload.current?.fileKey === fileKey ? pendingUpload.current : null

        // For protected PDFs, persist the password on the Bank Account so it is reused for
        // every statement of this account (and is available before the import doc is created).
        const ensurePassword = isPdf && password
            ? updateDoc("Bank Account", selectedBankAccount.name, { statement_password: password })
            : Promise.resolve()

        const fileName = chosenFile?.name ?? ""

        // A retry supersedes whatever the previous attempt observed, so the stale marker goes
        // before the request does rather than after it resolves - and it is retired only within THIS
        // account's scope, so a same-named file under another account keeps its own observation.
        setPreImportFailures((previous) => withoutPreImportFailure(previous, preImportFailureScope, fileName))

        ensurePassword.then((): Promise<{ file_url: string, name: string }> => {
            // Already stored, so the upload step is SKIPPED rather than repeated. The stored File's
            // own url and name are carried forward unchanged.
            if (reusableUpload) {
                return Promise.resolve({ file_url: reusableUpload.fileUrl, name: reusableUpload.fileDocName })
            }

            /*
             * PRIVATE, and deliberately UNATTACHED.
             *
             * The previous version attached the upload to a `new-bank-statement-import-log-…` name
             * this form minted. That name never becomes a document (see
             * {@link findImportLogForStatement}), and the relink that would have moved the
             * attachment onto the real one - `relink_mismatched_files` - only runs for a save
             * carrying Frappe's `__temporary_name`, which the Desk form sets and the REST resource
             * endpoint the SDK posts to does not. So the statement stayed attached to a name that
             * does not exist, AND the framework's `attach_files_to_document` hook - finding no
             * UNATTACHED File for the url - inserted a second File row for the real log: one
             * orphaned copy of a customer's bank statement plus one duplicate, per import.
             *
             * Uploading with no attachment target is what lets that same hook do the association
             * properly: it runs on the log's insert, matches the File whose
             * `attached_to_doctype/name/field` are all NULL, and points it at the FINAL document,
             * field and privacy - the only identity the server ever assigns. One stored copy, no
             * orphan, and no client guess about what the document will be called.
             *
             * `folder` is passed explicitly because `upload_file` defaults an unattached upload to
             * `Home`, and the stored statement belongs where attachments live.
             */
            return upload(chosenFile, {
                isPrivate: true,
                folder: "Home/Attachments"
            })
        }).then(async (file) => {
            // Recorded the instant the statement is on the server, BEFORE the create is attempted, so
            // a failure of that step always finds the upload it has to account for.
            pendingUpload.current = {
                fileKey,
                fileUrl: file.file_url,
                fileDocName: file.name
            }

            /*
             * PREFLIGHT, on a retry only.
             *
             * An upload is only held for reuse when a previous chain ended WITHOUT establishing
             * whether its create landed - the one state in which pressing on could import the same
             * statement twice. Asking first costs one read and is the difference between a retry
             * that recovers the earlier log and a retry that silently creates a duplicate of it.
             *
             * A first attempt skips this: nothing has been sent yet, so there is nothing to find,
             * and an unconditional read would put an extra round trip in front of every import.
             * An unanswerable lookup falls through to the create, which is the same position the
             * reviewer was already in.
             */
            if (reusableUpload) {
                const existingLog = await findImportLogForStatement(file.file_url)

                if (typeof existingLog === 'string') {
                    pendingUpload.current = null
                    navigate(`/statement-importer/${existingLog}`)
                    return null
                }
            }

            return createDoc("Bank Statement Import Log",
                // @ts-expect-error - not filling everything else
                {
                    // No `name`: this DocType is hash-autonamed, so the server assigns the identity
                    // and sending one only invited the client to believe its own guess afterwards.
                    file: file.file_url,
                    bank_account: selectedBankAccount.name
                })
        }).then((doc) => {
            // Nothing to create - a log for this statement already existed and the preflight above
            // has already handed the reviewer to it.
            if (!doc) {
                return
            }

            // The chain completed, so there is nothing left over to account for: the File is attached
            // to a log that exists, under the name the SERVER returned rather than one guessed here.
            pendingUpload.current = null
            navigate(`/statement-importer/${doc.name}`)
        }).catch((uploadError: unknown) => {
            /*
             * FM2, pre-log case. This chain can fail while saving the statement password, while
             * uploading the file, or while creating the import log - and in the first two of those
             * cases NO import log exists yet. There is therefore no document to carry a status and no
             * row for the importer list to render, so the log-keyed markers used elsewhere cannot
             * represent this failure at all. It is recorded against the FILE NAME, within this
             * account's scope, and surfaced next to the upload control.
             *
             * Without this handler the rejection was unhandled: the inline banners below did light
             * up from the hooks' own error state, but the promise still rejected into nothing, and a
             * failure in the password step - which no banner covers - was invisible.
             *
             * Normalised through the shared layer so a genuine server refusal (a rejected file type,
             * a permission failure) reaches the user verbatim, while a lost response becomes
             * outcome-indeterminate copy rather than the SDK's internal TypeError text.
             */
            const displayError = toDisplayError(uploadError)

            // Whatever the server already stored has to be accounted for BEFORE the control reopens:
            // either the log turned out to exist (the reviewer is handed off to it), or the private
            // statement is removed, or it is kept for the retry to re-use. `isFrappeErrorEnvelope`
            // distinguishes a server REFUSAL - which settles that the log was not created - from a
            // rejection that carries no response and therefore settles nothing.
            const pending = pendingUpload.current
            const settlement = pending
                ? settleStoredStatement(pending, isFrappeErrorEnvelope(uploadError))
                : Promise.resolve(false)

            return settlement
                .catch(() => {
                    // Fixed diagnostic only; see the note above.
                    console.error('Bank statement import: the upload settlement did not complete.')
                    return false
                })
                .then((handedOffToExistingLog) => {

                    // The log existed after all, so this was not a failure to report: the reviewer is
                    // already on that log's page and must not be shown an error about it, nor have the
                    // file marked as unuploadable.
                    if (handedOffToExistingLog) {
                        return
                    }

                    setErrorDialog(displayError)
                    setPreImportFailures((previous) =>
                        withPreImportFailure(previous, preImportFailureScope, fileName, displayError))

                    // The chain ended without an import log, so retrying is the user's to do and the
                    // control reopens. Lowered HERE and nowhere else: a chain that got as far as
                    // creating the log navigates away from this form, and reopening the control behind
                    // that hand-off is exactly what would let the same statement be uploaded a second
                    // time.
                    uploadInFlight.current = false
                    setIsUploading(false)
                })
        })
    }

    return (
        <div className="flex px-4">
            <div className="w-[52%]">
                {/*
                  * Each of these three is an SDK hook's OWN error object. For a response-less
                  * rejection that object is not a Frappe envelope at all - `frappe-js-sdk` reads
                  * `error.response.data` unguarded, so what reaches the banner is a raw
                  * `TypeError: Cannot read properties of undefined (reading 'data')`. Rendering it
                  * verbatim showed the SDK's own implementation detail to the user, which is why
                  * every one is normalised through the SAME layer the reconciliation seam uses: a
                  * genuine envelope passes through BY IDENTITY, keeping the server's wording,
                  * title and severity, while a lost response becomes outcome-indeterminate
                  * transport copy.
                  *
                  * They are also suppressed once a failure has been attributed to a FILE below,
                  * because that surface renders the same normalised envelope WITH the file name -
                  * showing both would print the identical message twice.
                  */}
                {!hasAttributedFailure && error && <ErrorBanner error={toDisplayError(error)} />}
                {!hasAttributedFailure && createError && <ErrorBanner error={toDisplayError(createError)} />}
                {!hasAttributedFailure && updateError && <ErrorBanner error={toDisplayError(updateError)} />}

                {/*
                  * FM2, pre-log case. Named per file, because a failure before the import log exists
                  * has no document and therefore no row in the list on the right. Rendered from the
                  * same shared ErrorBanner as everything else, so a server refusal keeps its own
                  * wording and severity, and a lost response reads as indeterminate rather than as
                  * a definite failure.
                  */}
                {Object.entries(scopedPreImportFailures).map(([failedFileName, failedError]) => (
                    <div key={failedFileName} className="flex flex-col gap-1 py-1">
                        <span className="text-p-sm text-ink-gray-7">{_("{0} could not be uploaded.", [failedFileName])}</span>
                        <ErrorBanner error={failedError} />
                    </div>
                ))}
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
                                    {_("Upload your bank statement file to start the import process. We support CSV, XLSX and PDF files.")}
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
                            accept={{
                                'text/csv': ['.csv'],
                                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
                                'application/vnd.ms-excel': ['.xls'],
                                'application/pdf': ['.pdf'],
                                // 'application/xml': ['.xml'],
                            }}
                            multiple={false}
                        />

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
                    <div className="flex justify-end px-4">
                        {/*
                          * `isUploading` is listed FIRST because it is the condition that actually
                          * spans the chain; the two hook flags are kept alongside it so the control
                          * still reflects an in-flight request that some other code path started.
                          */}
                        <Button
                            onClick={onUpload}
                            size='md'
                            disabled={isUploading || files.length === 0 || loading || createLoading || !selectedBankAccount || !selectedCompany}>
                            {isUploading || loading || createLoading ? <Loader2Icon className="size-4 animate-spin" /> : null}
                            {isUploading || loading || createLoading ? _("Uploading...") : _("Upload")}
                        </Button>
                    </div>
                </div>
            </div>
            <div className="w-[48%] border-s border-outline-gray-2 ps-4">
                {selectedBankAccount && <StatementImportLog />}
            </div>

            <BankRecErrorDialog />
        </div>
    )
}

const StatementInstructions = () => {
    return <Dialog>
        <DialogTrigger asChild>
            <Button variant='outline' size='sm'>{_("View Instructions")}</Button>
        </DialogTrigger>
        <DialogContent className="min-w-7xl">
            <DialogHeader>
                <DialogTitle>{_("Statement Import Instructions")}</DialogTitle>
                <DialogDescription>{_("We support uploading CSV, XLSX, XLS and PDF files. Please make sure the file contains the correct columns.")}</DialogDescription>
            </DialogHeader>
            <Paragraph className="text-sm">{_("The file should contain the following columns with a distinct header row. You can upload most bank statements as is without changing the columns.")}</Paragraph>
            <Paragraph className="text-sm text-ink-gray-6">{_("For PDF statements, we auto-detect the tables on each page. You can then confirm each detected table, map its columns, and exclude anything that is not transactions (e.g. ads or summaries). Password-protected PDFs are supported - the password is saved on the bank account and reused.")}</Paragraph>
            <Table>
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

/**
 * Per-row status chip.
 *
 * AUTHORITATIVE SERVER STATUS WINS. When the fetched log says `Completed`, that is what renders
 * regardless of anything the client observed: the client marker is an observation of one attempt,
 * while the document is the record. A marker is consulted only for a log the server has NOT
 * reported as completed, and `unknown` is rendered distinctly from `failed` because "the client
 * could not establish what happened" is not the same claim as "the import did not happen".
 */
const ImportLogStatusBadge = ({ status, attempt }: { status?: BankStatementImportLog['status'], attempt?: ImportAttemptStatus }) => {

    if (status === "Completed") {
        return <Badge theme="green">{_("Completed")}</Badge>
    }

    if (attempt === 'failed') {
        // Solid, not the subtle default: subtle red renders this 12px label at 4.41:1 in dark mode,
        // below the WCAG AA 4.5:1 floor for normal text, while solid red clears it in both themes.
        return <Badge variant="solid" theme="red">{_("Failed")}</Badge>
    }

    if (attempt === 'invalid') {
        /*
         * FM2's zero-row case, and the reason it is a state of its own rather than `Failed`: nothing
         * was attempted and nothing was refused - the SERVER parsed the file and recognised no
         * transactions in it, so there is nothing to import from it at all. The log's status is
         * accurate and permanently `Not Started`, which is exactly why the list needed this: an
         * unusable file was otherwise presented like a statement merely waiting its turn, and the
         * only explanation of it lived on the detail screen the reviewer would have to open first.
         *
         * It shares the solid red treatment with `Failed` for the same contrast reason, and is told
         * apart from it by its LABEL and its ICON rather than by colour alone - so the distinction
         * survives for a reviewer who cannot rely on hue. The explanation is carried on the chip
         * itself (`aria-label` for assistive technology, tooltip for pointer and keyboard), because
         * by the time the reviewer is looking at this row, whatever was said on the detail screen is
         * long gone.
         */
        const invalidExplanation = _("The server could not read any transactions from this file, so there is nothing to import. It may be empty, or its columns may not have been recognised.")

        return <Tooltip>
            <TooltipTrigger asChild>
                {/*
                  * `tabIndex` and the focus ring for the same reason as the `unknown` chip below:
                  * `asChild` hands the trigger role to a `<span>`, and Radix adds no `tabIndex`, so
                  * without these the explanation is reachable by POINTER ONLY.
                  */}
                <Badge
                    variant="solid"
                    theme="red"
                    tabIndex={0}
                    className="outline-none focus-visible:shadow-focus-red"
                    aria-label={`${_("No Transactions")}. ${invalidExplanation}`}>
                    <AlertCircleIcon aria-hidden="true" />
                    {_("No Transactions")}
                </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
                {invalidExplanation}
            </TooltipContent>
        </Tooltip>
    }

    if (attempt === 'unknown') {
        /*
         * The one state whose LABEL cannot carry its own meaning. "Completed", "Not Started" and
         * "Failed" each say what happened; "Unknown" says only that the client could not find out,
         * which is useless to a reviewer without the rest of the sentence - and the rest of the
         * sentence was previously only ever available in the dialog raised at the moment of the
         * attempt, or in an inline banner belonging to whatever fetch was failing at the time. Both
         * are gone by the time the reviewer is looking at this row, while the marker persists.
         *
         * So the explanation is attached to the chip itself: an `aria-label` carrying the whole
         * meaning (assistive technology gets it without hovering, and it replaces the bare word
         * rather than supplementing it), a question-mark glyph so the state is distinguishable from
         * `Failed` without relying on fill or hue, and a tooltip for pointer and keyboard users.
         * The chip's own tokens are deliberately unchanged - `orange` is the compound variant that
         * resolves to the amber surface tokens, since the Badge primitive exposes no literal
         * `amber` theme - so the four states keep the exact colours they are verified against.
         *
         * The copy is outcome-INDETERMINATE on purpose, for the same reason the dialog's is: the
         * client not learning the answer is not evidence the import did not happen, and telling a
         * reviewer it failed would invite a re-import of work that may already exist.
         */
        const unknownExplanation = _("The last import attempt for this file did not finish, and it could not be established whether the server recorded it. Open this import to check its current state before importing the file again.")

        return <Tooltip>
            <TooltipTrigger asChild>
                {/*
                  * `tabIndex` and the focus ring are BOTH required, and neither comes for free.
                  * Radix's tooltip trigger is a focusable button by default, but `asChild` hands that
                  * role to this Badge - a `<span>` - and Radix adds no `tabIndex` of its own, so
                  * without this the chip is skipped by Tab entirely and the tooltip is reachable by
                  * POINTER ONLY. The `aria-label` above already covers screen readers; this covers
                  * the sighted keyboard-only reviewer, who otherwise has no route to the explanation.
                  * The ring uses the amber focus token, matching the chip's own theme, because a new
                  * tab stop with no visible focus state would trade one accessibility gap for
                  * another. Both are additive: no colour, size or variant of the chip changes.
                  */}
                <Badge
                    theme="orange"
                    tabIndex={0}
                    className="outline-none focus-visible:shadow-focus-amber"
                    aria-label={`${_("Unknown")}. ${unknownExplanation}`}>
                    <CircleHelpIcon aria-hidden="true" />
                    {_("Unknown")}
                </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
                {unknownExplanation}
            </TooltipContent>
        </Tooltip>
    }

    return <Badge theme="gray">{status}</Badge>
}

const StatementImportLog = () => {

    const bankAccount = useAtomValue(selectedBankAccountAtom)

    // Drives the "Failed" and "Unknown" states of the per-row status badge below. The import log
    // persists no error field and its status never advances past "Not Started" when a synchronous
    // import rolls back, so an attempt the server confirms as not-completed is the only failure
    // signal available. The marker never overrides an authoritative `Completed` - see
    // `ImportLogStatusBadge` - and the setter is held so server truth can retire a stale marker.
    // Read here, never inside the row map: it is a hook.
    const [importFailures, setImportFailures] = useAtom(bankRecImportFailuresAtom)

    const { data, error } = useFrappeGetDocList<BankStatementImportLog>("Bank Statement Import Log", {
        // `currency` is projected because the row renders a MONETARY figure. It is a native
        // read-only field on this DocType, populated from the bank account's GL account currency,
        // and without it `formatCurrency` falls back to the system default - so every historical
        // closing balance on a non-default-currency account was labelled with the wrong symbol.
        // The projection stays otherwise minimal: nothing here reaches for a field the row does not
        // render, and in particular nothing password-bearing.
        fields: ["name", "file", "status", "currency", "number_of_transactions", "start_date", "end_date", "closing_balance", "creation"],
        filters: [["bank_account", "=", bankAccount?.name ?? ""]],
        orderBy: {
            field: "creation",
            order: "desc"
        },
        limit: 10
    }, bankAccount ? undefined : null, {
        revalidateOnFocus: false
    })

    // Server truth RETIRES client markers: every log this freshly fetched list reports as
    // `Completed` has its attempt marker dropped, so a marker cannot outlive the condition it
    // described - including one recorded as `unknown` for an import that had in fact succeeded.
    // The map is rebuilt only when something actually needs removing, so this cannot loop.
    //
    // Scoped to the bank this list actually queried: a per-account list is evidence about that
    // account's logs and about nothing else, so it must not reach into another account's markers.
    useEffect(() => {
        if (!data || !bankAccount) {
            return
        }

        const completed = data.filter((log) => log.status === "Completed").map((log) => log.name)

        if (completed.length === 0) {
            return
        }

        setImportFailures((previousAttempts) => withCompletedImportAttemptsRetired(previousAttempts, bankAccount.name, completed))
    }, [data, bankAccount, setImportFailures])

    const navigate = useNavigate()

    const onViewDetails = (name: string) => {
        navigate(`/statement-importer/${name}`)
    }

    return (
        <div className="flex flex-col gap-4">
            <H3 className="text-base">{_("Previous Imports")}</H3>

            {/*
              * Normalised for the same reason as the upload banners: if this list query loses its
              * response, the SDK hands back its own `TypeError` rather than a Frappe envelope, and
              * that must not be what the user reads.
              */}
            {error && <ErrorBanner error={toDisplayError(error)} />}

            {data && data.length > 0 ? (

                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{_("Imported On")}</TableHead>
                            <TableHead>{_("Status")}</TableHead>
                            <TableHead>{_("Transaction Dates")}</TableHead>
                            <TableHead className="text-end">{_("Number of Transactions")}</TableHead>
                            <TableHead className="text-end">{_("Closing Balance")}</TableHead>
                            <TableHead>{_("File")}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data?.map((item) => (
                            <TableRow key={item.name} onClick={() => onViewDetails(item.name)} className="cursor-pointer hover:bg-surface-gray-2">
                                <TableCell>{formatDate(item.creation, 'Do MMM YYYY')}</TableCell>
                                <TableCell><ImportLogStatusBadge status={item.status} attempt={getImportAttempt(importFailures, bankAccount?.name, item.name)} /></TableCell>
                                <TableCell>
                                    {item.start_date && item.end_date ? (
                                        <span>{formatDate(item.start_date, 'Do MMM YYYY')} to {formatDate(item.end_date, 'Do MMM YYYY')}</span>
                                    ) : (
                                        <span>-</span>
                                    )}
                                </TableCell>
                                <TableCell className="text-end">{item.number_of_transactions}</TableCell>
                                {/* Formatted in the LOG's own currency, which is the currency the
                                    figure is denominated in. Passing nothing let it default to the
                                    system currency, so an account in another currency reported its
                                    balances under the wrong symbol. */}
                                <TableCell className="text-end font-numeric">{formatCurrency(flt(item.closing_balance, 2), item.currency)}</TableCell>
                                <TableCell><a
                                    href={item.file}
                                    target="_blank" className="underline underline-offset-4">{item.file.split('/').pop()}</a></TableCell>
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