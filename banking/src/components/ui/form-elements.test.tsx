/**
 * Behavioural specification for the shared form-element primitives' required-field contract, and for
 * the Select's controlled/uncontrolled hygiene.
 *
 * Two independent defects lived here.
 *
 * `isRequired` and `rules` were two switches for one constraint. The flag drew the red asterisk and set
 * `aria-required`; only a separate `rules={{ required: ... }}` actually stopped a submission. Seventeen
 * fields across the modal forms set the flag and never set the rule, so they told the reviewer - and
 * told assistive technology - that a value was mandatory, and then submitted without one. Nothing
 * marked the control invalid and no message appeared, because react-hook-form had no rule to violate.
 * The rule is now derived from the flag, which is why the tests below exercise the DERIVATION rather
 * than any one call site: a call site can be fixed and re-broken, whereas a primitive that cannot
 * express "required in appearance only" cannot drift.
 *
 * The Select was handed `field.value`, which react-hook-form reports as `undefined` for a field with no
 * default. Radix decides controlled-ness from whether `value` is undefined, so the first real value
 * flipped the component from uncontrolled to controlled and React logged that as a warning on every
 * form containing a select. `?? ''` is not a workaround: Radix's own placeholder predicate is
 * `value === "" || value === undefined`, so the two are indistinguishable on screen and only one of
 * them is stable across the component's lifetime.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import type { ReactNode } from 'react'

import { Form } from './form'
import { Button } from './button'
import { SelectItem } from './select'
import { DataField, SelectFormField, SmallTextField } from './form-elements'

type Values = Record<string, unknown>

/** Renders children inside a real react-hook-form, and reports what a submit attempt produced. */
const Harness = ({
    children,
    onValid,
    defaultValues,
}: {
    children: ReactNode
    onValid: (values: Values) => void
    defaultValues?: Values
}) => {
    const form = useForm<Values>({ defaultValues })

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onValid)}>
                {children}
                <Button type="submit">Save</Button>
            </form>
        </Form>
    )
}

const renderForm = (children: ReactNode, defaultValues?: Values) => {
    const onValid = vi.fn()
    render(<Harness onValid={onValid} defaultValues={defaultValues}>{children}</Harness>)
    return { onValid, user: userEvent.setup() }
}

const control = (name: string): HTMLElement => {
    const node = document.querySelector<HTMLElement>(`[name="${name}"]`)
    if (!node) throw new Error(`no control named ${name}`)
    return node
}

const save = () => screen.getByRole('button', { name: 'Save' })

describe('required fields derive their validation rule from isRequired', () => {

    it('refuses a submission when a required field is empty', async () => {
        const { onValid, user } = renderForm(
            <DataField name="reference_no" label="Reference" isRequired />,
        )

        await user.click(save())

        await waitFor(() => {
            expect(screen.getByText('Reference is required')).toBeInTheDocument()
        })
        expect(onValid).not.toHaveBeenCalled()
    })

    it('marks the empty control invalid and points the message at it', async () => {
        const { user } = renderForm(<DataField name="reference_no" label="Reference" isRequired />)

        await user.click(save())

        const input = control('reference_no')
        await waitFor(() => {
            expect(input).toHaveAttribute('aria-invalid', 'true')
        })
        // The message must be REFERENCED, not merely rendered nearby, or a screen-reader user hears
        // an invalid field with no explanation.
        const message = screen.getByText('Reference is required')
        expect(input.getAttribute('aria-describedby') ?? '').toContain(message.id)
    })

    it('names the field, because one form holds a dozen similar controls', async () => {
        const { user } = renderForm(
            <>
                <DataField name="reference_no" label="Reference" isRequired />
                <DataField name="cheque_no" label="Cheque Number" isRequired />
            </>,
        )

        await user.click(save())

        expect(await screen.findByText('Reference is required')).toBeInTheDocument()
        expect(screen.getByText('Cheque Number is required')).toBeInTheDocument()
    })

    it('lets a submission through once the value is supplied', async () => {
        const { onValid, user } = renderForm(<DataField name="reference_no" label="Reference" isRequired />)

        await user.type(control('reference_no'), 'SWEEP-1')
        await user.click(save())

        await waitFor(() => {
            expect(onValid).toHaveBeenCalledTimes(1)
        })
        expect(onValid.mock.calls[0][0]).toMatchObject({ reference_no: 'SWEEP-1' })
    })

    it('leaves a field that is not required alone', async () => {
        const { onValid, user } = renderForm(<DataField name="remarks" label="Remarks" />)

        await user.click(save())

        await waitFor(() => {
            expect(onValid).toHaveBeenCalledTimes(1)
        })
        expect(control('remarks')).not.toHaveAttribute('aria-required')
    })

    it('applies to every element that takes the flag, not only text inputs', async () => {
        const { onValid, user } = renderForm(
            <>
                <SmallTextField name="remarks" label="Remarks" isRequired />
                <SelectFormField name="mode" label="Mode" isRequired>
                    <SelectItem value="Cash">Cash</SelectItem>
                </SelectFormField>
            </>,
        )

        await user.click(save())

        expect(await screen.findByText('Remarks is required')).toBeInTheDocument()
        expect(screen.getByText('Mode is required')).toBeInTheDocument()
        expect(onValid).not.toHaveBeenCalled()
    })

    /**
     * The escape hatch has to exist. A field can be required in appearance while being conditionally
     * optional in validation, and the caller's own rule is the only place that distinction can live.
     */
    it("defers to the caller's own required message", async () => {
        const { user } = renderForm(
            <DataField
                name="reference_no"
                label="Reference"
                isRequired
                rules={{ required: 'Give the bank reference from the statement' }}
            />,
        )

        await user.click(save())

        expect(await screen.findByText('Give the bank reference from the statement')).toBeInTheDocument()
        expect(screen.queryByText('Reference is required')).not.toBeInTheDocument()
    })

    it('honours an explicit opt-out of the derived rule', async () => {
        const { onValid, user } = renderForm(
            <DataField name="reference_no" label="Reference" isRequired rules={{ required: false }} />,
        )

        await user.click(save())

        await waitFor(() => {
            expect(onValid).toHaveBeenCalledTimes(1)
        })
        // Still announced as required - the asterisk and `aria-required` are the caller's stated intent.
        expect(control('reference_no')).toHaveAttribute('aria-required', 'true')
    })

    it('keeps the caller\'s other rules when it adds the required one', async () => {
        const { user } = renderForm(
            <DataField name="reference_no" label="Reference" isRequired rules={{ maxLength: { value: 4, message: 'Too long' } }} />,
        )

        await user.type(control('reference_no'), 'SWEEP-1')
        await user.click(save())

        expect(await screen.findByText('Too long')).toBeInTheDocument()
    })
})

describe('SelectFormField controlled-ness', () => {

    it('is controlled from its first render, with no value in the form', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        try {
            renderForm(
                <SelectFormField name="mode" label="Mode">
                    <SelectItem value="Cash">Cash</SelectItem>
                </SelectFormField>,
            )

            const complaints = [...warn.mock.calls, ...error.mock.calls]
                .map((args) => args.map(String).join(' '))
                .filter((message) => /uncontrolled|controlled/i.test(message))

            expect(complaints).toEqual([])
        } finally {
            warn.mockRestore()
            error.mockRestore()
        }
    })

    it('does not complain when a value arrives after the first render', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        try {
            const { user } = renderForm(
                <SelectFormField name="mode" label="Mode">
                    <SelectItem value="Cash">Cash</SelectItem>
                    <SelectItem value="Cheque">Cheque</SelectItem>
                </SelectFormField>,
            )

            // The transition that produced the warning: undefined -> a real string.
            await user.click(screen.getByRole('combobox'))
            await user.click(await screen.findByRole('option', { name: 'Cash' }))

            const complaints = [...warn.mock.calls, ...error.mock.calls]
                .map((args) => args.map(String).join(' '))
                .filter((message) => /uncontrolled|controlled/i.test(message))

            expect(complaints).toEqual([])
        } finally {
            warn.mockRestore()
            error.mockRestore()
        }
    })

    it('still shows the placeholder rather than an empty selection', () => {
        renderForm(
            <SelectFormField name="mode" label="Mode">
                <SelectItem value="Cash">Cash</SelectItem>
            </SelectFormField>,
        )

        // Radix's placeholder predicate is `value === "" || value === undefined`, so coercing to `''`
        // leaves the rendered state exactly as it was.
        expect(screen.getByRole('combobox')).toHaveAttribute('data-placeholder')
    })
})
