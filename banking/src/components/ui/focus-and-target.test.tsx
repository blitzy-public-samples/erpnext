/**
 * Behavioural specification for two cross-primitive accessibility contracts.
 *
 * They are specified together, in one place, because they are one contract each applied to several
 * controls - splitting them across five near-identical files would hide that, and would let a sixth
 * control be added without anyone noticing it was never held to either.
 *
 * **Pointer target size.** A `sm` switch paints 26x16, a `sm` checkbox 14px square and a radio 16px
 * square, so all three offered a pointer target well under the 24x24 minimum - a real cost to anyone
 * with a tremor or using a touch screen, and the three controls that gate the reconciliation filters,
 * the invoice allocation table and the rule classification are exactly the ones a reviewer presses
 * most. The painted size belongs to the design and is unchanged; the TARGET is grown instead, with a
 * transparent centred pseudo-element.
 *
 * **Focus indicator.** `Switch` set `outline-none` and put nothing back, so a keyboard user had no
 * indication at all of where focus was. `RadioGroupItem`, the calendar's date field and its focused
 * day cell, and the settings dialog's tab rail all DID draw a ring, but from `outline-gray-1` or
 * `outline-gray-3` - between 1.1:1 and 1.9:1 against the surfaces they sit on, which is not
 * perceivable. `outline-gray-5` is the ramp's focus value and clears the 3:1 non-text floor in both
 * themes; every change here is token-for-token within the existing ramp, so no new colour is
 * introduced and no geometry changes.
 *
 * These assertions are necessarily about the classes applied, because jsdom does not evaluate the
 * Tailwind stylesheet and so cannot report a computed size or colour. The pixels themselves are
 * measured in the browser during runtime verification; what these tests hold is that the contract is
 * applied to every control that needs it and cannot be silently dropped from one of them.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { TARGET_MIN_SIZE } from '@/lib/utils'
import { Switch } from './switch'
import { Checkbox } from './checkbox'
import { RadioGroup, RadioGroupItem } from './radio-group'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'

/** Every utility class the shared target-size contract is made of. */
const TARGET_CLASSES = TARGET_MIN_SIZE.split(/\s+/).filter(Boolean)

const expectMeetsTargetMinimum = (control: HTMLElement) => {
    for (const utility of TARGET_CLASSES) {
        expect(control.className).toContain(utility)
    }
}

describe('the shared target-size contract', () => {

    it('grows the target in both axes to at least 24px, and no less', () => {
        /*
         * `min-h-6`/`min-w-6` rather than a fixed `size-6`: a control that already exceeds 24px in one
         * axis - an `md` switch is 32px wide - must not be SHRUNK to 24, so the pseudo-element takes
         * the larger of the control's own box and the minimum.
         */
        expect(TARGET_MIN_SIZE).toContain('before:min-h-6')
        expect(TARGET_MIN_SIZE).toContain('before:min-w-6')
        expect(TARGET_MIN_SIZE).toContain('before:size-full')
    })

    it('centres the extra area rather than anchoring it to one edge', () => {
        // Anchored growth would reach into whichever neighbour sits on that side; centred growth
        // spreads the few extra pixels equally and stays clear of both.
        expect(TARGET_MIN_SIZE).toContain('before:top-1/2')
        expect(TARGET_MIN_SIZE).toContain('before:left-1/2')
        expect(TARGET_MIN_SIZE).toContain('before:-translate-x-1/2')
        expect(TARGET_MIN_SIZE).toContain('before:-translate-y-1/2')
    })

    it('paints nothing, so the control looks exactly as designed', () => {
        // An empty `content` with no background or border: it exists only to be hit.
        expect(TARGET_MIN_SIZE).toContain("before:content-['']")
        expect(TARGET_MIN_SIZE).not.toMatch(/before:bg-|before:border-|before:outline-/)
    })

    it('establishes the positioning context the pseudo-element needs', () => {
        // Without `relative` the absolute pseudo-element would resolve against some ancestor and land
        // somewhere other than on the control.
        expect(TARGET_CLASSES).toContain('relative')
    })
})

describe('Switch', () => {

    it('meets the pointer-target minimum without changing its painted size', () => {
        render(<Switch aria-label="Include partial matches" />)

        const control = screen.getByRole('switch')
        expectMeetsTargetMinimum(control)
        // The design's own track size, untouched.
        expect(control.className).toContain('data-[size=sm]:h-4')
    })

    it('marks keyboard focus, which it previously did not do at all', () => {
        render(<Switch aria-label="Include partial matches" />)

        expect(screen.getByRole('switch').className).toContain('focus-visible:shadow-focus-gray')
    })
})

describe('Checkbox', () => {

    it('meets the pointer-target minimum at both sizes', () => {
        render(
            <>
                <Checkbox size="sm" aria-label="Select fee row" />
                <Checkbox size="md" aria-label="Select all rows" />
            </>
        )

        const [small, medium] = screen.getAllByRole('checkbox')
        expectMeetsTargetMinimum(small)
        expectMeetsTargetMinimum(medium)
        expect(small.className).toContain('size-3.5')
        expect(medium.className).toContain('size-4')
    })
})

describe('RadioGroupItem', () => {

    it('meets the pointer-target minimum', () => {
        render(
            <RadioGroup>
                <RadioGroupItem value="payment-entry" aria-label="Payment Entry" />
            </RadioGroup>
        )

        expectMeetsTargetMinimum(screen.getByRole('radio'))
    })

    it('draws its focus ring from the high-contrast token, not the near-invisible one', () => {
        render(
            <RadioGroup>
                <RadioGroupItem value="payment-entry" aria-label="Payment Entry" />
            </RadioGroup>
        )

        const control = screen.getByRole('radio')
        expect(control.className).toContain('focus-visible:ring-outline-gray-5')
        // The measured failure: `outline-gray-1` at half alpha, about 1.1:1 against the field.
        expect(control.className).not.toContain('outline-gray-1')
    })
})

describe('TabsContent', () => {

    it('marks focus on the panel, which Radix places in the tab sequence', () => {
        /*
         * Radix puts `tabindex="0"` on the active panel, following the APG pattern - so it IS a stop
         * in the tab order, and `outline-none` alone left that stop unmarked. The indicator is inset
         * so the panel's own overflow cannot clip it.
         */
        render(
            <Tabs defaultValue="statement">
                <TabsList>
                    <TabsTrigger value="statement">Statement</TabsTrigger>
                </TabsList>
                <TabsContent value="statement">Summary</TabsContent>
            </Tabs>
        )

        const panel = screen.getByRole('tabpanel')
        expect(panel).toHaveAttribute('tabindex', '0')
        expect(panel.className).toContain('focus-visible:outline-outline-gray-5')
        expect(panel.className).toContain('focus-visible:-outline-offset-2')
    })

    it('restores the outline STYLE on focus, without which the ring paints nothing', () => {
        /*
         * The subtle half of this fix, and the half that was wrong first time round. Tailwind declares
         * `--tw-outline-style` with an initial value of `solid` and compiles every `outline-<width>`
         * utility to `outline-style: var(--tw-outline-style)` - while `outline-none` sets that variable
         * to `none`. So a base `outline-none` silences the variant's own width and colour entirely.
         *
         * Measured in the browser before `outline-solid` was added: this panel reported
         * `outline-style: none` beside `outline-width: 2px`, `box-shadow: none`, and ZERO pixels of the
         * declared colour anywhere along the ring it claimed to draw. Both halves are asserted together
         * because either one alone passes while the ring stays invisible.
         */
        render(
            <Tabs defaultValue="statement">
                <TabsList>
                    <TabsTrigger value="statement">Statement</TabsTrigger>
                </TabsList>
                <TabsContent value="statement">Summary</TabsContent>
            </Tabs>
        )

        const panel = screen.getByRole('tabpanel')
        expect(panel.className).toContain('outline-none')
        expect(panel.className).toContain('focus-visible:outline-solid')
        expect(panel.className).toContain('focus-visible:outline-2')
    })
})
