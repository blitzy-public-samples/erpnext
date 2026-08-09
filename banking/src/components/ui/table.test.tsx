/**
 * Behavioural specification for the `Table` primitive's overflow affordance.
 *
 * The statement preview grid on the import-detail screen hid roughly 215px of columns at 390px wide
 * with nothing on screen to say so. The container has always been `overflow-x-auto`, so the columns
 * were technically reachable - but overlay scrollbars, the platform default and what headless Chrome
 * renders, are invisible until a scroll gesture begins, and there is no gesture to begin with a
 * keyboard. The truncation was therefore both undiscoverable and, without a pointer, unreachable.
 *
 * The container now reports its own overflow: while content extends past either inline edge it
 * becomes a named focusable scroll region (operable with arrow keys) and thickens the edge that
 * content disappears behind. Both are conditional - a table that fits must add no tab stop, or every
 * small table in the application would put an interaction-free stop in the tab order.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { Table, TableBody, TableCell, TableRow } from './table'

function stubGeometry({ scrollWidth, clientWidth, scrollLeft = 0 }: {
    scrollWidth: number
    clientWidth: number
    scrollLeft?: number
}) {
    const widths = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth)
    const clients = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth)
    const lefts = vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'get').mockReturnValue(scrollLeft)

    return () => {
        widths.mockRestore()
        clients.mockRestore()
        lefts.mockRestore()
    }
}

let restoreGeometry: (() => void) | undefined

afterEach(() => {
    restoreGeometry?.()
    restoreGeometry = undefined
})

const renderTable = (containerLabel?: string) =>
    render(
        <Table containerLabel={containerLabel}>
            <TableBody>
                <TableRow>
                    <TableCell>2026-08-01</TableCell>
                    <TableCell>Card settlement</TableCell>
                </TableRow>
            </TableBody>
        </Table>,
    )

const container = (): HTMLElement => {
    const node = document.querySelector<HTMLElement>('[data-slot="table-container"]')
    if (!node) throw new Error('table container not rendered')
    return node
}

describe('Table overflow affordance', () => {
    it('becomes a named focusable scroll region while columns are hidden', async () => {
        restoreGeometry = stubGeometry({ scrollWidth: 900, clientWidth: 390 })
        renderTable('Statement preview')

        await waitFor(() => {
            expect(screen.getByRole('region', { name: 'Statement preview (scrollable)' })).toBeInTheDocument()
        })
        expect(container()).toHaveAttribute('tabindex', '0')
    })

    it('marks the edge the content disappears behind', async () => {
        restoreGeometry = stubGeometry({ scrollWidth: 900, clientWidth: 390, scrollLeft: 0 })
        renderTable('Statement preview')

        await waitFor(() => {
            // Scrolled to the start, so content continues past the trailing edge only.
            expect(container().className).toContain('ltr:border-r-2')
        })
        expect(container().className).not.toContain('ltr:border-l-2')
    })

    it('moves the marker to the other edge once scrolled to the end', async () => {
        restoreGeometry = stubGeometry({ scrollWidth: 900, clientWidth: 390, scrollLeft: 510 })
        renderTable('Statement preview')

        await waitFor(() => {
            expect(container().className).toContain('ltr:border-l-2')
        })
        expect(container().className).not.toContain('ltr:border-r-2')
    })

    it('adds no tab stop and no marker when the table already fits', () => {
        restoreGeometry = stubGeometry({ scrollWidth: 390, clientWidth: 390 })
        renderTable('Statement preview')

        expect(container()).not.toHaveAttribute('tabindex')
        expect(screen.queryByRole('region')).not.toBeInTheDocument()
        expect(container().className).not.toContain('border-r-2')
    })

    it('falls back to a generic region name when the caller supplied none', async () => {
        restoreGeometry = stubGeometry({ scrollWidth: 900, clientWidth: 390 })
        renderTable()

        await waitFor(() => {
            expect(screen.getByRole('region', { name: 'Scrollable table' })).toBeInTheDocument()
        })
    })

    it('keeps the table itself rendered inside the container', () => {
        restoreGeometry = stubGeometry({ scrollWidth: 900, clientWidth: 390 })
        renderTable('Statement preview')

        expect(screen.getByText('Card settlement')).toBeInTheDocument()
        expect(container().querySelector('table')).not.toBeNull()
    })
})
