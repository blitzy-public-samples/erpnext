import type { Element, Nodes, Parents, RootContent } from 'hast'

/* ================================================================================================
 * THE SHARED SERVER-MARKUP SANITISER (CWE-79 / CWE-451)
 *
 * `ui/markdown.tsx` runs `rehypeRaw`, which turns the raw HTML embedded in server text into real
 * elements, and `react-markdown` then renders those elements through `document.createElement`. Nodes
 * created that way are NOT inert: a `<script>` executes, an `<img src>` fetches, an `on*` attribute
 * fires, and a single `class` attribute is enough to paint an opaque full-viewport overlay because
 * this application's Tailwind utilities are already compiled into the shipped stylesheet.
 *
 * Everything that reaches `ErrorBanner` is server text - `_server_messages` is HTML by convention, and
 * a party name or a document field interpolated into a validation string is attacker-influenceable -
 * and the report bodies rendered by the reconciliation summaries are server text as well. So this is
 * ONE sanitiser, installed at the ONE sink, and every `Markdown`/`ErrorBanner` consumer in the SPA is
 * behind it. Placing it here rather than at each consumer is the point: a per-consumer guard protects
 * only the consumers someone remembered.
 *
 * It runs as a rehype plugin AFTER `rehypeRaw`, so it sees the parsed tree rather than a string, and
 * it filters by ALLOW-LIST: an element or attribute survives only by being named below. TEXT is never
 * touched - nothing is paraphrased, summarised or truncated - so the server's own wording still
 * reaches the reader verbatim.
 *
 * It also closes the two holes an HTML-only filter cannot see, because markdown is parsed by remark
 * BEFORE this runs: `![x](http://elsewhere/x.png)` becomes an `<img>` with an off-origin `src`, and a
 * GFM autolink literal becomes an anchor. Both arrive here as ordinary elements and are handled by the
 * same two rules as their HTML equivalents.
 * ============================================================================================== */

/**
 * Elements this renderer may emit. Covers everything Frappe's own message helpers produce -
 * `frappe.bold()` emits `<b>`, `get_link_to_form()` emits `<a>`, multi-line throws use `<br>`, and
 * validation summaries and the reconciliation reports use lists and tables.
 *
 * `img` is deliberately absent: no Frappe message legitimately carries one, while permitting it would
 * let server-controlled text trigger an outbound request to a host of its choosing - and a
 * same-origin one could be a state-changing GET - the moment the message is rendered.
 */
const ALLOWED_ELEMENTS = new Set([
	'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'section', 'small', 'span', 'strong',
	'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'
])

/**
 * Disallowed elements whose CHILDREN go with them, because the content is script, styling or
 * embedded-document data rather than text a reader should see - or, for media and form controls,
 * because the element IS the payload and has no text to preserve.
 *
 * Every OTHER disallowed element is UNWRAPPED instead, so no legitimate text is ever lost.
 */
const DROPPED_SUBTREES = new Set([
	'applet', 'area', 'audio', 'base', 'button', 'canvas', 'dialog', 'embed', 'form', 'frame',
	'frameset', 'iframe', 'img', 'input', 'link', 'map', 'marquee', 'math', 'meta', 'noscript',
	'object', 'option', 'portal', 'script', 'select', 'slot', 'source', 'style', 'svg',
	'template', 'textarea', 'title', 'track', 'video'
])

/**
 * Attributes permitted on any allowed element. Note the absence of `style`, of every `on*` handler,
 * and - deliberately - of `class` and `id`.
 *
 * `class` and `id` are excluded for CWE-451 (UI redress), not tidiness: this application's Tailwind
 * utilities are compiled into the shipped stylesheet, so one server-controlled `class` is enough to
 * position arbitrary text anywhere or cover a dialog entirely, and a duplicated `id` silently steals
 * the target of an existing `aria-describedby` / `aria-labelledby` and rewrites what assistive
 * technology announces for a real control.
 */
const ALLOWED_GLOBAL_ATTRIBUTES = new Set(['align', 'dir', 'lang', 'title'])

/** Additional attributes permitted only on specific elements, by lower-cased attribute name. */
const ALLOWED_ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
	a: new Set(['href']),
	ol: new Set(['start']),
	td: new Set(['colspan', 'rowspan']),
	th: new Set(['colspan', 'rowspan', 'scope'])
}

/** Attributes carrying a URL, which is additionally restricted by {@link isSameOriginUrl}. */
const URL_ATTRIBUTES = new Set(['href', 'src'])

/** Any leading `scheme:`, matched only once whitespace and control characters are gone. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * hast names properties rather than attributes, so `class` arrives as `className`, `colspan` as
 * `colSpan` and `onclick` as `onClick`. Lower-casing is what lets one allow-list of attribute names
 * decide both spellings, and it is why an unknown-but-hostile property cannot slip through on a
 * casing difference.
 */
const attributeName = (property: string): string => property.toLowerCase()

/**
 * A URL survives only when it points back at this application: an in-page fragment, a root-relative
 * path such as Frappe's own `/app/bank-transaction/…` document links, or a plain relative path.
 *
 * Whitespace and control characters are stripped FIRST, because browsers ignore them inside a scheme
 * and `java\nscript:` would otherwise slip past the scheme test.
 *
 * The survivor is then CANONICALISED with the platform URL parser and its resolved origin required to
 * equal this document's, so the predicate asks the same question the browser answers when the link is
 * clicked. Character comparison alone is not enough: WHATWG parsing folds `\` into `/` inside an
 * http(s) URL, so `\\host/path`, `/\host/path` and `\/host/path` are network-path references resolving
 * to another origin while carrying neither a scheme nor a leading `//`. A reference the parser cannot
 * resolve at all is refused HERE rather than allowed to throw out of the sanitiser and take down the
 * message that is reporting a failure.
 *
 * Three syntactic refusals are kept ON TOP of the origin check because each is STRICTER than it: a
 * backslash, because the destination the reader sees and the one the browser computes disagree; the
 * scheme-relative `//host/path` form, which reads as off-site whoever it names; and any explicit
 * scheme, which is what keeps `javascript:` and `data:` out even in a document whose own origin is
 * opaque - there `location.origin` is the string `"null"` and so is a `javascript:` URL's origin.
 */
export const isSameOriginUrl = (value: string): boolean => {
	// eslint-disable-next-line no-control-regex
	const normalized = value.replace(/[\u0000-\u0020]/g, '')
	if (normalized.length === 0) return false

	try {
		if (new URL(normalized, window.location.href).origin !== window.location.origin) return false
	} catch {
		// Unparseable, so it cannot be shown to point back at this application.
		return false
	}

	if (normalized.includes('\\')) return false
	if (normalized.startsWith('//')) return false
	return !URL_SCHEME.test(normalized)
}

/**
 * Rebuilds one element's properties from the allow-lists above. Deleting rather than filtering into a
 * copy is what makes this an allow-list: `style`, every `on*`, `srcset`, `formaction`, `class` and
 * `id` are simply never named, so they never survive.
 */
const sanitizeProperties = (element: Element): void => {
	const allowedForElement = ALLOWED_ELEMENT_ATTRIBUTES[element.tagName]
	const properties = element.properties ?? {}

	for (const property of Object.keys(properties)) {
		const name = attributeName(property)

		if (!ALLOWED_GLOBAL_ATTRIBUTES.has(name) && !allowedForElement?.has(name)) {
			delete properties[property]
			continue
		}

		if (URL_ATTRIBUTES.has(name) && !isSameOriginUrl(String(properties[property] ?? ''))) {
			delete properties[property]
		}
	}

	// A surviving link is same-origin by construction and `target` is not on its allow-list, so it
	// always opens in this tab. `rel` is stamped anyway: it costs nothing and keeps the guarantee local
	// to this function rather than resting on the allow-list above.
	if (element.tagName === 'a' && properties.href !== undefined) {
		properties.rel = 'noreferrer noopener'
	}

	element.properties = properties
}

/**
 * Depth-first sanitisation of one parent's children, in place.
 *
 * Children are rebuilt into a new array rather than spliced, because an unwrapped element contributes
 * several nodes where there was one and a dropped element contributes none - and mutating a list while
 * indexing it is how a sanitiser ends up skipping the node after a removal.
 */
const sanitizeChildren = (parent: Parents): void => {
	const kept: RootContent[] = []

	for (const child of parent.children) {
		if (child.type === 'text') {
			kept.push(child)
			continue
		}

		if (child.type !== 'element') {
			// Comments, doctypes and any `raw` node `rehypeRaw` did not consume carry nothing
			// renderable, and a surviving `raw` node would be re-serialised unparsed.
			continue
		}

		if (DROPPED_SUBTREES.has(child.tagName)) {
			continue
		}

		sanitizeChildren(child)

		if (!ALLOWED_ELEMENTS.has(child.tagName)) {
			// Unknown but harmless tag: keep the text, drop the wrapper.
			kept.push(...child.children)
			continue
		}

		sanitizeProperties(child)

		// An anchor whose destination did not survive `isSameOriginUrl` is unwrapped rather than
		// emitted href-less. The reader still sees exactly what the server wrote, including the URL if
		// it was written out, while no anchor remains to look like something this application is
		// offering to navigate to.
		if (child.tagName === 'a' && child.properties?.href === undefined) {
			kept.push(...child.children)
			continue
		}

		kept.push(child)
	}

	parent.children = kept
}

/**
 * The rehype plugin. Install it AFTER `rehypeRaw` so it sees the raw HTML as parsed elements:
 *
 * ```tsx
 * <ReactMarkdown rehypePlugins={[rehypeRaw, rehypeSanitizeServerMarkup]}>{content}</ReactMarkdown>
 * ```
 *
 * Ordering it before `rehypeRaw` would leave the hostile markup sitting in `raw` nodes that had not
 * been parsed yet, and the walk would find nothing to remove.
 */
const rehypeSanitizeServerMarkup = () => (tree: Nodes): void => {
	if (tree.type === 'root' || tree.type === 'element') {
		sanitizeChildren(tree)
	}
}

export default rehypeSanitizeServerMarkup
