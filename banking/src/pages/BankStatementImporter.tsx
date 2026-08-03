import BankPicker from "@/components/features/BankReconciliation/BankPicker"
import { bankRecErrorDialogAtom, bankRecImportFailuresAtom, bankRecPreImportFailuresAtom, getImportAttempt, selectedBankAccountAtom, withCompletedImportAttemptsRetired, type ImportAttemptStatus } from "@/components/features/BankReconciliation/bankRecAtoms"
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
import { toDisplayError } from "@/components/features/BankReconciliation/utils"
import { useCurrentCompany } from "@/hooks/useCurrentCompany"
import { formatDate } from "@/lib/date"
import { flt, formatCurrency } from "@/lib/numbers"
import _ from "@/lib/translate"
import { cn } from "@/lib/utils"
import { BankStatementImportLog } from "@/types/Accounts/BankStatementImportLog"
import { useFrappeCreateDoc, useFrappeFileUpload, useFrappeGetDocList, useFrappeUpdateDoc } from "frappe-react-sdk"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { CircleHelpIcon, ListIcon, Loader2Icon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"


const BankStatementImporter = () => {

    const selectedCompany = useCurrentCompany()

    const [selectedBankAccount] = useAtom(selectedBankAccountAtom)

    const setErrorDialog = useSetAtom(bankRecErrorDialogAtom)

    // FM2 pre-log failures: keyed by file name, because no import log exists to key them by.
    const [preImportFailures, setPreImportFailures] = useAtom(bankRecPreImportFailuresAtom)

    const [files, setFiles] = useState<File[]>([])
    const [password, setPassword] = useState("")

    const { upload, error, loading } = useFrappeFileUpload()

    const navigate = useNavigate()
    const { createDoc, loading: createLoading, error: createError } = useFrappeCreateDoc<BankStatementImportLog>()
    const { updateDoc, error: updateError } = useFrappeUpdateDoc()

    const isPdf = files[0]?.name?.toLowerCase().endsWith(".pdf") ?? false

    /**
     * SINGLE FLIGHT over the WHOLE upload chain.
     *
     * The chain is three server operations - save the statement password, upload the file, create the
     * import log - and the Upload control was held closed by `loading || createLoading`, which are the
     * upload hook's and the create hook's own in-flight flags. Neither covers the FIRST step: the
     * update hook's `loading` was never read, so for the entire duration of a protected-PDF password
     * save the control was enabled and a second click started a SECOND chain from the beginning. Each
     * chain mints its own `new-bank-statement-import-log-…` name, so both complete, and nothing
     * de-duplicates the two logs afterwards - the same statement can then be imported twice, once
     * from each. The hook flags also go quiet in the gaps BETWEEN steps, which is a second, narrower
     * version of the same window.
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

    // Whether any failure has already been attributed to a specific file. Used only to keep the
    // unattributed hook banners from repeating a message the per-file surface already shows.
    const hasAttributedFailure = Object.keys(preImportFailures).length > 0

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

        const id = `new-bank-statement-import-log-${Date.now()}`

        // For protected PDFs, persist the password on the Bank Account so it is reused for
        // every statement of this account (and is available before the import doc is created).
        const ensurePassword = isPdf && password
            ? updateDoc("Bank Account", selectedBankAccount.name, { statement_password: password })
            : Promise.resolve()

        const fileName = files[0]?.name ?? ""

        // A retry supersedes whatever the previous attempt observed, so the stale marker goes
        // before the request does rather than after it resolves.
        setPreImportFailures((previous) => {
            if (previous[fileName] === undefined) {
                return previous
            }
            return Object.fromEntries(Object.entries(previous).filter(([name]) => name !== fileName))
        })

        ensurePassword.then(() => upload(files[0], {
            isPrivate: true,
            doctype: "Bank Statement Import Log",
            docname: id,
            fieldname: 'file'
        })).then((file) => {
            return createDoc("Bank Statement Import Log",
                // @ts-expect-error - not filling everything else
                {
                    name: id,
                    file: file.file_url,
                    bank_account: selectedBankAccount.name
                })
        }).then((doc) => {
            navigate(`/statement-importer/${doc.name}`)
        }).catch((uploadError: unknown) => {
            /*
             * FM2, pre-log case. This chain can fail while saving the statement password, while
             * uploading the file, or while creating the import log - and in every one of those cases
             * NO import log exists yet. There is therefore no document to carry a status and no row
             * for the importer list to render, so the log-keyed markers used elsewhere cannot
             * represent this failure at all. It is recorded against the FILE NAME instead, which is
             * the only identifier the attempt has, and surfaced next to the upload control.
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
            setErrorDialog(displayError)
            setPreImportFailures((previous) => ({ ...previous, [fileName]: displayError }))

            // The chain ended without an import log, so retrying is the user's to do and the control
            // reopens. Lowered HERE and nowhere else: a chain that got as far as creating the log
            // navigates away from this form, and reopening the control behind that hand-off is exactly
            // what would let the same statement be uploaded a second time.
            uploadInFlight.current = false
            setIsUploading(false)
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
                {Object.entries(preImportFailures).map(([failedFileName, failedError]) => (
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
        fields: ["name", "file", "status", "number_of_transactions", "start_date", "end_date", "closing_balance", "creation"],
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
                                <TableCell className="text-end font-numeric">{formatCurrency(flt(item.closing_balance, 2))}</TableCell>
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