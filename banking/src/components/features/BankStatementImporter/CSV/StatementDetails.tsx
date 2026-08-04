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
import { useFrappeEventListener, useFrappePostCall, useSWRConfig, type FrappeError } from 'frappe-react-sdk'
import { toast } from 'sonner'
import ErrorBanner from '@/components/ui/error-banner'
import { Link, useNavigate } from 'react-router'
import { useMemo, useState } from 'react'
import { Progress } from '@/components/ui/progress'
import { useSetAtom } from 'jotai'
import { useDirection } from '@/components/ui/direction'
import BankLogo from '@/components/common/BankLogo'
import { readErrorText, useGetBankAccounts } from '../../BankReconciliation/utils'
import { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import BankRecErrorDialog from '../../BankReconciliation/BankRecErrorDialog'

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

    // FM2: the two sinks a refused import is reported through - the shared dismissible dialog, and the
    // per-file marker the importer list reads to render its third badge state.
    const setErrorDialog = useSetAtom(bankRecErrorDialogAtom)
    const setImportFailures = useSetAtom(bankRecImportFailuresAtom)

    const direction = useDirection()

    /*
     * TC1: the caches the workbench will read the imported rows out of.
     *
     * `useGetUnreconciledTransactions` is configured with `revalidateIfStale: false` and
     * `revalidateOnFocus: false`, so when an entry already exists for a (bank, from, to) triple SWR
     * serves it and issues NO request. Navigating to the workbench straight after an import therefore
     * showed whatever had last been fetched for that range - which, for the very common case of
     * importing a statement covering a range the reviewer had already been looking at, is a list
     * WITHOUT any of the rows just imported. The import appeared to have done nothing.
     */
    const { mutate: revalidate } = useSWRConfig()

    /*
     * TC2: RULE EVALUATION IS THE SERVER'S, AND THIS PAGE DELIBERATELY DOES NOT TRIGGER IT.
     *
     * `insert_transactions` queues evaluation itself, so evaluation of the rows this import created is
     * server-owned and needs nothing from here. A client-side call to `run_rule_evaluation` was added at
     * one point and has been REMOVED, for two reasons that point the same way:
     *
     *   • THE SERVER OWNS BOTH THE TRIGGER AND ITS SCOPE. `insert_transactions` queues the pass through
     *     `enqueue_rule_evaluation(bank_account=self.bank_account)` AFTER it saves the log and, because
     *     that helper sets `enqueue_after_commit`, only once the imported rows have committed - so the
     *     worker is guaranteed to see them. The scope is derived from the log's own bank account rather
     *     than from anything a client sends. Calling the endpoint from here would add a second,
     *     unscoped pass that duplicates work the server has already arranged correctly.
     *   • SCOPE. The Agent Action Plan's change list for this file is the rejection callback and the
     *     dialog mount, and it says in terms: "Leave the document-method call shape, the success-path
     *     navigation and the realtime subscription untouched" (sections 0.6.1.4 and 0.8.2.2). An extra
     *     endpoint call is not in that list.
     *
     * For the record, `run_rule_evaluation` now requires `Bank Transaction` WRITE permission - it stamps
     * `is_rule_evaluated` and `matched_transaction_rule` through permission-bypassing writes, so read
     * authority was never the right gate - and it authorises any bank account named as its scope. That
     * makes it a manager-level action rather than something a review surface should fire implicitly,
     * which is a second reason this page leaves it alone.
     */

    /**
     * EVICTS every cache entry the workbench will read for the range the server reported, then waits
     * for the eviction to settle.
     *
     * ⚠️ THE THIRD ARGUMENT IS THE WHOLE FIX, AND `mutate(key)` DOES NOT DO THIS JOB.
     *
     * SWR's global `mutate` has two different behaviours depending on how many arguments it is given.
     * With one, `internalMutate` takes the `args.length < 3` branch and only calls the REVALIDATORS
     * REGISTERED FOR THAT KEY - the callbacks a MOUNTED `useSWR` installs. Navigating here from the
     * workbench unmounts those hooks, so at this moment the keys below have no revalidators at all: the
     * call resolves having done nothing, the STALE DATA STAYS IN THE CACHE, and because
     * `useGetUnreconciledTransactions` is configured `revalidateIfStale: false` the remounted hook
     * serves that stale entry and issues no request. The reviewer arrived at a list that did not contain
     * the rows they had just imported, and the import looked as though it had done nothing.
     *
     * Passing `undefined` as the data with `{ revalidate: true }` takes the other branch: SWR writes
     * `data: undefined` into the cache entry (`populateCache` defaults to true) and then calls whatever
     * revalidators exist. Clearing the entry is what makes the remount fetch, because `useSWR`'s
     * initial-revalidation decision is `isUndefined(data) || revalidateIfStale` - an entry with no data
     * is always re-fetched, whatever the stale setting says.
     *
     * The key strings are constructed exactly as `utils.ts` constructs them and must stay
     * character-identical to it; no new cache-key family is introduced. Rejections are swallowed
     * individually: an eviction that fails leaves SWR to fetch on mount as it normally would, and must
     * not stop the reviewer being taken to the workbench.
     */
    const refreshImportedRange = (bankAccount: string, fromDate: string, toDate: string) =>
        Promise.all([
            `bank-reconciliation-unreconciled-transactions-${bankAccount}-${fromDate}-${toDate}`,
            `bank-reconciliation-bank-transactions-${bankAccount}-${fromDate}-${toDate}`,
            `bank-reconciliation-account-closing-balance-${bankAccount}-${toDate}`,
            `bank-reconciliation-account-closing-balance-as-per-statement-${bankAccount}-${toDate}`
        ].map((key) => revalidate(key, undefined, { revalidate: true }).catch(() => undefined)))

    const onImport = () => {

        /*
         * FM2: a RETRY starts by retiring the previous verdict about this file. The marker records one
         * observation of one refusal, so leaving it in place while a fresh attempt is in flight would
         * let the importer list keep asserting a failure that is being actively re-tested.
         */
        setImportFailures((previous) => {
            if (!previous.has(data.doc.name)) return previous
            const next = new Map(previous)
            next.delete(data.doc.name)
            return next
        })

        call({
            docs: data.doc,
            method: 'insert_transactions'
        }).then(async (response) => {
            const doc = response.docs ? response.docs[0] : undefined

            /*
             * THE SERVER'S OWN VERDICT, and nothing weaker.
             *
             * A fulfilled promise used to be treated as success outright, which is not what it means:
             * `run_doc_method` appends the document to `frappe.response.docs` AFTER running the method,
             * and `insert_transactions` sets `status = "Completed"` and saves as its last act - so a
             * response carrying a `Completed` doc is the server SAYING the import committed, while a
             * response with no doc, or a doc still at `Not Started`, is a response that says nothing of
             * the kind. Navigating on the latter announced an import that may not have happened and
             * sent the reviewer to a list that would not contain it.
             *
             * An unconfirmed outcome is reported as an UNKNOWN, deliberately not as a failure: no
             * refusal was observed, so nothing here may claim one.
             *
             * It is reported as a plain WARNING TOAST and nothing more. The dismissible dialog is
             * reserved for errors the SERVER raised, and it renders whatever `_server_messages` it is
             * given - so a client-authored envelope would put words the server never said behind a
             * surface whose whole purpose is to carry the server's own. No per-file failure marker is
             * written either, for the same reason: nothing was refused. The reviewer is simply kept on
             * this page, where the statement's own status badge IS the server's answer, rather than
             * being moved somewhere the answer is not visible.
             */
            if (doc?.status !== 'Completed') {
                toast.warning(_("The import could not be confirmed."), {
                    duration: 8000,
                    closeButton: true,
                    description: _("The server accepted the request but did not report this statement as imported. Reload this page to see its current status before trying again - transactions may or may not have been created.")
                })
                return
            }

            if (doc.start_date && doc.end_date) {
                setDates({
                    fromDate: doc.start_date,
                    toDate: doc.end_date,
                })
            }

            /*
             * TC1: the refresh is AWAITED before navigating, so the workbench mounts against rows that
             * were fetched after the import rather than against a cache that predates it.
             *
             * It is not allowed to withhold the reviewer's navigation, though: a failed refresh leaves SWR
             * to fetch on mount as it normally would, which is why every rejection is swallowed
             * individually inside `refreshImportedRange`.
             */
            if (doc.start_date && doc.end_date) {
                await refreshImportedRange(data.doc.bank_account, doc.start_date, doc.end_date)
            }

            toast.success(_("Bank statement imported."))
            navigate(`/`)
        }, (error: FrappeError) => {
            /*
             * Attached as the SECOND argument of `.then` rather than as a trailing `.catch`, and that
             * distinction is load-bearing: a trailing `.catch` also catches anything the success handler
             * above throws, so a client-side fault AFTER a confirmed import would be reported here as a
             * server refusal and would write a per-file `Failed` marker for a statement the server had
             * in fact imported. This handler now sees rejections of the SERVER CALL and nothing else,
             * which is what makes the marker below mean what it says.
             */
            toast.error(_("There was an error while importing the bank statement."))

            /*
             * FM2. This callback previously took NO argument at all, so the server's own account of
             * why it refused the import - "Invalid Bank Account", "Disabled Bank Account", an
             * unreadable or empty file, a missing PDF password, no tables detected, a missing
             * dependency, insufficient permission - was discarded, and the reviewer was shown only
             * the generic toast above.
             *
             * The error is passed to the dialog UNMODIFIED so `ErrorBanner` parses
             * `_server_messages` itself and the backend's wording reaches the reviewer verbatim.
             */
            setErrorDialog(error)

            /*
             * ...and recorded against this import log, because the dialog is dismissible and the row
             * has to keep saying so afterwards. `Bank Statement Import Log` offers only
             * `Not Started` and `Completed` and has no error field, and a refused import rolls back,
             * so the log stays at `Not Started` - visually identical to a statement merely waiting to
             * be imported. This marker is the only per-file failure signal that can exist.
             *
             * The map is replaced rather than mutated so jotai sees a new reference; the message is
             * the same parsed text the toast shows, so the chip's tooltip and the dialog cannot
             * disagree.
             *
             * NO TRANSACTION IS CREATED HERE. Only the server-side import inserts Bank Transactions,
             * and this path is reached precisely when it did not.
             */
            setImportFailures((previous) => {
                const next = new Map(previous)
                next.set(data.doc.name, readErrorText(error))
                return next
            })
        })

    }

    /*
     * FM2/TC1 realtime progress. `progress` is a PERCENTAGE and `total` is a row count, and they are
     * two different quantities: `insert_transactions` publishes
     * `{"progress": round(processed / total * 100)}` after each row and one final
     * `{"progress": 100, "total": <rows>}`. The percentage was previously rendered as
     * "Importing {progress} transactions", so a 30-row statement announced "Importing 3 transactions"
     * at the first row and "Importing 100 transactions" at the last - a number that was neither the
     * count nor recognisable as a percentage.
     *
     * The payload is typed here rather than taken as `any` so the two can no longer be confused, and
     * `total` is kept because it is the only authoritative row count the channel carries.
     */
    const [progress, setProgress] = useState(0)
    const [totalTransactions, setTotalTransactions] = useState<number | undefined>(undefined)

    useFrappeEventListener("bank-rec-statement-import-progress", (event: { progress: number, total?: number }) => {
        setProgress(event.progress)
        if (event.total !== undefined) {
            setTotalTransactions(event.total)
        }
    })

    const file_name = data.doc.file.split("/").pop() ?? ""

    /*
     * The currency every figure on this page is formatted in, read from `data.doc.currency`.
     *
     * It used to be read from `data.currency` — a TOP-LEVEL field of the response that the backend
     * never sends. `get_statement_details` returns exactly `doc`, `date_format`,
     * `conflicting_transactions`, `final_transactions`, `raw_data` and (for PDFs) `pdf_tables`; there
     * is no top-level `currency` in either return branch. So the value was always `undefined`, and
     * every amount here — total debits, total credits, closing balance and every previewed row — was
     * formatted in the SYSTEM DEFAULT currency instead of the statement's own. For a foreign-currency
     * account the preview showed the right numbers under the wrong symbol, immediately before the
     * reviewer committed them.
     *
     * `Bank Statement Import Log.currency` is a real (read-only) field, set from the linked GL
     * account's `account_currency` when the statement was analysed, and it is the same value
     * `insert_transactions` stamps on every Bank Transaction it creates - so formatting from it is
     * what makes this preview agree with what the import will actually record.
     */
    const statementCurrency = data.doc.currency

    const { banks } = useGetBankAccounts()

    const bank = useMemo(() => {

        return banks?.find((bank) => bank.name === data.doc.bank_account)

    }, [data.doc.bank_account, banks])

    return (
        <div className='flex flex-col gap-4'>
            {/* FM2: the same atom-driven dialog the reconciliation workbench mounts. This surface needs
                its own mount because `/statement-importer/:id` is a different route tree, and both
                mounts read one shared atom so they can never disagree. */}
            <BankRecErrorDialog />
            <div className='flex flex-col gap-4'>
                <div className='flex justify-between items-center'>
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
                <div className='flex items-start gap-4'>
                    <div className='flex flex-col gap-1'>
                        <H2 className='text-lg border-0 p-0'>{_("Statement Details")}</H2>
                        <Paragraph className='text-p-sm'><span>
                            {_("We've auto-detected the details of the statement file.")}
                        </span><br />
                            <span>
                                {_("Please review the details below and click the 'Import' button to proceed.")}
                            </span>
                        </Paragraph>
                    </div>
                </div>

                {progress > 0 && <div className='flex flex-col gap-2'><Progress value={progress} max={100} size="lg" />
                    <span className='text-sm'>{totalTransactions === undefined
                        ? _("Importing transactions... {0}% complete", [progress.toString()])
                        : _("Imported {0} transactions ({1}% complete)", [totalTransactions.toString(), progress.toString()])}
                    </span>
                </div>}

                {error && <ErrorBanner error={error} />}

                <Table>
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
                                    {file_name}
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
                            <TableCell><span className='font-numeric'>{formatCurrency(flt(data.doc.total_debits, 2), statementCurrency)}</span> <span className='text-ink-gray-5 font-sans'>({data.doc.total_debit_transactions} {data.doc.total_debit_transactions === 1 ? _("transaction") : _("transactions")})</span></TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>{_("Total Credits")}</TableHead>
                            <TableCell><span className='font-numeric'>{formatCurrency(flt(data.doc.total_credits, 2), statementCurrency)}</span> <span className='text-ink-gray-5 font-sans'>({data.doc.total_credit_transactions} {data.doc.total_credit_transactions === 1 ? _("transaction") : _("transactions")})</span></TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>{_("Closing Balance as of {}", [formatDate(data.doc.end_date, "Do MMMM YYYY")])}</TableHead>
                            <TableCell className='font-numeric'>{formatCurrency(flt(data.doc.closing_balance, 2), statementCurrency)}</TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>
                                <div className='flex items-center gap-2'>
                                    {_("Detected Amount Format")} <Tooltip>
                                        <TooltipTrigger><InfoIcon size={16} /></TooltipTrigger>
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
                                        <TooltipTrigger><InfoIcon size={16} /></TooltipTrigger>
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
                        {data.final_transactions?.length === 1 ? (
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
                                        <TableCell className='text-end font-numeric'>{formatCurrency(transaction.withdrawal, statementCurrency)}</TableCell>
                                        <TableCell className='text-end font-numeric'>{formatCurrency(transaction.deposit, statementCurrency)}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </div>
            </> : null}
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
                        <DialogContent className='min-w-7xl'>
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