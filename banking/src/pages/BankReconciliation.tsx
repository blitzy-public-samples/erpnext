import BankBalance from "@/components/features/BankReconciliation/BankBalance"
import BankPicker from "@/components/features/BankReconciliation/BankPicker"
import BankRecDateFilter from "@/components/features/BankReconciliation/BankRecDateFilter"
import BankTransactionUnreconcileModal from "@/components/features/BankReconciliation/BankTransactionUnreconcileModal"
import CompanySelector from "@/components/features/BankReconciliation/CompanySelector"
import MatchAndReconcile from "@/components/features/BankReconciliation/MatchAndReconcile"
import Settings from "@/components/features/Settings/Settings"
import ActionLog from "@/components/features/ActionLog/ActionLog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { MainContent } from "@/components/common/PageShell"
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

    /*
     * TWO measured blocks, not one, because the site header now sits outside the `main` landmark.
     *
     * Everything above the tabs used to live in a single wrapper, so one `clientHeight` described it.
     * Giving the breadcrumb-and-toolbar row its own `header` element - which is what earns it the
     * `banner` role, and what gives the skip link something to actually skip - split that block in two,
     * with the container's own row gap between them. Both are measured and the gap is read from the
     * container's computed style rather than hardcoded, so the sum stays exact if the gap ever changes.
     */
    const bannerRef = useRef<HTMLElement>(null)
    const summaryRef = useRef<HTMLDivElement>(null)

    useLayoutEffect(() => {
        const banner = bannerRef.current
        const summary = summaryRef.current

        if (!banner || !summary) {
            return
        }

        const measure = () => {
            const gap = Number.parseFloat(
                window.getComputedStyle(summary.parentElement ?? summary).rowGap
            )

            setHeaderHeight((previous) => {
                const next =
                    banner.clientHeight + summary.clientHeight + (Number.isFinite(gap) ? gap : 0)
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
        observer?.observe(banner)
        observer?.observe(summary)

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
        <>
            {/*
                Capped and centred rather than left to fill the viewport. Uncapped, a 1920px display
                stretched the header row so the breadcrumb and the toolbar sat ~1850px apart, and the
                balance strip and tab content inherited the same travel. 96rem keeps the two-pane
                workbench comfortably wide while bounding how far the eye has to move across it.

                The `sm:flex pointer-fine:flex` pair is what keeps this workbench usable at 200% browser
                zoom. Zoom shrinks the CSS viewport - 1440px at 100% becomes 720px at 200% - so a purely
                width-based gate at the old `md` (768px) could not tell a phone from a zoomed desktop, and
                it chose "phone": the whole workbench went `display:none` and a low-vision reviewer got
                "This screen is not supported on mobile devices." Measured before this change, the last
                working zoom was 187.5% (a 768px viewport) and 200% was blocked, which fails the
                requirement to remain usable at 200%.

                Two signals are used together because either alone leaves a hole:

                  - `sm` (640px) covers zoom by width, and covers it for every common desktop baseline:
                    1280 -> 640, 1366 -> 683, 1440 -> 720, 1920 -> 960 all clear 640 at 200%. Phones do
                    not: 360-430px CSS width keeps them below the breakpoint, so they still get the
                    notice. Widening the gate from 768 to 640 therefore buys 200% zoom without handing
                    the workbench to a handset.
                  - `(pointer: fine)` covers the remainder - a smaller desktop window, or zoom past 200%,
                    where width alone would fall back to "phone". It asks the question that was actually
                    meant: is this device driven by a precise pointer? A zoomed desktop still answers yes;
                    a phone answers no.

                A coarse-pointer device narrower than 640px matches neither and still sees the notice,
                which is the intended outcome for a genuine touch handset.
            */}
            <div className="mx-auto w-full max-w-[96rem] p-4 flex-col gap-4 sm:flex pointer-fine:flex hidden">
                {/*
                    A `header` element, and deliberately OUTSIDE the `main` landmark below. `header` only
                    takes the `banner` role when it is not nested inside `main`, and until it was moved
                    out, `main` wrapped the entire page - so there was no banner landmark at all and the
                    skip link, though it worked, skipped nothing: the first Tab after activating it was
                    still the first header control.
                */}
                <header ref={bannerRef} className="flex flex-col gap-4">
                    <div className="flex justify-between">
                        <div className="flex items-center gap-6">
                            <Breadcrumb>
                                <BreadcrumbList>
                                    <BreadcrumbItem>
                                        {/*
                                            Named, because this is the FIRST link in the tab order and it
                                            contains nothing but an icon - so it announced itself as a bare
                                            "link" with no destination, and it navigates away from the app
                                            entirely. The glyph is hidden so the name is not read twice.
                                        */}
                                        <a href="/desk" className="text-ink-gray-7" aria-label={_("ERPNext home")}>
                                            <HomeIcon size={16} aria-hidden="true" />
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
                </header>
                <MainContent
                    title={_("Bank Reconciliation")}
                    className="flex min-w-0 flex-1 flex-col gap-4"
                >
                    {/*
                        The account picker and the balance strip are page CONTENT, not site chrome, so they
                        stay inside `main` while the breadcrumb and toolbar above do not. They are measured
                        together with the header because the tab panels are sized from whatever sits above
                        them, regardless of which landmark it belongs to.
                    */}
                    <div ref={summaryRef} className="flex flex-col gap-4">
                        <BankPicker />
                        <BankBalance />
                    </div>
                    <BankRecTabs remainingHeightAfterTabs={remainingHeightAfterTabs} />
                    <BankTransactionUnreconcileModal />
                </MainContent>
            </div>
            {/* The exact inverse of the gate above, so the notice and the workbench can never both show. */}
            <div className="sm:hidden pointer-fine:hidden flex h-screen items-center justify-between">
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
        </>
    )
}

/*
 * Tab identifiers, kept apart from the tab LABELS on purpose - see the note in `BankRecTabs`.
 * These strings reach the DOM as id fragments and must stay single whitespace-free tokens; they are
 * never shown to a reviewer, so they are deliberately not translated.
 */
const TAB_MATCH_AND_RECONCILE = "match-and-reconcile"
const TAB_STATEMENT = "bank-reconciliation-statement"
const TAB_TRANSACTIONS = "bank-transactions"
const TAB_CLEARANCE = "bank-clearance-summary"
const TAB_INCORRECTLY_CLEARED = "incorrectly-cleared-entries"

const BankRecTabs = ({ remainingHeightAfterTabs }: { remainingHeightAfterTabs: number }) => {
    const selectedBankAccount = useAtomValue(selectedBankAccountAtom)

    if (!selectedBankAccount) {
        return null
    }

    /*
     * The values are slugs, and the labels are separate.
     *
     * Radix derives each panel's `id` and each trigger's `aria-controls` from the tab's VALUE, so a value
     * containing spaces produced `aria-controls="radix-:r0:-content-Match and Reconcile"`. `aria-controls`
     * is an ID-reference LIST, so a user agent splits that on whitespace and looks for four separate ids -
     * none of which exists. All five triggers therefore pointed at nothing, and assistive technology could
     * not tell which panel a tab governed. Slugs are single tokens, so the reference resolves; the visible
     * text comes from the children, which are translated as before.
     */
    return <Tabs defaultValue={TAB_MATCH_AND_RECONCILE}>
        {/* The five triggers are `whitespace-nowrap` and therefore unshrinkable, and they need about
            1044px between them. Below roughly 1076px the surplus used to escape the list - which is
            `flex-nowrap` with visible overflow - and widen the DOCUMENT, so the last tab ended up
            partly (36px at 1024) or entirely (292px at 768) outside the viewport with no way to reach
            it. Scrolling the strip keeps the overflow inside the strip, where it is reachable, and
            leaves the document itself at the viewport width. Radix scrolls the focused trigger into
            view, so keyboard access needs nothing further. */}
        <TabsList className="w-full max-w-full overflow-x-auto">
            <TabsTrigger value={TAB_MATCH_AND_RECONCILE}><ShuffleIcon aria-hidden="true" /> {_("Match and Reconcile")}</TabsTrigger>
            <TabsTrigger value={TAB_STATEMENT}><ScrollTextIcon aria-hidden="true" /> {_("Bank Reconciliation Statement")}</TabsTrigger>
            <TabsTrigger value={TAB_TRANSACTIONS}><ListIcon aria-hidden="true" />{_("Bank Transactions")}</TabsTrigger>
            <TabsTrigger value={TAB_CLEARANCE}><CheckCircleIcon aria-hidden="true" />{_("Bank Clearance Summary")}</TabsTrigger>
            <TabsTrigger value={TAB_INCORRECTLY_CLEARED}><AlertTriangleIcon aria-hidden="true" /> {_("Incorrectly Cleared Entries")}</TabsTrigger>
        </TabsList>
        <TabsContent value={TAB_MATCH_AND_RECONCILE}>
            <MatchAndReconcile contentHeight={remainingHeightAfterTabs} />
        </TabsContent>
        <Suspense fallback={
            <div className="flex items-center justify-center p-16">
                <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
            </div>
        }>
            <TabsContent value={TAB_STATEMENT}>
                <BankReconciliationStatement />
            </TabsContent>
            <TabsContent value={TAB_TRANSACTIONS}>
                <BankTransactions />
            </TabsContent>
            <TabsContent value={TAB_CLEARANCE}>
                <BankClearanceSummary />
            </TabsContent>
            <TabsContent value={TAB_INCORRECTLY_CLEARED}>
                <IncorrectlyClearedEntries />
            </TabsContent>
        </Suspense>
    </Tabs>
}

export default BankReconciliation