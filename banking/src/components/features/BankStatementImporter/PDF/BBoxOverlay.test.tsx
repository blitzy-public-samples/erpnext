/**
 * Behavioural specification for the PDF region selector.
 *
 * This is the control a reviewer uses to tell the importer WHERE on a scanned statement page the
 * transactions actually are. Getting it wrong does not merely look bad: the committed rectangle is sent
 * straight back to the server, which re-reads the table from that region, so a degenerate or
 * off-page rectangle produces a wrong or empty transaction list.
 *
 * The component works in PDF POINTS (top-left origin) while the browser gives it PIXELS, and the
 * conversion runs through the container's rendered size. Every behaviour below is about keeping that
 * conversion and the resulting rectangle sane.
 *
 * Five behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. A rectangle dragged inside out is NORMALISED rather than rejected - dragging the left edge past
 *      the right edge swaps them instead of producing negative width.
 *   2. A minimum size is enforced, because a zero-height region would extract nothing.
 *   3. The rectangle is clamped to the page, because the server cannot read outside it.
 *   4. Nothing is committed until the pointer is RELEASED, so the server is not re-queried on every
 *      mouse move.
 *   5. An authoritative rectangle arriving from the server REPLACES the local draft, which is what
 *      makes a server re-extract visible rather than being overwritten by stale local state.
 *
 * jsdom implements neither pointer capture nor layout, so both are stubbed - the pointer-capture
 * methods because the component calls them, and the container's rect because the points-per-pixel
 * conversion divides by its width and height.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createRef } from 'react'

import BBoxOverlay from './BBoxOverlay'

type Bbox = [number, number, number, number]

/** A page one point per pixel, so a pixel delta reads as the same number of points. */
const PAGE_WIDTH = 600
const PAGE_HEIGHT = 800
const RENDERED_WIDTH = 600
const RENDERED_HEIGHT = 800

const COLOR = { border: 'border-blue-500', bg: 'bg-blue-500/10', swatch: 'bg-blue-500' }

const START: Bbox = [100, 100, 300, 200]

interface OverlayOptions {
	bbox?: Bbox
	included?: boolean
	disabled?: boolean
}

const renderOverlay = ({ bbox = START, included = true, disabled }: OverlayOptions = {}) => {
	const onCommit = vi.fn<(bbox: Bbox) => void>()
	const containerRef = createRef<HTMLDivElement>()

	const view = render(
		<div
			ref={containerRef}
			// The rect is stubbed below; this only has to exist as the reference element.
			style={{ position: 'relative', width: RENDERED_WIDTH, height: RENDERED_HEIGHT }}
		>
			<BBoxOverlay
				bbox={bbox}
				pageWidth={PAGE_WIDTH}
				pageHeight={PAGE_HEIGHT}
				color={COLOR}
				label="Table 1"
				included={included}
				disabled={disabled}
				containerRef={containerRef}
				onCommit={onCommit}
			/>
		</div>
	)

	// jsdom performs no layout, so every rect is zero and the pixel-to-point conversion would divide
	// by zero. Stubbing the container's rect is what makes the arithmetic testable at all.
	if (containerRef.current) {
		containerRef.current.getBoundingClientRect = () =>
			({
				x: 0,
				y: 0,
				top: 0,
				left: 0,
				right: RENDERED_WIDTH,
				bottom: RENDERED_HEIGHT,
				width: RENDERED_WIDTH,
				height: RENDERED_HEIGHT,
				toJSON: () => ({})
			}) as DOMRect
	}

	const box = screen.getByText('Table 1').parentElement as HTMLElement

	return { onCommit, box, ...view }
}

/**
 * Reads the rendered rectangle back out of its percentage style, in PDF points.
 *
 * The round trip through a percentage is lossy - 300 points on a 600-point page becomes "50%" and
 * returns as 299.999999999999 - so the result is rounded to whole points. That is the right precision
 * to assert at anyway: the server receives points, and a millionth of a point is not a real difference.
 */
const readBox = (box: HTMLElement): Bbox => {
	const pct = (value: string) => Number.parseFloat(value)
	const x0 = (pct(box.style.left) / 100) * PAGE_WIDTH
	const top = (pct(box.style.top) / 100) * PAGE_HEIGHT
	const width = (pct(box.style.width) / 100) * PAGE_WIDTH
	const height = (pct(box.style.height) / 100) * PAGE_HEIGHT

	return [
		Math.round(x0),
		Math.round(top),
		Math.round(x0 + width),
		Math.round(top + height)
	]
}

const dragBy = (
	box: HTMLElement,
	{ dx, dy, handle }: { dx: number; dy: number; handle?: string }
) => {
	const target = handle
		? (box.querySelector(`[data-handle="${handle}"]`) as HTMLElement)
		: box

	fireEvent.pointerDown(target, { pointerId: 1, clientX: 0, clientY: 0, bubbles: true })
	fireEvent.pointerMove(box, { pointerId: 1, clientX: dx, clientY: dy, bubbles: true })
	fireEvent.pointerUp(box, { pointerId: 1, clientX: dx, clientY: dy, bubbles: true })
}

describe('BBoxOverlay', () => {

	beforeEach(() => {
		// The component calls both unconditionally; jsdom implements neither.
		HTMLElement.prototype.setPointerCapture = vi.fn()
		HTMLElement.prototype.releasePointerCapture = vi.fn()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('what it draws', () => {

		it('positions the rectangle proportionally to the page', () => {
			const { box } = renderOverlay()

			// Percentages rather than pixels, so the overlay stays aligned when the page image is
			// scaled to the available width.
			expect(readBox(box)).toEqual(START)
		})

		it('names the table it belongs to', () => {
			renderOverlay()

			// With several regions on one page, the label is the only thing tying a rectangle to the
			// row that toggles it.
			expect(screen.getByText('Table 1')).toBeInTheDocument()
		})

		it('dims a region that is excluded from the import', () => {
			const { box } = renderOverlay({ included: false })

			// An excluded region still has to be visible - a reviewer needs to see what they chose to
			// leave out - so it is dimmed rather than hidden.
			expect(box.className).toContain('opacity-40')
			expect(box.className).not.toContain(COLOR.bg)
		})

		it('fills a region that is included', () => {
			const { box } = renderOverlay({ included: true })

			expect(box.className).toContain(COLOR.bg)
			expect(box.className).not.toContain('opacity-40')
		})

		it('offers four corner handles for resizing', () => {
			const { box } = renderOverlay()

			expect(box.querySelectorAll('[data-handle]')).toHaveLength(4)
		})
	})

	describe('moving the whole region', () => {

		it('translates all four edges by the same amount', () => {
			const { box, onCommit } = renderOverlay()

			dragBy(box, { dx: 50, dy: 25 })

			// A move must not change the size, or a reviewer nudging a box would silently re-crop it.
			expect(onCommit).toHaveBeenCalledWith([150, 125, 350, 225])
		})

		it('QUIRK - commits only on release, not on every move', () => {
			// Each commit debounces into a server re-extract, so committing per move would fire a
			// storm of extractions for one drag.
			const { box, onCommit } = renderOverlay()

			fireEvent.pointerDown(box, { pointerId: 1, clientX: 0, clientY: 0 })
			fireEvent.pointerMove(box, { pointerId: 1, clientX: 10, clientY: 10 })
			fireEvent.pointerMove(box, { pointerId: 1, clientX: 20, clientY: 20 })
			fireEvent.pointerMove(box, { pointerId: 1, clientX: 30, clientY: 30 })

			expect(onCommit).not.toHaveBeenCalled()

			// The draft still tracks the pointer, so the drag is visibly live.
			expect(readBox(box)).toEqual([130, 130, 330, 230])

			fireEvent.pointerUp(box, { pointerId: 1, clientX: 30, clientY: 30 })

			expect(onCommit).toHaveBeenCalledTimes(1)
			expect(onCommit).toHaveBeenCalledWith([130, 130, 330, 230])
		})

		it('QUIRK - clamps a region dragged off the top-left corner back onto the page', () => {
			// The server can only read inside the page, so an off-page rectangle would extract
			// nothing at all.
			const { box, onCommit } = renderOverlay()

			dragBy(box, { dx: -500, dy: -500 })

			const [x0, top] = onCommit.mock.calls[0][0]
			expect(x0).toBe(0)
			expect(top).toBe(0)
		})

		it('QUIRK - clamps a region dragged off the bottom-right corner too', () => {
			const { box, onCommit } = renderOverlay()

			dragBy(box, { dx: 1000, dy: 1000 })

			const [, , x1, bottom] = onCommit.mock.calls[0][0]
			expect(x1).toBe(PAGE_WIDTH)
			expect(bottom).toBe(PAGE_HEIGHT)
		})
	})

	describe('resizing from a corner', () => {

		it('moves only the west and north edges from the north-west handle', () => {
			const { box, onCommit } = renderOverlay()

			dragBy(box, { dx: 20, dy: 10, handle: 'nw' })

			// The opposite corner must stay pinned, or a resize would behave like a move.
			expect(onCommit).toHaveBeenCalledWith([120, 110, 300, 200])
		})

		it('moves only the east and south edges from the south-east handle', () => {
			const { box, onCommit } = renderOverlay()

			dragBy(box, { dx: 40, dy: 30, handle: 'se' })

			expect(onCommit).toHaveBeenCalledWith([100, 100, 340, 230])
		})

		it('moves the east edge and the north edge from the north-east handle', () => {
			const { box, onCommit } = renderOverlay()

			dragBy(box, { dx: 15, dy: -25, handle: 'ne' })

			expect(onCommit).toHaveBeenCalledWith([100, 75, 315, 200])
		})

		it('moves the west edge and the south edge from the south-west handle', () => {
			const { box, onCommit } = renderOverlay()

			dragBy(box, { dx: -30, dy: 45, handle: 'sw' })

			expect(onCommit).toHaveBeenCalledWith([70, 100, 300, 245])
		})

		it('QUIRK - normalises a rectangle dragged inside out rather than rejecting it', () => {
			// Dragging the west edge past the east edge is an easy accident. Swapping is friendlier
			// than refusing, and it keeps width positive, which the percentage style depends on.
			const { box, onCommit } = renderOverlay()

			// The west edge starts at 100 and the east edge at 300; +260 puts west at 360.
			dragBy(box, { dx: 260, dy: 0, handle: 'nw' })

			const [x0, , x1] = onCommit.mock.calls[0][0]
			expect(x1).toBeGreaterThan(x0)
		})

		it('QUIRK - enforces a minimum size, so a collapsed region cannot be committed', () => {
			// A zero-height region extracts no rows, and the reviewer would see an empty table with
			// no explanation.
			const { box, onCommit } = renderOverlay()

			// Drag the north edge 200 points down, onto the south edge.
			dragBy(box, { dx: 0, dy: 200, handle: 'nw' })

			const [, top, , bottom] = onCommit.mock.calls[0][0]
			expect(bottom - top).toBeGreaterThanOrEqual(8)
		})
	})

	describe('when the statement is already imported', () => {

		it('QUIRK - ignores pointer input entirely', () => {
			// A committed region would be re-extracted server-side, which must not be possible once
			// the transactions have been created.
			const { box, onCommit } = renderOverlay({ disabled: true })

			dragBy(box, { dx: 50, dy: 50 })

			expect(onCommit).not.toHaveBeenCalled()
			expect(box.className).toContain('pointer-events-none')
		})

		it('withdraws the resize handles, so nothing suggests it is editable', () => {
			const { box } = renderOverlay({ disabled: true })

			expect(box.querySelectorAll('[data-handle]')).toHaveLength(0)
		})
	})

	describe('when the server sends an authoritative region', () => {

		it('QUIRK - replaces the local draft instead of keeping it', () => {
			// After a re-extract the server may have adjusted the region. Keeping the local draft
			// would leave the overlay describing a region the extracted rows did not come from.
			const { box, rerender, onCommit } = renderOverlay()

			dragBy(box, { dx: 40, dy: 40 })
			expect(onCommit).toHaveBeenCalledWith([140, 140, 340, 240])

			const containerRef = createRef<HTMLDivElement>()
			rerender(
				<div ref={containerRef} style={{ position: 'relative' }}>
					<BBoxOverlay
						bbox={[10, 20, 110, 220]}
						pageWidth={PAGE_WIDTH}
						pageHeight={PAGE_HEIGHT}
						color={COLOR}
						label="Table 1"
						included
						containerRef={containerRef}
						onCommit={onCommit}
					/>
				</div>
			)

			expect(readBox(screen.getByText('Table 1').parentElement as HTMLElement)).toEqual([
				10, 20, 110, 220
			])
		})
	})
})
