/**
 * Behavioural specification for the application's page structure.
 *
 * Both routes previously rendered a bare tree of `div`s: no `main` landmark, no `h1`, and no way to
 * jump past the breadcrumb and toolbar. The practical cost is highest for the two groups least able
 * to work around it - a screen-reader user had no landmark to jump to and no heading to orient by,
 * and a keyboard user had to traverse the entire header on every single route change before reaching
 * the reconciliation table.
 *
 * The heading is deliberately `sr-only`. The visible page title is the breadcrumb's trailing crumb,
 * which is the design's own answer to "what page is this", and duplicating it as visible text would
 * change the design to fix an accessibility problem that a hidden heading solves outright.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { MAIN_CONTENT_ID, MainContent, SkipToContent } from './PageShell'

describe('PageShell', () => {

    describe('the main landmark', () => {

        it('exposes exactly one main landmark, carrying the page content', () => {
            render(
                <MainContent title="Bank Reconciliation">
                    <p>Reconciliation workbench</p>
                </MainContent>
            )

            const landmarks = screen.getAllByRole('main')
            expect(landmarks).toHaveLength(1)
            expect(landmarks[0]).toContainElement(screen.getByText('Reconciliation workbench'))
        })

        it('gives the page exactly one level-one heading', () => {
            render(
                <MainContent title="Import Bank Statement">
                    <p>Importer</p>
                </MainContent>
            )

            const headings = screen.getAllByRole('heading', { level: 1 })
            expect(headings).toHaveLength(1)
            expect(headings[0]).toHaveTextContent('Import Bank Statement')
        })

        it('keeps the heading out of sight, because the breadcrumb already shows the title', () => {
            render(<MainContent title="Bank Reconciliation"><p>Body</p></MainContent>)

            // Present in the accessibility tree, absent from the design.
            expect(screen.getByRole('heading', { level: 1 })).toHaveClass('sr-only')
        })

        it('is programmatically focusable, so the skip link can move focus into it', () => {
            /*
             * `tabIndex={-1}` and not `0`: the landmark must be a valid target for
             * `element.focus()` after a fragment navigation, without becoming a stop in the tab
             * sequence itself - a container that swallows a Tab press teaches the user nothing.
             */
            render(<MainContent title="Bank Reconciliation"><p>Body</p></MainContent>)

            const main = screen.getByRole('main')
            expect(main).toHaveAttribute('tabindex', '-1')
            expect(main).toHaveAttribute('id', MAIN_CONTENT_ID)
        })
    })

    describe('the skip link', () => {

        it('points at the main landmark by fragment', () => {
            render(<SkipToContent />)

            expect(screen.getByRole('link')).toHaveAttribute('href', `#${MAIN_CONTENT_ID}`)
        })

        it('is hidden until it holds focus, then reveals itself', () => {
            render(<SkipToContent />)

            const link = screen.getByRole('link')

            // Off-screen but in the accessibility tree and in the tab order, so it is discoverable by
            // Tab and invisible to everyone else.
            expect(link).toHaveClass('sr-only')
            expect(link.className).toContain('focus-visible:not-sr-only')
        })

        it('resolves to the landmark that MainContent actually renders', () => {
            /*
             * The two halves are separately mounted - the link lives in the router, the landmark in
             * each page - so the only thing tying them together is the shared id. Asserting the
             * fragment alone would pass even if the landmark's id were changed on one side.
             */
            render(
                <>
                    <SkipToContent />
                    <MainContent title="Bank Reconciliation"><p>Body</p></MainContent>
                </>
            )

            const target = screen.getByRole('link').getAttribute('href')?.slice(1) ?? ''
            expect(document.getElementById(target)).toBe(screen.getByRole('main'))
        })
    })
})

describe('the document head', () => {

    /*
     * Read from the real `index.html` rather than from a fixture. The defect was a SECOND, restrictive
     * `viewport` declaration sitting above the compliant one, which no component test could ever have
     * seen: the browser resolves the later meta, so whether pinch-zoom worked came down to the source
     * order of two lines in a file no test looked at. Reading the shipped file is the only assertion
     * that can hold that line.
     */
    const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8')
    const viewports = html.match(/<meta\s+name="viewport"[^>]*>/g) ?? []

    it('declares the viewport exactly once', () => {
        expect(viewports).toHaveLength(1)
    })

    it('never forbids the user from zooming', () => {
        const declaration = viewports[0] ?? ''

        expect(declaration).not.toMatch(/user-scalable\s*=\s*no/)
        expect(declaration).not.toMatch(/maximum-scale/)
        expect(declaration).not.toMatch(/minimum-scale/)
    })
})
