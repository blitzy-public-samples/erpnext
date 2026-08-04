import BankPicker from "@/components/features/BankReconciliation/BankPicker"
import { bankRecErrorDialogAtom, bankRecImportFailuresAtom, bankRecPreLogImportFailuresAtom, preLogImportFailureKey, selectedBankAccountAtom } from "@/components/features/BankReconciliation/bankRecAtoms"
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { H3, Paragraph } from "@/components/ui/typography"
import { useCurrentCompany } from "@/hooks/useCurrentCompany"
import { formatDate } from "@/lib/date"
import { getErrorMessage } from "@/lib/frappe"
import { flt, formatCurrency } from "@/lib/numbers"
import _ from "@/lib/translate"
import { cn } from "@/lib/utils"
import { BankStatementImportLog } from "@/types/Accounts/BankStatementImportLog"
import { useFrappeCreateDoc, useFrappeFileUpload, useFrappeGetDocList, useFrappeUpdateDoc, type FrappeError } from "frappe-react-sdk"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { ListIcon, Loader2Icon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"


const BankStatementImporter = () => {

    const selectedCompany = useCurrentCompany()

    const [selectedBankAccount] = useAtom(selectedBankAccountAtom)

    const [files, setFiles] = useState<File[]>([])
    const [password, setPassword] = useState("")

    const { upload, error, loading } = useFrappeFileUpload()

    const navigate = useNavigate()
    const { createDoc, loading: createLoading, error: createError } = useFrappeCreateDoc<BankStatementImportLog>()
    /*
     * F-12: `loading` is destructured here as well, and it is not decoration. This one hook serves
     * BOTH writes the chain performs - the PDF password onto the `Bank Account`, and the private
     * `File` relink afterwards - so without it the button stayed enabled through the whole opening
     * phase of the chain, which is precisely the window a second click could exploit.
     */
    const { updateDoc, loading: updateLoading, error: updateError } = useFrappeUpdateDoc()

    const setErrorDialog = useSetAtom(bankRecErrorDialogAtom)
    const setPreLogFailures = useSetAtom(bankRecPreLogImportFailuresAtom)

    /*
     * THE SINGLE-FLIGHT GUARD, in two halves, because one value cannot do both jobs.
     *
     * `uploadInFlight` is a ref, and it is the guard itself. The chain is a promise sequence whose
     * FIRST step may be a server round-trip (the PDF password save), so for the whole of that
     * round-trip none of the hook `loading` flags is set yet: `upload` has not been called, `createDoc`
     * has not been called, and before this change `updateDoc`'s flag was not even read. The button was
     * therefore live while a chain was already running, and a second click started a SECOND complete
     * chain - a second private `File` uploaded and a second `Bank Statement Import Log` created, of
     * which the reviewer would be navigated to exactly one and would never learn about the other. A
     * ref is what closes it: two clicks dispatched in one tick both read the same mutable cell, whereas
     * a state variable would hand the second click the pre-click snapshot and let it through.
     *
     * `isChainRunning` is state, and it exists only so the button can RENDER the disabled state - a ref
     * mutation schedules no re-render. Both are cleared together when the chain settles, either way.
     */
    const uploadInFlight = useRef(false)
    const [isChainRunning, setIsChainRunning] = useState(false)

    const isPdf = files[0]?.name?.toLowerCase().endsWith(".pdf") ?? false

    const onUpload = () => {

        const file = files[0]

        if (!selectedBankAccount || !file) {
            return
        }

        // F-12. Read-and-set with nothing awaited in between, so no second click can observe `false`.
        if (uploadInFlight.current) {
            return
        }
        uploadInFlight.current = true
        setIsChainRunning(true)

        // Captured now: both are free to change under the reviewer while the chain is in flight, and
        // every step below - including the failure record - must describe the attempt that was made.
        const bankAccountName = selectedBankAccount.name
        const failureKey = preLogImportFailureKey(bankAccountName, file)

        /*
         * FM2: a retry retires the previous verdict about this exact account/file pair before the new
         * attempt runs, for the same reason the import step does it - a marker records one observation
         * of one refusal, and leaving it up while a fresh attempt is in flight asserts a failure that is
         * being actively re-tested.
         */
        setPreLogFailures((previous) => {
            if (!previous.has(failureKey)) return previous
            const next = new Map(previous)
            next.delete(failureKey)
            return next
        })

        // For protected PDFs, persist the password on the Bank Account so it is reused for
        // every statement of this account (and is available before the import doc is created).
        const ensurePassword = isPdf && password
            ? updateDoc("Bank Account", bankAccountName, { statement_password: password })
            : Promise.resolve()

        ensurePassword.then(() => upload(file, {
            /*
             * F-15: UPLOADED UNATTACHED, deliberately, and the omission is the fix.
             *
             * This call used to pass `docname: id` for a client-invented
             * `new-bank-statement-import-log-<timestamp>`, and then hand the same `id` to `createDoc` as
             * `name`. That identity never existed. `Bank Statement Import Log` is `autoname: hash`, and
             * Frappe's `set_new_name` discards a client-supplied name for every autoname mode except
             * `prompt` - so the server minted a hash and the `File` was left pointing
             * `attached_to_name` at a document that was never created. The import still worked, because
             * the log stores the file URL, but the attachment was an orphan: it did not appear among the
             * log's attachments, and its lifecycle was no longer tied to the log's.
             *
             * So the identity is left for the server to mint, and the `File` is relinked to the real
             * name once it is known. `FileArgs` makes every member optional, so an unattached private
             * upload is a supported call, and the reviewer is its owner until the relink lands.
             */
            isPrivate: true
        })).then((uploaded) => createDoc("Bank Statement Import Log",
            // @ts-expect-error - not filling everything else
            {
                // NO `name` here: see the note above. `file` and `bank_account` are both `reqd: 1`,
                // which is also why the file has to exist before the log can.
                file: uploaded.file_url,
                bank_account: bankAccountName
            }).then((doc) => ({ uploaded, doc }))
        ).then(({ uploaded, doc }) =>
            /*
             * F-15, second half: point the private `File` at the name the SERVER chose.
             * `File.validate_attachment_references` permits exactly this update, and it is what makes
             * the statement appear among the log's attachments and share its lifecycle.
             *
             * A refused relink does NOT withhold navigation and does NOT record a failure. Nothing was
             * refused that matters to the reviewer: the log exists, its `file` field holds the URL, and
             * the import reads that URL - so the statement is fully importable. Reporting this as an
             * import failure would be false, and blocking on it would strand a reviewer whose upload in
             * fact succeeded. It is surfaced as a development-only diagnostic instead, carrying no
             * response body.
             */
            updateDoc("File", uploaded.name, {
                attached_to_doctype: "Bank Statement Import Log",
                attached_to_name: doc.name,
                attached_to_field: "file"
            }).catch(() => {
                if (import.meta.env.DEV) {
                    console.warn('[bank-rec] could not relink the statement file', {
                        file: uploaded.name,
                        import_log: doc.name
                    })
                }
            }).then(() => {
                navigate(`/statement-importer/${doc.name}`)
            })
        ).then(undefined, (error: FrappeError) => {
            /*
             * F-03. This chain previously had NO rejection handler at all, so every refusal reachable
             * before a log exists - insufficient permission (the DocType is System Manager only), an
             * invalid or disabled bank account, a file the storage layer would not take, an empty or
             * unreadable statement, a wrong PDF password - produced nothing but whichever generic hook
             * banner happened to be rendered, and left no per-file record whatsoever. FM2 requires the
             * import status view to indicate failure PER FILE, and before this there was no file to
             * indicate against.
             *
             * Attached as the second argument of `.then` rather than as a trailing `.catch`, for the
             * same reason as the import step: a trailing `.catch` would also swallow a fault thrown by
             * the navigation above and report a successful upload as a refused one.
             *
             * The error reaches the dialog UNMODIFIED so `ErrorBanner` parses `_server_messages` itself
             * and the backend's own wording is what the reviewer reads; the SAME parsed text is stored
             * on the marker, so the chip's tooltip and the dialog cannot disagree.
             */
            setErrorDialog(error)
            setPreLogFailures((previous) => {
                const next = new Map(previous)
                next.set(failureKey, {
                    bankAccount: bankAccountName,
                    fileName: file.name,
                    message: getErrorMessage(error)
                })
                return next
            })
        }).finally(() => {
            // Released on BOTH outcomes: a chain that failed must be retryable, and one that succeeded
            // has already navigated away.
            uploadInFlight.current = false
            setIsChainRunning(false)
        })
    }

    return (
        <div className="flex px-4">
            {/* FM1/FM2: the shared dismissible dialog. This page needs its own mount because
                `/statement-importer` is a different route tree from the reconciliation workbench; both
                mounts read one shared atom, so the surfaces can never show conflicting error state. */}
            <BankRecErrorDialog />
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
                        {/* F-12: `isChainRunning` covers the WHOLE chain - including the password save
                            that precedes every hook flag - and `updateLoading` is included so the two
                            writes this hook performs are both accounted for. The busy label keys off the
                            same value, so the control cannot look idle while a chain is open. */}
                        <Button
                            onClick={onUpload}
                            size='md'
                            disabled={files.length === 0 || isChainRunning || loading || createLoading || updateLoading || !selectedBankAccount || !selectedCompany}>
                            {isChainRunning || loading || createLoading || updateLoading ? <Loader2Icon className="size-4 animate-spin" /> : null}
                            {isChainRunning || loading || createLoading || updateLoading ? _("Uploading...") : _("Upload")}
                        </Button>
                    </div>
                </div>
            </div>
            <div className="w-[48%] border-s border-outline-gray-2 ps-4">
                {selectedBankAccount && <StatementImportLog />}
            </div>

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
 * The per-file import status chip, in one of three states.
 *
 * Two are the server's own: `Completed` in green, anything else - which in practice means
 * `Not Started` - in grey. The third is `Failed` in red, shown when this session observed the server
 * refuse an import, because the stored status cannot express that: the import rolls back on failure,
 * so the log is left saying `Not Started`, the same thing it says before anyone has tried at all.
 *
 * PRECEDENCE, AND WHY IT IS THIS WAY ROUND. The marker used to win outright. It must not: a marker is
 * one session's memory of one refusal, while `Completed` is the server's committed record, written by
 * `insert_transactions` as its last act. Once the fetched status says `Completed` the import demonstrably
 * happened - whether it succeeded on a retry, in another tab, or for another user - and a red `Failed`
 * chip over it would be this client contradicting the database about a financial import that exists.
 * So `Completed` wins, and {@link StatementImportLog} retires the stale marker when it sees one, which
 * is what stops a transient refusal from outliving its own truth for the rest of the session.
 *
 * The refusal message is attached as a tooltip rather than left implicit, so the failure is not
 * communicated by colour alone and the reviewer can tell an unreadable file from a disabled bank
 * account without opening the log. The same message is carried on the chip's accessible name and the
 * chip is made a tab stop, because `asChild` hands the trigger role to a <span> and Radix adds no
 * tabIndex of its own - without one the reason would be reachable by pointer only.
 */
const ImportStatusBadge = ({ status, failureMessage }: { status: BankStatementImportLog["status"], failureMessage?: string }) => {

    if (failureMessage && status !== "Completed") {
        return <TooltipProvider>
            <Tooltip>
                {/* `asChild` keeps the Badge - a plain <span> - as the trigger. A bare TooltipTrigger
                    renders its own <button>, which would put an interactive control inside a row that is
                    already click-through to the detail view. */}
                <TooltipTrigger asChild>
                    {/* F-21: making the chip a tab stop without a focus treatment left keyboard users
                        with no indication of where focus was - the reason was reachable but invisibly so.
                        `focus-visible:shadow-focus-red` is the same tokenized ring `Button` uses for its
                        red theme (button.tsx), and `Badge`'s base class already transitions box-shadow,
                        so this needs no new token and no new primitive. `outline-none` replaces the UA
                        outline rather than removing it, which is why it is paired with the ring and not
                        used alone. */}
                    <Badge
                        theme="red"
                        tabIndex={0}
                        className="focus-visible:shadow-focus-red focus-visible:outline-none"
                        aria-label={`${_("Failed")}: ${failureMessage}`}>{_("Failed")}</Badge>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-sm text-balance wrap-break-word">
                    {failureMessage}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    }

    return <Badge theme={status === "Completed" ? "green" : "gray"}>{status}</Badge>
}

const StatementImportLog = () => {

    const bankAccount = useAtomValue(selectedBankAccountAtom)

    /*
     * FM2's per-file failure indicator.
     *
     * `Bank Statement Import Log.status` has exactly two options - `Not Started` and `Completed` - and
     * the DocType carries no error field, so a refused import (which rolls back) leaves the row at
     * `Not Started`, indistinguishable from a statement merely waiting to be imported. The observed
     * synchronous rejection recorded by the import step is therefore the only signal available, and
     * the badge below reads it to render a third, failed state.
     */
    const [importFailures, setImportFailures] = useAtom(bankRecImportFailuresAtom)

    /*
     * F-03: the failures that never reached a log. Filtered to the account on screen, because the key
     * is account-scoped and a refusal recorded against another bank account says nothing about this one.
     */
    const preLogFailures = useAtomValue(bankRecPreLogImportFailuresAtom)

    const { data, error } = useFrappeGetDocList<BankStatementImportLog>("Bank Statement Import Log", {
        /*
         * F-13: `currency` is projected because the closing balance below is formatted with it. It was
         * omitted, so `formatCurrency` fell back to the SYSTEM default and a statement on a
         * foreign-currency bank account had its balance rendered with the wrong symbol and the wrong
         * decimal convention - silently, and on the one figure a reviewer uses to decide whether the
         * import tallies. `Bank Statement Import Log.currency` is a Link to Currency, populated
         * read-only from the bank account's GL account, so the value is already there to be asked for.
         */
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

    /*
     * F-11: retire a marker the server has since contradicted.
     *
     * `Completed` is the committed record and it outranks this session's memory of a refusal, so once a
     * fetched row says `Completed` the marker for that log is not merely outranked for rendering - it is
     * WRONG, and keeping it would leave a false entry to be read by anything else that consults the map.
     * Retiring it here, where the authoritative status is actually observed, is what makes a
     * failed-then-succeeded import converge instead of staying marked for the rest of the session.
     *
     * The map is returned unchanged when there is nothing to retire, so this cannot loop: no new
     * reference means no notification means no re-run.
     */
    useEffect(() => {
        const completed = (data ?? []).filter((item) => item.status === "Completed")
        if (completed.length === 0) return

        setImportFailures((previous) => {
            if (!completed.some((item) => previous.has(item.name))) return previous
            const next = new Map(previous)
            completed.forEach((item) => next.delete(item.name))
            return next
        })
    }, [data, setImportFailures])

    const preLogRows = useMemo(
        () => bankAccount
            ? [...preLogFailures].filter(([, failure]) => failure.bankAccount === bankAccount.name)
            : [],
        [preLogFailures, bankAccount]
    )

    const navigate = useNavigate()

    const onViewDetails = (name: string) => {
        navigate(`/statement-importer/${name}`)
    }

    return (
        <div className="flex flex-col gap-4">
            <H3 className="text-base">{_("Previous Imports")}</H3>

            {error && <ErrorBanner error={error} />}

            {(data && data.length > 0) || preLogRows.length > 0 ? (

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
                        {/*
                          * F-03: the upload attempts that never became logs, listed FIRST because they
                          * are the most recent thing that happened and the list is newest-first.
                          *
                          * Every server-owned cell reads "-" rather than a fabricated value: there is no
                          * import date, no transaction range, no count and no closing balance, because
                          * there is no document. The file name is plain text rather than a link for the
                          * same reason - on the paths that fail before or during the upload there may be
                          * no stored file to link to, and offering one would invite a dead download. The
                          * row is not click-through either: there is nothing to open.
                          */}
                        {preLogRows.map(([key, failure]) => (
                            <TableRow key={key} className="bg-surface-red-1">
                                <TableCell className="text-ink-gray-5">-</TableCell>
                                <TableCell><ImportStatusBadge status="Not Started" failureMessage={failure.message} /></TableCell>
                                <TableCell className="text-ink-gray-5">-</TableCell>
                                <TableCell className="text-end text-ink-gray-5">-</TableCell>
                                <TableCell className="text-end text-ink-gray-5">-</TableCell>
                                <TableCell className="text-ink-gray-6">{failure.fileName}</TableCell>
                            </TableRow>
                        ))}
                        {data?.map((item) => (
                            <TableRow key={item.name} onClick={() => onViewDetails(item.name)} className="cursor-pointer hover:bg-surface-gray-2">
                                <TableCell>{formatDate(item.creation, 'Do MMM YYYY')}</TableCell>
                                <TableCell><ImportStatusBadge status={item.status} failureMessage={importFailures.get(item.name)} /></TableCell>
                                <TableCell>
                                    {item.start_date && item.end_date ? (
                                        <span>{formatDate(item.start_date, 'Do MMM YYYY')} to {formatDate(item.end_date, 'Do MMM YYYY')}</span>
                                    ) : (
                                        <span>-</span>
                                    )}
                                </TableCell>
                                <TableCell className="text-end">{item.number_of_transactions}</TableCell>
                                {/* F-13: formatted in the STATEMENT's currency, projected above. */}
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