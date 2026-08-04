/*
 * `lib/frappe.ts` is the only path a backend refusal takes to the user, so the server's wording has to
 * survive the parse unaltered: getting it wrong silently changes what a reviewer is told about a
 * rejected posting. This suite therefore specifies what the parser DOES, not what it ideally would.
 *
 * Five branches behave in ways the source does not telegraph. Three are pinned below under a QUIRK
 * label - the colon-slice step guards on TRUTHINESS, so a colon at index 0 is skipped; `indexOf(':')`
 * returning -1 is truthy, so a colon-less exception survives whole; and `_error_message` is APPENDED to
 * the parsed messages rather than substituted for them.
 *
 * The other two are specified as LIMITS in the `parsed UNGUARDED` block below, because they bound what
 * a caller may assume: the outer `JSON.parse` of `_server_messages` is unguarded, so a body that is
 * not a JSON array throws out of the parser; and a SINGLY encoded element survives as a bare string
 * with no `message` property, which also suppresses the `_error_message` -> `exception` -> `message`
 * fallback, since that chain is gated on the parsed array being empty.
 *
 * Two conventions this file is obliged to follow: the parsed-message interface is private to
 * `frappe.ts`, so assertions here are structural rather than typed against it; and no ambient global is
 * declared, because the live `ts-expect-error` directives across `src/` depend on the bare `frappe` and
 * `locals` globals staying untyped.
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
			const result = getErrorMessages(makeServerMessagesError('Duplicate reference number'))

			expect(result).toHaveLength(1)
			expect(result[0].message).toBe('Duplicate reference number')
			expect(result[0].message).not.toContain('ValidationError')
		})

	})

	/*
	 * THE ENVELOPE IS PARSED UNGUARDED - this shared parser is not total. `_server_messages` is
	 * server-controlled and only conventionally well formed, and the module parses it with a bare
	 * `JSON.parse` and then `.map`s the result, so a body that is not a JSON array throws out of
	 * `getErrorMessages` - during RENDER, in the case of `ErrorBanner`.
	 *
	 * The cases below specify that as a LIMIT rather than repairing it, so a caller knows what it is and
	 * is not entitled to assume.
	 */
	describe('the envelope is parsed UNGUARDED — specified LIMITS of the shared parser', () => {
		it('LIMIT 1: THROWS on an envelope that is not valid JSON at all', () => {
			const truncated = makeFrappeError({
				_server_messages: '[{"message":"Reconciliation refu',
				exception: 'frappe.exceptions.ValidationError: Bank Account is disabled'
			})

			expect(() => getErrorMessages(truncated)).toThrow()
		})

		it('LIMIT 1: THROWS on a NON-ARRAY envelope, because `.map` is reached on an object', () => {
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
			const result = getErrorMessages(
				makeFrappeError({
					_server_messages: JSON.stringify(['Bank Transaction is already fully reconciled'])
				})
			)

			expect(result).toStrictEqual(['Bank Transaction is already fully reconciled'])
			expect(result[0].message).toBeUndefined()
		})

		it('LIMIT 2: KEEPS an entry carrying no `message`, which suppresses the `exception` fallback', () => {
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
			expect(result[0].indicator).toBe('yellow')
		})

		it('treats an EMPTY array envelope as no messages, exactly as an absent one', () => {
			const result = getErrorMessages(
				makeFrappeError({ _server_messages: '[]', exception: '', message: 'Internal Server Error' })
			)

			expect(result).toStrictEqual([
				{ message: 'Internal Server Error', title: 'Error', indicator: 'red' }
			])
		})

		it('appends `_error_message` only when the envelope parsed, so an unreadable one costs it', () => {
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
			const result = getErrorMessages(makeExceptionError(FIRST_SERVER_MESSAGE))

			expect(result).toHaveLength(1)
			expect(result[0].message).toBe(` ${FIRST_SERVER_MESSAGE}`)
			expect(result[0].message).toBe(
				' Bank Transaction BT-0001 is already fully reconciled'
			)
			expect(result[0].title).toBe('Error')
		})

		it('leaves indicator UNSET on the colon-slice path, unlike every other path', () => {
			const result = getErrorMessages(makeExceptionError('Voucher is over-allocated'))

			expect(result[0].indicator).toBeUndefined()
			expect(result[0]).toStrictEqual({
				message: ' Voucher is over-allocated',
				title: 'Error'
			})
		})

		it('QUIRK 3: skips the slice when the colon sits at index 0 and falls through to message', () => {
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
			const result = getErrorMessages(makeColonlessExceptionError('NoColonHere'))

			expect(result).toStrictEqual([{ message: 'NoColonHere', title: 'Error' }])
		})
	})

	describe('path 4 — the bare message fallback', () => {
		it('falls back to message when the exception is empty, and marks it red', () => {
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
		expect(unscrub('BANK_TRANSACTION')).toBe('Bank Transaction')
	})

	it('coerces undefined and the empty string to an empty string', () => {
		expect(unscrub(undefined)).toBe('')
		expect(unscrub('')).toBe('')
	})
})


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
		expect(getSystemDefault('link_field_results_limit')).toBe('10')
	})

	it('returns the supplied fallback for a key the site does not define', () => {
		expect(getSystemDefault(UNSTUBBED_SYSTEM_DEFAULT, '2024-2025')).toBe('2024-2025')
	})

	it('returns undefined for an unknown key when no fallback is supplied', () => {
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
