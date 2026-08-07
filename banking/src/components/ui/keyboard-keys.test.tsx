/**
 * Behavioural specification for the modifier-key caps.
 *
 * These three components have one job: print the modifier the reviewer must actually press. That had
 * drifted from what the app binds. Every shortcut in this SPA is registered with `react-hotkeys-hook`
 * as `meta+…`, and `meta` is Command on macOS but the Super / Windows key everywhere else - yet this
 * component printed "Ctrl" on every non-Mac platform. A reviewer on Linux was told six times over to
 * press a combination that does nothing, and the combination that does work was named nowhere.
 *
 * Two behaviours are worth stating because they are easy to get wrong:
 *   1. The platform is read from `navigator.userAgentData.platform` first and `navigator.platform`
 *      second, because the latter is deprecated but is all Safari and older browsers offer.
 *   2. Each cap carries an accessible NAME, not just a glyph. A screen reader announces U+2318 as
 *      "place of interest sign" and announced nothing at all for the shift glyph, so the caps are
 *      `role="img"` with a spoken label.
 */

import { describe, expect, it, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { KeyboardAltKeyIcon, KeyboardMetaKeyIcon, KeyboardShiftKeyIcon } from './keyboard-keys'

type PlatformOverride = { userAgentData?: { platform?: string }, platform?: string, userAgent?: string }

const originals = {
	userAgentData: (navigator as Navigator & PlatformOverride).userAgentData,
	platform: navigator.platform,
	userAgent: navigator.userAgent
}

/**
 * Replaces the platform signals for one test. Each is defined rather than assigned because
 * `navigator.platform` and `navigator.userAgent` are accessor-only in jsdom.
 */
const onPlatform = (override: PlatformOverride) => {
	Object.defineProperty(navigator, 'userAgentData', {
		value: override.userAgentData,
		configurable: true,
		writable: true
	})
	Object.defineProperty(navigator, 'platform', {
		value: override.platform ?? '',
		configurable: true,
		writable: true
	})
	Object.defineProperty(navigator, 'userAgent', {
		value: override.userAgent ?? '',
		configurable: true,
		writable: true
	})
}

afterEach(() => {
	onPlatform({
		userAgentData: originals.userAgentData,
		platform: originals.platform,
		userAgent: originals.userAgent
	})
})

describe('KeyboardMetaKeyIcon', () => {

	it('prints Command on a Mac, because that is what meta binds there', () => {
		onPlatform({ platform: 'MacIntel' })

		render(<KeyboardMetaKeyIcon />)

		expect(screen.getByRole('img', { name: 'Command' })).toHaveTextContent('⌘')
	})

	it('prints the Windows key on Windows, not Ctrl', () => {
		// The regression this pins: `meta` on Windows is the Windows key. Printing "Ctrl" described a
		// combination the app does not bind.
		onPlatform({ platform: 'Win32' })

		render(<KeyboardMetaKeyIcon />)

		const cap = screen.getByRole('img', { name: 'Windows key' })
		expect(cap).toHaveTextContent('Win')
		expect(cap).not.toHaveTextContent('Ctrl')
	})

	it('prints Super on Linux, which is where the QA reviewer was misled', () => {
		onPlatform({ platform: 'Linux x86_64' })

		render(<KeyboardMetaKeyIcon />)

		const cap = screen.getByRole('img', { name: 'Super key' })
		expect(cap).toHaveTextContent('Super')
		expect(cap).not.toHaveTextContent('Ctrl')
	})

	it('never prints Ctrl on any platform, because no shortcut is registered with ctrl', () => {
		for (const platform of ['MacIntel', 'Win32', 'Linux x86_64', 'FreeBSD amd64', '']) {
			onPlatform({ platform })

			const { unmount, container } = render(<KeyboardMetaKeyIcon />)
			expect(container.textContent).not.toMatch(/ctrl/i)
			unmount()
		}
	})

	it('prefers userAgentData over the deprecated platform string', () => {
		// A browser that reports both must be believed on the supported signal.
		onPlatform({ userAgentData: { platform: 'macOS' }, platform: 'Linux x86_64' })

		render(<KeyboardMetaKeyIcon />)

		expect(screen.getByRole('img', { name: 'Command' })).toBeInTheDocument()
	})

	it('falls back to the user agent string when neither platform signal is present', () => {
		onPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })

		render(<KeyboardMetaKeyIcon />)

		expect(screen.getByRole('img', { name: 'Command' })).toBeInTheDocument()
	})

	it('settles on Super when the runtime exposes no platform signal at all', () => {
		// A headless or embedded runtime may expose none of the three; the cap must still render.
		onPlatform({})

		render(<KeyboardMetaKeyIcon />)

		expect(screen.getByRole('img', { name: 'Super key' })).toBeInTheDocument()
	})

	it('does not mistake a Mac user agent mentioning Windows for Windows', () => {
		// `isWindowsPlatform` excludes anything that also looks like a Mac, so the Mac branch wins.
		onPlatform({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh) Windows-Like' })

		render(<KeyboardMetaKeyIcon />)

		expect(screen.getByRole('img', { name: 'Command' })).toBeInTheDocument()
	})
})

describe('KeyboardAltKeyIcon', () => {

	it('prints Option on a Mac', () => {
		onPlatform({ platform: 'MacIntel' })

		render(<KeyboardAltKeyIcon />)

		expect(screen.getByRole('img', { name: 'Option' })).toHaveTextContent('⌥')
	})

	it('prints Alt everywhere else, which is what alt+r actually binds', () => {
		onPlatform({ platform: 'Linux x86_64' })

		render(<KeyboardAltKeyIcon />)

		expect(screen.getByRole('img', { name: 'Alt' })).toHaveTextContent('Alt')
	})
})

describe('KeyboardShiftKeyIcon', () => {

	it('gives the shift glyph a spoken name, which a bare glyph does not have', () => {
		render(<KeyboardShiftKeyIcon />)

		expect(screen.getByRole('img', { name: 'Shift' })).toHaveTextContent('⇧')
	})

	it('is platform-independent, because shift is spelled the same everywhere', () => {
		onPlatform({ platform: 'MacIntel' })
		const { container: mac, unmount } = render(<KeyboardShiftKeyIcon />)
		const macText = mac.textContent
		unmount()

		onPlatform({ platform: 'Linux x86_64' })
		const { container: linux } = render(<KeyboardShiftKeyIcon />)

		expect(linux.textContent).toBe(macText)
	})
})
