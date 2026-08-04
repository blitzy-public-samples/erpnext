/**
 * Behavioural specification for `src/lib/currency.ts` — the three readers that resolve a
 * currency's symbol and number format out of the Desk runtime the host page injects.
 *
 * WHY TWENTY-FOUR LINES OF LOOKUP CARRY THIS MUCH WEIGHT
 * -----------------------------------------------------
 * Every monetary figure a reviewer reads on the reconciliation workbench and the statement
 * importer is labelled through this module. `getCurrencySymbol` is called for the whole
 * transaction list at `MatchAndReconcile.tsx:138`, again for the filter bar at
 * `BankTransactionList.tsx:331`, and once per currency input at `form-elements.tsx:282`;
 * `numbers.ts` reaches all three readers from `formatCurrency` (L15, L17) and
 * `get_number_format` (L121). A wrong answer here does not break a layout — it mislabels an
 * amount on a screen whose entire purpose is deciding whether two amounts are the same
 * money, which is the most consequential way for a reconciliation tool to be wrong.
 *
 * The call sites are also the reason the argument may be empty. `numbers.ts:11-13` defaults
 * it to `getSystemDefault('currency') ?? ''`, and `MatchAndReconcile.tsx:137` /
 * `BankTransactionList.tsx:330` build it as `… ?? getCompanyCurrency(x?.company ?? '')`,
 * whose miss is `undefined`. Both spellings arrive here on the first paint of the workbench,
 * before a bank account has been selected — so the falsy-argument path below is the ordinary
 * case, not an edge case.
 *
 * WHAT IS PINNED HERE IS THE ACTUAL BEHAVIOUR, NOT THE DESIRABLE ONE
 * -----------------------------------------------------------------
 * Every expectation was produced by executing the real module under the real harness. Four
 * behaviours are surprising on first reading, and each is labelled QUIRK and pinned with an
 * explicit assertion so that a later change which "tidies" one of them fails loudly here
 * instead of quietly altering what a reviewer is told about money:
 *
 *   QUIRK 1  The suppression setting is compared with a LOOSE `==` against the string
 *            `"Yes"` (`currency.ts:5`) — it is not a boolean and not a truthiness test, so
 *            the `'No'` the boot payload actually carries must NOT suppress anything.
 *   QUIRK 2  The system-default fallback reads `frappe.boot.sysdefaults.currency` WITHOUT
 *            optional chaining (`currency.ts:8`), so an absent `sysdefaults` is a
 *            `TypeError` rather than a fallback. That is asserted below, because it is the
 *            single reason the harness has to install `sysdefaults.currency` at all.
 *   QUIRK 3  A currency the document cache does not carry resolves to the CODE, not to
 *            nothing (`currency.ts:10,12`). "XXX 1,200.00" is honest; a bare "1,200.00"
 *            would read as the site's own currency, which on this screen is the dangerous
 *            direction to be wrong in.
 *   QUIRK 4  The two branches are NOT equivalent. `currency.ts:10` and `currency.ts:12`
 *            return the same expression, but only line 10 is preceded by the fallback — so
 *            an empty argument yields the default currency's symbol when `frappe.boot` is
 *            present and the EMPTY STRING when it is not.
 *
 * HOW THIS SUITE IS ALLOWED TO REACH THE GLOBALS
 * ---------------------------------------------
 * `currency.ts` reads the BARE globals `frappe` (L3, L5, L8) and `locals` (L23), neither of
 * which is declared anywhere: `src/vite-env.d.ts` types `Window.frappe` as `any` and stops
 * there. Thirteen live `ts-expect-error` directives depend on those bare globals staying
 * untyped — `lib/currency.ts` (4), `lib/company.ts` (3), `hooks/useDocType.ts` (2),
 * `main.tsx` (4) — so this file introduces NO ambient declaration, not inline and not
 * through a `.d.ts` shim. Typing either global would orphan all thirteen and fail the build
 * with TS2578.
 *
 * Under jsdom `window === globalThis`, so `window.frappe` and the bare `frappe` the module
 * reads are the SAME property. That is what makes the mutations below reach the subject:
 *  - anything under `frappe` is written through `window.frappe`, which needs no cast because
 *    it is already `any`;
 *  - `locals` has no `Window` declaration, so it is reached through the same untyped
 *    `globalThis` cast `src/test/setup.ts` itself uses, which carries no type
 *    information.
 *
 * `frappe.boot` is FALSIFIED, never removed, and `locals` is REPLACED, never deleted:
 * `currency.ts:3` evaluates `if (frappe.boot)` on the bare identifier and `currency.ts:23`
 * indexes `locals` at the root un-chained, so removing either binding would throw and the
 * assertion would be about the harness instead of the module.
 *
 * Every mutation captures the value it displaces FIRST and restores that captured value in
 * an `afterEach` owned by the narrowest `describe` that needs it, so no test restores state
 * it never touched. The harness rebuilds this runtime in its own `beforeEach`
 * (`src/test/setup.ts`) and again in its `afterEach` (`src/test/setup.ts`), so these
 * restores are a second line of defence rather than the only one — which is precisely why
 * they are unconditional: the suite stays order-independent and cannot leak into
 * `company.test.ts`, which reads the same document cache.
 *
 * Vitest symbols are imported explicitly. `vitest.config.ts` sets `globals: true`, which
 * exposes the API at RUNTIME only; `tsconfig.app.json` declares no `types` array, so nothing
 * is ambiently typed and an implicit `describe` would not compile. Imports are limited to
 * `vitest` and the subject: these are pure functions over globals the harness already
 * installs, so the suite needs no DOM utilities, no fixture builder and no module stubbing.
 * Every assertion states a real expected value — no snapshot stands in for an expectation,
 * so nothing here can be "updated" into agreeing with a regression.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getCurrencyNumberFormat, getCurrencyProperty, getCurrencySymbol } from '@/lib/currency'

/* ── The harness contract these assertions mirror ────────────────────────────────────
 * `src/test/setup.ts` builds the document cache from a declared set using the
 * production `add_to_locals` rule and registers exactly TWO `:Currency` documents — so those
 * two are the entire universe these readers can resolve, and every other code is a
 * guaranteed miss.
 *
 * The values are re-declared here rather than imported: `setup.ts` keeps them module-scoped
 * and exports none of them, so any import would have to come from elsewhere and could drift
 * from the object actually installed. Each constant carries the line that installs it, so a
 * harness change fails loudly here and points straight at its own cause.
 * ────────────────────────────────────────────────────────────────────────────────── */

/** `src/test/setup.ts:77`, registered as a `:Currency` document at `src/test/setup.ts`. */
const TEST_CURRENCY = 'INR'

/** The symbol stamped onto that document at `src/test/setup.ts`. */
const EXPECTED_SYMBOL = '₹'

/**
 * `src/test/setup.ts:78`, registered at `src/test/setup.ts`. A SECOND currency exists in
 * the fixture on purpose: without it, nothing could distinguish a reader that resolves per
 * currency from one that returns the site default for everything — and that distinction is
 * what the workbench's currency-mismatch advisory depends on.
 */
const ALTERNATE_CURRENCY = 'USD'

/** The symbol stamped onto that document at `src/test/setup.ts`. */
const EXPECTED_ALTERNATE_SYMBOL = '$'

/** `src/test/setup.ts:84`, stamped onto BOTH currency documents at `src/test/setup.ts`. */
const EXPECTED_NUMBER_FORMAT = '#,###.##'

/** A code the boot payload never carried, so every reader must miss on it. */
const UNKNOWN_CURRENCY = 'XXX'

/**
 * The ONLY value `currency.ts:5` treats as suppression, spelled exactly as the comparison
 * expects it.
 */
const SYMBOLS_HIDDEN = 'Yes'

/** What `src/test/setup.ts` actually installs, and what must NOT suppress anything. */
const SYMBOLS_SHOWN = 'No'

/* ── Reaching the two bare globals ───────────────────────────────────────────────────
 * Both captures happen at module load, before any test in this file can reassign them, and
 * both target bindings whose identity the harness preserves across its own resets: it
 * re-points `frappe.boot` at the same object (`src/test/setup.ts`) and rebuilds the
 * document cache in place rather than replacing it (`src/test/setup.ts`). Restoring
 * the captured reference therefore restores the very object the harness installed, rather
 * than a payload reconstructed here that could silently diverge from it.
 * ────────────────────────────────────────────────────────────────────────────────── */

const globalScope = globalThis as unknown as Record<string, unknown>

/** The document cache `src/test/setup.ts` installs. */
const INSTALLED_LOCALS = globalScope.locals

/** The boot payload `src/test/setup.ts` installs, via a property already typed `any`. */
const INSTALLED_BOOT = window.frappe.boot

describe('getCurrencySymbol', () => {

	/*
	 * BRANCH 1 of 4 — the site-wide suppression setting (`currency.ts:5-6`).
	 *
	 * QUIRK 1. The comparison is a loose `==` against the STRING "Yes". It is asserted from
	 * both sides because each side fails differently: a truthiness test in its place would
	 * suppress the symbol for the installed `'No'` as well, and a stricter comparison would
	 * stop suppressing it for the live `'0'` that `src/test/setup.ts` records. Only the
	 * `'Yes'` / `'No'` pair distinguishes the implementation that exists from both.
	 */
	describe('when the site hides currency symbols', () => {

		/**
		 * Re-read for every test rather than captured once at module load, because the
		 * harness replaces the whole `sysdefaults` OBJECT in its own `beforeEach`
		 * (`src/test/setup.ts`) — so this holds the value belonging to the object THIS
		 * test was handed, and the restore below cannot write onto a stale one.
		 */
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

		/*
		 * The setting is read before the fallback and before the lookup, so it short-circuits
		 * both. These two assertions are what prove the ordering rather than the outcome.
		 */
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

	/*
	 * BRANCH 2 of 4 — the system-default fallback (`currency.ts:8`).
	 *
	 * The load-bearing case in this file. `numbers.ts:11-13` hands this reader `''` whenever
	 * a caller had no currency, and `MatchAndReconcile.tsx:137` reaches it through
	 * `getCompanyCurrency(…)`, whose miss is `undefined` — so on the first paint of the
	 * workbench, before a bank account is selected, this is the path every amount takes.
	 *
	 * Nothing is mutated here: the assertion runs against the harness exactly as installed,
	 * which is what makes it a check of the harness CONTRACT as much as of the module. The
	 * first expectation states that contract explicitly, so a `sysdefaults` without a
	 * `currency` key fails on a legible line instead of surfacing as a `TypeError` thrown
	 * from inside the subject.
	 */
	describe('when the caller has no currency to pass', () => {

		it('substitutes the system default currency named in the boot payload', () => {
			expect(window.frappe.boot.sysdefaults.currency).toBe(TEST_CURRENCY)

			expect(getCurrencySymbol('')).toBe(EXPECTED_SYMBOL)
		})
	})

	/*
	 * BRANCH 3 of 4 — the resolved-or-echoed return (`currency.ts:10`).
	 *
	 * QUIRK 3. A miss returns the CODE rather than nothing, because `|| currency` closes over
	 * the `undefined` the document cache produced.
	 */
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

	/*
	 * BRANCH 4 of 4 — the `else` arm reached only when `frappe.boot` is falsy
	 * (`currency.ts:11-13`).
	 *
	 * Reachable in production before the host page's boot script has run, and the reason
	 * `currency.ts` carries the branch at all. Only `frappe.boot` is falsified — never
	 * `frappe` itself, which `currency.ts:3` reads as a bare, un-chained identifier, so
	 * removing it would throw instead of taking this arm and the test would be asserting the
	 * harness rather than the module.
	 *
	 * QUIRK 4. Lines 10 and 12 return the identical expression, yet the arms are NOT
	 * equivalent: the fallback at line 8 sits inside the `if`, so an empty argument is
	 * substituted there and NOT here. The third test is the one that pins that asymmetry, and
	 * it is the assertion a future "simplification" of this `if`/`else` into a single return
	 * would break.
	 */
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
	 * QUIRK 2 — the un-optional-chained fallback (`currency.ts:8`).
	 *
	 * `frappe.boot.sysdefaults.currency` is read with no guard of its own; the only thing
	 * standing in front of it is the `frappe.boot.sysdefaults &&` test on line 5, which
	 * guards the SUPPRESSION comparison and not this read. So with `sysdefaults` absent the
	 * module divides sharply: a named currency still resolves, and an empty argument throws.
	 *
	 * This pair is asserted because it is the whole justification for the harness installing
	 * `sysdefaults.currency` (`src/test/setup.ts`, whose own comment cites this line).
	 * Pinning the throw records the real contract rather than wishing the read were chained —
	 * adding that chaining is a change to the subject, which is out of bounds here.
	 */
	describe('when the boot payload carries no system defaults at all', () => {

		/** Captured per test for the same reason as the suppression setting above. */
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

/**
 * `getCurrencyNumberFormat` is a one-line delegation to `getCurrencyProperty`
 * (`currency.ts:17`), and the delegation is the point: it carries NO `|| currency` fallback
 * of its own, so unlike `getCurrencySymbol` it answers a miss with `undefined`.
 *
 * That contract is what its only caller is written against. `numbers.ts:119-125` places the
 * call inside a `||` chain — `(cint(use_number_format_from_currency) && currency &&
 * getCurrencyNumberFormat(currency)) || getSystemDefault("number_format") || "#,###.##"` —
 * so an `undefined` here falls through to the site format and then to a hard-coded default.
 * Were a miss to become `''` or the currency code, that chain would keep the falsy value or
 * hand a currency code to the number formatter as a format string.
 */
describe('getCurrencyNumberFormat', () => {

	it('reads the number format stamped on a currency the document cache carries', () => {
		expect(getCurrencyNumberFormat(TEST_CURRENCY)).toBe(EXPECTED_NUMBER_FORMAT)
	})

	it('reads it per currency rather than once for the whole site', () => {
		expect(getCurrencyNumberFormat(ALTERNATE_CURRENCY)).toBe(EXPECTED_NUMBER_FORMAT)
	})

	/*
	 * The contrast with `getCurrencySymbol` is deliberate and is asserted rather than
	 * described: the same unknown code that gets ECHOED by the symbol reader gets `undefined`
	 * here, because only the symbol reader has a `||` fallback.
	 */
	it('answers an unknown currency with undefined instead of echoing the code', () => {
		expect(() => getCurrencyNumberFormat(UNKNOWN_CURRENCY)).not.toThrow()
		expect(getCurrencyNumberFormat(UNKNOWN_CURRENCY)).toBeUndefined()
	})

	it('answers the empty currency argument with undefined, applying no fallback', () => {
		expect(() => getCurrencyNumberFormat('')).not.toThrow()
		expect(getCurrencyNumberFormat('')).toBeUndefined()
	})
})

/**
 * `getCurrencyProperty` (`currency.ts:21-24`) is the single read both readers above resolve
 * through, and its second parameter is a typed union of exactly three literals — so the three
 * assertions below are the complete surface of what any caller can ask for.
 */
describe('getCurrencyProperty', () => {

	it('reads the symbol of a currency the document cache carries', () => {
		expect(getCurrencyProperty(TEST_CURRENCY, 'symbol')).toBe(EXPECTED_SYMBOL)
	})

	it('reads the number format of that same currency', () => {
		expect(getCurrencyProperty(TEST_CURRENCY, 'number_format')).toBe(EXPECTED_NUMBER_FORMAT)
	})

	/*
	 * QUIRK — `symbol_on_right` is the NUMBER 0, which is FALSY, and it must survive as 0
	 * rather than being coerced or defaulted. Verified against a live site and recorded at
	 * `src/test/setup.ts`.
	 *
	 * The literal `0` is written inline, and the matcher is an identity matcher, on purpose.
	 * A truthiness matcher would pass just as happily for `undefined`, `false` or `''`, and
	 * `numbers.ts:17` distinguishes exactly those cases when it reads the value as
	 * `getCurrencyProperty(…) ?? false` before testing it at `numbers.ts:24` to decide which
	 * side of the amount the symbol goes on. A `0` that decayed into `undefined` would still
	 * render correctly today and would break the moment a currency legitimately set the flag —
	 * so the pinned value is spelled out here rather than hidden behind a named constant.
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
	 * The state a page reaches when the boot payload carried no currency documents at all,
	 * which exercises the guard on the `[':Currency']` key itself rather than on the currency
	 * within it.
	 *
	 * The binding is REPLACED, never removed: `currency.ts:23` indexes `locals` at the root
	 * un-chained, so an absent global would be a `ReferenceError` and the assertion would be
	 * about the harness instead of the module.
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

		/*
		 * And the consequence for the reader above it: with nothing to resolve, the symbol
		 * reader falls all the way through to echoing whatever it was given.
		 */
		it('makes getCurrencySymbol echo the code, its last line of defence', () => {
			globalScope.locals = {}

			expect(getCurrencySymbol(TEST_CURRENCY)).toBe(TEST_CURRENCY)
		})
	})
})
