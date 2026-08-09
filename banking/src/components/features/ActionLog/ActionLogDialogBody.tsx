import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import _ from '@/lib/translate'
import { useAtomValue, useSetAtom } from 'jotai'
import { ArrowDownRight, ArrowRightLeftIcon, ArrowUpRight, CalendarIcon, CircleXIcon, GitCompareIcon, HistoryIcon, LandmarkIcon, Loader2Icon, ReceiptIcon, ReceiptTextIcon, UserIcon, WalletIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ActionLogItem, ActionLog as ActionLogType, bankRecActionLog, bankRecDateAtom, bankRecMatchFilters, SelectedBank, selectedBankAccountAtom } from '../BankReconciliation/bankRecAtoms'
import { useGetBankAccounts } from '../BankReconciliation/utils'
import { getCompanyCurrency } from '@/lib/company'
import { formatCurrency } from '@/lib/numbers'
import dayjs from 'dayjs'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/date'
import { Separator } from '@/components/ui/separator'
import { slug } from '@/lib/frappe'
import { PaymentEntry } from '@/types/Accounts/PaymentEntry'
import { JournalEntry } from '@/types/Accounts/JournalEntry'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Table, TableCell, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { useFrappePostCall, useSWRConfig } from 'frappe-react-sdk'
import { toast } from 'sonner'
import { getErrorMessage } from '@/lib/frappe'
import ErrorBanner from '@/components/ui/error-banner'
import SelectedTransactionDetails from '../BankReconciliation/SelectedTransactionDetails'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import BankLogo from '@/components/common/BankLogo'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import ErrorBoundary from '@/components/common/ErrorBoundary'

const ActionLogDialogBody = () => {

    const actionLog = useAtomValue(bankRecActionLog)

    return <div className='flex flex-col gap-2'>
        {actionLog.map((action) => (
            <div key={action.timestamp} className='flex flex-col gap-1'>
                <ActionGroupHeader action={action} />
                <div>
                    <div className='ms-2 border-s border-s-outline-gray-2 py-1'>
                        <div className='ms-5'>
                            {action.items.map((item, index) => (
                                /*
                                 * Every row is contained individually rather than the log as a whole. The log
                                 * is deserialised out of session storage, so it can hold an entry written by a
                                 * different build whose shape this renderer no longer recognises - and an
                                 * uncontained throw there took the entire SPA down to a blank page, losing the
                                 * reviewer's other entries along with it. Contained per row, one unreadable
                                 * entry costs only itself.
                                 */
                                <ErrorBoundary
                                    key={item.bankTransaction.name}
                                    label={`Action log row ${item.bankTransaction.name}`}
                                    resetKey={item}
                                    fallback={<UnrenderableRow
                                        item={item}
                                        index={index}
                                        isLast={index === action.items.length - 1} />}>
                                    <Row
                                        item={item}
                                        index={index}
                                        action={action}
                                        isLast={index === action.items.length - 1} />
                                </ErrorBoundary>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        ))}

        {actionLog.length === 0 && <Empty>
            <EmptyMedia>
                <HistoryIcon />
            </EmptyMedia>
            <EmptyHeader>
                <EmptyTitle>{_("No reconciliation actions found")}</EmptyTitle>
                <EmptyDescription>{_("You have not performed any reconciliations in this session yet.")}</EmptyDescription>
            </EmptyHeader>
        </Empty>}
    </div>
}



/**
 * Stands in for a row whose own render threw, keeping the group's frame intact so the reviewer can see
 * that something was logged here rather than silently losing a line of their audit trail.
 *
 * Every field is read defensively: this renders BECAUSE the row's data was not what the renderer expected,
 * so assuming any particular field is present would throw again - and a fallback that throws escapes to
 * the boundary above and takes the whole log with it after all.
 */
const UnrenderableRow = ({ item, index, isLast }: { item: ActionLogItem, index: number, isLast: boolean }) => {

    const reference = [item?.voucher?.reference_doctype, item?.voucher?.reference_name].filter(Boolean).join(' ')

    return <div className='flex items-center gap-2'>
        <div className={cn('p-3.5 border-s border-e border-t w-full', isLast ? 'rounded-b border-b' : '', index === 0 ? 'rounded-t' : '')}>
            <Alert theme='red' role='alert'>
                <AlertTitle>{_("This entry could not be displayed")}</AlertTitle>
                <AlertDescription>
                    {reference
                        ? _("Some of its details are missing from this session's log. Nothing that was posted has changed - open {} to review it.", [reference])
                        : _("Some of its details are missing from this session's log. Nothing that was posted has changed.")}
                </AlertDescription>
            </Alert>
        </div>
        {/* Holds the column the undo control occupies on a readable row, so the group stays aligned. */}
        <div className='w-10 h-10' />
    </div>
}

const ActionGroupHeader = ({ action }: { action: ActionLogType }) => {

    const label = useMemo(() => {
        switch (action.type) {
            case 'match':
                return _("Matched")
            case 'payment':
                if (action.isBulk) {
                    return _("Bulk Payment")
                }
                return _("Payment")

            case 'transfer':
                if (action.isBulk) {
                    return _("Bulk Transfer")
                }
                return _("Transfer")

            case 'bank_entry':
                if (action.isBulk) {
                    return _("Bulk Bank Entry")
                }
                return _("Bank Entry")

            default:
                return _("Action")
        }
    }, [action])

    return <div className='flex items-center gap-2 text-ink-gray-5'>
        {action.type === 'match' && <GitCompareIcon className='w-4 h-4' />}
        {action.type === 'payment' && <ReceiptIcon className='w-4 h-4' />}
        {action.type === 'transfer' && <ArrowRightLeftIcon className='w-4 h-4' />}
        {action.type === 'bank_entry' && <LandmarkIcon className='w-4 h-4' />}
        <span className='flex items-center gap-2 text-sm'>
            {label} - {dayjs(action.timestamp).fromNow()}
        </span>
    </div>
}

const Row = ({ item, index, isLast, action }: { item: ActionLogItem, index: number, isLast: boolean, action: ActionLogType }) => {

    const isWithdrawal = item.bankTransaction.withdrawal && item.bankTransaction.withdrawal > 0

    const { banks } = useGetBankAccounts()

    const bank = useMemo(() => {
        if (item.bankTransaction.bank_account) {
            return banks?.find((bank) => bank.name === item.bankTransaction.bank_account)
        }
        return null
    }, [item.bankTransaction.bank_account, banks])

    const amount = item.bankTransaction.withdrawal ? item.bankTransaction.withdrawal : item.bankTransaction.deposit

    const currency = item.bankTransaction.currency || getCompanyCurrency(item.bankTransaction.company ?? '')

    return <div className='flex items-center gap-2 group'>
        <div className={cn('p-3.5 group-hover:bg-surface-gray-1 border-s border-e border-t w-full', isLast ? 'rounded-b border-b' : '', index === 0 ? 'rounded-t' : '')}>
            <div className='flex justify-between items-center'>
                <div className='flex flex-col gap-2'>
                    <p className='text-p-base'>{item.bankTransaction.description}</p>
                    <div className='flex items-center gap-3'>
                        <div className='flex gap-2 items-center'>
                            <BankLogo bank={bank} className='h-4 mb-0' iconSize='16px' />
                            <span className='text-sm text-ink-gray-5'>{item.bankTransaction.bank_account}</span>
                        </div>
                        <Separator orientation='vertical' />
                        <div className='flex items-center gap-2 text-ink-gray-5 text-sm' title={_("Transaction Date")}>
                            <CalendarIcon className='w-4 h-4' />
                            <span className='text-sm'>{formatDate(item.bankTransaction.date, 'Do MMM YYYY')}</span>
                        </div>
                        <Separator orientation='vertical' />
                        <div>
                            <div className='flex items-center gap-1' title={isWithdrawal ? _("Spent") : _("Received")}>
                                {isWithdrawal ? <ArrowUpRight className="w-5 h-5 text-ink-red-3" /> : <ArrowDownRight className="w-5 h-5 text-ink-green-3" />}
                                <span className='text-sm text-ink-gray-5'>{formatCurrency(amount, currency)}</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div className='flex justify-end items-center gap-2'>
                    <div className='text-end flex flex-col gap-2'>
                        <a
                            href={`/desk/${slug(item.voucher.reference_doctype)}/${item.voucher.reference_name}`}
                            target='_blank'
                            className='underline underline-offset-4 text-base'>
                            {["Payment Entry", "Journal Entry"].includes(item.voucher.reference_doctype) ? "" : _("{} :", [item.voucher.reference_doctype])} {item.voucher.reference_name}
                        </a>
                        {item.voucher.reference_doctype === "Payment Entry" && item.voucher.doc && <PaymentEntryDetails item={item} />}
                        {/* `doc` is optional on a log item, and the Journal Entry branch used to omit the guard
                            its Payment Entry sibling has - so an entry logged without the voucher document
                            reached a renderer that reads the accounts child table off it and threw. */}
                        {item.voucher.reference_doctype === "Journal Entry" && item.voucher.doc && <JournalEntryDetails item={item} bank={bank} />}
                    </div>
                </div>
            </div>
        </div>
        <div className='w-10 h-10 flex items-center justify-center'>
            <CancelActionLogItem item={item} type={action.type} timestamp={action.timestamp} bank={bank} />
        </div>
    </div>
}

const JournalEntryDetails = ({ item, bank }: { item: ActionLogItem, bank?: SelectedBank | null }) => {

    return <div className='flex items-center gap-2 text-ink-gray-5 justify-end'>
        <WalletIcon className='w-4 h-4' />
        <JournalEntryAccountsTable item={item} bank={bank} />
    </div>
}

const JournalEntryAccountsTable = ({ item, bank }: { item: ActionLogItem, bank?: SelectedBank | null }) => {

    const accounts = useMemo(() => {

        // Read through the optional chain rather than through a bare cast. The cast asserts a document
        // that a log entry is not obliged to carry, and dereferencing the accounts table on an absent
        // one is the throw that used to blank the whole session log.
        const allAccounts = (item.voucher?.doc as JournalEntry | undefined)?.accounts ?? []

        return allAccounts.filter((acc) => bank ? acc.account !== bank.account : true)

    }, [item, bank])

    // Not an error state, and not worth a placeholder: the filter above removes the bank's own account on
    // purpose, so a two-line entry against this very bank legitimately leaves nothing to name. Saying
    // "split across 0 accounts" - which is what the branch below would have said - would be worse.
    if (accounts.length === 0) {
        return null
    }

    return <>
        {accounts.length === 1 ? <span className='text-sm'>{accounts[0].account}</span> :
            <HoverCard>
                <HoverCardTrigger>
                    <span className='text-sm cursor-pointer hover:underline underline-offset-4'>{_("Split across {} accounts", [accounts.length.toString()])}</span>
                </HoverCardTrigger>
                <HoverCardContent className='w-full p-2' align='end'>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{_("Account")}</TableHead>
                                <TableHead className='text-end'>{_("Debit")}</TableHead>
                                <TableHead className='text-end'>{_("Credit")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {accounts.map((account) => (
                                <TableRow key={account.account}>
                                    <TableCell>{account.account}</TableCell>
                                    <TableCell className='text-end font-numeric'>{formatCurrency(account.debit ?? 0, account.account_currency ?? '')}</TableCell>
                                    <TableCell className='text-end font-numeric'>{formatCurrency(account.credit ?? 0, account.account_currency ?? '')}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </HoverCardContent>
            </HoverCard>
        }</>
}

const PaymentEntryDetails = ({ item, className }: { item: ActionLogItem, className?: string }) => {

    const doc = item.voucher?.doc as PaymentEntry | undefined

    // Each of this component's three call sites guards on the document already. It guards again here
    // because it is reachable from all three and a fourth would be easy to add: a log entry without its
    // voucher document must cost the reviewer this one detail, never the log.
    if (!doc) {
        return null
    }

    if (doc.payment_type === "Internal Transfer") {
        return <TransferDetails item={item} className={className} />
    }

    const invoices = doc.references ?? []

    const currency = item.bankTransaction.withdrawal && item.bankTransaction.withdrawal > 0 ? doc.paid_to_account_currency : doc.paid_from_account_currency

    return <div className='flex items-center gap-3'>
        <div className={cn('flex items-center gap-2 text-ink-gray-5 text-sm', className)}>
            <UserIcon className='w-4 h-4' />
            <span className='text-sm'>{doc.party_name}</span>
        </div>
        <Separator orientation='vertical' />
        <HoverCard>
            <HoverCardTrigger>
                <div className={cn('flex items-center gap-2 text-ink-gray-5 text-sm', className)}>
                    <ReceiptTextIcon className='w-4 h-4' />
                    <span className='text-sm cursor-pointer hover:underline underline-offset-4'>{invoices.length === 0 ? _("No invoice linked") : invoices.length === 1 ? _("1 invoice") : _("{} invoices", [invoices.length.toString()])}</span>
                </div>
            </HoverCardTrigger>
            <HoverCardContent className='w-full p-2' align='end'>
                <div className='flex flex-col gap-2'>
                    {invoices.map((invoice) => (
                        // Keyed on the child row's own name, falling back to the referenced document: an
                        // unkeyed list lets React reuse one invoice's cells for another when the set changes.
                        <Table key={invoice.name ?? `${invoice.reference_doctype}-${invoice.reference_name}`}>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{_("Document")}</TableHead>
                                    <TableHead>{_("Invoice No")}</TableHead>
                                    <TableHead>{_("Due Date")}</TableHead>
                                    <TableHead className='text-end'>{_("Grand Total")}</TableHead>
                                    <TableHead className='text-end'>{_("Allocated")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                <TableRow>
                                    <TableCell><a href={`/desk/${slug(invoice.reference_doctype)}/${invoice.reference_name}`} target='_blank' className='underline underline-offset-4'>{invoice.reference_doctype}: {invoice.reference_name}</a></TableCell>
                                    <TableCell>{invoice.bill_no ?? "-"}</TableCell>
                                    <TableCell>{formatDate(invoice.due_date)}</TableCell>
                                    <TableCell className='text-end font-numeric'>{formatCurrency(invoice.total_amount, currency ?? '')}</TableCell>
                                    <TableCell className='text-end font-numeric'>{formatCurrency(invoice.allocated_amount, currency ?? '')}</TableCell>
                                </TableRow>
                            </TableBody>
                        </Table>
                    ))}
                </div>
            </HoverCardContent>
        </HoverCard>

    </div>
}

const TransferDetails = ({ item, className }: { item: ActionLogItem, className?: string }) => {

    const { banks } = useGetBankAccounts()

    const bank = useMemo(() => {

        // Same reasoning as the Payment Entry renderer: the voucher document is optional on a log entry,
        // so read it through the chain and resolve to no bank rather than throwing.
        const doc = item.voucher?.doc as PaymentEntry | undefined

        if (!doc) {
            return undefined
        }

        const isWithdrawal = item.bankTransaction.withdrawal && item.bankTransaction.withdrawal > 0

        const transferAccount = isWithdrawal ? doc.paid_to : doc.paid_from

        const transferBankAccount = banks?.find((bank) => bank.account === transferAccount)

        return transferBankAccount

    }, [banks, item])

    return <div className={cn('flex items-center gap-2 text-ink-gray-5 text-sm', className)}>
        <BankLogo bank={bank} className='h-5 mb-0' iconSize='16px' imageClassName='max-h-5' />
        <span className='text-sm'>{bank?.account}</span>
    </div>
}

const ACTION_TYPE_MAP = {
    'bank_entry': _("Bank Entry"),
    'payment': _("Payment"),
    'transfer': _("Transfer"),
    'match': _("Match"),
}

const CancelActionLogItem = ({ item, type, timestamp, bank }: { item: ActionLogItem, type: ActionLogType['type'], timestamp: number, bank?: SelectedBank | null }) => {

    const [isOpen, setIsOpen] = useState(false)

    const { call, loading, error } = useFrappePostCall('erpnext.accounts.doctype.bank_transaction.bank_transaction.unreconcile_transaction_entry')
    const { mutate } = useSWRConfig()
    const actionLog = useSetAtom(bankRecActionLog)
    const dates = useAtomValue(bankRecDateAtom)
    const matchFilters = useAtomValue(bankRecMatchFilters)
    const selectedBank = useAtomValue(selectedBankAccountAtom)

    const onUndo = () => {
        call({
            bank_transaction_id: item.bankTransaction.name,
            voucher_type: item.voucher.reference_doctype,
            voucher_id: item.voucher.reference_name,
        }).then(() => {
            toast.success(type === 'match' ? _("Unmatched") : _("Cancelled"))

            if (selectedBank?.name === item.bankTransaction.bank_account) {
                mutate(`bank-reconciliation-unreconciled-transactions-${selectedBank?.name}-${dates.fromDate}-${dates.toDate}`)
                mutate(`bank-reconciliation-account-closing-balance-${selectedBank?.name}-${dates.toDate}`)
                // Update the matching vouchers for the selected transaction
                mutate(`bank-reconciliation-vouchers-${item.bankTransaction.name}-${dates.fromDate}-${dates.toDate}-${matchFilters.join(',')}`)
            }

            setTimeout(() => {
                actionLog((prev) => {
                    // Find the action and then remove the item from it. If that empties the action, drop
                    // the action itself.
                    const action = prev.find((action) => action.timestamp === timestamp)

                    if (!action) {
                        return prev
                    }

                    /*
                     * Derived, never assigned back onto `action`.
                     *
                     * This read `action.items = action.items.filter(...)`, which mutates the state object
                     * this updater was handed. Jotai keeps that object - and the log is persisted, so a
                     * deserialised copy of it is handed to whoever mounts the atom next - and an entry
                     * whose `items` had been emptied in place then rendered as an action heading with no
                     * rows under it and, with them, no undo control. Building a new array and a new action
                     * object leaves the previous state exactly as it was found.
                     */
                    const remainingItems = action.items.filter((i) => i.bankTransaction.name !== item.bankTransaction.name)

                    if (remainingItems.length === 0) {
                        return prev.filter((a) => a.timestamp !== timestamp)
                    }

                    return prev.map((a) => a.timestamp === timestamp ? { ...a, items: remainingItems } : a)
                })
            }, 100)

            setIsOpen(false)

        }).catch((error) => {
            toast.error(_("There was an error while performing the action."), {
                duration: 5000,
                description: getErrorMessage(error),
            })
        })
    }

    /*
     * Names the control after what it does to THIS entry, and matches the confirmation it opens: the
     * control read "Cancel" for every row, which in an accounting product means cancelling the voucher
     * and, on a matched row, is not even what happens - the match is undone and the voucher left alone.
     */
    const undoLabel = type === 'match'
        ? _("Unmatch transaction")
        : _("Undo {}", [item.voucher.reference_doctype])

    return <AlertDialog open={isOpen} onOpenChange={setIsOpen}>
        <Tooltip>
            <TooltipTrigger asChild>
                <AlertDialogTrigger asChild>
                    <Button
                        variant={'ghost'}
                        isIconButton
                        theme='red'
                        title={undoLabel}
                        aria-label={undoLabel}
                        /*
                         * Permanently visible, and deliberately not revealed on hover.
                         *
                         * This started as `hidden` - `display: none` - which took the only way to undo an
                         * action away from everyone not using a mouse. Fading it in on hover instead kept
                         * it in the document and in the tab order, but that only moved the problem: hover
                         * cannot be produced by touch at all, so on a tablet the control was a 28x28
                         * invisible target that had to be found before it could be revealed, and a reveal
                         * that requires focus is no help when nothing tells you there is something to focus.
                         *
                         * Undoing a reconciliation is the whole purpose of this log, so the control is shown
                         * at rest in a muted grey and escalates to red on hover and focus. That keeps the row
                         * calm while leaving the action discoverable by every input device, which is what
                         * being reachable actually requires.
                         */
                        className='text-ink-gray-5 transition-colors hover:text-ink-red-3 hover:bg-destructive/5 focus-visible:text-ink-red-3'>
                        <CircleXIcon className='w-8 h-8' />
                    </Button>
                </AlertDialogTrigger>
            </TooltipTrigger>
            <TooltipContent>
                {undoLabel}
            </TooltipContent>
        </Tooltip>
        <AlertDialogContent size='3xl'>
            <AlertDialogHeader>
                <AlertDialogTitle>{type === 'match' ? _("Unmatch Transaction?") : _("Undo {}?", [item.voucher.reference_doctype])}</AlertDialogTitle>
                <AlertDialogDescription>{type === 'match' ? _("Are you sure you want to unmatch the voucher from this transaction?") : _("Are you sure you want to cancel this {} {}?", [_(item.voucher.reference_doctype), item.voucher.reference_name])}</AlertDialogDescription>
            </AlertDialogHeader>
            {error && <ErrorBanner error={error} />}
            <div className='flex flex-col gap-2'>
                <SelectedTransactionDetails transaction={item.bankTransaction} />
                {/* Wrapped in a body element rather than hanging rows straight off the table: a browser
                    inserts one anyway, which left React reconciling against a DOM it had not built and
                    logging a nesting error on every open. */}
                <Table>
                    <TableBody>
                    <TableRow>
                        <TableHead>{_("Action Type")}</TableHead>
                        <TableCell>{ACTION_TYPE_MAP[type]}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableHead>{_("Voucher Type")}</TableHead>
                        <TableCell>{_(item.voucher.reference_doctype)}</TableCell>
                    </TableRow>
                    <TableRow>
                        <TableHead>{_("Voucher Name")}</TableHead>
                        <TableCell><a href={`/desk/${slug(item.voucher.reference_doctype)}/${item.voucher.reference_name}`} target='_blank' className='underline underline-offset-4'>{item.voucher.reference_name}</a></TableCell>
                    </TableRow>
                    <TableRow>
                        <TableHead>{_("Posting Date")}</TableHead>
                        <TableCell>{formatDate(item.voucher.posting_date, 'Do MMM YYYY')}</TableCell>
                    </TableRow>
                    {type === 'transfer' && item.voucher.doc && <TableRow>
                        <TableHead>{_("Transfer Account")}</TableHead>
                        <TableCell>
                            <TransferDetails item={item} className='text-ink-gray-8' />
                        </TableCell>
                    </TableRow>}
                    {type === 'payment' && item.voucher.doc && <TableRow>
                        <TableHead>{_("Payment Details")}</TableHead>
                        <TableCell>
                            <PaymentEntryDetails item={item} className='text-ink-gray-8' />
                        </TableCell>
                    </TableRow>}
                    {type === 'bank_entry' && item.voucher.doc && <TableRow>
                        <TableHead>{_("Account")}</TableHead>
                        <TableCell><JournalEntryAccountsTable item={item} bank={bank} /></TableCell>
                    </TableRow>}
                    </TableBody>
                </Table>
            </div>
            <AlertDialogFooter>
                <AlertDialogCancel disabled={loading}>
                    {_("Close")}
                </AlertDialogCancel>
                <Button theme="red" size='md' disabled={loading} onClick={onUndo}>
                    {loading ? <Loader2Icon className='w-4 h-4 animate-spin' /> : _(("Undo"))}
                </Button>
            </AlertDialogFooter>
        </AlertDialogContent>
    </AlertDialog>
}

export default ActionLogDialogBody
