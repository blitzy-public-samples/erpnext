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
 * The numbering starts at 3 deliberately. Two further quirks used to be documented here and are
 * now FIXED rather than pinned, because each was a way for malformed server data to deny the
 * reviewer the refusal they were owed - the opposite of what this module exists to do:
 *
 *   was QUIRK 1  An element of `_server_messages` that is not itself valid JSON was returned
 *                UNCHANGED, as a bare `string` with no `.message`. Every consumer reads
 *                `.message` off each entry, so such an entry rendered as NOTHING: an empty
 *                banner where a backend refusal should have been. It is now normalised into a
 *                red `Error` entry that keeps the text (`frappe.ts:86-98`).
 *   was QUIRK 2  A truthy but unparseable `_server_messages` threw an uncaught `SyntaxError`
 *                out of `getErrorMessages`. Nothing under `src/` is an error boundary, so that
 *                throw propagated into the render of whichever surface was reporting the
 *                rejection - suppressing the dismissible dialog FM1 requires. The outer parse is
 *                now guarded and the raw envelope is kept as the message text
 *                (`frappe.ts:114-126`).
 *
 * Both replacements are asserted below under `the malformed-envelope guard`, which is what stops
 * either behaviour returning.
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
 * whose elements are themselves JSON strings. `frappe.ts:114-126` parses the outer array and
 * `:86-98` normalises each element, so anything singly encoded arrives as a raw string and is
 * degraded into a red `Error` entry that keeps its text rather than staying a bare string.
 */
const encodeServerMessages = (...messages: ServerMessagePayload[]): string =>
	JSON.stringify(messages.map((message) => JSON.stringify(message)))

const FIRST_SERVER_MESSAGE = 'Bank Transaction BT-0001 is already fully reconciled'
const SECOND_SERVER_MESSAGE = 'Second msg'

const TWO_MESSAGE_ENVELOPE = encodeServerMessages(
	{ message: FIRST_SERVER_MESSAGE, title: 'Message', indicator: 'red' },
	{ message: SECOND_SERVER_MESSAGE, title: 'Message', indicator: 'yellow' }
)

const RAW_STRING_MESSAGE = 'just a plain string not json'
const SINGLY_ENCODED_ENVELOPE = JSON.stringify([RAW_STRING_MESSAGE])

/** Not JSON at all — the shape that used to reach an UNGUARDED `JSON.parse` and throw. */
const UNPARSEABLE_ENVELOPE = 'this is not json'

/**
 * A well-formed message object sent WITHOUT the array wrapper. Frappe wraps, but a proxy or a
 * differently-versioned app need not, and a lone object has no `.length` to iterate.
 */
const NON_ARRAY_ENVELOPE = JSON.stringify({
	message: 'Reconciliation refused by the server',
	title: 'Message',
	indicator: 'red'
})

/**
 * A double-encoded entry that parses cleanly but carries no `message` at all. Every consumer
 * reads `.message` off each entry, so an entry like this renders as nothing unless normalised.
 */
const MESSAGELESS_ENTRY_ENVELOPE = JSON.stringify([JSON.stringify({ title: 'Message', indicator: 'red' })])

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

	/**
	 * THE MALFORMED-ENVELOPE GUARD.
	 *
	 * This module is the single path by which every backend refusal reaches the user, and NOTHING
	 * under `src/` is a React error boundary. That combination is what makes the shapes below a
	 * security concern rather than a curiosity: server error data the client cannot parse must
	 * never be able to (a) throw into the render of the surface that is trying to report a
	 * rejection, suppressing the dismissible dialog FM1 requires, or (b) degrade into an entry
	 * with no `.message`, which every consumer renders as nothing at all — an empty banner where
	 * a refusal should have been.
	 *
	 * So each case asserts the same two properties: the call RETURNS rather than throws, and what
	 * it returns is a valid `{ message, title?, indicator? }` entry that still carries useful
	 * text. Severity falls to red, because a message the client could not parse is not one whose
	 * severity the server can be said to have chosen.
	 */
	describe('the malformed-envelope guard', () => {

		it('normalises an element that is not valid JSON instead of leaving it a bare string', () => {
			/* A singly encoded element: valid JSON at the array level, not valid JSON as an
			 * element. It used to be returned UNCHANGED — a `string`, not an object — so
			 * `messages.map(m => m.message)` produced `[undefined]` and the banner rendered an
			 * empty description. The text now survives inside a real entry. */
			const result = getErrorMessages(
				makeFrappeError({ _server_messages: SINGLY_ENCODED_ENVELOPE })
			)

			expect(result).toStrictEqual([
				{ message: RAW_STRING_MESSAGE, title: 'Error', indicator: 'red' }
			])
		})

		it('reports an unparseable envelope as a message instead of throwing', () => {
			const malformed = makeFrappeError({ _server_messages: UNPARSEABLE_ENVELOPE })

			expect(() => getErrorMessages(malformed)).not.toThrow()
			/* The raw envelope IS the only text there is, so it is what the reviewer is shown —
			 * unusual to read, but never lost and never fatal. */
			expect(getErrorMessages(malformed)).toStrictEqual([
				{ message: UNPARSEABLE_ENVELOPE, title: 'Error', indicator: 'red' }
			])
		})

		it('accepts a single message object sent without the array wrapper', () => {
			/* A lone object has no `.length` and no elements, so the pre-guard parser produced an
			 * empty result for it and fell through to `message`. Wrapping it means the two
			 * encodings resolve identically — and, because the entry is well formed, it is passed
			 * through BY IDENTITY with the server's own title and severity intact. */
			const result = getErrorMessages(
				makeFrappeError({ _server_messages: NON_ARRAY_ENVELOPE })
			)

			expect(result).toStrictEqual([
				{
					message: 'Reconciliation refused by the server',
					title: 'Message',
					indicator: 'red'
				}
			])
		})

		it('keeps the text of an entry that parses but carries no message field', () => {
			/* Renderable-ness is decided by the presence of a non-blank string `message`, not by
			 * the parse succeeding. Without that distinction this entry reaches the banner and
			 * renders nothing, while the reviewer is told there was an error. */
			const result = getErrorMessages(
				makeFrappeError({ _server_messages: MESSAGELESS_ENTRY_ENVELOPE })
			)

			expect(result).toHaveLength(1)
			expect(result[0].message).toContain('indicator')
			expect(result[0].title).toBe('Error')
			expect(result[0].indicator).toBe('red')
		})

		it('falls through to the remaining paths when the envelope carries no text at all', () => {
			/* An empty array, and an entry that is only whitespace, are both "no message" rather
			 * than "an empty message" — so resolution must continue to `_error_message`, then
			 * `exception`, then `message`, exactly as it would for an error with no envelope.
			 * Reporting a blank entry here would have hidden the text those paths do have. */
			expect(
				getErrorMessages(
					makeFrappeError({ _server_messages: '[]', _error_message: APPENDED_ERROR_MESSAGE })
				)
			).toStrictEqual([
				{ message: APPENDED_ERROR_MESSAGE, title: 'Error', indicator: 'red' }
			])

			expect(
				getErrorMessages(
					makeFrappeError({
						_server_messages: JSON.stringify([JSON.stringify('   ')]),
						message: 'Internal Server Error'
					})
				)
			).toStrictEqual([
				{ message: 'Internal Server Error', title: 'Error', indicator: 'red' }
			])
		})

		it('survives every other unparseable shape a response could carry', () => {
			/* Blanket proof that no `_server_messages` value can raise out of this function.
			 * Each shape is a real possibility — a truncated array, a bare number, a nested
			 * array, a JSON `null` — and none of them may cost the reviewer their refusal. */
			const shapes = ['[', '["unterminated', '42', 'null', '[[]]', '{"message":}', '["a",']

			shapes.forEach((serverMessages) => {
				const error = makeFrappeError({ _server_messages: serverMessages })

				expect(() => getErrorMessages(error)).not.toThrow()

				// Whatever comes back is renderable: a non-blank string message on every entry.
				getErrorMessages(error).forEach((parsed) => {
					expect(typeof parsed.message).toBe('string')
					expect(parsed.message.trim()).not.toBe('')
				})
			})
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

	it('reports the text of a malformed entry rather than an empty string', () => {
		/* The downstream consequence of the malformed-envelope guard, asserted at the call site
		 * most consumers actually use. Before the guard, a singly encoded element stayed a bare
		 * `string`; the `map` at `frappe.ts:12` then produced `[undefined]` and `join` rendered it
		 * as an EMPTY STRING — so `toast.error(getErrorMessage(error))` raised a toast with no
		 * text in it, which is indistinguishable from the call having succeeded. */
		expect(getErrorMessage(makeFrappeError({ _server_messages: SINGLY_ENCODED_ENVELOPE })))
			.toBe(RAW_STRING_MESSAGE)
	})

	it('never returns an empty string for an error that carries text somewhere', () => {
		/* The property that matters at every toast call site: an error object always yields
		 * something to read. Each shape below reaches a DIFFERENT branch — malformed envelope,
		 * appended fallback field, exception-only, message-only — and none of them may resolve to
		 * nothing. */
		expect(getErrorMessage(makeFrappeError({ _server_messages: UNPARSEABLE_ENVELOPE })))
			.toBe(UNPARSEABLE_ENVELOPE)
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
