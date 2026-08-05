/**
 * Behavioural specification for `src/lib/amountFormula.ts` - the evaluator behind the amount field on a
 * Bank Transaction Rule, which lets a rule express an allocation as an expression over the transaction's
 * own amount rather than as a fixed figure.
 *
 * The expression comes from a stored rule document, so it is operator-authored rather than
 * attacker-supplied - but it is still evaluated in the browser, which is why the module uses a
 * restricted expression parser rather than anything that can reach the surrounding scope. The two
 * properties that matter are therefore: arithmetic over `transaction_amount` works, and NOTHING else
 * does.
 *
 * Three behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. A plain number bypasses the parser entirely, via an explicit pattern test - so the common case
 *      never pays for expression parsing and cannot be affected by parser behaviour.
 *   2. EVERY failure - a parse error, a non-numeric result, an infinite result - collapses to `0` rather
 *      than throwing or returning `null`. A rule with a broken formula allocates nothing instead of
 *      breaking the reconciliation screen.
 *   3. The plain-number fast path accepts a leading minus but NOT a leading plus or an exponent, so
 *      `+5` and `1e3` go through the parser instead.
 */

import { describe, expect, it } from 'vitest'

import { evaluateAmountFormula } from '@/lib/amountFormula'

const TRANSACTION_AMOUNT = 5000

describe('evaluateAmountFormula', () => {

	describe('the plain-number fast path', () => {

		it('QUIRK - returns a bare number without consulting the parser', () => {
			expect(evaluateAmountFormula('5000', TRANSACTION_AMOUNT)).toBe(5000)
			expect(evaluateAmountFormula('1234.56', TRANSACTION_AMOUNT)).toBe(1234.56)
			expect(evaluateAmountFormula('0', TRANSACTION_AMOUNT)).toBe(0)
		})

		it('accepts a leading minus, because a rule may allocate a negative figure', () => {
			expect(evaluateAmountFormula('-750', TRANSACTION_AMOUNT)).toBe(-750)
			expect(evaluateAmountFormula('-0.5', TRANSACTION_AMOUNT)).toBe(-0.5)
		})

		it('tolerates surrounding whitespace, which a pasted value carries', () => {
			expect(evaluateAmountFormula('  5000  ', TRANSACTION_AMOUNT)).toBe(5000)
			expect(evaluateAmountFormula('\n1234.56\t', TRANSACTION_AMOUNT)).toBe(1234.56)
		})

		it('QUIRK - mishandles a leading plus and, worse, an exponent', () => {
			// The fast-path pattern admits a leading MINUS but not a leading plus, and admits no exponent
			// notation, so both of these are handed to the parser instead. The two then fail DIFFERENTLY:
			//   "+5000" is rejected outright and lands on the zero fallback, allocating nothing;
			//   "1e3" parses as just its leading "1", so it allocates ONE rupee rather than a thousand.
			// The second is the dangerous one, because a wrong figure is posted silently whereas a zero is
			// at least visibly nothing. Both are pinned so neither can change unnoticed.
			expect(evaluateAmountFormula('+5000', TRANSACTION_AMOUNT)).toBe(0)
			expect(evaluateAmountFormula('1e3', TRANSACTION_AMOUNT)).toBe(1)
			// The forms the fast path does admit are unaffected.
			expect(evaluateAmountFormula('-5000', TRANSACTION_AMOUNT)).toBe(-5000)
			expect(evaluateAmountFormula('5000', TRANSACTION_AMOUNT)).toBe(5000)
		})
	})

	describe('arithmetic over the transaction amount', () => {

		it('exposes the amount under the name a rule author writes', () => {
			expect(evaluateAmountFormula('transaction_amount', TRANSACTION_AMOUNT)).toBe(5000)
		})

		it('evaluates the operations a rule realistically needs', () => {
			// A percentage split, a fee deduction and a proportional share are the three shapes an
			// allocation formula actually takes.
			expect(evaluateAmountFormula('transaction_amount * 0.1', TRANSACTION_AMOUNT)).toBe(500)
			expect(evaluateAmountFormula('transaction_amount - 250', TRANSACTION_AMOUNT)).toBe(4750)
			expect(evaluateAmountFormula('transaction_amount / 4', TRANSACTION_AMOUNT)).toBe(1250)
			expect(evaluateAmountFormula('transaction_amount + 100', TRANSACTION_AMOUNT)).toBe(5100)
		})

		it('honours parentheses and operator precedence', () => {
			expect(evaluateAmountFormula('(transaction_amount - 1000) * 0.5', TRANSACTION_AMOUNT)).toBe(2000)
			expect(evaluateAmountFormula('transaction_amount - 1000 * 0.5', TRANSACTION_AMOUNT)).toBe(4500)
		})

		it('re-evaluates against whatever amount it is handed', () => {
			// The same stored rule is applied to every matching transaction, so the expression must not
			// capture an amount.
			expect(evaluateAmountFormula('transaction_amount * 0.1', 100)).toBe(10)
			expect(evaluateAmountFormula('transaction_amount * 0.1', 250)).toBe(25)
			expect(evaluateAmountFormula('transaction_amount * 0.1', 0)).toBe(0)
		})

		it('copes with a negative transaction amount', () => {
			expect(evaluateAmountFormula('transaction_amount * 0.5', -800)).toBe(-400)
		})
	})

	describe('QUIRK - every failure resolves to zero rather than throwing', () => {

		it('returns zero for an empty or whitespace-only expression', () => {
			// The field is optional on the rule form, so this is the default state rather than an error.
			expect(evaluateAmountFormula('', TRANSACTION_AMOUNT)).toBe(0)
			expect(evaluateAmountFormula('   ', TRANSACTION_AMOUNT)).toBe(0)
			expect(evaluateAmountFormula('\n\t', TRANSACTION_AMOUNT)).toBe(0)
		})

		it('returns zero for an expression that cannot be parsed', () => {
			expect(evaluateAmountFormula('transaction_amount *', TRANSACTION_AMOUNT)).toBe(0)
			expect(evaluateAmountFormula('((((', TRANSACTION_AMOUNT)).toBe(0)
			expect(evaluateAmountFormula('not an expression at all', TRANSACTION_AMOUNT)).toBe(0)
		})

		it('returns zero for a name the evaluator was not given', () => {
			// A rule referring to a variable that no longer exists must allocate nothing rather than
			// break the screen it is rendered on.
			expect(evaluateAmountFormula('unknown_variable * 2', TRANSACTION_AMOUNT)).toBe(0)
			expect(evaluateAmountFormula('transactionAmount', TRANSACTION_AMOUNT)).toBe(0)
		})

		it('returns zero for a result that is not a finite number', () => {
			// Division by zero yields Infinity, which is not a figure that can be posted.
			expect(evaluateAmountFormula('transaction_amount / 0', TRANSACTION_AMOUNT)).toBe(0)
			expect(evaluateAmountFormula('0 / 0', TRANSACTION_AMOUNT)).toBe(0)
		})

		it('never throws, for any input, which is the property the rule form depends on', () => {
			const hostile = [
				'', '   ', 'undefined', 'null', 'NaN', '[]', '{}',
				'transaction_amount +', ')(', '1 +++ 2', 'transaction_amount / 0'
			]

			for (const expression of hostile) {
				expect(() => evaluateAmountFormula(expression, TRANSACTION_AMOUNT), expression).not.toThrow()
				expect(Number.isFinite(evaluateAmountFormula(expression, TRANSACTION_AMOUNT)), expression)
					.toBe(true)
			}
		})
	})

	describe('the expression scope is restricted', () => {

		it('reaches no host global, so an expression cannot escape into the page', () => {
			// The evaluator is a restricted parser rather than `eval`, and each of these is a route out of
			// the sandbox if it were not. Every one must collapse to the zero fallback.
			const escapes = [
				'window', 'globalThis', 'document', 'frappe', 'locals', 'process',
				'window.location', 'document.cookie', 'this'
			]

			for (const expression of escapes) {
				expect(evaluateAmountFormula(expression, TRANSACTION_AMOUNT), expression).toBe(0)
			}
		})

		it('cannot invoke a function or construct anything', () => {
			const invocations = [
				'alert(1)', 'fetch("/api")', 'constructor', 'new Date()',
				'[].constructor', 'transaction_amount.toString()'
			]

			for (const expression of invocations) {
				expect(evaluateAmountFormula(expression, TRANSACTION_AMOUNT), expression).toBe(0)
			}
		})
	})
})
