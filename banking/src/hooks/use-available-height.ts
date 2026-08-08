import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Options for {@link useAvailableHeight}.
 */
type AvailableHeightOptions = {
	/**
	 * Pixels to leave between the element's bottom edge and the bottom of the viewport, so a scroll
	 * container never sits flush against the window edge.
	 */
	gutter?: number
	/**
	 * Floor for the returned height. A virtualised list measured to (near) zero renders no rows at all,
	 * so collapsing to nothing is worse than overflowing.
	 *
	 * When the floor engages - a viewport too short for the chrome above the element, e.g. 700px tall
	 * with a wrapped header - the element does extend past the fold, and the PAGE grows a scrollbar so
	 * every row stays reachable. That is the deliberate trade: a few rows plus a page scroll beats a
	 * list too short to show anything.
	 */
	min?: number
}

/**
 * Measures how much vertical room is left for an element, from where it actually sits to the bottom of
 * the viewport, and keeps that measurement current.
 *
 * WHY THIS EXISTS. The reconciliation workbench sizes its virtual lists in JavaScript, because
 * `@tanstack/react-virtual` needs a pixel height for its scroll container rather than a CSS one. The
 * height used to be derived arithmetically - viewport height, minus a header height captured once, minus
 * a hard-coded allowance for everything in between. Both halves of that were wrong in practice:
 *
 *   - the header was measured in a `useLayoutEffect` with an empty dependency array, so it was read
 *     BEFORE the account picker and balance tiles had data and never re-read afterwards, understating
 *     the real header by over 100px;
 *   - the allowance could not account for the chrome that varies with viewport width - the filter row,
 *     and above all the older-unreconciled-transactions banner, which wraps to many more lines as the
 *     window narrows.
 *
 * Both errors pushed the list's bottom edge below the fold at every width, worst at the narrow end, and
 * a plain window resize made it worse still because nothing recomputed.
 *
 * Measuring the element's own position removes both classes of error at once: whatever renders above it,
 * and however that reflows, the answer is read from the layout rather than predicted from constants.
 *
 * SCROLL INVARIANCE. The measurement uses the element's DOCUMENT-relative top (`rect.top +
 * window.scrollY`), not its viewport-relative top. Using the viewport-relative value would make the
 * height a function of the scroll position, so scrolling the page would resize the list, which would
 * change the page height, which would move the scroll position - a feedback loop that never settles.
 *
 * CONVERGENCE. Recomputation is driven by window resizes and by a `ResizeObserver` on the document
 * element AND on the element's own parent, which is what catches the chrome above the element reflowing
 * (a banner appearing, a badge cluster wrapping, a filter reset control coming and going). The parent is
 * observed as well as the document because chrome that appears and disappears INSIDE a fixed-height page
 * changes no document dimension at all: when the filter row lost a line, the document stayed exactly as
 * tall, nothing fired, and the list kept a height measured around chrome that was no longer there.
 *
 * The parent is tracked across renders rather than read once, because the element being measured is
 * routinely absent when this hook first runs: the list it sizes renders a loading state until its request
 * answers, so a one-off read of `ref.current` finds nothing and the column is never watched at all. That
 * is what left the list 40-80px short after the filter row shrank - the document was still being watched,
 * and a document that stays exactly as tall reports nothing, so only chrome that GREW was ever noticed.
 *
 * SIZE IS NOT POSITION, which is why a `MutationObserver` is watched as well. A `ResizeObserver` reports
 * that a box changed SIZE; it says nothing about a box that merely MOVED. Chrome above the element can
 * disappear and move the element up without a single observed box changing size, and then no size-driven
 * trigger can fire at all: the refusal banner sits inside a wrapper carrying a `min-height` floor, so
 * removing its 135px left that wrapper at an unchanged 901px and every ancestor out to `body` unchanged
 * too - measured, not assumed - while the element's own top moved up by exactly 135px. The list kept the
 * height it had measured with the banner present and left a 135px blank band below itself, and because
 * nothing was pending it never recovered; only a window resize, which re-measures for its own reasons,
 * put it right.
 *
 * A structural change is the honest signal there. Chrome appearing or disappearing above the element is
 * an element added to or removed from one of its ancestors, so `childList` on each ancestor catches it
 * whether or not anything resizes. `subtree` is deliberately NOT used: the element's own descendants are
 * the virtualised rows, which mount and unmount continuously while scrolling, and observing those would
 * force a layout read on every scroll frame to answer a question their own container's position cannot
 * have changed. Ancestors only, one level each.
 *
 * The element measured is expected to be the LAST thing in its column, so its own height does not feed
 * back into its own top; and because the hook only stores a changed value, an observation that resolves
 * to the same number ends the cycle rather than re-rendering.
 *
 * @param options gutter and minimum height, both optional
 * @returns a ref to attach to the element being sized, and the height in pixels available to it
 */
export const useAvailableHeight = <T extends HTMLElement = HTMLDivElement>(
	options: AvailableHeightOptions = {}
): [React.RefObject<T | null>, number] => {
	const { gutter = 16, min = 240 } = options

	const ref = useRef<T | null>(null)
	const [height, setHeight] = useState(min)
	const observerRef = useRef<ResizeObserver | null>(null)
	const mutationObserverRef = useRef<MutationObserver | null>(null)
	/** The column currently being watched, so re-checking it costs nothing once it is settled. */
	const watchedColumnRef = useRef<HTMLElement | null>(null)
	/**
	 * The ancestor chain currently watched for structural change, in order from the element outwards.
	 * Held so an unchanged chain - the settled case, re-checked on every render - costs one length
	 * comparison and nothing else.
	 */
	const watchedAncestorsRef = useRef<HTMLElement[]>([])

	const measure = useCallback(() => {
		const element = ref.current
		if (!element) {
			return
		}

		const rect = element.getBoundingClientRect()
		// Document-relative, so the result does not move with the scroll position - see SCROLL
		// INVARIANCE above.
		const documentTop = rect.top + window.scrollY
		const available = window.innerHeight - documentTop - gutter

		setHeight((previous) => {
			const next = Math.max(min, Math.round(available))
			// Only commit a real change: an unchanged value would still re-render, and this hook is
			// driven by an observer that fires on every layout change.
			return previous === next ? previous : next
		})
	}, [gutter, min])

	/**
	 * Points the observer at the column the element sits in, whenever that column changes.
	 *
	 * Kept in refs rather than state so it can be re-checked on every render without causing one, and a
	 * no-op until the observer exists, so it is simply retried on the next render in an environment - or
	 * at a moment - where there is nothing to attach to yet.
	 */
	const watchColumn = useCallback(() => {
		const observer = observerRef.current
		if (!observer) {
			return
		}

		const column = ref.current?.parentElement ?? null
		if (column === watchedColumnRef.current) {
			return
		}

		if (watchedColumnRef.current) {
			observer.unobserve(watchedColumnRef.current)
		}

		watchedColumnRef.current = column

		if (column) {
			observer.observe(column)
		}
	}, [])

	/**
	 * Points the mutation observer at every ancestor of the element, whenever that chain changes.
	 *
	 * Watches one level of each ancestor - not a subtree - so that chrome added above the element, or
	 * taken away from above it, is noticed even when it changes no box's size. See SIZE IS NOT POSITION
	 * above for the case this exists for. The walk stops at `body`, which is as far as anything that can
	 * move the element vertically lives, and is also where portalled overlays mount.
	 *
	 * Re-targeted by disconnecting and re-observing, because `MutationObserver` has no per-target
	 * `unobserve`. That is bounded work: the chain is a handful of elements and changes only when the
	 * element itself is re-parented, which for these lists means mounting after their request answered.
	 */
	const watchAncestors = useCallback(() => {
		const observer = mutationObserverRef.current
		if (!observer) {
			return
		}

		const ancestors: HTMLElement[] = []
		for (let node = ref.current?.parentElement ?? null; node; node = node.parentElement) {
			ancestors.push(node)
			if (node === document.body) {
				break
			}
		}

		const watched = watchedAncestorsRef.current
		const unchanged = watched.length === ancestors.length &&
			watched.every((element, index) => element === ancestors[index])
		if (unchanged) {
			return
		}

		observer.disconnect()
		watchedAncestorsRef.current = ancestors

		for (const ancestor of ancestors) {
			observer.observe(ancestor, { childList: true })
		}
	}, [])

	/*
	 * Layout effect rather than effect: the first measurement must land before the browser paints, or the
	 * list is visibly sized twice on every mount. Deliberately un-gated - it runs after EVERY render,
	 * because the element can attach on any of them: the list this sizes renders a loading state until its
	 * request answers, so on the render where the hook mounts there is nothing to measure or attach to.
	 * Re-measuring is a rect read plus arithmetic, and only a changed value is committed, so a settled
	 * layout costs one measurement and no re-render.
	 */
	useLayoutEffect(() => {
		watchColumn()
		watchAncestors()
		measure()
	})

	useEffect(() => {
		window.addEventListener('resize', measure)

		// Observing the document element catches everything a resize event does not: the header
		// populating from its own requests, a banner appearing, text rewrapping. `ResizeObserver` is not
		// implemented by jsdom, so its absence is tolerated rather than assumed - the resize listener
		// alone still keeps the value current in that environment.
		const observer = typeof ResizeObserver === 'undefined'
			? null
			: new ResizeObserver(() => measure())
		observerRef.current = observer
		observer?.observe(document.documentElement)

		// Structural change above the element, which no size-driven trigger can see when the chrome that
		// went away leaves every surrounding box the same size. Tolerated as absent for the same reason
		// as `ResizeObserver`: an environment without it still keeps the value current through resizes
		// and re-renders.
		const mutationObserver = typeof MutationObserver === 'undefined'
			? null
			: new MutationObserver(() => measure())
		mutationObserverRef.current = mutationObserver

		// The column carries the chrome above the element, so it shrinks and grows when that chrome does
		// even while the document's own dimensions hold steady. `ResizeObserver` reports each new target
		// once on attachment, so this also re-measures as soon as the column appears.
		watchColumn()
		watchAncestors()

		return () => {
			window.removeEventListener('resize', measure)
			observer?.disconnect()
			observerRef.current = null
			watchedColumnRef.current = null
			mutationObserver?.disconnect()
			mutationObserverRef.current = null
			watchedAncestorsRef.current = []
		}
	}, [measure, watchColumn, watchAncestors])

	return [ref, height]
}
