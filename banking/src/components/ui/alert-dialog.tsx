import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useReturnFocus } from "@/hooks/use-return-focus"

/**
 * Alert-dialog widths, CLAMPED TO THE VIEWPORT, matching `DialogContent`'s set so a size means the same
 * thing in both primitives. See the note on `DIALOG_SIZES` in `dialog.tsx` for why a call-site `min-w-*`
 * was the wrong tool: a minimum width beats a maximum, so it bled off the screen on a narrow viewport
 * and took its controls with it.
 *
 * `sm` and `default` keep the two the primitive already shipped, so existing call sites are unaffected.
 */
const ALERT_DIALOG_SIZES = {
  sm: "data-[size=sm]:max-w-xs",
  default: "data-[size=default]:sm:max-w-lg",
  "2xl": "w-[min(42rem,calc(100vw-2rem))] max-w-none sm:max-w-none",
  "3xl": "w-[min(48rem,calc(100vw-2rem))] max-w-none sm:max-w-none",
  "5xl": "w-[min(64rem,calc(100vw-2rem))] max-w-none sm:max-w-none",
  "7xl": "w-[min(80rem,calc(100vw-2rem))] max-w-none sm:max-w-none",
} as const

export type AlertDialogSize = keyof typeof ALERT_DIALOG_SIZES

function AlertDialog({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogPortal({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black-200 dark:bg-black-700",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  size = "default",
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  size?: AlertDialogSize
}) {
  const contentRef = React.useRef<HTMLDivElement>(null)

  /*
   * Returns focus to the control that opened this dialog. These dialogs are atom-driven and have no
   * `AlertDialogTrigger`, so Radix has no trigger to restore to and focus fell to `document.body` on
   * close - see the note in `use-return-focus.ts`.
   */
  const returnFocusToOpener = useReturnFocus(onCloseAutoFocus)

  /**
   * Guarantees focus actually LANDS in the dialog, even when its body has not arrived yet.
   *
   * Radix's alert dialog moves focus by doing `event.preventDefault(); cancelRef.current?.focus()` - it
   * focuses the Cancel button specifically, and nothing else. Several dialogs in this app load their body
   * as a lazy chunk, so on a COLD first open there is no Cancel mounted, `cancelRef.current` is null, and
   * the optional call quietly does nothing: default focus behaviour has been prevented, nothing has
   * replaced it, and focus is left on the trigger - which sits in a background the dialog has just marked
   * `aria-hidden`. Chrome logs its "blocked aria-hidden on an element because its descendant retained
   * focus" warning, keyboard users are outside the dialog they just opened, and Escape does not reach it.
   *
   * Checked on the next frame rather than assumed, because Radix's own handler runs immediately AFTER this
   * one (it composes the caller's handler first). If focus did move - the warm case, where Cancel exists -
   * nothing happens here at all. If it did not, the content container takes it, which is where the browser
   * would have put it had default behaviour never been prevented.
   */
  const ensureFocusEntersDialog = (event: Event) => {
    onOpenAutoFocus?.(event)

    requestAnimationFrame(() => {
      const content = contentRef.current
      if (!content || content.contains(document.activeElement)) {
        return
      }

      content.focus({ preventScroll: true })
    })
  }

  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        ref={contentRef}
        // Focusable by script but not by Tab, so the container can hold focus while the body loads
        // without adding a stop to the dialog's own tab order once it has.
        tabIndex={-1}
        onOpenAutoFocus={ensureFocusEntersDialog}
        onCloseAutoFocus={returnFocusToOpener}
        // Stated explicitly for the same reason as in `dialog.tsx`: Radix renders a real modal but never
        // sets `aria-modal`, so the attribute is supplied here rather than left to be inferred.
        aria-modal="true"
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          "bg-surface-modal shadow-xl rounded-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 group/alert-dialog-content fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 p-6 duration-200",
          /* One uninflatable column and both scroll axes - see the same two notes in `dialog.tsx`. */
          "grid-cols-[minmax(0,1fr)] max-h-[90vh] overflow-auto [scrollbar-gutter:stable]",
          ALERT_DIALOG_SIZES[size],
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        "grid grid-rows-[auto_1fr] place-items-center gap-1.5 has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-6 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-start sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end",
        /* Kept in view while the dialog scrolls - see the same note on `DialogFooter`. */
        "sticky bottom-0 z-10 -mx-6 -mb-6 bg-surface-modal px-6 pb-6 pt-3",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(
        "text-2xl leading-6 text-ink-gray-8 font-semibold sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-ink-gray-7 text-p-base", className)}
      {...props}
    />
  )
}

function AlertDialogMedia({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "bg-surface-gray-1 mb-2 inline-flex size-16 items-center justify-center rounded-md sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-8",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  variant = "solid",
  size = "md",
  theme = "red",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size" | "theme">) {
  return (
    <Button variant={variant} size={size} theme={theme} asChild>
      <AlertDialogPrimitive.Action
        data-slot="alert-dialog-action"
        className={cn(className)}
        {...props}
      />
    </Button>
  )
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "md",
  theme = "gray",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size" | "theme">) {
  return (
    <Button variant={variant} size={size} theme={theme} asChild>
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        className={cn(className)}
        {...props}
      />
    </Button>
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
