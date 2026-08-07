import BankPicker from "@/components/features/BankReconciliation/BankPicker"
import BankRecErrorDialog from "@/components/features/BankReconciliation/BankRecErrorDialog"
import { bankRecImportFailuresAtom, selectedBankAccountAtom } from "@/components/features/BankReconciliation/bankRecAtoms"
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
import { H3, Paragraph } from "@/components/ui/typography"
import { useCurrentCompany } from "@/hooks/useCurrentCompany"
import { formatDate } from "@/lib/date"
import { flt, formatCurrency } from "@/lib/numbers"
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
     * The file the last upload attempt was refused for, so the form can carry a per-file failure
     * indicator for a refusal that happened before any import log existed.
     *
     * This deliberately does NOT go in `bankRecImportFailuresAtom`: that map is keyed by `Bank Statement
     * Import Log` name and pruned against the fetched rows, and a refusal here happens before creation
     * succeeds - there is no name to key it against and no row to hang it from. Component-local for the
     * same reason that atom is not persisted: a failure marker must not outlive the attempt that caused
     * it, so it dies with the page and with any change of file.
     */
    const [refusedFileName, setRefusedFileName] = useState<string | null>(null)

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

        // A fresh attempt supersedes whatever the last one concluded, so the indicator clears before the
        // request goes out rather than lingering over a file that is being retried.
        const attemptedFile = files[0]
        setRefusedFileName(null)

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
             * Recording the attempted file name is what completes FM2's per-file failure indicator for
             * this path: the modal is transient and the list on the right can only badge rows the server
             * actually has, so without it a refused statement left no trace once the modal was gone.
             */
            setBankRecErrorDialog(uploadError)
            setRefusedFileName(attemptedFile?.name ?? null)
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

                        {/* FM2's per-file failure indicator for a statement the server refused before any
                            import log existed. Gated on the name so it describes THIS file rather than the
                            form: replacing or clearing the selection retires it, as does a fresh attempt.

                            Same `solid` red token language as the per-row badge in Previous Imports, so
                            one failure reads the same way wherever it is shown.

                            Deliberately NOT a live region. The modal announced this refusal already and
                            took focus for it, and the inline banner above carries `role="alert"`; a third
                            announcement of the same words would only talk over them. This is the durable
                            visual trace, which is precisely what the transient surfaces cannot be. */}
                        {refusedFileName && files[0]?.name === refusedFileName &&
                            <div className="flex items-center gap-2 flex-wrap">
                                <Badge variant="solid" theme="red">{_("Failed")}</Badge>
                                <span className="text-ink-gray-6 text-p-sm wrap-anywhere">
                                    {_("{0} was refused and nothing was imported from it. Correct it or choose another, then upload again.", [refusedFileName])}
                                </span>
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
                    <div className="flex justify-end px-4">
                        <Button
                            onClick={onUpload}
                            size='md'
                            disabled={files.length === 0 || loading || createLoading || !selectedBankAccount || !selectedCompany}>
                            {loading || createLoading ? <Loader2Icon className="size-4 animate-spin" /> : null}
                            {loading || createLoading ? _("Uploading...") : _("Upload")}
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
            <H3 className="text-base">{_("Previous Imports")}</H3>

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
                <Table>
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
                                    <Link
                                        to={`/statement-importer/${item.name}`}
                                        onClick={(event) => event.stopPropagation()}
                                        className="underline underline-offset-4 rounded focus-visible:shadow-focus-gray focus-visible:outline-none">
                                        {formatDate(item.creation, 'Do MMM YYYY')}
                                    </Link>
                                </TableCell>
                                {/* The server's `Completed` is checked FIRST, so an authoritative
                                    success always outranks a marker left by an earlier failed attempt.
                                    `solid` red rather than the default `subtle`: subtle red on the dark
                                    surface measures 4.407:1, under the 4.5:1 WCAG AA floor for this
                                    text size, whereas solid puts `ink-red-1` on `surface-red-5`. */}
                                <TableCell>{item.status === "Completed"
                                    ? <Badge theme="green">{item.status}</Badge>
                                    : importFailures[item.name]
                                        ? <Badge variant="solid" theme="red">{_("Failed")}</Badge>
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