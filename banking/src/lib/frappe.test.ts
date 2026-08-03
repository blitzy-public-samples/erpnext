import { describe, expect, it } from 'vitest'
import {
	makeColonlessExceptionError,
	makeErrorMessageError,
	makeExceptionError,
	makeFrappeError,
	makeLeadingColonExceptionError,
	makeMessageOnlyError,
	makeServerMessagesError,
	makeWarningServerMessagesError,
	TEST_COMPANY,
	TEST_CURRENCY,
	TEST_USER
} from '@/test/factories'

import {
	getBootFieldData,
	getErrorMessage,
	getErrorMessages,
	getSystemDefault,
	getUserDefault,
	scrub,
	slug,
	unscrub
} from './frappe'

/**
 * The error-parsing boundary EVERY surface that shows a rejected call resolves through: the
 * dismissible dialog, the inline banners and the transient toasts all render whatever this returns.
 *
 * Its whole job is to get the SERVER'S OWN WORDING in front of the user unaltered, which is why the
 * cases below are organised by the shape the server actually sends rather than by branch coverage.
 * Frappe's `_server_messages` is DOUBLE-ENCODED - a JSON array whose elements are themselves JSON
 * strings - and the fallback chain behind it (`_error_message`, then `exception`, then `message`)
 * decides what a reviewer reads when a response carries no messages at all.
 */
describe('getErrorMessages', () => {

	it('returns nothing at all for no error', () => {
		expect(getErrorMessages(undefined)).toEqual([])
		expect(getErrorMessages(null)).toEqual([])
	})

	// The normal server path. Each element of `_server_messages` is itself a JSON string, so the
	// parser has to decode twice; a single decode would leave the message as raw JSON text.
	it('decodes the double-encoded server-messages envelope', () => {
		const messages = getErrorMessages(makeServerMessagesError('Bank Transaction ACC-BTN-0001 is already fully reconciled'))

		expect(messages).toHaveLength(1)
		expect(messages[0].message).toBe('Bank Transaction ACC-BTN-0001 is already fully reconciled')
		expect(messages[0].title).toBeDefined()
	})

	// The server's own severity survives, because the banner picks amber versus red from it. A
	// client that dropped `indicator` would render every server warning as an error.
	it('preserves the server\'s own severity indicator', () => {
		const [warning] = getErrorMessages(makeWarningServerMessagesError('This statement overlaps an existing import'))

		expect(warning.message).toBe('This statement overlaps an existing import')
		// `yellow` is the server's own value, and the banner themes amber on exactly that string.
		expect(warning.indicator).toBe('yellow')
	})

	// Frappe transmits several messages as several elements of the same double-encoded array, and
	// every one of them belongs on screen: the second is often the one naming what to do about the
	// first.
	it('keeps every message when the server sends several', () => {
		const messages = getErrorMessages(makeFrappeError({
			_server_messages: JSON.stringify([
				JSON.stringify({ message: 'Voucher PE-0001 is over-allocated by 250.00', title: 'Message', indicator: 'red' }),
				JSON.stringify({ message: 'Bank Transaction ACC-BTN-0002 is already fully reconciled', title: 'Message', indicator: 'red' })
			])
		}))

		expect(messages.map((m) => m.message)).toEqual([
			'Voucher PE-0001 is over-allocated by 250.00',
			'Bank Transaction ACC-BTN-0002 is already fully reconciled'
		])
	})

	/*
	 * Not every element is JSON. Frappe writes plain strings into `_server_messages` in places, so
	 * the per-element decode is wrapped in a try/catch and the raw string is kept. Losing this would
	 * turn a readable server message into nothing at all.
	 */
	it('keeps a plain-string element that is not itself JSON', () => {
		const messages = getErrorMessages(makeFrappeError({
			_server_messages: JSON.stringify(['Something went wrong on the server'])
		}))

		expect(messages).toEqual(['Something went wrong on the server'])
	})

	// The second rung of the chain.
	it('falls back to the single error-message field', () => {
		const messages = getErrorMessages(makeErrorMessageError('Bank account is disabled. Please enable it.'))

		expect(messages).toHaveLength(1)
		expect(messages[0].message).toBe('Bank account is disabled. Please enable it.')
		expect(messages[0].indicator).toBe('red')
	})

	/*
	 * The third rung strips the exception TYPE, so the user reads "Bank account not found" rather
	 * than "frappe.exceptions.ValidationError: Bank account not found".
	 */
	it('strips the exception type and keeps the human part', () => {
		const [message] = getErrorMessages(makeExceptionError('Bank account not found'))

		expect(message.message.trim()).toBe('Bank account not found')
		expect(message.message).not.toContain('ValidationError')
	})

	/*
	 * A known edge in the existing implementation, pinned rather than "fixed": the colon test is a
	 * TRUTHINESS test, so a colon at index 0 is indistinguishable from no colon at all and the chain
	 * falls through to `message`. Recorded because the behaviour is observable and any future change
	 * to it should be a deliberate one.
	 */
	it('falls through to the plain message when the exception begins with a colon', () => {
		const [message] = getErrorMessages(makeLeadingColonExceptionError('leading colon text'))

		expect(message.message).toBe('Bare message reached because the colon sits at index zero')
	})

	/*
	 * PATH 3, the other quirk: `indexOf(':')` returns `-1`, which IS truthy, so the slice starts at
	 * index 0 and the whole exception string survives rather than being discarded. Pinned because it
	 * is the behaviour a user sees, and because the two quirks pull in opposite directions.
	 */
	it('keeps the whole exception string when it carries no colon at all', () => {
		const [message] = getErrorMessages(makeColonlessExceptionError('SomethingBrokeWithoutAColon'))

		expect(message.message).toBe('SomethingBrokeWithoutAColon')
	})

	// The last rung. A transport failure reaches here, and it is the only text there is.
	it('falls back to the bare message as a last resort', () => {
		const [message] = getErrorMessages(makeMessageOnlyError('Network Error'))

		expect(message.message).toBe('Network Error')
		expect(message.indicator).toBe('red')
	})
})

describe('getErrorMessage', () => {

	it('is the empty string when there is no error', () => {
		expect(getErrorMessage(undefined)).toBe('')
	})

	it('joins several server messages with newlines, preserving order and wording', () => {
		const error = makeFrappeError({
			_server_messages: JSON.stringify([
				JSON.stringify({ message: 'first problem', title: 'Message', indicator: 'red' }),
				JSON.stringify({ message: 'second problem', title: 'Message', indicator: 'red' })
			])
		})

		expect(getErrorMessage(error)).toBe('first problem\nsecond problem')
	})

	// Toasts and the dialog must never disagree, which they cannot while both resolve through here.
	it('reads the same text the structured parser produced', () => {
		const error = makeServerMessagesError('Transaction currency: USD cannot be different from Bank Account currency: INR')

		expect(getErrorMessage(error)).toBe(getErrorMessages(error).map((m) => m.message).join('\n'))
	})
})

/**
 * The name helpers. Small, but every one of them is on a path that builds a URL or a label, so a
 * regression shows up as a broken link rather than as a test failure somewhere.
 */
describe('name helpers', () => {

	it('slugs a document name for a URL', () => {
		expect(slug('Bank Statement Import Log')).toBe('bank-statement-import-log')
	})

	it('answers the empty string rather than throwing on nothing', () => {
		expect(slug(undefined)).toBe('')
		expect(scrub(undefined)).toBe('')
		expect(unscrub(undefined)).toBe('')
	})

	it('scrubs a label into a field name', () => {
		expect(scrub('Bank Account')).toBe('bank_account')
	})

	it('unscrubs a field name back into a title-cased label', () => {
		expect(unscrub('bank_account')).toBe('Bank Account')
		expect(unscrub('matched-transaction-rule')).toBe('Matched Transaction Rule')
	})
})

/**
 * The boot readers. These are the seam between the application and the Desk runtime the host page
 * injects, and the fallback argument is what keeps a missing key from becoming `undefined` deep
 * inside a formatter.
 */
describe('boot readers', () => {

	it('reads a system default the host page injected', () => {
		expect(getSystemDefault('currency')).toBe(TEST_CURRENCY)
	})

	it('reads a user default the host page injected', () => {
		expect(getUserDefault('company')).toBe(TEST_COMPANY)
	})

	it('reads a top-level boot field', () => {
		expect(getBootFieldData('sitename')).toBeDefined()
		expect(window.frappe.boot.user.name).toBe(TEST_USER)
	})

	it('returns the supplied fallback for a key the boot payload does not carry', () => {
		expect(getSystemDefault('no_such_default', 'fallback')).toBe('fallback')
		expect(getUserDefault('no_such_default', 'fallback')).toBe('fallback')
		expect(getBootFieldData('no_such_field', 'fallback')).toBe('fallback')
	})

	it('is undefined, not an exception, for a missing key with no fallback', () => {
		expect(getSystemDefault('no_such_default')).toBeUndefined()
		expect(getUserDefault('no_such_default')).toBeUndefined()
		expect(getBootFieldData('no_such_field')).toBeUndefined()
	})
})
