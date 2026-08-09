import * as React from "react"
import {
    type Cell,
    type ColumnDef,
    type ColumnSizingState,
    type Header,
    type OnChangeFn,
    type Row,
    type RowSelectionState,
    flexRender,
    functionalUpdate,
    getCoreRowModel,
    useReactTable,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useDebounceCallback } from "usehooks-ts"

import { Checkbox } from "@/components/ui/checkbox"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useScrollOverflow } from "@/hooks/use-scroll-overflow"
import _ from "@/lib/translate"
import { cn } from "@/lib/utils"
import { useDirection } from "./direction"

/** Optional per-column layout hints for `ListView`. */
export type ListViewColumnMeta = {
    /** CSS grid track (`1fr`, `2fr`, `minmax(0,1fr)`). When set, used instead of TanStack pixel `size` in `grid-template-columns`. */
    gridWidth?: string
    align?: "left" | "center" | "right"
    /**
     * Tabular figures for stable digit width. Default: on when `align` is `right` (amounts); set `false` to opt out, or `true` for dates/IDs.
     */
    tabularNums?: boolean
    /**
     * Full text for an overflow tooltip (shown only when the cell truncates). If omitted, a string `accessorKey` value is used when available.
     */
    getTooltipText?: (row: unknown) => string | null | undefined
    /** `false` disables the overflow tooltip for this column. */
    truncateTooltip?: boolean
    /**
     * `false` skips single-line truncation for cells with custom layouts (e.g. action buttons). Default `true`.
     */
    truncate?: boolean
    /**
     * Pins this column to the TRAILING edge of the scroll area, so its contents stay reachable however
     * far the grid is scrolled horizontally.
     *
     * Intended for the actions column, which is why it exists. These grids declare a minimum outer width
     * from the sum of their columns and scroll horizontally below it, and the actions sit last - so on any
     * viewport narrower than the full table the controls that DO something (Undo a reconciliation, Force
     * Clear a voucher) were the first things to leave the screen, behind a scrollbar nothing advertised.
     * Measured: Undo unreachable at 1380px and below, sheared between 1381 and 1455; Force Clear entirely
     * off-screen at 768 and 1024.
     *
     * Pinning is the right answer rather than shrinking the other columns, because it costs nothing at
     * full width - a sticky cell that fits inside the scrollport never moves - and because these controls
     * are the point of the row.
     */
    stickyEnd?: boolean
}

function alignClass(meta: ListViewColumnMeta | undefined) {
    switch (meta?.align) {
        case "center":
            return "justify-center text-center"
        case "right":
            return "justify-end text-end"
        default:
            return "justify-start text-start"
    }
}

function tabularNumsClass(meta: ListViewColumnMeta | undefined) {
    if (meta?.tabularNums === false) return ""
    if (meta?.tabularNums === true) return "tabular-nums"
    if (meta?.align === "right") return "tabular-nums"
    return ""
}

function resolveTooltipLabel<TData>(
    row: Row<TData>,
    meta: ListViewColumnMeta | undefined,
    columnDef: ColumnDef<TData, unknown>,
): string | undefined {
    if (meta?.truncateTooltip === false) return undefined
    const fromMeta = meta?.getTooltipText?.(row.original as unknown)
    if (fromMeta != null && String(fromMeta).length > 0) {
        return String(fromMeta)
    }
    const key = "accessorKey" in columnDef ? columnDef.accessorKey : undefined
    if (key !== undefined && key !== null && key !== "") {
        try {
            const v = row.getValue(String(key))
            if (v != null && v !== "") return String(v)
        } catch {
            /* column may not expose a value */
        }
    }
    return undefined
}

function ListViewCellBody<TData>({
    cell,
    row,
    meta,
    children,
}: {
    cell: Cell<TData, unknown>
    row: Row<TData>
    meta: ListViewColumnMeta | undefined
    children: React.ReactNode
}) {
    const ref = React.useRef<HTMLDivElement>(null)
    const [overflowing, setOverflowing] = React.useState(false)
    const direction = useDirection()

    const tooltipLabel = resolveTooltipLabel(row, meta, cell.column.columnDef)
    const tooltipAlign = meta?.align === "right" && direction === "ltr" ? "end" : "start"

    const measure = React.useCallback(() => {
        const el = ref.current
        if (!el) return
        setOverflowing(el.scrollWidth > el.clientWidth + 1)
    }, [])

    React.useLayoutEffect(() => {
        measure()
    }, [measure, children, tooltipLabel])

    React.useEffect(() => {
        const el = ref.current
        if (!el || typeof ResizeObserver === "undefined") return
        const ro = new ResizeObserver(measure)
        ro.observe(el)
        return () => ro.disconnect()
    }, [measure])

    if (meta?.truncate === false) {
        return <div className="min-w-0 flex-1 overflow-visible">{children}</div>
    }

    const inner = (
        <div
            ref={ref}
            className={cn(
                "min-h-0 min-w-0 flex-1 truncate",
            )}
        >
            {children}
        </div>
    )

    if (!tooltipLabel || !overflowing) {
        return inner
    }

    return (
        <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>{inner}</TooltipTrigger>
            <TooltipContent
                side="bottom"
                align={tooltipAlign}
                className="max-w-sm text-balance wrap-break-word"
            >
                {tooltipLabel}
            </TooltipContent>
        </Tooltip>
    )
}

function gridTemplateFromHeaders<TData>(headers: Header<TData, unknown>[]) {
    return headers
        .map((header) => {
            const meta = header.column.columnDef.meta as ListViewColumnMeta | undefined
            if (meta?.gridWidth) {
                return meta.gridWidth
            }
            return `${header.getSize()}px`
        })
        .join(" ")
}

function defaultGetRowId<TData>(row: TData, index: number) {
    const r = row as Record<string, unknown>
    if (r && typeof r.name === "string") return r.name
    if (r && typeof r.id === "string") return r.id
    return String(index)
}

export type ListViewProps<TData> = {
    data: TData[]
    columns: ColumnDef<TData, unknown>[]
    /**
     * Stable row id for selection and keys. Defaults to `name`, then `id`, then row index (index is fragile if data order changes).
     */
    getRowId?: (originalRow: TData, index: number) => string
    /** Pixel height of each body row (default 40, matches frappe-ui ListView). */
    rowHeight?: number
    className?: string
    /** Classes for the scrollable viewport (default includes max-height). */
    scrollAreaClassName?: string
    /** Max height of the scroll area; number is pixels. Default `420`. */
    maxHeight?: number | string
    emptyState?: React.ReactNode
    enableColumnResizing?: boolean
    columnSizing?: ColumnSizingState
    onColumnSizingChange?: OnChangeFn<ColumnSizingState>
    /** Debounced callback for persisting widths (e.g. localStorage). */
    onColumnSizingCommit?: (sizing: ColumnSizingState) => void
    columnSizingCommitDelayMs?: number
    enableRowSelection?: boolean
    rowSelection?: RowSelectionState
    onRowSelectionChange?: OnChangeFn<RowSelectionState>
    onRowClick?: (row: TData, event: React.MouseEvent) => void
    /**
     * Accessible name for the grid and for its scrollable viewport.
     *
     * When the grid overflows horizontally the viewport becomes a keyboard-focusable scroll region,
     * and a focusable region without a name is an unlabelled stop in the tab order. Supplying the
     * name here keeps it in the caller's translation catalogue rather than inventing a generic one.
     */
    ariaLabel?: string
}

function ListViewInner<TData>({
    data,
    columns: userColumns,
    getRowId: getRowIdProp,
    rowHeight = 40,
    className,
    scrollAreaClassName,
    maxHeight = 420,
    emptyState,
    enableColumnResizing = true,
    columnSizing: controlledColumnSizing,
    onColumnSizingChange: controlledOnColumnSizingChange,
    onColumnSizingCommit,
    columnSizingCommitDelayMs = 250,
    enableRowSelection = false,
    rowSelection: controlledRowSelection,
    onRowSelectionChange: controlledOnRowSelectionChange,
    onRowClick,
    ariaLabel,
}: ListViewProps<TData>) {
    const parentRef = React.useRef<HTMLDivElement>(null)
    /**
     * Drives the horizontal-overflow affordance. Overlay scrollbars are invisible at rest, so without
     * this a grid whose trailing action column is off-screen looks complete while its controls are
     * unreachable to anyone who does not guess that the region scrolls.
     */
    const { ref: overflowRef, ...horizontalOverflow } = useScrollOverflow<HTMLDivElement>()
    /*
     * One node, two consumers: the virtualiser needs a ref OBJECT it can read on demand, and the
     * overflow hook needs a callback ref so it learns the moment the scrollport attaches - which is a
     * render later than the first, because the empty-state branch above returns before this element
     * exists. Merging them here keeps both correct without giving the DOM two `ref` props.
     */
    const setScrollport = React.useCallback(
        (node: HTMLDivElement | null) => {
            parentRef.current = node
            overflowRef(node)
        },
        [overflowRef],
    )

    const [internalColumnSizing, setInternalColumnSizing] = React.useState<ColumnSizingState>({})
    const columnSizing = controlledColumnSizing ?? internalColumnSizing

    const [internalRowSelection, setInternalRowSelection] = React.useState<RowSelectionState>({})
    const rowSelection = controlledRowSelection ?? internalRowSelection
    const setRowSelection = controlledOnRowSelectionChange ?? setInternalRowSelection

    const debouncedSizingCommit = useDebounceCallback(
        (sizing: ColumnSizingState) => {
            onColumnSizingCommit?.(sizing)
        },
        columnSizingCommitDelayMs,
    )

    const selectionColumn = React.useMemo<ColumnDef<TData, unknown>>(
        () => ({
            id: "__list_view_select__",
            size: 36,
            minSize: 36,
            maxSize: 36,
            enableResizing: false,
            meta: {
                truncate: false,
                truncateTooltip: false,
            } satisfies ListViewColumnMeta,
            header: ({ table }) => (
                <div className="flex size-full items-center justify-center">
                    <Checkbox
                        aria-label="Select all rows"
                        checked={
                            table.getIsAllRowsSelected()
                                ? true
                                : table.getIsSomeRowsSelected()
                                    ? "indeterminate"
                                    : false
                        }
                        onCheckedChange={(value) => table.toggleAllRowsSelected(value === true)}
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>
            ),
            cell: ({ row }) => (
                <div className="flex size-full items-center justify-center">
                    <Checkbox
                        aria-label="Select row"
                        checked={row.getIsSelected()}
                        onCheckedChange={(value) => row.toggleSelected(value === true)}
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>
            ),
        }),
        [],
    )

    const columns = React.useMemo(() => {
        if (!enableRowSelection) return userColumns
        return [selectionColumn, ...userColumns]
    }, [enableRowSelection, selectionColumn, userColumns])

    const getRowId = React.useCallback(
        (originalRow: TData, index: number) =>
            (getRowIdProp ?? defaultGetRowId)(originalRow, index),
        [getRowIdProp],
    )

    const onColumnSizingChangeInternal = React.useCallback<OnChangeFn<ColumnSizingState>>(
        (updater) => {
            if (controlledOnColumnSizingChange) {
                controlledOnColumnSizingChange(updater)
                return
            }
            setInternalColumnSizing((old) => {
                const next = functionalUpdate(updater, old)
                debouncedSizingCommit(next)
                return next
            })
        },
        [controlledOnColumnSizingChange, debouncedSizingCommit],
    )

    const direction = useDirection()

    const table = useReactTable({
        data,
        columns,
        defaultColumn: {
            minSize: 50,
            size: 150,
        },
        columnResizeMode: "onChange",
        columnResizeDirection: direction,
        enableColumnResizing,
        getCoreRowModel: getCoreRowModel(),
        getRowId,
        onColumnSizingChange: onColumnSizingChangeInternal,
        onRowSelectionChange: setRowSelection,
        state: {
            columnSizing,
            rowSelection,
        },
        enableRowSelection,
    })

    const headerGroup = table.getHeaderGroups()[0]
    const gridTemplateColumns = headerGroup
        ? gridTemplateFromHeaders(headerGroup.headers)
        : ""

    const { rows } = table.getRowModel()

    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => rowHeight,
        overscan: 10,
    })

    const maxHeightStyle =
        typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight

    if (data.length === 0) {
        return (
            <div
                className={cn(
                    "bg-surface-gray-2 text-ink-gray-5 flex min-h-32 items-center justify-center rounded-md px-4 text-sm",
                    className,
                )}
            >
                {emptyState ?? "No data"}
            </div>
        )
    }

    /** Tracks + column gaps + horizontal padding (`px-2` × 2) so header and body share one scroll width. */
    const colCount = headerGroup?.headers.length ?? 0
    const minTableOuterWidth =
        table.getCenterTotalSize() +
        Math.max(0, colCount - 1) * 16 +
        16

    /*
     * `aria-rowcount` is what makes a VIRTUALISED table honest. Only the visible slice of rows is in
     * the DOM, so without it assistive technology counts what it can see and announces "row 3 of 20"
     * over a set of 180. The count includes the header row, and `aria-rowindex` below is 1-based with
     * the header at 1, which is why the body rows start at 2.
     */
    const ariaRowCount = rows.length + (headerGroup ? 1 : 0)

    return (
        <div className={cn("flex min-w-0 flex-col", className)}>
            <div
                ref={setScrollport}
                data-slot="list-view-scrollport"
                className={cn("min-h-0 overflow-auto", scrollAreaClassName)}
                style={{ maxHeight: maxHeightStyle }}
                /**
                 * Only a horizontally overflowing viewport becomes a focusable scroll region. Adding an
                 * unconditional tab stop would put an interaction-free element in the tab order of
                 * every grid that fits, which is a regression in its own right.
                 */
                {...(horizontalOverflow.overflows
                    ? {
                        role: "region",
                        tabIndex: 0,
                        "aria-label": ariaLabel
                            ? _("{0} (scrollable)", [ariaLabel])
                            : _("Scrollable table"),
                    }
                    : {})}
            >
                {/*
                 * The grid lives INSIDE the scroll container, not around it.
                 *
                 * It used to be the other way round, which put the scrollport between the `grid` and its
                 * `row` children - and once that scrollport became a `region` for the horizontal-scroll
                 * affordance, the grid's structure was broken outright: ARIA permits only `row` and
                 * `rowgroup` between a grid and its rows, so a `region` in the middle orphaned every row.
                 * Nesting it this way lets both roles be correct at once.
                 *
                 * The header row is a DIRECT child rather than sitting in its own `rowgroup`, and that is
                 * a layout constraint rather than a preference: it is `position: sticky`, so it can only
                 * travel within its containing block. Wrapped in a rowgroup sized to the header itself,
                 * it would have nowhere to stick.
                 */}
                <div
                    role="grid"
                    aria-label={ariaLabel}
                    aria-rowcount={ariaRowCount}
                    aria-colcount={colCount}
                >
                {headerGroup ? (
                    <div
                        className="bg-surface-gray-2 sticky top-0 z-10 mb-2 grid w-full items-center gap-x-4 rounded p-2"
                        role="row"
                        aria-rowindex={1}
                        style={{
                            display: "grid",
                            gridTemplateColumns,
                            minWidth: `max(100%, ${minTableOuterWidth}px)`,
                            boxSizing: "border-box",
                        }}
                    >
                        {headerGroup.headers.map((header, headerIndex) => {
                            const meta = header.column.columnDef.meta as ListViewColumnMeta | undefined
                            return (
                                <div
                                    key={header.id}
                                    aria-colindex={headerIndex + 1}
                                    className={cn(
                                        "text-ink-gray-5 group relative flex min-w-0 items-center px-0 text-sm",
                                        alignClass(meta),
                                        // Pinned with its column, so the heading stays over the cells it names.
                                        // `surface-gray-2` matches the header row's own background.
                                        meta?.stickyEnd && "sticky ltr:right-0 rtl:left-0 z-1 bg-surface-gray-2 ltr:ps-2 rtl:pe-2",
                                        // Leading edge marker, shown only while columns are actually
                                        // hidden underneath the pinned cell. This is the discoverable
                                        // part: it says "content continues this way" at rest, which an
                                        // overlay scrollbar never does.
                                        meta?.stickyEnd &&
                                        horizontalOverflow.overflows &&
                                        !horizontalOverflow.atEnd &&
                                        "ltr:border-l rtl:border-r border-outline-gray-2",
                                    )}
                                    role="columnheader"
                                >
                                    <div className="min-w-0 flex-1 truncate">
                                        {header.isPlaceholder
                                            ? null
                                            : flexRender(header.column.columnDef.header, header.getContext())}
                                    </div>
                                    {enableColumnResizing && header.column.getCanResize() ? (
                                        <>
                                            <span
                                                aria-hidden
                                                className={cn(
                                                    "pointer-events-none absolute ltr:-right-2 rtl:-left-2 z-1 w-0.5 bg-gray-400",
                                                    "opacity-0 transition-[opacity,background-color] ease-in-out duration-150",
                                                    "group-hover:opacity-100 group-hover:bg-gray-400",
                                                    header.column.getIsResizing() && "bg-outline-gray-6 opacity-100",
                                                )}
                                                style={{ height: "100%" }}
                                            />
                                            {/*
                                              * Hidden from assistive technology, and that is the honest
                                              * treatment rather than a shortcut. It handles `mousedown` and
                                              * `touchstart` only - there is no key handler and no tab stop -
                                              * so it was a control a screen-reader user could reach the name
                                              * of and then not operate. Worse, its `aria-label` sat INSIDE
                                              * the `columnheader`, so it was folded into the heading's
                                              * accessible name: every column announced itself as
                                              * "Description Resize column", in hardcoded English, on a
                                              * surface where every other string is translated. Column widths
                                              * are a convenience with no bearing on what the table says.
                                              */}
                                            <div
                                                aria-hidden="true"
                                                onMouseDown={(e) => {
                                                    e.preventDefault()
                                                    document.body.classList.add("select-none", "cursor-col-resize")
                                                    const end = () => {
                                                        document.body.classList.remove("select-none", "cursor-col-resize")
                                                        window.removeEventListener("mouseup", end)
                                                        window.removeEventListener("touchend", end)
                                                    }
                                                    window.addEventListener("mouseup", end)
                                                    window.addEventListener("touchend", end)
                                                    header.getResizeHandler()(e)
                                                }}
                                                onTouchStart={header.getResizeHandler()}
                                                className="absolute top-0 ltr:-right-2 rtl:-left-2 z-10 h-full w-2 max-w-[12px] cursor-col-resize touch-none select-none bg-transparent"
                                            />
                                        </>
                                    ) : null}
                                </div>
                            )
                        })}
                    </div>
                ) : null}

                <div
                    role="rowgroup"
                    className="relative w-full"
                    style={{
                        height: `${rowVirtualizer.getTotalSize()}px`,
                        minWidth: `max(100%, ${minTableOuterWidth}px)`,
                        boxSizing: "border-box",
                    }}
                >
                    {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                        const row = rows[virtualRow.index]
                        if (!row) return null
                        const leadDataColumnIndex = enableRowSelection ? 1 : 0
                        return (
                            <div
                                key={row.id}
                                data-index={virtualRow.index}
                                role="row"
                                /* 1-based, and offset past the header at index 1. */
                                aria-rowindex={virtualRow.index + (headerGroup ? 2 : 1)}
                                className={cn(
                                    /*
                                     * `transition-colors`, NOT `transition-all`. `transition-all` includes
                                     * `transform`, and the `transform: translateY()` below is this row's
                                     * POSITION in the virtualised list - so every time a row's offset
                                     * changed, the browser animated it there over 300ms instead of drawing
                                     * it where it belonged. Sorting, filtering and any row-height change
                                     * all rewrite those offsets for the whole window at once, and the
                                     * transform is composited per frame for every visible row. Measured on
                                     * a 135-row list: 52.4fps with 73 frames over 50ms.
                                     *
                                     * Nothing about the design changes. The only transition this row was
                                     * ever meant to have is the hover and selection background fade, which
                                     * is a colour transition; the duration and easing are untouched, so
                                     * that fade is identical.
                                     */
                                    "ease-in-out absolute top-0 ltr:left-0 rtl:right-0 w-full min-w-0 rounded px-2 transition-colors duration-300",
                                    // virtualRow.index > 0 && "border-t border-outline-gray-1",
                                    !row.getIsSelected() && "hover:bg-surface-menu-bar",
                                    row.getIsSelected() && "bg-surface-gray-2 hover:bg-surface-gray-3",
                                    onRowClick && "cursor-pointer",
                                )}
                                style={{
                                    display: "grid",
                                    gridTemplateColumns,
                                    boxSizing: "border-box",
                                    columnGap: "1rem",
                                    height: `${rowHeight}px`,
                                    transform: `translateY(${virtualRow.start}px)`,
                                    /*
                                     * Layout and style containment on each row. Every row is absolutely
                                     * positioned at a fixed height, so its own box can never be influenced
                                     * by a sibling and nothing inside it can change the size of anything
                                     * outside it - which is precisely the promise containment makes. Stating
                                     * it lets the engine treat a row as its own layout and style subtree, so
                                     * the per-frame re-render the virtualiser performs while scrolling
                                     * invalidates one row rather than reaching up into the rowgroup and back
                                     * down through every other visible row.
                                     *
                                     * `paint` is deliberately NOT included. It would clip descendants to the
                                     * row's own box, and the trailing `stickyEnd` cells are `position: sticky`
                                     * against the horizontal scrollport rather than the row - clipping them
                                     * at the row boundary is a real risk for no measured gain, since every
                                     * cell already carries `overflow-hidden`.
                                     */
                                    contain: "layout style",
                                }}
                                onClick={(e) => {
                                    if (onRowClick) onRowClick(row.original, e)
                                }}
                            >
                                {virtualRow.index > 0 && <div className="absolute top-0 inset-s-2 inset-e-2 h-px bg-outline-gray-1" />}
                                {row.getVisibleCells().map((cell, cellIndex) => {
                                    const meta = cell.column.columnDef.meta as ListViewColumnMeta | undefined
                                    return (
                                        <div
                                            key={cell.id}
                                            role="gridcell"
                                            aria-colindex={cellIndex + 1}
                                            className={cn(
                                                "flex min-w-0 items-center overflow-hidden text-sm",
                                                cellIndex === leadDataColumnIndex
                                                    ? "text-ink-gray-8"
                                                    : "text-ink-gray-7",
                                                alignClass(meta),
                                                tabularNumsClass(meta),
                                                // Pinned to the trailing edge of the scrollport. The background is
                                                // required, not decorative: without it the columns scrolling
                                                // underneath would show through the pinned cell.
                                                meta?.stickyEnd && "sticky ltr:right-0 rtl:left-0 z-1 bg-surface-white ltr:ps-2 rtl:pe-2",
                                                meta?.stickyEnd && row.getIsSelected() && "bg-surface-gray-2",
                                                // Matches the pinned header's marker so the boundary
                                                // reads as one continuous edge down the whole grid.
                                                meta?.stickyEnd &&
                                                horizontalOverflow.overflows &&
                                                !horizontalOverflow.atEnd &&
                                                "ltr:border-l rtl:border-r border-outline-gray-2",
                                            )}
                                        >
                                            <ListViewCellBody cell={cell} row={row} meta={meta}>
                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                            </ListViewCellBody>
                                        </div>
                                    )
                                })}


                            </div>
                        )
                    })}
                </div>
                </div>
            </div>
        </div>
    )
}

/**
 * Div-based list with CSS Grid columns, optional resize handles, row virtualization, and frappe-ui–aligned Espresso tokens.
 */
export function ListView<TData>(props: ListViewProps<TData>) {
    return <ListViewInner {...props} />
}

export type { ColumnSizingState, RowSelectionState }
