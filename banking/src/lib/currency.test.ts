import { afterEach, describe, expect, it } from 'vitest'
import { TEST_ALTERNATE_CURRENCY, TEST_CURRENCY } from '@/test/factories'

import { getCurrencyNumberFormat, getCurrencyProperty, getCurrencySymbol } from './currency'

/** The Desk `sysdefaults` object the host page injects; mutated only by the tests that need to. */
const sysdefaults = () => window.frappe.boot.sysdefaults as Record<string, string>

/**
 * The currency readers, which resolve a symbol and a number format out of `locals[':Currency']`.
 *
 * Every monetary figure on the reconciliation workbench and the importer passes through here, so the
 * behaviours worth pinning are the ones that change what a reviewer reads about money: the site-wide
 * "hide the symbol" setting, the fallback to the system default currency when a caller has none, and
 * - most of all - what happens for a currency the boot payload does not know, where returning the
 * CODE is meaningfully better than returning nothing at all.
 */
describe('getCurrencySymbol', () => {

	afterEach(() => {
		// The harness resets the boot payload between tests, but these tests mutate it directly, so
		// the value is restored explicitly rather than relying on ordering.
		sysdefaults().hide_currency_symbol = 'No'
	})

	it('reads the symbol of a currency in the boot payload', () => {
		expect(getCurrencySymbol(TEST_CURRENCY)).toBe('₹')
	})

	it('reads the symbol of a second currency, which is what makes a mismatch visible', () => {
		expect(getCurrencySymbol(TEST_ALTERNATE_CURRENCY)).toBe('$')
	})

	/*
	 * The site-wide setting, compared against the literal string "Yes" - not a boolean. A truthiness
	 * test here would hide the symbol for the "No" case too.
	 */
	it('returns nothing at all when the site hides currency symbols', () => {
		sysdefaults().hide_currency_symbol = 'Yes'

		expect(getCurrencySymbol(TEST_CURRENCY)).toBe('')
		expect(getCurrencySymbol(TEST_ALTERNATE_CURRENCY)).toBe('')
	})

	it('does not hide the symbol for any other value of that setting', () => {
		sysdefaults().hide_currency_symbol = 'No'

		expect(getCurrencySymbol(TEST_CURRENCY)).toBe('₹')
	})

	// Callers routinely have no currency to hand - a bank account with no derived currency, a
	// transaction row before its account resolves - so the system default stands in.
	it('falls back to the system default currency when the caller has none', () => {
		expect(getCurrencySymbol('')).toBe('₹')
	})

	/*
	 * The unknown-currency case. Returning the CODE is the deliberate behaviour: a figure labelled
	 * "AED 1,200.00" is honest and readable, whereas an empty label would make the amount look like
	 * it were in the site's own currency - which on a reconciliation screen is the dangerous
	 * direction to be wrong in.
	 */
	it('falls back to the currency CODE for a currency the boot payload does not carry', () => {
		expect(getCurrencySymbol('AED')).toBe('AED')
	})
})

describe('getCurrencyNumberFormat', () => {

	it('reads the number format of a known currency', () => {
		expect(getCurrencyNumberFormat(TEST_CURRENCY)).toBe(sysdefaults().number_format)
	})

	it('is undefined rather than throwing for an unknown currency', () => {
		expect(() => getCurrencyNumberFormat('AED')).not.toThrow()
		expect(getCurrencyNumberFormat('AED')).toBeUndefined()
	})
})

describe('getCurrencyProperty', () => {

	it('reads each of the three properties the type permits', () => {
		expect(getCurrencyProperty(TEST_CURRENCY, 'symbol')).toBe('₹')
		expect(getCurrencyProperty(TEST_CURRENCY, 'symbol_on_right')).toBe(0)
		expect(getCurrencyProperty(TEST_CURRENCY, 'number_format')).toBeDefined()
	})

	// `symbol_on_right` is read as a truthiness test by the formatter, so a falsy 0 must survive as
	// 0 rather than being coerced or defaulted - it is what keeps the symbol on the left.
	it('preserves a falsy property value instead of defaulting it', () => {
		expect(getCurrencyProperty(TEST_CURRENCY, 'symbol_on_right')).toBe(0)
		expect(getCurrencyProperty(TEST_ALTERNATE_CURRENCY, 'symbol_on_right')).toBe(0)
	})

	it('is undefined rather than throwing for an unknown currency', () => {
		expect(() => getCurrencyProperty('AED', 'symbol')).not.toThrow()
		expect(getCurrencyProperty('AED', 'symbol')).toBeUndefined()
	})

	it('is undefined rather than throwing for an empty currency name', () => {
		expect(() => getCurrencyProperty('', 'symbol')).not.toThrow()
		expect(getCurrencyProperty('', 'symbol')).toBeUndefined()
	})
})
