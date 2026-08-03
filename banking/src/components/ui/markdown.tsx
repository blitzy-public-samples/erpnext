import React from 'react'
import rehypeRaw from 'rehype-raw'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, ElementContent, Properties, Root } from 'hast'
// import './markdown.css'

/**
 * Elements this renderer is allowed to emit. Everything remark-gfm produces for ordinary
 * markdown is here (paragraphs, headings, lists, tables, code, emphasis, links, footnote
 * sections), plus the handful of inline tags the app's own translated strings use through
 * `rehypeRaw` - `<strong>` and `<br>`.
 *
 * `img` is deliberately NOT here, and is dropped below instead. Every caller of this renderer
 * passes either a translated sentence whose only markup is an interpolated `<strong>`, or text
 * the server produced (a parsed `_server_messages` entry, or a link-search result
 * description) - never documentation. No caller authors a markdown image, and `src/` contains
 * no `![...](...)` syntax at all, so permitting `img` would buy nothing while letting text
 * this renderer does not control trigger an outbound request to a host of its choosing and
 * paint a broken-image glyph inside an error dialog. Excluding it costs no existing behaviour.
 *
 * `input` is NOT here either, and is likewise dropped - see DROPPED_SUBTREES.
 */
const ALLOWED_ELEMENTS = new Set([
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'section', 'small', 'span', 'strong',
    'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'
])

/**
 * Disallowed elements whose CHILDREN are discarded along with them, because their content is
 * script, styling or embedded-document data rather than text a reader should see - or, for
 * the media and form-control elements, because the element IS the payload and has no text to
 * preserve. Every other disallowed element is unwrapped instead, so no legitimate text is
 * ever lost.
 *
 * `input` is here rather than in ALLOWED_ELEMENTS because a form control rendered from text
 * this renderer does not control is a credential-harvesting surface: the only markup that
 * legitimately produces one is a remark-gfm task-list checkbox, and no caller renders a task
 * list (every caller passes a single short sentence). Dropping it therefore removes the
 * "type a value here" primitive outright, which is strictly safer than emitting it and
 * relying on a forced `disabled`.
 */
const DROPPED_SUBTREES = new Set([
    'applet', 'area', 'audio', 'base', 'button', 'canvas', 'dialog', 'embed', 'form', 'frame',
    'frameset', 'iframe', 'img', 'input', 'link', 'map', 'marquee', 'math', 'meta', 'noscript',
    'object', 'option', 'portal', 'script', 'select', 'slot', 'source', 'style', 'svg',
    'template', 'textarea', 'track', 'video'
])

/**
 * Attributes permitted on any allowed element. Note the absence of `style`, of every `on*`,
 * and - deliberately - of `className` and `id`.
 *
 * `className` and `id` are excluded because of CWE-451 (UI redress / clickjacking), not for
 * tidiness. Tailwind compiles the utilities this application uses into the shipped
 * stylesheet, so a single server-controlled `class` attribute is enough to paint a
 * full-viewport opaque overlay (`fixed inset-0 z-50 bg-surface-white`) on top of the very
 * dialog reporting the failure, and to position arbitrary text wherever the author likes.
 * `id` is excluded alongside it because a duplicated `id` silently steals the target of an
 * existing `aria-describedby`/`aria-labelledby`/`<label for>` and can therefore rewrite what
 * assistive technology announces for a real control.
 *
 * Excluding both costs no existing behaviour: every caller of this renderer passes a short
 * sentence whose only markup is an interpolated `<strong>` or `<br>`, or text the server
 * produced. Nothing in `src/` renders markdown documentation, so the only classes ever lost
 * are the ones remark-gfm generates for footnote sections, which no caller emits.
 */
const ALLOWED_GLOBAL_ATTRIBUTES = new Set(['align', 'dir', 'lang', 'title'])

/** Additional attributes permitted only on specific elements. */
const ALLOWED_ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
    a: new Set(['href']),
    ol: new Set(['start']),
    td: new Set(['colSpan', 'rowSpan']),
    th: new Set(['colSpan', 'rowSpan', 'scope'])
}

/** Attributes carrying a URL, which is additionally restricted below. */
const URL_ATTRIBUTES = new Set(['href', 'src'])

/** Any leading `scheme:`, matched only once whitespace and control characters are gone. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * A URL is renderable only when it points back at this application: an in-page fragment, a
 * root-relative path such as Frappe's own `/app/bank-transaction/…` document links, or a
 * plain relative path. Anything else - an absolute `https://` URL, a scheme-relative
 * `//host/path`, the backslash spellings of that same network path (`\\host/path`,
 * `/\host/path`, `\/host/path`), and every dangerous scheme (`javascript:`, `data:`,
 * `vbscript:`) - is refused, so a server-controlled message cannot present an off-site
 * destination as though the application were offering it.
 *
 * Whitespace and control characters are stripped first, because browsers ignore them inside a
 * scheme and `java\nscript:` would otherwise slip through.
 *
 * The surviving value is then CANONICALISED with the platform URL parser and its resolved origin
 * required to equal this document's own, so the predicate asks the same question the browser will
 * answer when the link is clicked rather than a lookalike of it. Comparing characters alone is not
 * enough: WHATWG URL parsing - what every browser and jsdom implement - folds `\` into `/` inside
 * an http(s) URL, so `\\host/path`, `/\host/path` and `\/host/path` are all network-path
 * references that resolve to an entirely different origin while carrying neither a scheme nor a
 * leading `//` for a syntactic test to catch. A reference the parser cannot resolve at all
 * (`////`, a network path with an empty host, throws) is refused for the same reason, and refused
 * HERE rather than allowed to throw out of the sanitiser and take down the very error dialog that
 * is reporting a failure.
 *
 * Three syntactic refusals are kept ON TOP of that origin check, because each is STRICTER than it
 * and each still earns its place:
 *
 * - a backslash, because the parser folds it into `/`: the destination the reader sees written out
 *   and the one the browser navigates to would disagree, which is the whole trick above;
 * - the scheme-relative `//host/path` form, which origin equality would admit whenever the host
 *   happens to be ours, yet reads as an off-site link either way;
 * - any explicit scheme, which is what keeps `javascript:`, `data:` and `vbscript:` out even in a
 *   document whose own origin is opaque - there `window.location.origin` is the string `"null"`
 *   and so is the origin of a `javascript:` URL, so the comparison alone would pass them.
 *
 * `%5C` is a literal path character to the parser, not a separator, so a percent-encoded
 * backslash inside a legitimate document name is untouched by any of this.
 */
const isSameOriginUrl = (value: Properties[string]): boolean => {
    if (typeof value !== 'string') return false
    // eslint-disable-next-line no-control-regex
    const normalized = value.replace(/[\u0000-\u0020]/g, '')
    if (normalized.length === 0) return false

    try {
        const { origin } = new URL(normalized, window.location.href)
        if (origin !== window.location.origin) return false
    } catch {
        // Unparseable, so it cannot be shown to point back at this application.
        return false
    }

    if (normalized.includes('\\')) return false
    if (normalized.startsWith('//')) return false
    return !URL_SCHEME.test(normalized)
}

/**
 * Rebuilds an element's properties from the allow-lists above, dropping everything else.
 *
 * Returning an empty object rather than the original is what makes this an allow-list: any
 * attribute nobody named above - `style`, every `on*` handler, `srcset`, `formaction`,
 * `class`, `id` - simply never reaches the rendered element.
 */
const sanitizeProperties = (element: Element): Properties => {
    const allowedForElement = ALLOWED_ELEMENT_ATTRIBUTES[element.tagName]
    const safeProperties: Properties = {}

    for (const [name, value] of Object.entries(element.properties ?? {})) {
        if (!ALLOWED_GLOBAL_ATTRIBUTES.has(name) && !allowedForElement?.has(name)) continue
        if (URL_ATTRIBUTES.has(name) && !isSameOriginUrl(value)) continue
        safeProperties[name] = value
    }

    // A surviving link is same-origin by construction, and `target` is not on its allow-list,
    // so it always opens in this tab. `rel` is stamped anyway: it costs nothing and keeps the
    // guarantee local to this function rather than resting on the allow-list above.
    if (element.tagName === 'a' && safeProperties.href !== undefined) {
        safeProperties.rel = 'noreferrer noopener'
    }

    return safeProperties
}

const sanitizeChildren = (children: ElementContent[]): ElementContent[] => {
    const safeChildren: ElementContent[] = []

    for (const child of children) {
        // Comments carry nothing renderable, so they are simply discarded.
        if (child.type === 'comment') continue

        if (child.type !== 'element') {
            safeChildren.push(child)
            continue
        }

        if (DROPPED_SUBTREES.has(child.tagName)) continue

        child.children = sanitizeChildren(child.children)

        if (ALLOWED_ELEMENTS.has(child.tagName)) {
            child.properties = sanitizeProperties(child)

            // An anchor whose destination did not survive `isSameOriginUrl` is unwrapped rather
            // than emitted href-less. Keeping the text is the point - the reader still sees
            // exactly what the server wrote, including the URL if it was written out - while no
            // anchor element remains to look like something the application is offering to
            // navigate to.
            if (child.tagName === 'a' && child.properties.href === undefined) {
                safeChildren.push(...child.children)
                continue
            }

            safeChildren.push(child)
        } else {
            // Unknown but harmless tag: keep the text, drop the wrapper.
            safeChildren.push(...child.children)
        }
    }

    return safeChildren
}

/**
 * Restrictive sanitiser applied AFTER `rehypeRaw` has parsed raw HTML into real nodes, so that
 * markup arriving inside untrusted content - most importantly Frappe's `_server_messages`, which
 * `ErrorBanner` renders through this component - cannot become active DOM.
 *
 * Removed here: scripts, styles, frames, embedded objects, media, form controls, every
 * event-handler attribute, `style`, and - because they are UI-redress primitives in a codebase
 * whose utility classes are already compiled into the shipped stylesheet - `class` and `id`.
 * Links survive only when they point back at this application. Ordinary markdown and the
 * inline emphasis the app's own strings rely on are untouched.
 *
 * Sanitising at this boundary rather than at the data source is deliberate: the error envelope
 * stays exactly as the server sent it, so what the user READS is never paraphrased, while
 * every caller of this renderer - the ~20 inline `ErrorBanner` sites, the dismissible
 * reconciliation error dialog, and the link-search result descriptions - is protected by one
 * shared allow-list instead of ~20 separate decisions.
 */
const rehypeSanitizeMarkup = () => (tree: Root) => {
    tree.children = sanitizeChildren(
        tree.children.filter((child): child is ElementContent => child.type !== 'doctype')
    )
}

interface MarkdownRendererProps {
    content: string,
    className?: string
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
    return <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitizeMarkup]}
    // components={{
    //     p: (props) => <Text {...props} as='p' />,
    //     ul: (props) => <UnorderedList {...props} />,
    //     ol: (props) => <OrderedList {...props} />,
    //     li: (props) => <ListItem {...props} />,
    //     a: (props) => <Link {...props} />,
    // }}>
    >
        {content}
    </ReactMarkdown>
}

export default MarkdownRenderer