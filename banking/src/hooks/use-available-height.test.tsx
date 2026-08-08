/**
 * Behavioural specification for `useAvailableHeight`.
 *
 * This hook replaced an arithmetic height calculation that was wrong at every viewport width: the
 * workbench measured its header once, before the header had data, then subtracted a constant for
 * everything between the header and the list. The list's bottom edge consequently sat below the fold at
 * every width (37px at 1920 through 269px at 768), and a plain window resize made it worse still because
 * nothing recomputed.
 *
 * Four behaviours here are load-bearing and each is pinned below:
 *   1. the height is measured from the element's own position, on first paint;
 *   2. it is derived from the DOCUMENT-relative top, so scrolling cannot resize it;
 *   3. it recomputes on window resize, when the document reflows, AND when its own column changes size;
 *   4. it never returns less than the floor, because a virtualised list measured at zero renders no rows.
 *
 * jsdom performs no layout, so the probe below supplies the element's rect itself. The rect is installed
 * through a callback ref, which React runs during commit and therefore BEFORE the hook's layout effect -
 * the same order a real browser gives the hook.
 */

import { describe, expect, it, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'

import { useAvailableHeight } from './use-available-height'

const rectAt = (top: number) => ({
	top,
	bottom: top,
	left: 0,
	right: 0,
	width: 0,
	height: 0,
	x: 0,
	y: top,
	toJSON: () => ({})
}) as DOMRect

/** Renders the hook against an element whose viewport-relative top is dictated by the test. */
const Probe = ({ top, min, gutter }: { top: number, min?: number, gutter?: number }) => {
	const [ref, height] = useAvailableHeight<HTMLDivElement>({ min, gutter })

	return (
		<div
			data-testid="probe"
			data-height={height}
			ref={(node) => {
				if (!node) return
				node.getBoundingClientRect = () => rectAt(top)
				ref.current = node
			}}
		/>
	)
}

/**
 * Renders the hook with a piece of chrome above it that a test can take away WITHOUT re-rendering.
 *
 * That is the production shape, and the reason it has to be modelled: the refusal banner above the
 * candidate pane is its own component and the only subscriber to the atom that decides whether it
 * renders, so dismissing it re-renders nothing that measures. The element's rect is answered from the
 * DOM the test is manipulating rather than from a prop, so it moves up when the chrome goes exactly as
 * it does in a browser - jsdom lays nothing out, so the rect has to be supplied either way.
 */
const ChromeProbe = ({ withChrome, withoutChrome }: { withChrome: number, withoutChrome: number }) => {
	const [ref, height] = useAvailableHeight<HTMLDivElement>({ min: 100, gutter: 0 })

	return (
		<div data-testid="column">
			<div data-testid="chrome" />
			<div
				data-testid="probe"
				data-height={height}
				ref={(node) => {
					if (!node) return
					node.getBoundingClientRect = () => rectAt(
						document.querySelector('[data-testid="chrome"]') ? withChrome : withoutChrome
					)
					ref.current = node
				}}
			/>
		</div>
	)
}

/** Lets jsdom deliver its mutation records, which it queues in a microtask. */
const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0))

const measuredHeight = () => Number(screen.getByTestId('probe').dataset.height)

const setViewportHeight = (height: number) => {
	Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
}

const setScrollY = (value: number) => {
	Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true })
}

describe('useAvailableHeight', () => {

	afterEach(() => {
		setViewportHeight(768)
		setScrollY(0)
	})

	it('leaves exactly the gutter between the element and the bottom of the viewport', () => {
		setViewportHeight(1000)

		render(<Probe top={300} min={100} gutter={24} />)

		// 1000 viewport - 300 top - 24 gutter
		expect(measuredHeight()).toBe(676)
	})

	it('QUIRK - measures from the document top, so scrolling does not resize it', () => {
		/*
		 * Using the viewport-relative top would make the height a function of the scroll position:
		 * scrolling would resize the list, which changes the page height, which moves the scroll position -
		 * a loop that never settles. Below, the element has scrolled 200px up the viewport, and the answer
		 * is unchanged because the scroll offset is added back.
		 */
		setViewportHeight(1000)

		const { rerender } = render(<Probe top={300} min={100} gutter={24} />)
		const unscrolled = measuredHeight()

		setScrollY(200)
		rerender(<Probe top={100} min={100} gutter={24} />)
		act(() => {
			window.dispatchEvent(new Event('resize'))
		})

		expect(measuredHeight()).toBe(unscrolled)
	})

	it('recomputes when the window is resized', () => {
		setViewportHeight(1000)

		render(<Probe top={400} min={100} gutter={16} />)
		expect(measuredHeight()).toBe(584)

		setViewportHeight(700)
		act(() => {
			window.dispatchEvent(new Event('resize'))
		})

		expect(measuredHeight()).toBe(284)
	})

	it('re-measures when the document reflows, not only when the window resizes', () => {
		/*
		 * The case a resize event cannot cover: the viewport is unchanged, but chrome ABOVE the element has
		 * grown - the older-transactions banner appearing, or a badge cluster wrapping - so the element has
		 * moved down and now has less room than it did.
		 */
		const observers: Array<() => void> = []
		const original = globalThis.ResizeObserver
		globalThis.ResizeObserver = class {
			constructor(callback: () => void) {
				observers.push(callback)
			}
			observe() { }
			unobserve() { }
			disconnect() { }
		} as unknown as typeof ResizeObserver

		try {
			setViewportHeight(1000)

			const { rerender } = render(<Probe top={200} min={100} gutter={0} />)
			expect(measuredHeight()).toBe(800)

			rerender(<Probe top={500} min={100} gutter={0} />)
			act(() => {
				observers.forEach((notify) => notify())
			})

			expect(measuredHeight()).toBe(500)
		} finally {
			globalThis.ResizeObserver = original
		}
	})

	it('watches its own parent, because chrome that comes and goes changes no document dimension', () => {
		/*
		 * The case observing the document cannot cover: the reset control in the filter row appears and
		 * disappears INSIDE a page whose height is fixed by the viewport. The document stays exactly as
		 * tall, so nothing fires, and the list keeps a height it measured around chrome that has since
		 * gone - it stayed 40px short until the next reload. The parent carries that chrome, so it is the
		 * thing that changes size.
		 */
		const observed: Element[] = []
		const notifiers: Array<() => void> = []
		const original = globalThis.ResizeObserver
		globalThis.ResizeObserver = class {
			constructor(callback: () => void) {
				notifiers.push(callback)
			}
			observe(target: Element) {
				observed.push(target)
			}
			unobserve() { }
			disconnect() { }
		} as unknown as typeof ResizeObserver

		try {
			setViewportHeight(1000)

			const { rerender } = render(
				<div data-testid="column">
					<Probe top={500} min={100} gutter={0} />
				</div>
			)
			expect(measuredHeight()).toBe(500)

			// The element's own column is watched, alongside the document.
			expect(observed).toContain(document.documentElement)
			expect(observed).toContain(screen.getByTestId('column'))

			// Chrome above the element goes away: it moves up, and the extra room is claimed.
			rerender(
				<div data-testid="column">
					<Probe top={460} min={100} gutter={0} />
				</div>
			)
			act(() => {
				notifiers.forEach((notify) => notify())
			})

			expect(measuredHeight()).toBe(540)
		} finally {
			globalThis.ResizeObserver = original
		}
	})

	it('attaches to the column even when the element mounts later than the hook', () => {
		/*
		 * The case that actually broke: the list this sizes renders a loading state until its request
		 * answers, so on the render where the hook mounts there is no element and no column. Reading the
		 * parent once, at that moment, watched nothing - and a document that stays exactly as tall reports
		 * nothing either, so chrome that disappeared was never noticed and the list stayed short.
		 */
		const observed: Element[] = []
		const notifiers: Array<() => void> = []
		const original = globalThis.ResizeObserver
		globalThis.ResizeObserver = class {
			constructor(callback: () => void) {
				notifiers.push(callback)
			}
			observe(target: Element) {
				observed.push(target)
			}
			unobserve() { }
			disconnect() { }
		} as unknown as typeof ResizeObserver

		try {
			setViewportHeight(1000)

			const LateProbe = ({ ready, top }: { ready: boolean, top: number }) => {
				const [ref, height] = useAvailableHeight<HTMLDivElement>({ min: 100, gutter: 0 })

				if (!ready) {
					return <span data-testid="loading">loading</span>
				}

				return (
					<div data-testid="column">
						<div
							data-testid="probe"
							data-height={height}
							ref={(node) => {
								if (!node) return
								node.getBoundingClientRect = () => rectAt(top)
								ref.current = node
							}}
						/>
					</div>
				)
			}

			const { rerender } = render(<LateProbe ready={false} top={500} />)
			expect(screen.getByTestId('loading')).toBeInTheDocument()
			// Nothing to attach to yet: only the document is watched.
			expect(observed).toEqual([document.documentElement])

			rerender(<LateProbe ready top={500} />)

			expect(observed).toContain(screen.getByTestId('column'))

			// Chrome above the element goes away; the column reports it and the room is reclaimed.
			rerender(<LateProbe ready top={420} />)
			act(() => {
				notifiers.forEach((notify) => notify())
			})

			expect(measuredHeight()).toBe(580)
		} finally {
			globalThis.ResizeObserver = original
		}
	})

	it('never drops below the floor, because a list measured at zero renders no rows', () => {
		setViewportHeight(400)

		// The element starts below the fold entirely, so the arithmetic answer is negative.
		render(<Probe top={900} min={240} gutter={16} />)

		expect(measuredHeight()).toBe(240)
	})

	it('tolerates an environment without ResizeObserver', () => {
		const original = globalThis.ResizeObserver
		// @ts-expect-error - deliberately removing a browser global the hook must not depend on
		delete globalThis.ResizeObserver

		try {
			setViewportHeight(900)

			render(<Probe top={100} min={100} gutter={0} />)

			expect(measuredHeight()).toBe(800)
		} finally {
			globalThis.ResizeObserver = original
		}
	})

	it('applies its documented defaults', () => {
		setViewportHeight(1000)

		render(<Probe top={100} />)

		// Default gutter of 16, default floor of 240.
		expect(measuredHeight()).toBe(884)
	})

	it('reclaims the room when chrome above it is REMOVED, though no box around it changes size', async () => {
		/*
		 * The case no size-driven trigger can see, and the one this was reported for. The refusal banner
		 * above the candidate pane sits inside a wrapper with a `min-height` floor, so removing its 135px
		 * left that wrapper - and every ancestor out to `body` - at exactly the same height, while the
		 * pane's own top moved up by 135px. Nothing resized, the window did not resize, and the pane's
		 * component did not re-render, so the pane kept the height it had measured with the banner there
		 * and left a 135px blank band below itself until the next window resize.
		 *
		 * The chrome is removed outside React deliberately: a re-render would re-measure through the
		 * layout effect and prove nothing about the observation.
		 */
		setViewportHeight(1000)

		render(<ChromeProbe withChrome={500} withoutChrome={365} />)
		expect(measuredHeight()).toBe(500)

		await act(async () => {
			screen.getByTestId('chrome').remove()
			await flushMutations()
		})

		// 1000 viewport - 365 top - 0 gutter: the 135px the chrome vacated is now the list's.
		expect(measuredHeight()).toBe(635)
	})

	it('ignores mutations INSIDE itself, so a virtualised row mounting is not a re-measure', async () => {
		/*
		 * Why the ancestors are watched one level each rather than as subtrees. The element's own
		 * descendants are the virtual rows, which mount and unmount continuously while scrolling; treating
		 * those as a reason to re-measure would force a layout read on every scroll frame to answer a
		 * question the container's unchanged position has already answered.
		 */
		setViewportHeight(1000)

		render(<ChromeProbe withChrome={500} withoutChrome={365} />)
		expect(measuredHeight()).toBe(500)

		// A shorter viewport with no resize event dispatched: from here ANY measurement returns a
		// different number, so an unchanged number is proof that none was taken.
		setViewportHeight(800)

		await act(async () => {
			screen.getByTestId('probe').appendChild(document.createElement('div'))
			await flushMutations()
		})
		expect(measuredHeight()).toBe(500)

		// And the observation is demonstrably live - chrome ABOVE it still reports, at the new viewport.
		await act(async () => {
			screen.getByTestId('chrome').remove()
			await flushMutations()
		})
		expect(measuredHeight()).toBe(435)
	})

	it('watches every ancestor up to body for structure, and lets go on unmount', () => {
		const observed: Array<{ target: Node, options?: MutationObserverInit }> = []
		let disconnects = 0
		const original = globalThis.MutationObserver
		globalThis.MutationObserver = class {
			// No constructor: this stub never notifies, because what is under test here is WHICH targets
			// are watched and that they are let go of, not what a notification does.
			observe(target: Node, options?: MutationObserverInit) {
				observed.push({ target, options })
			}
			disconnect() {
				disconnects += 1
			}
			takeRecords() {
				return []
			}
		} as unknown as typeof MutationObserver

		try {
			setViewportHeight(1000)

			const { unmount } = render(<ChromeProbe withChrome={500} withoutChrome={365} />)

			const targets = observed.map(({ target }) => target)
			expect(targets).toContain(screen.getByTestId('column'))
			// Right the way out to `body`, which is where portalled overlays mount and as far out as
			// anything that can move the element vertically lives.
			expect(targets).toContain(document.body)
			// One level of each ancestor, never a subtree - see the test above for what that buys.
			expect(observed.every(({ options }) => options?.childList === true)).toBe(true)
			expect(observed.some(({ options }) => options?.subtree)).toBe(false)

			const before = disconnects
			unmount()
			expect(disconnects).toBeGreaterThan(before)
		} finally {
			globalThis.MutationObserver = original
		}
	})

	it('tolerates an environment without MutationObserver', () => {
		const original = globalThis.MutationObserver
		// @ts-expect-error - deliberately removing a browser global the hook must not depend on
		delete globalThis.MutationObserver

		try {
			setViewportHeight(900)

			render(<Probe top={100} min={100} gutter={0} />)

			expect(measuredHeight()).toBe(800)
		} finally {
			globalThis.MutationObserver = original
		}
	})
})
