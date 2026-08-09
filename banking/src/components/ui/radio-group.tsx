import * as React from "react"
import { CircleIcon } from "lucide-react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

import { cn, TARGET_MIN_SIZE } from "@/lib/utils"

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  )
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "border-outline-gray-2 text-ink-gray-7 focus-visible:border-outline-gray-5 focus-visible:ring-outline-gray-5 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive aspect-square size-4 shrink-0 rounded-full border shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        /*
         * Two accessibility corrections, both token-for-token within the ramp the theme already
         * defines. (1) The focus ring was `outline-gray-1` at 50% alpha, which resolves to roughly
         * 1.1:1 against the surfaces this control sits on - effectively invisible; `outline-gray-5`
         * is the ramp's high-contrast focus value (10:1 light, 5.8:1 dark) and clears the 3:1
         * non-text floor in both themes. (2) The control paints 16px square, so the pointer target
         * is grown to the 24x24 minimum without changing the painted size. See TARGET_MIN_SIZE.
         */
        TARGET_MIN_SIZE,
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="fill-primary absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  )
}

export { RadioGroup, RadioGroupItem }
