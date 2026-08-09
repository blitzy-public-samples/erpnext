import * as React from "react"

import { useScrollOverflow } from "@/hooks/use-scroll-overflow"
import _ from "@/lib/translate"
import { cn } from "@/lib/utils"

function Table({
  className,
  containerClassName,
  containerLabel,
  ...props
}: React.ComponentProps<"table"> & {
  containerClassName?: string
  /**
   * Accessible name for the scroll container, used only when the table actually overflows
   * horizontally and the container therefore becomes a focusable scroll region.
   */
  containerLabel?: string
}) {
  /**
   * Horizontal overflow is silent by default: overlay scrollbars are invisible at rest, so a wide
   * table (the statement preview grid at narrow widths hides several hundred pixels of columns)
   * looks complete while part of it is unreachable without a discovered gesture.
   */
  const { ref: containerRef, ...overflow } = useScrollOverflow<HTMLDivElement>()

  return (
    <div
      ref={containerRef}
      data-slot="table-container"
      data-overflowing={overflow.overflows ? "" : undefined}
      className={cn(
        "relative w-full overflow-x-auto rounded border-outline-gray-1 border",
        // Marks the edge that content disappears behind, so the truncation is visible at rest.
        overflow.overflows && !overflow.atEnd && "ltr:border-r-2 rtl:border-l-2 border-r-outline-gray-3",
        overflow.overflows && !overflow.atStart && "ltr:border-l-2 rtl:border-r-2 border-l-outline-gray-3",
        containerClassName,
      )}
      /**
       * A scrollable region needs to be operable from the keyboard, but only while it scrolls -
       * an unconditional tab stop would add an interaction-free stop to every table that fits.
       */
      {...(overflow.overflows
        ? {
          role: "region",
          tabIndex: 0,
          "aria-label": containerLabel
            ? _("{0} (scrollable)", [containerLabel])
            : _("Scrollable table"),
        }
        : {})}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "bg-surface-gray-2 border-t font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "hover:bg-surface-gray-1 data-[state=selected]:bg-surface-gray-2 border-b transition-all",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "bg-surface-gray-2 text-ink-gray-5 text-sm p-2 text-start align-middle whitespace-nowrap [&:has([role=checkbox])]:pe-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle text-base whitespace-nowrap [&:has([role=checkbox])]:pe-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-ink-gray-5 my-4 text-sm", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
