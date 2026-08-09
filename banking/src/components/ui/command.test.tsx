/**
 * Behavioural specification for the command palette's filter field.
 *
 * Every combobox in the application - the company selector, the period picker, the account dropdown
 * and the generic link field - mounts one of these, and not one of the four supplied an `id` or a
 * `name`. Chrome reported "A form field element should have an id or name attribute" once per mounted
 * popover, and a field the browser cannot identify is one it cannot restore on a back-navigation or
 * associate with a label.
 *
 * The fix defaults both attributes in the primitive rather than at the four call sites, so a fifth
 * combobox cannot be added without them.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { Command, CommandInput } from './command'

const renderInput = (props: Partial<React.ComponentProps<typeof CommandInput>> = {}) => {
    render(
        <Command>
            <CommandInput placeholder="Search account..." {...props} />
        </Command>
    )

    return screen.getByPlaceholderText('Search account...')
}

describe('CommandInput', () => {

    it('identifies itself even when the caller supplies nothing', () => {
        const field = renderInput()

        expect(field.getAttribute('name')).toBeTruthy()
        // cmdk assigns the id; between the two the field is always identifiable.
        expect(field.getAttribute('id')).toBeTruthy()
    })

    it('gives two simultaneously open popovers distinct ids', () => {
        // A combobox can open inside a modal that already has one, and two fields sharing an id would
        // make any `htmlFor` or `aria-describedby` pointing at either of them ambiguous.
        render(
            <>
                <Command><CommandInput placeholder="Search company..." /></Command>
                <Command><CommandInput placeholder="Search account..." /></Command>
            </>
        )

        const first = screen.getByPlaceholderText('Search company...')
        const second = screen.getByPlaceholderText('Search account...')

        expect(first.id).not.toBe(second.id)
    })

    it('lets a caller name the field itself', () => {
        const field = renderInput({ name: 'account_query' })

        expect(field).toHaveAttribute('name', 'account_query')
    })

    it('cannot promise an id override, and does not pretend to', () => {
        /*
         * cmdk sets `id` after spreading the caller's props, so it always wins. Asserted here so the
         * comment in the component is checkable rather than merely claimed - if cmdk ever changes this,
         * the docblock stops being true and this test says so.
         */
        const field = renderInput({ id: 'account-search' } as Partial<React.ComponentProps<typeof CommandInput>>)

        expect(field).not.toHaveAttribute('id', 'account-search')
    })

    it('stays a plain text field, so no browser search decoration appears', () => {
        // `type="search"` would have identified the field too, at the cost of Chrome painting its own
        // clear button inside a control the design already draws.
        const field = renderInput()

        expect(field.getAttribute('type')).not.toBe('search')
    })
})
