import _ from '@/lib/translate'
import { GetStatementDetailsResponse } from '../import_utils'
import { flt, formatCurrency } from '@/lib/numbers'
import { formatDate } from '@/lib/date'
import { bankRecDateAtom, bankRecErrorDialogAtom, bankRecImportFailuresAtom } from '../../BankReconciliation/bankRecAtoms'
import { AlertCircleIcon, ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon, InfoIcon, Loader2Icon } from 'lucide-react'
import { H2, H3, Paragraph } from '@/components/ui/typography'
import { FileTypeIcon } from '@/components/ui/file-dropzone'
import { getFileExtension } from '@/lib/file'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useFrappeEventListener, useFrappePostCall } from 'frappe-react-sdk'
import type { FrappeError } from 'frappe-react-sdk'
import { toast } from 'sonner'
import ErrorBanner from '@/components/ui/error-banner'
import { makeClientRefusal } from '@/lib/frappe'
import { Link, useNavigate } from 'react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Progress } from '@/components/ui/progress'
import { useSetAtom } from 'jotai'
import { useDirection } from '@/components/ui/direction'
import BankLogo from '@/components/common/BankLogo'
import { useGetBankAccounts } from '../../BankReconciliation/utils'
import BankRecErrorDialog from '../../BankReconciliation/BankRecErrorDialog'
import { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

const parseDateFormat = (dateFormat: string) => {

    const charMap = {
        "%d": "DD",
        "%m": "MM",
        "%Y": "YYYY",
        "%y": "YY",
        "%b": "MMM",
        "%B": "MMMM",
    }

    let label = dateFormat

    Object.keys(charMap).forEach((char) => {
        label = label.replace(char, charMap[char as keyof typeof charMap])
    })

    return dateFormat

}

type Props = {
    data: GetStatementDetailsResponse,
}

const StatementDetails = ({ data }: Props) => {
    const dateFormat = parseDateFormat(data.date_format)

    const { call, loading, error } = useFrappePostCall<{ docs: BankStatementImportLog[] }>('run_doc_method')

    const navigate = useNavigate()

    const setDates = useSetAtom(bankRecDateAtom)

    const setBankRecErrorDialog = useSetAtom(bankRecErrorDialogAtom)
    const setImportFailures = useSetAtom(bankRecImportFailuresAtom)

    const direction = useDirection()

    /*
     * Which import attempt, if any, is still in flight. A ref rather than state because the realtime
     * listener below must read the CURRENT value: the payload carries no import-log identity, so
     * "an attempt this screen started has not settled yet" is the only honest gate available against a
     * delayed event from a superseded attempt.
     */
    const attemptRef = useRef(0)
    const activeAttemptRef = useRef<number | null>(null)

    /*
     * Whether this screen is still on the reviewer's page. An import is a single server-side operation
     * that keeps running whether or not anyone is watching, so its promise can settle long after the
     * reviewer has clicked Back - and when it did, the continuation reached straight past the screen it
     * belonged to: it rewrote the workbench's persisted date range, raised a success toast over whatever
     * route the reviewer had moved to, and pushed a navigation to `/` that buried the history entry they
     * had deliberately gone back to.
     *
     * `true` is re-asserted in the effect body rather than only initialised, because StrictMode mounts,
     * tears down and re-mounts in development - a ref set false by the first cleanup would otherwise
     * stay false for the life of the real mount.
     */
    const isMountedRef = useRef(true)
    useEffect(() => {
        isMountedRef.current = true
        return () => { isMountedRef.current = false }
    }, [])

    const onImport = () => {

        // Reset before dispatching, so a retry never starts from the bar the previous attempt left
        // behind, and so the bar is visible at zero rather than appearing part-way through.
        const attempt = ++attemptRef.current
        activeAttemptRef.current = attempt
        setProgress({ percent: 0 })

        /*
         * Deliberately NOT abortable. The suggested remedy for the stale-continuation defect was an
         * AbortController, but aborting this XHR would abandon only the client's half: the server would
         * carry on writing the transactions and committing, and the reviewer would be left with an import
         * that had really happened and no record of it either way. The server is the authority on what
         * was recorded, so the request is always allowed to finish - what is guarded is which of its
         * consequences are permitted to touch a screen the reviewer has left.
         */
        call({
            docs: data.doc,
            method: 'insert_transactions'
        }).then((response) => {
            // A newer attempt owns the screen; this one's outcome is history and must not overwrite it.
            if (activeAttemptRef.current !== attempt) return
            activeAttemptRef.current = null

            /*
             * A fact about the FILE, so it is recorded whatever became of this screen: a confirmed
             * success retires any failure marker an earlier attempt left, so a stale marker cannot keep
             * labelling a log that has since imported cleanly. This writes to a store, not to a mounted
             * component, and the importer list reads it wherever the reviewer happens to be.
             */
            setImportFailures((failures) => {
                if (!(data.doc.name in failures)) return failures
                return Object.fromEntries(
                    Object.entries(failures).filter(([name]) => name !== data.doc.name)
                )
            })

            /*
             * Everything below changes what the reviewer is LOOKING AT - their persisted date range, a
             * toast, and a navigation - so none of it may happen once they have left this screen.
             */
            if (!isMountedRef.current) return

            const doc = response.docs ? response.docs[0] : undefined
            if (doc && doc.start_date && doc.end_date) {
                setDates({
                    fromDate: doc.start_date,
                    toDate: doc.end_date,
                })
            }
            toast.success(_("Bank statement imported."))
            navigate(`/`)
        }).catch((error: FrappeError) => {
            if (activeAttemptRef.current !== attempt) return
            activeAttemptRef.current = null

            /*
             * Also a fact about the file, and the ONLY record of it - the import rolled back and the
             * import-log schema has no error field - so it is recorded even if the reviewer has moved on.
             * They then meet the refusal as a red marker against that file in the importer list, which is
             * where they would look for it, rather than as a modal ambushing an unrelated screen.
             */
            setImportFailures((failures) => ({ ...failures, [data.doc.name]: error }))

            if (!isMountedRef.current) return

            // The import rolled back, so any progress already reported describes work that no longer
            // exists. Clearing it is what stops a failed screen showing a part-filled bar.
            setProgress(null)
            toast.error(_("There was an error while importing the bank statement."))
            /* Preserve the raw import error for the shared dialog. */
            setBankRecErrorDialog(error)
        })

    }

    /*
     * `insert_transactions` publishes `{ progress: <PERCENT> }` after every row - `round(done / total *
     * 100)`, not a row count - and then one terminal `{ progress: 100, total: <rows> }`. Modelled as
     * such so the copy can say what each number means, and `null` for "no import is being reported".
     */
    const [progress, setProgress] = useState<{ percent: number, total?: number } | null>(null)

    useFrappeEventListener("bank-rec-statement-import-progress", (event: { progress?: number, total?: number }) => {
        // Ignore anything arriving outside an attempt this screen started and has not yet settled.
        if (activeAttemptRef.current === null) return
        // Clamped here rather than trusted: the server derives the figure with `round(done / total *
        // 100)`, and the bar has to stay a bar for any figure that arrives.
        const percent = Math.min(100, Math.max(0, event.progress ?? 0))
        setProgress({ percent, total: event.total })
    })

    /**
     * The statement was accepted as a file but nothing in it could be read as a transaction.
     *
     * This is a real failure with no server-side record of it: the import log is inserted with
     * `number_of_transactions = 0` and left at `Not Started`, which is indistinguishable from a statement
     * nobody has imported yet. It is derived rather than remembered, so it holds after a reload, in a new
     * tab and for a different reviewer - which is exactly what the transient surfaces could not do.
     */
    const hasNothingToImport = data.doc.status !== 'Completed' && (data.final_transactions?.length ?? 0) === 0

    const file_name = data.doc.file.split("/").pop() ?? ""

    const { banks } = useGetBankAccounts()

    const bank = useMemo(() => {

        return banks?.find((bank) => bank.name === data.doc.bank_account)

    }, [data.doc.bank_account, banks])

    return (
        <div className='flex flex-col gap-4'>
            <div className='flex flex-col gap-4'>
                {/* Wraps rather than compressing: Back and the Import control both carry text, and on a
                    narrow screen a single non-wrapping row squeezed the Import label until it was clipped
                    by the pane edge. */}
                <div className='flex flex-wrap gap-2 justify-between items-center'>
                    <Button size='sm' variant='outline' asChild>
                        <Link to="/statement-importer">
                            {direction === 'ltr' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
                            {_("Back")}
                        </Link>
                    </Button>
                    {data.doc.status === 'Completed' ? <Badge theme='green'>{_("Completed")}</Badge> :
                        <Button onClick={onImport} disabled={loading || data.final_transactions?.length === 0} size='sm' type='button'>
                            {loading ? <Loader2Icon className='size-4 animate-spin' /> : null}
                            {loading ? _("Importing...") : _("Import {0} transactions", [data.final_transactions?.length?.toString() || "0"])}</Button>
                    }
                </div>
                {/*
                  * The blurb answers the state the screen is actually in, rather than one of them.
                  *
                  * It used to tell every reviewer to "click the 'Import' button" - including the one
                  * looking at an already-imported statement, where that button has been replaced by a
                  * Completed badge and there is nothing to click, and the one looking at a statement the
                  * parser found nothing in, where the button is present but disabled. Being told to press
                  * something that is not there is worse than being told nothing.
                  */}
                <div className='flex items-start gap-4'>
                    <div className='flex flex-col gap-1'>
                        <H2 className='text-lg border-0 p-0'>{_("Statement Details")}</H2>
                        <Paragraph className='text-p-sm'><span>
                            {_("We've auto-detected the details of the statement file.")}
                        </span><br />
                            <span>
                                {data.doc.status === 'Completed'
                                    ? _("This statement has already been imported. The details below are what was read from it.")
                                    : hasNothingToImport
                                        ? _("Nothing could be read from this statement as transactions. Correct the header row or the column mapping below, or upload a corrected statement.")
                                        : _("Please review the details below and click the 'Import' button to proceed.")}
                            </span>
                        </Paragraph>
                    </div>
                </div>

                {/*
                  * FM2's reason surface for a statement that WAS accepted as a file but yielded no
                  * transactions.
                  *
                  * This is the quietest of the import failures and was the one with no voice at all. The
                  * file parses, so the framework accepts it and the import log is created; the column
                  * detection then finds nothing it can read as a transaction, so the log is inserted with
                  * zero of them and left at `Not Started`. The reviewer arrived at a screen that looked
                  * ordinary apart from a disabled button reading "Import 0 transactions" - no error, no
                  * dialog, no marker, and nothing saying whether the file was wrong, the mapping was
                  * wrong, or the import had simply not happened yet.
                  *
                  * Stated inline rather than through the shared dialog, deliberately: a dialog is for
                  * something that just happened to a request the reviewer made, and this is a standing
                  * fact about the record they are looking at - it has to still be here after any dialog
                  * would have been dismissed, and after a reload. It also says what to DO, because unlike
                  * a refused upload this one is usually recoverable from this very screen: the header row
                  * and the column mapping are both editable below.
                  */}
                {hasNothingToImport && <ErrorBanner
                    error={makeClientRefusal(
                        _("No transactions could be read from this statement, so there is nothing to import and nothing has been created. This usually means the header row or the column mapping was detected incorrectly - correct them below and the preview will update. If the file is not a bank statement, upload a corrected one instead."),
                        _("No Transactions Found")
                    )}
                />}

                {/* The server's figure is a PERCENTAGE, so it is labelled as one. Only the terminal
                    event carries `total`, which is the row count actually written - the one point at
                    which a transaction count can honestly be shown. */}
                {progress !== null && (() => {
                    /* The wording shown beside the bar is also the bar's spoken value, so a screen reader
                       hears the same thing a sighted reviewer reads rather than a bare percentage. */
                    const progressText = progress.total !== undefined
                        ? _("Imported {0} transactions.", [progress.total.toString()])
                        : _("Importing... {0}% complete", [progress.percent.toString()])

                    return <div className='flex flex-col gap-2'>
                        <Progress
                            value={progress.percent}
                            max={100}
                            size="lg"
                            aria-label={_("Statement import progress")}
                            hintText={progressText}
                        />
                        <span className='text-sm'>{progressText}</span>
                    </div>
                })()}

                {error && <ErrorBanner error={error} />}

                {/*
                  * Every cell in this summary is allowed to wrap. The table primitive defaults each cell to
                  * `whitespace-nowrap`, which is right for a list of many short rows and wrong for this:
                  * the labels here are whole phrases ("Closing Balance as of 5th August 2026") and the
                  * values carry currency and counts, so nowrap forced a horizontal scroll INSIDE the pane
                  * and the reviewed figures ended up off the edge of it. Wrapping keeps every one of them
                  * on screen at any pane width. Applied once here rather than as a class on each of the ten
                  * rows.
                  */}
                <Table className='[&_th]:whitespace-normal [&_td]:whitespace-normal'>
                    <TableBody>
                        <TableRow>
                            <TableHead>{_("Bank Account")}</TableHead>
                            <TableCell>
                                <div className='flex items-center gap-2'>
                                    <BankLogo bank={bank} />
                                    <span className="text-sm">{bank?.account_name}</span>
                                </div>
                            </TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>{_("Account")}</TableHead>
                            <TableCell>
                                <span title="GL Account" className="text-sm">{bank?.account}</span>
                            </TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>{_("Statement File")}</TableHead>
                            <TableCell>
                                <div className='flex items-center gap-2'>
                                    <FileTypeIcon fileType={getFileExtension(file_name)} size='md' showBackground={false} />
                                    {/* `break-all` as well as wrapping: an exported filename is often one
                                        unbroken token, which `whitespace-normal` alone cannot wrap, so it
                                        would still run past the pane edge. `title` carries it whole. */}
                                    <span className='break-all' title={file_name}>{file_name}</span>
                                </div>
                            </TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>{_("Transaction Dates")}</TableHead>
                            {data.doc.start_date && data.doc.end_date ? (
                                <TableCell>{_("{0} to {1}", [formatDate(data.doc.start_date, "Do MMMM YYYY"), formatDate(data.doc.end_date, "Do MMMM YYYY")])}</TableCell>
                            ) : (
                                <TableCell>-</TableCell>
                            )}
                        </TableRow>
                        <TableRow>
                            <TableHead>{_("Number of Transactions")}</TableHead>
                            <TableCell>{data.doc.number_of_transactions}</TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>{_("Total Debits")}</TableHead>
                            <TableCell><span className='font-numeric'>{formatCurrency(flt(data.doc.total_debits, 2), data.doc.currency)}</span> <span className='text-ink-gray-5 font-sans'>({data.doc.total_debit_transactions} {data.doc.total_debit_transactions === 1 ? _("transaction") : _("transactions")})</span></TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>{_("Total Credits")}</TableHead>
                            <TableCell><span className='font-numeric'>{formatCurrency(flt(data.doc.total_credits, 2), data.doc.currency)}</span> <span className='text-ink-gray-5 font-sans'>({data.doc.total_credit_transactions} {data.doc.total_credit_transactions === 1 ? _("transaction") : _("transactions")})</span></TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>{_("Closing Balance as of {}", [formatDate(data.doc.end_date, "Do MMMM YYYY")])}</TableHead>
                            <TableCell className='font-numeric'>{formatCurrency(flt(data.doc.closing_balance, 2), data.doc.currency)}</TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>
                                <div className='flex items-center gap-2'>
                                    {_("Detected Amount Format")} <Tooltip>
                                        {/* A TooltipTrigger renders a focusable button, so an icon-only
                                            trigger reaches the accessibility tree as an unnamed control.
                                            The name is taken from the row's own visible label so the two
                                            can never drift apart. */}
                                        <TooltipTrigger aria-label={_("About {0}", [_("Detected Amount Format")])}><InfoIcon size={16} aria-hidden="true" /></TooltipTrigger>
                                        <TooltipContent>
                                            {_("The amount format detected in the statement file. This is used to parse the deposit and withdrawal values from each row.")}
                                        </TooltipContent>
                                    </Tooltip>
                                </div>
                            </TableHead>
                            <TableCell>{data.doc.detected_amount_format}</TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>
                                <div className='flex items-center gap-2'>
                                    {_("Detected Date Format")}
                                    <Tooltip>
                                        <TooltipTrigger aria-label={_("About {0}", [_("Detected Date Format")])}><InfoIcon size={16} aria-hidden="true" /></TooltipTrigger>
                                        <TooltipContent>
                                            {_("The date format detected in the statement file. This is used to parse the date values.")}
                                        </TooltipContent>
                                    </Tooltip>
                                </div>
                            </TableHead>
                            <TableCell>
                                {dateFormat || data.date_format} (e.g.{" "}
                                {formatDate(new Date(), dateFormat || "YYYY-MM-DD")})
                            </TableCell>
                        </TableRow>
                    </TableBody>
                </Table>
            </div>

            {data.doc.status === "Not Started" ? <>

                <ConflictingTransactions transactions={data.conflicting_transactions} />

                <Separator />

                <div className='flex flex-col gap-4'>
                    <div className='flex flex-col gap-1'>
                        <H3 className='text-base border-0 p-0'>{_("Preview Transactions")}</H3>
                        {/* The zero case is not a quantity of transactions, it is the absence of any, and
                            it needs different words: "0 transactions will be imported ... click the
                            'Import' button" described a button that is present but permanently disabled. */}
                        {hasNothingToImport ? (
                            <Paragraph className='text-p-sm'>{_("No transactions were found in this statement file. Adjust the header row or the column mapping above and this preview will update.")}</Paragraph>
                        ) : data.final_transactions?.length === 1 ? (
                            <Paragraph className='text-p-sm'>{_("We've found 1 transaction in the statement file that will be imported into the system. Please review the details below and click the 'Import' button to proceed.")}</Paragraph>
                        ) : (
                            <Paragraph className='text-p-sm'>{_("{0} transactions will be imported into the system. Please review the details below and click the 'Import' button to proceed.", [data.final_transactions?.length?.toString() || "0"])}</Paragraph>
                        )}
                    </div>
                    <div className='max-h-[400px] overflow-scroll pb-2'>
                        <Table>
                            <TableCaption>{_("Transactions to be imported into the system")}</TableCaption>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className='w-8'>#</TableHead>
                                    <TableHead>{_("Date")}</TableHead>
                                    <TableHead>{_("Description")}</TableHead>
                                    <TableHead>{_("Ref.")}</TableHead>
                                    <TableHead className='text-end'>{_("Withdrawal")}</TableHead>
                                    <TableHead className='text-end'>{_("Deposit")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {data.final_transactions?.map((transaction, index) => (
                                    <TableRow key={index}>
                                        <TableCell className='w-8'>{index + 1}</TableCell>
                                        <TableCell>{formatDate(transaction.date)}</TableCell>
                                        <TableCell className='max-w-[200px] w-fit overflow-hidden text-ellipsis'>{transaction.description}</TableCell>
                                        <TableCell className='max-w-[100px] w-fit overflow-hidden text-ellipsis'>{transaction.reference}</TableCell>
                                        <TableCell className='text-end font-numeric'>{formatCurrency(transaction.withdrawal, data.doc.currency)}</TableCell>
                                        <TableCell className='text-end font-numeric'>{formatCurrency(transaction.deposit, data.doc.currency)}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </div>
            </> : null}

            {/* Mounted here as well as on the reconciliation workbench because those surfaces sit in a
                different route tree; both mounts read the one atom. */}
            <BankRecErrorDialog />
        </div>

    )
}

const ConflictingTransactions = ({ transactions }: { transactions: GetStatementDetailsResponse["conflicting_transactions"] }) => {

    if (transactions.length === 0) {
        return null
    }

    return <>
        <Alert theme="red">
            <AlertCircleIcon />
            <AlertTitle>{_("Conflicting Transactions")}</AlertTitle>
            <AlertDescription>
                {transactions.length === 1 ? _("We've found 1 existing transaction in the system that conflicts with the transactions in the statement file. Are you sure you want to proceed with the import?")
                    : _("We've found {0} existing transactions in the system that conflict with the transactions in the statement file. Are you sure you want to proceed with the import?", [transactions.length.toString()])}

                <div className='py-2'>
                    <Dialog>
                        <DialogTrigger asChild>
                            <Button
                                size='sm'
                                type='button'
                                theme='red'
                                variant='solid'>
                                <span>{transactions.length > 1 ? _("View transactions") : _("View transaction")}</span>
                            </Button>
                        </DialogTrigger>
                        <DialogContent size='7xl'>
                            <DialogHeader>
                                <DialogTitle>{_("Conflicting Transactions")}</DialogTitle>
                                <DialogDescription>
                                    {transactions.length === 1 ? _("We've found 1 existing transaction in the system that conflicts with the transactions in the statement file. Are you sure you want to proceed with the import?")
                                        : _("We've found {0} existing transactions in the system that conflict with the transactions in the statement file. Are you sure you want to proceed with the import?", [transactions.length.toString()])}
                                </DialogDescription>
                            </DialogHeader>

                            <div className='max-h-[400px] overflow-scroll pb-2'>
                                <Table>
                                    <TableCaption>{_("Existing transactions in the system belonging to the same bank account and date range")}</TableCaption>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{_("Date")}</TableHead>
                                            <TableHead>{_("Description")}</TableHead>
                                            <TableHead>{_("Ref.")}</TableHead>
                                            <TableHead className='text-end'>{_("Withdrawal")}</TableHead>
                                            <TableHead className='text-end'>{_("Deposit")}</TableHead>
                                            <TableHead></TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {transactions.map((transaction) => (
                                            <TableRow key={transaction.name}>
                                                <TableCell>{formatDate(transaction.date)}</TableCell>
                                                <TableCell title={transaction.description} className='max-w-[200px] w-fit overflow-hidden text-ellipsis'>{transaction.description}</TableCell>
                                                <TableCell title={transaction.reference_number} className='max-w-[100px] w-fit overflow-hidden text-ellipsis'>{transaction.reference_number ? transaction.reference_number : "-"}</TableCell>
                                                <TableCell className='text-end font-numeric'>{formatCurrency(transaction.withdrawal, transaction.currency)}</TableCell>
                                                <TableCell className='text-end font-numeric'>{formatCurrency(transaction.deposit, transaction.currency)}</TableCell>
                                                <TableCell className='text-end'>
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <Button variant='link' isIconButton asChild className='text-ink-gray-5 hover:text-black p-0 h-4'>
                                                                <a href={`/desk/bank-transaction/${transaction.name}`} target='_blank' rel='noopener noreferrer'>
                                                                    <ExternalLinkIcon />
                                                                </a>
                                                            </Button>
                                                        </TooltipTrigger>
                                                        <TooltipContent>
                                                            {_("Open {0} in a new tab", [transaction.name])}
                                                        </TooltipContent>
                                                    </Tooltip>

                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                            <DialogFooter>
                                <DialogClose asChild>
                                    <Button variant={'outline'} size='md' type='button'>{_("Close")}</Button>
                                </DialogClose>
                            </DialogFooter>
                        </DialogContent>

                    </Dialog>
                </div>
            </AlertDescription>
        </Alert>
    </>
}

export default StatementDetails