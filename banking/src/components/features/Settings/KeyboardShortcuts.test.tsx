/**
 * Behavioural specification for the Keyboard Shortcuts panel.
 *
 * This panel is the ONLY place a reviewer can discover what the workbench binds, which makes it the one
 * surface where being wrong is worse than being absent: a reviewer who is told to press a combination
 * that does nothing concludes the feature is broken. It had been wrong on every non-Mac platform,
 * advertising "Ctrl" for six shortcuts that are registered with `meta`.
 *
 * The suite below therefore does something unusual, and deliberately so: rather than asserting the panel
 * contains particular words, it READS THE REGISTRATIONS out of the source tree and requires the panel to
 * agree with them. A future contributor who adds a `useHotkeys` call, or re-binds an existing one, will
 * be told by this suite that the documentation no longer matches - which is exactly the drift that
 * produced the original finding and which no fixed list of expected strings would have caught.
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { Dialog, DialogContent } from '@/components/ui/dialog'

import KeyboardShortcuts from './KeyboardShortcuts'

/*
 * The panel's heading is a Radix `DialogTitle`, which throws unless a `Dialog` root is above it - so the
 * panel is mounted inside a minimal open dialog rather than bare. This is the same context the real
 * Settings dialog provides; nothing about the panel's own behaviour changes.
 */
const renderPanel = () => render(
    <Dialog open>
        <DialogContent>
            <KeyboardShortcuts />
        </DialogContent>
    </Dialog>
)

/* ------------------------------------------------------------------ *
 * Reading what is actually registered
 * ------------------------------------------------------------------ */

const SOURCE_ROOT = join(process.cwd(), 'src')

/** Every `.ts`/`.tsx` file under `src`, excluding the test files themselves. */
const sourceFiles = (): string[] =>
	(readdirSync(SOURCE_ROOT, { recursive: true }) as string[])
		.filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
		.map((entry) => join(SOURCE_ROOT, entry))

/**
 * The set of key combinations passed to `useHotkeys` across the app, as written.
 *
 * Both quote styles are matched because the codebase uses single quotes but nothing enforces it.
 */
const registeredCombinations = (): Set<string> => {
	const found = new Set<string>()

	for (const file of sourceFiles()) {
		const contents = readFileSync(file, 'utf8')
		for (const match of contents.matchAll(/useHotkeys\(\s*['"]([^'"]+)['"]/g)) {
			found.add(match[1])
		}
	}

	return found
}

/* ------------------------------------------------------------------ *
 * Reading what the panel documents
 * ------------------------------------------------------------------ */

/**
 * Maps a rendered key cap back to the `react-hotkeys-hook` token it stands for.
 *
 * This is the mapping the finding was about: `Super`, `Win` and `⌘` are three spellings of ONE token,
 * `meta`. "Ctrl" is deliberately absent - if the panel ever prints it again, the lookup fails and the
 * combination will not match any registration.
 */
const CAP_TO_TOKEN: Record<string, string> = {
	'⌘': 'meta',
	'Win': 'meta',
	'Super': 'meta',
	'⌥': 'alt',
	'Alt': 'alt',
	'⇧': 'shift'
}

/** A documented combination, normalised so token order does not matter. */
const normalise = (tokens: string[]): string =>
	[...tokens].map((token) => token.toLowerCase()).sort().join('+')

/**
 * Reads each documented row out of the rendered panel as a normalised combination.
 *
 * The caps live in the first cell of each body row; the action label lives in the second.
 */
const documentedRows = (): { action: string, combination: string }[] => {
	const rows = screen.getAllByRole('row').slice(1) // drop the header row

	return rows.map((row) => {
		const cells = row.querySelectorAll('td')
		const caps = Array.from(cells[0].querySelectorAll('kbd[data-slot="kbd"]'))
			.map((cap) => (cap.textContent ?? '').trim())

		return {
			action: (cells[1].textContent ?? '').trim(),
			combination: normalise(caps.map((cap) => CAP_TO_TOKEN[cap] ?? cap))
		}
	})
}

/* ------------------------------------------------------------------ *
 * Platform control
 * ------------------------------------------------------------------ */

const originalPlatform = navigator.platform

const onPlatform = (platform: string) => {
	Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true, writable: true })
	Object.defineProperty(navigator, 'platform', { value: platform, configurable: true, writable: true })
	Object.defineProperty(navigator, 'userAgent', { value: platform, configurable: true, writable: true })
}

beforeEach(() => {
	// Linux, because that is the platform the reviewer was on when the panel misled them.
	onPlatform('Linux x86_64')
})

afterEach(() => {
	Object.defineProperty(navigator, 'platform', { value: originalPlatform, configurable: true, writable: true })
})

describe('KeyboardShortcuts', () => {

	describe('what it documents versus what the app registers', () => {

		it('finds the registrations at all, so the rest of this suite cannot pass vacuously', () => {
			// A guard on the harness: if the source scan silently found nothing, every comparison below
			// would trivially succeed.
			const registered = registeredCombinations()

			expect(registered.size).toBeGreaterThan(0)
			expect(registered).toContain('meta+s')
		})

		it('documents every combination the app registers', () => {
			const registered = [...registeredCombinations()].map((combo) => normalise(combo.split('+')))

			renderPanel()
			const documented = documentedRows().map((row) => row.combination)

			for (const combination of registered) {
				expect(documented, `registered ${combination} is not documented in the panel`)
					.toContain(combination)
			}
		})

		it('documents nothing the app does not register', () => {
			// The other direction: a row describing a combination nobody bound is as misleading as a
			// missing one.
			const registered = [...registeredCombinations()].map((combo) => normalise(combo.split('+')))

			renderPanel()

			for (const row of documentedRows()) {
				expect(registered, `the panel documents ${row.combination} for "${row.action}" but nothing registers it`)
					.toContain(row.combination)
			}
		})

		it('never advertises Ctrl, because no shortcut is registered with ctrl', () => {
			// This is the finding, stated directly. It held on every platform, so all three are checked.
			expect([...registeredCombinations()].some((combo) => /ctrl|control/i.test(combo))).toBe(false)

			for (const platform of ['Linux x86_64', 'Win32', 'MacIntel']) {
				onPlatform(platform)
				const { container, unmount } = renderPanel()

				const caps = Array.from(container.querySelectorAll('kbd[data-slot="kbd"]')).map((cap) => cap.textContent ?? '')
				expect(caps.join(' ')).not.toMatch(/ctrl/i)

				unmount()
			}
		})
	})

	describe('the modifier it prints', () => {

		it('prints Super on Linux, which is the key that actually triggers these shortcuts', () => {
			renderPanel()

			expect(screen.getAllByRole('img', { name: 'Super key' }).length).toBeGreaterThan(0)
		})

		it('prints Command on a Mac', () => {
			onPlatform('MacIntel')

			renderPanel()

			expect(screen.getAllByRole('img', { name: 'Command' }).length).toBeGreaterThan(0)
		})

		it('prints the Windows key on Windows', () => {
			onPlatform('Win32')

			renderPanel()

			expect(screen.getAllByRole('img', { name: 'Windows key' }).length).toBeGreaterThan(0)
		})

		it('names Alt rather than drawing a bare Mac Option glyph on Linux', () => {
			// The Accept Matching Rule row is registered with `alt+r` and used to render the lucide
			// Option glyph regardless of platform, which is not the key a Linux reviewer presses.
			renderPanel()

			expect(screen.getByRole('img', { name: 'Alt' })).toHaveTextContent('Alt')
		})

		it('gives the shift cap a spoken name instead of leaving a bare glyph', () => {
			renderPanel()

			expect(screen.getByRole('img', { name: 'Shift' })).toBeInTheDocument()
		})
	})

	describe('the rows themselves', () => {

		it('describes what each shortcut does, not just which keys it uses', () => {
			renderPanel()

			expect(screen.getByText('Bank Entry')).toBeInTheDocument()
			expect(screen.getByText('Record Payment')).toBeInTheDocument()
			expect(screen.getByText('Transfer')).toBeInTheDocument()
			expect(screen.getByText('Accept Matching Rule')).toBeInTheDocument()
			expect(screen.getByText('Save')).toBeInTheDocument()
			expect(screen.getByText('Reconciliation History')).toBeInTheDocument()
			expect(screen.getByText('Settings')).toBeInTheDocument()
		})

		it('pairs each action with the combination that triggers it', () => {
			// Documenting the right keys against the wrong action would still send a reviewer to the
			// wrong place, so the pairing is asserted and not just the presence of both.
			renderPanel()

			const byAction = new Map(documentedRows().map((row) => [row.action, row.combination]))

			expect(byAction.get('Bank Entry')).toBe('b+meta')
			expect(byAction.get('Record Payment')).toBe('meta+p')
			expect(byAction.get('Transfer')).toBe('i+meta')
			expect(byAction.get('Accept Matching Rule')).toBe('alt+r')
			expect(byAction.get('Save')).toBe('meta+s')
			expect(byAction.get('Reconciliation History')).toBe('meta+z')
			expect(byAction.get('Settings')).toBe('g+meta+shift')
		})

		it('renders one row per shortcut with no duplicates', () => {
			renderPanel()

			const combinations = documentedRows().map((row) => row.combination)

			expect(new Set(combinations).size).toBe(combinations.length)
		})
	})
})
