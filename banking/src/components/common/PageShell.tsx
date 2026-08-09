import { H1 } from "@/components/ui/typography"
import { cn } from "@/lib/utils"
import _ from "@/lib/translate"

/** The id the skip link targets and the `main` landmark carries. One per document. */
export const MAIN_CONTENT_ID = "banking-main-content"

/**
 * The first focusable thing in the document: a link that jumps past the header to the content.
 *
 * A reviewer driving this workbench from the keyboard otherwise has to walk the breadcrumb, the
 * company selector, four header controls and the date filter before reaching a transaction - on every
 * single route change, because the SPA re-renders the header each time. The link is off-screen until it
 * takes focus, so it costs the visual design nothing and is discoverable by exactly the people who
 * need it.
 *
 * Positioned rather than `sr-only`: an `sr-only` link cannot become visible when focused, and a skip
 * link that a sighted keyboard user cannot see is a link they cannot tell they have landed on.
 */
export function SkipToContent() {
    return (
        <a
            href={`#${MAIN_CONTENT_ID}`}
            data-slot="skip-to-content"
            className="bg-surface-modal text-ink-gray-8 outline-outline-gray-5 shadow-lg sr-only z-50 rounded px-4 py-2 text-p-base focus-visible:not-sr-only focus-visible:fixed focus-visible:start-4 focus-visible:top-4 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
            {_("Skip to main content")}
        </a>
    )
}

/**
 * The `main` landmark, plus the document's single top-level heading.
 *
 * Both were missing outright: there was no landmark of any kind, so assistive technology offered no
 * way to jump to the content and no way to describe where in the page the user was, and there was no
 * `h1`, so the heading outline began at `h4` inside a modal body.
 *
 * The heading is visually hidden rather than rendered, deliberately. The visible page title is the
 * breadcrumb's trailing crumb, which is the design's own answer and is not this component's to
 * change; a second visible title would contradict it. Hiding it keeps the accessible outline correct
 * without altering a pixel - and unlike the skip link it never needs to become visible, because it is
 * not interactive.
 */
export function MainContent({
    title,
    className,
    children,
}: {
    /** The page's name, already translated by the caller. */
    title: string
    /**
     * Layout classes for the landmark itself.
     *
     * The landmark has to be a real box in the page's layout, not a transparent wrapper: once the site
     * header sits OUTSIDE it - which is what gives the header its `banner` role and gives the skip link
     * something to skip - the landmark becomes a flex child of the page container and has to carry the
     * sizing its content needs.
     */
    className?: string
    children: React.ReactNode
}) {
    return (
        <main
            id={MAIN_CONTENT_ID}
            data-slot="main-content"
            tabIndex={-1}
            className={cn("min-w-0", className)}
        >
            <H1 className="sr-only">{title}</H1>
            {children}
        </main>
    )
}
