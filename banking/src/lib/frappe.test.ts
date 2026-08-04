/*
 * `lib/frappe.ts` is the only path a backend refusal takes to the user, so the server's wording has
 * to survive the parse unaltered. Five branches behave in ways the source does not telegraph, and
 * each is pinned below under a QUIRK label.
 *
 * WHY THIS SUITE IS A SPECIFICATION AND NOT A WISH LIST
 * ----------------------------------------------------
 * `frappe.ts` is the single code path through which every backend refusal reaches the user.
 * `ErrorBanner` (`src/components/ui/error-banner.tsx:35`) funnels the raw `FrappeError`
 * straight into `getErrorMessages`, and the reconciliation error dialog renders whatever
 * comes back — so the server's own text, for example "Bank Transaction {0} is already fully
 * reconciled", reaches the accountant VERBATIM with no client-side paraphrasing. Getting the
 * parse wrong does not produce a cosmetic defect; it silently changes what a reviewer is told
 * about a rejected posting.
 *
 * The module is mature, working code. These tests therefore DOCUMENT what it actually does,
 * including three behaviours that are surprising on first reading. Each is labelled QUIRK and
 * pinned with an explicit assertion, so a later change that "tidies" one of them fails loudly
 * here instead of quietly altering the user-facing message:
 *
 *   QUIRK 3  The colon-slice step guards with a TRUTHINESS test, so a colon at index 0 is
 *            skipped and resolution falls through to `message` (`frappe.ts:150`).
 *   QUIRK 4  `indexOf(':')` returning -1 is truthy, so a colon-LESS exception is sliced from
 *            index 0 and survives whole (`frappe.ts:150-151`).
 *   QUIRK 5  `_error_message` is APPENDED to the parsed server messages, never substituted
 *            for them (`frappe.ts:137-145`).
 *
 * The numbering starts at 3 deliberately. QUIRKS 1 and 2 are not pinned as quirks but specified as
 * LIMITS, in the `the envelope is parsed UNGUARDED` block below, because they bound what a caller of
 * this parser is entitled to assume:
 *
 *   LIMIT 1  The outer `JSON.parse` of `_server_messages` is UNGUARDED, and `.map` then runs on
 *            whatever it produced - so a truncated body, a rewritten body, or valid JSON that is not
 *            an array THROWS out of this parser.
 *   LIMIT 2  A SINGLY encoded element survives as a bare string with no `message` property, and an
 *            entry carrying no `message` is kept - which also SUPPRESSES the
 *            `_error_message` -> `exception` -> `message` fallback chain, because that chain is gated
 *            on the parsed array being empty.
 *
 * This module is FROZEN by the Agent Action Plan - section 0.6.4 records the error-transport envelope
 * as "Unchanged - reused verbatim by the new dialog", and section 0.9.1 does not list it among the
 * paths this work may touch - so neither limit is repaired here, and no wrapper is introduced to hide
 * one. They are SPECIFIED instead, which is the useful thing a frozen contract's suite can do: the
 * dialog this work adds renders through `ErrorBanner`, so it reads the envelope through exactly this
 * parser, and the block below pins what that parser really does so a future change to it fails here
 * rather than quietly altering what a reviewer is told about a refusal.
 *
 * LIMIT 1 is also worth putting in proportion: it is unreachable through the real transport. A
 * `FrappeError` only carries `_server_messages` once the response body has already parsed as JSON, so
 * a truncated body or an intermediary's HTML error page never produces the field at all - it produces
 * an error resolved through the `_error_message` -> `exception` -> `message` chain instead.
 *
 * Every other behaviour below is asserted as the module BEHAVES, never as it ideally would: this
 * suite is a specification of the shipped parser, so a future change to it fails here rather than
 * silently altering what a reviewer is told about a refusal.
 *
 * Every expected value below was produced by executing the real module under this harness,
 * not reasoned about on paper.
 *
 * CONVENTIONS THIS FILE IS OBLIGED TO FOLLOW
 * ------------------------------------------
 *  - Vitest symbols are imported explicitly. `vitest.config.ts` sets `globals: true`, which
 *    exposes the API at RUNTIME, but `tsconfig.app.json` declares no `types` array, so nothing
 *    is ambiently typed and an implicit `describe` would not compile.
 *  - The parsed-message interface at `frappe.ts:3-7` is private to that module and is
 *    deliberately NOT imported here; assertions are structural instead.
 *    `error-banner.tsx:14-18` declares its own local copy for exactly the same reason.
 *  - No ambient global is declared here. Live `ts-expect-error` directives across `src/` —
 *    `lib/company.ts`, `lib/currency.ts`, `hooks/useDocType.ts` and `main.tsx` among them —
 *    depend on the bare `frappe` and `locals` globals staying untyped; typing either would
 *    orphan those directives and fail the build with `TS2578`. The count is deliberately not
 *    stated, because a stated count goes stale the moment a directive is added or removed.
 *  - Error envelopes come from `src/test/factories.ts`. Only the malformed shapes it has no named
 *    builder for — a SINGLY encoded element, an unparseable envelope, a non-array envelope and an
 *    entry carrying no `message` — are composed here, through the base builder the factory
 *    exposes for precisely that purpose. That builder also owns the single `FrappeError` cast, so
 *    this file needs no cast of its own.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
	getBootFieldData,
	getErrorMessage,
	getErrorMessages,
	getSystemDefault,
	getUserDefault,
	scrub,
	slug,
	unscrub
} from '@/lib/frappe'

import {
	formatAlreadyReconciledMessage,
	makeAlreadyReconciledError,
	makeColonlessExceptionError,
	makeErrorMessageError,
	makeExceptionError,
	makeFrappeError,
	makeLeadingColonExceptionError,
	makeMessageOnlyError,
	makeServerMessagesError,
	makeWarningServerMessagesError
} from '@/test/factories'

/* ── Local fixtures ─────────────────────────────────────────────────────────────────
 * The factory covers one envelope per resolution path, which is all its named builders
 * need to do. The remaining shapes are composed below from the exposed base builder
 * rather than hand-rolled:
 *   - a MULTI-message envelope, required to prove server ORDER and to prove QUIRK 5's
 *     append-not-substitute behaviour;
 *   - the four MALFORMED envelopes the guard is verified against — singly encoded,
 *     unparseable, non-array, and an entry carrying no `message`. The factory's own
 *     encoder always produces a well-formed double-encoded envelope, so none of these
 *     can come from it.
 * ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Structural mirror of the shape a parsed server message has. Declared locally, exactly as
 * `error-banner.tsx:14-18` does, because the equivalent interface at `frappe.ts:3-7` is
 * private to that module and importing it is out of bounds.
 */
interface ServerMessagePayload {
	message: string
	title?: string
	indicator?: string
}

/**
 * Encodes messages the way Frappe actually transmits them: DOUBLE-encoded — a JSON array
 * whose elements are themselves JSON strings. `getErrorMessages` parses the outer array and then
 * each element, which is why a fixture has to encode TWICE for the parser to see message objects.
 */
const encodeServerMessages = (...messages: ServerMessagePayload[]): string =>
	JSON.stringify(messages.map((message) => JSON.stringify(message)))

const FIRST_SERVER_MESSAGE = 'Bank Transaction BT-0001 is already fully reconciled'
const SECOND_SERVER_MESSAGE = 'Second msg'

const TWO_MESSAGE_ENVELOPE = encodeServerMessages(
	{ message: FIRST_SERVER_MESSAGE, title: 'Message', indicator: 'red' },
	{ message: SECOND_SERVER_MESSAGE, title: 'Message', indicator: 'yellow' }
)

const APPENDED_ERROR_MESSAGE = 'Appended error message'

describe('getErrorMessages', () => {
	describe('the empty-input guard', () => {
		it('returns an empty array when no error has occurred', () => {
			expect(getErrorMessages(undefined)).toEqual([])
		})

		it('returns an empty array when the error has been explicitly cleared to null', () => {
			expect(getErrorMessages(null)).toEqual([])
		})
	})

	describe('path 1 — the double-encoded _server_messages envelope', () => {
		it('parses every element into an object and preserves the order the server sent', () => {
			const result = getErrorMessages(
				makeFrappeError({ _server_messages: TWO_MESSAGE_ENVELOPE })
			)

			expect(result).toHaveLength(2)
			expect(result[0].message).toBe(FIRST_SERVER_MESSAGE)
			expect(result[0].title).toBe('Message')
			expect(result[0].indicator).toBe('red')
			expect(result[1].message).toBe(SECOND_SERVER_MESSAGE)
			expect(result[1].title).toBe('Message')
			expect(result[1].indicator).toBe('yellow')
		})

		it('resolves the single-message envelope a plain frappe.throw produces', () => {
			const result = getErrorMessages(makeServerMessagesError('Voucher is over-allocated'))

			expect(result).toStrictEqual([
				{ message: 'Voucher is over-allocated', title: 'Message', indicator: 'red' }
			])
		})

		it('carries the server severity through untouched, including the amber warning', () => {
			/* The `indicator` is the WHOLE amber-versus-red decision at
			 * `error-banner.tsx:39`; the client makes no severity judgement of its own, so a
			 * parser that normalised this value would silently repaint every warning red. */
			const result = getErrorMessages(
				makeWarningServerMessagesError('Transaction currency differs from the account')
			)

			expect(result[0].indicator).toBe('yellow')
		})

		it('delivers the already-reconciled refusal verbatim, transaction name substituted', () => {
			const result = getErrorMessages(makeAlreadyReconciledError('ACC-BTN-2024-00003'))

			expect(result[0].message).toBe(
				formatAlreadyReconciledMessage('ACC-BTN-2024-00003')
			)
			expect(result[0].message).toBe(
				'Bank Transaction ACC-BTN-2024-00003 is already fully reconciled'
			)
		})

		it('prefers _server_messages over exception when the error carries both', () => {
			/* The factory populates `exception` as well, so this pins the PRECEDENCE at
			 * `frappe.ts:147`: the colon-slice step is guarded by `eMessages.length === 0` and
			 * is therefore unreachable while any server message parsed. */
			const result = getErrorMessages(makeServerMessagesError('Duplicate reference number'))

			expect(result).toHaveLength(1)
			expect(result[0].message).toBe('Duplicate reference number')
			expect(result[0].message).not.toContain('ValidationError')
		})

	})

	/*
	 * ══════════════════════════════════════════════════════════════════════════════════════════════
	 * THE ENVELOPE IS PARSED UNGUARDED — this shared parser is NOT total
	 *
	 * `_server_messages` is server-controlled and only CONVENTIONALLY well formed: a truncated
	 * response, a proxy that rewrote the body, or an intermediary's HTML error page can deliver
	 * something else entirely. This module parses it with a bare `JSON.parse` and then `.map`s the
	 * result, so all three of those inputs throw out of `getErrorMessages` — during RENDER, in the case
	 * of `ErrorBanner` (`error-banner.tsx:34`).
	 *
	 * The module is frozen (see the file header), so the cases below are specified as LIMITS rather
	 * than repaired. They exist to pin exactly what a caller is and is not entitled to assume — and
	 * the inputs that reach them do not arise on the real transport, because `_server_messages` only
	 * exists on an error whose body already parsed as JSON.
	 * ══════════════════════════════════════════════════════════════════════════════════════════════ */
	describe('the envelope is parsed UNGUARDED — specified LIMITS of the shared parser', () => {
		it('LIMIT 1: THROWS on an envelope that is not valid JSON at all', () => {
			const truncated = makeFrappeError({
				_server_messages: '[{"message":"Reconciliation refu',
				exception: 'frappe.exceptions.ValidationError: Bank Account is disabled'
			})

			expect(() => getErrorMessages(truncated)).toThrow()
		})

		it('LIMIT 1: THROWS on a NON-ARRAY envelope, because `.map` is reached on an object', () => {
			// Valid JSON, wrong shape — a distinct failure from the parse above, and the reason the
			// wrapper has to guard the `.map` as well as the `JSON.parse`.
			const nonArray = makeFrappeError({
				_server_messages: '{"message":"Reconciliation refused"}',
				exception: '',
				message: 'Internal Server Error'
			})

			expect(() => getErrorMessages(nonArray)).toThrow()
		})

		it('LIMIT 1: THROWS on a JSON string envelope, which is valid JSON and also not an array', () => {
			const stringEnvelope = makeFrappeError({
				_server_messages: '"Reconciliation refused"',
				exception: '',
				message: 'Internal Server Error'
			})

			expect(() => getErrorMessages(stringEnvelope)).toThrow()
		})

		it('LIMIT 1: the throw defeats `getErrorMessage` too, so a toast description is not safe either', () => {
			const malformed = makeFrappeError({
				_server_messages: '[{"message":"trunc',
				exception: 'frappe.exceptions.ValidationError: Invalid Bank Account'
			})

			expect(() => getErrorMessage(malformed)).toThrow()
		})

		it('LIMIT 2: leaves a SINGLY encoded element as a bare string with no `message`', () => {
			// Frappe's convention is DOUBLE encoding, so the inner parse is what turns each element into
			// an object. When an element is a bare string that parse throws and the string survives — and
			// a plain string has no `message`, so the banner renders `undefined`: an empty body, for a
			// refusal that did carry text.
			const result = getErrorMessages(
				makeFrappeError({
					_server_messages: JSON.stringify(['Bank Transaction is already fully reconciled'])
				})
			)

			expect(result).toStrictEqual(['Bank Transaction is already fully reconciled'])
			expect(result[0].message).toBeUndefined()
		})

		it('LIMIT 2: KEEPS an entry carrying no `message`, which suppresses the `exception` fallback', () => {
			// The array is non-empty, and the fallback chain is gated on it being empty — so an entry that
			// says nothing actively denies the reviewer text that was available on a different field.
			const result = getErrorMessages(
				makeFrappeError({
					_server_messages: JSON.stringify([JSON.stringify({ title: 'Message', indicator: 'red' })]),
					exception: 'frappe.exceptions.ValidationError: The bank account is disabled'
				})
			)

			expect(result).toStrictEqual([{ title: 'Message', indicator: 'red' }])
			expect(getErrorMessage(makeFrappeError({
				_server_messages: JSON.stringify([JSON.stringify({ title: 'Message', indicator: 'red' })]),
				exception: 'frappe.exceptions.ValidationError: The bank account is disabled'
			}))).not.toContain('disabled')
		})

		it('LIMIT 2: keeps an entry whose `message` is the empty string, for the same reason', () => {
			const result = getErrorMessages(
				makeFrappeError({
					_server_messages: JSON.stringify([JSON.stringify({ message: '', title: 'Message' })]),
					exception: '',
					message: 'Internal Server Error'
				})
			)

			expect(result).toStrictEqual([{ message: '', title: 'Message' }])
		})

		it('LIMIT 2: keeps an element that is neither a string nor an object', () => {
			const result = getErrorMessages(
				makeFrappeError({
					_server_messages: JSON.stringify([JSON.stringify(42), JSON.stringify(null)]),
					exception: '',
					message: 'Internal Server Error'
				})
			)

			expect(result).toStrictEqual([42, null])
		})

		it('parses a MIXED envelope element by element, so a well-formed sibling is unaffected', () => {
			const result = getErrorMessages(
				makeFrappeError({
					_server_messages: JSON.stringify([
						JSON.stringify({ message: 'Properly encoded', title: 'Message', indicator: 'yellow' }),
						'Singly encoded'
					])
				})
			)

			expect(result).toHaveLength(2)
			expect(result[0]).toStrictEqual({
				message: 'Properly encoded',
				title: 'Message',
				indicator: 'yellow'
			})
			expect(result[1]).toBe('Singly encoded')
			// Order is the server's, and the FIRST entry is the one `error-banner.tsx:37` themes on.
			expect(result[0].indicator).toBe('yellow')
		})

		it('treats an EMPTY array envelope as no messages, exactly as an absent one', () => {
			// The one malformed-ish shape this module handles on its own: an empty array leaves the
			// parsed list empty, so the fallback chain runs as designed.
			const result = getErrorMessages(
				makeFrappeError({ _server_messages: '[]', exception: '', message: 'Internal Server Error' })
			)

			expect(result).toStrictEqual([
				{ message: 'Internal Server Error', title: 'Error', indicator: 'red' }
			])
		})

		it('appends `_error_message` only when the envelope parsed, so an unreadable one costs it', () => {
			// The append itself is independent of the envelope, but it is placed AFTER the parse — so a
			// malformed envelope denies the reviewer a message that arrived on a different field.
			expect(() => getErrorMessages(
				makeFrappeError({
					_server_messages: 'not json',
					_error_message: APPENDED_ERROR_MESSAGE
				})
			)).toThrow()

			expect(getErrorMessages(
				makeFrappeError({ _server_messages: '[]', _error_message: APPENDED_ERROR_MESSAGE })
			)).toStrictEqual([
				{ message: APPENDED_ERROR_MESSAGE, title: 'Error', indicator: 'red' }
			])
		})
	})

	describe('path 2 — the appended _error_message', () => {
		it('reports an _error_message on its own as a single red Error entry', () => {
			const result = getErrorMessages(
				makeErrorMessageError('Insufficient permission for Bank Transaction')
			)

			expect(result).toStrictEqual([
				{
					message: 'Insufficient permission for Bank Transaction',
					title: 'Error',
					indicator: 'red'
				}
			])
		})

		it('QUIRK 5: appends the _error_message entry LAST instead of substituting it', () => {
			/* `frappe.ts:139` pushes onto the already-parsed array. Asserting the LENGTH and the
			 * LAST index together is what distinguishes append from substitute — either
			 * behaviour would satisfy a test that only looked at `result[0]`. */
			const result = getErrorMessages(
				makeFrappeError({
					_server_messages: TWO_MESSAGE_ENVELOPE,
					_error_message: APPENDED_ERROR_MESSAGE
				})
			)

			expect(result).toHaveLength(3)
			expect(result[0].message).toBe(FIRST_SERVER_MESSAGE)
			expect(result[1].message).toBe(SECOND_SERVER_MESSAGE)
			expect(result[2].message).toBe(APPENDED_ERROR_MESSAGE)
			expect(result[2].title).toBe('Error')
			expect(result[2].indicator).toBe('red')
		})
	})

	describe('path 3 — recovering the text from the exception field', () => {
		it('slices off the exception type and KEEPS the leading space after the colon', () => {
			/* The parser preserves the leading space after the colon; assert parser output
			 * exactly. */
			const result = getErrorMessages(makeExceptionError(FIRST_SERVER_MESSAGE))

			expect(result).toHaveLength(1)
			expect(result[0].message).toBe(` ${FIRST_SERVER_MESSAGE}`)
			expect(result[0].message).toBe(
				' Bank Transaction BT-0001 is already fully reconciled'
			)
			expect(result[0].title).toBe('Error')
		})

		it('leaves indicator UNSET on the colon-slice path, unlike every other path', () => {
			/* `frappe.ts:153-156` builds the entry without an `indicator`, whereas paths 2 and 4
			 * both set `'red'`. That difference is load-bearing at `error-banner.tsx:39`, which
			 * themes amber only on `'yellow'` and therefore falls to red here — so the absent
			 * key is the signal that path 3, not path 4, produced this entry. */
			const result = getErrorMessages(makeExceptionError('Voucher is over-allocated'))

			expect(result[0].indicator).toBeUndefined()
			expect(result[0]).toStrictEqual({
				message: ' Voucher is over-allocated',
				title: 'Error'
			})
		})

		it('QUIRK 3: skips the slice when the colon sits at index 0 and falls through to message', () => {
			/* `frappe.ts:150` guards with `if (indexOfFirstColon)`, a TRUTHINESS test rather than
			 * an `!== undefined` test. An exception beginning with ':' yields index `0`, which
			 * is falsy, so the colon-slice step never runs even though a colon is plainly
			 * present and resolution drops to path 4. The bare `message` therefore wins. */
			const result = getErrorMessages(
				makeLeadingColonExceptionError('Leading colon message')
			)

			expect(result).toHaveLength(1)
			expect(result[0].message).toBe(
				'Bare message reached because the colon sits at index zero'
			)
			expect(result[0].message).not.toContain('Leading colon message')
			expect(result[0].indicator).toBe('red')
		})

		it('QUIRK 4: returns a colon-less exception WHOLE, because -1 is truthy', () => {
			/* `indexOf(':')` returns `-1` for a string with no colon; `-1` is truthy, so the
			 * guard passes and `slice(-1 + 1)` is `slice(0)` — the entire exception survives
			 * with nothing removed, and with no leading space to strip either. */
			const result = getErrorMessages(makeColonlessExceptionError('NoColonHere'))

			expect(result).toStrictEqual([{ message: 'NoColonHere', title: 'Error' }])
		})
	})

	describe('path 4 — the bare message fallback', () => {
		it('falls back to message when the exception is empty, and marks it red', () => {
			/* An empty `exception` takes the long way round: `''.indexOf(':')` is `-1` (truthy,
			 * so the guard passes), `''.slice(0)` is `''` (falsy, so `frappe.ts:152` skips the
			 * assignment), and the array is still empty when `frappe.ts:160` is reached. This is
			 * the shape a transport failure has — no server messages and no traceback. */
			const result = getErrorMessages(makeMessageOnlyError('Network Error'))

			expect(result).toStrictEqual([
				{ message: 'Network Error', title: 'Error', indicator: 'red' }
			])
		})

		it('sets indicator red here, in contrast to the colon-slice path that sets none', () => {
			const fromMessage = getErrorMessages(makeMessageOnlyError('Internal Server Error'))
			const fromException = getErrorMessages(makeExceptionError('Internal Server Error'))

			expect(fromMessage[0].indicator).toBe('red')
			expect(fromException[0].indicator).toBeUndefined()
		})

		it('reports the factory default message when none is supplied', () => {
			const result = getErrorMessages(makeMessageOnlyError())

			expect(result[0].message).toBe('Internal Server Error')
		})
	})
})

describe('getErrorMessage', () => {
	it('joins every parsed message with a newline, in the order the server sent them', () => {
		/* `frappe.ts:12`. The separator is a literal `\n`, not a space and not a bullet, which
		 * is what lets a multi-message refusal read as separate lines in a toast. */
		expect(getErrorMessage(makeFrappeError({ _server_messages: TWO_MESSAGE_ENVELOPE })))
			.toBe(`${FIRST_SERVER_MESSAGE}\n${SECOND_SERVER_MESSAGE}`)
	})

	it('returns an empty string when there is no error at all', () => {
		expect(getErrorMessage(undefined)).toBe('')
		expect(getErrorMessage(null)).toBe('')
	})

	it('returns the bare message for a transport-failure envelope', () => {
		expect(getErrorMessage(makeMessageOnlyError('Network Error'))).toBe('Network Error')
	})

	it('yields readable text for every shape that carries text in a DIFFERENT field', () => {
		/* The property that matters at every toast call site: an error object that carries text
		 * somewhere always yields something to read. Each shape below reaches a different branch —
		 * appended fallback field, exception-only, message-only — and none of them may resolve to
		 * nothing. */
		expect(getErrorMessage(makeErrorMessageError('Not permitted'))).toBe('Not permitted')
		expect(getErrorMessage(makeExceptionError('Voucher is over-allocated')).trim())
			.toBe('Voucher is over-allocated')
		expect(getErrorMessage(makeMessageOnlyError('Network Error'))).toBe('Network Error')
	})
})

describe('slug', () => {
	it('lowercases a DocType name and hyphenates spaces, as the /desk deep links require', () => {
		expect(slug('Payment Entry')).toBe('payment-entry')
		expect(slug('Journal Entry')).toBe('journal-entry')
		expect(slug('Bank Transaction')).toBe('bank-transaction')
		expect(slug('Sales Invoice')).toBe('sales-invoice')
	})

	it('returns an empty string for undefined rather than throwing', () => {
		expect(slug(undefined)).toBe('')
		expect(slug('')).toBe('')
	})

	it('replaces SPACES ONLY — an underscore in the name survives untouched', () => {
		/* Pinned so nobody later "improves" this into a general slugifier: the regex is `/ /g`,
		 * so every other character, punctuation included, is passed through lowercased. */
		expect(slug('Bank_Transaction Rule')).toBe('bank_transaction-rule')
	})
})

describe('scrub', () => {
	it('lowercases and underscores spaces, the form MatchFilters uses as a DOM id', () => {
		expect(scrub('Payment Entry')).toBe('payment_entry')
		expect(scrub('Sales Invoice')).toBe('sales_invoice')
		expect(scrub('Purchase Invoice')).toBe('purchase_invoice')
		expect(scrub('Journal Entry')).toBe('journal_entry')
	})

	it('coerces undefined and the empty string to an empty string', () => {
		expect(scrub(undefined)).toBe('')
		expect(scrub('')).toBe('')
	})

	it('replaces SPACES ONLY — a hyphen in the name survives untouched', () => {
		expect(scrub('Bank-Transaction Rule')).toBe('bank-transaction_rule')
	})
})

describe('unscrub', () => {

	it('turns underscores AND hyphens into spaces and title-cases every word', () => {
		expect(unscrub('bank_transaction-rule')).toBe('Bank Transaction Rule')
		expect(unscrub('payment_entry')).toBe('Payment Entry')
		expect(unscrub('a_b-c')).toBe('A B C')
	})

	it('lowercases the tail of an already upper-cased token', () => {
		/* `frappe.ts:181-183` upper-cases `charAt(0)` and lower-cases `substring(1)` for each
		 * `\w*` run, so this is a normalising title-case rather than a first-letter capitalise. */
		expect(unscrub('BANK_TRANSACTION')).toBe('Bank Transaction')
	})

	it('coerces undefined and the empty string to an empty string', () => {
		expect(unscrub(undefined)).toBe('')
		expect(unscrub('')).toBe('')
	})
})

/*
 * Expected values below are the ones `src/test/setup.ts` installs, which is the authority for what a
 * hit returns. The three constants are keys a real site defines but the harness deliberately leaves
 * out, so the fallback branch is reached without mutating any global.
 */

const UNSTUBBED_SYSTEM_DEFAULT = 'fiscal_year'
const UNSTUBBED_USER_DEFAULT = 'cost_center'
const UNSTUBBED_BOOT_FIELD = 'user_info'

describe('getSystemDefault', () => {
	it('reads a stubbed value straight off boot.sysdefaults', () => {
		expect(getSystemDefault('currency')).toBe('INR')
		expect(getSystemDefault('number_format')).toBe('#,###.##')
		expect(getSystemDefault('float_precision')).toBe('3')
		expect(getSystemDefault('currency_precision')).toBe('2')
		expect(getSystemDefault('country')).toBe('India')
		expect(getSystemDefault('hide_currency_symbol')).toBe('No')
	})

	it('resolves link_field_results_limit, the page size LinkFieldCombobox searches with', () => {
		/* `LinkFieldCombobox.tsx:125` reads `limit || getSystemDefault('link_field_results_limit')
		 * || 20`. Asserted as a STRING because every `sysdefaults` value arrives as a string,
		 * numeric-looking ones included — the reason the consumer funnels it through a numeric
		 * coercion downstream. */
		expect(getSystemDefault('link_field_results_limit')).toBe('10')
	})

	it('returns the supplied fallback for a key the site does not define', () => {
		expect(getSystemDefault(UNSTUBBED_SYSTEM_DEFAULT, '2024-2025')).toBe('2024-2025')
	})

	it('returns undefined for an unknown key when no fallback is supplied', () => {
		/* The `fallback` parameter is optional, so `?? undefined` is the honest result — not an
		 * empty string. Callers such as `LinkFieldCombobox.tsx:125` rely on that being falsy so
		 * their own `||` default takes over. */
		expect(getSystemDefault(UNSTUBBED_SYSTEM_DEFAULT)).toBeUndefined()
	})
})

describe('getUserDefault', () => {
	it('reads the signed-in user defaults off boot.user.defaults', () => {
		expect(getUserDefault('company')).toBe('Test Company')
		expect(getUserDefault('date_format')).toBe('dd-mm-yyyy')
	})

	it('returns the supplied fallback for a default this user has not set', () => {
		expect(getUserDefault(UNSTUBBED_USER_DEFAULT, 'Main - TC')).toBe('Main - TC')
	})

	it('returns undefined for an unset default when no fallback is supplied', () => {
		expect(getUserDefault(UNSTUBBED_USER_DEFAULT)).toBeUndefined()
	})
})

describe('getBootFieldData', () => {
	it('reads a top-level field off boot', () => {
		expect(getBootFieldData('sitename')).toBe('test.localhost')
		expect(getBootFieldData('desk_theme')).toBe('Light')
		expect(getBootFieldData('layout_direction')).toBe('ltr')
		expect(getBootFieldData('lang')).toBe('en')
	})

	it('returns the supplied fallback for a field this boot payload omits', () => {
		expect(getBootFieldData(UNSTUBBED_BOOT_FIELD, 'absent')).toBe('absent')
	})

	it('returns undefined for an omitted field when no fallback is supplied', () => {
		expect(getBootFieldData(UNSTUBBED_BOOT_FIELD)).toBeUndefined()
	})
})

describe('the boot readers with no Desk boot payload at all', () => {
	/* Capture and restore `window.frappe` because jsdom exposes it through `globalThis` as well. */
	const harnessFrappe = window.frappe

	afterEach(() => {
		window.frappe = harnessFrappe
	})

	it('short-circuits to the supplied fallback for all three readers', () => {
		window.frappe = undefined

		expect(getSystemDefault('currency', 'USD')).toBe('USD')
		expect(getUserDefault('company', 'Fallback Company')).toBe('Fallback Company')
		expect(getBootFieldData('lang', 'fr')).toBe('fr')
	})

	it('short-circuits to undefined for all three readers when no fallback is supplied', () => {
		window.frappe = undefined

		expect(getSystemDefault('currency')).toBeUndefined()
		expect(getUserDefault('company')).toBeUndefined()
		expect(getBootFieldData('lang')).toBeUndefined()
	})

	it('leaves the harness intact for the tests that follow', () => {
		expect(getSystemDefault('currency')).toBe('INR')
		expect(getUserDefault('company')).toBe('Test Company')
		expect(getBootFieldData('lang')).toBe('en')
	})
})
