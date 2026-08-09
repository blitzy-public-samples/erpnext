import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["p-base", "p-2xs", "p-xs", "p-sm", "p-lg", "p-xl", "p-2xl", "p-3xl"] }
      ]
    }
  }
})



export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Grows a control's *pointer target* to at least 24x24 without altering a single painted pixel.
 *
 * Several design-system controls are deliberately small - a `sm` switch track is 16px tall, a `sm`
 * checkbox is 14px square, a radio is 16px square - which leaves the pointer target well under the
 * 24x24 minimum. Because the painted size belongs to the design and must not change, the target is
 * grown instead of the control: a transparent, centred `::before` that is at least 24x24 and
 * otherwise tracks the control's own box. The pseudo-element is part of the control's box for
 * hit-testing, so a press anywhere inside it activates the control itself, and because it paints
 * nothing (`content: ""` with no background) the visual result is byte-identical.
 *
 * It is centred rather than anchored so the extra area is shared equally on all four sides, which
 * keeps it from reaching into a neighbouring control on only one side.
 */
export const TARGET_MIN_SIZE =
  "relative before:absolute before:top-1/2 before:left-1/2 before:size-full before:min-h-6 before:min-w-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
