import { cn } from "@/lib/utils"
import { ReactNode } from "react"

/**
 * The centred "you need to choose something first" message shown in place of a panel's content.
 *
 * The wrapper is a `div` carrying the paragraph type token rather than the `Paragraph` primitive, and
 * that is a correctness fix rather than a stylistic one. `text` is a `ReactNode`, so a caller may pass
 * arbitrary elements - and one does: the Record Payment invoice panel passes a `MarkdownRenderer`,
 * which emits its own `<p>`. Nesting that inside `Paragraph`'s `<p>` is invalid HTML, so React logged a
 * `validateDOMNesting` error and the browser's own parser recovery closed the outer paragraph early,
 * leaving the message outside the box that was meant to centre it. A component whose content type is
 * `ReactNode` cannot assume phrasing content, so it must not render an element that only accepts it.
 *
 * The five callers that pass a plain string are unaffected: the token that set their appearance is
 * still applied here, so they render identically.
 */
export const MissingFiltersBanner = ({ text, className }: { text: ReactNode, className?: string }) => {
    return <div className={cn("min-h-[50vh] flex items-center justify-center", className)}>
        <div className="text-p-base">{text}</div>
    </div>
}
