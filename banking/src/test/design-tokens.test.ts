/**
 * Contrast specification for the design tokens that carry text and focus indicators.
 *
 * This reads the real stylesheet, resolves each token through its `var()` chain to a hex value, and
 * computes WCAG contrast ratios from it. That is deliberate, and it is the only kind of test that can
 * hold this line: jsdom evaluates no stylesheet, so a component test can assert that a class is
 * applied but never what colour it resolves to or whether that colour is legible. Every ratio the
 * browser reported during runtime verification is reproduced here from the same source of truth, so a
 * token can no longer be nudged back down without a failing test naming the pairing it breaks.
 *
 * The tokens under test were all measured failing in a real browser by axe-core and Lighthouse, which
 * agreed exactly:
 *
 *   - `--ink-gray-5` was gray-600 (#7C7C7C): 4.17:1 on white, 3.76:1 on gray-2, 3.94:1 on amber-2.
 *     Ten failing nodes on the workbench and thirteen on the importer traced to this one token,
 *     including all four inactive tab labels and every "Previous Imports" column header.
 *   - `--ink-red-3` was red-500 (#E03636): 4.42:1 on white. It carries the balance strip's negative
 *     difference, its "Shortfall" label and the "As of ..." warning.
 *   - `--focus-shadow-gray` was rgba(201,201,201,0.9): 1.57:1 against white - a focus ring that could
 *     not be seen.
 *
 * The thresholds are WCAG 2.1 AA: 4.5:1 for body text (1.4.3) and 3:1 for a non-text indicator
 * (1.4.11).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const AA_TEXT = 4.5
const AA_NON_TEXT = 3

type Theme = 'light' | 'dark'

/** Every custom property declared in each theme block, unresolved. */
const declarations = (): Record<Theme, Map<string, string>> => {
    const lines = readFileSync(resolve(__dirname, '../index.css'), 'utf8').split('\n')

    // The dark theme is a single `.dark` block; everything before it is the light theme.
    const darkStart = lines.findIndex((line) => line.includes('.dark') && line.includes('{'))
    expect(darkStart).toBeGreaterThan(0)

    const collect = (from: number, to: number) => {
        const found = new Map<string, string>()
        for (const line of lines.slice(from, to)) {
            const match = /^\s*(--[a-z0-9-]+):\s*(.+?);/.exec(line)
            if (match) {
                found.set(match[1], match[2].trim())
            }
        }
        return found
    }

    return {
        light: collect(0, darkStart),
        dark: collect(darkStart, lines.length)
    }
}

const TOKENS = declarations()

/** Follows a `var()` chain to the hex literal at the end of it. */
const resolveToken = (theme: Theme, name: string, depth = 0): string => {
    const value = TOKENS[theme].get(name)
    if (value === undefined) {
        throw new Error(`${name} is not declared in the ${theme} theme`)
    }

    const indirect = /^var\((--[a-z0-9-]+)\)$/.exec(value)
    if (indirect && depth < 10) {
        return resolveToken(theme, indirect[1], depth + 1)
    }

    if (!value.startsWith('#')) {
        throw new Error(`${name} resolves to ${value} in the ${theme} theme, which is not a hex colour`)
    }
    return value
}

const channels = (hex: string): [number, number, number] => {
    const digits = hex.replace('#', '')
    return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16)) as [number, number, number]
}

const relativeLuminance = (hex: string): number => {
    const linear = channels(hex).map((channel) => {
        const fraction = channel / 255
        return fraction <= 0.04045 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

const contrast = (foreground: string, background: string): number => {
    const a = relativeLuminance(foreground)
    const b = relativeLuminance(background)
    const [lighter, darker] = a > b ? [a, b] : [b, a]
    return (lighter + 0.05) / (darker + 0.05)
}

/** Composites a partly transparent colour over an opaque one, the way a browser paints it. */
const composite = (foreground: string, alpha: number, background: string): string => {
    const over = channels(foreground)
    const under = channels(background)
    const mixed = over.map((channel, index) => Math.round(channel * alpha + under[index] * (1 - alpha)))
    return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/**
 * The surfaces each text token is actually painted on.
 *
 * `--surface-gray-3` is deliberately absent: it is a hover fill, and no element in this application
 * combines it with `text-ink-gray-5` - checked by searching every class list for the pair. Listing a
 * pairing that never occurs would force a token darker than the design needs.
 */
const TEXT_SURFACES = [
    '--surface-white',
    '--surface-gray-1',
    '--surface-gray-2',
    '--surface-modal',
    '--surface-menu-bar',
    '--surface-green-1',
    '--surface-amber-2',
    '--surface-red-1'
] as const

const THEMES: Theme[] = ['light', 'dark']

describe('text tokens meet the AA contrast floor', () => {

    for (const token of ['--ink-gray-5', '--ink-red-3', '--ink-red-4', '--ink-gray-6', '--ink-gray-8'] as const) {
        for (const theme of THEMES) {
            it(`${token} is legible on every surface it is painted on (${theme})`, () => {
                const foreground = resolveToken(theme, token)

                const failures = TEXT_SURFACES
                    .map((surface) => ({
                        surface,
                        ratio: Number(contrast(foreground, resolveToken(theme, surface)).toFixed(2))
                    }))
                    .filter(({ ratio }) => ratio < AA_TEXT)

                expect(failures).toEqual([])
            })
        }
    }

    it('keeps the red ink scale in order, so the steps stay distinguishable', () => {
        /*
         * Both dark red steps moved one place lighter together. Asserting the ORDER as well as the
         * ratios is what stops a future contrast fix from being made by simply swapping a step for a
         * brighter one out of sequence, which would leave `ink-red-3` more prominent than `ink-red-4`.
         */
        expect(relativeLuminance(resolveToken('light', '--ink-red-3')))
            .toBeGreaterThan(relativeLuminance(resolveToken('light', '--ink-red-4')))
        expect(relativeLuminance(resolveToken('dark', '--ink-red-4')))
            .toBeGreaterThan(relativeLuminance(resolveToken('dark', '--ink-red-3')))
    })

    it('reproduces the exact ratios measured in the browser', () => {
        // Spot values, so a regression reports a number rather than only a boolean.
        expect(contrast(resolveToken('light', '--ink-gray-5'), resolveToken('light', '--surface-white')))
            .toBeCloseTo(7.81, 1)
        expect(contrast(resolveToken('light', '--ink-red-3'), resolveToken('light', '--surface-white')))
            .toBeCloseTo(5.36, 1)
        expect(contrast(resolveToken('dark', '--ink-gray-5'), resolveToken('dark', '--surface-green-1')))
            .toBeCloseTo(5.97, 1)
    })
})

describe('the focus ring meets the non-text contrast floor', () => {

    /**
     * The ring is a translucent box-shadow, so what matters is the composite. The browser reported
     * rgb(99,99,99) for the light ring over white, which is exactly 0.9 x 82 + 0.1 x 255 - the same
     * arithmetic this test performs.
     */
    const RING = {
        light: { colour: '#525252', alpha: 0.9 },
        dark: { colour: '#afafaf', alpha: 0.8 }
    } as const

    for (const theme of THEMES) {
        it(`is perceivable against every surface it is drawn over (${theme})`, () => {
            const declared = TOKENS[theme].get('--focus-shadow-gray')
            expect(declared).toBeDefined()

            const rgba = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(declared ?? '')
            expect(rgba, `--focus-shadow-gray should be an rgba() value in the ${theme} theme`).not.toBeNull()

            const [, r, g, b, alpha] = rgba as RegExpExecArray
            const colour = `#${[r, g, b].map((channel) => Number(channel).toString(16).padStart(2, '0')).join('')}`

            // The declared value must match what this test believes it is measuring.
            expect(colour.toLowerCase()).toBe(RING[theme].colour)
            expect(Number(alpha)).toBeCloseTo(RING[theme].alpha, 2)

            const failures = TEXT_SURFACES
                .map((surface) => {
                    const background = resolveToken(theme, surface)
                    return {
                        surface,
                        ratio: Number(contrast(composite(colour, Number(alpha), background), background).toFixed(2))
                    }
                })
                .filter(({ ratio }) => ratio < AA_NON_TEXT)

            expect(failures).toEqual([])
        })
    }

    it('is a long way clear of the value it replaced', () => {
        // The old light ring composited to rgb(206,206,206) over white: 1.57:1, measured by QA as 1.66.
        const old = contrast(composite('#c9c9c9', 0.9, '#ffffff'), '#ffffff')
        const now = contrast(composite('#525252', 0.9, '#ffffff'), '#ffffff')

        expect(old).toBeLessThan(AA_NON_TEXT)
        expect(now).toBeGreaterThan(AA_NON_TEXT * 1.5)
    })

    it('draws the settings rail and the panel ring from a token that is high-contrast in BOTH themes', () => {
        /*
         * `outline-gray-5` is the one token used for every opaque focus ring in the application, and the
         * reason it is that token rather than a per-theme pair is that it inverts: near-black in light,
         * near-white in dark. Both directions are checked here, because a ring that is only correct in
         * one theme is a ring that disappears in the other.
         */
        for (const theme of THEMES) {
            const ring = resolveToken(theme, '--outline-gray-5')

            const failures = TEXT_SURFACES
                .map((surface) => ({
                    surface,
                    ratio: Number(contrast(ring, resolveToken(theme, surface)).toFixed(2))
                }))
                .filter(({ ratio }) => ratio < AA_NON_TEXT)

            expect(failures).toEqual([])
        }
    })
})
