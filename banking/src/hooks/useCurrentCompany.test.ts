/**
 * Behavioural specification for `src/hooks/useCurrentCompany.ts`.
 *
 * This hook is the single source of the company every company-scoped request carries, and two of those
 * requests - `bank_reconciliation_tool.get_account_balance` and `bank_account.get_list` - declare
 * `company` as a REQUIRED POSITIONAL argument. A call that omits it therefore does not come back empty;
 * it comes back as an HTTP 500 `TypeError: ... missing 1 required positional argument: 'company'` with a
 * full server traceback. So "when does this hook have a value" is not a cosmetic question.
 *
 * The behaviour pinned below is the one that was actually wrong. `selectedBankAccountAtom` is declared
 * with `getOnInit: true` and so is populated from storage on the FIRST render. This atom was not, which
 * meant that for one render the application held a persisted bank account and no company - and every
 * hook pairing the two fired a request in exactly that state. Reading storage on init is what makes the
 * two hydrate together, which is what the pairing has always assumed.
 *
 * These tests re-import the module per case, because `atomWithStorage` reads `localStorage` and
 * `window.frappe.boot` at MODULE EVALUATION time; a shared import would freeze whatever the first test
 * happened to set up.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'jotai'

const STORAGE_KEY = 'bank-rec-selected-company'

/**
 * Load a fresh copy of the module against the current `localStorage` / boot state, and read the atom
 * exactly once from a brand-new store - which is the first-render behaviour under test.
 */
const readAtomOnFirstRender = async () => {
	const { selectedCompanyAtom } = await import('./useCurrentCompany')
	return createStore().get(selectedCompanyAtom)
}

const setBootDefaultCompany = (company: string | undefined) => {
	const boot = window.frappe.boot as { user: { defaults: Record<string, unknown> } }
	if (company === undefined) {
		delete boot.user.defaults.company
	} else {
		boot.user.defaults.company = company
	}
}

describe('selectedCompanyAtom hydration', () => {

	beforeEach(() => {
		localStorage.removeItem(STORAGE_KEY)
		setBootDefaultCompany(undefined)
		// Re-evaluated per test: the atom captures storage and boot when the module is first evaluated.
		vi.resetModules()
	})

	it('reads the persisted company on the FIRST render, not on a later effect', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify('_Test Company'))

		/*
		 * The whole point of the fix. Without `getOnInit`, this first read returns the atom's initial
		 * value - here the empty string, because the signed-in user has no default company - and the
		 * stored company only arrives after mount. That one render is when the balance requests fire.
		 */
		expect(await readAtomOnFirstRender()).toBe('_Test Company')
	})

	it('falls back to the signed-in user\'s default company when nothing is persisted', async () => {
		setBootDefaultCompany('_Boot Default Company')

		expect(await readAtomOnFirstRender()).toBe('_Boot Default Company')
	})

	it('is empty when neither a persisted company nor a user default exists', async () => {
		// The ordinary first-visit state for a user with no default company. It must read as empty rather
		// than as `undefined` or a stale value, because that emptiness is what the callers gate on.
		expect(await readAtomOnFirstRender()).toBe('')
	})

	it('prefers the persisted company over the user default', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify('_Chosen Company'))
		setBootDefaultCompany('_Boot Default Company')

		expect(await readAtomOnFirstRender()).toBe('_Chosen Company')
	})
})

describe('useCurrentCompany', () => {

	beforeEach(() => {
		localStorage.removeItem(STORAGE_KEY)
		setBootDefaultCompany(undefined)
		vi.resetModules()
	})

	it('returns the persisted company', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify('_Test Company'))

		const { useCurrentCompany } = await import('./useCurrentCompany')
		const { renderHook } = await import('@testing-library/react')

		expect(renderHook(() => useCurrentCompany()).result.current).toBe('_Test Company')
	})

	it('returns the user default when the persisted company is empty', async () => {
		setBootDefaultCompany('_Boot Default Company')

		const { useCurrentCompany } = await import('./useCurrentCompany')
		const { renderHook } = await import('@testing-library/react')

		expect(renderHook(() => useCurrentCompany()).result.current).toBe('_Boot Default Company')
	})

	it('returns a falsy value when no company can be resolved, so callers can withhold their request', async () => {
		const { useCurrentCompany } = await import('./useCurrentCompany')
		const { renderHook } = await import('@testing-library/react')

		expect(renderHook(() => useCurrentCompany()).result.current).toBeFalsy()
	})
})
