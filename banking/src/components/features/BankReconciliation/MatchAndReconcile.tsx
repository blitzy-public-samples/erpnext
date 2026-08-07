import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { bankRecAmountFilter, bankRecDateAtom, bankRecLastRefusalAtom, bankRecRecordJournalEntryModalAtom, bankRecRecordPaymentModalAtom, bankRecSelectedTransactionsAtom, bankRecTransactionTypeFilter, bankRecTransferModalAtom, selectedBankAccountAtom, selectedTransactionScopeKey } from "./bankRecAtoms"
import { H4 } from "@/components/ui/typography"
import { useEffect, useMemo, useRef, useState } from "react"
import { useAvailableHeight } from "@/hooks/use-available-height"
import { getCompanyCurrency } from "@/lib/company"
import ErrorBanner from "@/components/ui/error-banner"
import { Separator } from "@/components/ui/separator"
import Fuse from 'fuse.js'
import { getSearchResults, LinkedPayment, TransactionDirection, UnreconciledTransaction, useGetRuleForTransaction, useGetUnreconciledTransactions, useGetVouchersForTransaction, useIsTransactionWithdrawal, useReconcileTransaction, useSelectedBankAccountCurrency, useTransactionSearch } from "./utils"
import { Input } from "@/components/ui/input"
import { AlertCircleIcon, ArrowDownRight, ArrowRightIcon, ArrowRightLeft, ArrowUpRight, BadgeCheck, ChevronDown, DollarSign, Landmark, LandmarkIcon, ListIcon, Loader2, MinusIcon, Receipt, ReceiptIcon, Search, User, XCircle, ZapIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import CurrencyInput from 'react-currency-input-field'
import { getCurrencySymbol } from "@/lib/currency"
import { useVirtualizer } from '@tanstack/react-virtual'
import { formatDate } from "@/lib/date"
import { Badge } from "@/components/ui/badge"
import { formatCurrency, getCurrencyFormatInfo, parseCurrencyInput } from "@/lib/numbers"
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { slug } from "@/lib/frappe"
import _ from "@/lib/translate"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import TransferModal from "./TransferModal"
import BankEntryModal from "./BankEntryModal"
import RecordPaymentModal from "./RecordPaymentModal"
import BankRecErrorDialog from "./BankRecErrorDialog"
import SelectedTransactionsTable from "./SelectedTransactionsTable"
import MatchFilters from "./MatchFilters"
import { useHotkeys } from "react-hotkeys-hook"
import { KeyboardMetaKeyIcon } from "@/components/ui/keyboard-keys"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { useFrappeGetCall } from "frappe-react-sdk"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Link } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { InputGroup, InputGroupAddon, InputGroupText } from "@/components/ui/input-group"

const MatchAndReconcile = ({ contentHeight }: { contentHeight: number }) => {
    const selectedBank = useAtomValue(selectedBankAccountAtom)

    if (!selectedBank) {
        return <Empty>
            <EmptyMedia>
                <LandmarkIcon />
            </EmptyMedia>
            <EmptyHeader>
                <EmptyTitle>{_("Select a bank account to reconcile")}</EmptyTitle>
            </EmptyHeader>
        </Empty>
    }

    return <>
        {/* Two panes side by side is the comparison surface this screen exists to provide, but only while
            each pane is wide enough to read. Below `xl` they stack instead of being squeezed: at 1024px a
            side-by-side pane measured 483px and at 768px only ~355px, which wrapped every transaction row
            onto three or four lines and left the amount column colliding with the description. `min-w-0`
            on both is what actually lets them narrow - a flex item defaults to `min-width:auto`, so
            without it the panes refuse to go below their content width and push their content out
            instead. */}
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:gap-2" >
            <div className="flex-1 min-w-0">
                <H4 className="text-sm font-medium">{_("Unreconciled Transactions")}</H4>
                <UnreconciledTransactions />
            </div>
            <Separator orientation="vertical" className="hidden xl:block" style={{ minHeight: `${contentHeight}px` }} />
            <Separator orientation="horizontal" className="xl:hidden" />
            <div className="flex-1 min-w-0 xl:px-1">
                <H4 className="text-sm font-medium">{_("Match or Create")}</H4>
                <VouchersSection contentHeight={contentHeight} />
            </div>
        </div>
        <TransferModal />
        <BankEntryModal />
        <RecordPaymentModal />
        {/* The same atom drives the mounts on the statement-importer surfaces, which sit in a different
            route tree, so no two surfaces can report different errors at once. */}
        <BankRecErrorDialog />
    </>
}

/** TanStack requires `estimateSize` for initial scroll range; `measureElement` on each row sets the real height. */
function VirtualizedListBody<T>({
    items,
    height,
    getItemKey,
    children,
    estimateSize = 74,
}: {
    items: T[]
    height: number
    getItemKey: (item: T, index: number) => string | number
    children: (item: T, index: number) => React.ReactNode
    estimateSize?: number
}) {
    const scrollRef = useRef<HTMLDivElement>(null)

    const rowVirtualizer = useVirtualizer({
        count: items.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => estimateSize,
        overscan: 8,
        getItemKey: (index) => String(getItemKey(items[index], index)),
    })

    if (items.length === 0) {
        return null
    }

    return (
        <div
            ref={scrollRef}
            className="overflow-auto contain-strict"
            style={{ height }}
        >
            <div
                className="relative w-full"
                style={{ height: rowVirtualizer.getTotalSize() }}
            >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => (
                    <div
                        key={virtualRow.key}
                        data-index={virtualRow.index}
                        ref={rowVirtualizer.measureElement}
                        className="absolute top-0 left-0 w-full"
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                        {children(items[virtualRow.index], virtualRow.index)}
                    </div>
                ))}
            </div>
        </div>
    )
}

const UnreconciledTransactions = () => {
    const bankAccount = useAtomValue(selectedBankAccountAtom)
    const dates = useAtomValue(bankRecDateAtom)
    const setSelectedTransaction = useSetAtom(bankRecSelectedTransactionsAtom)

    const currency = bankAccount?.account_currency ?? getCompanyCurrency(bankAccount?.company ?? '')
    const currencySymbol = getCurrencySymbol(currency)
    const formatInfo = getCurrencyFormatInfo(currency)
    const groupSeparator = formatInfo.group_sep || ","
    const decimalSeparator = formatInfo.decimal_str || "."

    const inputRef = useRef<HTMLInputElement>(null)

    const { data: unreconciledTransactions, isLoading, error } = useGetUnreconciledTransactions()

    const [typeFilter, setTypeFilter] = useAtom(bankRecTransactionTypeFilter)
    const [amountFilter, setAmountFilter] = useAtom(bankRecAmountFilter)

    const [search, setSearch] = useTransactionSearch()

    /** Set when the amount field holds text that cannot be used, so the reason can be shown in place. */
    const [amountFilterError, setAmountFilterError] = useState<string | null>(null)

    const searchIndex = useMemo(() => {

        if (!unreconciledTransactions) {
            return null
        }

        return new Fuse(unreconciledTransactions.message, {
            keys: ['description', 'reference_number'],
            threshold: 0.5,
            includeScore: true
        })
    }, [unreconciledTransactions])

    const results = useMemo(() => {

        return getSearchResults(searchIndex, search, typeFilter, amountFilter.value, unreconciledTransactions?.message)

    }, [searchIndex, search, typeFilter, amountFilter.value, unreconciledTransactions?.message])

    /*
     * Leaving a scope ENDS the review.
     *
     * The selection atom already refuses to read a selection made under a different account or date
     * range, but refusing to read it is not the same as being rid of it: the row was still held, so
     * returning to the account replayed it - which is the account-switch resurrection this closes. One
     * write in the new scope is enough, because the atom keeps a single scope-stamped selection, so the
     * previous one is overwritten rather than parked.
     *
     * Guarded on a CHANGE rather than run on mount, so a selection made before this list mounted - a
     * reviewer returning from a modal, or from another tab - is left alone.
     */
    const scopeKey = selectedTransactionScopeKey(bankAccount?.name, dates)
    const scopeRef = useRef(scopeKey)

    useEffect(() => {
        if (scopeRef.current === scopeKey) {
            return
        }

        scopeRef.current = scopeKey
        setSelectedTransaction([])
    }, [scopeKey, setSelectedTransaction])

    /*
     * Filters no longer discard the selection.
     *
     * Every filter change used to clear it outright, so narrowing the list threw away the row under
     * review and its loaded candidates even when the filter still matched them - and a reviewer who
     * typed a search term to find something adjacent lost their place for no reason. A filter changes
     * what is LISTED, not what is under review, so the two are now independent.
     *
     * What does end a selection is a change of SCOPE - a different account, or a different date range -
     * and that is handled by the selection atom itself, which is keyed by both. So a row selected in
     * August cannot survive a move to July, where it is not in the result set at all.
     *
     * A row the SERVER has moved on from is handled where the server's answer arrives:
     * `convergeWithServer` in the reconcile hook re-reads the list after a refusal and drops any selected
     * row the re-read no longer returns.
     */

    const onSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setSearch(e.target.value)
    }

    const onTypeFilterChange = (type: string) => {
        setTypeFilter(type)
    }

    const onClearFilters = () => {
        setSearch('')
        if (inputRef.current) {
            inputRef.current.value = ''
        }
        setTypeFilter('All')
        setAmountFilter({ value: 0, stringValue: '' })
        setAmountFilterError(null)
    }

    /*
     * Whether there is anything to reset - which includes an amount the filter REFUSED.
     *
     * Keying this on the filtered number alone left a reviewer who typed a negative looking at a field
     * holding red text and an error message with no reset control at all, because a refused amount filters
     * on nothing and so read as "no filters active". What the reviewer sees in the box is what decides it.
     */
    const hasAmountText = String(amountFilter.stringValue ?? '') !== ''

    const hasFilters = search !== '' || typeFilter !== 'All' || amountFilter.value !== 0 || hasAmountText

    /** Identity of the current filter set - see the `key` on the list body below. */
    const listResetKey = `${search}\u0000${typeFilter}\u0000${amountFilter.value}`

    /*
     * The list is sized from where it actually sits, rather than from an arithmetic guess. Everything
     * above it - the filter row, and above all the older-transactions banner, which wraps to many more
     * lines as the window narrows - changes height with the viewport, so no constant offset can be right
     * at every width. See `useAvailableHeight`.
     */
    const [listRef, listHeight] = useAvailableHeight({ min: 240, gutter: 24 })

    if (isLoading) {
        return <UnreconciledTransactionsLoadingState />
    }

    return <div className="space-y-1">
        {/* `flex-wrap` plus a floor on the search field: the two filters to its right keep their width, so
            an unwrapped row made the search input absorb every pixel of shrinkage and it collapsed to 24px
            at 768px - too narrow to show its own placeholder. Wrapping moves them to a second line
            instead. The floor is on the GROUP, which also carries the leading icon and the trailing result
            counter, so it is set well above the width wanted for the text field alone. */}
        <div className="flex flex-wrap py-2 w-full gap-2">

            <InputGroup variant='outline' className="min-w-72 flex-1">
                <label className="sr-only" htmlFor="bank-rec-transaction-search">{_("Search transactions")}</label>
                <InputGroupAddon>
                    <Search className="w-4 h-4 text-ink-gray-5" />
                </InputGroupAddon>
                <Input
                    id="bank-rec-transaction-search"
                    name="bank-rec-transaction-search"
                    aria-label={_("Search transactions")}
                    placeholder={_("Search")}
                    // type='search'
                    variant='outline'
                    onChange={onSearchChange}
                    defaultValue={search}
                    ref={inputRef}
                />
                <InputGroupAddon align='inline-end'>
                    <InputGroupText>{results?.length} {_(results?.length === 1 ? "result" : "results")}</InputGroupText>
                </InputGroupAddon>
            </InputGroup>
            <div>
                <label className="sr-only" htmlFor="bank-rec-amount-filter">{_("Filter by amount")}</label>
                <CurrencyInput
                    id="bank-rec-amount-filter"
                    name="bank-rec-amount-filter"
                    aria-label={_("Filter by amount")}
                    groupSeparator={groupSeparator}
                    decimalSeparator={decimalSeparator}
                    placeholder={`${currencySymbol}0${decimalSeparator}00`}
                    decimalsLimit={2}
                    value={amountFilter.stringValue}
                    maxLength={12}
                    decimalScale={2}
                    /* The library's k/m/b shorthand is off: a bank amount is typed in full, and left on
                       it a stray letter multiplies the figure. `12ab34` was read as `12b34` and filtered
                       on 120,000,000,003 - a figure the reviewer never typed. Off, the letters are simply
                       dropped and 1234 is filtered. */
                    disableAbbreviations
                    prefix={currencySymbol}
                    aria-invalid={amountFilterError !== null}
                    aria-describedby={amountFilterError ? 'bank-rec-amount-filter-error' : undefined}
                    onValueChange={(v, _n, values) => {
                        /*
                         * The number comes from the library's own parse, never from re-reading the
                         * displayed text. Storing "the string while a decimal is being typed, otherwise
                         * the float" and then running `Number()` over that union is what previously
                         * produced `NaN` on a grouped value, inflated 1.23 into 1,230,000,000, and
                         * filtered on a silently truncated 12 for `12ab34`. See `parseCurrencyInput`.
                         */
                        const parsed = parseCurrencyInput({ text: v, float: values?.float, decimalSeparator })

                        // A negative can never match: the list compares against withdrawal and deposit,
                        // both of which the server stores as positive magnitudes. So it is refused out
                        // loud rather than accepted and quietly ignored.
                        const isNegative = parsed.value !== null && parsed.value < 0

                        setAmountFilterError(
                            parsed.isInvalid ? _("Enter an amount, for example {0}", [`1${decimalSeparator}00`])
                                : isNegative ? _("Amounts are matched by magnitude, so a negative amount cannot match a transaction.")
                                    : null
                        )

                        setAmountFilter({
                            // Only a usable, non-negative number filters anything; 0 means "no filter".
                            value: parsed.value !== null && !isNegative ? parsed.value : 0,
                            stringValue: parsed.text
                        })
                    }}
                    // @ts-expect-error - CurrencyInputProps doesn't have a variant prop but Input does
                    variant={"outline"}
                    customInput={Input}
                />
                {amountFilterError && <p
                    id="bank-rec-amount-filter-error"
                    role="alert"
                    className="text-xs text-ink-red-3 max-w-56 text-wrap">
                    {amountFilterError}
                </p>}
            </div>
            <div>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size='md' className="min-w-32 text-start">
                            {typeFilter === 'All' ? <DollarSign className="text-ink-gray-5" /> : typeFilter === 'Debits' ? <ArrowUpRight className="text-ink-red-3" /> : <ArrowDownRight className="text-ink-green-3" />}
                            {_(typeFilter)}
                            <ChevronDown className="text-ink-gray-5" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                        <DropdownMenuItem onClick={() => onTypeFilterChange('All')}><DollarSign /> {_("All")}</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onTypeFilterChange('Debits')}><ArrowUpRight className="text-ink-red-3" /> {_("Debits")}</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onTypeFilterChange('Credits')}><ArrowDownRight className="text-ink-green-3" /> {_("Credits")}</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            {/* Reachable whenever a filter is active, not only once the filters have hidden everything.
                Previously the only way back to the unfiltered list was to empty each control by hand, and
                a reviewer looking at a short list had no way to tell how much a filter was hiding. */}
            {hasFilters && <Button
                type='button'
                size='md'
                variant='ghost'
                onClick={onClearFilters}>
                <XCircle className="text-ink-gray-5" />
                {_("Clear Filters")}
            </Button>}
        </div>

        {error && <ErrorBanner error={error} />}

        <OlderUnreconciledTransactionsBanner />

        {results.length === 0 && <NoTransactionsFoundBanner
            onClearFilters={hasFilters ? onClearFilters : undefined}
            text={hasFilters ? _("No transactions found for the given filters.") : _("No unreconciled transactions found")}
            description={hasFilters ? _("Try adjusting your search or filter criteria.") : _("Import your bank statement to get started.")} />}

        <div ref={listRef}>
            <VirtualizedListBody
                /*
                 * A filter change starts a FRESH list, rather than asking the old one to recover.
                 *
                 * Filtering a scrolled list down to a couple of rows shortens the scroll area, so the
                 * browser clamps `scrollTop` to 0 by itself - and it does so without a scroll event, which
                 * is the only thing the virtualiser listens to. Its remembered offset then belonged to the
                 * unfiltered list: clearing the filter rendered the rows for that old offset and placed
                 * every one of them more than a thousand pixels below the visible box, so the pane looked
                 * empty until the reviewer happened to scroll. Remounting on a filter change gives a
                 * virtualiser whose offset and element agree from the outset, and starting a new result set
                 * at the top is what a reviewer expects in any case. Deliberately keyed on the FILTERS and
                 * not on the row count, so reconciling a row does not throw the reviewer back to the top.
                 */
                key={listResetKey}
                items={results}
                height={listHeight}
                estimateSize={74}
                getItemKey={(transaction) => transaction.name}
            >
                {(transaction) => <UnreconciledTransactionItem transaction={transaction} />}
            </VirtualizedListBody>
        </div>

    </div>
}

const NoTransactionsFoundBanner = ({ text, description, onClearFilters }: { text: string, description?: string, onClearFilters?: () => void }) => {

    return <Empty>
        <EmptyMedia>
            <ListIcon />
        </EmptyMedia>
        <EmptyHeader>
            <EmptyTitle>{text}</EmptyTitle>
            {description && <EmptyDescription>{description}</EmptyDescription>}
        </EmptyHeader>
        <EmptyContent>
            {onClearFilters ? <Button type='button' size='sm' variant='subtle' onClick={onClearFilters}>Clear Filters</Button> :
                <Button type='button' asChild size='sm' variant='subtle'>
                    <Link to="/statement-importer">
                        {_("Import Bank Statement")}
                    </Link>
                </Button>}
        </EmptyContent>
    </Empty>
}

const UnreconciledTransactionsLoadingState = () => {

    return <div className="flex flex-col gap-2 py-2">
        <div className="flex items-center gap-2 pb-2">
            <Skeleton className="h-9.5 w-full" />
            <Skeleton className="h-9.5 min-w-36" />
            <Skeleton className="h-9.5 min-w-32" />
        </div>
        {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
        ))}
    </div>
}

/**
 * The direction of a transaction, as an icon that also says which direction it is.
 *
 * Direction was previously carried by the arrow's shape and colour alone, which says nothing to a screen
 * reader and nothing to a reviewer who cannot tell the two greens apart - so each icon now carries a
 * name, and a `title` puts the same words within reach of the pointer.
 *
 * `none` is a real state the server can report: a statement row can carry no amount in either column.
 * It used to fall through to the deposit arrow and claim money had come in.
 */
const TransactionDirectionIcon = ({ direction }: { direction: TransactionDirection }) => {

    const label = direction === 'withdrawal'
        ? _("Money out")
        : direction === 'deposit'
            ? _("Money in")
            : _("No amount recorded")

    const Icon = direction === 'withdrawal' ? ArrowUpRight : direction === 'deposit' ? ArrowDownRight : MinusIcon

    const theme = direction === 'withdrawal'
        ? "text-ink-red-3"
        : direction === 'deposit'
            ? "text-ink-green-3"
            : "text-ink-gray-5"

    /* The name and the `title` live on a wrapping span: the icon component accepts no `title` prop, and
       an `aria-hidden` icon inside a named `role="img"` is the shape that reads as one image. */
    return <span
        role="img"
        aria-label={label}
        title={label}
        data-direction={direction}
        className="inline-flex">
        <Icon aria-hidden="true" className={cn("size-5 shrink-0", theme)} />
    </span>
}

const UnreconciledTransactionItem = ({ transaction }: { transaction: UnreconciledTransaction }) => {

    const selectedBank = useAtomValue(selectedBankAccountAtom)

    const [selectedTransaction, setSelectedTransaction] = useAtom(bankRecSelectedTransactionsAtom)

    const { amount, direction } = useIsTransactionWithdrawal(transaction)

    const isSelected = selectedTransaction?.some((t) => t.name === transaction.name)

    /*
     * The account currency as the server currently reports it, NOT as the `localStorage`-backed
     * selection remembers it: that snapshot is only rewritten when the selection changes, so
     * re-selecting the same account replays a value that can be arbitrarily old. The snapshot is still
     * a reasonable last resort for FORMATTING while the list is in flight, but never for the advisory.
     */
    const accountCurrency = useSelectedBankAccountCurrency()

    const currency = transaction.currency ?? accountCurrency ?? selectedBank?.account_currency ?? getCompanyCurrency(selectedBank?.company ?? '')

    /*
     * The advisory currency-mismatch predicate, derived from the server rather than designed:
     * `validate_currency` on Bank Transaction resolves `Bank Account.account` ->
     * `Account.account_currency`, and `bank_account.get_list` attaches `account_currency` to each row
     * through that identical lookup, so the two sides cannot disagree.
     *
     * Either side may legitimately be unknown - a row without a currency, an account whose linked
     * ledger carries none, or a list that has not arrived yet - and unknown means "nothing to compare",
     * never "mismatch".
     */
    const isCurrencyMismatch = Boolean(transaction.currency && accountCurrency && transaction.currency !== accountCurrency)

    /** `additive` is the shift modifier: add to or remove from the selection instead of replacing it. */
    const selectTransaction = (additive: boolean) => {
        if (additive) {
            setSelectedTransaction(isSelected ? selectedTransaction.filter((t) => t.name !== transaction.name) : [...selectedTransaction, transaction])
        } else {
            setSelectedTransaction([transaction])
        }
    }

    const handleSelectTransaction = (event: React.MouseEvent<HTMLDivElement>) => selectTransaction(event.shiftKey)

    /*
     * Enter and Space select the row, and shift extends the selection exactly as shift-clicking does.
     *
     * The row advertises `role="button"`, but a `div` gets no keyboard activation from the browser, so
     * Enter did nothing at all and Space fell through to its default: scrolling the virtualised list,
     * which carried the focused row out of view and left focus stranded on a row the reviewer could no
     * longer see. Preventing the default is what a native button does.
     */
    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return
        }

        event.preventDefault()
        selectTransaction(event.shiftKey)
    }

    return <div className="py-1">
        {/* `aria-pressed`, not `aria-selected`: `aria-selected` is not an allowed attribute on
            `role="button"` and is discarded, so it would have announced nothing. `aria-pressed` is the
            state a button may carry, and it is what the bank cards use for the same purpose.

            `focus-visible:shadow-focus-gray` is the design system's focus treatment. An outline cannot be
            used here - the selected state already owns `outline` - and without it a keyboard user had no
            idea which row they were on. */}
        <div className={cn("border outline rounded-md p-2 mx-0.5 cursor-pointer transition-[color,box-shadow, bg] hover:bg-surface-gray-1 focus-visible:shadow-focus-gray",
            isSelected ? "bg-surface-gray-1 border-outline-gray-5 outline-outline-gray-5" : "border-outline-gray-2 outline-none"
        )}
            role='button'
            tabIndex={0}
            aria-pressed={isSelected}
            onClick={handleSelectTransaction}
            onKeyDown={onKeyDown}>
            <div className="flex justify-between items-start w-full gap-2">
                {/* `flex-1 min-w-0` on the text column and `shrink-0` on the amount column.
                    A flex item defaults to `min-width:auto`, so this column refused to narrow below its
                    content and pushed itself over the amounts instead of letting them keep their space -
                    a long reference sat across half of the figure it belonged to. */}
                <div className="flex-1 min-w-0 space-y-1 overflow-hidden whitespace-pre-wrap">
                    {/* `flex-wrap`, plus a bound on every variable-length badge ahead of the advisory.
                        This cluster sits inside an `overflow-hidden` pane and Badge is deliberately
                        `shrink-0 whitespace-nowrap`, so without both an unbounded rule name or
                        transaction type pushed the trailing currency advisory clean out of the visible
                        area - silently hiding a warning. Wrapping lets the pane grow taller instead.

                        Each bounded badge is made shrinkable and truncates through an INNER block span.
                        `text-overflow` has no effect on the Badge itself: it is `inline-flex` and
                        `justify-center`, so over-long text was cut symmetrically at both edges instead of
                        ellipsised. `shrink` is what keeps a badge that is alone on a wrapped line from
                        overflowing a pane narrower than its own maximum. */}
                    <div className="flex flex-wrap items-center gap-1">
                        {/* The date does not shrink and does not wrap. It was the first item in a
                            wrapping row, so a long badge beside it squeezed "6th August 2026" onto three
                            lines and set the height of everything after it. */}
                        <span className="font-medium text-sm shrink-0 whitespace-nowrap">{formatDate(transaction.date)}</span>
                        {transaction.transaction_type &&
                            <Badge theme="blue"
                                title={transaction.transaction_type}
                                className="min-w-0 shrink max-w-40">
                                <span className="truncate">{transaction.transaction_type}</span></Badge>}
                        {transaction.reference_number && <Badge
                            title={transaction.reference_number}
                            className="min-w-0 shrink max-w-[300px]"
                        >
                            <span className="truncate">{_("Ref")}: {transaction.reference_number}</span></Badge>}

                        {/* Titled with the rule name as well as the label, because the bound above may
                            ellipsise the name itself. */}
                        {transaction.matched_transaction_rule && <Badge
                            theme="violet"
                            title={`${_("Matched by rule")}: ${transaction.matched_transaction_rule}`}
                            className="min-w-0 shrink max-w-56">
                            <ZapIcon className="w-4 h-4 shrink-0" />
                            <span className="truncate">{transaction.matched_transaction_rule}</span></Badge>}

                        {/* Advisory only: Reconcile stays enabled, because the server and not this badge
                            decides whether a post is allowed. `theme="orange"` resolves to the amber ink
                            and surface tokens, since Badge declares no `amber` theme.

                            Size is left at Badge's default `md` deliberately, not by omission. Every badge
                            in this cluster takes that default, as does the identically themed "Partial
                            Match" badge in the voucher panel, so an `sm` chip here read as a 16px pill with
                            a 10px icon among 20px siblings with 12px icons. Subordination is already
                            carried by `variant="subtle"` and the amber theme; size only broke the rhythm.

                            The trigger is a focusable span rather than the Badge itself. Badge renders a
                            plain span, which takes no focus, so a keyboard user reaching this row had no
                            way to reveal the explanation - focusing the row shows nothing. The span
                            carries the accessible name and Radix points `aria-describedby` at the tooltip
                            while it is open, so focus alone announces the warning and its reason. */}
                        {isCurrencyMismatch && <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span
                                        tabIndex={0}
                                        aria-label={_("Currency mismatch: transaction in {0}, bank account in {1}", [transaction.currency ?? '', accountCurrency ?? ''])}
                                        className="inline-flex rounded-full outline-none focus-visible:shadow-focus-gray">
                                        <Badge variant="subtle" theme="orange">
                                            <AlertCircleIcon /> {transaction.currency}</Badge>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-sm text-balance wrap-break-word">
                                    {_("Transaction currency {0} differs from the bank account currency {1}. This indicator does not block the action - the server validates the currency when the reconciliation is posted, and refuses a mismatch.", [transaction.currency ?? '', accountCurrency ?? ''])}
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>}
                    </div>
                    {/* Two lines at most, with the whole description on the `title`. Unbounded, a
                        multi-line statement narrative grew the row past 400px and pushed every other
                        transaction off the screen. */}
                    <span className="text-sm wrap-anywhere line-clamp-2" title={transaction.description}>{transaction.description}</span>
                </div>
                <div className="gap-1 flex flex-col items-end min-w-36 shrink-0 h-full text-end">
                    <TransactionDirectionIcon direction={direction} />
                    {/* Always a figure, formatted. The guard here was `amount && amount > 0 &&`, which for
                        a zero-amount transaction evaluated to the number 0 and put a bare, unformatted
                        `0` on screen with no amount element at all. Zero is a real amount and is shown as
                        one. */}
                    <span className="font-semibold font-numeric text-base">{formatCurrency(amount, currency)}</span>
                    {amount !== transaction.unallocated_amount && <span className="text-xs leading-normal text-ink-gray-5">{formatCurrency(transaction.unallocated_amount, currency)} {_("Unallocated")}</span>}
                </div>
            </div>
        </div>
    </div>
}


/**
 * The reason a reconciliation was refused, kept on screen after the dialog has been dismissed.
 *
 * The dialog is modal and momentary, and dismissing it used to take the only explanation with it. That
 * mattered most in the case it exists for: the server refuses because the transaction has already been
 * reconciled elsewhere, the client re-reads, the row leaves the unreconciled list - and the reviewer is
 * left looking at an empty pane with nothing saying why what they were working on disappeared.
 *
 * It reuses `ErrorBanner`, so the server's own words reach the reviewer here in exactly the form the
 * dialog showed them, down to the severity the server itself indicated.
 */
const LastRefusalNotice = () => {

    const [refusal, setRefusal] = useAtom(bankRecLastRefusalAtom)

    if (!refusal) {
        return null
    }

    return <div className="flex flex-col gap-1 pt-2" data-testid="bank-rec-last-refusal">
        <ErrorBanner
            error={refusal.error}
            overrideHeading={refusal.refused
                ? _("The server refused this reconciliation")
                : _("This reconciliation was not confirmed")} />
        <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-xs text-ink-gray-5">
                {refusal.refused
                    ? _("Nothing was posted. This bank account has been re-read, so what you see below is the server's current answer.")
                    : _("The server did not answer, so it is not known whether this was recorded. This bank account has been re-read.")}
            </span>
            <Button
                type='button'
                size='sm'
                variant='ghost'
                onClick={() => setRefusal(null)}>
                {_("Dismiss")}
            </Button>
        </div>
    </div>
}

const VouchersSection = ({ contentHeight }: { contentHeight: number }) => {

    const selectedTransactions = useAtomValue(bankRecSelectedTransactionsAtom)

    /* Rendered above every branch below, including the empty one, because convergence after a refusal
       can itself be what emptied the pane. */
    if (selectedTransactions.length === 0) {
        return <>
            <LastRefusalNotice />
            <Empty>
                <EmptyMedia>
                    <ReceiptIcon />
                </EmptyMedia>
                <EmptyHeader>
                    <EmptyTitle>{_("Select a transaction to match and reconcile with vouchers")}</EmptyTitle>
                </EmptyHeader>
            </Empty>
        </>
    }

    if (selectedTransactions.length > 1) {
        return <>
            <LastRefusalNotice />
            <OptionsForMultipleTransactions transactions={selectedTransactions} />
        </>
    }

    return <div style={{ minHeight: contentHeight }} className="mt-2">
        <LastRefusalNotice />
        <OptionsForSingleTransaction transaction={selectedTransactions[0]} />
    </div>
}

const useKeyboardShortcuts = () => {
    const setTransferModalOpen = useSetAtom(bankRecTransferModalAtom)
    const setRecordPaymentModalOpen = useSetAtom(bankRecRecordPaymentModalAtom)
    const setRecordJournalEntryModalOpen = useSetAtom(bankRecRecordJournalEntryModalAtom)

    useHotkeys('meta+p', () => {
        // 
        setRecordPaymentModalOpen(true)
    }, {
        enabled: true,
        enableOnFormTags: false,
        preventDefault: true
    })

    useHotkeys('meta+b', () => {
        // 
        setRecordJournalEntryModalOpen(true)
    }, {
        enabled: true,
        enableOnFormTags: false,
        preventDefault: true
    })

    useHotkeys('meta+i', () => {
        // 
        setTransferModalOpen(true)
    }, {
        enabled: true,
        enableOnFormTags: false,
        preventDefault: true
    })

    return {
        setTransferModalOpen,
        setRecordPaymentModalOpen,
        setRecordJournalEntryModalOpen
    }
}

const OptionsForMultipleTransactions = ({ transactions }: { transactions: UnreconciledTransaction[] }) => {

    const { setTransferModalOpen, setRecordPaymentModalOpen, setRecordJournalEntryModalOpen } = useKeyboardShortcuts()

    return <div className="flex flex-col py-4">
        <Card className="gap-2">
            <CardHeader>
                <CardTitle>
                    <div className="flex items-center justify-between">
                        <span className="text-md font-medium">{transactions.length} {_(transactions.length === 1 ? _("transaction selected") : _("transactions selected"))}</span>
                        <span className="text-md font-medium font-numeric">
                            {formatCurrency(transactions.reduce((acc, transaction) => acc + (transaction.unallocated_amount ?? 0), 0), transactions[0].currency ?? '')}
                        </span>
                    </div>
                </CardTitle>
            </CardHeader>
            <CardContent>
                <SelectedTransactionsTable />

                <CardAction className="mt-4 justify-self-center">
                    <div className="flex gap-3 justify-center">
                        <TooltipProvider>
                            <div className="flex gap-4 justify-center">
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            size='md'
                                            aria-label={_("Record a bank journal entry for expenses, income or split transactions")}
                                            onClick={() => setRecordJournalEntryModalOpen(true)}>
                                            <Landmark /> {_("Bank Entry")}
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        {_("Record a journal entry for expenses, income or split transactions")}
                                        <KbdGroup className="ms-2">
                                            <Kbd><KeyboardMetaKeyIcon /></Kbd>
                                            <Kbd>B</Kbd>
                                        </KbdGroup>
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant='outline'
                                            size='md'
                                            aria-label={_("Record a payment entry against a customer or supplier")}
                                            onClick={() => setRecordPaymentModalOpen(true)}>
                                            <Receipt /> {_("Record Payment")}
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        {_("Record a payment entry against a customer or supplier")}
                                        <KbdGroup className="ms-2">
                                            <Kbd><KeyboardMetaKeyIcon /></Kbd>
                                            <Kbd>P</Kbd>
                                        </KbdGroup>
                                    </TooltipContent>
                                </Tooltip>

                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant='outline'
                                            size='md'
                                            aria-label={_("Record an internal transfer to another bank/credit card/cash account")}
                                            onClick={() => setTransferModalOpen(true)}>
                                            <ArrowRightLeft /> {_("Transfer")}
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        {_("Record an internal transfer to another bank/credit card/cash account")}
                                        <KbdGroup className="ms-2">
                                            <Kbd><KeyboardMetaKeyIcon /></Kbd>
                                            <Kbd>I</Kbd>
                                        </KbdGroup>
                                    </TooltipContent>
                                </Tooltip>

                            </div>
                        </TooltipProvider>
                    </div>
                </CardAction>
            </CardContent>
        </Card>

    </div>
}


const OptionsForSingleTransaction = ({ transaction }: { transaction: UnreconciledTransaction }) => {

    const { setTransferModalOpen, setRecordPaymentModalOpen, setRecordJournalEntryModalOpen } = useKeyboardShortcuts()

    return <div className="flex flex-col gap-3">
        <TooltipProvider>
            <div className="flex items-center justify-between pt-2">
                <div className="flex gap-4 justify-center">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant='outline'
                                size='md'
                                aria-label={_("Record a payment entry against a customer or supplier")}
                                onClick={() => setRecordPaymentModalOpen(true)}>
                                <Receipt /> {_("Record Payment")}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {_("Record a payment entry against a customer or supplier")}
                            <KbdGroup className="ms-2">
                                <Kbd><KeyboardMetaKeyIcon /></Kbd>
                                <Kbd>P</Kbd>
                            </KbdGroup>
                        </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant='outline'
                                size='md'
                                aria-label={_("Record a bank journal entry for expenses, income or split transactions")}
                                onClick={() => setRecordJournalEntryModalOpen(true)}>
                                <Landmark /> {_("Bank Entry")}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {_("Record a journal entry for expenses, income or split transactions")}
                            <KbdGroup className="ms-2">
                                <Kbd><KeyboardMetaKeyIcon /></Kbd>
                                <Kbd>B</Kbd>
                            </KbdGroup>
                        </TooltipContent>
                    </Tooltip>
                    <Tooltip >
                        <TooltipTrigger asChild>
                            <Button
                                variant='outline'
                                size='md'
                                aria-label={_("Record an internal transfer to another bank/credit card/cash account")}
                                onClick={() => setTransferModalOpen(true)}>
                                <ArrowRightLeft /> {_("Transfer")}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            {_("Record an internal transfer to another bank/credit card/cash account")}
                            <KbdGroup className="ms-2">
                                <Kbd><KeyboardMetaKeyIcon /></Kbd>
                                <Kbd>I</Kbd>
                            </KbdGroup>
                        </TooltipContent>
                    </Tooltip>
                </div>
                <MatchFilters />
            </div>
        </TooltipProvider>
        {transaction.matched_transaction_rule && <RuleAction transaction={transaction} />}
        <VouchersForTransaction transaction={transaction} />
    </div>
}

const RuleAction = ({ transaction }: { transaction: UnreconciledTransaction }) => {

    const { data: rule } = useGetRuleForTransaction(transaction)
    const setTransferModalOpen = useSetAtom(bankRecTransferModalAtom)
    const setRecordPaymentModalOpen = useSetAtom(bankRecRecordPaymentModalAtom)
    const setRecordJournalEntryModalOpen = useSetAtom(bankRecRecordJournalEntryModalAtom)

    const getActionIcon = () => {
        if (!rule) return null
        switch (rule.classify_as) {
            case "Bank Entry":
                return <Landmark />
            case "Payment Entry":
                return <Receipt className="w-6 h-6" />
            case "Transfer":
                return <ArrowRightLeft />
            default:
                return <ZapIcon />
        }
    }

    const getActionStyles = () => {
        if (!rule) return {}
        switch (rule.classify_as) {
            case "Bank Entry":
                return {
                    border: "border-outline-blue-3",
                    bg: "bg-surface-blue-1/50",
                    text: "text-ink-blue-4",
                    theme: "blue",
                }
            case "Payment Entry":
                return {
                    border: "border-outline-green-3",
                    bg: "bg-surface-green-1/50",
                    text: "text-ink-green-4",
                    theme: "green",
                }
            case "Transfer":
                return {
                    border: "border-outline-violet-3",
                    bg: "bg-surface-violet-2/50",
                    text: "text-ink-violet-4",
                    theme: "violet",
                }
            default:
                return {
                    border: "border-outline-amber-3",
                    bg: "bg-surface-amber-1/50",
                    text: "text-ink-amber-4",
                    theme: "orange",
                }
        }
    }

    const handleActionClick = () => {
        if (!rule) return
        switch (rule.classify_as) {
            case "Bank Entry":
                setRecordJournalEntryModalOpen(true)
                break
            case "Payment Entry":
                setRecordPaymentModalOpen(true)
                break
            case "Transfer":
                setTransferModalOpen(true)
                break
        }
    }

    const getActionDescription = () => {
        if (!rule) return ""
        switch (rule.classify_as) {
            case "Bank Entry":
                return _("Create a journal entry for expenses, income or split transactions")
            case "Payment Entry":
                return _("Record a payment entry against a customer or supplier")
            case "Transfer":
                return _("Record an internal transfer to another bank/credit card/cash account")
            default:
                return _("Create a new entry based on the rule")
        }
    }

    useHotkeys('alt+r', () => {
        handleActionClick()
    }, {
        enabled: true,
        enableOnFormTags: false,
        preventDefault: true
    })

    const styles = getActionStyles()

    if (!rule) {
        return null
    }

    return (
        <Card className={`border ${styles.border} ${styles.bg} shadow-sm hover:shadow-md transition-all duration-200`}>
            <CardHeader className="pb-0">
                <CardTitle className="flex justify-between items-center gap-3">
                    <div className="flex items-center gap-3">
                        <div className={`px-2.5 rounded-lg ${styles.bg} ${styles.text}`}>
                            {getActionIcon()}
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <span className="font-semibold text-lg">{rule.rule_name}</span>
                            <span className="text-sm text-ink-gray-5 font-normal">
                                {rule.rule_description || _("Rule matched based on transaction description and other criteria.")}
                            </span>
                        </div>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <Badge size='lg'
                            theme={rule.classify_as === "Bank Entry" ? "blue" : rule.classify_as === "Payment Entry" ? "green" : rule.classify_as === "Transfer" ? "violet" : "orange"}>
                            {rule.classify_as}
                        </Badge>
                    </div>
                </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
                <div className="flex items-center justify-between p-2 bg-surface-white rounded-lg border border-outline-gray-1">
                    <div className="flex items-center gap-2">
                        <BadgeCheck className="w-4 h-4 text-ink-green-3" />
                        <span className="text-sm font-medium text-ink-gray-8">{_("Recommended Action")}</span>
                    </div>
                    <Badge variant="ghost" theme={styles.theme as "blue" | "green" | "violet" | "orange"}>
                        {_("Priority")} {rule.priority}
                    </Badge>
                </div>

                <div className="space-y-2">

                    {rule.account && (
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-ink-gray-8">{_("Account")}:</span>
                            <span className="text-sm">{rule.account}</span>
                        </div>
                    )}

                    {rule.party_type && rule.party && (
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-ink-gray-8">{_("Party")}:</span>
                            <span className="text-sm">{rule.party} ({_(rule.party_type)})</span>
                        </div>
                    )}
                </div>

                <div className="pt-1">
                    <Button
                        onClick={handleActionClick}
                        className={`w-full`}
                        theme={styles.theme as "blue" | "green" | "violet"}
                        size="md"
                    >
                        {getActionIcon()}
                        <span>{_("Create")} {rule.classify_as}</span>
                    </Button>
                    <p className="text-sm text-ink-gray-5 mt-2 text-center leading-relaxed">
                        {getActionDescription()}
                    </p>
                </div>
            </CardContent>
        </Card>
    )
}

const VouchersForTransaction = ({ transaction }: { transaction: UnreconciledTransaction }) => {

    const { data: vouchers, isLoading, error } = useGetVouchersForTransaction(transaction)

    const voucherList = vouchers?.message ?? []

    /* Sized from the candidate list's own position, for the same reason the transaction list is: the rule
     * card and the action row above it vary in height with both the data and the viewport. */
    const [listRef, listHeight] = useAvailableHeight({ min: 240, gutter: 24 })

    if (error) {
        return <ErrorBanner error={error} />
    }

    if (isLoading) {
        return <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm text-ink-gray-5">
                <Separator className="flex-1" />
                <span>or</span>
                <Separator className="flex-1" />
            </div>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
        </div>
    }

    return <div className="relative space-y-2">
        <div className="flex items-center gap-2 text-sm text-ink-gray-5">
            <Separator className="flex-1" />
            <span>or</span>
            <Separator className="flex-1" />
        </div>
        {voucherList.length === 0 && <Empty className="my-4">
            <EmptyMedia>
                <ReceiptIcon />
            </EmptyMedia>
            <EmptyHeader>

                <EmptyTitle>{_("No vouchers found for this transaction")}</EmptyTitle>
            </EmptyHeader>
        </Empty>}
        <div ref={listRef}>
            <VirtualizedListBody
                items={voucherList}
                height={listHeight}
                estimateSize={121}
                getItemKey={(voucher) => voucher.name}
            >
                {(voucher, index) => <VoucherItem voucher={voucher} index={index} />}
            </VirtualizedListBody>
        </div>
    </div >
}

const VoucherItem = ({ voucher, index }: { voucher: LinkedPayment, index: number }) => {

    const selectedTransaction = useAtomValue(bankRecSelectedTransactionsAtom)

    const { amountMatches, postingDateMatches, referenceDateMatches, referenceMatchesFull, referenceMatchesPartial, isSuggested } = useMemo(() => {

        const transaction = selectedTransaction?.[0]

        // We need to check if the following details match:
        // Amount
        // Date
        // Reference/Description: Full or partial
        // Whether this is suggested or not - depends on the above scores

        const amountMatches = voucher.paid_amount === transaction?.unallocated_amount
        const postingDateMatches = voucher.posting_date === transaction?.date
        const referenceDateMatches = voucher.reference_date === transaction?.date
        const referenceMatchesFull = voucher.reference_no === transaction?.reference_number || voucher.reference_no === transaction?.description

        const referenceMatchesPartial = transaction?.reference_number?.includes(voucher.reference_no) || transaction?.description?.includes(voucher.reference_no)


        const isSuggested = amountMatches && (postingDateMatches || referenceDateMatches || referenceMatchesPartial) && index === 0

        return { isSelected: false, amountMatches, postingDateMatches, referenceDateMatches, referenceMatchesFull, referenceMatchesPartial, isSuggested: isSuggested }

    }, [voucher, selectedTransaction, index])

    const { reconcileTransaction, loading } = useReconcileTransaction()

    /*
     * The already-reconciled guard mirrors the server's own predicate rather than inventing one:
     * `add_payment_entries` refuses when `unallocated_amount <= 0`, and `set_status` derives the status
     * field from that same quantity, so the two signals agree. Both arrive in the
     * `get_bank_transactions` payload, so the guard needs no extra read.
     *
     * It is a UX affordance only - the server check stays authoritative, and an attempt that slips
     * through a stale client surfaces the server's own throw in the shared dialog.
     */
    const transactionUnderReview = selectedTransaction?.[0]
    const isAlreadyReconciled = transactionUnderReview
        ? transactionUnderReview.status === 'Reconciled' || (transactionUnderReview.unallocated_amount ?? 0) <= 0
        : false

    const onClick = () => {
        if (!selectedTransaction) {
            return
        }
        reconcileTransaction(selectedTransaction[0], voucher)
    }

    const reconcileButton = <Button
        variant={isSuggested || amountMatches ? "solid" : "outline"}
        theme={isSuggested || amountMatches ? "green" : "gray"}
        onClick={onClick} disabled={loading || isAlreadyReconciled}>{loading ? <><Loader2 className="w-4 h-4 animate-spin" /> {_("Reconciling")}...</> : `${_("Reconcile")}`}</Button>

    return <div className="py-1 px-1">
        <div
            className={cn("border outline overflow-hidden relative rounded-md p-2",
                isSuggested ? "border-outline-green-4 bg-surface-green-1/40 outline-outline-green-4" : "border-outline-gray-2 outline-transparent"
            )}
        >

            <div className="flex justify-between items-end gap-2">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <Badge size='md'>{_(voucher.doctype)}</Badge>
                        <a target="_blank"
                            href={`/desk/${slug(voucher.doctype)}/${voucher.name}`}
                            className="underline underline-offset-2 text-base"
                        >{voucher.name}</a>
                    </div>
                    {voucher.party && voucher.party_type && <div className="flex items-center gap-1.5 text-base">
                        <User size='18px' />
                        <span>{_(voucher.party_type)}</span>
                        <a target="_blank"
                            href={`/desk/${slug(voucher.party_type)}/${voucher.party}`}
                            className="underline underline-offset-2"
                        >{voucher.party}</a>
                    </div>}
                    <TooltipProvider>
                        <div className="flex items-start gap-8 py-0.5">
                            <div className="flex flex-col gap-1 min-w-24">
                                <div className="text-xs text-ink-gray-6">{_("Amount")}</div>
                                <div className="text-base font-medium flex items-center gap-1">{formatCurrency(voucher.paid_amount, voucher.currency)} {amountMatches ? <MatchBadge matchType="full" label={_("Amount matches the selected transaction")} /> : <MatchBadge matchType="none" label={_("Amount does not match the selected transaction")} />}</div>
                            </div>

                            <div className="flex flex-col gap-1 min-w-24">
                                <div className="text-xs text-ink-gray-6">{_("Posted On")}</div>
                                <div className="text-base font-medium flex items-center gap-1">{formatDate(voucher.posting_date)} {postingDateMatches ? <MatchBadge matchType="full" label={_("Posting date matches the selected transaction")} /> : <MatchBadge matchType="none" label={_("Posting date does not match the selected transaction")} />}</div>
                            </div>

                            {voucher.reference_date && <div className="flex flex-col gap-1 min-w-24">
                                <div className="text-xs text-ink-gray-6">{_("Reference Date")}</div>
                                <div className="text-base font-medium flex items-center gap-1">{formatDate(voucher.reference_date)} {referenceDateMatches ? <MatchBadge matchType="full" label={_("Reference date matches the selected transaction")} /> : <MatchBadge matchType="none" label={_("Reference date does not match the selected transaction")} />}</div>
                            </div>}

                        </div>
                        {voucher.reference_no && <div className="flex items-start gap-1">
                            <span className="text-p-base">
                                {voucher.reference_no}
                                &nbsp;&nbsp;
                                <Tooltip>
                                    <TooltipTrigger>
                                        <Badge theme={referenceMatchesFull ? "green" : referenceMatchesPartial ? "orange" : "red"} variant={referenceMatchesFull || referenceMatchesPartial ? "subtle" : "outline"}>
                                            {referenceMatchesFull ? `${_("Complete Match")}` : referenceMatchesPartial ? `${_("Partial Match")}` : `${_("No Match")}`}</Badge>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                        {referenceMatchesFull ? `${_("Reference matches the selected transaction")}` : referenceMatchesPartial ? `${_("Reference matches the selected transaction partially")}` : `${_("Reference does not match the selected transaction")}`}
                                    </TooltipContent>
                                </Tooltip>
                            </span>
                        </div>}
                    </TooltipProvider>
                </div>
                <div>
                    {/* A disabled control emits no pointer or focus events, so the reason is anchored to a
                        focusable wrapper span rather than to the Button, keeping it discoverable by mouse
                        and keyboard alike. The provider that wraps the match badges above has already
                        closed, so this subtree needs its own. */}
                    {isAlreadyReconciled
                        ? <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span tabIndex={0} className="inline-flex rounded outline-none focus-visible:shadow-focus-gray">{reconcileButton}</span>
                                </TooltipTrigger>
                                <TooltipContent side="top" align="end" className="max-w-sm text-balance wrap-break-word">
                                    {_("This bank transaction is already fully reconciled, so it cannot be reconciled again.")}
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                        : reconcileButton}
                </div>
            </div>

            {isSuggested && <div className="absolute top-1.5 end-2 flex items-center gap-1 justify-center">
                <Badge theme="green" variant="subtle" size='md'>{_("Suggested")}</Badge>
            </div>}

        </div>
    </div>
}


const MatchBadge = ({ matchType, label }: { matchType: 'full' | 'partial' | 'none', label: string }) => {
    return <Tooltip>
        <TooltipTrigger>
            {matchType === 'full' ? <BadgeCheck className="text-ink-white fill-surface-green-5 size-4" /> : matchType === 'partial' ?
                <Badge theme="orange" variant="subtle">{_("Partial Match")}</Badge> :
                <XCircle className="text-ink-red-4 size-4" />}
        </TooltipTrigger>
        <TooltipContent>
            {label}
        </TooltipContent>
    </Tooltip>
}

const OlderUnreconciledTransactionsBanner = () => {

    // A banner to show when there are unreconciled transactions for the given bank account before the current selected date
    const [dates, setDates] = useAtom(bankRecDateAtom)
    const selectedBank = useAtomValue(selectedBankAccountAtom)

    const { data } = useFrappeGetCall<{
        message: {
            count: number,
            oldest_date: string
        }
    }>("erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_older_unreconciled_transactions", {
        bank_account: selectedBank?.name,
        from_date: dates.fromDate,
    }, undefined, {
        revalidateOnFocus: false,
    })

    if (data && data.message.count > 0) {

        return <Alert theme='gray' variant='subtle'>
            <AlertCircleIcon />
            <div className="flex justify-between items-center gap-1.5">
                <div>
                    <AlertTitle> {data.message.count > 1 ? (
                        <span>{_("There are {0} unreconciled transactions before {1}.", [data.message.count.toString(), formatDate(dates.fromDate)])}</span>
                    ) : (
                        <span>{_("There is one unreconciled transaction before {0}.", [formatDate(dates.fromDate)])}</span>
                    )}</AlertTitle>
                    <AlertDescription className="flex justify-between text-balance">
                        {_("The opening balance might not match your bank statement. Would you like to reconcile them?")}
                    </AlertDescription>
                </div>
                <div>
                    <Button
                        size='sm'
                        type='button'
                        theme='gray'
                        variant='outline'
                        onClick={() => setDates({ fromDate: data.message.oldest_date, toDate: dates.toDate })}>
                        <span>{data.message.count > 1 ? _("View older transactions") : _("View older transaction")}</span>
                        <ArrowRightIcon />
                    </Button>
                </div>
            </div>
        </Alert>
    }

    return null

}

export default MatchAndReconcile