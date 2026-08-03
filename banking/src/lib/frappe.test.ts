/**
 * Behavioural specification for `src/lib/frappe.ts` — the SPA's shared Frappe interop layer.
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
 * including five behaviours that are surprising on first reading. Each is labelled QUIRK and
 * pinned with an explicit assertion, so a later change that "tidies" one of them fails loudly
 * here instead of quietly altering the user-facing message:
 *
 *   QUIRK 1  An element of `_server_messages` that is not itself valid JSON is returned
 *            UNCHANGED, as a bare string, rather than wrapped in an object (`frappe.ts:23-34`).
 *   QUIRK 2  A truthy but unparseable `_server_messages` throws an uncaught `SyntaxError`
 *            straight out of `getErrorMessages` (`frappe.ts:22`).
 *   QUIRK 3  The colon-slice step guards with a TRUTHINESS test, so a colon at index 0 is
 *            skipped and resolution falls through to `message` (`frappe.ts:49`).
 *   QUIRK 4  `indexOf(':')` returning -1 is truthy, so a colon-LESS exception is sliced from
 *            index 0 and survives whole (`frappe.ts:49-50`).
 *   QUIRK 5  `_error_message` is APPENDED to the parsed server messages, never substituted
 *            for them (`frappe.ts:36-44`).
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
 *  - No ambient global is declared here. Thirteen live `ts-expect-error` directives
 *    (`lib/company.ts` 3, `lib/currency.ts` 4, `hooks/useDocType.ts` 2, `main.tsx` 4) depend on
 *    the bare `frappe` and `locals` globals staying untyped; typing either would orphan those
 *    directives and fail the build with `TS2578`.
 *  - Error envelopes come from `src/test/factories.ts`. Only the two shapes it has no named
 *    builder for — a SINGLY encoded element and an unparseable envelope — are composed here,
 *    through the base builder the factory exposes for precisely that purpose. That builder
 *    also owns the single `FrappeError` cast, so this file needs no cast of its own.
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
 * need to do. Two shapes remain, and both are composed below from the exposed base
 * builder rather than hand-rolled:
 *   - a MULTI-message envelope, required to prove server ORDER and to prove QUIRK 5's
 *     append-not-substitute behaviour;
 *   - a SINGLY encoded and an UNPARSEABLE envelope, required for QUIRKS 1 and 2. The
 *     factory's own encoder always double-encodes, so neither can come from it.
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
 * whose elements are themselves JSON strings. `frappe.ts:22` parses the outer array and
 * `:23-34` parses each element, so anything singly encoded arrives as a raw string and takes
 * the `catch` branch instead (QUIRK 1).
 */
const encodeServerMessages = (...messages: ServerMessagePayload[]): string =>
	JSON.stringify(messages.map((message) => JSON.stringify(message)))

/** The refusal a stale client actually receives from `reconcile_vouchers`. */
const FIRST_SERVER_MESSAGE = 'Bank Transaction BT-0001 is already fully reconciled'
const SECOND_SERVER_MESSAGE = 'Second msg'

/** Two messages at DIFFERENT severities, so order and severity are both observable. */
const TWO_MESSAGE_ENVELOPE = encodeServerMessages(
	{ message: FIRST_SERVER_MESSAGE, title: 'Message', indicator: 'red' },
	{ message: SECOND_SERVER_MESSAGE, title: 'Message', indicator: 'yellow' }
)

/** A singly encoded element: valid JSON at the array level, not valid JSON as an element. */
const RAW_STRING_MESSAGE = 'just a plain string not json'
const SINGLY_ENCODED_ENVELOPE = JSON.stringify([RAW_STRING_MESSAGE])

/** Not JSON at all — the shape that reaches the unguarded `JSON.parse` at `frappe.ts:22`. */
const UNPARSEABLE_ENVELOPE = 'this is not json'

const APPENDED_ERROR_MESSAGE = 'Appended error message'

describe('getErrorMessages', () => {
	describe('the empty-input guard', () => {
		/* `frappe.ts:21`. Both spellings matter: the SDK hands `undefined` before a call has
		 * failed and `null` once a caller has cleared the error, and `ErrorBanner` renders on
		 * every render pass either way. */
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
			/* The exact text of `bank_transaction.py`'s first guard. It must survive the parse
			 * unaltered, because this is the string an accountant reads when a stale client
			 * tries to post a reconciliation twice. */
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
			 * `frappe.ts:46`: the colon-slice step is guarded by `eMessages.length === 0` and
			 * is therefore unreachable while any server message parsed. */
			const result = getErrorMessages(makeServerMessagesError('Duplicate reference number'))

			expect(result).toHaveLength(1)
			expect(result[0].message).toBe('Duplicate reference number')
			expect(result[0].message).not.toContain('ValidationError')
		})

		it('QUIRK 1: returns an element that is not valid JSON unchanged, as a bare string', () => {
			/* `frappe.ts:31-33` — the `catch` branch returns `m` itself. The array element is
			 * then a `string`, NOT an object with a `.message`, which is exactly why
			 * `frappe.ts:26` needs its `ts-expect-error`. Widened to `unknown[]` so the type
			 * system records the same truth the runtime does. */
			const result: unknown[] = getErrorMessages(
				makeFrappeError({ _server_messages: SINGLY_ENCODED_ENVELOPE })
			)

			expect(result).toHaveLength(1)
			expect(result[0]).toBe(RAW_STRING_MESSAGE)
			expect(typeof result[0]).toBe('string')
		})

		it('QUIRK 2: lets a SyntaxError escape when _server_messages is unparseable', () => {
			/* `frappe.ts:22` parses the outer envelope OUTSIDE the try/catch that guards the
			 * per-element parse, so a truthy but malformed value is not degraded into a
			 * message — it propagates. Documented, deliberately not "fixed": the existing
			 * behaviour is authoritative, and callers already sit behind React error
			 * boundaries. */
			const malformed = makeFrappeError({ _server_messages: UNPARSEABLE_ENVELOPE })

			expect(() => getErrorMessages(malformed)).toThrow(SyntaxError)
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
			/* `frappe.ts:38` pushes onto the already-parsed array. Asserting the LENGTH and the
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
			/* `frappe.ts:50` slices from `indexOfFirstColon + 1`, so the space Python puts
			 * after the colon is retained. The leading space is asserted explicitly because it
			 * is genuinely present in what the user sees, and a later `.trim()` would be a
			 * behaviour change rather than a tidy-up. */
			const result = getErrorMessages(makeExceptionError(FIRST_SERVER_MESSAGE))

			expect(result).toHaveLength(1)
			expect(result[0].message).toBe(` ${FIRST_SERVER_MESSAGE}`)
			expect(result[0].message).toBe(
				' Bank Transaction BT-0001 is already fully reconciled'
			)
			expect(result[0].title).toBe('Error')
		})

		it('leaves indicator UNSET on the colon-slice path, unlike every other path', () => {
			/* `frappe.ts:52-55` builds the entry without an `indicator`, whereas paths 2 and 4
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
			/* `frappe.ts:49` guards with `if (indexOfFirstColon)`, a TRUTHINESS test rather than
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
			/* Path 4, not path 3 — proven by the indicator the colon-slice never sets. */
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
			 * so the guard passes), `''.slice(0)` is `''` (falsy, so `frappe.ts:51` skips the
			 * assignment), and the array is still empty when `frappe.ts:59` is reached. This is
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
		/* The guard's empty array joined — never the string "undefined", which would otherwise
		 * surface in a toast on the very first render. */
		expect(getErrorMessage(undefined)).toBe('')
		expect(getErrorMessage(null)).toBe('')
	})

	it('returns the bare message for a transport-failure envelope', () => {
		expect(getErrorMessage(makeMessageOnlyError('Network Error'))).toBe('Network Error')
	})

	it('QUIRK 1 downstream: yields an empty string when the only entry is a bare string', () => {
		/* Follows directly from QUIRK 1: a `string` has no `.message`, so the `map` at
		 * `frappe.ts:12` produces `[undefined]`, and `Array.prototype.join` renders `undefined`
		 * as an empty string. Pinned so the consequence of the raw-string branch is visible at
		 * the call site that most consumers actually use. */
		expect(getErrorMessage(makeFrappeError({ _server_messages: SINGLY_ENCODED_ENVELOPE })))
			.toBe('')
	})
})

describe('slug', () => {
	it('lowercases a DocType name and hyphenates spaces, as the /desk deep links require', () => {
		/* The output is interpolated straight into `/desk/${slug(doctype)}/${name}` in eight
		 * modules — for example `MatchAndReconcile.tsx:1004` and
		 * `IncorrectlyClearedEntries.tsx:125` — so these are the real inputs. */
		expect(slug('Payment Entry')).toBe('payment-entry')
		expect(slug('Journal Entry')).toBe('journal-entry')
		expect(slug('Bank Transaction')).toBe('bank-transaction')
		expect(slug('Sales Invoice')).toBe('sales-invoice')
	})

	it('returns an empty string for undefined rather than throwing', () => {
		/* `frappe.ts:72` ends in `?? ""`. Callers pass fields that are genuinely optional —
		 * `BankTransactionUnreconcileModalBody.tsx:70` passes `voucher.payment_document` — so
		 * the nullish path is reached in production, not only in tests. */
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
		/* `MatchFilters.tsx:57,63` build `id: scrub(doctype)` for the match-filter checkboxes,
		 * so the output has to be a valid, stable identifier for each voucher DocType. */
		expect(scrub('Payment Entry')).toBe('payment_entry')
		expect(scrub('Sales Invoice')).toBe('sales_invoice')
		expect(scrub('Purchase Invoice')).toBe('purchase_invoice')
		expect(scrub('Journal Entry')).toBe('journal_entry')
	})

	it('coerces undefined and the empty string to an empty string', () => {
		/* `frappe.ts:76` starts with `(txt || "")`, so BOTH falsy inputs take the same branch —
		 * asserted separately because only the nullish one is covered by a `??`-style guard. */
		expect(scrub(undefined)).toBe('')
		expect(scrub('')).toBe('')
	})

	it('replaces SPACES ONLY — a hyphen in the name survives untouched', () => {
		expect(scrub('Bank-Transaction Rule')).toBe('bank-transaction_rule')
	})
})

describe('unscrub', () => {
	/* No module under `src/` calls `unscrub` today. It is covered regardless: it is exported,
	 * it is executable, and `vitest.config.ts` includes every `src/**` module in the coverage
	 * measurement that Success Criterion 3 gates on. */

	it('turns underscores AND hyphens into spaces and title-cases every word', () => {
		expect(unscrub('bank_transaction-rule')).toBe('Bank Transaction Rule')
		expect(unscrub('payment_entry')).toBe('Payment Entry')
		expect(unscrub('a_b-c')).toBe('A B C')
	})

	it('lowercases the tail of an already upper-cased token', () => {
		/* `frappe.ts:80-82` upper-cases `charAt(0)` and lower-cases `substring(1)` for each
		 * `\w*` run, so this is a normalising title-case rather than a first-letter capitalise. */
		expect(unscrub('BANK_TRANSACTION')).toBe('Bank Transaction')
	})

	it('coerces undefined and the empty string to an empty string', () => {
		expect(unscrub(undefined)).toBe('')
		expect(unscrub('')).toBe('')
	})
})

/* ── The three boot readers ─────────────────────────────────────────────────────────
 * All three are fully optional-chained and end in `?? fallback`, so no input can make them
 * throw; the only two behaviours to pin are the HIT and the FALLBACK.
 *
 * Every expected value below is read from the values `src/test/setup.ts` actually installs,
 * which is the authority here. Note in particular that the harness DOES stub
 * `link_field_results_limit`, so that key is exercised as a hit; the fallback cases use keys
 * the harness genuinely leaves out (`fiscal_year`, `cost_center`, `user_info` — all real
 * Frappe keys, none of them stubbed).
 *
 * The fallback branch is reached WITHOUT mutating any global, which keeps these tests
 * independent of one another by construction. The one describe that does mutate
 * `window.frappe` restores it explicitly.
 * ─────────────────────────────────────────────────────────────────────────────────── */

/** A sysdefault key a real site defines but this harness does not stub. */
const UNSTUBBED_SYSTEM_DEFAULT = 'fiscal_year'
/** A user-default key a real site defines but this harness does not stub. */
const UNSTUBBED_USER_DEFAULT = 'cost_center'
/** A top-level boot key a real site publishes but this harness does not stub. */
const UNSTUBBED_BOOT_FIELD = 'user_info'

describe('getSystemDefault', () => {
	it('reads a stubbed value straight off boot.sysdefaults', () => {
		/* `frappe.ts:86`. These are the site-wide settings the number and currency formatters
		 * are built on, so a silent miss here would mis-render every monetary figure in the
		 * workbench rather than fail loudly. */
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
		/* `frappe.ts:90`. `company` is the value the whole reconciliation surface is scoped to
		 * and `date_format` is consumed unguarded by the date helpers. */
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
		/* `frappe.ts:94`. Unlike the other two readers this indexes `boot` DIRECTLY, so it
		 * reaches the session-level fields the application root is configured from —
		 * `sitename` feeds `FrappeProvider`, `desk_theme` feeds `ThemeProvider`. */
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
	/* The optional chain's short-circuit, which is what keeps the SPA from crashing outright if
	 * the host page's boot blob failed to parse. Captured at module scope: `src/test/setup.ts`
	 * installs `window.frappe` synchronously, before this file is imported, and reinstalls the
	 * SAME object identity around every test — so this is the stable value to restore to.
	 *
	 * In jsdom `window === globalThis`, so clearing `window.frappe` also clears the BARE global
	 * that `lib/currency.ts:3` reads un-chained. Nothing in this file imports that module, and
	 * the restore below runs after every test in this block, so the removal cannot outlive the
	 * test that made it. */
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
		/* Proves the restore above actually works, so a later suite cannot inherit a missing
		 * boot payload from this one. */
		expect(getSystemDefault('currency')).toBe('INR')
		expect(getUserDefault('company')).toBe('Test Company')
		expect(getBootFieldData('lang')).toBe('en')
	})
})
