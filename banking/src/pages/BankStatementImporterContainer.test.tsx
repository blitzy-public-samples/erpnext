/**
 * Behavioural specification for the statement importer's route shell.
 *
 * The importer's two screens - the list of previous imports and a single import's detail - share this
 * shell, and it was a bare stack of `div`s: no `main` landmark, no heading of any level, and a
 * breadcrumb whose first item was an icon-only link with no accessible name. That link is the first
 * stop in the tab order on every route AND it leaves the application entirely for the Frappe desk, so
 * "unnamed link" was the worst possible thing for it to be.
 *
 * The heading is `sr-only` on purpose: the visible title is the breadcrumb's trailing crumb, which is
 * the design's own answer, and adding a second visible title would change the design in order to fix
 * an accessibility problem that a hidden heading fixes outright.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'

import { MAIN_CONTENT_ID } from '@/components/common/PageShell'
import BankStatementImporterContainer from './BankStatementImporterContainer'

const renderShell = () =>
    render(
        <MemoryRouter initialEntries={['/statement-importer']}>
            <Routes>
                <Route path="/statement-importer" element={<BankStatementImporterContainer />}>
                    <Route index element={<p>Previous imports</p>} />
                </Route>
            </Routes>
        </MemoryRouter>
    )

describe('BankStatementImporterContainer', () => {

    it('wraps the route in a single main landmark', () => {
        renderShell()

        const landmarks = screen.getAllByRole('main')
        expect(landmarks).toHaveLength(1)
        expect(landmarks[0]).toHaveAttribute('id', MAIN_CONTENT_ID)
    })

    it('gives the route exactly one level-one heading, out of sight', () => {
        renderShell()

        const headings = screen.getAllByRole('heading', { level: 1 })
        expect(headings).toHaveLength(1)
        expect(headings[0]).toHaveTextContent('Import Bank Statement')
        expect(headings[0]).toHaveClass('sr-only')
    })

    it('names the breadcrumb home link, and hides its glyph from being read twice', () => {
        renderShell()

        const home = screen.getByRole('link', { name: 'ERPNext home' })
        expect(home).toHaveAttribute('href', '/desk')
        expect(home.querySelector('[aria-hidden="true"]')).not.toBeNull()
    })

    it('renders the nested route inside the landmark, not beside it', () => {
        renderShell()

        expect(screen.getByRole('main')).toContainElement(screen.getByText('Previous imports'))
    })

    it('puts the breadcrumb in a banner landmark OUTSIDE main, so the skip link skips something', () => {
        /*
         * `header` earns the `banner` role only when it is not nested inside `main`. While `main` wrapped
         * the whole route there was no banner landmark, and the skip link - which did move focus
         * correctly - skipped nothing: the first Tab after activating it was still this breadcrumb.
         */
        renderShell()

        const banner = screen.getByRole('banner')
        const main = screen.getByRole('main')

        expect(main).not.toContainElement(banner)
        expect(banner).toContainElement(screen.getByRole('link', { name: 'ERPNext home' }))
        expect(main).toContainElement(screen.getByText('Previous imports'))
    })

    it('keeps the breadcrumb trail intact, since it is the visible page title', () => {
        renderShell()

        expect(screen.getByRole('link', { name: 'Banking' })).toHaveAttribute('href', '/')
        // The trailing crumb is the current page and is deliberately not a link.
        expect(screen.getByText('Import Bank Statement', { selector: '[data-slot="breadcrumb-page"]' }))
            .toBeInTheDocument()
    })
})
