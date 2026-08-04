/**
 * Behavioural specification for `src/lib/company.ts` — the three readers that resolve a company
 * record out of `locals[':Company']`, the Desk document cache the host page's boot payload
 * populates.
 *
 * WHY FIFTEEN LINES OF LOOKUP DESERVE A SUITE
 * ------------------------------------------
 * `company.ts` is easy to dismiss and is not dismissible. `getCompanyCurrency` is the LAST
 * fallback in the effective-currency chain every monetary figure on the reconciliation workbench
 * is formatted through, and it is consulted from nineteen call sites across ten modules. The two
 * that carry the most weight are both in `MatchAndReconcile.tsx`:
 *
 *     L137  const currency = freshAccountCurrency ?? bankAccount?.account_currency
 *                            ?? getCompanyCurrency(bankAccount?.company ?? '')
 *     L344  const currency = transaction.currency ?? accountCurrency
 *                            ?? selectedBank?.account_currency
 *                            ?? getCompanyCurrency(selectedBank?.company ?? '')
 *
 * L137 supplies the currency the transaction list's amount filter and column headers are read in;
 * L344 supplies the per-row currency that the currency-mismatch indicator compares against the
 * account. A reader that threw where it should return `undefined` would therefore not degrade a
 * label — it would take the transaction row, and with it the reviewer's whole worklist, down.
 *
 * WHAT IS PINNED HERE IS THE ACTUAL BEHAVIOUR, NOT THE DESIRABLE ONE
 * -----------------------------------------------------------------
 * Every expectation below was produced by executing the real module under the real harness. The
 * module answers a miss with `undefined`: it does not throw, and it does not substitute a
 * default. Its callers are written to that contract rather than around it —
 * `BankEntryModalContent.tsx` coalesces the result at seven sites (L181, L193, L214, L233, L454,
 * L484, L546), each spelled `getCompanyCostCenter(…) ?? ''`. Making a miss throw, or inventing a
 * default, would break those callers silently, so each reader is asserted on four inputs: a
 * company the boot payload carries, one it does not, the empty string, and a document cache with
 * no `:Company` key at all.
 *
 * The empty string is not an edge case invented here. Fifteen of the nineteen currency call sites
 * reach the reader as `x?.company ?? ''`, and the remaining four pass `useCurrentCompany()`,
 * whose atom initialises to `window.frappe?.boot?.user?.defaults?.company || ''`
 * (`src/hooks/useCurrentCompany.ts:4`) — so ALL nineteen can hand this reader `''`, and they do
 * on the first paint of the workbench, before a bank account has been selected.
 *
 * ONE ASYMMETRY IS DELIBERATELY PRESERVED
 * ---------------------------------------
 * `getCompanyCurrency` (`company.ts:4`) and `getCompanyCostCenter` (`company.ts:9`) index the
 * root as `locals[':Company']?.…`, leaving `locals` itself un-chained, while `getCompany`
 * (`company.ts:14`) writes `locals?.[':Company']?.…`. The bare global must therefore exist for
 * all three, which the harness guarantees (`src/test/setup.ts`). That asymmetry is existing,
 * authoritative behaviour: this suite documents it and does not harmonise it, so the
 * cache-absent tests below replace the map rather than removing the binding.
 *
 * CONVENTIONS THIS FILE IS OBLIGED TO FOLLOW
 * ------------------------------------------
 *  - Vitest symbols are imported explicitly. `vitest.config.ts` sets `globals: true`, which
 *    exposes the API at RUNTIME only; `tsconfig.app.json` declares no `types` array, so nothing
 *    is ambiently typed and an implicit `describe` would not compile. `eslint.config.js`
 *    registers browser globals only, which says the same thing independently.
 *  - NO ambient typing of the bare `locals` global is introduced here — not inline, not through
 *    a `.d.ts` shim. Thirteen live `ts-expect-error` directives depend on that global staying
 *    untyped: `lib/company.ts` (3), `lib/currency.ts` (4), `hooks/useDocType.ts` (2),
 *    `main.tsx` (4). Typing it would orphan all thirteen and fail the build with TS2578. The
 *    tests that vary the cache reach it through the same untyped `globalThis` cast
 *    `src/test/setup.ts` uses, which carries no type information.
 *  - Imports are limited to `vitest` and the subject. These are pure functions over a global the
 *    harness already installs, so the suite needs no DOM utilities, no fixture builder and no
 *    module stubbing. Expected values are declared locally, mirroring the harness, each cited to
 *    the line that installs it.
 *  - Every assertion states a real expected value. No snapshot is recorded in place of an
 *    expectation, so nothing here can be "updated" into agreeing with a regression.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { getCompany, getCompanyCostCenter, getCompanyCurrency } from '@/lib/company'

/* ── The harness contract these assertions mirror ────────────────────────────────────
 * `src/test/setup.ts` builds `locals` from a declared document set using the production
 * `add_to_locals` rule, and registers exactly ONE `:Company` document — so that record is the
 * entire universe these readers can resolve, and every other name is a guaranteed miss.
 *
 * The values are re-declared here rather than imported: `setup.ts` keeps them module-scoped and
 * exports none of them, and `src/test/factories.ts` exposes no cost-centre constant, so any
 * import would have to be partial. Each carries the line that installs it, so a harness change
 * fails loudly here and points straight at its own cause.
 * ────────────────────────────────────────────────────────────────────────────────── */

/**
 * `src/test/setup.ts:72`. Deliberately also `boot.user.defaults.company`
 * (`src/test/setup.ts:68-70`): a mismatch between the two would make every reader below return
 * `undefined` for the company the application considers selected.
 */
const TEST_COMPANY = 'Test Company'

/** `src/test/setup.ts:77`, stamped onto the record at `src/test/setup.ts`. */
const EXPECTED_DEFAULT_CURRENCY = 'INR'

/** `src/test/setup.ts:73`, stamped onto the record at `src/test/setup.ts`. */
const EXPECTED_COST_CENTER = 'Main - TC'

/** A name the boot payload never carried, so all three readers must miss on it. */
const UNKNOWN_COMPANY = 'Nonexistent Company'

/* ── Varying the document cache, and putting it back ─────────────────────────────────
 * One test per reader replaces the whole `locals` map to exercise the optional-chaining guard on
 * the `:Company` key — the state a page reaches when the boot payload carried no company
 * documents at all.
 *
 * The global is reached through the same untyped cast `src/test/setup.ts` uses, for the
 * reason given in the header. The harness re-points the global in its own `beforeEach`
 * (`src/test/setup.ts,692`), so the restore below is a second line of defence rather than
 * the only one; it is unconditional and restores the very object the harness installed, which
 * keeps this suite order-independent and unable to leak into `currency.test.ts`, which reads the
 * same map.
 * ────────────────────────────────────────────────────────────────────────────────── */

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

	/*
	 * The load-bearing case. `MatchAndReconcile.tsx:344` hands this reader `''` for every row it
	 * renders until a bank account carrying a company is selected, and the result feeds the
	 * currency-mismatch indicator — so `undefined` here must stay a value the caller can coalesce,
	 * never an exception that unmounts the row.
	 */
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

	/*
	 * `BankEntryModalContent.tsx` writes `getCompanyCostCenter(…) ?? ''` at L181, L193, L214,
	 * L233, L454, L484 and L546, so the journal-entry rows it builds depend on a miss being
	 * `undefined` and coalescible. This assertion is what stops that contract being changed by
	 * accident.
	 */
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

/*
 * `getCompany` is the whole-record reader. It has no consumer in the application today — the two
 * field readers above cover every in-app need — which makes this suite its only specification,
 * and makes pinning the shape it hands back the point rather than a formality.
 */
describe('getCompany', () => {

	/*
	 * Asserted structurally, deliberately not by exact equality. The harness stamps FIVE fields
	 * onto the record (`src/test/setup.ts`: `doctype`, `name`, `default_currency`,
	 * `cost_center`, `country`) and a live Desk `locals` carries more still, so a whole-object
	 * literal would pin the fixture's shape instead of this reader's contract and would break the
	 * moment the harness grew a field. What matters is that the record the field readers project
	 * from is returned INTACT, carrying both projected fields at once.
	 */
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

	/*
	 * The one reader that also chains the root (`company.ts:14`), so it is the one place where a
	 * cache-absent assertion could diverge from the two above. It does not: a present map without
	 * the `:Company` key short-circuits identically.
	 */
	it('returns undefined when the document cache carries no company documents at all', () => {
		installCacheWithoutCompanies()

		expect(() => getCompany(TEST_COMPANY)).not.toThrow()
		expect(getCompany(TEST_COMPANY)).toBeUndefined()
	})
})
