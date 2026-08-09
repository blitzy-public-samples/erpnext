/**
 * Behavioural specification for the shared `Dialog` primitive's size and overflow contract.
 *
 * Every modal in this application was unusable at some supported width, and the cause was in this
 * file rather than in the modals. Three defects compounded:
 *
 *   1. Call sites sized themselves with `min-w-*`. A minimum width is a floor, not a bound, so
 *      `min-w-7xl` (80rem) on a 768px viewport produced a 1280px dialog that hung 512px off the
 *      screen, taking its footer with it. `min-w-[95vw]` failed the same way once the content inside
 *      was wider than the box: the minimum was satisfied and then exceeded.
 *   2. The content grid's implicit track is sized `auto`, and an `auto` track's minimum is the
 *      max-content width of its widest child. A wide table therefore inflated the track past the
 *      dialog's own box and dragged the footer - which shares that track - out of reach even at
 *      1440px, where there was room to spare.
 *   3. Overflow was `overflow-y-auto`, so content too wide to fit had no scroll axis at all:
 *      visible, unreachable and un-scrollable.
 *
 * The fixes are a viewport-clamped width expression per size, a `minmax(0,1fr)` column that cannot
 * be inflated, scrolling on both axes, and a footer pinned inside the scroll container so it is
 * reachable however far the body scrolls. This file pins all four, plus the close control's target
 * size, focus ring and translated accessible name.
 */

import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from './dialog'
import type { DialogSize } from './dialog'

const renderDialog = (size?: DialogSize, extra?: React.ReactNode) =>
    render(
        <Dialog open>
            <DialogContent size={size}>
                <DialogHeader>
                    <DialogTitle>Reconcile</DialogTitle>
                    <DialogDescription>Body</DialogDescription>
                </DialogHeader>
                {extra}
                <DialogFooter>
                    <button type="button">Submit</button>
                </DialogFooter>
            </DialogContent>
        </Dialog>,
    )

const content = (): HTMLElement => {
    const node = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')
    if (!node) throw new Error('dialog content not rendered')
    return node
}

/**
 * Every size that is not the primitive's own default clamps to the viewport.
 *
 * The assertion is on the shape of the expression rather than on a pixel measurement because jsdom
 * does not lay out or resolve `min()`; what can be verified here is that the width is bounded by
 * `calc(100vw-2rem)` and that the `max-w` ceiling the primitive ships is explicitly stood down, so a
 * `sm:max-w-lg` cannot silently win over the requested size.
 */
describe('DialogContent size', () => {
    const clamped: DialogSize[] = ['sm', 'xl', '2xl', '3xl', '5xl', '7xl', 'wide']

    it.each(clamped)('clamps %s to the viewport rather than overflowing it', (size) => {
        renderDialog(size)
        const className = content().className

        expect(className).toContain('calc(100vw-2rem)')
        expect(className).toContain('max-w-none')
        expect(className).toContain('sm:max-w-none')
        // A floor would reintroduce the original defect: satisfied, then exceeded.
        expect(className).not.toMatch(/\bmin-w-/)
    })

    it('records the requested size so it is inspectable from the DOM', () => {
        renderDialog('7xl')
        expect(content()).toHaveAttribute('data-size', '7xl')
    })

    it('leaves the primitive default untouched when no size is requested', () => {
        renderDialog()
        // The default deliberately keeps `sm:max-w-lg`; it never overflowed.
        expect(content().className).not.toContain('calc(100vw-2rem)')
    })

    it('caps the widest size so a large display does not stretch form rows across it', () => {
        renderDialog('wide')
        // 90rem, not `calc(100vw-2rem)` alone: an ~1888px dialog on a 1920px display put label and
        // field a screen-width apart.
        expect(content().className).toContain('min(90rem,calc(100vw-2rem))')
    })
})

describe('DialogContent overflow', () => {
    it('pins the content column so wide children cannot inflate the dialog', () => {
        renderDialog('7xl')
        expect(content().className).toContain('grid-cols-[minmax(0,1fr)]')
    })

    it('scrolls on both axes, not only vertically', () => {
        renderDialog('7xl')
        const className = content().className

        expect(className).toContain('overflow-auto')
        expect(className).not.toContain('overflow-y-auto')
    })

    it('reserves the scrollbar gutter so an appearing scrollbar does not reflow the body', () => {
        renderDialog('7xl')
        expect(content().className).toContain('[scrollbar-gutter:stable]')
    })
})

describe('DialogFooter reachability', () => {
    it('pins the footer inside the scroll container so it survives a long body', () => {
        renderDialog('7xl')
        const footer = document.querySelector<HTMLElement>('[data-slot="dialog-footer"]')

        expect(footer).not.toBeNull()
        // Sticky within the scrollport rather than at the end of the flow: a 2000px body used to push
        // Submit below the fold with nothing to say it was there.
        expect(footer!.className).toContain('sticky')
        expect(footer!.className).toContain('bottom-0')
    })

    it('keeps the primary action rendered alongside the dismiss control', () => {
        renderDialog('7xl')
        expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })
})

describe('DialogContent close control', () => {
    it('is large enough to hit and carries a translated accessible name', () => {
        renderDialog('7xl')
        const close = screen.getByRole('button', { name: 'Close' })

        // The name comes from `_("Close")`, so a translated build renames it; it was hard-coded English.
        expect(close).toHaveAttribute('data-slot', 'dialog-close')
        // 16x16 originally - below any pointer-target guidance.
        expect(close.className).toContain('size-9')
    })

    it('shows a focus ring, so keyboard users can see where they are', () => {
        renderDialog('7xl')
        expect(screen.getByRole('button', { name: 'Close' }).className).toContain('focus-visible:outline-2')
    })

    it('hides the decorative glyph from assistive technology', () => {
        renderDialog('7xl')
        const icon = screen.getByRole('button', { name: 'Close' }).querySelector('svg')

        expect(icon).not.toBeNull()
        expect(icon).toHaveAttribute('aria-hidden', 'true')
    })
})

describe('DialogContent modality', () => {

    it('says it is modal, rather than leaving assistive technology to infer it', async () => {
        /*
         * Radix renders a genuine modal - it traps focus and marks everything outside `aria-hidden` - but
         * it never sets `aria-modal`: verified by searching the installed `@radix-ui/react-dialog` bundle,
         * which contains no occurrence of the attribute. The behaviour was already correct; what was
         * missing was stating it, which is what a screen reader uses to decide whether to confine its
         * reading to the dialog.
         */
        renderDialog()

        const dialog = await screen.findByRole('dialog')
        expect(dialog).toHaveAttribute('aria-modal', 'true')
    })
})

/**
 * Return focus on close - the same defect and the same fix as in `alert-dialog.tsx`, pinned in both so the
 * two primitives cannot drift. Every dialog in this app except the settings dialog is opened by setting a
 * jotai atom rather than by a `DialogTrigger`, so Radix has no trigger to restore focus to and it fell to
 * `document.body`. Rendered here without a trigger, deliberately, because a trigger-based version of this
 * test passes against the defect.
 */
describe('DialogContent return focus', () => {

    const AtomDrivenDialog = ({ open }: { open: boolean }) => (
        <>
            <button type="button">Record payment</button>
            {open ? (
                <Dialog open>
                    <DialogContent size="2xl">
                        <DialogHeader>
                            <DialogTitle>Record payment</DialogTitle>
                            <DialogDescription>Pick a voucher.</DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                            <button type="button">Submit</button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            ) : null}
        </>
    )

    it('returns focus to the control that opened it, with no trigger to restore to', async () => {
        const { rerender } = render(<AtomDrivenDialog open={false} />)

        const opener = screen.getByRole('button', { name: 'Record payment' })
        opener.focus()
        expect(opener).toHaveFocus()

        rerender(<AtomDrivenDialog open />)
        await waitFor(() => {
            expect(screen.getByRole('dialog')).toBeInTheDocument()
        })

        rerender(<AtomDrivenDialog open={false} />)

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Record payment' })).toHaveFocus()
        })
        expect(document.body).not.toHaveFocus()
    })
})
