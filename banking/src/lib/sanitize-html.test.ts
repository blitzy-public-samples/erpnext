/*
 * `@/lib/sanitize-html` — the ONE shared server-markup sanitiser every `Markdown`/`ErrorBanner`
 * consumer in the SPA renders behind.
 *
 * These are UNIT tests: the plugin is driven directly over hand-built hast trees, which is the exact
 * shape `rehypeRaw` hands it, so each allow-list rule can be specified in isolation. The same rules
 * are asserted a second time end-to-end through the real `react-markdown` pipeline in
 * `BankRecErrorDialog.test.tsx`, which is where the markdown-authored spellings (`![x](url)`, GFM
 * autolinks) can be exercised at all — remark produces those nodes long before this plugin runs.
 *
 * ⚠️ WHAT THIS ENVIRONMENT CAN AND CANNOT PROVE. jsdom does not execute scripts and does not load
 * subresources, and `vitest.config.ts` configures neither, so an assertion that nothing ran or nothing
 * was fetched would be satisfied whether or not the sanitiser works. Nothing below claims that. What
 * is specified — and what is sufficient to specify an allow-list — is the STRUCTURAL outcome: which
 * elements and attributes survive, which are removed with their contents, which are unwrapped, and
 * that the server's own text is never lost.
 */
import type { Element, ElementContent, Properties, Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'

import rehypeSanitizeServerMarkup, { isSameOriginUrl } from './sanitize-html'

/** A hast text node. */
const text = (value: string): ElementContent => ({ type: 'text', value })

/** A hast element, with hast's own property spelling (`className`, `colSpan`, `onClick`, …). */
const el = (
	tagName: string,
	properties: Properties = {},
	children: ElementContent[] = []
): Element => ({ type: 'element', tagName, properties, children })

/** The document root `rehypeRaw` produces, wrapping the nodes under test. */
const root = (...children: RootContent[]): Root => ({ type: 'root', children })

/** Runs the plugin over a tree, in place, and returns it. */
const sanitize = <T extends Root>(tree: T): T => {
	rehypeSanitizeServerMarkup()(tree)
	return tree
}

/** Every tag name in a tree, in document order — the survivors of the element allow-list. */
const tagNames = (node: Root | Element): string[] => {
	const names: string[] = []
	const walk = (parent: Root | Element) => {
		for (const child of parent.children) {
			if (child.type === 'element') {
				names.push(child.tagName)
				walk(child)
			}
		}
	}
	walk(node)
	return names
}

/** All readable text in a tree, concatenated in document order. */
const textOf = (node: Root | Element): string => {
	let value = ''
	const walk = (parent: Root | Element) => {
		for (const child of parent.children) {
			if (child.type === 'text') value += child.value
			else if (child.type === 'element') walk(child)
		}
	}
	walk(node)
	return value
}

/** The first element with the given tag name, or `undefined`. */
const find = (node: Root | Element, tagName: string): Element | undefined => {
	for (const child of node.children) {
		if (child.type !== 'element') continue
		if (child.tagName === tagName) return child
		const nested = find(child, tagName)
		if (nested) return nested
	}
	return undefined
}

describe('rehypeSanitizeServerMarkup', () => {
	describe('script and other active content', () => {
		it('removes a <script> subtree, its source text with it, and keeps the words around it', () => {
			const tree = sanitize(
				root(
					el('p', {}, [
						text('Refused '),
						el('script', {}, [text('window.__pwned = true')]),
						text(' here')
					])
				)
			)

			expect(tagNames(tree)).toEqual(['p'])
			// The source text goes with the element. `textContent` on a real DOM would have included
			// it, which is why the subtree is dropped rather than unwrapped.
			expect(textOf(tree)).toBe('Refused  here')
			expect(textOf(tree)).not.toContain('__pwned')
		})

		it.each(['style', 'iframe', 'object', 'noscript', 'svg', 'template', 'form', 'textarea'])(
			'removes a <%s> subtree',
			(tagName) => {
				const tree = sanitize(root(el('p', {}, [text('a'), el(tagName, {}, [text('payload')])])))

				expect(tagNames(tree)).toEqual(['p'])
				expect(textOf(tree)).toBe('a')
			}
		)

		it.each(['input', 'select', 'button', 'option'])(
			'removes the form control <%s>, which is a credential-harvesting surface',
			(tagName) => {
				const tree = sanitize(root(el('div', {}, [el(tagName, { value: 'v' }, [])])))

				expect(tagNames(tree)).toEqual(['div'])
			}
		)

		it('strips every event-handler property while keeping the element and its text', () => {
			const tree = sanitize(
				root(
					el('span', { onClick: 'steal()', onMouseOver: 'steal()', onError: 'steal()' }, [
						text('Refused')
					])
				)
			)

			const span = find(tree, 'span')
			expect(span).toBeDefined()
			expect(Object.keys(span?.properties ?? {})).toEqual([])
			expect(textOf(tree)).toBe('Refused')
		})
	})

	describe('UI-redress properties', () => {
		it('removes class and id, the two properties that can cover or re-label a surface', () => {
			const tree = sanitize(
				root(el('div', { className: ['fixed', 'inset-0'], id: 'radix-title' }, [text('Refused')]))
			)

			expect(Object.keys(find(tree, 'div')?.properties ?? {})).toEqual([])
			expect(textOf(tree)).toBe('Refused')
		})

		it('removes inline style', () => {
			const tree = sanitize(root(el('span', { style: 'position:fixed;inset:0' }, [text('Refused')])))

			expect(Object.keys(find(tree, 'span')?.properties ?? {})).toEqual([])
		})

		it('removes data-* and aria-* properties, which the allow-list never names', () => {
			const tree = sanitize(
				root(el('span', { dataSlot: 'alert-dialog-content', ariaLabel: 'Dismiss' }, [text('x')]))
			)

			expect(Object.keys(find(tree, 'span')?.properties ?? {})).toEqual([])
		})
	})

	describe('off-origin resources', () => {
		it('removes an <img> even when its source is same-origin, because no message needs one', () => {
			const tree = sanitize(
				root(el('p', {}, [text('Refused '), el('img', { src: '/assets/erpnext/x.png' }, [])]))
			)

			expect(tagNames(tree)).toEqual(['p'])
			expect(textOf(tree)).toBe('Refused ')
		})

		it('removes an off-origin <img> and leaves no reference to its host behind', () => {
			const tree = sanitize(
				root(el('p', {}, [el('img', { src: 'https://tracker.example/pixel.png' }, [])]))
			)

			expect(find(tree, 'img')).toBeUndefined()
			expect(JSON.stringify(tree)).not.toContain('tracker.example')
		})
	})

	describe('the same-origin link boundary', () => {
		it("keeps Frappe's own root-relative document link, with rel stamped on it", () => {
			const tree = sanitize(
				root(el('a', { href: '/app/bank-transaction/ACC-BTN-2024-00001' }, [text('this transaction')]))
			)

			const anchor = find(tree, 'a')
			expect(anchor?.properties.href).toBe('/app/bank-transaction/ACC-BTN-2024-00001')
			expect(anchor?.properties.rel).toBe('noreferrer noopener')
			expect(anchor?.properties.target).toBeUndefined()
		})

		it('keeps a fragment and a plain relative reference', () => {
			const tree = sanitize(
				root(
					el('p', {}, [
						el('a', { href: '#details' }, [text('details')]),
						el('a', { href: 'rules' }, [text('rules')])
					])
				)
			)

			expect(tagNames(tree)).toEqual(['p', 'a', 'a'])
		})

		it.each([
			['javascript:', 'javascript:window.__pwned=true'],
			['data:', 'data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4='],
			['an absolute off-origin URL', 'https://phish.example/login'],
			['the scheme-relative form', '//phish.example/login'],
			['a control-character-obfuscated scheme', 'java\nscript:window.__pwned=true'],
			['a backslash network-path reference', '\\\\phish.example/login'],
			['a mixed-slash network-path reference', '/\\phish.example/login']
		])('unwraps an anchor whose href is %s, keeping the text the server wrote', (_label, href) => {
			const tree = sanitize(root(el('p', {}, [el('a', { href }, [text('click here')])])))

			// No anchor survives, so nothing looks like something this application offers to navigate
			// to — but the words are still readable.
			expect(tagNames(tree)).toEqual(['p'])
			expect(textOf(tree)).toBe('click here')
		})

		it('drops a src that is not same-origin while keeping an allow-listed element', () => {
			// `src` is not on any element's allow-list once `img`/`video`/`iframe` are dropped, so this
			// asserts the URL rule itself rather than the element rule.
			const tree = sanitize(root(el('span', { src: 'https://phish.example/x' }, [text('a')])))

			expect(Object.keys(find(tree, 'span')?.properties ?? {})).toEqual([])
		})
	})

	describe('isSameOriginUrl', () => {
		it('accepts references that resolve back to this document', () => {
			expect(isSameOriginUrl('#anchor')).toBe(true)
			expect(isSameOriginUrl('/app/bank-transaction/ACC-BTN-2024-00001')).toBe(true)
			expect(isSameOriginUrl('rules')).toBe(true)
		})

		it('refuses even a same-origin ABSOLUTE reference, because it carries an explicit scheme', () => {
			// Stricter than the origin check on purpose: the scheme refusal is what keeps `javascript:`
			// and `data:` out of a document whose own origin is opaque, where `location.origin` and a
			// `javascript:` URL's origin are both the string "null". No Frappe message writes an
			// absolute self-reference, so nothing legitimate is lost by refusing this shape too.
			expect(isSameOriginUrl(`${window.location.origin}/app`)).toBe(false)
		})

		it('refuses an empty or whitespace-only reference', () => {
			expect(isSameOriginUrl('')).toBe(false)
			expect(isSameOriginUrl('   \t\n')).toBe(false)
		})

		it('refuses a reference the platform parser cannot resolve at all', () => {
			// A percent sign followed by a non-hex pair defeats WHATWG parsing, and the refusal has to
			// happen HERE rather than as a throw out of the sanitiser.
			expect(isSameOriginUrl('http://%zz')).toBe(false)
		})

		it('proves the backslash spellings really do resolve off this origin', () => {
			// The syntactic refusals are kept because they are STRICTER than the origin check; this
			// pins the premise, so a future change to the origin comparison cannot quietly weaken them.
			expect(new URL('\\\\phish.example/login', window.location.href).origin).not.toBe(
				window.location.origin
			)
			expect(new URL('/\\phish.example/login', window.location.href).origin).not.toBe(
				window.location.origin
			)
		})
	})

	describe('structure the server legitimately uses', () => {
		it('keeps the markup a validation summary is written with', () => {
			const tree = sanitize(
				root(
					el('div', {}, [
						el('b', {}, [text('Refused')]),
						el('ul', {}, [el('li', {}, [text('one')]), el('li', {}, [text('two')])]),
						el('table', {}, [
							el('tbody', {}, [
								el('tr', {}, [
									el('td', { colSpan: 2, rowSpan: 1, className: 'x' }, [text('cell')]),
									el('th', { scope: 'col' }, [text('head')])
								])
							])
						]),
						el('br', {}, []),
						el('code', {}, [text('ACC-BTN-2024-00001')])
					])
				)
			)

			expect(tagNames(tree)).toEqual([
				'div', 'b', 'ul', 'li', 'li', 'table', 'tbody', 'tr', 'td', 'th', 'br', 'code'
			])
			// The structural attributes a table needs survive; the styling hook does not.
			expect(find(tree, 'td')?.properties).toEqual({ colSpan: 2, rowSpan: 1 })
			expect(find(tree, 'th')?.properties).toEqual({ scope: 'col' })
			expect(textOf(tree)).toBe('RefusedonetwocellheadACC-BTN-2024-00001')
		})

		it('keeps the global attributes the allow-list does name', () => {
			const tree = sanitize(
				root(el('p', { dir: 'rtl', lang: 'ar', title: 'hint', align: 'right', id: 'x' }, [text('a')]))
			)

			expect(find(tree, 'p')?.properties).toEqual({
				dir: 'rtl',
				lang: 'ar',
				title: 'hint',
				align: 'right'
			})
		})

		it('keeps `start` on an ordered list only', () => {
			const tree = sanitize(
				root(el('ol', { start: 3 }, [el('li', { start: 3 }, [text('three')])]))
			)

			expect(find(tree, 'ol')?.properties).toEqual({ start: 3 })
			expect(find(tree, 'li')?.properties).toEqual({})
		})

		it('unwraps an unknown-but-harmless tag, keeping every word inside it', () => {
			const tree = sanitize(
				root(el('p', {}, [text('a '), el('marquee-ish', {}, [text('kept')]), text(' b')]))
			)

			expect(tagNames(tree)).toEqual(['p'])
			expect(textOf(tree)).toBe('a kept b')
		})

		it('removes comments, doctypes and any unconsumed raw node', () => {
			const tree = sanitize(
				root(
					{ type: 'comment', value: ' hidden ' },
					{ type: 'doctype' },
					{ type: 'raw', value: '<script>window.__pwned = true</script>' },
					el('p', {}, [text('kept')])
				)
			)

			expect(tree.children).toHaveLength(1)
			expect(textOf(tree)).toBe('kept')
			expect(JSON.stringify(tree)).not.toContain('__pwned')
		})

		it('handles an element whose properties bag is absent', () => {
			// `rehypeRaw` always supplies a `properties` object and the hast type requires one, but a
			// plugin upstream of this one is free to hand over a node without it - and the sanitiser has
			// to survive that rather than throw while reporting a failure.
			const bare = { type: 'element', tagName: 'p', children: [text('kept')] } as unknown as Element
			const tree = sanitize(root(bare))

			expect(textOf(tree)).toBe('kept')
			expect(find(tree, 'p')?.properties).toEqual({})
		})

		it('leaves a tree with no elements untouched', () => {
			const tree = sanitize({ type: 'root', children: [{ type: 'text', value: 'just words' }] })

			expect(textOf(tree)).toBe('just words')
		})
	})
})
