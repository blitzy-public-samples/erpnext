import { FieldValues, RegisterOptions, useFormContext } from "react-hook-form"
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage, FormRequiredIndicator, useFormField } from "@/components/ui/form"
import _ from "@/lib/translate"
import { Input } from "./input"
import { ComponentProps, FocusEventHandler, useCallback, useState } from "react"
import { parseDate } from "chrono-node"
import { formatDate, getUserDateFormat, toDate } from "@/lib/date"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"
import { Button } from "./button"
import { CalendarIcon } from "lucide-react"
import { Calendar } from "./calendar"
import dayjs from "dayjs"
import { Textarea } from "./textarea"
import AccountsDropdown, { AccountsDropdownProps } from "../common/AccountsDropdown"
import PartyTypeDropdown, { PartyTypeDropdownProps } from "../common/PartyTypeDropdown"
import CurrencyInput from "react-currency-input-field"
import { getSystemDefault } from "@/lib/frappe"
import { getCurrencySymbol } from "@/lib/currency"
import { getCurrencyFormatInfo, parseCurrencyInput } from "@/lib/numbers"
import LinkFieldCombobox, { LinkFieldComboboxProps } from "../common/LinkFieldCombobox"
import { Select, SelectContent, SelectTrigger, SelectValue } from "./select"
import { InputGroup, InputGroupAddon } from "./input-group"

/*
 * `isRequired` used to draw a red asterisk beside the label and nothing else, so the constraint
 * existed only for a sighted reader: an asterisk is punctuation that a screen reader either skips
 * or reads as "star", and nothing in the accessibility tree marked the control itself as required.
 * Every component below now also forwards `aria-required` to the control it renders, which is what
 * makes the constraint programmatically determinable.
 *
 * `aria-required` and not the native `required` attribute, deliberately. None of the ten <form>
 * elements in this app sets `noValidate`, so a native `required` would engage the browser's own
 * constraint validation - which runs BEFORE the submit handler - and the user would get Chrome's
 * bubble in place of the `FormMessage` that react-hook-form renders from this form's own rules.
 * `aria-required` announces the constraint without taking validation away from the form.
 */
interface FormElementProps {
    name: string,
    rules?: Omit<RegisterOptions<FieldValues, string>, "disabled" | "valueAsNumber" | "valueAsDate" | "setValueAs">,
    label: string,
    isRequired?: boolean,
    disabled?: boolean,
    formDescription?: string,
    hideLabel?: boolean,
    readOnly?: boolean,

}

interface DataFieldProps extends FormElementProps {
    inputProps?: Omit<ComponentProps<"input">, "value" | "onChange" | "onBlur" | "name" | "ref">
}

export const DataField = ({ name, rules, label, isRequired, formDescription, inputProps, hideLabel, disabled, readOnly }: DataFieldProps) => {

    const { control } = useFormContext()
    return <FormField
        control={control}
        disabled={disabled}
        name={name}
        rules={rules}
        render={({ field }) => (
            <FormItem className='flex flex-col'>
                <FormLabel className={hideLabel ? 'sr-only' : ''}>{label}{isRequired && <FormRequiredIndicator />}</FormLabel>
                <FormControl>
                    <Input {...field} maxLength={140} aria-readonly={readOnly} readOnly={readOnly} aria-required={isRequired || undefined} {...inputProps} />
                </FormControl>
                {formDescription && <FormDescription>{formDescription}</FormDescription>}
                <FormMessage />
            </FormItem>
        )}
    />
}

interface SelectFieldProps extends FormElementProps {
    children: React.ReactNode
}

export const SelectFormField = ({ name, rules, label, isRequired, formDescription, hideLabel, children, disabled, readOnly }: SelectFieldProps) => {

    const { control } = useFormContext()

    return <FormField
        control={control}
        name={name}
        disabled={disabled}
        rules={rules}
        render={({ field }) => (
            <FormItem>
                <FormLabel className={hideLabel ? 'sr-only' : ''}>{label}{isRequired && <FormRequiredIndicator />}</FormLabel>
                <FormControl>
                    <Select onValueChange={field.onChange} value={field.value} disabled={disabled || readOnly} aria-readonly={readOnly}>
                        <FormControl>
                            <SelectTrigger className="w-full" aria-required={isRequired || undefined}>
                                <SelectValue />
                            </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                            {children}
                        </SelectContent>
                    </Select>
                </FormControl>
                {formDescription && <FormDescription>{formDescription}</FormDescription>}
                <FormMessage />
            </FormItem>
        )}
    />
}

interface DateFieldProps extends FormElementProps {
    inputProps?: Omit<ComponentProps<"input">, "value" | "onChange" | "onBlur" | "name" | "ref">
}

export const DateField = ({ name, rules, label, isRequired, formDescription, inputProps, hideLabel, disabled }: DateFieldProps) => {

    const { control } = useFormContext()

    const DatePicker = ({ field }: { field: FieldValues }) => {

        const userDateFormat = getUserDateFormat()
        const [open, setOpen] = useState(false)

        const [value, setValue] = useState<string | undefined>(field.value ? formatDate(field.value) : undefined)

        const date = field.value ? toDate(field.value) : undefined

        return <div className="relative flex gap-2">
            <FormControl>
                <Input className="pe-10"
                    name={field.name}
                    onBlur={() => {
                        setValue(formatDate(field.value))
                        field.onBlur()
                    }}
                    placeholder={userDateFormat}
                    value={value}
                    onChange={(e) => {
                        setValue(e.target.value)
                        if (e.target.value) {
                            // On change in value, try computing date usning standard formats first
                            const dateObj = toDate(e.target.value, userDateFormat)
                            // If we find a valid date, use it
                            if (dateObj && !isNaN(dateObj.getTime())) {
                                field.onChange(formatDate(dateObj, "YYYY-MM-DD"))
                            } else {
                                // If not, try parsing using chrono-node for things like "1st July 2025"
                                const date = parseDate(e.target.value)
                                if (date) {
                                    field.onChange(formatDate(date, "YYYY-MM-DD"))
                                }
                            }
                        } else {
                            field.onChange("")
                        }
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "ArrowDown") {
                            e.preventDefault()
                            setOpen(true)
                        }
                    }}
                    maxLength={140}
                    aria-required={isRequired || undefined}
                    {...inputProps} />
            </FormControl>
            {/* The calendar trigger's id is derived from the field rather than being the literal
                "date-picker-button" it carried: the Bank Entry form renders a date field per row, so a
                fixed id appeared several times in one document. Duplicate ids are invalid and make
                `getElementById` and any `for`/`aria-*` reference ambiguous. */}
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        id={`${field.name}-date-picker-button`}
                        variant="ghost"
                        className="absolute top-1/2 ltr:right-2 rtl:left-2 size-6 -translate-y-1/2"
                    >
                        <CalendarIcon className="size-3.5" />
                        <span className="sr-only">{_("Select date")}</span>
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto overflow-hidden p-0" align="center">
                    <Calendar
                        mode="single"
                        selected={date}
                        fixedWeeks
                        endMonth={dayjs().add(1, "year").toDate()}
                        captionLayout="dropdown"
                        defaultMonth={date}
                        onSelect={(date) => {
                            setValue(formatDate(date))
                            field.onChange(formatDate(date, "YYYY-MM-DD"))
                            setOpen(false)
                        }}
                    />
                </PopoverContent>
            </Popover>
        </div>
    }

    return <FormField
        control={control}
        name={name}
        disabled={disabled}
        rules={rules}
        render={({ field }) => (
            <FormItem className='flex flex-col'>
                <FormLabel className={hideLabel ? 'sr-only' : ''}>{label}{isRequired && <FormRequiredIndicator />}</FormLabel>
                <DatePicker field={field} />
                {formDescription && <FormDescription>{formDescription}</FormDescription>}
                <FormMessage />
            </FormItem>
        )}
    />
}


interface SmallTextFieldProps extends FormElementProps {
    inputProps?: Omit<ComponentProps<"textarea">, "value" | "onChange" | "onBlur" | "name" | "ref">
}

export const SmallTextField = ({ name, rules, label, isRequired, formDescription, inputProps, hideLabel, disabled, readOnly }: SmallTextFieldProps) => {

    const { control } = useFormContext()
    return <FormField
        control={control}
        name={name}
        disabled={disabled}
        rules={rules}
        render={({ field }) => (
            <FormItem className='flex flex-col'>
                <FormLabel className={hideLabel ? 'sr-only' : ''}>{label}{isRequired && <FormRequiredIndicator />}</FormLabel>
                <FormControl>
                    <Textarea {...field} {...inputProps} readOnly={readOnly} aria-readonly={readOnly} aria-required={isRequired || undefined} />
                </FormControl>
                {formDescription && <FormDescription>{formDescription}</FormDescription>}
                <FormMessage />
            </FormItem>
        )}
    />
}


interface AccountFormFieldProps extends Omit<AccountsDropdownProps, 'value' | 'onChange'>, FormElementProps {
}
export const AccountFormField = (props: AccountFormFieldProps) => {

    const { control } = useFormContext()

    return <FormField
        control={control}
        disabled={props.disabled}
        name={props.name}
        rules={props.rules}
        render={({ field }) => (
            <FormItem className='flex flex-col'>
                <FormLabel className={props.hideLabel ? 'sr-only' : ''}>{props.label}{props.isRequired && <FormRequiredIndicator />}</FormLabel>
                <AccountsDropdown {...props} value={field.value} onChange={field.onChange} useInForm readOnly={props.readOnly} isRequired={props.isRequired} />
                {props.formDescription && <FormDescription>{props.formDescription}</FormDescription>}
                <FormMessage />
            </FormItem>
        )}
    />
}

interface PartyTypeFormField extends FormElementProps {
    inputProps?: Omit<PartyTypeDropdownProps, 'value' | 'onChange'>
}

export const PartyTypeFormField = ({ name, rules, label, isRequired, formDescription, hideLabel, inputProps, disabled, readOnly }: PartyTypeFormField) => {

    const { control } = useFormContext()

    return <FormField
        control={control}
        disabled={disabled}
        name={name}
        rules={rules}
        render={({ field }) => (
            <FormItem className='flex flex-col'>
                <FormLabel className={hideLabel ? 'sr-only' : ''}>{label}{isRequired && <FormRequiredIndicator />}</FormLabel>
                <PartyTypeDropdown {...inputProps} value={field.value} onChange={field.onChange} useInForm readOnly={readOnly} isRequired={isRequired} />
                {formDescription && <FormDescription>{formDescription}</FormDescription>}
                <FormMessage />
            </FormItem>
        )}
    />
}


interface CurrencyFormFieldProps extends FormElementProps {
    currency?: string,
    style?: React.CSSProperties,
    leftSlot?: React.ReactNode,
}

export const CurrencyFormField = ({ name, rules, label, isRequired, formDescription, hideLabel, currency, disabled, readOnly, style = {}, leftSlot }: CurrencyFormFieldProps) => {

    const { control } = useFormContext()

    const defaultCurrency = getSystemDefault("currency")
    const currencySymbol = getCurrencySymbol(currency ?? defaultCurrency)


    const CurrencyField = ({ field }: { field: FieldValues }) => {

        const onFocus: FocusEventHandler<HTMLInputElement> = useCallback((e) => {
            // When the input is focused, select the text
            // A short timeout is needed so that the input selects the text after the focus event
            setTimeout(() => {
                // Check if the input is focused - do not select text if the input is not focused
                if (e.target.contains(document.activeElement)) {
                    e.target.select()
                }
            }, 100)
        }, [])

        /*
         * The accessibility wiring is applied HERE, on the control itself, rather than by wrapping this
         * field in a `FormControl`.
         *
         * `FormControl` is a Radix `Slot`: it stamps `id`, `aria-describedby` and `aria-invalid` onto its
         * single direct child. The only child it can reach here is the `InputGroup` DIV that has to sit
         * between it and the input, so the id landed on that div while this component put the SAME id on
         * the real input - two elements sharing one id, with the label's `htmlFor` resolving to the div.
         * A div is not a labelable element, so every currency field in the app computed an EMPTY
         * accessible name, and the error message was associated with the wrapper rather than the field.
         */
        const { formItemId, formDescriptionId, formMessageId, error } = useFormField()

        // Get the correct separators for the currency
        const formatInfo = getCurrencyFormatInfo(currency ?? defaultCurrency)
        const groupSeparator = formatInfo.group_sep || ","
        const decimalSeparator = formatInfo.decimal_str || "."

        return <CurrencyInput
            ref={field.ref}
            name={field.name}
            style={{
                textAlign: 'right',
                ...style
            }}
            id={formItemId}
            onBlur={field.onBlur}
            disabled={field.disabled}
            readOnly={readOnly}
            aria-readonly={readOnly}
            aria-required={isRequired || undefined}
            aria-invalid={!!error}
            aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId}
            onFocus={onFocus}
            groupSeparator={groupSeparator}
            decimalSeparator={decimalSeparator}
            placeholder={`${currencySymbol} 0${decimalSeparator}00`}
            decimalsLimit={2}
            value={field.value}
            maxLength={12}
            decimalScale={2}
            /* The library's k/m/b shorthand is off. These fields carry posted monetary amounts, and a
               stray letter multiplied the figure by up to a billion without a word - `1b` became
               1,000,000,000. Off, non-numeric characters are simply dropped. */
            disableAbbreviations
            prefix={currencySymbol + " "}
            onValueChange={(v, _n, values) => {
                /*
                 * The number stored here is the library's own parsed float, never a re-read of the
                 * displayed text: re-parsing a grouped string yielded `NaN`, and re-parsing a partially
                 * typed one moved the decimal point, which is how 1.23 was inflated to 1,230,000,000.
                 *
                 * The text is echoed back instead - and only - while the entry cannot yet be represented
                 * by its number: a lone minus, a bare separator, or a decimal in progress. A field
                 * controlled by the number cannot be typed into past the separator, because `250.` parses
                 * to 250 and echoing `250` back drops the keystroke, sending the next digit into the
                 * units: that is how `-250.50` was stored as -25050. See `parseCurrencyInput`.
                 */
                const parsed = parseCurrencyInput({ text: v, float: values?.float, decimalSeparator })
                field.onChange(parsed.keepText || parsed.isInvalid ? parsed.text : parsed.value)
            }}
            customInput={Input}
        />
    }

    return <FormField
        control={control}
        disabled={disabled}
        name={name}
        rules={rules}
        render={({ field }) => (
            <FormItem className='flex flex-col'>
                <FormLabel className={hideLabel ? 'sr-only' : ''}>{label}{isRequired && <FormRequiredIndicator />}</FormLabel>

                <InputGroup>
                    {leftSlot && <InputGroupAddon>{leftSlot}</InputGroupAddon>}
                    <CurrencyField field={field} />
                </InputGroup>
                {formDescription && <FormDescription>{formDescription}</FormDescription>}
                <FormMessage />
            </FormItem>
        )}
    />
}

interface LinkFormFieldProps extends FormElementProps, Omit<LinkFieldComboboxProps, 'value' | 'onChange'> {
}

export const LinkFormField = ({ name, rules, label, isRequired, formDescription, hideLabel, disabled, readOnly, ...inputProps }: LinkFormFieldProps) => {

    const { control } = useFormContext()

    return <FormField
        control={control}
        name={name}
        disabled={disabled}
        rules={rules}
        render={({ field }) => (
            <FormItem className='flex flex-col'>
                <FormLabel className={hideLabel ? 'sr-only' : ''}>{label}{isRequired && <FormRequiredIndicator />}</FormLabel>
                <LinkFieldCombobox {...inputProps} value={field.value} onChange={field.onChange} useInForm disabled={disabled} readOnly={readOnly} isRequired={isRequired} />
                {formDescription && <FormDescription>{formDescription}</FormDescription>}
                <FormMessage />
            </FormItem>
        )}
    />
}