/**
 * Behavioural specification for `useScrollOverflow`.
 *
 * This hook exists to make horizontal overflow visible. Overlay scrollbars - the platform default on
 * macOS and what headless Chrome renders - are invisible until a scroll gesture begins, so a table
 * wider than its container silently truncates its trailing columns with nothing on screen to say so.
 * Row actions live in those trailing columns, which turns an aesthetic shortcoming into unreachable
 * functionality.
 *
 * Three distinctions carry the behaviour and each is pinned below:
 *
 *   1. "Does not overflow" is not the same as "scrolled to the end". A container that fits is
 *      simultaneously at its start and its end, so callers must be able to tell "nothing to scroll"
 *      apart from "nothing further this way" - otherwise a permanent edge marker appears on every
 *      table that fits.
 *   2. The edge comparisons are tolerant. Sub-pixel layout and fractional device pixel ratios land
 *      the arithmetic a fraction short of the theoretical extreme, which would leave a "there is more
 *      content" marker lit on a fully scrolled table forever.
 *   3. `scrollLeft` is negative in right-to-left, so the distance travelled is taken as an absolute
 *      value before being compared against the scrollable extent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { useScrollOverflow, type ScrollOverflowState } from './use-scroll-overflow'

/**
 * A stand-in for a scrolling element. jsdom performs no layout, so every geometric property it could
 * report is zero; each is defined explicitly here so the hook sees the numbers a browser would give it.
 */
function makeScroller({ scrollWidth, clientWidth, scrollLeft = 0 }: {
    scrollWidth: number
    clientWidth: number
    scrollLeft?: number
}) {
    const element = document.createElement('div')

    Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth })
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth })
    Object.defineProperty(element, 'scrollLeft', {
        configurable: true,
        writable: true,
        value: scrollLeft,
    })

    document.body.appendChild(element)
    return element
}

/**
 * Renders the hook and attaches `element` through its callback ref, which is how a consumer hands the
 * scrolling node over. Attachment happens inside `act` so the resulting state settles before assertions.
 */
const observe = (element: HTMLElement | null) => {
    const rendered = renderHook(() => useScrollOverflow<HTMLElement>())
    act(() => {
        rendered.result.current.ref(element)
    })
    return rendered
}

/** The reported state without the callback ref, so a whole-object assertion stays readable. */
const state = (result: { current: ScrollOverflowState }): ScrollOverflowState => ({
    overflows: result.current.overflows,
    atStart: result.current.atStart,
    atEnd: result.current.atEnd,
})

afterEach(() => {
    document.body.innerHTML = ''
})

describe('useScrollOverflow', () => {
    it('reports no overflow for a container whose content fits', () => {
        const { result } = observe(makeScroller({ scrollWidth: 600, clientWidth: 600 }))

        expect(result.current.overflows).toBe(false)
        // Both edges read true, which is why callers must test `overflows` before drawing a marker.
        expect(result.current.atStart).toBe(true)
        expect(result.current.atEnd).toBe(true)
    })

    it('reports overflow with content ahead when scrolled to the start', () => {
        const { result } = observe(
            makeScroller({ scrollWidth: 1200, clientWidth: 600, scrollLeft: 0 }),
        )

        expect(state(result)).toEqual({ overflows: true, atStart: true, atEnd: false })
    })

    it('reports overflow with content behind when scrolled to the end', () => {
        const { result } = observe(
            makeScroller({ scrollWidth: 1200, clientWidth: 600, scrollLeft: 600 }),
        )

        expect(state(result)).toEqual({ overflows: true, atStart: false, atEnd: true })
    })

    it('reports content on both sides while scrolled through the middle', () => {
        const { result } = observe(
            makeScroller({ scrollWidth: 1200, clientWidth: 600, scrollLeft: 300 }),
        )

        expect(state(result)).toEqual({ overflows: true, atStart: false, atEnd: false })
    })

    it('recomputes on scroll', () => {
        const element = makeScroller({ scrollWidth: 1200, clientWidth: 600, scrollLeft: 0 })
        const { result } = observe(element)

        expect(result.current.atEnd).toBe(false)

        act(() => {
            ; (element as unknown as { scrollLeft: number }).scrollLeft = 600
            element.dispatchEvent(new Event('scroll'))
        })

        expect(result.current.atEnd).toBe(true)
        expect(result.current.atStart).toBe(false)
    })

    /**
     * Right-to-left engines report `scrollLeft` as a negative distance from the inline-start edge, so a
     * naive comparison would place an RTL table permanently at its start.
     */
    it('treats a negative scroll offset as a distance travelled', () => {
        const { result } = observe(
            makeScroller({ scrollWidth: 1200, clientWidth: 600, scrollLeft: -600 }),
        )

        expect(state(result)).toEqual({ overflows: true, atStart: false, atEnd: true })
    })

    it('tolerates a sub-pixel shortfall at either extreme', () => {
        const { result } = observe(
            makeScroller({ scrollWidth: 1200, clientWidth: 600, scrollLeft: 599.6 }),
        )

        // Without the tolerance this reads as "there is more content ahead" on a fully scrolled table.
        expect(result.current.atEnd).toBe(true)
    })

    it('treats a sub-pixel difference between content and container as no overflow', () => {
        const { result } = observe(makeScroller({ scrollWidth: 600.4, clientWidth: 600 }))

        expect(result.current.overflows).toBe(false)
    })

    it('is inert until the container attaches, rather than throwing', () => {
        const { result } = observe(null)

        expect(state(result)).toEqual({ overflows: false, atStart: true, atEnd: true })
    })

    /**
     * The case that matters most in practice, and the one a ref-in-dependencies effect gets wrong.
     *
     * Every grid in the workbench renders an empty-state placeholder until its rows arrive, and the
     * placeholder is returned BEFORE the scroll container exists - so nothing is attached on the first
     * render. An earlier version of this hook took a ref OBJECT and subscribed in an effect listing it as
     * a dependency; a ref object's identity never changes, so that effect ran exactly once, on the render
     * where there was nothing to subscribe to. The hook then stayed permanently silent on a grid that did
     * overflow, which is how one grid ended up with a pinned column and no scroll region while its
     * sibling had both. A callback ref fixes it because React invokes it on attach and on detach.
     */
    it('picks up an element that only attaches on a later render', () => {
        const { result } = renderHook(() => useScrollOverflow<HTMLElement>())
        expect(result.current.overflows).toBe(false)

        // The rows arrive, the real scroll container replaces the placeholder, and React invokes the
        // callback ref with the node.
        act(() => {
            result.current.ref(makeScroller({ scrollWidth: 1200, clientWidth: 600 }))
        })

        expect(state(result)).toEqual({ overflows: true, atStart: true, atEnd: false })
    })

    it('follows the element when one scroll container replaces another', () => {
        const { result } = observe(makeScroller({ scrollWidth: 1200, clientWidth: 600 }))
        expect(result.current.overflows).toBe(true)

        // A narrower data set re-renders the grid with a container that no longer overflows.
        act(() => {
            result.current.ref(makeScroller({ scrollWidth: 600, clientWidth: 600 }))
        })

        expect(result.current.overflows).toBe(false)
    })

    it('stops reporting overflow once the container detaches', () => {
        const { result } = observe(makeScroller({ scrollWidth: 1200, clientWidth: 600 }))
        expect(result.current.overflows).toBe(true)

        act(() => {
            result.current.ref(null)
        })

        expect(result.current.overflows).toBe(false)
    })

    it('detaches its listener and observer on unmount', () => {
        const element = makeScroller({ scrollWidth: 1200, clientWidth: 600 })
        const remove = vi.spyOn(element, 'removeEventListener')

        const { unmount } = observe(element)
        unmount()

        expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function))
    })
})

/**
 * The RESIZE path is deferred by one animation frame; the scroll path is not. This exists because of a
 * genuine re-entrancy loop, not as a general-purpose throttle.
 *
 * A ResizeObserver callback that changes the size of something it observes re-enters the same delivery
 * cycle. The browser breaks the cycle by abandoning the remaining notifications and reporting
 * "ResizeObserver loop completed with undelivered notifications", which surfaced as an uncaught
 * `window.onerror` on the workbench. This hook closes exactly that loop: flipping `overflows` to true
 * adds a border to the trailing sticky cells, that border changes the content width, and the observed
 * content element therefore resizes as a DIRECT RESULT of the observation.
 *
 * A frame's deferral moves the state update out of the delivery cycle. Both halves are pinned: that the
 * notification does not settle synchronously, and that it does settle on the next frame.
 */
describe('useScrollOverflow resize handling', () => {

    /** A scroller whose geometry can be changed after the hook has already measured it. */
    function makeResizableScroller(initial: { scrollWidth: number; clientWidth: number }) {
        const element = document.createElement('div')
        let { scrollWidth, clientWidth } = initial

        Object.defineProperty(element, 'scrollWidth', { configurable: true, get: () => scrollWidth })
        Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => clientWidth })
        Object.defineProperty(element, 'scrollLeft', { configurable: true, writable: true, value: 0 })
        // Observed as well as the scrollport itself, so it must exist.
        element.appendChild(document.createElement('div'))
        document.body.appendChild(element)

        return {
            element,
            resizeContentTo(next: number) {
                scrollWidth = next
            },
            resizePortTo(next: number) {
                clientWidth = next
            },
        }
    }

    /** Captures the ResizeObserver callback and lets the test hold the animation frame. */
    function instrument() {
        const callbacks: ResizeObserverCallback[] = []
        const original = globalThis.ResizeObserver
        globalThis.ResizeObserver = class {
            constructor(callback: ResizeObserverCallback) {
                callbacks.push(callback)
            }
            observe(): void { }
            unobserve(): void { }
            disconnect(): void { }
        } as unknown as typeof ResizeObserver

        const frames: FrameRequestCallback[] = []
        const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
            frames.push(callback)
            return frames.length
        })
        const caf = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined)

        return {
            notify: () => callbacks.forEach((callback) =>
                callback([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)),
            runFrames: () => {
                const pending = frames.splice(0, frames.length)
                pending.forEach((callback) => callback(0))
            },
            pendingFrames: () => frames.length,
            scheduledCount: () => raf.mock.calls.length,
            cancelledCount: () => caf.mock.calls.length,
            restore: () => {
                globalThis.ResizeObserver = original
                raf.mockRestore()
                caf.mockRestore()
            },
        }
    }

    let harness: ReturnType<typeof instrument> | undefined

    afterEach(() => {
        harness?.restore()
        harness = undefined
    })

    it('does not settle a resize notification inside the observation cycle', () => {
        harness = instrument()
        const scroller = makeResizableScroller({ scrollWidth: 600, clientWidth: 600 })
        const { result } = observe(scroller.element)

        expect(result.current.overflows).toBe(false)

        // The content grew, which is what the observer is there to notice.
        scroller.resizeContentTo(1200)
        act(() => {
            harness!.notify()
        })

        // Still false: settling here is what re-enters the delivery cycle and drops notifications.
        expect(result.current.overflows).toBe(false)
        expect(harness.pendingFrames()).toBe(1)

        act(() => {
            harness!.runFrames()
        })

        expect(state(result)).toEqual({ overflows: true, atStart: true, atEnd: false })
    })

    it('coalesces several notifications in one cycle into a single measurement', () => {
        // Two elements are observed - the scrollport and its content - and both describe the same layout,
        // so a change that resizes both must not be measured twice.
        harness = instrument()
        const scroller = makeResizableScroller({ scrollWidth: 600, clientWidth: 600 })
        observe(scroller.element)

        const before = harness.scheduledCount()
        act(() => {
            harness!.notify()
            harness!.notify()
            harness!.notify()
        })

        expect(harness.scheduledCount() - before).toBe(1)
        expect(harness.pendingFrames()).toBe(1)
    })

    it('schedules again once the pending frame has run', () => {
        // The coalescing must not latch: a later, genuinely different resize still has to be measured.
        harness = instrument()
        const scroller = makeResizableScroller({ scrollWidth: 600, clientWidth: 600 })
        const { result } = observe(scroller.element)

        scroller.resizeContentTo(1200)
        act(() => {
            harness!.notify()
            harness!.runFrames()
        })
        expect(result.current.overflows).toBe(true)

        scroller.resizePortTo(1200)
        act(() => {
            harness!.notify()
        })
        expect(harness.pendingFrames()).toBe(1)

        act(() => {
            harness!.runFrames()
        })
        expect(result.current.overflows).toBe(false)
    })

    it('cancels a pending frame when the container goes away', () => {
        // Otherwise the frame runs against a detached element after unmount.
        harness = instrument()
        const scroller = makeResizableScroller({ scrollWidth: 600, clientWidth: 600 })
        const rendered = observe(scroller.element)

        act(() => {
            harness!.notify()
        })
        expect(harness.pendingFrames()).toBe(1)

        const cancelledBefore = harness.cancelledCount()
        rendered.unmount()

        expect(harness.cancelledCount()).toBeGreaterThan(cancelledBefore)
    })
})
