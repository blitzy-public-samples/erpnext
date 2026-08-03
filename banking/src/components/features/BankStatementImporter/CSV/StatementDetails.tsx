import _ from '@/lib/translate'
import { GetStatementDetailsResponse } from '../import_utils'
import { flt, formatCurrency } from '@/lib/numbers'
import { formatDate } from '@/lib/date'
import { bankRecDateAtom, bankRecErrorDialogAtom, bankRecImportFailuresAtom, classifyImportAttempt, withImportAttempt, withoutImportAttempt, type ImportAttemptStatus } from '../../BankReconciliation/bankRecAtoms'
import { AlertCircleIcon, ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon, InfoIcon, Loader2Icon } from 'lucide-react'
import { H2, H3, Paragraph } from '@/components/ui/typography'
import { FileTypeIcon } from '@/components/ui/file-dropzone'
import { getFileExtension } from '@/lib/file'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FrappeContext, useFrappeEventListener, useFrappePostCall, type FrappeConfig, type FrappeError } from 'frappe-react-sdk'
import { toast } from 'sonner'
import ErrorBanner from '@/components/ui/error-banner'
import { Link, useNavigate } from 'react-router'
import { useContext, useMemo, useState } from 'react'
import { Progress } from '@/components/ui/progress'
import { useSetAtom } from 'jotai'
import { useDirection } from '@/components/ui/direction'
import BankLogo from '@/components/common/BankLogo'
import { isFrappeErrorEnvelope, toDisplayError, useGetBankAccounts, useRefreshImportedTransactions, useWaitForRuleEvaluation } from '../../BankReconciliation/utils'
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

/**
 * The ONE test for "the server says this import happened".
 *
 * `insert_transactions` sets `status = "Completed"` and saves as its LAST act
 * (`bank_statement_import_log.py:568-569`), and it early-returns a document already in that state,
 * so a completed status is the server's own record of the import having taken effect - and the only
 * evidence of it that exists. Nothing else in a response is a substitute: `run_doc_method` always
 * appends the document it ran the method on (`frappe/handler.py:340`), so a response WITHOUT one
 * cannot have come from a successful import, and a document that came back still saying
 * `Not Started` is the server reporting that the import did not complete.
 *
 * Used as a type guard so a confirmed document can be handed to a continuation that requires one.
 */
const isConfirmedCompletedImport = (doc?: BankStatementImportLog): doc is BankStatementImportLog =>
    doc?.status === 'Completed'

/**
 * What the reviewer is shown when the request SUCCEEDED at the transport level but the response
 * carried no confirmation of the import - no document, an empty `docs`, or a document that still
 * reports a nonterminal status.
 *
 * Built here rather than through `toDisplayError`, which exists for the different case of a
 * rejection with no envelope at all and whose copy opens "No response arrived from the server".
 * That sentence would be false here - a response DID arrive - and a message the reviewer can tell
 * is wrong about what happened is worse than no message. The rest of the reasoning is identical to
 * that layer's, and deliberately so: a response that cannot be relied on proves only that the
 * client did not learn the answer, never that the server failed to apply the request, so the copy
 * names the outcome as unknown and sends the reviewer to the server's own record instead of
 * inviting a blind re-import of work that may already exist.
 *
 * A function rather than a constant, so the wording is resolved through the translation layer at
 * the moment it is needed rather than at module load.
 */
const unconfirmedImportError = (): FrappeError => ({
    httpStatus: 0,
    httpStatusText: 'Unconfirmed',
    message: _('The server did not confirm this import, so it is not known whether the transactions were recorded. Open this import to check its current state before importing the file again.'),
    exception: ''
})

const StatementDetails = ({ data }: Props) => {
    const dateFormat = parseDateFormat(data.date_format)

    const { call, loading, error } = useFrappePostCall<{ docs: BankStatementImportLog[] }>('run_doc_method')

    const navigate = useNavigate()

    const setDates = useSetAtom(bankRecDateAtom)

    const setErrorDialog = useSetAtom(bankRecErrorDialogAtom)

    const setImportFailures = useSetAtom(bankRecImportFailuresAtom)

    // The authoritative read used to confirm what the server actually recorded for this import
    // log after a rejection. `db.getDoc` rather than a cache revalidation because this component
    // is passed no `mutate`, and it is the same imperative-read pattern the rest of the SPA uses.
    const { db } = useContext(FrappeContext) as FrappeConfig

    // F2: awaited cache invalidation for the imported range. F3: bounded wait for rule evaluation.
    const refreshImportedTransactions = useRefreshImportedTransactions()
    const waitForRuleEvaluation = useWaitForRuleEvaluation()

    const direction = useDirection()

    /**
     * The client's own view of where this import has got to, for the window in which neither of the
     * two signals the Import control used to read is telling the truth.
     *
     *   - `data` is the PARENT's `get_statement_details` response. It is not revalidated anywhere in
     *     the success continuation, so `data.doc.status` still reads `Not Started` for the whole
     *     time that continuation runs - including after the server has recorded the import.
     *   - `loading` from the post hook answers a narrower question still ("is the request in
     *     flight?") and flips back to false the instant the response lands, which is BEFORE the
     *     continuation - the bounded rule-evaluation wait and the cache invalidation - has finished.
     *
     * Between those two, the Import control re-rendered ENABLED, reading "Import N transactions",
     * for work the server had already committed, and invited a re-click on it. (Re-clicking was
     * never able to double-post: the server refuses a completed log and rejects a stale resubmit.
     * The defect is that the affordance said the opposite of what was true.)
     *
     *   - `attempting` - a request is in flight, or its confirmed-completed continuation is still
     *     running. The control stays closed for all of it.
     *   - `completed`  - the server has CONFIRMED the import. The control is REPLACED by the same
     *     green badge the server-derived status renders, which is the strongest form of closed:
     *     there is nothing left to click.
     *
     * It returns to `idle` only when an attempt ends without the import having taken effect, which
     * is exactly when a retry is legitimate. Local state, deliberately: this describes one
     * component's attempt, not application state, and it must not survive a remount that re-reads
     * the document.
     */
    const [attemptState, setAttemptState] = useState<'idle' | 'attempting' | 'completed'>('idle')

    /** True whenever an attempt is being carried out, whether or not its request is still in flight. */
    const isImporting = loading || attemptState === 'attempting'

    /**
     * True once EITHER the fetched document or this attempt says the import is done. The server's
     * own status is still consulted first, so a log that was already completed before this screen
     * was opened renders exactly as it did before.
     */
    const isImported = data.doc.status === 'Completed' || attemptState === 'completed'

    /** Retires this log's attempt marker. A marker must never outlive the condition it described. */
    const clearImportAttempt = () => {
        setImportFailures((previousAttempts) => withoutImportAttempt(previousAttempts, data.doc.bank_account, data.doc.name))
    }

    /**
     * Applies the outcome of an import the server has CONFIRMED as completed. Extracted so the
     * rejection path can run the identical continuation when its authoritative re-read shows the
     * import did complete after all - the two paths must not be allowed to drift apart.
     *
     * The parameter is REQUIRED, and every call site has to satisfy {@link isConfirmedCompletedImport}
     * first. That is what makes "confirmed" structural rather than a promise: the first thing this
     * function does is record success locally and its last is to navigate away, so it must never be
     * reachable with a document that does not say the import happened. It used to accept an optional
     * document and was called with `response.docs ? response.docs[0] : undefined`, so a 200 that
     * carried no document at all - a truncated or rewritten response - was presented to the reviewer
     * as a completed import, complete with success toast and hand-off.
     *
     * The order here is deliberate and each step depends on the one before it:
     *
     *  1. Resolve the date range from the SERVER's copy of the document. The import derives the
     *     statement's start and end dates while parsing and returns them on the saved doc, so this
     *     is the range the newly created transactions actually fall in - not the range the
     *     reconciliation page happens to be filtered to.
     *  2. Point the reconciliation page's filter at that range.
     *  3. Give rule evaluation a bounded chance to stamp the new transactions, so the suggested
     *     matches the reviewer is about to look for are present rather than arriving later.
     *  4. AWAIT invalidation of that range's cache entries. The unreconciled query does not
     *     revalidate on mount or when stale, so without this the page renders whatever it already
     *     had cached for the range and the imported transactions are simply missing, silently.
     *  5. Only then navigate.
     *
     * Steps 3 and 4 are bounded and never reject, so a slow or unavailable worker delays this
     * hand-off but cannot strand the user on the import screen.
     */
    const onImportCompleted = async (doc: BankStatementImportLog) => {

        // Recorded FIRST, before any awaiting: from here on the server has confirmed the import, so
        // the Import control must be gone for the whole of the continuation below rather than
        // reappearing the moment the request settles.
        setAttemptState('completed')

        const fromDate = doc.start_date
        const toDate = doc.end_date

        if (fromDate && toDate) {
            setDates({
                fromDate: fromDate,
                toDate: toDate,
            })
        }

        clearImportAttempt()

        if (fromDate && toDate) {
            await waitForRuleEvaluation(data.doc.bank_account, fromDate, toDate)
            await refreshImportedTransactions(data.doc.bank_account, fromDate, toDate)
        }

        toast.success(_("Bank statement imported."))
        navigate(`/`)
    }

    /**
     * Settles an attempt whose RESPONSE did not establish that the import completed - whether
     * because the server refused it, or because what came back carried no confirmation.
     *
     * Neither of those is by itself evidence that the import did not happen: the request may have
     * been received and committed with only the acknowledgement lost or rewritten. The server is
     * therefore asked what the log actually says before anything is recorded or shown, and its
     * answer decides:
     *
     *  - status `Completed`  -> server truth wins outright. No error is surfaced, no marker is
     *    written, any earlier marker is retired, and the success continuation runs.
     *  - the SERVER refused, and the log is confirmed not completed -> `failed`.
     *  - anything else       -> `unknown`. In particular a lost response leaving the log at its
     *    initial `Not Started` is NOT a failure: that status is nonterminal for the whole duration
     *    of the import, so it cannot distinguish a rollback from a commit whose response went
     *    missing. Claiming failure there would invite a re-import of work that may already exist.
     *
     * The classification itself lives in `classifyImportAttempt`, which takes an OBSERVATION rather
     * than a verdict, so this function cannot express "mark it failed" - only "here is what I saw".
     *
     * Both entry points share this one function ON PURPOSE. An unconfirmed success used to be
     * indistinguishable from a confirmed one, so it took the SUCCESS continuation; giving it its own
     * private handler instead would have re-created the same class of divergence one layer down.
     *
     * `serverRejected` is the caller's OBSERVATION, never a re-derivation: only the rejection path
     * has an envelope to judge, and a 200 that simply carried no document is not a refusal, so it
     * must never be classified as one.
     *
     * Nothing here creates a transaction: only the server-side import does that.
     */
    const settleUnconfirmedImport = async (
        { serverRejected, displayError, transientMessage }: {
            serverRejected: boolean,
            displayError: FrappeError,
            transientMessage: string
        }
    ): Promise<void> => {
        let confirmedLog: BankStatementImportLog | undefined
        try {
            confirmedLog = await db.getDoc<BankStatementImportLog>('Bank Statement Import Log', data.doc.name)
        } catch (confirmationError) {
            // The confirmation itself failed, so the outcome stays unknown rather than being guessed.
            console.error(confirmationError)
        }

        const outcome = classifyImportAttempt({
            serverRejected,
            confirmedStatus: confirmedLog?.status
        })

        if (outcome === 'completed' && isConfirmedCompletedImport(confirmedLog)) {
            // The freshly fetched log is passed rather than the local copy: it is the document the
            // import wrote, so it is the one carrying the resolved statement date range.
            //
            // The two conditions are ONE condition twice: `classifyImportAttempt` answers
            // `completed` for exactly the status `isConfirmedCompletedImport` accepts. It is written
            // as a guard rather than a cast so that if the two rules ever disagree, control falls
            // through to the not-completed handling below - fail closed - instead of handing an
            // unconfirmed document to a continuation that reports success.
            await onImportCompleted(confirmedLog)
            return
        }

        /*
         * `completed` could only survive the guard above if the classification and the confirmation
         * predicate disagreed, which they cannot by construction. If they ever did, the attempt is
         * recorded as `unknown` - the honest reading of "the client could not establish what
         * happened" - rather than as a completion nothing here was able to verify.
         */
        const marker: ImportAttemptStatus = outcome === 'completed' ? 'unknown' : outcome

        // The attempt ended without the import having taken effect, so re-offering it is correct -
        // this is the one path on which the control may legitimately reopen. The server refuses a
        // log it has already completed, so a retry cannot double-import.
        setAttemptState('idle')

        // Normalised through the SAME layer the reconciliation seam uses, so a genuine envelope is
        // passed through BY IDENTITY - the backend's own message, title and severity reach the user
        // verbatim - while a rejection with no envelope becomes outcome-indeterminate transport copy
        // instead of the SDK's internal TypeError text. Untrusted markup inside a server message is
        // neutralised at the rendering boundary, not by rewriting the envelope here.
        toast.error(transientMessage)
        setErrorDialog(displayError)
        setImportFailures((previousAttempts) => withImportAttempt(previousAttempts, data.doc.bank_account, data.doc.name, marker))
    }

    const onImport = () => {

        // Raised BEFORE the request is dispatched, so there is no render - however brief - in which
        // an attempt is under way and nothing is holding the control closed.
        setAttemptState('attempting')

        // A retry supersedes whatever the previous attempt observed, so the stale marker is
        // discarded BEFORE the request goes out rather than after it resolves - otherwise the
        // importer list would keep flagging the file for the whole duration of a retry that may
        // well succeed.
        clearImportAttempt()

        call({
            docs: data.doc,
            method: 'insert_transactions'
        }).then((response) => {
            const returnedLog = response?.docs?.[0]

            if (isConfirmedCompletedImport(returnedLog)) {
                return onImportCompleted(returnedLog)
            }

            /*
             * A 200 IS NOT A CONFIRMATION. `run_doc_method` returns the document it ran the method
             * on, and the import's last act is to set the status to `Completed` and save - so a
             * response with no document, an empty `docs`, or a document still reporting
             * `Not Started` did not come from an import that took effect. It used to be treated as
             * success anyway: the control was retired, a success toast was raised, the
             * reconciliation range was moved and the reviewer was handed off to a workbench that
             * had nothing new in it.
             *
             * It is not treated as a failure either, because that is equally unknowable from here.
             * It is settled the same way a rejection is: ask the server what the log says and let
             * THAT decide. `serverRejected` is false - nothing was refused - so a log that is not
             * confirmed completed is recorded as `unknown`, which is the honest reading of "the
             * response could not be relied on".
             */
            return settleUnconfirmedImport({
                serverRejected: false,
                displayError: unconfirmedImportError(),
                transientMessage: _("The import could not be confirmed.")
                // Terminated HERE rather than in the catch below, which would otherwise re-run the
                // whole settlement and judge this handler's own failure as though the SERVER had
                // refused the import.
            }).catch((handlerError) => console.error(handlerError))
        }).catch((importError: unknown) => {
            // Handled asynchronously because the server must be consulted before any outcome is
            // recorded; the terminal catch keeps that handler from ever escaping as an unhandled
            // rejection.
            return settleUnconfirmedImport({
                // A genuine Frappe envelope is the evidence that the server answered at all. Without
                // one there is no response to reason about - `frappe-js-sdk` dereferences
                // `error.response.data` unguarded, so a lost response surfaces as its own TypeError.
                serverRejected: isFrappeErrorEnvelope(importError),
                displayError: toDisplayError(importError),
                transientMessage: _("There was an error while importing the bank statement.")
            }).catch((handlerError) => console.error(handlerError))
        })

    }

    const [progress, setProgress] = useState(0)

    useFrappeEventListener("bank-rec-statement-import-progress", (event) => {
        setProgress(event.progress)
    })

    const file_name = data.doc.file.split("/").pop() ?? ""

    const { banks } = useGetBankAccounts()

    const bank = useMemo(() => {

        return banks?.find((bank) => bank.name === data.doc.bank_account)

    }, [data.doc.bank_account, banks])

    return (
        <div className='flex flex-col gap-4'>
            <BankRecErrorDialog />
            <div className='flex flex-col gap-4'>
                <div className='flex justify-between items-center'>
                    <Button size='sm' variant='outline' asChild>
                        <Link to="/statement-importer">
                            {direction === 'ltr' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
                            {_("Back")}
                        </Link>
                    </Button>
                    {/*
                      * The control is driven by `isImported` / `isImporting` rather than by
                      * `data.doc.status` and `loading` directly, so that the window between the
                      * server confirming the import and this screen being replaced cannot present an
                      * enabled "Import" action for work that is already recorded. See `attemptState`.
                      */}
                    {isImported ? <Badge theme='green'>{_("Completed")}</Badge> :
                        <Button onClick={onImport} disabled={isImporting || data.final_transactions?.length === 0} size='sm' type='button'>
                            {isImporting ? <Loader2Icon className='size-4 animate-spin' /> : null}
                            {isImporting ? _("Importing...") : _("Import {0} transactions", [data.final_transactions?.length?.toString() || "0"])}</Button>
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
                    <span className='text-sm'>{_("Importing {0} transactions", [progress.toString()])}
                    </span>
                </div>}

                {/*
                  * The import call's own hook error. Normalised through the shared layer for the
                  * same reason the dialog is: when the response is lost there is no envelope to
                  * render, and the SDK's unguarded read of `error.response.data` surfaces as a raw
                  * `TypeError` that tells the user nothing about what was or was not recorded.
                  * A genuine envelope is passed through by identity and keeps the server's wording.
                  */}
                {error && <ErrorBanner error={toDisplayError(error)} />}

                {/*
                  * FM2, zero-row case. A file the server parsed without raising - an empty
                  * statement, or one whose rows the detected mapping matched none of - yields no
                  * transactions to import, and the Import control above is disabled as a result.
                  * Disabling it alone left the reason entirely unstated, which reads as the page
                  * being broken rather than the file being unusable. The condition is derived from
                  * the SERVER's parse result, so nothing here is a client-side judgement about the
                  * file, and no marker is involved: the log exists and its status is accurate.
                  */}
                {data.doc.status !== 'Completed' && data.final_transactions?.length === 0 && (
                    <Alert theme="red">
                        <AlertCircleIcon />
                        <AlertTitle>{_("No transactions found in this statement")}</AlertTitle>
                        <AlertDescription>
                            {_("This file could not be read as a bank statement, so there is nothing to import. It may be empty, or its columns may not have been recognised. Check the file against the expected columns and upload it again.")}
                        </AlertDescription>
                    </Alert>
                )}

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
                            <TableCell><span className='font-numeric'>{formatCurrency(flt(data.doc.total_debits, 2), data.currency)}</span> <span className='text-ink-gray-5 font-sans'>({data.doc.total_debit_transactions} {data.doc.total_debit_transactions === 1 ? _("transaction") : _("transactions")})</span></TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>{_("Total Credits")}</TableHead>
                            <TableCell><span className='font-numeric'>{formatCurrency(flt(data.doc.total_credits, 2), data.currency)}</span> <span className='text-ink-gray-5 font-sans'>({data.doc.total_credit_transactions} {data.doc.total_credit_transactions === 1 ? _("transaction") : _("transactions")})</span></TableCell>
                        </TableRow>
                        <TableRow>
                            <TableHead>{_("Closing Balance as of {}", [formatDate(data.doc.end_date, "Do MMMM YYYY")])}</TableHead>
                            <TableCell className='font-numeric'>{formatCurrency(flt(data.doc.closing_balance, 2), data.currency)}</TableCell>
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
                                        <TableCell className='text-end font-numeric'>{formatCurrency(transaction.withdrawal, data.currency)}</TableCell>
                                        <TableCell className='text-end font-numeric'>{formatCurrency(transaction.deposit, data.currency)}</TableCell>
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