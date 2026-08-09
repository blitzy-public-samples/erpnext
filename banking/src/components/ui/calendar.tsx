import * as React from "react"
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react"
import {
  DayPicker,
  Dropdown,
  getDefaultClassNames,
  type DayButton,
} from "react-day-picker"

import { cn } from "@/lib/utils"
import _ from "@/lib/translate"
import { Button, buttonVariants } from "@/components/ui/button"

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = "label",
  buttonVariant = "ghost",
  formatters,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  buttonVariant?: React.ComponentProps<typeof Button>["variant"]
}) {
  const defaultClassNames = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(
        "bg-surface-modal group/calendar p-3 [--cell-size:--spacing(8)] [[data-slot=card-content]_&]:bg-transparent [[data-slot=popover-content]_&]:bg-transparent",
        String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
        String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
        className
      )}
      captionLayout={captionLayout}
      formatters={{
        formatMonthDropdown: (date) =>
          date.toLocaleString("default", { month: "short" }),
        ...formatters,
      }}
      classNames={{
        root: cn("w-fit", defaultClassNames.root),
        months: cn(
          "flex gap-4 flex-col md:flex-row relative",
          defaultClassNames.months
        ),
        month: cn("flex flex-col w-full gap-4", defaultClassNames.month),
        nav: cn(
          "flex items-center gap-1 w-full absolute top-0 inset-x-0 justify-between",
          defaultClassNames.nav
        ),
        button_previous: cn(
          buttonVariants({ variant: buttonVariant }),
          "size-(--cell-size) aria-disabled:opacity-50 p-0 select-none",
          defaultClassNames.button_previous
        ),
        button_next: cn(
          buttonVariants({ variant: buttonVariant }),
          "size-(--cell-size) aria-disabled:opacity-50 p-0 select-none",
          defaultClassNames.button_next
        ),
        month_caption: cn(
          "flex items-center justify-center h-(--cell-size) w-full px-(--cell-size)",
          defaultClassNames.month_caption
        ),
        dropdowns: cn(
          "w-full flex items-center text-sm font-medium justify-center h-(--cell-size) gap-1.5",
          defaultClassNames.dropdowns
        ),
        dropdown_root: cn(
          /*
           * The focus ring was `outline-gray-1` at 50% alpha - gray-200 in light, so about 1.1:1
           * against the field it surrounds and invisible in practice. `outline-gray-5` is the ramp's
           * focus value and clears the 3:1 non-text floor in both themes. Geometry unchanged.
           */
          "relative has-focus:border-outline-gray-5 border border-outline-gray-2 shadow-xs has-focus:ring-outline-gray-5 has-focus:ring-[3px] rounded-md",
          defaultClassNames.dropdown_root
        ),
        dropdown: cn(
          "absolute bg-surface-modal inset-0 opacity-0",
          defaultClassNames.dropdown
        ),
        caption_label: cn(
          "select-none font-medium",
          captionLayout === "label"
            ? "text-sm"
            : "rounded-md ps-2 pe-1 flex items-center gap-1 text-sm h-8 [&>svg]:text-ink-gray-5 [&>svg]:size-3.5",
          defaultClassNames.caption_label
        ),
        table: "w-full border-collapse",
        weekdays: cn("flex", defaultClassNames.weekdays),
        weekday: cn(
          "text-ink-gray-5 rounded-md flex-1 font-normal text-[0.8rem] select-none",
          defaultClassNames.weekday
        ),
        week: cn("flex w-full mt-2", defaultClassNames.week),
        week_number_header: cn(
          "select-none w-(--cell-size)",
          defaultClassNames.week_number_header
        ),
        week_number: cn(
          "text-[0.8rem] select-none text-ink-gray-5",
          defaultClassNames.week_number
        ),
        day: cn(
          "relative w-full h-full p-0 text-center [&:last-child[data-selected=true]_button]:rounded-e-md group/day aspect-square select-none",
          props.showWeekNumber
            ? "[&:nth-child(2)[data-selected=true]_button]:rounded-s-md"
            : "[&:first-child[data-selected=true]_button]:rounded-s-md",
          defaultClassNames.day
        ),
        range_start: cn(
          "rounded-s-md bg-surface-gray-1",
          defaultClassNames.range_start
        ),
        range_middle: cn("rounded-none", defaultClassNames.range_middle),
        range_end: cn("rounded-e-md bg-surface-gray-1", defaultClassNames.range_end),
        today: cn(
          "bg-surface-gray-1 text-ink-gray-8 rounded-md data-[selected=true]:rounded-none",
          defaultClassNames.today
        ),
        outside: cn(
          "text-ink-gray-5 aria-selected:text-ink-gray-5",
          defaultClassNames.outside
        ),
        disabled: cn(
          "text-ink-gray-5 opacity-50",
          defaultClassNames.disabled
        ),
        hidden: cn("invisible", defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Root: ({ className, rootRef, ...props }) => {
          return (
            <div
              data-slot="calendar"
              ref={rootRef}
              className={cn(className)}
              {...props}
            />
          )
        },
        Chevron: ({ className, orientation, ...props }) => {
          if (orientation === "left") {
            return (
              <ChevronLeftIcon className={cn("size-4", className)} {...props} />
            )
          }

          if (orientation === "right") {
            return (
              <ChevronRightIcon
                className={cn("size-4", className)}
                {...props}
              />
            )
          }

          return (
            <ChevronDownIcon className={cn("size-4", className)} {...props} />
          )
        },
        /*
         * The month and year pickers are react-day-picker's own native `<select>`s, laid over the styled
         * caption. Two problems were measured on them, both from the library's defaults, so both are fixed
         * here rather than at the call sites.
         *
         * They arrive with `id=""` and no `name`, and have no associated `<label>`, so the browser cannot
         * identify them for autofill or for restoring a value on a back-navigation, and nothing can address
         * them by a stable selector. `useId` supplies an id unique per instance.
         *
         * The naming is what costs a user something. A range calendar renders TWO months side by side, so
         * the library's stock labels produced four controls sharing two names - two comboboxes both called
         * "Choose the Month" and two both called "Choose the Year" - with nothing to say which panel each
         * governed. Each label now states its own current value, which is what distinguishes the two month
         * pickers. Two year pickers showing the same year still share a name; that is inherent to the value
         * and is a naming weakness rather than a missing name, so it is left rather than papered over with a
         * positional label the user cannot see.
         *
         * Both are delegated to the library's OWN `Dropdown`, not reimplemented. `Dropdown` also renders the
         * visible caption label and its chevron, so replacing it means reproducing that structure from
         * library internals - and getting it slightly wrong erases the month name from the caption, which is
         * exactly what happened on the first attempt.
         */
        MonthsDropdown: ({ options, value, ...props }) => {
          const generatedId = React.useId()
          const displayed =
            options?.find((option) => String(option.value) === String(value))?.label ?? String(value ?? '')

          return (
            <Dropdown
              {...props}
              options={options}
              value={value}
              id={props.id || generatedId}
              name={props.name || 'calendar-month'}
              aria-label={_("Month: {0}", [displayed])}
            />
          )
        },
        YearsDropdown: ({ options, value, ...props }) => {
          const generatedId = React.useId()
          const displayed =
            options?.find((option) => String(option.value) === String(value))?.label ?? String(value ?? '')

          return (
            <Dropdown
              {...props}
              options={options}
              value={value}
              id={props.id || generatedId}
              name={props.name || 'calendar-year'}
              aria-label={_("Year: {0}", [displayed])}
            />
          )
        },
        DayButton: CalendarDayButton,
        WeekNumber: ({ children, ...props }) => {
          return (
            <td {...props}>
              <div className="flex size-(--cell-size) items-center justify-center text-center">
                {children}
              </div>
            </td>
          )
        },
        ...components,
      }}
      {...props}
    />
  )
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: React.ComponentProps<typeof DayButton>) {
  const defaultClassNames = getDefaultClassNames()

  const ref = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])

  return (
    <Button
      ref={ref}
      variant="ghost"
      isIconButton
      data-day={day.date.toLocaleDateString()}
      data-selected-single={
        modifiers.selected &&
        !modifiers.range_start &&
        !modifiers.range_end &&
        !modifiers.range_middle
      }
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        "data-[selected-single=true]:bg-surface-gray-7 data-[selected-single=true]:text-ink-white data-[range-middle=true]:bg-surface-gray-1 data-[range-middle=true]:text-ink-gray-8 data-[range-start=true]:bg-surface-gray-7 data-[range-start=true]:text-ink-white data-[range-end=true]:bg-surface-gray-7 data-[range-end=true]:text-ink-white group-data-[focused=true]/day:border-outline-gray-5 group-data-[focused=true]/day:ring-outline-gray-5 dark:hover:text-ink-gray-8 flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 leading-none font-normal group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:ring-[3px] data-[range-end=true]:rounded-md data-[range-end=true]:rounded-e-md data-[range-middle=true]:rounded-none data-[range-start=true]:rounded-md data-[range-start=true]:rounded-s-md [&>span]:text-xs [&>span]:opacity-70",
        defaultClassNames.day,
        className
      )}
      {...props}
    />
  )
}

export { Calendar, CalendarDayButton }
