import React from 'react'
import rehypeRaw from 'rehype-raw'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, ElementContent, Properties, Root } from 'hast'
// import './markdown.css'

/**
 * Elements this renderer is allowed to emit. Everything remark-gfm produces for ordinary
 * markdown is here (paragraphs, headings, lists, tables, code, emphasis, links, task-list
 * checkboxes, footnote sections), plus the handful of inline tags the app's own translated
 * strings use through `rehypeRaw` - `<strong>` and `<br>`.
 *
 * `img` is deliberately NOT here, and is dropped below instead. Every caller of this renderer
 * passes either a translated sentence whose only markup is an interpolated `<strong>`, or text
 * the server produced (a parsed `_server_messages` entry, or a link-search result
 * description) - never documentation. No caller authors a markdown image, and `src/` contains
 * no `![...](...)` syntax at all, so permitting `img` would buy nothing while letting text
 * this renderer does not control trigger an outbound request to a host of its choosing and
 * paint a broken-image glyph inside an error dialog. Excluding it costs no existing behaviour.
 */
const ALLOWED_ELEMENTS = new Set([
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'input', 'li', 'ol', 'p', 'pre', 's', 'section', 'small', 'span', 'strong',
    'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'
])

/**
 * Disallowed elements whose CHILDREN are discarded along with them, because their content is
 * script, styling or embedded-document data rather than text a reader should see - or, for
 * the media elements, because the element IS the payload and has no text to preserve. Every
 * other disallowed element is unwrapped instead, so no legitimate text is ever lost.
 */
const DROPPED_SUBTREES = new Set([
    'applet', 'area', 'audio', 'base', 'button', 'canvas', 'dialog', 'embed', 'form', 'frame',
    'frameset', 'iframe', 'img', 'link', 'map', 'marquee', 'math', 'meta', 'noscript', 'object',
    'option', 'portal', 'script', 'select', 'slot', 'source', 'style', 'svg', 'template',
    'textarea', 'track', 'video'
])

/** Attributes permitted on any allowed element. Note the absence of `style` and of every `on*`. */
const ALLOWED_GLOBAL_ATTRIBUTES = new Set(['align', 'className', 'dir', 'id', 'lang', 'title'])

/** Additional attributes permitted only on specific elements. */
const ALLOWED_ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
    a: new Set(['href', 'target', 'rel']),
    input: new Set(['checked', 'disabled', 'type']),
    ol: new Set(['start']),
    td: new Set(['colSpan', 'rowSpan']),
    th: new Set(['colSpan', 'rowSpan', 'scope'])
}

/** Attributes carrying a URL, which is additionally restricted to a safe scheme. */
const URL_ATTRIBUTES = new Set(['href', 'src'])

/** Any leading `scheme:`, matched only once whitespace and control characters are gone. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** The only schemes allowed to appear. Everything else - `javascript:`, `data:`, `vbscript:` - goes. */
const SAFE_URL_SCHEME = /^(?:https?|mailto|tel):/i

/**
 * A URL is safe when it either carries no scheme at all (an in-page anchor or a relative path) or
 * carries one of the safe schemes. Whitespace and control characters are removed first, because
 * browsers ignore them inside a scheme and `java\nscript:` would otherwise slip through.
 */
const isSafeUrl = (value: Properties[string]): boolean => {
    if (typeof value !== 'string') return false
    // eslint-disable-next-line no-control-regex
    const normalized = value.replace(/[\u0000-\u0020]/g, '')
    return !URL_SCHEME.test(normalized) || SAFE_URL_SCHEME.test(normalized)
}

/** Rebuilds an element's properties from the allow-lists above, dropping everything else. */
const sanitizeProperties = (element: Element): Properties => {
    const allowedForElement = ALLOWED_ELEMENT_ATTRIBUTES[element.tagName]
    const safeProperties: Properties = {}

    for (const [name, value] of Object.entries(element.properties ?? {})) {
        if (!ALLOWED_GLOBAL_ATTRIBUTES.has(name) && !allowedForElement?.has(name)) continue
        if (URL_ATTRIBUTES.has(name) && !isSafeUrl(value)) continue
        safeProperties[name] = value
    }

    // A link that opens a new context must not hand it a reference back to this window.
    if (safeProperties.target !== undefined) {
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
 * `ErrorBanner` renders through this component - cannot become active DOM. Scripts, styles,
 * frames, embedded objects, form controls, event-handler attributes and unsafe URL schemes are
 * all removed here; ordinary markdown and the inline emphasis the app's own strings rely on are
 * untouched. Sanitising at this boundary rather than at the data source is deliberate: the error
 * envelope stays exactly as the server sent it, and every caller of this renderer is protected.
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