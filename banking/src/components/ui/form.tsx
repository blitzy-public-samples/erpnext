import * as React from "react"
import { Label as LabelPrimitive, Slot as SlotPrimitive } from "radix-ui"

import {
    Controller,
    FormProvider,
    useFormContext,
    useFormState,
    type ControllerProps,
    type FieldPath,
    type FieldValues,
} from "react-hook-form"

import { cn } from "@/lib/utils"
import _ from "@/lib/translate"
import { Label } from "@/components/ui/label"

const Form = FormProvider

type FormFieldContextValue<
    TFieldValues extends FieldValues = FieldValues,
    TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
    name: TName
}

const FormFieldContext = React.createContext<FormFieldContextValue>(
    {} as FormFieldContextValue
)

const FormField = <
    TFieldValues extends FieldValues = FieldValues,
    TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
    ...props
}: ControllerProps<TFieldValues, TName>) => {
    return (
        <FormFieldContext.Provider value={{ name: props.name }}>
            <Controller {...props} />
        </FormFieldContext.Provider>
    )
}

const useFormField = () => {
    const fieldContext = React.useContext(FormFieldContext)
    const itemContext = React.useContext(FormItemContext)
    const { getFieldState } = useFormContext()
    const formState = useFormState({ name: fieldContext.name })
    const fieldState = getFieldState(fieldContext.name, formState)

    if (!fieldContext) {
        throw new Error("useFormField should be used within <FormField>")
    }

    const { id, hasDescription } = itemContext

    return {
        id,
        name: fieldContext.name,
        formItemId: `${id}-form-item`,
        formDescriptionId: `${id}-form-item-description`,
        formMessageId: `${id}-form-item-message`,
        hasDescription: hasDescription ?? false,
        ...fieldState,
    }
}

type FormItemContextValue = {
    id: string
    /** Whether a `FormDescription` is currently mounted inside this item. */
    hasDescription: boolean
    /** Called by `FormDescription` on mount and unmount. */
    setHasDescription: (present: boolean) => void
}

const FormItemContext = React.createContext<FormItemContextValue>(
    {} as FormItemContextValue
)

function FormItem({ className, ...props }: React.ComponentProps<"div">) {
    const id = React.useId()
    /*
     * Tracked rather than assumed, because `FormControl` used to reference the description's id
     * unconditionally. Most fields supply no description, so most controls carried
     * `aria-describedby="…-form-item-description"` pointing at an element that does not exist - a
     * dangling reference, which assistive technology resolves to nothing and which also masks the case
     * where a description was meant to be there and is not.
     *
     * Registration is done by the description itself rather than through a prop on `FormItem`, so it
     * works for every consumer - including the several places that compose these primitives directly
     * instead of going through `form-elements.tsx`.
     */
    const [hasDescription, setHasDescription] = React.useState(false)
    const value = React.useMemo(
        () => ({ id, hasDescription, setHasDescription }),
        [id, hasDescription],
    )

    return (
        <FormItemContext.Provider value={value}>
            <div
                data-slot="form-item"
                className={cn("grid gap-1.5", className)}
                {...props}
            />
        </FormItemContext.Provider>
    )
}

function FormLabel({
    className,
    ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
    const { error, formItemId } = useFormField()

    return (
        <Label
            data-slot="form-label"
            data-error={!!error}
            className={className}
            htmlFor={formItemId}
            {...props}
        />
    )
}

/**
 * The "this field is required" mark shown after a field's label.
 *
 * The asterisk on its own was decorative: it is a punctuation character, so a screen reader either
 * skipped it or read "star", and nothing in the accessible tree said the field was required. The glyph is
 * therefore hidden from assistive technology and the requirement is stated in words alongside it, which
 * become part of the label's accessible name. The controls themselves carry `aria-required`, so the
 * constraint is also readable programmatically rather than only being announced.
 */
function FormRequiredIndicator({ className, ...props }: React.ComponentProps<"span">) {
    /*
     * `ink-red-3`, not `ink-red-2`. The asterisk is always-visible text conveying a real constraint, and
     * `ink-red-2` measured 2.17:1 in light and 1.55:1 in dark - unreadable in both. Every other
     * `text-ink-red-2` in this codebase is a `disabled:` state, which WCAG exempts and which would look
     * live if it were darkened, so the token itself is left alone and only this one usage moves.
     */
    return (
        <span className={cn("text-ink-red-3", className)} {...props}>
            <span aria-hidden="true">*</span>
            {/*
                A COMMA separates the two parts, not a space, and the reason is that no space can.
                An earlier attempt used a leading `{" "}` with a comment calling it load-bearing; it was
                not, and neither is a non-breaking space. Accessible-name computation trims each node's
                text before concatenating, and `trim` treats U+00A0 as whitespace too - both were
                measured producing "Reference(required)", one run-together word. A comma survives
                trimming, so the name computes as "Reference, required", which is also how a screen
                reader naturally announces a constraint. The asterisk stays visible and `aria-hidden`,
                since it already carries the meaning for anyone who can see it.
            */}
            <span className="sr-only">{", "}{_("required")}</span>
        </span>
    )
}

function FormControl({ ...props }: React.ComponentProps<typeof SlotPrimitive.Slot>) {
    const { error, formItemId, formDescriptionId, formMessageId, hasDescription } = useFormField()

    /*
     * Only ids that are actually in the document. `aria-describedby` is an ID-reference list, and a
     * reference to a missing element is silently dropped - so a control with no description and no error
     * previously advertised a description that was never there, and one WITH an error announced the
     * error only by luck of the second id resolving. Omitting the attribute entirely when there is
     * nothing to point at is the correct expression of "no description".
     */
    const describedBy = [
        hasDescription ? formDescriptionId : null,
        error ? formMessageId : null,
    ].filter(Boolean).join(" ")

    return (
        <SlotPrimitive.Slot
            data-slot="form-control"
            id={formItemId}
            aria-describedby={describedBy || undefined}
            aria-invalid={!!error}
            {...props}
        />
    )
}

function FormDescription({ className, ...props }: React.ComponentProps<"p">) {
    const { formDescriptionId } = useFormField()
    const { setHasDescription } = React.useContext(FormItemContext)

    // Announces its own presence to the enclosing item, so `FormControl` can reference it and, just as
    // importantly, stop referencing it when it unmounts.
    React.useEffect(() => {
        setHasDescription?.(true)
        return () => setHasDescription?.(false)
    }, [setHasDescription])

    return (
        <p
            data-slot="form-description"
            id={formDescriptionId}
            className={cn("text-ink-gray-5 text-p-base", className)}
            {...props}
        />
    )
}

function FormMessage({ className, ...props }: React.ComponentProps<"p">) {
    const { error, formMessageId } = useFormField()
    const body = error ? String(error?.message ?? "") : props.children

    if (!body) {
        return null
    }

    return (
        <p
            data-slot="form-message"
            id={formMessageId}
            className={cn("text-ink-red-4 text-p-base", className)}
            {...props}
        >
            {body}
        </p>
    )
}

export {
    useFormField,
    Form,
    FormItem,
    FormLabel,
    FormControl,
    FormDescription,
    FormMessage,
    FormField,
    FormRequiredIndicator,
}
