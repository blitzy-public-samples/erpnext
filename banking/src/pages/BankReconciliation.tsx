import BankBalance from "@/components/features/BankReconciliation/BankBalance"
import BankPicker from "@/components/features/BankReconciliation/BankPicker"
import BankRecDateFilter from "@/components/features/BankReconciliation/BankRecDateFilter"
import BankTransactionUnreconcileModal from "@/components/features/BankReconciliation/BankTransactionUnreconcileModal"
import CompanySelector from "@/components/features/BankReconciliation/CompanySelector"
import MatchAndReconcile from "@/components/features/BankReconciliation/MatchAndReconcile"
import Settings from "@/components/features/Settings/Settings"
import ActionLog from "@/components/features/ActionLog/ActionLog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import _ from "@/lib/translate"
import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react"
import { AlertTriangleIcon, CheckCircleIcon, HomeIcon, ImportIcon, LandmarkIcon, ListIcon, Loader2Icon, ScrollTextIcon, ShuffleIcon } from "lucide-react"
import { Link } from "react-router"
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Button } from "@/components/ui/button"
import { useAtomValue } from "jotai"
import { selectedBankAccountAtom } from "@/components/features/BankReconciliation/bankRecAtoms"

const BankReconciliationStatement = lazy(() => import('@/components/features/BankReconciliation/BankReconciliationStatement'))
const BankTransactions = lazy(() => import('@/components/features/BankReconciliation/BankTransactionList'))
const BankClearanceSummary = lazy(() => import('@/components/features/BankReconciliation/BankClearanceSummary'))
const IncorrectlyClearedEntries = lazy(() => import('@/components/features/BankReconciliation/IncorrectlyClearedEntries'))

/** Chrome between the header's bottom edge and the top of a tab's content: the tab strip and its gaps. */
const TAB_CHROME_HEIGHT = 74

/** Never hand the panels a height so small that a virtualised list renders no rows. */
const MIN_TAB_CONTENT_HEIGHT = 280

const BankReconciliation = () => {

    /*
     * The header is measured for real, and re-measured whenever it changes size or the window does.
     *
     * A single `useLayoutEffect(…, [])` read used to be taken here, which was wrong twice over: it ran
     * before the account picker and balance tiles had data (so it understated the header by more than
     * 100px), and nothing re-ran it, so resizing the window left every panel sized for the previous
     * viewport. Both errors pushed panel content below the fold.
     */
    const [headerHeight, setHeaderHeight] = useState(0)
    const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)

    const ref = useRef<HTMLDivElement>(null)

    useLayoutEffect(() => {
        const header = ref.current
        if (!header) {
            return
        }

        const measure = () => {
            setHeaderHeight((previous) => {
                const next = header.clientHeight
                return previous === next ? previous : next
            })
            setViewportHeight((previous) => {
                const next = window.innerHeight
                return previous === next ? previous : next
            })
        }

        measure()
        window.addEventListener('resize', measure)

        // jsdom implements no ResizeObserver in some environments, so its absence is tolerated: the
        // resize listener alone still keeps the measurement current there.
        const observer = typeof ResizeObserver === 'undefined'
            ? undefined
            : new ResizeObserver(measure)
        observer?.observe(header)

        return () => {
            window.removeEventListener('resize', measure)
            observer?.disconnect()
        }
    }, [])

    const remainingHeightAfterTabs = Math.max(
        MIN_TAB_CONTENT_HEIGHT,
        viewportHeight - headerHeight - TAB_CHROME_HEIGHT
    )

    return (
        <div>
            <div className="p-4 flex-col gap-4 md:flex hidden">
                <div ref={ref} className="flex flex-col gap-4">
                    <div className="flex justify-between">
                        <div className="flex items-center gap-6">
                            <Breadcrumb>
                                <BreadcrumbList>
                                    <BreadcrumbItem>
                                        <a href="/desk" className="text-ink-gray-7">
                                            <HomeIcon size={16} />
                                        </a>
                                    </BreadcrumbItem>
                                    <BreadcrumbSeparator />
                                    <BreadcrumbItem>
                                        <BreadcrumbPage>
                                            <div className="flex gap-1 items-center">
                                                {_("Banking")} <Badge theme="violet" variant="subtle">{_("Beta")}</Badge>
                                            </div>

                                        </BreadcrumbPage>
                                    </BreadcrumbItem>
                                </BreadcrumbList>
                            </Breadcrumb>
                            <CompanySelector />
                        </div>
                        <div className="flex items-center gap-2 flex-wrap justify-end">
                            <TooltipProvider>
                                {/* The importer used to be reachable only from the no-transactions empty
                                    state, so a populated workbench offered no route to it at all. */}
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button variant='outline' isIconButton size='md' asChild>
                                            <Link to="/statement-importer" aria-label={_("Import Bank Statement")}>
                                                <ImportIcon />
                                            </Link>
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        {_("Import Bank Statement")}
                                    </TooltipContent>
                                </Tooltip>
                                <Settings />
                                <ActionLog />
                            </TooltipProvider>
                            <BankRecDateFilter />
                        </div>
                    </div>
                    <BankPicker />
                    <BankBalance />
                </div>
                <BankRecTabs remainingHeightAfterTabs={remainingHeightAfterTabs} />
                <BankTransactionUnreconcileModal />
            </div>
            <div className="md:hidden flex h-screen items-center justify-between">
                <Empty>
                    <EmptyMedia>
                        <LandmarkIcon />
                    </EmptyMedia>
                    <EmptyHeader>
                        <EmptyTitle>
                            {_("Banking")}
                        </EmptyTitle>
                        <EmptyDescription>
                            {_("This screen is not supported on mobile devices.")}
                        </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                        <Button asChild>
                            <a href="/desk">
                                {_("Go to Desktop")}
                            </a>
                        </Button>
                    </EmptyContent>
                </Empty>

            </div>
        </div>
    )
}

const BankRecTabs = ({ remainingHeightAfterTabs }: { remainingHeightAfterTabs: number }) => {
    const selectedBankAccount = useAtomValue(selectedBankAccountAtom)

    if (!selectedBankAccount) {
        return null
    }

    return <Tabs defaultValue="Match and Reconcile">
        {/* The five triggers are `whitespace-nowrap` and therefore unshrinkable, and they need about
            1044px between them. Below roughly 1076px the surplus used to escape the list - which is
            `flex-nowrap` with visible overflow - and widen the DOCUMENT, so the last tab ended up
            partly (36px at 1024) or entirely (292px at 768) outside the viewport with no way to reach
            it. Scrolling the strip keeps the overflow inside the strip, where it is reachable, and
            leaves the document itself at the viewport width. Radix scrolls the focused trigger into
            view, so keyboard access needs nothing further. */}
        <TabsList className="w-full max-w-full overflow-x-auto">
            <TabsTrigger value="Match and Reconcile"><ShuffleIcon /> {_("Match and Reconcile")}</TabsTrigger>
            <TabsTrigger value="Bank Reconciliation Statement"><ScrollTextIcon /> {_("Bank Reconciliation Statement")}</TabsTrigger>
            <TabsTrigger value="Bank Transactions"><ListIcon />{_("Bank Transactions")}</TabsTrigger>
            <TabsTrigger value="Bank Clearance Summary"><CheckCircleIcon />{_("Bank Clearance Summary")}</TabsTrigger>
            <TabsTrigger value="Incorrectly Cleared Entries"><AlertTriangleIcon /> {_("Incorrectly Cleared Entries")}</TabsTrigger>
        </TabsList>
        <TabsContent value="Match and Reconcile">
            <MatchAndReconcile contentHeight={remainingHeightAfterTabs} />
        </TabsContent>
        <Suspense fallback={
            <div className="flex items-center justify-center p-16">
                <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
            </div>
        }>
            <TabsContent value="Bank Reconciliation Statement">
                <BankReconciliationStatement />
            </TabsContent>
            <TabsContent value="Bank Transactions">
                <BankTransactions />
            </TabsContent>
            <TabsContent value="Bank Clearance Summary">
                <BankClearanceSummary />
            </TabsContent>
            <TabsContent value="Incorrectly Cleared Entries">
                <IncorrectlyClearedEntries />
            </TabsContent>
        </Suspense>
    </Tabs>
}

export default BankReconciliation