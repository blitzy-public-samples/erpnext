import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Which edges of a scroll container still have content beyond the scrollport.
 *
 * `overflows` is deliberately separate from `atStart`/`atEnd`: a container that does not overflow at
 * all is simultaneously at its start and at its end, and callers need to distinguish "nothing to
 * scroll" from "scrolled all the way".
 */
export type ScrollOverflowState = {
    /** True when `scrollWidth` exceeds the scrollport, i.e. some content is horizontally out of view. */
    overflows: boolean
    /** True when the scrollport is flush against the inline-start edge (no hidden content behind it). */
    atStart: boolean
    /** True when the scrollport is flush against the inline-end edge (no hidden content ahead of it). */
    atEnd: boolean
}

export type ScrollOverflow<T extends HTMLElement> = ScrollOverflowState & {
    /**
     * Attach to the scrolling element. This is a callback ref rather than a ref object, and that is
     * load-bearing - see the note on `useScrollOverflow`.
     */
    ref: (node: T | null) => void
}

const NO_OVERFLOW: ScrollOverflowState = { overflows: false, atStart: true, atEnd: true }

/**
 * Tolerance in CSS pixels for the edge comparisons.
 *
 * Sub-pixel layout, fractional device pixel ratios and RTL negative `scrollLeft` all make the
 * arithmetic land a fraction short of the theoretical extreme, which would otherwise leave a "there
 * is more content" affordance permanently lit on a table that is fully scrolled.
 */
const EDGE_TOLERANCE = 1

function measure(element: HTMLElement): ScrollOverflowState {
    const maxScroll = element.scrollWidth - element.clientWidth
    if (maxScroll <= EDGE_TOLERANCE) return NO_OVERFLOW

    // `scrollLeft` is negative in RTL in every engine that follows the current spec, so normalise to
    // a distance travelled from the inline-start edge before comparing.
    const travelled = Math.abs(element.scrollLeft)
    return {
        overflows: true,
        atStart: travelled <= EDGE_TOLERANCE,
        atEnd: travelled >= maxScroll - EDGE_TOLERANCE,
    }
}

/**
 * Observes a horizontally scrollable element and reports whether content is hidden beyond either
 * inline edge.
 *
 * This exists to make horizontal overflow *discoverable*. Overlay scrollbars - the platform default
 * on macOS and in headless Chrome - are invisible until a scroll gesture begins, so a wide table
 * silently truncates its trailing columns with nothing on screen to say so. Row actions (Undo,
 * Reset Clearing Date, Force Clear) live in those trailing columns, which turns a cosmetic
 * shortcoming into unreachable functionality.
 *
 * The element arrives through a CALLBACK REF, not a ref object, and the distinction decides whether
 * the hook works at all. Every grid here renders an empty-state placeholder until its rows arrive,
 * and the placeholder is returned before the scroll container exists - so the container attaches on a
 * later render than the first. A ref object's identity never changes, so an effect that subscribed
 * using one ran exactly once, on the first render, when there was nothing to subscribe to; the hook
 * then reported "no overflow" forever on a grid that overflowed. React invokes a callback ref exactly
 * when the node attaches and again with null when it detaches, which is precisely the signal needed.
 *
 * State is recomputed on scroll, on container resize and on content resize, because all three change
 * the answer independently: scrolling moves the viewport, resizing the container changes the
 * scrollport, and re-rendering rows changes the content width.
 */
export function useScrollOverflow<T extends HTMLElement>(): ScrollOverflow<T> {
    const [state, setState] = useState<ScrollOverflowState>(NO_OVERFLOW)
    const [element, setElement] = useState<T | null>(null)

    // Read the latest state without re-subscribing, so the effect below runs once per element.
    const stateRef = useRef(state)
    stateRef.current = state

    const sync = useCallback(() => {
        if (!element) return
        const next = measure(element)
        const current = stateRef.current
        if (
            next.overflows === current.overflows &&
            next.atStart === current.atStart &&
            next.atEnd === current.atEnd
        ) {
            return
        }
        setState(next)
    }, [element])

    useEffect(() => {
        if (!element) {
            // A container that has gone away leaves no overflow to report. `NO_OVERFLOW` is a module
            // constant, so when the state is already that value React bails out without re-rendering.
            setState(NO_OVERFLOW)
            return
        }

        sync()
        element.addEventListener("scroll", sync, { passive: true })

        /*
         * The RESIZE path is deferred to the next animation frame; the scroll path above is not.
         *
         * A ResizeObserver callback that changes the size of something it observes re-enters the same
         * delivery cycle, and the browser breaks that cycle by abandoning the remaining notifications and
         * reporting "ResizeObserver loop completed with undelivered notifications" - which surfaced as an
         * uncaught `window.onerror` on the workbench. This hook closes exactly that loop: flipping
         * `overflows` to true adds a border to the trailing sticky cells, that border changes the content
         * width, and the observed content element therefore resizes as a direct result of the observation.
         *
         * A frame's deferral moves the state update out of the delivery cycle, so the resize it causes is
         * observed as an ordinary later change instead of re-entrant one. Coalescing on a single pending
         * frame also collapses the two observed elements' notifications into one measurement, since both
         * describe the same layout. Scroll needs none of this - it changes no size - and is left
         * synchronous so the affordance keeps up with the gesture.
         */
        let frame = 0
        const scheduleSync = () => {
            if (frame) return
            frame = requestAnimationFrame(() => {
                frame = 0
                sync()
            })
        }

        // jsdom has no ResizeObserver by default. The test harness stubs one, but guard anyway so a
        // consumer of this hook can never be the reason a component fails to mount.
        let observer: ResizeObserver | undefined
        if (typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(scheduleSync)
            observer.observe(element)
            // The first element child is the grid/table that actually grows; observing only the
            // scrollport misses content-width changes that do not resize the scrollport.
            const content = element.firstElementChild
            if (content) observer.observe(content)
        }

        return () => {
            if (frame) cancelAnimationFrame(frame)
            element.removeEventListener("scroll", sync)
            observer?.disconnect()
        }
    }, [element, sync])

    return { ...state, ref: setElement }
}
