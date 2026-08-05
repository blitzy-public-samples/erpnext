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
import { useFrappeCreateDoc, useFrappeFileUpload, useFrappeGetDocList, useFrappeUpdateDoc } from "frappe-react-sdk"
import type { FrappeError } from "frappe-react-sdk"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { ListIcon, Loader2Icon } from "lucide-react"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { bankRecErrorDialogAtom } from "@/components/features/BankReconciliation/bankRecAtoms"


const BankStatementImporter = () => {

    const selectedCompany = useCurrentCompany()

    const [selectedBankAccount] = useAtom(selectedBankAccountAtom)

    const [files, setFiles] = useState<File[]>([])
    const [password, setPassword] = useState("")

    const { upload, error, loading } = useFrappeFileUpload()

    const navigate = useNavigate()
    const { createDoc, loading: createLoading, error: createError } = useFrappeCreateDoc<BankStatementImportLog>()
    const { updateDoc, error: updateError } = useFrappeUpdateDoc()

    const setBankRecErrorDialog = useSetAtom(bankRecErrorDialogAtom)

    const isPdf = files[0]?.name?.toLowerCase().endsWith(".pdf") ?? false

    const onUpload = () => {

        if (!selectedBankAccount) {
            return
        }

        const id = `new-bank-statement-import-log-${Date.now()}`

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
            return createDoc("Bank Statement Import Log",
                // @ts-expect-error - not filling everything else
                {
                    name: id,
                    file: file.file_url,
                    bank_account: selectedBankAccount.name
                })
        }).then((doc) => {
            navigate(`/statement-importer/${doc.name}`)
        }).catch((uploadError: FrappeError) => {
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
             */
            setBankRecErrorDialog(uploadError)
            toast.error(_("The bank statement could not be uploaded."))
        })
    }

    return (
        <div className="flex px-4">
            <div className="w-[52%]">
                {error && <ErrorBanner error={error} />}
                {createError && <ErrorBanner error={createError} />}
                {updateError && <ErrorBanner error={updateError} />}
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
            <div className="w-[48%] border-s border-outline-gray-2 ps-4">
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