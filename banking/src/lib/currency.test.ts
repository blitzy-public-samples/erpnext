/**
 * Behavioural specification for `src/lib/currency.ts` - the three readers that resolve a currency's
 * symbol and number format out of the Desk runtime the host page injects.
 *
 * Every monetary figure a reviewer reads on the reconciliation workbench and the statement importer is
 * labelled through this module, so a wrong answer mislabels an amount on a screen whose entire purpose
 * is deciding whether two amounts are the same money. The argument may legitimately be empty or
 * `undefined`, because callers build it from a system default or a company lookup whose miss is
 * `undefined`, and both arrive on the workbench's first paint.
 *
 * Four behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *   1. the suppression setting is compared with a LOOSE `==` against the string `"Yes"`, so it is
 *      neither a boolean nor a truthiness test;
 *   2. the system-default fallback reads `frappe.boot.sysdefaults.currency` WITHOUT optional chaining,
 *      so an absent `sysdefaults` is a `TypeError` rather than a fallback;
 *   3. a currency the document cache does not carry resolves to the CODE rather than to nothing;
 *   4. the two return branches are not equivalent, because only one is preceded by the fallback.
 *
 * Reaching the globals: `currency.ts` reads the BARE `frappe` and `locals`, and this file introduces no
 * ambient declaration for either, because the live `ts-expect-error` directives across `src/` depend on
 * them staying untyped. Under jsdom `window === globalThis`, so writing through `window.frappe` reaches
 * the same property the module reads, while `locals` is reached through the same untyped `globalThis`
 * cast the harness uses.
 *
 * `frappe.boot` is FALSIFIED, never removed, and `locals` is REPLACED, never deleted: the module
 * evaluates `if (frappe.boot)` on the bare identifier and indexes `locals` at the root un-chained, so
 * removing either binding would throw and the assertion would be about the harness. Every mutation
 * captures what it displaces FIRST and restores it unconditionally in the narrowest `describe` that
 * needs it, so the suite stays order-independent and cannot leak into `company.test.ts`, which reads the
 * same document cache.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getCurrencyNumberFormat, getCurrencyProperty, getCurrencySymbol } from '@/lib/currency'


const TEST_CURRENCY = 'INR'

const EXPECTED_SYMBOL = '₹'

const ALTERNATE_CURRENCY = 'USD'

const EXPECTED_ALTERNATE_SYMBOL = '$'

const EXPECTED_NUMBER_FORMAT = '#,###.##'

const UNKNOWN_CURRENCY = 'XXX'

const SYMBOLS_HIDDEN = 'Yes'

const SYMBOLS_SHOWN = 'No'

/* Both captures happen at module load, before any test in this file can reassign them, so restoring the
 * captured reference restores the very object the harness installed rather than a payload reconstructed
 * here that could silently diverge from it. */

const globalScope = globalThis as unknown as Record<string, unknown>

const INSTALLED_LOCALS = globalScope.locals

const INSTALLED_BOOT = window.frappe.boot

describe('getCurrencySymbol', () => {

	/*
	 * BRANCH 1 of 4 - the site-wide suppression setting. Only the literal string "Yes" suppresses currency
	 * symbols, and the harness value "No" must not: a truthiness test in its place would suppress the
	 * symbol for "No" as well, so both sides are asserted.
	 */
	describe('when the site hides currency symbols', () => {

		/** Capture the current setting per test so this block can restore its own mutation. */
		let installedSuppressionSetting: unknown

		beforeEach(() => {
			installedSuppressionSetting = window.frappe.boot.sysdefaults.hide_currency_symbol
		})

		afterEach(() => {
			window.frappe.boot.sysdefaults.hide_currency_symbol = installedSuppressionSetting
		})

		it('returns the empty string for currencies that DO have a symbol', () => {
			window.frappe.boot.sysdefaults.hide_currency_symbol = SYMBOLS_HIDDEN

			expect(getCurrencySymbol(TEST_CURRENCY)).toBe('')
			expect(getCurrencySymbol(ALTERNATE_CURRENCY)).toBe('')
		})

		it('suppresses the symbol before the system-default fallback can substitute one', () => {
			window.frappe.boot.sysdefaults.hide_currency_symbol = SYMBOLS_HIDDEN

			expect(getCurrencySymbol('')).toBe('')
		})

		it('suppresses the code echo too, so an unknown currency yields nothing either', () => {
			window.frappe.boot.sysdefaults.hide_currency_symbol = SYMBOLS_HIDDEN

			expect(getCurrencySymbol(UNKNOWN_CURRENCY)).toBe('')
		})

		it('does not suppress anything for the "No" the boot payload actually carries', () => {
			expect(window.frappe.boot.sysdefaults.hide_currency_symbol).toBe(SYMBOLS_SHOWN)

			expect(getCurrencySymbol(TEST_CURRENCY)).toBe(EXPECTED_SYMBOL)
		})
	})

	describe('when the caller has no currency to pass', () => {

		it('substitutes the system default currency named in the boot payload', () => {
			expect(window.frappe.boot.sysdefaults.currency).toBe(TEST_CURRENCY)

			expect(getCurrencySymbol('')).toBe(EXPECTED_SYMBOL)
		})
	})

	describe('when the boot payload is present', () => {

		it('resolves the symbol of a currency the document cache carries', () => {
			expect(getCurrencySymbol(TEST_CURRENCY)).toBe(EXPECTED_SYMBOL)
		})

		it('resolves a second currency distinctly, which is what makes a mismatch visible', () => {
			expect(getCurrencySymbol(ALTERNATE_CURRENCY)).toBe(EXPECTED_ALTERNATE_SYMBOL)
		})

		it('echoes the currency CODE verbatim for a currency the cache does not carry', () => {
			expect(getCurrencySymbol(UNKNOWN_CURRENCY)).toBe(UNKNOWN_CURRENCY)
		})
	})

	describe('when the boot payload is absent', () => {

		afterEach(() => {
			window.frappe.boot = INSTALLED_BOOT
		})

		it('still resolves a known symbol, because the document cache is independent of boot', () => {
			window.frappe.boot = undefined

			expect(getCurrencySymbol(TEST_CURRENCY)).toBe(EXPECTED_SYMBOL)
			expect(getCurrencySymbol(ALTERNATE_CURRENCY)).toBe(EXPECTED_ALTERNATE_SYMBOL)
		})

		it('still echoes the currency code for a currency the cache does not carry', () => {
			window.frappe.boot = undefined

			expect(getCurrencySymbol(UNKNOWN_CURRENCY)).toBe(UNKNOWN_CURRENCY)
		})

		it('has no system-default fallback here, so an empty argument returns the empty string', () => {
			window.frappe.boot = undefined

			expect(getCurrencySymbol('')).toBe('')
		})

		it('resolves rather than throwing, even though boot is gone', () => {
			window.frappe.boot = undefined

			expect(() => getCurrencySymbol(TEST_CURRENCY)).not.toThrow()
		})
	})

	/*
	 * QUIRK 2 - the un-optional-chained fallback. `frappe.boot.sysdefaults.currency` is read with no guard
	 * of its own; the only test in front of it guards the SUPPRESSION comparison instead. So with
	 * `sysdefaults` absent the module divides sharply: a named currency still resolves, and an empty
	 * argument throws. Pinning the throw records the real contract rather than wishing the read were
	 * chained.
	 */
	describe('when the boot payload carries no system defaults at all', () => {

		let installedSysdefaults: unknown

		beforeEach(() => {
			installedSysdefaults = window.frappe.boot.sysdefaults
		})

		afterEach(() => {
			window.frappe.boot.sysdefaults = installedSysdefaults
		})

		it('still resolves a named currency, because line 5 guards only the suppression test', () => {
			window.frappe.boot.sysdefaults = undefined

			expect(getCurrencySymbol(TEST_CURRENCY)).toBe(EXPECTED_SYMBOL)
			expect(getCurrencySymbol(UNKNOWN_CURRENCY)).toBe(UNKNOWN_CURRENCY)
		})

		it('throws for an empty argument, because the fallback reads sysdefaults unguarded', () => {
			window.frappe.boot.sysdefaults = undefined

			expect(() => getCurrencySymbol('')).toThrow(TypeError)
		})
	})
})

describe('getCurrencyNumberFormat', () => {

	it('reads the number format stamped on a currency the document cache carries', () => {
		expect(getCurrencyNumberFormat(TEST_CURRENCY)).toBe(EXPECTED_NUMBER_FORMAT)
	})

	it('reads it per currency rather than once for the whole site', () => {
		expect(getCurrencyNumberFormat(ALTERNATE_CURRENCY)).toBe(EXPECTED_NUMBER_FORMAT)
	})

	it('answers an unknown currency with undefined instead of echoing the code', () => {
		expect(() => getCurrencyNumberFormat(UNKNOWN_CURRENCY)).not.toThrow()
		expect(getCurrencyNumberFormat(UNKNOWN_CURRENCY)).toBeUndefined()
	})

	it('answers the empty currency argument with undefined, applying no fallback', () => {
		expect(() => getCurrencyNumberFormat('')).not.toThrow()
		expect(getCurrencyNumberFormat('')).toBeUndefined()
	})
})

describe('getCurrencyProperty', () => {

	it('reads the symbol of a currency the document cache carries', () => {
		expect(getCurrencyProperty(TEST_CURRENCY, 'symbol')).toBe(EXPECTED_SYMBOL)
	})

	it('reads the number format of that same currency', () => {
		expect(getCurrencyProperty(TEST_CURRENCY, 'number_format')).toBe(EXPECTED_NUMBER_FORMAT)
	})

	/*
	 * QUIRK - `symbol_on_right` is the NUMBER 0, which is FALSY, and it must survive as 0 rather than
	 * being coerced or defaulted. The literal is written inline and the matcher is an identity matcher on
	 * purpose: a truthiness matcher would pass just as happily for `undefined`, `false` or `''`, and
	 * `numbers.ts` distinguishes exactly those cases when it decides which side of the amount the symbol
	 * goes on.
	 */
	it('preserves the falsy NUMBER 0 for symbol_on_right rather than defaulting it', () => {
		expect(getCurrencyProperty(TEST_CURRENCY, 'symbol_on_right')).toBe(0)
		expect(getCurrencyProperty(ALTERNATE_CURRENCY, 'symbol_on_right')).toBe(0)
	})

	it('is keyed per currency, so the second currency answers with its own symbol', () => {
		expect(getCurrencyProperty(ALTERNATE_CURRENCY, 'symbol')).toBe(EXPECTED_ALTERNATE_SYMBOL)
		expect(getCurrencyProperty(ALTERNATE_CURRENCY, 'number_format')).toBe(EXPECTED_NUMBER_FORMAT)
	})

	it('answers a currency outside the document cache with undefined instead of throwing', () => {
		expect(() => getCurrencyProperty(UNKNOWN_CURRENCY, 'symbol')).not.toThrow()
		expect(getCurrencyProperty(UNKNOWN_CURRENCY, 'symbol')).toBeUndefined()
		expect(getCurrencyProperty(UNKNOWN_CURRENCY, 'number_format')).toBeUndefined()
		expect(getCurrencyProperty(UNKNOWN_CURRENCY, 'symbol_on_right')).toBeUndefined()
	})

	it('answers the empty currency name with undefined instead of throwing', () => {
		expect(() => getCurrencyProperty('', 'symbol')).not.toThrow()
		expect(getCurrencyProperty('', 'symbol')).toBeUndefined()
	})

	/*
	 * The state a page reaches when the boot payload carried no currency documents at all, which exercises
	 * the guard on the `[':Currency']` key itself. The binding is REPLACED, never removed: the module
	 * indexes `locals` at the root un-chained, so an absent global would be a `ReferenceError` and the
	 * assertion would be about the harness instead of the module.
	 */
	describe('when the document cache carries no currency documents at all', () => {

		afterEach(() => {
			globalScope.locals = INSTALLED_LOCALS
		})

		it('returns undefined for a currency it would otherwise resolve', () => {
			globalScope.locals = {}

			expect(() => getCurrencyProperty(TEST_CURRENCY, 'symbol')).not.toThrow()
			expect(getCurrencyProperty(TEST_CURRENCY, 'symbol')).toBeUndefined()
		})

		it('makes getCurrencySymbol echo the code, its last line of defence', () => {
			globalScope.locals = {}

			expect(getCurrencySymbol(TEST_CURRENCY)).toBe(TEST_CURRENCY)
		})
	})
})
