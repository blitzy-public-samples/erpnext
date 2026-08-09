/**
 * Behavioural specification for the form primitives' ARIA wiring.
 *
 * Two defects lived here, and both were invisible to anyone testing by eye.
 *
 * `FormControl` built `aria-describedby` from a fixed pair of ids - the description's and the
 * message's - regardless of whether either element existed. `aria-describedby` is an ID-reference
 * list, and a reference to a missing element is silently dropped, so a field with no description
 * advertised one that was never in the document, and a field WITH an error announced it only because
 * the second id happened to resolve. It now names only the ids actually mounted, and omits the
 * attribute entirely when there is nothing to point at, which is the honest expression of "no
 * description".
 *
 * `FormRequiredIndicator` separated the label from the word "required" with a space. Accessible-name
 * computation trims each node's text before joining them, and `trim` treats U+00A0 as whitespace too,
 * so both a plain space and a non-breaking space produced the single run-together word
 * "Reference(required)". A comma survives trimming, and is also how a screen reader naturally
 * announces a constraint.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useForm } from 'react-hook-form'

import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
    FormRequiredIndicator,
} from './form'
import { Input } from './input'

interface Values {
    reference: string
}

/**
 * Mounts a single field, optionally with a description and optionally already in error.
 *
 * The error is seeded through `setError` rather than by submitting, because what is under test is the
 * wiring between the control and whichever of the two elements exists - not the validation itself.
 */
const renderField = ({
    withDescription,
    withError,
    required = false,
}: {
    withDescription?: boolean
    withError?: boolean
    required?: boolean
} = {}) => {
    const Harness = () => {
        const form = useForm<Values>({ defaultValues: { reference: '' } })

        if (withError && !form.formState.errors.reference) {
            form.setError('reference', { type: 'required', message: 'Reference is required' })
        }

        return (
            <Form {...form}>
                <FormField
                    control={form.control}
                    name="reference"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>
                                Reference
                                {required && <FormRequiredIndicator />}
                            </FormLabel>
                            <FormControl>
                                <Input {...field} />
                            </FormControl>
                            {withDescription && <FormDescription>As printed on the statement</FormDescription>}
                            <FormMessage />
                        </FormItem>
                    )}
                />
            </Form>
        )
    }

    render(<Harness />)

    return { control: document.querySelector('input[name="reference"]') as HTMLInputElement }
}

/** Every id the control claims to be described by, in order. */
const describedByIds = (control: HTMLElement) =>
    (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)

describe('FormControl', () => {

    describe('aria-describedby', () => {

        it('is absent entirely when there is no description and no error', () => {
            const { control } = renderField()

            expect(control).not.toHaveAttribute('aria-describedby')
        })

        it('names the description when one is mounted', () => {
            const { control } = renderField({ withDescription: true })

            const ids = describedByIds(control)
            expect(ids).toHaveLength(1)
            expect(document.getElementById(ids[0])).toHaveTextContent('As printed on the statement')
        })

        it('names the message when the field is in error', async () => {
            const { control } = renderField({ withError: true })

            await screen.findByText('Reference is required')

            const ids = describedByIds(control)
            expect(ids).toHaveLength(1)
            expect(document.getElementById(ids[0])).toHaveTextContent('Reference is required')
        })

        it('names both, in reading order, when a described field is also in error', async () => {
            const { control } = renderField({ withDescription: true, withError: true })

            await screen.findByText('Reference is required')

            const ids = describedByIds(control)
            expect(ids).toHaveLength(2)
            expect(document.getElementById(ids[0])).toHaveTextContent('As printed on the statement')
            expect(document.getElementById(ids[1])).toHaveTextContent('Reference is required')
        })

        it('never references an element that is not in the document', async () => {
            /*
             * The general invariant, stated once rather than per case: whatever the attribute names
             * must resolve. This is the assertion that would have caught the original defect in any
             * of the four states above.
             */
            for (const options of [
                {},
                { withDescription: true },
                { withError: true },
                { withDescription: true, withError: true },
            ]) {
                const { control } = renderField(options)

                for (const id of describedByIds(control)) {
                    expect(document.getElementById(id)).not.toBeNull()
                }

                document.body.innerHTML = ''
            }
        })
    })
})

describe('FormRequiredIndicator', () => {

    it('separates the label from the constraint so the two do not run together', () => {
        const { control } = renderField({ required: true })

        /*
         * Resolved BY accessible name rather than by reading the markup back, so the assertion runs the
         * same name computation a browser does. Both a plain space and U+00A0 were measured here and
         * produced "Reference(required)" - accessible-name computation trims each node's text before
         * joining, and `trim` strips a non-breaking space too.
         */
        expect(screen.getByRole('textbox', { name: 'Reference, required' })).toBe(control)
        expect(screen.queryByRole('textbox', { name: 'Reference(required)' })).toBeNull()
    })

    it('hides the asterisk from the accessibility tree, so it is not announced as "star"', () => {
        renderField({ required: true })

        const label = screen.getByText('Reference', { selector: 'label' })
        expect(label.querySelector('[aria-hidden="true"]')).toHaveTextContent('*')
    })

    it('keeps the asterisk visible, because it is what carries the meaning to the eye', () => {
        renderField({ required: true })

        const label = screen.getByText('Reference', { selector: 'label' })
        const marker = label.querySelector('[aria-hidden="true"]') as HTMLElement

        expect(marker).not.toHaveClass('sr-only')
    })
})
