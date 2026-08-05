/**
 * Behavioural specification for `src/hooks/use-mobile.ts`.
 *
 * The reconciliation page is deliberately desktop-only - it renders a "Go to Desktop" gate below its
 * breakpoint rather than reflowing - so this hook is what decides whether a reviewer sees the workbench
 * at all. Two behaviours are pinned:
 *
 *   1. The hook subscribes to a media query but derives its ANSWER from `window.innerWidth`, so the two
 *      must agree for it to be correct. A test that only changes the media query, or only the width, is
 *      testing half of it.
 *   2. It starts as `undefined` and is coerced with `!!` on the way out, so the first render reports
 *      "not mobile" regardless of the real viewport - the truth arrives on the effect.
 *
 * jsdom provides no `matchMedia`, so `src/test/setup.ts` installs one. This suite replaces it with a
 * listener-capturing double for the duration of each test and restores what it displaced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { useIsMobile } from '@/hooks/use-mobile'

const MOBILE_BREAKPOINT = 768

describe('useIsMobile', () => {

	let displacedMatchMedia: typeof window.matchMedia
	let displacedWidth: number
	let listeners: Array<() => void>

	/** Moves the viewport and notifies every subscriber, as a real resize would. */
	const resizeTo = (width: number) => {
		Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
		act(() => {
			for (const listener of listeners) listener()
		})
	}

	beforeEach(() => {
		listeners = []
		displacedMatchMedia = window.matchMedia
		displacedWidth = window.innerWidth

		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: window.innerWidth < MOBILE_BREAKPOINT,
			media: query,
			addEventListener: (_event: string, listener: () => void) => {
				listeners.push(listener)
			},
			removeEventListener: (_event: string, listener: () => void) => {
				listeners = listeners.filter((registered) => registered !== listener)
			},
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn()
		})) as unknown as typeof window.matchMedia
	})

	afterEach(() => {
		window.matchMedia = displacedMatchMedia
		Object.defineProperty(window, 'innerWidth', {
			value: displacedWidth,
			configurable: true,
			writable: true
		})
	})

	it('reports a desktop viewport as not mobile', () => {
		Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true })

		expect(renderHook(() => useIsMobile()).result.current).toBe(false)
	})

	it('reports a viewport below the breakpoint as mobile', () => {
		Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true, writable: true })

		expect(renderHook(() => useIsMobile()).result.current).toBe(true)
	})

	it('treats the breakpoint itself as desktop, and one pixel under it as mobile', () => {
		// The comparison is strictly `<`, so 768 is the narrowest desktop rather than the widest phone.
		Object.defineProperty(window, 'innerWidth', {
			value: MOBILE_BREAKPOINT, configurable: true, writable: true
		})
		expect(renderHook(() => useIsMobile()).result.current).toBe(false)

		Object.defineProperty(window, 'innerWidth', {
			value: MOBILE_BREAKPOINT - 1, configurable: true, writable: true
		})
		expect(renderHook(() => useIsMobile()).result.current).toBe(true)
	})

	it('subscribes to a query built from one pixel below the breakpoint', () => {
		Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true })

		renderHook(() => useIsMobile())

		expect(window.matchMedia).toHaveBeenCalledWith(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
	})

	it('follows the viewport across the breakpoint, in both directions', () => {
		Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true })

		const { result } = renderHook(() => useIsMobile())
		expect(result.current).toBe(false)

		resizeTo(360)
		expect(result.current).toBe(true)

		resizeTo(1024)
		expect(result.current).toBe(false)
	})

	it('unsubscribes on unmount, so a later resize cannot update a dead component', () => {
		Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true })

		const { unmount } = renderHook(() => useIsMobile())
		expect(listeners).toHaveLength(1)

		unmount()

		expect(listeners).toHaveLength(0)
	})

	it('QUIRK - always answers a boolean, never the undefined it starts as', () => {
		// The state is initialised `undefined` and coerced with `!!`, so a consumer can use the result in
		// a conditional on the very first render without a tri-state to handle.
		Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true, writable: true })

		const { result } = renderHook(() => useIsMobile())

		expect(typeof result.current).toBe('boolean')
	})
})
