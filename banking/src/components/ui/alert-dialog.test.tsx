/**
 * Behavioural specification for the shared `AlertDialog` primitive.
 *
 * Two separate defects lived here.
 *
 * Sizing and overflow mirrored `DialogContent`'s: call sites reached for `min-w-*`, which is a floor
 * rather than a bound, and the content column was an implicit `auto` track whose minimum is the
 * max-content width of its widest child - so a wide body inflated the dialog past the viewport and
 * carried the footer, and therefore the only way to dismiss or confirm, off the screen with it. The
 * fixes are the same as in `dialog.tsx` and are pinned below so the two primitives cannot drift.
 *
 * Focus was the second, and it only showed itself on a COLD open. Radix moves focus into an alert
 * dialog by doing `event.preventDefault(); cancelRef.current?.focus()` - it focuses Cancel and
 * nothing else. Several of these dialogs load their body as a lazy chunk, so on the first open there
 * is no Cancel mounted yet: default focus behaviour has been prevented, the replacement is a no-op on
 * a null ref, and focus stays on the trigger - which is inside the background the dialog has just
 * marked `aria-hidden`. Chrome logs "Blocked aria-hidden on an element because its descendant
 * retained focus", the keyboard user is outside the dialog they just opened, and Escape never reaches
 * it. The backstop moves focus to the content container when, and only when, focus did not land
 * inside on its own.
 */

import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from './alert-dialog'
import type { AlertDialogSize } from './alert-dialog'

const content = (): HTMLElement => {
    const node = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]')
    if (!node) throw new Error('alert dialog content not rendered')
    return node
}

const renderAlert = (size?: AlertDialogSize) =>
    render(
        <AlertDialog open>
            <AlertDialogContent size={size}>
                <AlertDialogHeader>
                    <AlertDialogTitle>Undo reconciliation</AlertDialogTitle>
                    <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction>Confirm</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>,
    )

describe('AlertDialogContent size', () => {
    const clamped: AlertDialogSize[] = ['2xl', '3xl', '5xl', '7xl']

    it.each(clamped)('clamps %s to the viewport rather than overflowing it', (size) => {
        renderAlert(size)
        const className = content().className

        expect(className).toContain('calc(100vw-2rem)')
        expect(className).toContain('max-w-none')
        expect(className).not.toMatch(/\bmin-w-/)
    })

    it('records the requested size so it is inspectable from the DOM', () => {
        renderAlert('2xl')
        expect(content()).toHaveAttribute('data-size', '2xl')
    })

    it('leaves the two sizes the primitive already shipped alone', () => {
        const { unmount } = renderAlert('default')
        expect(content().className).toContain('data-[size=default]:sm:max-w-lg')
        unmount()

        renderAlert('sm')
        expect(content().className).toContain('data-[size=sm]:max-w-xs')
    })
})

describe('AlertDialogContent overflow', () => {
    it('pins the content column so a wide body cannot inflate the dialog', () => {
        renderAlert('5xl')
        expect(content().className).toContain('grid-cols-[minmax(0,1fr)]')
    })

    it('scrolls on both axes and is bounded vertically', () => {
        renderAlert('5xl')
        const className = content().className

        expect(className).toContain('overflow-auto')
        expect(className).toContain('max-h-[90vh]')
    })

    it('keeps the footer in view while the body scrolls', () => {
        renderAlert('5xl')
        const footer = document.querySelector<HTMLElement>('[data-slot="alert-dialog-footer"]')

        expect(footer).not.toBeNull()
        expect(footer!.className).toContain('sticky')
        expect(footer!.className).toContain('bottom-0')
    })
})

describe('AlertDialogContent first-open focus', () => {
    /**
     * The cold case: the body - and therefore Cancel - has not arrived. This is exactly the lazy-chunk
     * first open, reproduced by rendering a content with no focusable child at all.
     */
    it('takes focus itself when there is nothing focusable inside yet', async () => {
        const user = userEvent.setup()

        render(
            <AlertDialog>
                <AlertDialogTrigger>Undo</AlertDialogTrigger>
                <AlertDialogContent size="2xl">
                    <AlertDialogHeader>
                        <AlertDialogTitle>Loading</AlertDialogTitle>
                        <AlertDialogDescription>Fetching the body.</AlertDialogDescription>
                    </AlertDialogHeader>
                </AlertDialogContent>
            </AlertDialog>,
        )

        const trigger = screen.getByRole('button', { name: 'Undo' })
        await user.click(trigger)

        // The assertion that matters is that focus is INSIDE the dialog rather than left on the
        // trigger: the trigger is in a subtree the open dialog marks aria-hidden.
        await waitFor(() => {
            expect(content().contains(document.activeElement)).toBe(true)
        })
        expect(document.activeElement).not.toBe(trigger)
    })

    it('is script-focusable but adds no stop to the dialog tab order', () => {
        renderAlert('2xl')
        expect(content()).toHaveAttribute('tabindex', '-1')
    })

    /**
     * The warm case must be left exactly as Radix intends it. If the backstop stole focus from Cancel
     * it would change the destructive-confirmation default, which is deliberately the safe control.
     */
    it('does not displace Cancel once the body has arrived', async () => {
        const user = userEvent.setup()

        render(
            <AlertDialog>
                <AlertDialogTrigger>Undo</AlertDialogTrigger>
                <AlertDialogContent size="2xl">
                    <AlertDialogHeader>
                        <AlertDialogTitle>Undo reconciliation</AlertDialogTitle>
                        <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction>Confirm</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>,
        )

        await user.click(screen.getByRole('button', { name: 'Undo' }))

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
        })
    })
})

describe('AlertDialogContent modality', () => {

    it('says it is modal, for the same reason DialogContent does', () => {
        // Radix sets no `aria-modal` on either primitive; both now state it themselves.
        renderAlert()

        expect(screen.getByRole('alertdialog')).toHaveAttribute('aria-modal', 'true')
    })
})

/**
 * Return focus on close.
 *
 * Radix restores focus to its `Trigger`, and almost none of these dialogs have one - they are driven by
 * jotai atoms, so the content mounts already-open with no trigger Radix ever recorded. Measured on the
 * reconciliation workbench: opening a reconciled row's Undo dialog and pressing Escape left
 * `document.activeElement === document.body`, so the next Tab restarted from the top of the page instead
 * of continuing from the row being worked in. The trigger-driven Settings dialog restored correctly, which
 * is what isolated the cause to the missing trigger rather than to the primitive.
 *
 * Rendered here the way the real modals are - `<AlertDialog open>` with no `AlertDialogTrigger` - because
 * a version of this test that used a trigger would pass against the defect.
 */
describe('AlertDialogContent return focus', () => {

    const AtomDrivenAlert = ({
        open,
        onCloseAutoFocus,
    }: {
        open: boolean
        onCloseAutoFocus?: (event: Event) => void
    }) => (
        <>
            <button type="button">Undo</button>
            {open ? (
                <AlertDialog open>
                    <AlertDialogContent size="2xl" onCloseAutoFocus={onCloseAutoFocus}>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Undo reconciliation</AlertDialogTitle>
                            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            ) : null}
        </>
    )

    it('returns focus to the control that opened it, with no trigger to restore to', async () => {
        const { rerender } = render(<AtomDrivenAlert open={false} />)

        const opener = screen.getByRole('button', { name: 'Undo' })
        opener.focus()
        expect(opener).toHaveFocus()

        rerender(<AtomDrivenAlert open />)
        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
        })

        rerender(<AtomDrivenAlert open={false} />)

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus()
        })
        expect(document.body).not.toHaveFocus()
    })

    it('stands down when the call site takes responsibility for focus', async () => {
        const elsewhere = document.createElement('button')
        elsewhere.textContent = 'Elsewhere'
        document.body.append(elsewhere)

        const { rerender } = render(
            <AtomDrivenAlert
                open={false}
                onCloseAutoFocus={(event) => {
                    event.preventDefault()
                    elsewhere.focus()
                }}
            />,
        )

        screen.getByRole('button', { name: 'Undo' }).focus()
        rerender(
            <AtomDrivenAlert
                open
                onCloseAutoFocus={(event) => {
                    event.preventDefault()
                    elsewhere.focus()
                }}
            />,
        )
        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
        })

        rerender(
            <AtomDrivenAlert
                open={false}
                onCloseAutoFocus={(event) => {
                    event.preventDefault()
                    elsewhere.focus()
                }}
            />,
        )

        await waitFor(() => {
            expect(elsewhere).toHaveFocus()
        })

        elsewhere.remove()
    })

    it('does not chase an opener that the dialog itself removed', async () => {
        /*
         * Undo removes its own opener: once the unreconcile succeeds the row leaves the reconciled list.
         * Focusing a detached node is a silent no-op that leaves focus on `body`, so the hook declines and
         * lets Radix decide instead of pretending it restored something.
         *
         * The opener here is a plain DOM node rather than a rendered one, because removing a
         * React-managed element out from under React makes the next reconciliation throw
         * `NotFoundError` - the test would then fail for its own reasons rather than the code's.
         */
        const opener = document.createElement('button')
        opener.type = 'button'
        opener.textContent = 'Undo row 7'
        document.body.append(opener)
        opener.focus()
        expect(opener).toHaveFocus()

        const { rerender } = render(<AtomDrivenAlert open />)
        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
        })

        opener.remove()
        rerender(<AtomDrivenAlert open={false} />)

        await waitFor(() => {
            expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
        })
        expect(opener.isConnected).toBe(false)
        expect(document.activeElement).not.toBe(opener)
    })
})
