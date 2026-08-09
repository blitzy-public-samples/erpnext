import { useState } from "react"

/**
 * Returns focus to whatever opened a dialog once that dialog closes.
 *
 * WHY THIS IS NEEDED AT ALL, given Radix already restores focus:
 *
 * Radix restores focus to its `Trigger`. Almost every dialog in this app has no `Trigger` - the modals
 * here are driven by jotai atoms, so a row's button sets an atom, the dialog component goes from
 * returning `null` to rendering `<AlertDialog open>`, and Radix's content mounts already-open with no
 * trigger it ever recorded. There is therefore nothing for it to return focus to, and on close it lands
 * on `document.body`. Measured on the reconciliation workbench: opening a reconciled row's Undo dialog
 * and pressing Escape left `document.activeElement === document.body`, so the next Tab restarted from the
 * top of the page instead of continuing from the row the reviewer was working in. The trigger-driven
 * Settings dialog restored correctly, which is exactly what isolated the cause to the missing trigger
 * rather than to the primitive.
 *
 * HOW THE OPENER IS CAPTURED:
 *
 * During the FIRST RENDER, via a lazy `useState` initialiser - deliberately not in an effect. Effects run
 * child-first, and Radix's own focus scope lives deeper in the tree than the component using this hook,
 * so by the time an effect here could run, focus has already been moved INTO the dialog and the thing we
 * would capture is the dialog's own Cancel button. First render is the last moment at which
 * `document.activeElement` is still the control the user activated.
 *
 * WHAT IT REFUSES TO DO:
 *
 *  - It does not fight a caller. If a call site supplies its own `onCloseAutoFocus` and prevents the
 *    default, that call site owns focus and this hook stands down.
 *  - It does not focus a detached node. A dialog that removes its own opener - Undo, whose row leaves the
 *    reconciled list once the unreconcile succeeds - has no opener left to return to, so the hook leaves
 *    Radix's behaviour in place rather than throwing focus at a node that is no longer in the document.
 *  - It does nothing when the opener was `body` to begin with, which is the case for a dialog opened by
 *    something other than a focused control.
 *
 * For a dialog that DOES have a trigger, the captured element and Radix's trigger are the same node, so
 * the behaviour is unchanged; this only fills in the case Radix cannot see.
 */
export function useReturnFocus(
    onCloseAutoFocus?: (event: Event) => void
): (event: Event) => void {
    const [opener] = useState<HTMLElement | null>(() => {
        if (typeof document === "undefined") {
            return null
        }

        const active = document.activeElement

        return active instanceof HTMLElement && active !== document.body ? active : null
    })

    return (event: Event) => {
        onCloseAutoFocus?.(event)

        // The caller took responsibility for focus.
        if (event.defaultPrevented) {
            return
        }

        // Either nothing was focused when the dialog opened, or the opener has since been removed from
        // the document. Both are cases where Radix's default is the better answer.
        if (!opener || !opener.isConnected) {
            return
        }

        event.preventDefault()
        opener.focus({ preventScroll: true })
    }
}
