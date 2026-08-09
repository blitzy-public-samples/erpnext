import {useAtomValue, useSetAtom} from "jotai"
import {bankRecClosingBalanceAtom, bankRecDateAtom, SelectedBank, selectedBankAccountAtom} from "./bankRecAtoms"
import {FrappeConfig, FrappeContext, useFrappeGetDocCount, useFrappeGetDocList, useFrappePostCall, useSWRConfig} from "frappe-react-sdk"
import {BankTransaction} from "@/types/Accounts/BankTransaction"
import {Progress} from "@/components/ui/progress"
import {useGetAccountClosingBalance, useGetAccountClosingBalanceAsPerStatement, useGetAccountOpeningBalance, useGetUnreconciledTransactions} from "./utils"
import {currencyInputValueToNumber, flt, formatCurrency, getCurrencyFormatInfo} from "@/lib/numbers"
import {Skeleton} from "@/components/ui/skeleton"
import {StatContainer, StatLabel, StatValue} from "@/components/ui/stats"
import {CheckCircle2, Edit, Info, TrendingDown, TrendingUp, Trash2} from "lucide-react"
import { H2, Paragraph } from "@/components/ui/typography"
import {HoverCard, HoverCardContent, HoverCardTrigger} from "@/components/ui/hover-card"
import {getCompanyCurrency} from "@/lib/company"
import _ from "@/lib/translate"
import {Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog"
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip"
import {formatDate} from "@/lib/date"
import {Form} from "@/components/ui/form"
import {CurrencyFormField} from "@/components/ui/form-elements"
import {useForm} from "react-hook-form"
import {Button} from "@/components/ui/button"
import {useContext, useState} from "react"
import {Separator} from "@/components/ui/separator"
import {BankAccountBalance} from "@/types/Accounts/BankAccountBalance"
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table"
import {toast} from "sonner"
import ErrorBanner from "@/components/ui/error-banner"
import {cn} from "@/lib/utils"

const BankBalance = () => {

    const bankAccount = useAtomValue(selectedBankAccountAtom)

    if (!bankAccount) {
        return null
    }
    /*
     * The four balances were a `w-[80%]` wrapping flex row with `justify-between`, which is the one
     * combination that guarantees a void: once the widest label pushed a stat onto a second line, the
     * remaining items were shoved to opposite ends of an 800px row with nothing between them, and at
     * 1920 the same rule spread four ~190px stats across a 1500px track. A grid removes the failure
     * mode outright - equal tracks cannot be spread apart - and reflows on a breakpoint instead of on
     * whatever the longest translated label happens to measure: two columns up to `xl`, four beyond it.
     */
    return (
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-8 gap-y-3 border-e border-e-border pe-8 xl:grid-cols-4">
                <OpeningBalance />
                <ClosingBalance />
                <ClosingBalanceAsPerStatement />
                <Difference />
            </div>

            <ReconcileProgress />
        </div>
    )
}

const OpeningBalance = () => {
    const bankAccount = useAtomValue(selectedBankAccountAtom)
    const { data, isLoading } = useGetAccountOpeningBalance()

    return <StatContainer className="min-w-48">
        <StatLabel>{_("Opening Balance")}</StatLabel>
        {isLoading ? <Skeleton className="w-[150px] h-5 rounded-sm" /> : <StatValue className="font-numeric">{formatCurrency(flt(data?.message, 2), bankAccount?.account_currency ?? getCompanyCurrency(bankAccount?.company ?? ''))}</StatValue>}
    </StatContainer>
}

const ClosingBalance = () => {
    const bankAccount = useAtomValue(selectedBankAccountAtom)
    const { data, isLoading } = useGetAccountClosingBalance()

    return (
        <StatContainer className="min-w-48">
            <div className="flex items-start gap-1">
                <StatLabel>
                    {_("Closing Balance as per system")}
                </StatLabel>
                <HoverCard openDelay={100}>
                    <HoverCardTrigger>
                        <Info className="size-3.5 text-ink-gray-6 -mt-px" />
                    </HoverCardTrigger>
                    <HoverCardContent className="w-96" align="start" side="right">
                        <H2 className="text-base border-0 p-0">{_("Closing balance as per system")}</H2>
                        <Paragraph className="mt-2 text-p-sm">
                            {_("This is what the system expects the closing balance to be in your bank statement.")}
                            <br />
                            {_("It takes into account all the transactions that have been posted and subtracts the transactions that have not cleared yet.")}
                            <br />
                            {_("If your bank statement shows a different closing balance, it is because all transactions have not reconciled yet.")}
                            <br /><br />
                            For more information, click on the <strong>Bank Reconciliation Statement</strong> tab below.
                        </Paragraph>
                    </HoverCardContent>
                </HoverCard>

            </div>
            {isLoading ? <Skeleton className="w-[150px] h-5 rounded-sm" /> : <StatValue className="font-numeric">{formatCurrency(flt(data?.message, 2), bankAccount?.account_currency ?? getCompanyCurrency(bankAccount?.company ?? ''))}</StatValue>}
        </StatContainer>
    )
}

const Difference = () => {
    const bankAccount = useAtomValue(selectedBankAccountAtom)

    const { data, isLoading } = useGetAccountClosingBalance()

    const value = useAtomValue(bankRecClosingBalanceAtom(bankAccount?.name ?? ''))

    /*
     * Rounded to the currency's smallest unit BEFORE anything is decided from it.
     *
     * The system's closing balance is a sum of ledger amounts, so it arrives carrying floating-point
     * residue: a fully reconciled account answered 7.275957614183426e-12 rather than 0. The unrounded
     * difference was then negative, so the tile called a balanced account a shortfall and coloured it red
     * while DISPLAYING it as zero - the state and the figure on screen disagreed. Two decimal places is
     * what the display shows, so it is what the state is decided on, and the two cannot diverge.
     */
    const difference = flt(value.value - (data?.message ?? 0), 2)

    const isError = difference !== 0

    const currency = bankAccount?.account_currency ?? getCompanyCurrency(bankAccount?.company ?? '')
    const formattedDifference = formatCurrency(difference, currency)

    /*
     * The three states are told apart by WORDS and a glyph, not by colour alone.
     *
     * A surplus and a shortfall were rendered in the identical red, and a reconciled account differed
     * only in being a neutral grey - so the tile carried three distinct meanings in two colours, none of
     * them named. Anyone who cannot compare those colours, or who is reading the account through a screen
     * reader, could not tell which of the three they were looking at.
     *
     * `difference` is the statement's closing balance less the system's, so a positive figure means the
     * statement holds more than the ledger accounts for.
     */
    const state = difference > 0 ? 'surplus' : difference < 0 ? 'shortfall' : 'balanced'

    const stateLabel = state === 'surplus'
        ? _("Surplus")
        : state === 'shortfall' ? _("Shortfall") : _("Balanced")

    const StateIcon = state === 'surplus' ? TrendingUp : state === 'shortfall' ? TrendingDown : CheckCircle2

    /*
     * One sentence for assistive technology, and the visual parts hidden from it, so the live region
     * announces the change once and in full rather than reading a bare figure twice.
     */
    const announcement = state === 'surplus'
        ? _("Difference {0}, a surplus over the closing balance as per system.", [formattedDifference])
        : state === 'shortfall'
            ? _("Difference {0}, a shortfall against the closing balance as per system.", [formattedDifference])
            : _("Difference {0}, the statement is balanced against the closing balance as per system.", [formattedDifference])

    return <StatContainer className="w-fit text-end sm:min-w-56">
        <StatLabel className="text-end">{_("Difference")}</StatLabel>
        {isLoading ? <Skeleton className="w-[150px] h-5 self-end rounded-sm" /> : <div
            role="status"
            aria-live="polite"
            data-difference-state={state}
            className="flex flex-col items-end gap-0.5"
        >
            <span className="sr-only">{announcement}</span>
            {/* The visual figure and word are hidden from assistive technology as one unit, so the
                sentence above is announced in full and nothing is read twice. */}
            <div aria-hidden="true" className="flex flex-col items-end gap-0.5">
                <StatValue className={isError ? 'text-ink-red-3 font-numeric' : 'font-numeric'}>
                    {formattedDifference}
                </StatValue>
                <span
                    className={cn(
                        'flex items-center gap-1 text-xs font-medium',
                        isError ? 'text-ink-red-3' : 'text-ink-green-3'
                    )}
                >
                    <StateIcon className="size-3" />
                    {stateLabel}
                </span>
            </div>
        </div>}
    </StatContainer>
}

const ReconcileProgress = () => {

    const bankAccount = useAtomValue(selectedBankAccountAtom)

    const dates = useAtomValue(bankRecDateAtom)

    const { data: totalCount, isLoading: isCountLoading } = useFrappeGetDocCount<BankTransaction>('Bank Transaction', [
        ["bank_account", "=", bankAccount?.name ?? ''],
        ['docstatus', '=', 1],
        ['date', '<=', dates?.toDate],
        ['date', '>=', dates?.fromDate]
    ], false, undefined, {
        revalidateOnFocus: false
    })

    const { data: unreconciledTransactions, isLoading: isUnreconciledLoading } = useGetUnreconciledTransactions()

    /*
     * Nothing counts reconciled transactions directly: the figure is the TOTAL minus the OUTSTANDING,
     * so it is only meaningful once BOTH reads have answered. Neither read is gated by the other, so
     * until then the pair is genuinely unknown rather than zero - and a subtraction performed on the
     * half that has arrived is not an approximation, it is wrong: with the count still in flight the
     * numerator went NEGATIVE (one outstanding transaction read as "-1 reconciled") and the
     * denominator stringified to the literal "undefined", both of which reached the accessibility
     * tree as text. The two figures are therefore withheld together behind the same Skeleton the
     * four balance stats above use, and `isLoading` alone is not enough to decide that: SWR reports
     * `isLoading: false` with `data` still `undefined` for a key it has not resolved yet.
     */
    const isProgressUnknown = isCountLoading || isUnreconciledLoading
        || totalCount === undefined || unreconciledTransactions === undefined

    /*
     * Clamped rather than trusted even once both have answered. The two reads are independent
     * queries over different filter sets, so a transaction can be absent from the count while still
     * being listed as outstanding; without the floor that difference would again render as a
     * negative count of reconciled transactions.
     */
    const reconciledCount = Math.max(0, (totalCount ?? 0) - (unreconciledTransactions?.message?.length ?? 0))

    const progress = Math.min(100, (totalCount ? reconciledCount / totalCount : 0) * 100)

    /*
     * Once both reads have answered, the bar REPORTS the pair: it is handed the value (which makes it
     * determinate and gives it an `aria-valuenow`), an explicit accessible name - a bar with a value but
     * no name announces a bare number, which says nothing about what is progressing - and the same
     * "x / y reconciled" wording for its spoken value that a sighted reviewer reads beside it.
     *
     * Until then it is not rendered at all. An earlier attempt kept the bar up with a "Counting
     * transactions..." hint in place of the figures, which does keep the literal "undefined" off the
     * page, but the bar still carried a `value` derived from half the data - a 0% determinate bar
     * asserting "nothing is reconciled" when the truth was simply not known yet. The Skeleton says
     * "not known" without asserting anything, and matches the four sibling balance stats.
     */

    /*
     * A definite width rather than `w-[18%]`: as a percentage the bar measured 184px at 1024 (too
     * narrow to read its own hint without wrapping) and 345px at 1920 (wider than it needs to be, and
     * the source of the trailing gap the strip was criticised for). 16rem is enough for the bar plus
     * "x / y reconciled" at every supported width.
     */
    return <div className="flex w-64 shrink-0 flex-col items-end gap-1">
        <div className="w-full">
            {isProgressUnknown
                ? <Skeleton className="w-full h-5 rounded-sm" />
                : <Progress
                    value={progress}
                    max={100}
                    size="md"
                    label={_("Progress")}
                    aria-label={_("Reconciliation progress")}
                    hint
                    hintText={`${reconciledCount} / ${totalCount} ${_("reconciled")}`} />}
        </div>
    </div>
}

const ClosingBalanceAsPerStatement = () => {

    const bankAccount = useAtomValue(selectedBankAccountAtom)
    const dates = useAtomValue(bankRecDateAtom)
    const setValue = useSetAtom(bankRecClosingBalanceAtom(bankAccount?.name ?? ''))

    const { data, isLoading } = useGetAccountClosingBalanceAsPerStatement({
        onSuccess: (data) => {
            /*
             * Every figure the server reports is adopted, zero included.
             *
             * The guard here used to be `if (data.message.balance)`, which is falsy for 0 - so the tile
             * and the Difference beside it kept whatever they held the last time a non-zero balance was
             * seen. That is what left both stale after the last saved balance was DELETED: the endpoint
             * answers `{balance: 0}` when no row remains, and that answer was discarded.
             */
            const balance = data?.message?.balance

            if (typeof balance === 'number' && Number.isFinite(balance)) {
                setValue({
                    value: balance,
                    stringValue: balance.toString()
                })
            }
        }
    })

    const isDateSame = data?.message?.date === dates.toDate

    const [isOpen, setIsOpen] = useState(false)


    return <StatContainer className="min-w-48">
        <StatLabel>{_("Closing Balance as per statement")}</StatLabel>
        <div className="flex flex-col gap-2 items-start">
            <Dialog open={isOpen} onOpenChange={setIsOpen}>
                <DialogTrigger>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div className="flex items-center gap-4 underline cursor-pointer underline-offset-6" role="button">
                                {isLoading ? <Skeleton className="w-[150px] h-5 rounded-sm" /> : <StatValue className="font-numeric">{formatCurrency(flt(data?.message?.balance, 2), bankAccount?.account_currency ?? getCompanyCurrency(bankAccount?.company ?? ''))}</StatValue>}
                                <Edit className="w-4 h-4" />
                            </div>
                        </TooltipTrigger>
                        <TooltipContent>
                            {_("Click to set the closing balance as per statement")}
                        </TooltipContent>
                    </Tooltip>
                </DialogTrigger>
                <DialogContent size="xl">
                    <ClosingBalanceForm
                        defaultBalance={data?.message?.balance ?? 0}
                        date={dates.toDate}
                        bankAccount={bankAccount}
                        onClose={() => setIsOpen(false)}
                    />


                </DialogContent>
            </Dialog>
            {!isDateSame && data?.message.date && <span className="text-xs font-medium text-ink-red-3">{_("As of {0}", [formatDate(data?.message?.date ?? '', 'Do MMM YYYY')])}</span>}
        </div>
    </StatContainer>

}

const ClosingBalanceForm = ({ defaultBalance, date, bankAccount, onClose }: { defaultBalance: number, date: string, bankAccount: SelectedBank | null, onClose: VoidFunction }) => {

    const { mutate } = useSWRConfig()

    const currency = bankAccount?.account_currency ?? getCompanyCurrency(bankAccount?.company ?? '')

    /*
     * `balance` is a union because the field echoes its own text back while a decimal is being typed - see
     * `parseCurrencyInput`. `onSubmit` narrows it with `currencyInputValueToNumber`.
     */
    const form = useForm<{ balance: number | string }>({
        defaultValues: {
            balance: defaultBalance
        }
    })

    const setValue = useSetAtom(bankRecClosingBalanceAtom(bankAccount?.name ?? ''))

    const { call, loading, error } = useFrappePostCall("erpnext.accounts.doctype.bank_account.bank_account.set_closing_balance_as_per_statement")

    const onSubmit = (data: { balance: number | string }) => {
        /*
         * Zero is a balance, and so is a negative one.
         *
         * The guard here used to be `if (data.balance)`, which is falsy for 0 - so a reviewer whose
         * statement genuinely closed at zero was told "Closing balance is required", no request was sent,
         * and there was no way to record it at all. The test is now for a usable NUMBER: absent, empty or
         * unparseable text is what "required" means, and every real figure - including 0 and an overdrawn
         * negative - is accepted and sent.
         */
        const formatInfo = getCurrencyFormatInfo(currency)
        const balance = currencyInputValueToNumber(data.balance, {
            groupSeparator: formatInfo.group_sep,
            decimalSeparator: formatInfo.decimal_str
        })

        if (balance !== null) {
            call({
                bank_account: bankAccount?.name ?? '',
                date: date,
                balance: balance
            })
                .then(() => {
                    // Mutate the closing balance as per statement
                    mutate(`bank-reconciliation-account-closing-balance-as-per-statement-${bankAccount?.name}-${date}`)
                    setValue({
                        value: balance,
                        stringValue: balance.toString()
                    })
                    toast.success(_("Closing balance set."))
                    onClose()


                })
        } else {
            toast.error(_("Closing balance is required."))
        }
    }

    return <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
            <DialogHeader>
                <DialogTitle>{_("Set closing balance as per bank statement")}</DialogTitle>
                <DialogDescription>
                    {_("Enter the closing balance you see in your bank statement for {0} as of the {1}", [bankAccount?.account_name ?? bankAccount?.name ?? '', formatDate(date, 'Do MMM YYYY')])}
                </DialogDescription>
            </DialogHeader>
            {error && <div className="py-2"><ErrorBanner error={error} /></div>}
            <div className="py-4">
                <CurrencyFormField
                    name="balance"
                    label={_("Closing balance on bank statement as of {0}", [formatDate(date, 'Do MMM YYYY')])}
                    isRequired
                    currency={currency}
                />
            </div>

            <DialogFooter>
                <DialogClose asChild>
                    <Button variant={'outline'} size='md' disabled={loading}>{_("Cancel")}</Button>
                </DialogClose>
                <Button type='submit' size='md' disabled={loading}>{_("Save")}</Button>
            </DialogFooter>

            <ClosingBalancesList bankAccount={bankAccount} date={date} />
        </form>
    </Form>
}

const ClosingBalancesList = ({ bankAccount, date }: { bankAccount: SelectedBank | null, date: string }) => {

    const { mutate: revalidate } = useSWRConfig()

    const { data, mutate } = useFrappeGetDocList<BankAccountBalance>("Bank Account Balance", {
        filters: [["bank_account", "=", bankAccount?.name ?? ''], ["date", "<=", date]],
        orderBy: {
            field: "date",
            order: "desc"
        },
        fields: ["date", "balance", "name"],
        limit: 10
    })

    const { db } = useContext(FrappeContext) as FrappeConfig

    const onDelete = (name: string) => {
        toast.promise(db.deleteDoc("Bank Account Balance", name).then(() => {
            mutate()
            /*
             * The tiles are told too, not just this list.
             *
             * Deleting a row used to refresh only the table it was deleted from: the "Closing Balance as
             * per statement" tile and the Difference beside it went on showing the figure that had just
             * been removed until the page was reloaded. Re-reading the endpoint is what makes them
             * correct - it falls back to the next older statement balance, or to zero when none is left -
             * and the tile's own success handler then carries that answer into the shared atom the
             * Difference reads.
             */
            return revalidate(`bank-reconciliation-account-closing-balance-as-per-statement-${bankAccount?.name}-${date}`)
        }), {
            loading: _("Deleting closing balance..."),
            success: _("Closing balance deleted."),
            error: _("Failed to delete closing balance.")
        })
    }

    if (data?.length === 0) {
        return null
    }

    return <div>
        <Separator className="my-8" />
        <p className="text-sm text-center">{_("Balances as per bank statement before {0}", [formatDate(date, 'Do MMM YYYY')])}</p>
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>{_("Date")}</TableHead>
                    <TableHead className="text-end">{_("Balance")}</TableHead>
                    <TableHead></TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {data?.map((item) => (
                    <TableRow key={item.name}>
                        <TableCell>{formatDate(item.date, 'Do MMM YYYY')}</TableCell>
                        <TableCell className="text-end">{formatCurrency(flt(item.balance, 2), bankAccount?.account_currency ?? getCompanyCurrency(bankAccount?.company ?? ''))}</TableCell>
                        <TableCell className="text-end">
                            <Button
                                title={_("Delete")}
                                type='button' isIconButton variant='ghost' onClick={() => onDelete(item.name)}>
                                <Trash2 />
                            </Button>
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    </div>

}

export default BankBalance