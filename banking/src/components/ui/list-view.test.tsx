/**
 * Behavioural specification for `ListView`'s horizontal-overflow handling.
 *
 * Row actions were unreachable rather than merely out of sight. Every grid in the workbench puts its
 * controls in the trailing column - Undo and Force Clear on a bank transaction, Reset Clearing Date on
 * an incorrectly cleared entry - and the trailing column is the first thing a narrow viewport pushes
 * out of the scrollport. Below roughly 1380px Undo was entirely gone; between 1381 and 1455 it was
 * sheared in half; Force Clear was off-screen at both 768 and 1024. Nothing on the page said so,
 * because overlay scrollbars - the platform default, and what headless Chrome renders - are invisible
 * until a scroll gesture starts. The grid looked complete and part of it simply was not there.
 *
 * Two mechanisms answer that, and both are pinned here:
 *
 *   1. `stickyEnd` pins a column to the trailing edge of the scrollport, so the controls stay put
 *      while the data columns scroll underneath them. This is cost-free at full width - a sticky cell
 *      that already fits never moves - and it is the right answer rather than shrinking the other
 *      columns, because the actions are the point of the row.
 *   2. While the grid actually overflows, the scrollport becomes a named, keyboard-focusable scroll
 *      region and the pinned column grows a leading edge marker. The region makes the content
 *      reachable without a pointer; the marker makes the truncation visible at rest.
 *
 * The conditionality is as important as the behaviour: a grid that fits must NOT gain a tab stop, or
 * every narrow table in the app would add an interaction-free stop to the tab order.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { ColumnDef } from '@tanstack/react-table'

import { stubViewportMeasurement } from '@/test/renderPanel'
import { TooltipProvider } from './tooltip'
import { ListView, type ListViewColumnMeta } from './list-view'

type Row = { name: string; description: string }

const ROWS: Row[] = [
    { name: 'BT-0001', description: 'Card settlement' },
    { name: 'BT-0002', description: 'Supplier payment' },
]

const columns: ColumnDef<Row, unknown>[] = [
    { accessorKey: 'description', header: 'Description', size: 400 },
    {
        id: 'actions',
        header: 'Actions',
        size: 200,
        enableResizing: false,
        meta: { truncate: false, truncateTooltip: false, stickyEnd: true } satisfies ListViewColumnMeta,
        cell: ({ row }) => <button type="button">Undo {row.original.name}</button>,
    },
]

/**
 * jsdom performs no layout, so `scrollWidth` and `clientWidth` are both 0 and nothing ever "overflows".
 * Both are stubbed on the prototype for the duration of a test so the hook under test sees the
 * geometry a real browser would report.
 */
function stubGeometry({ scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
    const widths = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth)
    const clients = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth)

    return () => {
        widths.mockRestore()
        clients.mockRestore()
    }
}

stubViewportMeasurement()

let restoreGeometry: (() => void) | undefined

afterEach(() => {
    restoreGeometry?.()
    restoreGeometry = undefined
})

/** Overflow tooltips on truncating cells require the provider the application mounts at its root. */
const renderGrid = (element: React.ReactElement) =>
    render(<TooltipProvider>{element}</TooltipProvider>)

const grid = (name?: string) =>
    name ? screen.getByRole('grid', { name }) : screen.getByRole('grid')

/**
 * The scroll container, which is the PARENT of the grid rather than a child of it. ARIA permits only
 * `row` and `rowgroup` between a grid and its rows, so the scrollport - which becomes a `region` when it
 * overflows - has to sit outside the grid element.
 */
const scrollport = (): HTMLElement => {
    const node = document.querySelector<HTMLElement>('[data-slot="list-view-scrollport"]')
    if (!node) throw new Error('scrollport not rendered')
    return node
}

describe('ListView accessible name', () => {
    it('names the grid so it is identifiable in the accessibility tree', () => {
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)
        expect(grid('Bank transactions')).toBeInTheDocument()
    })
})

describe('ListView stickyEnd column', () => {
    it('pins the opted-in column at both the header and every body cell', () => {
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        const header = screen.getByRole('columnheader', { name: /^Actions\b/ })
        expect(header.className).toContain('sticky')
        // `right` in LTR: the trailing edge is where the actions live.
        expect(header.className).toContain('ltr:right-0')

        // Each action cell needs its own opaque background, or the columns scrolling underneath it
        // would show through the pinned cell.
        const undo = screen.getByRole('button', { name: 'Undo BT-0001' })
        const cell = undo.closest('.sticky')
        expect(cell).not.toBeNull()
        expect(cell!.className).toContain('bg-surface-white')
    })

    it('leaves columns that did not opt in unpinned', () => {
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)
        const header = screen.getByRole('columnheader', { name: /^Description\b/ })
        expect(header.className).not.toContain('sticky')
    })

    it('keeps every row action rendered, which is what reachability rests on', () => {
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        expect(screen.getByRole('button', { name: 'Undo BT-0001' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Undo BT-0002' })).toBeInTheDocument()
    })
})

describe('ListView scroll affordance', () => {
    it('becomes a named keyboard-focusable region while content is hidden', async () => {
        restoreGeometry = stubGeometry({ scrollWidth: 1200, clientWidth: 600 })
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        await waitFor(() => {
            expect(scrollport()).toHaveAttribute('tabindex', '0')
        })
        // Named from the caller's own label, so it stays in the translation catalogue.
        expect(scrollport()).toHaveAttribute('aria-label', 'Bank transactions (scrollable)')
        expect(scrollport()).toHaveAttribute('role', 'region')
    })

    it('marks the pinned column edge so the truncation is visible at rest', async () => {
        restoreGeometry = stubGeometry({ scrollWidth: 1200, clientWidth: 600 })
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        await waitFor(() => {
            expect(
                screen.getByRole('columnheader', { name: /^Actions\b/ }).className,
            ).toContain('ltr:border-l')
        })
    })

    it('adds no tab stop and no edge marker when the grid already fits', () => {
        restoreGeometry = stubGeometry({ scrollWidth: 600, clientWidth: 600 })
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        expect(scrollport()).not.toHaveAttribute('tabindex')
        expect(scrollport()).not.toHaveAttribute('role', 'region')
        expect(
            screen.getByRole('columnheader', { name: /^Actions\b/ }).className,
        ).not.toContain('ltr:border-l')
    })

    it('falls back to a generic region name when the caller supplied none', async () => {
        restoreGeometry = stubGeometry({ scrollWidth: 1200, clientWidth: 600 })
        renderGrid(<ListView data={ROWS} columns={columns} />)

        await waitFor(() => {
            expect(scrollport()).toHaveAttribute('aria-label', 'Scrollable table')
        })
    })
})

/**
 * Grid semantics.
 *
 * The workbench's data surfaces declared `role="grid"` and then broke the structure ARIA requires
 * underneath it, so the rows were announced without any of the relationships that make a grid
 * navigable: no `rowgroup`, no row or column positions, and no row count. A screen-reader user could
 * hear a cell's contents but not "row 40 of 118, column 3 of 8" - which in a reconciliation table is
 * most of the information.
 *
 * Virtualisation is what makes the counts load-bearing rather than decorative. Only the visible slice
 * of rows is in the DOM, so a reader counting DOM rows would report "row 3 of 12" while scrolled to
 * the middle of a hundred and eighteen. `aria-rowcount` states the real total and `aria-rowindex`
 * states each row's real position within it.
 */
describe('ListView grid semantics', () => {

    it('states the true row and column totals, not the virtualised slice', () => {
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        // Two data rows plus the header row, which is itself a row of the grid.
        expect(grid('Bank transactions')).toHaveAttribute('aria-rowcount', '3')
        expect(grid('Bank transactions')).toHaveAttribute('aria-colcount', '2')
    })

    it('puts the grid inside the scrollport, not around it', () => {
        /*
         * The ordering is the fix, not an implementation detail. ARIA permits only `row` and
         * `rowgroup` as children of a grid, so once the scrollport became a `region` - which it must,
         * to be a focusable scroll container - having it sit BETWEEN the grid and its rows orphaned
         * every row in the table.
         */
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        expect(scrollport()).toContainElement(grid('Bank transactions'))
    })

    it('numbers the header row first and the body rows after it', () => {
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        const rows = screen.getAllByRole('row')
        expect(rows[0]).toHaveAttribute('aria-rowindex', '1')

        const first = screen.getByRole('button', { name: 'Undo BT-0001' }).closest('[role="row"]')
        expect(first).toHaveAttribute('aria-rowindex', '2')

        const second = screen.getByRole('button', { name: 'Undo BT-0002' }).closest('[role="row"]')
        expect(second).toHaveAttribute('aria-rowindex', '3')
    })

    it('numbers every column from one, in both the header and the body', () => {
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        expect(screen.getByRole('columnheader', { name: /^Description\b/ }))
            .toHaveAttribute('aria-colindex', '1')
        expect(screen.getByRole('columnheader', { name: /^Actions\b/ }))
            .toHaveAttribute('aria-colindex', '2')

        const cell = screen.getByRole('button', { name: 'Undo BT-0001' }).closest('[role="gridcell"]')
        expect(cell).toHaveAttribute('aria-colindex', '2')
    })

    it('groups the body rows, so the grid is not a flat list of rows', () => {
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        const group = screen.getByRole('rowgroup')
        expect(group).toContainElement(
            screen.getByRole('button', { name: 'Undo BT-0001' }).closest('[role="row"]'),
        )
    })

    it('keeps the resize handle out of the column header\'s accessible name', () => {
        /*
         * The handle used to be a labelled `separator` INSIDE the `columnheader`, so every column in
         * every grid announced as "Description Resize column" - in hardcoded English, and naming a
         * control that has no key handler and no tab stop, so a screen-reader user could hear it and
         * then not operate it. It is a pointer-only affordance and is now hidden outright.
         */
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        const header = screen.getByRole('columnheader', { name: 'Description' })
        expect(header.textContent).toBe('Description')
        expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    })
})

/**
 * N-12. Each virtual row's POSITION in the list is a `transform: translateY()` written per frame by the
 * virtualiser. The row also carried `transition-all duration-300`, and `transition-all` includes
 * `transform` - so every offset change animated the row into place over 300ms instead of drawing it
 * where it belonged, for every visible row at once, composited every frame. Measured on a 135-row list
 * before the change: 52.4fps with 73 frames over 50ms.
 *
 * Asserted on the class list and the inline style rather than by scrolling, because jsdom runs no
 * compositor and no layout - there is no frame budget here to measure. The browser measurement is
 * recorded in the phase evidence; what these hold is that the two properties cannot silently come back.
 */
describe('ListView virtual row rendering cost', () => {

    it('does not animate the positional transform', () => {
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        const rows = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-rowindex') !== '1')
        expect(rows.length).toBeGreaterThan(0)

        rows.forEach((row) => {
            // The transform IS still there - it is how the row is positioned. What must not be there is a
            // transition that includes it.
            expect(row.style.transform).toMatch(/^translateY\(\d+(\.\d+)?px\)$/)
            expect(row.className).not.toContain('transition-all')
            expect(row.className).toContain('transition-colors')
        })
    })

    it('keeps the hover and selection fade, which is the only transition it ever wanted', () => {
        // `transition-colors` covers background-color, so the fade is unchanged; the duration and easing
        // are untouched. A fix that simply deleted the transition would fail this.
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        const row = screen.getAllByRole('row').filter((r) => r.getAttribute('aria-rowindex') !== '1')[0]

        expect(row.className).toContain('duration-300')
        expect(row.className).toContain('ease-in-out')
        expect(row.className).toContain('hover:bg-surface-menu-bar')
    })

    it('contains each row so one row re-rendering cannot invalidate the rest', () => {
        renderGrid(<ListView data={ROWS} columns={columns} ariaLabel="Bank transactions" />)

        const rows = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-rowindex') !== '1')

        rows.forEach((row) => {
            expect(row.style.contain).toBe('layout style')
            /*
             * `paint` deliberately absent: it clips descendants to the row box, and the trailing
             * `stickyEnd` cells are sticky against the horizontal scrollport rather than the row. Pinned so
             * a later "optimisation" cannot add it without this test objecting.
             */
            expect(row.style.contain).not.toContain('paint')
        })
    })
})
