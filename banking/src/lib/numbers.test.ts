/**
 * Behavioural specification for `src/lib/numbers.ts` - the module that turns every monetary figure the
 * reconciliation workbench and the statement importer display into text, and that turns every figure a
 * reviewer types back into a number.
 *
 * This is a port of Frappe's Desk number formatting, so its behaviour is dictated by the site's number
 * format, precision and rounding-method settings rather than by anything local. Nine behaviours are
 * surprising on first reading and each is pinned below under a QUIRK label:
 *
 *   1. `formatCurrency` treats EVERY falsy value as zero, so `undefined`, `null` and `0` are one case -
 *      and `NaN` is too.
 *   2. The currency symbol is placed BEFORE the minus sign, because the sign is produced inside the
 *      number formatter while the symbol is concatenated outside it.
 *   3. The `#,##,###.##` format is the Indian lakh/crore grouping: the group size changes from three to
 *      two after the first separator, so 1234567 becomes `12,34,567` rather than `1,234,567`.
 *   4. The two group-less formats declare an EMPTY decimal separator, and `get_number_format_info` then
 *      derives precision by splitting the format on that empty string - which splits it into single
 *      characters and yields a precision of 1, not 0.
 *   5. `flt` strips a currency symbol only when the string contains a space, and it decides which side
 *      the symbol is on by testing whether the FIRST token parses as a number.
 *   6. Because a space is a legitimate group separator in some formats, a space-grouped figure read
 *      under a comma-grouped format silently truncates at the space.
 *   7. `cint` strips LEADING ZEROS as characters before parsing, but exempts the single string "0".
 *   8. The rounding method is read from the site on every call, and an unrecognised one THROWS rather
 *      than falling back.
 *   9. `get_number_format_info` writes the derived precision onto the shared format table, so the
 *      returned object is a reference into module state rather than a fresh copy.
 *
 * The site settings live on `frappe.boot.sysdefaults`, which `src/test/setup.ts` provides. Where a test
 * needs a different setting it captures the displaced value FIRST and restores it unconditionally in the
 * narrowest `describe` that needs it, so the suite stays order-independent and cannot leak into
 * `currency.test.ts` or `company.test.ts`, which read the same runtime.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cint, currencyInputValueToNumber, flt, formatCurrency, getCurrencyFormatInfo, lstrip, parseCurrencyInput } from '@/lib/numbers'

const DEFAULT_CURRENCY = 'INR'
const ALTERNATE_CURRENCY = 'USD'

/** Reaches the same untyped globals the module reads. Under jsdom `window === globalThis`. */
const sysdefaults = (): Record<string, unknown> =>
	(globalThis as unknown as { frappe: { boot: { sysdefaults: Record<string, unknown> } } })
		.frappe.boot.sysdefaults

const currencyDocument = (code: string): Record<string, unknown> =>
	(globalThis as unknown as { locals: Record<string, Record<string, Record<string, unknown>>> })
		.locals[':Currency'][code]

/**
 * Replaces one site setting for the duration of a `describe`, capturing what it displaced first so the
 * restore is unconditional. Returns nothing: the caller reads the setting through the module under test.
 */
const withSysdefault = (key: string, value: unknown) => {
	let displaced: unknown

	beforeEach(() => {
		displaced = sysdefaults()[key]
		sysdefaults()[key] = value
	})

	afterEach(() => {
		sysdefaults()[key] = displaced
	})
}

describe('formatCurrency', () => {

	it('labels a figure with the symbol of the currency it was given', () => {
		expect(formatCurrency(1234.5, DEFAULT_CURRENCY)).toBe('₹ 1,234.50')
		expect(formatCurrency(1234.5, ALTERNATE_CURRENCY)).toBe('$ 1,234.50')
	})

	it("falls back to the site's own currency when none is named", () => {
		// The workbench builds the argument from a company lookup whose miss is the empty string, so
		// this is the first paint rather than an edge case.
		expect(formatCurrency(1234.5)).toBe('₹ 1,234.50')
		expect(formatCurrency(1234.5, '')).toBe('₹ 1,234.50')
	})

	it('QUIRK - renders every falsy amount as zero, not as blank', () => {
		// A zero balance and an unknown balance are indistinguishable in the output, which is why the
		// panels that display them decide emptiness for themselves rather than asking this function.
		expect(formatCurrency(0, DEFAULT_CURRENCY)).toBe('₹ 0.00')
		expect(formatCurrency(undefined, DEFAULT_CURRENCY)).toBe('₹ 0.00')
		expect(formatCurrency(NaN, DEFAULT_CURRENCY)).toBe('₹ 0.00')
	})

	it('QUIRK - places the symbol BEFORE the minus sign', () => {
		// The sign is produced inside the number formatter while the symbol is concatenated outside it,
		// so a withdrawal reads "₹ -500.00" rather than "-₹ 500.00".
		expect(formatCurrency(-500, DEFAULT_CURRENCY)).toBe('₹ -500.00')
	})

	it('honours the requested number of decimals', () => {
		expect(formatCurrency(1234.5678, DEFAULT_CURRENCY, 0)).toBe('₹ 1,235')
		expect(formatCurrency(1234.5678, DEFAULT_CURRENCY, 3)).toBe('₹ 1,234.568')
	})

	it('groups thousands, and leaves a figure below the first group ungrouped', () => {
		expect(formatCurrency(999, DEFAULT_CURRENCY)).toBe('₹ 999.00')
		expect(formatCurrency(1000, DEFAULT_CURRENCY)).toBe('₹ 1,000.00')
		expect(formatCurrency(1234567.89, DEFAULT_CURRENCY)).toBe('₹ 1,234,567.89')
	})

	describe('when the currency places its symbol on the right', () => {
		let displaced: unknown

		beforeEach(() => {
			displaced = currencyDocument(ALTERNATE_CURRENCY).symbol_on_right
			currencyDocument(ALTERNATE_CURRENCY).symbol_on_right = 1
		})

		afterEach(() => {
			currencyDocument(ALTERNATE_CURRENCY).symbol_on_right = displaced
		})

		it('appends the symbol instead of prefixing it', () => {
			expect(formatCurrency(1234.5, ALTERNATE_CURRENCY)).toBe('1,234.50 $')
		})
	})

	describe('when the currency document carries no symbol', () => {
		let displaced: unknown

		beforeEach(() => {
			displaced = currencyDocument(ALTERNATE_CURRENCY).symbol
			currencyDocument(ALTERNATE_CURRENCY).symbol = ''
		})

		afterEach(() => {
			currencyDocument(ALTERNATE_CURRENCY).symbol = displaced
		})

		it('QUIRK - labels the figure with the currency CODE rather than dropping the label', () => {
			// `getCurrencySymbol` ends in `|| currency`, so a currency whose document carries no symbol
			// still labels its amounts - with the code. An amount on this workbench is never printed
			// unlabelled by accident.
			expect(formatCurrency(1234.5, ALTERNATE_CURRENCY)).toBe('USD 1,234.50')
		})
	})

	describe('when the site suppresses currency symbols altogether', () => {
		withSysdefault('hide_currency_symbol', 'Yes')

		it('returns the bare number, which is the only way to reach that branch', () => {
			// This setting is what empties the symbol, so it is the sole route to the unlabelled branch -
			// a currency with a blank symbol document still falls back to its code.
			expect(formatCurrency(1234.5, DEFAULT_CURRENCY)).toBe('1,234.50')
			expect(formatCurrency(-500, DEFAULT_CURRENCY)).toBe('-500.00')
		})
	})

	describe("under the site's European number format", () => {
		withSysdefault('number_format', '#.###,##')

		it('swaps the roles of the comma and the full stop', () => {
			expect(formatCurrency(1234567.89, DEFAULT_CURRENCY)).toBe('₹ 1.234.567,89')
		})
	})

	describe("under the site's space-grouped number format", () => {
		withSysdefault('number_format', '# ###.##')

		it('groups with spaces', () => {
			expect(formatCurrency(1234567.89, DEFAULT_CURRENCY)).toBe('₹ 1 234 567.89')
		})
	})

	describe("under the site's apostrophe-grouped number format", () => {
		withSysdefault('number_format', "#'###.##")

		it('groups with apostrophes', () => {
			expect(formatCurrency(1234567.89, DEFAULT_CURRENCY)).toBe("₹ 1'234'567.89")
		})
	})

	describe('QUIRK - under the Indian lakh format', () => {
		withSysdefault('number_format', '#,##,###.##')

		it('narrows the group from three digits to two after the first separator', () => {
			// 12,34,567 rather than 1,234,567: the group size changes once a separator has been emitted,
			// which is the lakh/crore convention.
			expect(formatCurrency(1234567, DEFAULT_CURRENCY)).toBe('₹ 12,34,567.00')
			expect(formatCurrency(100000, DEFAULT_CURRENCY)).toBe('₹ 1,00,000.00')
			expect(formatCurrency(999, DEFAULT_CURRENCY)).toBe('₹ 999.00')
		})
	})

	describe('QUIRK - under a format that declares no decimal separator', () => {
		withSysdefault('number_format', '#.###')

		it('derives a precision of one by splitting the format on the empty string', () => {
			// `get_number_format_info` splits the format on its own decimal separator to count the
			// decimals. With an empty separator the split yields single characters, so the precision is
			// the length of one character rather than zero - and the explicit argument still wins.
			expect(formatCurrency(1234567.89, DEFAULT_CURRENCY, 0)).toBe('₹ 1.234.568')
			expect(getCurrencyFormatInfo(DEFAULT_CURRENCY)).toMatchObject({
				decimal_str: '',
				group_sep: '.',
				precision: 1
			})
		})
	})

	describe('when the site takes the number format FROM the currency', () => {
		withSysdefault('use_number_format_from_currency', '1')

		let displaced: unknown

		beforeEach(() => {
			displaced = currencyDocument(ALTERNATE_CURRENCY).number_format
			currencyDocument(ALTERNATE_CURRENCY).number_format = '#.###,##'
		})

		afterEach(() => {
			currencyDocument(ALTERNATE_CURRENCY).number_format = displaced
		})

		it("prefers the currency's own format over the site default", () => {
			expect(formatCurrency(1234567.89, ALTERNATE_CURRENCY)).toBe('$ 1.234.567,89')
			// The site default still applies to a currency that declares nothing unusual.
			expect(formatCurrency(1234567.89, DEFAULT_CURRENCY)).toBe('₹ 1,234,567.89')
		})
	})
})

describe('flt', () => {

	it('reads a number straight through when no precision is requested', () => {
		expect(flt(1234.5)).toBe(1234.5)
		expect(flt(0)).toBe(0)
		expect(flt(-42)).toBe(-42)
	})

	it('treats an absent or empty value as zero rather than as NaN', () => {
		// Every one of these arrives from a form field the reviewer has not filled in.
		expect(flt(undefined)).toBe(0)
		expect(flt(null)).toBe(0)
		expect(flt('')).toBe(0)
	})

	it('parses a grouped string by removing the group separators', () => {
		expect(flt('1,234.50')).toBe(1234.5)
		expect(flt('1,234,567.89')).toBe(1234567.89)
	})

	it('QUIRK - strips a currency symbol only when a space separates it', () => {
		// The reviewer pastes a figure copied off the screen, which carries the symbol the workbench
		// printed. With a space the symbol is dropped; glued to the digits it defeats the parse.
		expect(flt('₹ 1,234.50')).toBe(1234.5)
		expect(flt('₹1,234.50')).toBe(0)
	})

	it('keeps the number when the symbol trails it', () => {
		// The first token parses as a number, so the string is left alone and the group strip and
		// `parseFloat` between them discard the trailing symbol.
		expect(flt('1,234.50 $')).toBe(1234.5)
	})

	it('parses under an explicitly supplied number format', () => {
		expect(flt('1.234.567,89', undefined, '#.###,##')).toBe(1234567.89)
		expect(flt("1'234'567.89", undefined, "#'###.##")).toBe(1234567.89)
	})

	it('QUIRK - truncates a space-grouped figure read under a comma-grouped format', () => {
		// A space is a legitimate group separator in some formats, so the symbol-stripping branch cannot
		// tell this apart from a symbol and the value silently loses everything after the space.
		expect(flt('1 234.50')).toBe(1)
		// Told the right format, the same string parses correctly.
		expect(flt('1 234.50', undefined, '# ###.##')).toBe(1234.5)
	})

	it('falls back to zero for a string carrying no number at all', () => {
		expect(flt('abc')).toBe(0)
		expect(flt('--')).toBe(0)
	})

	it('rounds to the requested precision', () => {
		expect(flt(1234.5678, 2)).toBe(1234.57)
		expect(flt(1234.5678, 0)).toBe(1235)
		expect(flt(-1234.5678, 2)).toBe(-1234.57)
	})

	describe("under the site's default Banker's Rounding", () => {
		it('rounds a half toward the even neighbour, in both directions', () => {
			expect(flt(2.5, 0)).toBe(2)
			expect(flt(3.5, 0)).toBe(4)
			expect(flt(-2.5, 0)).toBe(-2)
		})
	})

	describe('under the legacy rounding method', () => {
		withSysdefault('rounding_method', "Banker's Rounding (legacy)")

		it('also rounds a half toward the even neighbour', () => {
			expect(flt(2.5, 0)).toBe(2)
			expect(flt(3.5, 0)).toBe(4)
			expect(flt(1234.5678, 2)).toBe(1234.57)
		})
	})

	describe('under commercial rounding', () => {
		withSysdefault('rounding_method', 'Commercial Rounding')

		it('rounds a half AWAY from zero, which is where it differs from the default', () => {
			expect(flt(2.5, 0)).toBe(3)
			expect(flt(3.5, 0)).toBe(4)
			expect(flt(-2.5, 0)).toBe(-3)
			expect(flt(0, 2)).toBe(0)
		})
	})

	describe('QUIRK - under a rounding method the module does not implement', () => {
		withSysdefault('rounding_method', 'Round Half To Odd')

		it('throws rather than silently choosing one', () => {
			// Refusing is the safe answer for money: a silent fallback would post a figure the site did
			// not ask for. Only the rounding path throws, so an unrounded read still succeeds.
			expect(() => flt(2.5, 0)).toThrow('Unknown rounding method Round Half To Odd')
			expect(flt(2.5)).toBe(2.5)
		})
	})
})

describe('cint', () => {

	it('maps the booleans onto one and zero', () => {
		expect(cint(true)).toBe(1)
		expect(cint(false)).toBe(0)
	})

	it('truncates a number toward zero rather than rounding it', () => {
		expect(cint(12.9)).toBe(12)
		expect(cint(-12.9)).toBe(-12)
		expect(cint(0)).toBe(0)
	})

	it('QUIRK - strips leading zeros as characters, but exempts the string "0"', () => {
		// The strip runs before the parse, so "0" would otherwise be emptied into NaN.
		expect(cint('007')).toBe(7)
		expect(cint('0')).toBe(0)
		expect(cint('0012.9')).toBe(12)
	})

	it('falls back to zero for an unparseable value', () => {
		expect(cint('abc')).toBe(0)
		expect(cint('')).toBe(0)
	})

	it('falls back to a supplied default instead, when one is given', () => {
		expect(cint('abc', 5)).toBe(5)
		expect(cint('', 'fallback')).toBe('fallback' as unknown as number)
	})
})

describe('lstrip', () => {

	it('strips whitespace from the left only, by default', () => {
		expect(lstrip('  padded  ')).toBe('padded  ')
		expect(lstrip('\n\tpadded')).toBe('padded')
	})

	it('strips only the characters it was given', () => {
		expect(lstrip('00value', ['0'])).toBe('value')
		expect(lstrip('value00', ['0'])).toBe('value00')
	})

	it('returns an unpadded string untouched, and copes with an empty one', () => {
		expect(lstrip('value')).toBe('value')
		expect(lstrip('')).toBe('')
	})
})

describe('getCurrencyFormatInfo', () => {

	it("describes the separators of the site's own format", () => {
		expect(getCurrencyFormatInfo(DEFAULT_CURRENCY)).toMatchObject({
			decimal_str: '.',
			group_sep: ',',
			precision: 2
		})
	})

	it('describes the site format when no currency is named', () => {
		expect(getCurrencyFormatInfo()).toMatchObject({ decimal_str: '.', group_sep: ',' })
	})

	describe('for a format the module does not tabulate', () => {
		withSysdefault('number_format', '#~###.##')

		it('assumes the conventional comma and full stop', () => {
			expect(getCurrencyFormatInfo(DEFAULT_CURRENCY)).toMatchObject({
				decimal_str: '.',
				group_sep: ',',
				precision: 2
			})
		})
	})

	describe('QUIRK - for an untabulated format containing no full stop at all', () => {
		withSysdefault('number_format', '#~###!##')

		it('throws, because the assumed separator is not present to split on', () => {
			// The fallback assumes a full stop and then counts the decimals by splitting the format on
			// it. With no full stop present the split yields a single element, the tail is `undefined`,
			// and reading `.length` off it throws. Pinned because it is a latent crash rather than a
			// designed refusal: every caller here funnels through this one derivation, so a site
			// configured with such a format would break formatting everywhere rather than degrade.
			expect(() => getCurrencyFormatInfo(DEFAULT_CURRENCY)).toThrow(TypeError)
			expect(() => formatCurrency(1234.5, DEFAULT_CURRENCY)).toThrow(TypeError)
		})
	})
})

/**
 * The two functions below are the READ side of a currency field, and they exist because of a specific
 * class of defect: a figure a reviewer typed being stored as a DIFFERENT figure, silently.
 *
 * `react-currency-input-field` reports both the sanitised text and its own parsed float on every
 * keystroke, and the field is controlled by whatever the handler stores. Storing a re-read of the text
 * produced `NaN` for a grouped value and moved the decimal point on a partial one; storing the number
 * unconditionally swallowed the separator mid-entry, so `-250.50` was saved as -25050. The split below is
 * what makes both impossible: `parseCurrencyInput` decides whether the text or the number is authoritative
 * yet, and `currencyInputValueToNumber` is the only sanctioned way to read the resulting union back.
 */
describe('parseCurrencyInput', () => {

	describe('an empty field', () => {

		it('carries no value and is not an error, because that is how a filter is switched off', () => {
			expect(parseCurrencyInput({ text: '', float: null })).toEqual({
				value: null, text: '', isInvalid: false, keepText: false
			})
		})

		it('treats whitespace as empty', () => {
			expect(parseCurrencyInput({ text: '   ', float: null })).toMatchObject({
				value: null, isInvalid: false
			})
		})

		it('treats an absent text and an absent float as empty rather than as a refusal', () => {
			expect(parseCurrencyInput({})).toMatchObject({ value: null, isInvalid: false, keepText: false })
		})
	})

	describe('a figure the library parsed', () => {

		it('takes the float verbatim, never re-reading the text', () => {
			expect(parseCurrencyInput({ text: '1,234.56', float: 1234.56 })).toMatchObject({
				value: 1234.56, isInvalid: false
			})
		})

		it('keeps zero, because zero is a figure and not a missing one', () => {
			expect(parseCurrencyInput({ text: '0', float: 0 })).toMatchObject({
				value: 0, isInvalid: false, keepText: false
			})
		})

		it('keeps the sign of a negative, including one that arrived by paste', () => {
			expect(parseCurrencyInput({ text: '-250.5', float: -250.5 })).toMatchObject({
				value: -250.5, isInvalid: false
			})
		})

		it('does not inflate a small decimal, which is how 1.23 became 1,230,000,000', () => {
			expect(parseCurrencyInput({ text: '1.23', float: 1.23 })).toMatchObject({ value: 1.23 })
		})

		it('does not truncate a long figure to fit, which is how a filter ran on a silent 12', () => {
			expect(parseCurrencyInput({ text: '123456789012', float: 123456789012 })).toMatchObject({
				value: 123456789012, isInvalid: false
			})
		})
	})

	describe('a decimal still being typed', () => {

		it('asks for the text back once the separator is pressed, so the keystroke survives', () => {
			// `250.` parses to 250. Echoing 250 into a controlled field drops the separator and sends the
			// next digit into the units - the exact route by which -250.50 was stored as -25050.
			expect(parseCurrencyInput({ text: '250.', float: 250 })).toMatchObject({
				value: 250, keepText: true, isInvalid: false
			})
		})

		it('counts a trailing zero as unfinished, because 1.0 is on its way to 1.05', () => {
			expect(parseCurrencyInput({ text: '1.0', float: 1 })).toMatchObject({ keepText: true })
		})

		it('counts a fully typed 0.00 as unfinished text too, so the zeroes are not erased under the cursor', () => {
			expect(parseCurrencyInput({ text: '0.00', float: 0 })).toMatchObject({
				value: 0, keepText: true, isInvalid: false
			})
		})

		it('stops asking for the text once a significant decimal digit lands', () => {
			expect(parseCurrencyInput({ text: '1.05', float: 1.05 })).toMatchObject({
				value: 1.05, keepText: false
			})
		})

		it('does not mistake a whole number ending in zero for a decimal in progress', () => {
			expect(parseCurrencyInput({ text: '10', float: 10 })).toMatchObject({
				value: 10, keepText: false
			})
		})
	})

	describe('a prefix of a figure', () => {

		it('accepts a lone minus sign as unfinished rather than wrong', () => {
			expect(parseCurrencyInput({ text: '-', float: null })).toEqual({
				value: null, text: '-', isInvalid: false, keepText: true
			})
		})

		it('accepts a bare separator as unfinished', () => {
			expect(parseCurrencyInput({ text: '.', float: null })).toMatchObject({
				value: null, isInvalid: false, keepText: true
			})
		})
	})

	describe('text that cannot be used as a figure', () => {

		it('refuses it out loud instead of offering a number derived from part of it', () => {
			expect(parseCurrencyInput({ text: '1.2.3', float: null })).toMatchObject({
				value: null, isInvalid: true
			})
		})

		it('refuses a NaN float, which is what a field showing NaN was previously built from', () => {
			expect(parseCurrencyInput({ text: 'abc', float: Number.NaN })).toMatchObject({
				value: null, isInvalid: true
			})
		})

		it('refuses an infinite float', () => {
			expect(parseCurrencyInput({ text: '1e999', float: Number.POSITIVE_INFINITY })).toMatchObject({
				value: null, isInvalid: true
			})
		})

		it('keeps the text alongside the refusal, so the reviewer still sees what they typed', () => {
			expect(parseCurrencyInput({ text: '1.2.3', float: null }).text).toBe('1.2.3')
		})
	})

	describe('a currency whose decimal separator is a comma', () => {

		it('reads a comma as the separator being pressed', () => {
			expect(parseCurrencyInput({ text: '1,', float: 1, decimalSeparator: ',' })).toMatchObject({
				value: 1, keepText: true, isInvalid: false
			})
		})

		it('accepts a bare comma as a prefix', () => {
			expect(parseCurrencyInput({ text: ',', float: null, decimalSeparator: ',' })).toMatchObject({
				isInvalid: false, keepText: true
			})
		})

		it('does not treat a full stop as that currency\'s separator', () => {
			expect(parseCurrencyInput({ text: '.', float: null, decimalSeparator: ',' })).toMatchObject({
				isInvalid: true
			})
		})
	})
})

describe('currencyInputValueToNumber', () => {

	describe('reading the number branch of the union', () => {

		it('passes a finite number through, zero and negatives included', () => {
			expect(currencyInputValueToNumber(1234.56)).toBe(1234.56)
			expect(currencyInputValueToNumber(0)).toBe(0)
			expect(currencyInputValueToNumber(-250.5)).toBe(-250.5)
		})

		it('reports no figure for NaN and Infinity rather than passing them to the server', () => {
			expect(currencyInputValueToNumber(Number.NaN)).toBeNull()
			expect(currencyInputValueToNumber(Number.POSITIVE_INFINITY)).toBeNull()
		})
	})

	describe('reading the text branch of the union', () => {

		it('reads a decimal in progress as the figure typed so far', () => {
			expect(currencyInputValueToNumber('250.')).toBe(250)
		})

		it('reads a fully typed 0.00 as zero, so a statement closing at zero can be saved', () => {
			expect(currencyInputValueToNumber('0.00')).toBe(0)
		})

		it('strips group separators, which is what made Number() return NaN on a grouped figure', () => {
			expect(currencyInputValueToNumber('1,234.56')).toBe(1234.56)
		})

		it('handles the Indian lakh grouping the default number format produces', () => {
			expect(currencyInputValueToNumber('12,34,567.89')).toBe(1234567.89)
		})

		it('honours the separators of the currency in force rather than assuming them', () => {
			expect(currencyInputValueToNumber('1.234,56', {
				groupSeparator: '.', decimalSeparator: ','
			})).toBe(1234.56)
		})

		it('keeps the sign of a negative read out of text', () => {
			expect(currencyInputValueToNumber('-250.50')).toBe(-250.5)
		})

		it('reports no figure for an emptied field, which is what "required" means', () => {
			expect(currencyInputValueToNumber('')).toBeNull()
			expect(currencyInputValueToNumber('   ')).toBeNull()
		})

		it('reports no figure for a lone minus or unusable text', () => {
			expect(currencyInputValueToNumber('-')).toBeNull()
			expect(currencyInputValueToNumber('1.2.3')).toBeNull()
			expect(currencyInputValueToNumber('abc')).toBeNull()
		})
	})

	describe('reading anything else', () => {

		it('reports no figure, so an unset field cannot be mistaken for zero', () => {
			expect(currencyInputValueToNumber(undefined)).toBeNull()
			expect(currencyInputValueToNumber(null)).toBeNull()
			expect(currencyInputValueToNumber({})).toBeNull()
		})
	})
})
