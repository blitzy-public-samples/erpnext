import { describe, expect, it } from 'vitest'
import { TEST_COMPANY, TEST_CURRENCY } from '@/test/factories'

import { getCompany, getCompanyCostCenter, getCompanyCurrency } from './company'

/**
 * The company readers. They index `locals[':Company']` - the document cache the host page's boot
 * payload populates - so they are the seam between this application and the Desk runtime, and they
 * are read on paths where a wrong answer is not obviously wrong: the currency one supplies the
 * fallback currency for every amount the reconciliation workbench formats when a bank account
 * carries no derived `account_currency`.
 *
 * The important property is therefore how they behave for an UNKNOWN company. `undefined` is
 * correct and survivable (the formatter renders the amount with no symbol); a thrown
 * `TypeError` from indexing into nothing would take the whole panel down. Every reader is asserted
 * on both paths for that reason.
 */
describe('company readers', () => {

	it('reads the default currency of a company in the boot payload', () => {
		expect(getCompanyCurrency(TEST_COMPANY)).toBe(TEST_CURRENCY)
	})

	it('reads the cost centre of a company in the boot payload', () => {
		expect(getCompanyCostCenter(TEST_COMPANY)).toBeDefined()
		expect(typeof getCompanyCostCenter(TEST_COMPANY)).toBe('string')
	})

	it('returns the whole company record, not just one field', () => {
		const company = getCompany(TEST_COMPANY)

		expect(company).toBeDefined()
		expect(company.name).toBe(TEST_COMPANY)
		expect(company.default_currency).toBe(TEST_CURRENCY)
	})

	// The case that matters: a company the boot payload never carried.
	it('is undefined rather than throwing for a company that is not cached', () => {
		expect(() => getCompanyCurrency('No Such Company')).not.toThrow()
		expect(getCompanyCurrency('No Such Company')).toBeUndefined()

		expect(() => getCompanyCostCenter('No Such Company')).not.toThrow()
		expect(getCompanyCostCenter('No Such Company')).toBeUndefined()

		expect(() => getCompany('No Such Company')).not.toThrow()
		expect(getCompany('No Such Company')).toBeUndefined()
	})

	/*
	 * Callers reach these with `bankAccount?.company ?? ''` while no account is selected yet, so the
	 * empty string is a REAL input on the first paint of the workbench, not a hypothetical one.
	 */
	it('survives the empty company name that an unselected account produces', () => {
		expect(() => getCompanyCurrency('')).not.toThrow()
		expect(getCompanyCurrency('')).toBeUndefined()
		expect(getCompany('')).toBeUndefined()
	})
})
