import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { bankRecAmountFilter, bankRecDateAtom, bankRecRecordJournalEntryModalAtom, bankRecRecordPaymentModalAtom, bankRecSelectedTransactionAtom, bankRecTransactionTypeFilter, bankRecTransferModalAtom, selectedBankAccountAtom } from "./bankRecAtoms"
import { H4 } from "@/components/ui/typography"
import { useId, useMemo, useRef } from "react"
import { getCompanyCurrency } from "@/lib/company"
import ErrorBanner from "@/components/ui/error-banner"
import { Separator } from "@/components/ui/separator"
import Fuse from 'fuse.js'
import { getSearchResults, LinkedPayment, UnreconciledTransaction, useGetRuleForTransaction, useGetUnreconciledTransactions, useGetVouchersForTransaction, useIsTransactionWithdrawal, useReconcileTransaction, useSelectedBankAccountCurrency, useTransactionSearch } from "./utils"
import { Input } from "@/components/ui/input"
import { AlertCircleIcon, ArrowDownRight, ArrowRightIcon, ArrowRightLeft, ArrowUpRight, BadgeCheck, ChevronDown, DollarSign, Landmark, LandmarkIcon, ListIcon, Loader2, Receipt, ReceiptIcon, Search, User, XCircle, ZapIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import CurrencyInput from 'react-currency-input-field'
import { getCurrencySymbol } from "@/lib/currency"
import { useVirtualizer } from '@tanstack/react-virtual'
import { formatDate } from "@/lib/date"
import { Badge } from "@/components/ui/badge"
import { formatCurrency, getCurrencyFormatInfo } from "@/lib/numbers"
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
        <div className={`flex items-start space-x-2`} >
            <div className="flex-1">
                <H4 className="text-sm font-medium">{_("Unreconciled Transactions")}</H4>
                <UnreconciledTransactions contentHeight={contentHeight} />
            </div>
            <Separator orientation="vertical" style={{ minHeight: `${contentHeight}px` }} />
            <div className="flex-1 px-1">
                <H4 className="text-sm font-medium">{_("Match or Create")}</H4>
                <VouchersSection contentHeight={contentHeight} />
            </div>
        </div>
        <TransferModal />
        <BankEntryModal />
        <RecordPaymentModal />
        {/* FM1/FM3: the dismissible dialog that reports a refused confirm/post. Mounted here beside
            the three existing feature-level modals, following the same atom-driven convention - it
            renders nothing until the shared error atom holds a rejection. The statement importer
            surfaces mount the same component against the same atom, because they live in a different
            route tree. */}
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

const UnreconciledTransactions = ({ contentHeight }: { contentHeight: number }) => {
    const bankAccount = useAtomValue(selectedBankAccountAtom)

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

    const setSelectedTransaction = useSetAtom(bankRecSelectedTransactionAtom(bankAccount?.name || ''))

    const onFilterChange = () => {
        setSelectedTransaction([])
    }

    const onSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setSearch(e.target.value)
        onFilterChange()
    }

    const onTypeFilterChange = (type: string) => {
        setTypeFilter(type)
        onFilterChange()
    }

    const onClearFilters = () => {
        setSearch('')
        if (inputRef.current) {
            inputRef.current.value = ''
        }
        setTypeFilter('All')
        setAmountFilter({ value: 0, stringValue: '' })
        onFilterChange()
    }

    const hasFilters = search !== '' || typeFilter !== 'All' || amountFilter.value !== 0
    const listHeight = contentHeight - 72

    if (isLoading) {
        return <UnreconciledTransactionsLoadingState />
    }

    return <div className="space-y-1">
        <div className="flex py-2 w-full gap-2">

            <InputGroup variant='outline'>
                <label className="sr-only">{_("Search transactions")}</label>
                <InputGroupAddon>
                    <Search className="w-4 h-4 text-ink-gray-5" />
                </InputGroupAddon>
                <Input
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
                <label className="sr-only">{_("Filter by amount")}</label>
                <CurrencyInput
                    groupSeparator={groupSeparator}
                    decimalSeparator={decimalSeparator}
                    placeholder={`${currencySymbol}0${decimalSeparator}00`}
                    decimalsLimit={2}
                    value={amountFilter.stringValue}
                    maxLength={12}
                    decimalScale={2}
                    prefix={currencySymbol}
                    onValueChange={(v, _n, values) => {
                        // If the input ends with a decimal or a decimal with trailing zeroes, store the string since we need the user to be able to type the decimals.
                        // When the user eventually types the decimals or blurs out, the value is formatted anyway.
                        // Otherwise store the float value
                        // Check if the value ends with a decimal or a decimal with trailing zeroes
                        const isDecimal = v?.endsWith(decimalSeparator) || v?.endsWith(decimalSeparator + '0')
                        const newValue = isDecimal ? v : values?.float ?? ''
                        const nextAmountFilter = {
                            value: Number(newValue),
                            stringValue: newValue
                        }
                        const hasAmountFilterChanged = amountFilter.value !== nextAmountFilter.value || amountFilter.stringValue !== nextAmountFilter.stringValue

                        setAmountFilter(nextAmountFilter)

                        // `onValueChange` also fires on blur; avoid clearing selected transaction unless filter value actually changed.
                        if (hasAmountFilterChanged) {
                            onFilterChange()
                        }
                    }}
                    // @ts-expect-error - CurrencyInputProps doesn't have a variant prop but Input does
                    variant={"outline"}
                    customInput={Input}
                />
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
        </div>

        {error && <ErrorBanner error={error} />}

        <OlderUnreconciledTransactionsBanner />

        {results.length === 0 && <NoTransactionsFoundBanner
            onClearFilters={hasFilters ? onClearFilters : undefined}
            text={hasFilters ? _("No transactions found for the given filters.") : _("No unreconciled transactions found")}
            description={hasFilters ? _("Try adjusting your search or filter criteria.") : _("Import your bank statement to get started.")} />}

        <VirtualizedListBody
            items={results}
            height={listHeight}
            estimateSize={74}
            getItemKey={(transaction) => transaction.name}
        >
            {(transaction) => <UnreconciledTransactionItem transaction={transaction} />}
        </VirtualizedListBody>

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

const UnreconciledTransactionItem = ({ transaction }: { transaction: UnreconciledTransaction }) => {

    const selectedBank = useAtomValue(selectedBankAccountAtom)

    const [selectedTransaction, setSelectedTransaction] = useAtom(bankRecSelectedTransactionAtom(selectedBank?.name || ''))

    const { amount, isWithdrawal } = useIsTransactionWithdrawal(transaction)

    const isSelected = selectedTransaction?.some((t) => t.name === transaction.name)

    /*
     * FM5, and the ONE authoritative currency value this row uses for BOTH purposes.
     *
     * `useSelectedBankAccountCurrency` reads the live `bank_account.get_list` response. Everything
     * here resolves through it - the mismatch comparison AND the fallback used to format the amount -
     * because those two must not be able to disagree. They previously could: the comparison read the
     * live value while the formatting fell back to `selectedBank.account_currency`, the persisted
     * localStorage snapshot, so a row could simultaneously be told "these currencies match" and be
     * rendered under a stale symbol. `useGetBankAccounts` now rehydrates that snapshot from the same
     * response, and reading the live value here as well removes the second source outright.
     *
     * `selectedBank?.account_currency` is kept as the NEXT fallback rather than deleted: it is the only
     * value available in the first render after a cold start, before the list has answered, and a
     * momentarily stale symbol is better than none. The company default remains the last resort.
     *
     * Either side of the COMPARISON may legitimately be unknown - `currency` is optional on the
     * transaction, and the hook returns `undefined` while the list is loading, after a failed read, or
     * when the selected account is absent from it. Unknown means "nothing to compare", never
     * "mismatch": a warning that is wrong in either direction is worse than no warning.
     */
    const accountCurrency = useSelectedBankAccountCurrency()

    const currency = transaction.currency ?? accountCurrency ?? selectedBank?.account_currency ?? getCompanyCurrency(selectedBank?.company ?? '')

    const isCurrencyMismatch = Boolean(transaction.currency && accountCurrency && transaction.currency !== accountCurrency)

    /*
     * The advisory is authored once and consumed twice - as the badge's tooltip for pointer users and
     * as the row's own accessible description for keyboard and screen-reader users - so the two can
     * never drift apart.
     *
     * The copy states ONLY what this client has observed: the two currency codes differ, and this
     * indicator does not stop the reconciliation. It makes no claim about what the server will do with
     * the mismatch, because the server does not in fact check it on this path - `validate_currency` is
     * invoked from `validate()`, and `reconcile_vouchers` saves a document that is already submitted,
     * which Frappe routes through `update_after_submit`, so `validate()` never runs. Telling the
     * reviewer their currencies would be "validated" would be describing a check that does not happen
     * here. FM5 leaves the backend the authority on the outcome; where the backend asserts nothing,
     * this indicator asserts nothing on its behalf.
     */
    const currencyAdvisoryId = useId()
    const currencyAdvisory = isCurrencyMismatch
        ? _("Transaction currency {0} differs from the bank account currency {1}. This is an advisory check made here only and does not block the reconciliation - review the match before confirming.", [transaction.currency ?? '', accountCurrency ?? ''])
        : ''

    const handleSelectTransaction = (event: React.MouseEvent<HTMLDivElement>) => {
        // If the user is pressing the shift key, add/remove the transaction from the selected transactions
        if (event.shiftKey) {
            setSelectedTransaction(isSelected ? selectedTransaction.filter((t) => t.name !== transaction.name) : [...selectedTransaction, transaction])
        } else {
            setSelectedTransaction([transaction])
        }
    }

    return <div className="py-1">
        <div className={cn("border outline rounded-md p-2 mx-0.5 cursor-pointer transition-[color,box-shadow, bg] hover:bg-surface-gray-1",
            isSelected ? "bg-surface-gray-1 border-outline-gray-5 outline-outline-gray-5" : "border-outline-gray-2 outline-none"
        )}
            role='button'
            tabIndex={0}
            // The row is the ONLY interactive element here, so the currency advisory is attached as
            // the row's own description rather than to a second control inside it. Focusing or
            // reading the row therefore announces the reason, with no extra tab stop to traverse.
            aria-describedby={isCurrencyMismatch ? currencyAdvisoryId : undefined}
            onClick={handleSelectTransaction}>
            <div className="flex justify-between items-start w-full">
                <div className="space-y-1 overflow-hidden whitespace-pre-wrap">
                    <div className="flex items-center gap-1">
                        <span className="font-medium text-sm">{formatDate(transaction.date)}</span>
                        {transaction.transaction_type &&
                            <Badge theme="blue">{transaction.transaction_type}</Badge>}
                        {transaction.reference_number && <Badge
                            title={transaction.reference_number}
                            className="max-w-[300px] text-ellipsis"
                        >
                            {_("Ref")}: {transaction.reference_number}</Badge>}

                        {transaction.matched_transaction_rule && <Badge
                            theme="violet"
                            title={_("Matched by rule")}>
                            <ZapIcon className="w-4 h-4" /> {transaction.matched_transaction_rule}</Badge>}

                        {/* Advisory only: Reconcile is deliberately left enabled, because the server -
                            not this badge - decides whether a post is allowed. `theme="orange"` is used
                            because Badge declares no `amber` theme, and `subtle` + `orange` is what
                            resolves to the amber tokens this warning calls for.

                            `TooltipTrigger asChild` is REQUIRED, not stylistic. This row is itself a
                            focusable `role="button"`, and a bare TooltipTrigger renders its own native
                            <button>, which would nest an interactive control inside an interactive
                            control and add a second tab stop to every mismatched row. `asChild` makes
                            the Badge - a plain <span> - the trigger, so the indicator stays
                            non-interactive; the same pattern is used for the reconcile button's tooltip
                            further down this file. Because a <span> cannot take focus, the tooltip alone
                            would be hover-only, so the advisory is ALSO published as the `sr-only`
                            description the row points at with `aria-describedby` - one shared string, so
                            the two can never disagree.

                            The LOCAL TooltipProvider matches every other tooltip in this file (see the
                            transaction-actions cluster, the keyboard-shortcut row and the voucher card
                            below): each subtree stays independently mountable instead of depending on
                            App.tsx happening to wrap the router in a provider. */}
                        {isCurrencyMismatch && <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Badge variant="subtle" theme="orange" size="sm">
                                        <AlertCircleIcon /> {transaction.currency}</Badge>
                                </TooltipTrigger>
                                {/* TooltipContent is `w-fit` with no intrinsic maximum, so this two-sentence
                                    advisory would lay out as a single very long line that Radix then clamps
                                    flush against the viewport edge. `max-w-sm` with balanced wrapping is the
                                    constraint the design system already uses for long tooltip copy (see
                                    ui/list-view.tsx). */}
                                <TooltipContent side="top" className="max-w-sm text-balance wrap-break-word">
                                    {currencyAdvisory}
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>}
                    </div>
                    <span className="text-sm wrap-anywhere" title={transaction.description}>{transaction.description}</span>
                </div>
                <div className="gap-1 flex flex-col items-end min-w-36 h-full text-end">
                    {isWithdrawal ? <ArrowUpRight className="size-5 text-ink-red-3" /> : <ArrowDownRight className="size-5 text-ink-green-3" />}
                    {amount && amount > 0 && <span className="font-semibold font-numeric text-base">{formatCurrency(amount, currency)}</span>}
                    {amount !== transaction.unallocated_amount && <span className="text-xs leading-normal text-ink-gray-5">{formatCurrency(transaction.unallocated_amount, currency)} {_("Unallocated")}</span>}
                </div>
            </div>
        </div>
        {/* The advisory text the row points at. It sits OUTSIDE the row element on purpose: a
            description nested inside the row would also be walked when the row's accessible NAME is
            computed from its contents, so the same sentence would be announced twice. `sr-only` is the
            utility this codebase already uses for text meant only for assistive technology (see the
            search and amount-filter labels above), and it leaves the visual row unchanged. */}
        {isCurrencyMismatch && <span id={currencyAdvisoryId} className="sr-only">{currencyAdvisory}</span>}
    </div>
}


const VouchersSection = ({ contentHeight }: { contentHeight: number }) => {

    const selectedBank = useAtomValue(selectedBankAccountAtom)
    const selectedTransactions = useAtomValue(bankRecSelectedTransactionAtom(selectedBank?.name || ''))


    if (selectedTransactions.length === 0) {
        return <Empty>
            <EmptyMedia>
                <ReceiptIcon />
            </EmptyMedia>
            <EmptyHeader>
                <EmptyTitle>{_("Select a transaction to match and reconcile with vouchers")}</EmptyTitle>
            </EmptyHeader>
        </Empty>
    }

    if (selectedTransactions.length > 1) {
        return <OptionsForMultipleTransactions transactions={selectedTransactions} />
    }

    return <div style={{ minHeight: contentHeight }} className="mt-2">
        <OptionsForSingleTransaction transaction={selectedTransactions[0]} contentHeight={contentHeight} />
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


const OptionsForSingleTransaction = ({ transaction, contentHeight }: { transaction: UnreconciledTransaction, contentHeight: number }) => {

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
        <VouchersForTransaction transaction={transaction} contentHeight={contentHeight} />
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

const VouchersForTransaction = ({ transaction, contentHeight }: { transaction: UnreconciledTransaction, contentHeight: number }) => {

    const { data: vouchers, isLoading, error } = useGetVouchersForTransaction(transaction)

    const voucherList = vouchers?.message ?? []
    const listHeight = contentHeight - 120

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
        <VirtualizedListBody
            items={voucherList}
            height={listHeight}
            estimateSize={121}
            getItemKey={(voucher) => voucher.name}
        >
            {(voucher, index) => <VoucherItem voucher={voucher} index={index} />}
        </VirtualizedListBody>
    </div >
}

const VoucherItem = ({ voucher, index }: { voucher: LinkedPayment, index: number }) => {

    const selectedBank = useAtomValue(selectedBankAccountAtom)
    const selectedTransaction = useAtomValue(bankRecSelectedTransactionAtom(selectedBank?.name || ''))

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

        /*
         * A BLANK REFERENCE CANNOT MATCH ANYTHING, and both tests below depend on saying so
         * explicitly.
         *
         * `reference_no` is genuinely absent for whole classes of candidate: the Purchase Invoice
         * branch of `get_linked_payments` projects a constant empty string, and the Bank Transaction,
         * Payment Entry, Journal Entry and Sales Invoice branches all project a nullable column. Left
         * unguarded, `''.includes()` semantics made every such candidate a PARTIAL reference match
         * against any transaction, because every string contains the empty string - so a candidate
         * with no reference at all, sitting first in the list with a matching amount, was promoted to
         * "Suggested" and given the solid green treatment on a financial posting screen. The full test
         * had the mirror-image flaw: two absent references compared equal to each other.
         *
         * Trimmed before the test, because a reference of spaces carries no more information than one
         * that is missing.
         */
        const voucherReference = voucher.reference_no?.trim() ?? ''
        const hasVoucherReference = voucherReference !== ''

        const referenceMatchesFull = hasVoucherReference &&
            (voucherReference === transaction?.reference_number || voucherReference === transaction?.description)

        const referenceMatchesPartial = hasVoucherReference &&
            Boolean(transaction?.reference_number?.includes(voucherReference) || transaction?.description?.includes(voucherReference))


        const isSuggested = amountMatches && (postingDateMatches || referenceDateMatches || referenceMatchesPartial) && index === 0

        return { isSelected: false, amountMatches, postingDateMatches, referenceDateMatches, referenceMatchesFull, referenceMatchesPartial, isSuggested: isSuggested }

    }, [voucher, selectedTransaction, index])

    const { reconcileTransaction, loading, isReconcileInFlight } = useReconcileTransaction()

    /*
     * FM3: the already-reconciled guard, mirroring the server's own predicate rather than inventing
     * one. `add_payment_entries` refuses outright when `unallocated_amount <= 0`, and `set_status`
     * derives the status field from that same quantity - `> 0` is Unreconciled, `<= 0` is
     * Reconciled - so the two signals are strictly co-derived and both already arrive in the
     * `get_bank_transactions` payload. No extra read and no backend change are needed.
     *
     * The server stays the authority; this only stops the affordance offering an action that cannot
     * succeed. The case it exists for is the STALE CLIENT, and that case is real rather than
     * theoretical: `useGetUnreconciledTransactions` revalidates neither on focus nor when stale, and
     * the selection itself is persisted, so this surface can be holding a row the server has since
     * settled - either because the list was fetched before the reconciliation or because a stored
     * selection outlived it.
     *
     * It is NOT reachable from the unfiltered "Bank Transactions" tab, contrary to what this comment
     * used to claim: that tab is `BankTransactionList`, which renders no Reconcile control at all, and
     * the endpoint behind THIS surface filters `unallocated_amount > 0` server-side.
     *
     * Read off the SELECTION, which the reconcile hook empties on rejection - so a refused attempt
     * withdraws this control rather than leaving it pointed at a snapshot the server has contradicted.
     */
    const transactionUnderReview = selectedTransaction?.[0]
    const isAlreadyReconciled = transactionUnderReview
        ? transactionUnderReview.status === 'Reconciled' || (transactionUnderReview.unallocated_amount ?? 0) <= 0
        : false

    /*
     * Guards on the ROW, not on the array. The previous test was `!selectedTransaction`, which an
     * array satisfies whether or not it is empty, so an empty selection posted
     * `bank_transaction_name: undefined`. That is now reachable state rather than a theoretical one:
     * the rejection path empties the selection deliberately.
     */
    const onClick = () => {
        if (!transactionUnderReview) {
            return
        }
        reconcileTransaction(transactionUnderReview, voucher)
    }

    /*
     * FM1/TC6: disabled while ANY reconcile post is open, not merely while THIS row's is.
     *
     * `loading` belongs to this row's own hook instance, and every candidate row instantiates the hook
     * for itself - so a control gated on `loading` alone stayed live while a SIBLING row's post was
     * unanswered, and a reviewer could dispatch a second `reconcile_vouchers` for the same transaction
     * before the first had returned. `isReconcileInFlight` is shared state, so one open post closes
     * every candidate at once. The spinner still follows `loading`, so only the row that started the
     * request says "Reconciling" - the others simply become unavailable, which is what the reviewer
     * needs to be told.
     */
    const reconcileButton = <Button
        variant={isSuggested || amountMatches ? "solid" : "outline"}
        theme={isSuggested || amountMatches ? "green" : "gray"}
        onClick={onClick} disabled={loading || isReconcileInFlight || isAlreadyReconciled}>{loading ? <><Loader2 className="w-4 h-4 animate-spin" /> {_("Reconciling")}...</> : `${_("Reconcile")}`}</Button>

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
                                {/* `?? undefined` collapses the endpoint's literal null onto the parameter's
                                    own default, which `formatCurrency` then resolves to the system currency -
                                    the same value a null produced before the type admitted one. Coercion
                                    belongs here, at the presentation boundary, and not where the reconcile
                                    hook copies the reference onto the action log: there the null is the
                                    server's statement that no reference exists and has to survive. */}
                                <div className="text-base font-medium flex items-center gap-1">{formatCurrency(voucher.paid_amount, voucher.currency ?? undefined)} {amountMatches ? <MatchBadge matchType="full" label={_("Amount matches the selected transaction")} /> : <MatchBadge matchType="none" label={_("Amount does not match the selected transaction")} />}</div>
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
                        and keyboard alike. The Tooltip is mounted only when the guard fires, so the
                        enabled path never stamps an `aria-describedby` pointing at content that is not
                        rendered. Wrapped in its own TooltipProvider, matching every other tooltip in this
                        file. */}
                    {isAlreadyReconciled
                        ? <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span tabIndex={0} className="inline-flex rounded outline-none focus-visible:shadow-focus-gray">{reconcileButton}</span>
                                </TooltipTrigger>
                                {/* End-aligned so the tooltip stays inside the page gutter at the far right of
                                    the voucher card. */}
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
            // REQUIRED and NULLABLE: `get_older_unreconciled_transactions` returns
            // `{"count": 0, "oldest_date": None}` when nothing is older, so the key is always present
            // and `null` is a value it really carries. It was typed `string`, which promised callers a
            // date that need not exist - and the jump control below consumed it unguarded.
            oldest_date: string | null
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
                {/* The jump control is rendered only when the server actually named a date. `count > 0`
                    and a non-null `oldest_date` normally arrive together, but they are two separate
                    fields on one payload and this control writes the date straight into the shared date
                    range: without the guard a `null` would be persisted as `fromDate`, and every query
                    keyed on that range - transactions, both balances, the candidate lists - would be
                    re-issued with a null boundary. The banner's own text stands on `count` alone, so the
                    reviewer is still told what exists either way. */}
                {data.message.oldest_date && <div>
                    <Button
                        size='sm'
                        type='button'
                        theme='gray'
                        variant='outline'
                        onClick={() => setDates({ fromDate: data.message.oldest_date as string, toDate: dates.toDate })}>
                        <span>{data.message.count > 1 ? _("View older transactions") : _("View older transaction")}</span>
                        <ArrowRightIcon />
                    </Button>
                </div>}
            </div>
        </Alert>
    }

    return null

}

export default MatchAndReconcile