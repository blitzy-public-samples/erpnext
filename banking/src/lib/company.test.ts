/**
 * Behavioural specification for `src/lib/company.ts` - the three readers that resolve a company record
 * out of `locals[':Company']`, the Desk document cache the host page's boot payload populates.
 *
 * `getCompanyCurrency` is the LAST fallback in the effective-currency chain every monetary figure on the
 * reconciliation workbench is formatted through, so a reader that threw where it should return
 * `undefined` would take the transaction row down rather than degrade a label.
 *
 * The module answers a miss with `undefined` and its callers coalesce that result rather than guarding
 * around it, so each reader is asserted on four inputs: a company the boot payload carries, one it does
 * not, the empty string, and a document cache with no `:Company` key. The empty string is not invented
 * here - callers reach these readers as `x?.company ?? ''`, and the current-company atom itself
 * initialises to `''`.
 *
 * One asymmetry is deliberately preserved: `getCompanyCurrency` and `getCompanyCostCenter` index the
 * root as `locals[':Company']?.…`, leaving `locals` itself un-chained, while `getCompany` chains it.
 * The bare global must therefore exist for all three, so the cache-absent tests below REPLACE the map
 * rather than removing the binding.
 *
 * No ambient typing of the bare `locals` global is introduced, inline or through a shim: the live
 * `ts-expect-error` directives across `src/` depend on it staying untyped. The tests that vary the
 * cache reach it through the same untyped `globalThis` cast the harness uses.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { getCompany, getCompanyCostCenter, getCompanyCurrency } from '@/lib/company'


const TEST_COMPANY = 'Test Company'

const EXPECTED_DEFAULT_CURRENCY = 'INR'

const EXPECTED_COST_CENTER = 'Main - TC'

const UNKNOWN_COMPANY = 'Nonexistent Company'

/* Replace the locals map only within this test and restore the captured object afterward; the
 * production helpers require the bare global binding to remain defined. Restoring unconditionally keeps
 * this suite order-independent and unable to leak into `currency.test.ts`, which reads the same map. */

const globalScope = globalThis as unknown as Record<string, unknown>

/** Captured at module load, before any test in this file can reassign it. */
const INSTALLED_LOCALS = globalScope.locals

/**
 * Installs a document cache that is present but carries no `:Company` key.
 *
 * The binding is REPLACED, never removed: `company.ts:4` and `company.ts:9` index the root
 * un-chained, so an absent `locals` would throw a `ReferenceError` and would assert the harness
 * rather than the module.
 */
const installCacheWithoutCompanies = (): void => {
	globalScope.locals = {}
}

afterEach(() => {
	globalScope.locals = INSTALLED_LOCALS
})

describe('getCompanyCurrency', () => {

	it('reads the default currency of a company the boot payload carries', () => {
		expect(getCompanyCurrency(TEST_COMPANY)).toBe(EXPECTED_DEFAULT_CURRENCY)
	})

	it('answers a company outside the document cache with undefined instead of throwing', () => {
		expect(() => getCompanyCurrency(UNKNOWN_COMPANY)).not.toThrow()
		expect(getCompanyCurrency(UNKNOWN_COMPANY)).toBeUndefined()
	})

	it('returns undefined for the empty-string company argument every call site can pass', () => {
		expect(() => getCompanyCurrency('')).not.toThrow()
		expect(getCompanyCurrency('')).toBeUndefined()
	})

	it('returns undefined when the document cache carries no company documents at all', () => {
		installCacheWithoutCompanies()

		expect(() => getCompanyCurrency(TEST_COMPANY)).not.toThrow()
		expect(getCompanyCurrency(TEST_COMPANY)).toBeUndefined()
	})
})

describe('getCompanyCostCenter', () => {

	it('reads the cost centre of a company the boot payload carries', () => {
		expect(getCompanyCostCenter(TEST_COMPANY)).toBe(EXPECTED_COST_CENTER)
	})

	it('answers a company outside the document cache with undefined instead of throwing', () => {
		expect(() => getCompanyCostCenter(UNKNOWN_COMPANY)).not.toThrow()
		expect(getCompanyCostCenter(UNKNOWN_COMPANY)).toBeUndefined()
	})

	it('returns undefined for the empty-string company argument every call site can pass', () => {
		expect(() => getCompanyCostCenter('')).not.toThrow()
		expect(getCompanyCostCenter('')).toBeUndefined()
	})

	it('returns undefined when the document cache carries no company documents at all', () => {
		installCacheWithoutCompanies()

		expect(() => getCompanyCostCenter(TEST_COMPANY)).not.toThrow()
		expect(getCompanyCostCenter(TEST_COMPANY)).toBeUndefined()
	})
})

describe('getCompany', () => {

	it('returns the whole company record, carrying both fields the field readers project', () => {
		const company = getCompany(TEST_COMPANY)

		expect(company).toBeDefined()
		expect(company).toMatchObject({
			name: TEST_COMPANY,
			default_currency: EXPECTED_DEFAULT_CURRENCY,
			cost_center: EXPECTED_COST_CENTER
		})
	})

	it('answers a company outside the document cache with undefined instead of throwing', () => {
		expect(() => getCompany(UNKNOWN_COMPANY)).not.toThrow()
		expect(getCompany(UNKNOWN_COMPANY)).toBeUndefined()
	})

	it('returns undefined for the empty-string company argument every call site can pass', () => {
		expect(() => getCompany('')).not.toThrow()
		expect(getCompany('')).toBeUndefined()
	})

	it('returns undefined when the document cache carries no company documents at all', () => {
		installCacheWithoutCompanies()

		expect(() => getCompany(TEST_COMPANY)).not.toThrow()
		expect(getCompany(TEST_COMPANY)).toBeUndefined()
	})
})
