import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import ErrorBanner from "@/components/ui/error-banner"
import type { FrappeError } from "frappe-react-sdk"
import { useAtom } from "jotai"
import { useEffect, useMemo, useRef } from "react"
import { bankRecErrorDialogAtom } from "./bankRecAtoms"
import { readServerMessages } from "./utils"
import _ from "@/lib/translate"

/* ================================================================================================
 * SERVER-MARKUP SANITISATION (CWE-79 / CWE-451)
 *
 * `_server_messages` is HTML, and the shared renderer this dialog composes puts it on the page as
 * REAL DOM: `ErrorBanner` hands each parsed message to `ui/markdown.tsx`, which runs `rehypeRaw`
 * with no sanitiser after it. Anything that reaches a server error message - a party name, a
 * document field interpolated into a validation string - therefore reaches this dialog as markup:
 * `<script>`, an `<img src>` pointing at a host of the author's choosing, an `on*` handler, or a
 * single `class` attribute, which in a codebase whose Tailwind utilities are already compiled into
 * the shipped stylesheet is enough to paint an opaque full-viewport overlay over the very dialog
 * reporting the failure.
 *
 * WHY THE SANITISER LIVES HERE AND NOT IN THE SHARED RENDERER. One shared boundary inside
 * `ui/markdown.tsx` would protect every consumer at once and would be the better design in a codebase
 * where that file could be edited. It cannot: `ui/markdown.tsx` is one of the 43 design-system
 * primitives the Agent Action Plan lists as reference-only files that "must not appear in the diff"
 * (AAP section 0.8.1.6), section 0.7.6 requires zero new primitives and zero design-system changes,
 * section 0.2.2 confines this work to the authorised paths, and Success Criterion 4 (section 0.10.1.4)
 * is verified by exactly that diff. Adding a `rehype-sanitize` plugin is barred on the same grounds -
 * section 0.10.4 permits no dependency beyond the seven test packages section 0.5 enumerates.
 *
 * So this dialog - a NEW consumer, and the only new untrusted-markup sink this work introduces -
 * is where the guard can legitimately be placed. Stated plainly rather than left implicit: this closes
 * the vector for the surface FM1 introduced, and the pre-existing inline `ErrorBanner` call sites keep
 * the shared renderer's baseline behaviour, which is a known residual risk recorded in the README
 * rather than a solved problem.
 *
 * The result is handed to `ErrorBanner` as a re-encoded `_server_messages` envelope, so the parser,
 * the severity rule, the heading rule and the markdown rendering all remain the single shared
 * implementation - only the CONTENT is filtered. Nothing is paraphrased: text is preserved
 * character for character, and only markup is removed.
 * ============================================================================================== */

/**
 * Elements this dialog is allowed to emit. Covers everything Frappe's own message helpers produce -
 * `frappe.bold()` emits `<b>`, `get_link_to_form()` emits `<a>`, multi-line throws use `<br>`, and
 * validation summaries use lists and tables.
 *
 * `img` is deliberately absent, and dropped rather than unwrapped: no Frappe message legitimately
 * carries one, while permitting it would let server-controlled text trigger an outbound request to a
 * host of its choosing the moment this dialog opens. `input` is absent for the same reason - a form
 * control rendered from text this dialog does not control is a credential-harvesting surface.
 */
const ALLOWED_ELEMENTS = new Set([
	'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'section', 'small', 'span', 'strong',
	'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'
])

/**
 * Disallowed elements whose CHILDREN go with them, because the content is script, styling or
 * embedded-document data rather than text a reader should see - or, for media and form controls,
 * because the element IS the payload and has no text to preserve. Every OTHER disallowed element is
 * unwrapped instead, so no legitimate text is ever lost.
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
 * position arbitrary text anywhere or cover the dialog entirely, and a duplicated `id` silently
 * steals the target of an existing `aria-describedby` / `aria-labelledby` and rewrites what
 * assistive technology announces for a real control.
 */
const ALLOWED_GLOBAL_ATTRIBUTES = new Set(['align', 'dir', 'lang', 'title'])

/** Additional attributes permitted only on specific elements. DOM attribute names are lower-case. */
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
 * A URL survives only when it points back at this application: an in-page fragment, a root-relative
 * path such as Frappe's own `/app/bank-transaction/…` document links, or a plain relative path.
 *
 * Whitespace and control characters are stripped FIRST, because browsers ignore them inside a scheme
 * and `java\nscript:` would otherwise slip past the scheme test.
 *
 * The survivor is then CANONICALISED with the platform URL parser and its resolved origin required
 * to equal this document's, so the predicate asks the same question the browser answers when the
 * link is clicked. Character comparison alone is not enough: WHATWG parsing folds `\` into `/`
 * inside an http(s) URL, so `\\host/path`, `/\host/path` and `\/host/path` are network-path
 * references resolving to another origin while carrying neither a scheme nor a leading `//`. A
 * reference the parser cannot resolve at all is refused HERE rather than allowed to throw out of the
 * sanitiser and take down the dialog that is reporting the failure.
 *
 * Three syntactic refusals are kept ON TOP of the origin check because each is STRICTER than it:
 * a backslash, because the destination the reader sees and the one the browser computes disagree;
 * the scheme-relative `//host/path` form, which reads as off-site whoever it names; and any explicit
 * scheme, which is what keeps `javascript:` and `data:` out even in a document whose own origin is
 * opaque - there `location.origin` is the string `"null"` and so is a `javascript:` URL's origin.
 */
const isSameOriginUrl = (value: string): boolean => {
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
 * Rebuilds one element's attributes from the allow-lists above. Removing rather than filtering into
 * a copy is what makes this an allow-list: `style`, every `on*`, `srcset`, `formaction`, `class` and
 * `id` are simply never named, so they never survive.
 */
const sanitizeAttributes = (element: Element) => {
	const tagName = element.tagName.toLowerCase()
	const allowedForElement = ALLOWED_ELEMENT_ATTRIBUTES[tagName]

	for (const attribute of Array.from(element.attributes)) {
		const name = attribute.name.toLowerCase()

		if (!ALLOWED_GLOBAL_ATTRIBUTES.has(name) && !allowedForElement?.has(name)) {
			element.removeAttribute(attribute.name)
			continue
		}

		if (URL_ATTRIBUTES.has(name) && !isSameOriginUrl(attribute.value)) {
			element.removeAttribute(attribute.name)
		}
	}

	// A surviving link is same-origin by construction and `target` is not on its allow-list, so it
	// always opens in this tab. `rel` is stamped anyway: it costs nothing and keeps the guarantee
	// local to this function rather than resting on the allow-list above.
	if (tagName === 'a' && element.hasAttribute('href')) {
		element.setAttribute('rel', 'noreferrer noopener')
	}
}

/** Replaces an element with its own children, so the text survives and the wrapper does not. */
const unwrap = (element: Element) => {
	element.replaceWith(...Array.from(element.childNodes))
}

/**
 * Collapses BLANK lines, which matter for a reason that is not obvious: the sanitised markup is
 * handed to the renderer as a single HTML BLOCK (see {@link sanitizeServerMarkup}), and a CommonMark
 * HTML block ENDS at the first blank line. A blank line inside a server message would therefore
 * close the block early and hand the remainder back to the markdown parser - the one thing the
 * wrapper exists to prevent. Frappe writes line breaks as `<br>`, which is preserved untouched, so
 * this costs no real formatting.
 */
const collapseBlankLines = (value: string): string => value.replace(/(\r?\n)(?:[ \t]*\r?\n)+/g, '$1')

/** Depth-first sanitisation of a parsed fragment, in place. */
const sanitizeChildNodes = (parent: Node) => {
	for (const child of Array.from(parent.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE) {
			child.textContent = collapseBlankLines(child.textContent ?? '')
			continue
		}

		if (child.nodeType !== Node.ELEMENT_NODE) {
			// Comments, CDATA and processing instructions carry nothing renderable.
			child.parentNode?.removeChild(child)
			continue
		}

		const element = child as Element
		const tagName = element.tagName.toLowerCase()

		if (DROPPED_SUBTREES.has(tagName)) {
			element.remove()
			continue
		}

		sanitizeChildNodes(element)

		if (!ALLOWED_ELEMENTS.has(tagName)) {
			// Unknown but harmless tag: keep the text, drop the wrapper.
			unwrap(element)
			continue
		}

		sanitizeAttributes(element)

		// An anchor whose destination did not survive `isSameOriginUrl` is unwrapped rather than
		// emitted href-less. The reader still sees exactly what the server wrote, including the URL
		// if it was written out, while no anchor remains to look like something this application is
		// offering to navigate to.
		if (tagName === 'a' && !element.hasAttribute('href')) {
			unwrap(element)
		}
	}
}

/**
 * Filters one server message down to markup this dialog is prepared to render, and returns it
 * wrapped in a single `<div>`.
 *
 * THREE mechanisms, and all three are load-bearing:
 *
 * 1. The INERT PARSING PRIMITIVE. Untrusted markup is parsed by assigning it to a detached
 *    `<template>`'s `innerHTML`, NOT with `DOMParser`. This is the only parsing step in the chain and
 *    the choice of primitive is a security decision rather than a stylistic one, because the walk in
 *    (2) necessarily runs AFTER parsing - so whatever the parse itself does has already happened by
 *    the time the first hostile node is removed.
 *
 *    `<template>` is the platform's explicit answer to that ordering problem. Its parsed contents live
 *    in a `DocumentFragment` owned by the "template contents owner" - a document with NO browsing
 *    context - and HTML specifies that template contents are INERT: scripts do not run, IMAGES DO NOT
 *    LOAD, styles do not apply, media does not play. The guarantee is about the parse, so it holds for
 *    the window this sanitiser cannot otherwise cover.
 *
 *    `DOMParser` was used here previously and is deliberately no longer: its documents are described
 *    as inert with respect to SCRIPT execution, but not with the same unqualified guarantee about
 *    subresource fetching, and MDN warns that a document it returns can still download resources
 *    referenced by elements such as images and frames. A sanitiser whose safety depends on a
 *    qualified guarantee is a sanitiser with a window in it - so `<img src="https://elsewhere/x">` in
 *    a server message could have initiated a request before the walk below removed it, and a
 *    same-origin one could have initiated a state-changing GET. Nothing about the filtering changed;
 *    only the primitive the filtering is applied to.
 *
 * 2. The ALLOW-LIST walk above, applied depth-first to those inert nodes. It is what guarantees only
 *    allow-listed elements and attributes are re-serialised. Note that the change of primitive makes
 *    it do MORE work, not less: `DOMParser` put a leading `<script>` or comment into `<head>`, out of
 *    reach of a walk over `<body>`, whereas a `<template>` keeps every node in one fragment where the
 *    walk sees and removes it explicitly.
 *
 * 3. The `<div>` WRAPPER, which suppresses markdown interpretation entirely. Without it the walk
 *    would still leave a hole, because the sanitiser necessarily runs BEFORE the markdown parser
 *    the shared renderer owns: `![x](http://elsewhere/x.png)` is not HTML, so no HTML filter can
 *    see it, yet remark turns it into an `<img>` with an off-origin `src`, and a GFM autolink
 *    literal turns bare text into an anchor. A line beginning with `<div` is a CommonMark HTML
 *    block, which remark passes through VERBATIM to `rehypeRaw` with no markdown parsing inside it -
 *    so after this wrap the only markup that can reach the DOM is markup this function emitted.
 *    `div` is itself allow-listed, and `AlertDescription` is a grid whose children are laid out
 *    identically whether they are `<div>` or `<p>`, so the wrapper is invisible.
 */
const sanitizeServerMessage = (markup: string): { markup: string, text: string } => {
	// Detached and never appended to the document: the fragment below belongs to the template contents
	// owner, not to this page, so nothing here is ever laid out, styled or loaded.
	const template = document.createElement('template')
	template.innerHTML = markup

	sanitizeChildNodes(template.content)

	// `template.innerHTML` serialises the CONTENT fragment, so this is the sanitised markup and not the
	// element wrapping it. `textContent` is read from the same filtered fragment, which is why the
	// source of a dropped `<script>` cannot leak into the text - see {@link sanitizeToText}.
	return { markup: `<div>${template.innerHTML}</div>`, text: template.content.textContent ?? '' }
}

/**
 * The readable text of a server-supplied string, for the places that render it as a plain React
 * child rather than as markup - the banner heading, today.
 *
 * It goes through the SAME walk rather than through a bare `textContent`, because `textContent`
 * includes the source of a `<script>` element: a title of
 * `Over-<script>window.__pwned=true</script>allocation` would otherwise be shown to the reviewer as
 * `Over-window.__pwned=trueallocation`. The walk drops that subtree with its contents, so only text
 * a reader was meant to see survives.
 */
const sanitizeToText = (value: string): string => sanitizeServerMessage(value).text

/** Encodes messages the way Frappe transmits them: a JSON array of JSON strings. */
const encodeServerMessages = (messages: { message: string, title?: string, indicator?: string }[]): string =>
	JSON.stringify(messages.map((message) => JSON.stringify(message)))

/**
 * The rejection to render: the same object the atom holds, with every message body filtered through
 * {@link sanitizeServerMarkup} and re-encoded into a `_server_messages` envelope.
 *
 * `title` is sanitised to TEXT rather than markup because `AlertTitle` renders it as a plain React
 * child, so markup there would be shown literally rather than executed - stripping tags is what
 * keeps the heading readable.
 *
 * `_error_message`, `exception` and `exc` are cleared on the object handed onward. They are not
 * discarded information: the parser has already folded them into the message list being re-encoded
 * here, and leaving them in place would make the shared parser append `_error_message` a SECOND
 * time. Clearing `exc` additionally keeps the server traceback out of the rendered tree.
 *
 * Re-encoding also makes what `ErrorBanner` receives WELL FORMED BY CONSTRUCTION, which matters
 * because the banner parses `_server_messages` again for itself during render (`error-banner.tsx:34`)
 * through the shared parser, and that parser throws on a malformed envelope. Reading the raw error
 * through {@link readServerMessages} - the total wrapper in `./utils` - and handing the banner an
 * envelope this function encoded is what keeps a malformed rejection from taking the dialog down
 * instead of being reported by it.
 */
const useSanitizedError = (error: FrappeError | null): FrappeError | null => useMemo(() => {
	if (!error) return null

	const messages = readServerMessages(error)
		.map((message) => ({
			sanitized: sanitizeServerMessage(message.message ?? ''),
			title: message.title === undefined ? undefined : sanitizeToText(message.title),
			indicator: message.indicator
		}))
		/*
		 * An entry with no READABLE text is dropped, and the test is the text rather than the markup
		 * because the two differ: a rejection whose only content was an `<img>` or an empty `message`
		 * survives sanitisation as a non-empty `<div></div>` while saying nothing at all. Dropping it
		 * here is what lets the honest fallback below run instead of opening a blank dialog.
		 */
		.filter((message) => message.sanitized.text.trim().length > 0)
		.map((message) => ({
			message: message.sanitized.markup,
			title: message.title,
			indicator: message.indicator
		}))

	// `readServerMessages` is total, but it can legitimately resolve NOTHING: a transport failure
	// carries no server response at all, and an envelope the shared parser could not read carries no
	// messages either - and a dialog that opens saying nothing is worse than one that admits it has no
	// detail. The reviewer still gets the chrome, the heading and the Dismiss control.
	const resolved = messages.length > 0
		? messages
		: [{
			message: sanitizeServerMessage(_("No further details were returned.")).markup,
			title: undefined,
			indicator: 'red'
		}]

	const sanitized: FrappeError = {
		...error,
		exception: '',
		exc: undefined,
		_server_messages: encodeServerMessages(resolved)
	}

	delete (sanitized as unknown as Record<string, unknown>)._error_message

	return sanitized
}, [error])

/**
 * Tab-reachable controls a restored focus target may legitimately be. The `:not([disabled])`
 * clauses are load-bearing, not decorative — see {@link canTakeFocus}.
 */
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Whether an element can ACTUALLY take focus right now, as opposed to merely still being in the
 * document. `HTMLElement.focus()` is a silent no-op on a disabled control, so "connected" is not
 * the same question and answering it instead is what stranded keyboard focus on `<body>`: the
 * reconcile button this dialog is usually raised from stays connected after a rejection but is
 * disabled by its own already-reconciled guard the moment the refreshed status lands.
 *
 * `FOCUSABLE_SELECTOR` already excludes `[disabled]` controls, so matching it answers most of the
 * question; `aria-disabled` is checked separately because the design system uses it on composite
 * controls that carry no native `disabled` attribute.
 */
const canTakeFocus = (element: HTMLElement | null): element is HTMLElement =>
	element !== null && element.isConnected &&
	element.matches(FOCUSABLE_SELECTOR) &&
	element.getAttribute('aria-disabled') !== 'true'

/**
 * Shared, dismissible error dialog for the Bank Reconciliation and Bank Statement Importer
 * surfaces. Takes no props: one shared atom drives every mount site across both route trees, so
 * the two surfaces can never show conflicting error state.
 *
 * The error itself is rendered by the SHARED `ErrorBanner`, with `overrideHeading` left unset, so
 * the parser (`getErrorMessages`), the severity rule (`indicator === 'yellow'` -> amber, else red),
 * the heading rule and the message rendering are the same single implementation the ~20 inline
 * banner call sites use. Composing rather than restating is what guarantees this dialog and an
 * inline banner can never disagree about the same rejection, and it means the server's own words -
 * for example `"Bank Transaction {0} is already fully reconciled"` - reach the user verbatim.
 *
 * The one thing that is NOT passed through untouched is the MARKUP. `ErrorBanner` hands each parsed
 * message to `ui/markdown.tsx`, which runs `rehypeRaw` with no sanitiser after it, so a server
 * message reaches the page as real DOM. {@link useSanitizedError} therefore filters every message
 * body through an element/attribute allow-list with a same-origin URL boundary first. TEXT is
 * preserved character for character - nothing is paraphrased, summarised or truncated - and only
 * markup is removed.
 *
 * Dismissing clears the dialog atom and nothing else - it issues no request, triggers no
 * revalidation and raises no notification, because the calling hook owns revalidation. Atomicity
 * is the backend's: its already-reconciled guard runs first and the whole operation commits
 * through a single save.
 */
const BankRecErrorDialog = () => {
	const [error, setError] = useAtom(bankRecErrorDialogAtom)
	const sanitizedError = useSanitizedError(error)
	const dismissRef = useRef<HTMLButtonElement>(null)
	// The most recent control to hold focus outside this dialog, then the control that was focused
	// when the failure surfaced and the region it belonged to. The first is tracked continuously,
	// the other two are frozen on open and consumed on close, so focus returns where the user left
	// it instead of falling to <body>.
	const lastFocusedRef = useRef<HTMLElement | null>(null)
	const invokerRef = useRef<HTMLElement | null>(null)
	const invokerRegionRef = useRef<HTMLElement | null>(null)

	// The invoking control cannot be read from `document.activeElement` when this dialog opens. The
	// actions that fail here are asynchronous and the control that starts one re-renders into its
	// disabled pending state within milliseconds of the click - browsers blur a control the instant
	// it becomes disabled - so `activeElement` has already fallen back to <body> before the
	// rejection arrives. Recording focus as it happens is the only way to still know the invoker at
	// close time. Capture-phase so an intervening handler cannot suppress it, and anything belonging
	// to this dialog is ignored so an open dialog never overwrites the element it will restore.
	useEffect(() => {
		const recordFocus = (event: FocusEvent) => {
			const target = event.target
			if (!(target instanceof HTMLElement)) {
				return
			}

			if (target.hasAttribute('data-radix-focus-guard') || target.closest('[data-slot="alert-dialog-content"]')) {
				return
			}

			lastFocusedRef.current = target
		}

		document.addEventListener('focusin', recordFocus, true)
		return () => document.removeEventListener('focusin', recordFocus, true)
	}, [])

	/** Discards the error being displayed. This is the only state this dialog owns. */
	const dismiss = () => {
		setError(null)
	}

	// This dialog renders a Dismiss action and no cancel control, so Radix has no default target to
	// seed its focus scope with; naming Dismiss keeps Radix's own focus trap authoritative. Radix
	// dispatches this before it moves focus inward, so it is also where the tracked invoker and its
	// surrounding region are frozen for the lifetime of this dialog. The region matters because a
	// rejection can be followed by a revalidation that replaces the invoking control's subtree.
	const onOpenAutoFocus = (event: Event) => {
		const lastFocused = lastFocusedRef.current
		const invoker = lastFocused?.isConnected ? lastFocused : null
		invokerRef.current = invoker
		invokerRegionRef.current = invoker?.closest<HTMLElement>('[data-slot="tabs-content"]') ?? document.getElementById('root')
		event.preventDefault()
		dismissRef.current?.focus()
	}

	// Radix funnels its close intents through here: the Escape key and the action button's own
	// implicit close both arrive as `false`. An overlay click deliberately does NOT - `AlertDialog`
	// suppresses interact-outside so an error that must be acknowledged cannot be dismissed by a
	// stray click. Escape and Dismiss are what make it dismissible.
	const onOpenChange = (v: boolean) => {
		if (!v) {
			dismiss()
		}
	}

	// Radix restores focus to whatever it recorded as previously-focused, which for an atom-driven
	// dialog with no trigger resolves to <body>. So a target is chosen here instead: the captured
	// invoker, else the first focusable control of the region it belonged to.
	//
	// Each candidate is tested with `canTakeFocus` BEFORE the default is suppressed. Testing only
	// `isConnected` suppressed the default and then failed to replace it, because the invoker is
	// routinely connected-but-disabled by the time this runs. Focus is also VERIFIED after the call
	// rather than assumed, so a refusal no predicate can anticipate falls through to the next
	// candidate instead of leaving focus nowhere.
	const onCloseAutoFocus = (event: Event) => {
		const invoker = invokerRef.current
		const region = invokerRegionRef.current
		invokerRef.current = null
		invokerRegionRef.current = null

		const candidates = [
			invoker,
			region?.isConnected ? region.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) : null
		]

		for (const candidate of candidates) {
			if (!canTakeFocus(candidate)) {
				continue
			}

			event.preventDefault()
			candidate.focus()

			if (document.activeElement === candidate) {
				return
			}
		}
	}

	// An empty atom means "no error to show", mirroring the falsy-means-closed modal-atom convention
	// used throughout this feature folder.
	if (!error) {
		return null
	}

	return (
		<AlertDialog open onOpenChange={onOpenChange}>
			{/* Radix marks the rest of the page inert but does not emit `aria-modal`, so the modal
				semantics are declared explicitly here. The focus trap, Escape handling and
				`role="alertdialog"` all remain Radix's.

				WIDTH: the 42rem minimum matches the canonical pattern this dialog imitates
				(`BankTransactionUnreconcileModal.tsx:37`), but it is applied ONLY from `md` (768px)
				upwards. Unqualified, a `min-width` of 672px overrides the primitive's
				`max-w-[calc(100%-2rem)]` - `min-width` beats `max-width` in CSS - so on a 375px
				viewport the box rendered 672px wide and pushed the only Dismiss control off-screen
				horizontally. The importer routes have no desktop-only gate, so that viewport is
				reachable. `md` is the first default breakpoint wide enough to hold 672px inside the
				primitive's 2rem gutter (768 - 32 = 736); below it the primitive's own responsive
				width is left to do its job.

				HEIGHT: `max-h-[90vh]` is the bound `ui/dialog.tsx` already applies to the ordinary
				dialog primitive, and `grid-rows-[auto_minmax(0,1fr)_auto]` is what makes it bite. The
				primitive is `display: grid` with IMPLICIT rows, and a `max-height` on a grid
				container does not shrink an `auto` track - so the message row kept its full content
				height, its `overflow-y-auto` never activated, and the footer painted outside the
				clamped box (measured at 375x812: box 731px, content 2723px, Dismiss 1952px below the
				fold). Naming three tracks pins the header and footer at their natural heights and
				lets only the middle one shrink. The count is exact because this dialog renders
				exactly three children, unconditionally. */}
			<AlertDialogContent aria-modal="true" className="md:min-w-2xl max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto]" onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
				<AlertDialogHeader>
					{/* Deliberately outcome-NEUTRAL. This chrome renders before the rejection has been
					    inspected, and a transport-level failure carries no server response at all - so
					    the client cannot know whether the operation was applied and must not say. FM1
					    makes the backend response the sole source of truth, so the heading and this
					    line only frame the authoritative text below. */}
					<AlertDialogTitle>{_("Something went wrong")}</AlertDialogTitle>
					<AlertDialogDescription>
						{_("Review the details below, then dismiss this message to continue. The server remains the authority on what was recorded.")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{/* The SHARED banner, handed the server's envelope with its TEXT intact and only its
					MARKUP filtered (see `useSanitizedError`); `overrideHeading` is deliberately unset so
					the server's own title survives. `min-h-0` lets this grid item shrink inside the
					`minmax(0,1fr)` track above - a grid item's automatic minimum size would otherwise
					still be its content - and `overflow-y-auto` gives the surplus somewhere to go, so
					only the message scrolls and Dismiss always stays on screen. */}
				<div className="min-h-0 overflow-y-auto">
					<ErrorBanner error={sanitizedError} />
				</div>
				<AlertDialogFooter>
					<AlertDialogAction ref={dismissRef} onClick={dismiss}>
						{_("Dismiss")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

export default BankRecErrorDialog
