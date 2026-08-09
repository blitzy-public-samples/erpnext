import { Button } from "@/components/ui/button"
import ErrorBanner from "@/components/ui/error-banner"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import _ from "@/lib/translate"
import { BankTransactionRule } from "@/types/Accounts/BankTransactionRule"
import { FrappeConfig, FrappeContext, useFrappeGetCall, useFrappeGetDocList, useFrappePostCall } from "frappe-react-sdk"
import { ArrowDownRight, ArrowDownUp, ArrowUpRight, MoreVertical, Trash2, GripVertical, Play, RefreshCw, ZapIcon, CalendarSyncIcon } from "lucide-react"
import { useContext, useState } from "react"
import { toast } from "sonner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
} from '@dnd-kit/core'
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import {
    useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"

const useGetRuleList = () => {
    return useFrappeGetDocList<BankTransactionRule>("Bank Transaction Rule", {
        fields: ["name", "rule_name", "rule_description", "transaction_type", "priority"],
        orderBy: {
            field: 'priority',
            order: 'asc'
        },
        limit: 100
    })
}

export const RunRulesButton = () => {

    const { data } = useGetRuleList()

    const { call: runRuleEvaluation, loading: isRunningRules } = useFrappePostCall('erpnext.accounts.doctype.bank_transaction_rule.bank_transaction_rule.run_rule_evaluation')

    const handleRunRules = async (forceEvaluate: boolean = false) => {
        try {
            await runRuleEvaluation({
                force_evaluate: forceEvaluate
            })
            toast.success(forceEvaluate ? _("Rules evaluation started") : _("Rules evaluation completed"))
        } catch (error) {
            toast.error(_("Failed to run rules evaluation"))
            console.error("Error running rules evaluation:", error)
        }
    }

    if (!data || data.length === 0) {
        return null
    }

    return <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={isRunningRules}>
                {isRunningRules ? (
                    <RefreshCw className="animate-spin" />
                ) : (
                    <Play />
                )}
                {isRunningRules ? _("Running...") : _("Run Rules")}
            </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => handleRunRules(false)} disabled={isRunningRules} title={_("Run rules on unreconciled transactions that haven't been evaluated yet")}>
                <Play />
                {_("Run on new transactions")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleRunRules(true)} disabled={isRunningRules} title={_("Force re-evaluate all unreconciled transactions, even if they were previously evaluated")}>
                <RefreshCw />
                {_("Force evaluate all")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <AutoRunRuleItem />
        </DropdownMenuContent>
    </DropdownMenu>
}

const AutoRunRuleItem = () => {

    const { db } = useContext(FrappeContext) as FrappeConfig

    const { data: accountsSetting, mutate: setAutomaticallyRunRulesOnUnreconciledTransactions } = useFrappeGetCall("frappe.client.get_single_value", {
        "doctype": "Accounts Settings",
        "field": "automatically_run_rules_on_unreconciled_transactions"
    })

    const automaticallyRunRulesOnUnreconciledTransactions = accountsSetting?.message ? true : false

    const onAutoClassifyTransactions = (checked: boolean) => {
        toast.promise(db.setValue("Accounts Settings", "Accounts Settings", "automatically_run_rules_on_unreconciled_transactions", checked ? 1 : 0).then(() => {
            setAutomaticallyRunRulesOnUnreconciledTransactions({
                message: {
                    automatically_run_rules_on_unreconciled_transactions: checked ? 1 : 0,
                }
            }, {
                revalidate: false
            })
        }), {
            loading: _("Updating..."),
            success: checked ? _("Scheduled job enabled. Transactions will be auto classified.") : _("Scheduled job disabled. Transactions will not be auto classified."),
            error: _("Failed to update auto classify transactions settings")
        })
    }


    return <DropdownMenuCheckboxItem
        checked={automaticallyRunRulesOnUnreconciledTransactions}
        onCheckedChange={onAutoClassifyTransactions}>
        <CalendarSyncIcon />
        {_("Run rules automatically")}
    </DropdownMenuCheckboxItem>
}



const RuleList = ({ setSelectedRule }: { setSelectedRule: (rule: string) => void }) => {

    const { data, error, isLoading, mutate } = useGetRuleList()

    const { db } = useContext(FrappeContext) as FrappeConfig

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    )

    const onDeleteRule = (ruleID: string) => {
        toast.promise(db.deleteDoc("Bank Transaction Rule", ruleID).then(() => {
            mutate()
        }), {
            loading: _("Deleting rule..."),
            success: _("Rule deleted."),
            error: _("Failed to delete rule.")
        })
    }

    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event

        if (active.id !== over?.id && data) {
            const oldIndex = data.findIndex((rule) => rule.name === active.id)
            const newIndex = data.findIndex((rule) => rule.name === over?.id)

            const newData = arrayMove(data, oldIndex, newIndex)

            // Update priorities based on new order
            const updatePromises = newData.map((rule, index) => {
                const newPriority = index + 1
                if (rule.priority !== newPriority) {
                    return db.setValue("Bank Transaction Rule", rule.name, "priority", newPriority)
                }
                return Promise.resolve()
            })

            try {
                await Promise.all(updatePromises)
                toast.success(_("Rule priorities updated"))
                mutate() // Refresh the data
            } catch (error) {
                toast.error(_("Failed to update rule priorities"))
                console.error("Error updating priorities:", error)
            }
        }
    }

    return (
        <>
            <div className="overflow-y-auto">
                {isLoading && <div className="flex flex-col gap-2">
                    <Skeleton className="w-full h-10" />
                    <Skeleton className="w-full h-10" />
                    <Skeleton className="w-full h-10" />
                    <Skeleton className="w-full h-10" />
                    <Skeleton className="w-full h-10" />
                </div>}

                {error && <ErrorBanner error={error} />}

                {data && data.length === 0 && <Empty className="h-96">
                    <EmptyMedia>
                        <ZapIcon />
                    </EmptyMedia>
                    <EmptyHeader>
                        <EmptyTitle>{_("No rules setup yet")}</EmptyTitle>
                        <EmptyDescription>{_("Configure rules to save time when reconciling transactions.")}</EmptyDescription>
                    </EmptyHeader>

                </Empty>}

                {data && data.length > 0 && (
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        <SortableContext
                            items={data.map(rule => rule.name)}
                            strategy={verticalListSortingStrategy}
                        >
                            <ul className="space-2 divide-y divide-outline-gray-modals">
                                {data?.map((rule) => (
                                    <SortableRuleItem
                                        key={rule.name}
                                        rule={rule}
                                        setSelectedRule={setSelectedRule}
                                        onDeleteRule={onDeleteRule}
                                    />
                                ))}
                            </ul>
                        </SortableContext>
                    </DndContext>
                )}
            </div>
        </>
    )
}
const SortableRuleItem = ({
    rule,
    setSelectedRule,
    onDeleteRule
}: {
    rule: BankTransactionRule
    setSelectedRule: (rule: string) => void
    onDeleteRule: (ruleID: string) => void
}) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: rule.name })

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    }

    const [isDropdownOpen, setIsDropdownOpen] = useState(false)

    return (
        <li ref={setNodeRef} style={style}>
            {/* A rule name and description are free text with no server-side length cap, so both are
                treated here the same way the unreconciled-transaction row treats its variable-length
                fields: the flex chain that carries them is cleared to `min-w-0` so it can shrink, each
                variable string truncates through an INNER block span (both `Button` and `Badge` set
                `whitespace-nowrap` on themselves, so the ellipsis has to be applied to a child), and
                the full text stays available through `title`. Everything of fixed width — the drag
                handle, the priority badge, the direction icon and the actions menu — is pinned with
                `shrink-0` so it can never be squeezed away or overlapped by the text column. Without
                this, a long rule name grew the row past the settings dialog and pushed the panel
                header's "Run Rules" and "Add Rule" buttons outside the dialog's clipping box. */}
            <div className={cn("flex justify-between items-center gap-2 py-2 my-0.5 h-full hover:bg-surface-gray-1 pe-2 rounded", isDropdownOpen && "bg-surface-gray-1")}>
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div
                        {...attributes}
                        {...listeners}
                        className="cursor-grab active:cursor-grabbing p-1 rounded shrink-0"
                        title={_("Drag to reorder")}
                    >
                        <GripVertical className="w-4 h-4 text-ink-gray-5" />
                    </div>
                    <Badge theme="gray" className="font-numeric tabular-nums shrink-0">
                        {rule.priority}
                    </Badge>
                    <div className="flex flex-col gap-1 min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                            <Button
                                variant='link'
                                size='sm'
                                className="p-0 h-fit text-start cursor-pointer no-underline hover:underline min-w-0 shrink"
                                title={rule.rule_name}
                                onClick={() => setSelectedRule(rule.name)}>
                                <span className="truncate">{rule.rule_name}</span>
                            </Button>
                            <div className="shrink-0" title={rule.transaction_type === "Any" ? _("Applies to withdrawals and deposits") : rule.transaction_type === "Withdrawal" ? _("Applies to withdrawals") : _("Applies to deposits")}>
                                {rule.transaction_type === "Any" ? <ArrowDownUp className="text-ink-gray-5 w-4 h-4" /> : rule.transaction_type === "Withdrawal" ? <ArrowUpRight className="text-ink-red-3 w-5 h-5" /> : <ArrowDownRight className="text-ink-green-3 w-5 h-5" />}
                            </div>
                        </div>
                        <span className="text-sm text-ink-gray-5 truncate" title={rule.rule_description}>
                            {rule.rule_description}
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-2 h-full justify-center shrink-0">
                    <DropdownMenu open={isDropdownOpen} onOpenChange={setIsDropdownOpen}>
                        <DropdownMenuTrigger asChild>
                            {/* Named with the rule it acts on: a column of bare "button" entries gives no
                                way to tell which rule is about to be deleted. */}
                            <Button variant='ghost' isIconButton className="hover:bg-transparent"
                                aria-label={_("Actions for {0}", [rule.rule_name ?? rule.name])}>
                                <MoreVertical aria-hidden="true" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => onDeleteRule(rule.name)}>
                                <Trash2 />
                                {_("Delete")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </li>
    )
}

export default RuleList
