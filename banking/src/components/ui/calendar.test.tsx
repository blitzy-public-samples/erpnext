/**
 * Behavioural specification for the calendar's month and year pickers.
 *
 * They are react-day-picker's own invisible native `<select>`s, laid over the styled caption, and the
 * library's defaults left two problems on them.
 *
 * They arrived with `id=""`, no `name` and no associated `<label>`, so the browser could not identify
 * them for autofill or for restoring a value on a back-navigation.
 *
 * The one that actually costs a user something is the naming. A range calendar renders TWO months side
 * by side, so the stock labels produced four controls sharing two names - two comboboxes both called
 * "Choose the Month" and two both called "Choose the Year" - with nothing to say which panel each
 * belonged to. Somebody driving the date filter by voice or listening to a list of the form's controls
 * had no way to pick the right one. The label is rebuilt from each dropdown's own current value, which
 * is the thing that distinguishes them.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { Calendar } from './calendar'

/** A two-month range calendar with the caption dropdowns switched on - the date filter's own setup. */
const renderRangeCalendar = () =>
    render(
        <Calendar
            mode="range"
            captionLayout="dropdown"
            numberOfMonths={2}
            defaultMonth={new Date(2026, 7, 1)}
            selected={{ from: new Date(2026, 7, 1), to: new Date(2026, 7, 31) }}
        />
    )

const dropdowns = () => Array.from(document.querySelectorAll('select'))

describe('Calendar caption dropdowns', () => {

    it('renders one month and one year picker for each displayed month', () => {
        renderRangeCalendar()

        expect(dropdowns()).toHaveLength(4)
    })

    it('identifies every dropdown, so none is a form field the browser cannot name', () => {
        renderRangeCalendar()

        for (const dropdown of dropdowns()) {
            expect(dropdown.id).toBeTruthy()
            expect(dropdown.getAttribute('name')).toBeTruthy()
        }
    })

    it('gives every dropdown a distinct id', () => {
        renderRangeCalendar()

        const ids = dropdowns().map((dropdown) => dropdown.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    it('distinguishes the two month pickers from each other by name', () => {
        renderRangeCalendar()

        const names = dropdowns().map((dropdown) => dropdown.getAttribute('aria-label') ?? '')

        expect(names.filter((name) => name.startsWith('Month:'))).toHaveLength(2)
        expect(names.filter((name) => name.startsWith('Year:'))).toHaveLength(2)

        // The two MONTH pickers are what a range calendar makes ambiguous, and they are now distinct.
        const months = names.filter((name) => name.startsWith('Month:'))
        expect(new Set(months).size).toBe(2)

        // Two year pickers showing the same year still share a name. That is inherent to the value rather
        // than a missing name, and is recorded here so the limit is documented rather than discovered.
        const years = names.filter((name) => name.startsWith('Year:'))
        expect(years).toEqual(['Year: 2026', 'Year: 2026'])
    })

    it('leaves the visible caption label intact', () => {
        /*
         * The first attempt at this fix reimplemented the library's `Dropdown` and dropped the caption
         * span it also renders, so the month name vanished from the calendar while the accessible name was
         * perfect. Both halves are asserted from here on.
         */
        renderRangeCalendar()

        // Read from the caption span, not from an <option> - both carry the text, and only one is painted.
        const captions = Array.from(document.querySelectorAll('[class*="caption_label"]'))
            .map((caption) => (caption.textContent ?? '').trim())

        expect(captions.some((caption) => caption.includes('Aug'))).toBe(true)
        expect(captions.some((caption) => caption.includes('Sep'))).toBe(true)
    })

    it('states each dropdown\'s purpose AND its current value', () => {
        renderRangeCalendar()

        // August and September 2026, from the `defaultMonth` above.
        expect(screen.getByRole('combobox', { name: 'Month: Aug' })).toBeInTheDocument()
        expect(screen.getByRole('combobox', { name: 'Month: Sep' })).toBeInTheDocument()
        expect(screen.getAllByRole('combobox', { name: 'Year: 2026' })).toHaveLength(2)
    })

    it('keeps every option the library offered, so the control still works', () => {
        // A custom renderer that dropped options would name the control perfectly and break it.
        renderRangeCalendar()

        const months = dropdowns().filter((dropdown) => dropdown.name.includes('month'))
        for (const month of months) {
            expect(month.options).toHaveLength(12)
        }
    })
})
