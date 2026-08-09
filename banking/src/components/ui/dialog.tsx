import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { useReturnFocus } from "@/hooks/use-return-focus"
import { Button } from "@/components/ui/button"
import _ from "@/lib/translate"

/**
 * Dialog widths, as a closed set, every one of them CLAMPED TO THE VIEWPORT.
 *
 * Call sites used to set their own `min-w-*`, and that was the defect rather than a style choice: a
 * minimum width beats a maximum in CSS, so `min-w-7xl` produced a 1280px box inside a 768px viewport and
 * the dialog bled off both edges with its primary and close controls entirely outside the window and no
 * horizontal scroll axis to reach them - Escape was often the only way out of a financial dialog. The
 * same went for `min-w-[95vw]` once the content inside was wider than the box.
 *
 * `w-[min(Nrem,calc(100vw-2rem))]` is the fix and it is one expression: the intended width where there is
 * room for it, and the viewport less a 1rem gutter each side where there is not. `max-w-none` and
 * `sm:max-w-none` are needed to retire the primitive's own defaults, which would otherwise cap this at
 * `lg`; they are listed here rather than at the call sites so no call site can forget them.
 *
 * Named for the Tailwind width scale they correspond to, so migrating a `min-w-3xl` call site to
 * `size="3xl"` is a rename rather than a re-decision.
 */
const DIALOG_SIZES = {
  /** The primitive's own default - `sm:max-w-lg`, untouched. */
  default: "",
  sm: "w-[min(24rem,calc(100vw-2rem))] max-w-none sm:max-w-none",
  xl: "w-[min(36rem,calc(100vw-2rem))] max-w-none sm:max-w-none",
  "2xl": "w-[min(42rem,calc(100vw-2rem))] max-w-none sm:max-w-none",
  "3xl": "w-[min(48rem,calc(100vw-2rem))] max-w-none sm:max-w-none",
  "5xl": "w-[min(64rem,calc(100vw-2rem))] max-w-none sm:max-w-none",
  "7xl": "w-[min(80rem,calc(100vw-2rem))] max-w-none sm:max-w-none",
  /**
   * The widest form surface. Replaces `min-w-[95vw]`.
   *
   * Capped at 90rem rather than left at `calc(100vw-2rem)`: on a 1920px display the uncapped
   * expression produced an ~1888px dialog whose two-column form fields stretched to roughly 900px
   * each, so reading one row meant crossing the whole screen and the eye had to travel back for the
   * next. 90rem still comfortably holds the widest of these forms while keeping label and field
   * within one glance.
   */
  wide: "w-[min(90rem,calc(100vw-2rem))] max-w-none sm:max-w-none",
} as const

export type DialogSize = keyof typeof DIALOG_SIZES

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black-200 dark:bg-black-700",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  size = "default",
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  size?: DialogSize
}) {
  /*
   * Returns focus to the control that opened this dialog. Nearly every dialog in this app is driven by a
   * jotai atom rather than a `DialogTrigger`, so Radix has no trigger to restore focus to and it fell to
   * `document.body` on close - see the note in `use-return-focus.ts`.
   */
  const returnFocusToOpener = useReturnFocus(onCloseAutoFocus)

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      {/*
        `aria-modal` stated explicitly, because Radix does not set it - verified by searching the installed
        `@radix-ui/react-dialog` bundle, which contains no occurrence of the attribute. It renders a real
        modal (it traps focus and marks everything outside `aria-hidden`), so the behaviour was already
        correct, but a `role="dialog"` that never SAYS it is modal leaves assistive technology to infer
        modality from the DOM instead of being told.
      */}
      <DialogPrimitive.Content
        onCloseAutoFocus={returnFocusToOpener}
        data-slot="dialog-content"
        data-size={size}
        aria-modal="true"
        className={cn(
          "bg-surface-modal shadow-xl rounded-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 p-6 duration-200 outline-none sm:max-w-lg max-h-[90vh]",
          /*
           * One grid column that CANNOT be inflated by what is inside it.
           *
           * This element is `display:grid` with no declared columns, so its single implicit track was
           * sized `auto` - and an `auto` track's minimum is the max-content width of its widest item. A
           * wide table therefore stretched the track past the dialog's own box, and the footer, sitting in
           * the same track, went with it: Bank Entry's Submit was off-screen even at 1440px, where the
           * dialog had room to spare. `minmax(0,1fr)` pins the track to the dialog instead, which is what
           * lets a wide child scroll inside its own container - `Table` is already an `overflow-x-auto`
           * wrapper - rather than push the dialog's chrome out of reach.
           */
          "grid-cols-[minmax(0,1fr)]",
          /*
           * BOTH axes scroll. It was `overflow-y-auto`, so anything still too wide overflowed with no
           * scroll axis at all - visible, unreachable, and un-scrollable. `scrollbar-gutter: stable`
           * reserves the space so appearing scrollbars do not reflow the content underneath them.
           */
          "overflow-auto [scrollbar-gutter:stable]",
          DIALOG_SIZES[size],
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            /*
             * A 16px icon is a 16px target unless the control is given one. `size-9` with the icon
             * centred takes it to 36px - still under the 44px ideal, but this control sits in the
             * dialog's own padding and a 44px box would collide with the title; 36px is the largest
             * honest size here, and Escape and the footer's own Close remain full-size alternatives.
             *
             * The focus ring is the other half: `focus:outline-hidden` removed the browser's own with
             * nothing in its place, so this control could hold focus invisibly. `outline-gray-5`
             * resolves dark on the light theme and light on the dark one, so one token serves both.
             *
             * `focus:outline-hidden` is NOT kept alongside the ring, and the reason is easy to miss.
             * `:focus-visible` is a subset of `:focus`, so a keyboard focus matches both selectors at
             * once; the two utilities then collide over the same declaration. `outline-2` supplies only
             * the width plus `outline-style: var(--tw-outline-style)`, while `outline-hidden` sets that
             * variable - and the longhand - to `none`. The computed result was
             * `outline: rgb(56,56,56) none 2px`: the correct width and colour, painted with no style, so
             * the ring measured as present in the computed style and drew nothing at all. Suppressing
             * the outline only when focus is NOT visible keeps the mouse-click case ringless (which is
             * what the original rule was for) without cancelling the keyboard case.
             */
            className="data-[state=open]:bg-surface-gray-1 data-[state=open]:text-ink-gray-8 absolute top-3 ltr:right-3 rtl:left-3 inline-flex size-9 items-center justify-center rounded opacity-70 transition-opacity hover:bg-surface-gray-2 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-outline-gray-5 focus:not-focus-visible:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon className="w-4 h-4" aria-hidden="true" />
            {/* Translated, like every other user-visible string in this app. A screen reader announced
                this control in English on a Hindi or German site. */}
            <span className="sr-only">{_("Close")}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 sm:text-start", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        /*
         * Stays on screen while the dialog scrolls.
         *
         * `DialogContent` is the scroll container and it is capped at 90vh, so a tall dialog - Record
         * Payment at 768px and 1024px, measurably - put its footer below the fold, where the primary
         * action could not be seen and nothing indicated it was there. Sticking it to the bottom of the
         * scrollport keeps Cancel and the primary action in view at every height.
         *
         * The negative margins bleed the background out over the container's own 24px padding, so the
         * content scrolling underneath passes behind an opaque bar rather than through a transparent one.
         */
        "sticky bottom-0 z-10 -mx-6 -mb-6 bg-surface-modal px-6 pb-6 pt-3",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">{_("Close")}</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-2xl leading-6 text-ink-gray-8 font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-ink-gray-7 text-p-base", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
