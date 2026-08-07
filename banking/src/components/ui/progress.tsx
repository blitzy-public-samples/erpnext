import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { cva, VariantProps } from "class-variance-authority"

const progressVariants = cva(
  "bg-surface-gray-2 relative w-full overflow-hidden rounded-full",
  {
    variants: {
      size: {
        sm: "h-0.5",
        md: "h-1",
        lg: "h-2.5",
        xl: "h-3"
      }
    }
  }
)

interface ProgressProps extends React.ComponentProps<typeof ProgressPrimitive.Root>, VariantProps<typeof progressVariants> {
  /** Optional text label displayed on the progress bar */
  label?: React.ReactNode,
  /** Whether to show a hint/tooltip for the progress value */
  hint?: boolean,
  /** Override the default hint text with custom progress value */
  hintText?: React.ReactNode
}

function Progress({
  className,
  value,
  size = "sm",
  label,
  hint,
  hintText,
  "aria-label": ariaLabel,
  ...props
}: ProgressProps) {

  const progressValue = hintText ? hintText : `${value}%`

  /*
   * The value is handed to the primitive, not only to the indicator's transform.
   *
   * It used to be destructured here and then never passed on, so `Progress.Root` saw no value at all:
   * every bar in the application reported `data-state="indeterminate"` with no `aria-valuenow`, and a
   * screen reader was told a determinate, known figure - "2 of 259 reconciled", "63% imported" - was
   * simply "loading". `null` is the primitive's own way of asking for indeterminate, so a caller that
   * genuinely does not know the figure still has it.
   */
  const rootValue = typeof value === "number" ? value : null

  /*
   * An accessible name, taken from the caller's `aria-label` or from a plain-text `label`. A progress bar
   * with a value but no name announces a bare number, which says nothing about what is progressing. A
   * label carrying markup cannot be flattened safely, so those callers must pass `aria-label` themselves.
   */
  const accessibleName = ariaLabel ?? (typeof label === "string" ? label : undefined)

  return (
    <div className="flex flex-col gap-2.5">
      {label || hint ? <div className="flex items-center justify-between gap-1">
        {label && <span className="text-base font-medium text-ink-gray-7">{label}</span>}
        {hint && <span className="text-base font-medium text-ink-gray-5">{progressValue}</span>}
      </div> : null}
      <ProgressPrimitive.Root
        data-slot="progress"
        data-size={size}
        value={rootValue}
        aria-label={accessibleName}
        /* The spoken value: the caller's own wording where it has some ("2 / 259 reconciled"), which is
           more use than a bare percentage, and the percentage otherwise. */
        getValueLabel={(current, max) =>
          typeof hintText === "string" ? hintText : `${Math.round((current / max) * 100)}%`
        }
        className={cn(
          progressVariants({ size }),
          className
        )}
        {...props}
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="bg-surface-gray-7 rounded-xl h-full w-full flex-1 transition-all"
          style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
        />
      </ProgressPrimitive.Root>
    </div>
  )
}

export { Progress }
