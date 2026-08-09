/**
 * Behavioural specification for `MissingFiltersBanner`.
 *
 * The banner stands in for a panel's content when the reviewer has not yet chosen a bank account or a
 * date range. Five callers pass it a plain string; one - the Record Payment invoice panel - passes a
 * `MarkdownRenderer`, which emits its own `<p>`.
 *
 * The wrapper used to be the `Paragraph` primitive, i.e. a `<p>`, so that one caller produced a `<p>`
 * inside a `<p>`. That is invalid HTML: React logged a `validateDOMNesting` error, and the browser's own
 * parser recovery closed the outer paragraph before the inner one opened - which moved the message
 * outside the flex box that was meant to centre it, so the visible symptom was a mis-placed message
 * rather than anything that looked like a nesting problem. A component whose content type is
 * `ReactNode` cannot assume phrasing content and so must not render an element that only accepts it.
 *
 * The tests below pin both halves: the invalid nesting is gone, and the five string callers still look
 * the same.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { MissingFiltersBanner } from './MissingFiltersBanner'
import MarkdownRenderer from '@/components/ui/markdown'

/**
 * React reports invalid nesting through `console.error`, so the only way to assert its absence is to
 * capture that channel for the duration of the render.
 */
const captureReactComplaints = () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    return {
        nesting: () =>
            error.mock.calls
                .map((args) => args.map(String).join(' '))
                .filter((message) => /validateDOMNesting|cannot (?:appear|be a descendant)/i.test(message)),
        restore: () => error.mockRestore(),
    }
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('MissingFiltersBanner', () => {

    it('renders a plain-string message', () => {
        render(<MissingFiltersBanner text="Please select a bank and set the date range" />)

        expect(screen.getByText('Please select a bank and set the date range')).toBeInTheDocument()
    })

    it('keeps the paragraph type token, so the string callers are unchanged', () => {
        render(<MissingFiltersBanner text="Please select a bank and set the date range" />)

        const message = screen.getByText('Please select a bank and set the date range')
        expect(message.className).toContain('text-p-base')
    })

    it('does not wrap its content in a paragraph', () => {
        const { container } = render(<MissingFiltersBanner text="Please select a bank" />)

        // The wrapper itself must not be a <p>; the content type is ReactNode, so it may legitimately
        // contain block elements.
        expect(container.querySelector('p')).toBeNull()
    })

    /**
     * The exact production case: `RecordPaymentModalContent` passes a `MarkdownRenderer`, whose output
     * begins with a `<p>`.
     */
    it('accepts markdown content without nesting one paragraph inside another', () => {
        const complaints = captureReactComplaints()

        try {
            const { container } = render(
                <MissingFiltersBanner text={<MarkdownRenderer content="Select a **party** to see its invoices." />} />,
            )

            expect(complaints.nesting()).toEqual([])

            // Markdown's own paragraph is present and is not inside another one.
            const paragraphs = container.querySelectorAll('p')
            expect(paragraphs.length).toBeGreaterThan(0)
            paragraphs.forEach((paragraph) => {
                expect(paragraph.parentElement?.tagName).not.toBe('P')
            })
        } finally {
            complaints.restore()
        }
    })

    it('still centres the message inside the panel', () => {
        const { container } = render(<MissingFiltersBanner text="Please select a bank" />)
        const outer = container.firstElementChild as HTMLElement

        // The centring box is what the early-closed paragraph used to escape.
        expect(outer.className).toContain('items-center')
        expect(outer.className).toContain('justify-center')
        expect(outer.contains(screen.getByText('Please select a bank'))).toBe(true)
    })

    it('accepts an extra class from the caller', () => {
        const { container } = render(<MissingFiltersBanner text="Please select a bank" className="py-8" />)

        expect((container.firstElementChild as HTMLElement).className).toContain('py-8')
    })
})
