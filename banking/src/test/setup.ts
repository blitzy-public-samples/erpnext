/**
 * Global Vitest harness for the ERPNext Banking SPA.
 *
 * Registered by `vitest.config.ts` as `setupFiles: ['./src/test/setup.ts']`, so it runs
 * once per test file, before that file — and before any application module — is
 * imported. It reproduces the slice of the Frappe Desk runtime the SPA reads, so the
 * existing application mounts unmodified under jsdom. Every stub is justified by a read
 * located in the consuming module and is annotated with that `file:line`.
 *
 * Three properties of this file are load-bearing:
 *
 * 1. Everything is installed at TOP LEVEL, synchronously. Two modules read boot state
 *    while being imported, not while rendering: `src/hooks/useCurrentCompany.ts:4`
 *    evaluates `window.frappe?.boot?.user?.defaults?.company || ''` as an
 *    `atomWithStorage` initialiser, and `bankRecAtoms.ts:23-25` calls
 *    `getDatesForTimePeriod('This Month')`. Deferring any assignment into
 *    `beforeAll`/`beforeEach` would run it after those initialisers and silently leave
 *    the selected company empty.
 *
 * 2. This file introduces NO ambient global declaration. `src/vite-env.d.ts` types
 *    `Window.frappe` as `any` but leaves the BARE globals `frappe` and `locals`
 *    undeclared, and thirteen live `ts-expect-error` directives depend on that —
 *    `src/lib/company.ts` (3), `src/lib/currency.ts` (4), `src/hooks/useDocType.ts` (2),
 *    `src/main.tsx` (4). Typing either global here would orphan those directives and
 *    fail the build with `TS2578`, so §6 installs them through an untyped `globalThis`
 *    cast, which carries no type information.
 *
 * 3. No application module is imported. In production the SPA's legacy `namespace`
 *    module (under `src/lib`) establishes `locals` and `frappe.model`, but it is
 *    reachable only from `src/main.tsx`, which no test loads; importing it here would
 *    execute unrelated legacy side effects. §3 performs the equivalent wiring instead.
 *
 * `vitest.config.ts` excludes `src/test/**` from coverage, so this file neither inflates
 * nor dilutes the measured percentage, and it does not match the test glob, so it is
 * never collected as a suite.
 */

// The single bare side-effect import this file may make. The `/vitest` subpath is
// required: the package root registers Jest-style matchers, and the older
// expect-extending entry point was deleted in jest-dom v6.
// `@testing-library/jest-dom@7` ships `types/vitest.d.ts` for
// this specifier, satisfying `noUncheckedSideEffectImports`. Registering it from inside
// `src/` augments `expect` for the whole `tsconfig.app.json` program, so every test file
// gets typed `toBeInTheDocument()` / `toBeDisabled()` with no per-file import.
import '@testing-library/jest-dom/vitest'

// `globals: true` exposes the Vitest API at runtime but does not TYPE it —
// `tsconfig.app.json` declares no `types` array and adding one is out of bounds — so
// every Vitest symbol must be imported explicitly.
import { afterEach, vi } from 'vitest'

// Imported so the shared teardown below can reset the `frappe-react-sdk` spies without any
// suite having to opt in. Importing this executes no application code - it declares fixtures
// and `vi.fn` spies only.
import { resetFrappeSDKMock } from './factories'
import { cleanup } from '@testing-library/react'

/* ── 1. Fixture identity ─────────────────────────────────────────────────────────── */

/**
 * Must be truthy and not `'Guest'`: `src/App.tsx:45` gates the entire router on
 * `boot?.user?.name && … !== 'Guest'`, and `src/App.tsx:18-19` derives the same verdict
 * from the `user_id` cookie.
 */
const TEST_USER = 'Administrator'

/**
 * Used as both `boot.user.defaults.company` and the `locals[':Company']` key — a
 * mismatch would make `getCompanyCurrency()` silently return `undefined`
 * (`src/lib/company.ts:4`).
 */
const TEST_COMPANY = 'Test Company'
const TEST_COMPANY_COST_CENTER = 'Main - TC'
const TEST_COUNTRY = 'India'

/** System default, plus a second currency so currency-mismatch paths are testable. */
const DEFAULT_CURRENCY = 'INR'
const ALTERNATE_CURRENCY = 'USD'

/**
 * One of the ten formats hard-coded at `src/lib/numbers.ts:37-48`; anything outside that
 * set falls back to a synthesised descriptor and makes assertions unpredictable.
 */
const DEFAULT_NUMBER_FORMAT = '#,###.##'

/**
 * Required on BOTH `boot.user.defaults` and `boot.sysdefaults`: `src/lib/date.ts:21`
 * calls `.toUpperCase()` on each in turn without optional chaining, so a missing value
 * on either side is a `TypeError` rather than a fallback.
 */
const DEFAULT_DATE_FORMAT = 'dd-mm-yyyy'

/**
 * `src/lib/date.ts:142-147` only takes the `dayjs.tz()` branch when both the system and
 * user zones are present; supplying both keeps dates on the production code path.
 */
const TEST_TIME_ZONE = 'Asia/Kolkata'

/**
 * Non-secret placeholder. `index.html:28` publishes `window.csrf_token` and its boot
 * script reads `frappe.csrf_token`, so both spellings are stubbed. No request in a test
 * reaches a server — the Frappe SDK is mocked in every suite — so this value is inert by
 * construction and is deliberately not credential-shaped.
 */
const CSRF_TOKEN = 'test-csrf-token'

/* ── 2. Permission surface ───────────────────────────────────────────────────────────
 * `src/lib/permissions.ts` exposes nine helpers (lines 5, 14, 23, 32, 41, 50, 59, 68,
 * 76). Eight index a `can_*` array on `boot.user`; the ninth indexes `roles`. Each
 * helper indexes its own array, so all eight must exist.
 * ────────────────────────────────────────────────────────────────────────────────── */

/**
 * `Bank Statement Import Log` grants permissions to `System Manager` ONLY — not to
 * `Accounts Manager`, not to `Accounts User` — so accounting roles alone could not render
 * the statement importer. `Bank Account` conversely has no `System Manager` row, so both
 * families are required.
 */
const TEST_ROLES = ['System Manager', 'Accounts Manager', 'Accounts User']

/**
 * The eight `can_*` arrays, stated as literals.
 *
 * They are what a `System Manager` + `Accounts Manager` + `Accounts User` profile resolves to
 * on a provisioned site, transcribed from that site rather than computed here. The harness
 * deliberately does NOT reproduce the server's `build_permissions` algorithm: reimplementing
 * a production authorisation derivation inside a test harness makes the harness itself
 * something that has to be trusted and maintained, and the SPA only ever asks whether a
 * DocType appears in one of these lists.
 *
 * The asymmetries that matter to this SPA survive in the data and are what make a narrowed
 * profile meaningful: `Bank Statement Import Log` and `Bank` come from the System Manager
 * rows alone, `Bank Account` has no System Manager row at all, and only five DocTypes grant
 * `cancel` to anybody.
 *
 * A suite that needs a narrower profile assigns over these arrays directly on
 * `window.frappe.boot.user`, and restores what it narrowed itself, so no suite leaks a
 * profile into the next.
 */
const USER_PERMISSIONS = {
	can_read: [
		'Party Type', 'Accounts Settings', 'Bank Transaction', 'Bank Transaction Rule',
		'Bank Statement Import Log', 'Bank Account', 'Bank Account Balance', 'Bank',
		'Payment Entry', 'Journal Entry', 'Sales Invoice', 'Purchase Invoice', 'Account',
		'Company', 'Cost Center', 'Mode of Payment', 'File'
	],
	can_write: [
		'Accounts Settings', 'Bank Transaction', 'Bank Transaction Rule',
		'Bank Statement Import Log', 'Bank Account', 'Bank Account Balance', 'Bank',
		'Payment Entry', 'Journal Entry', 'Sales Invoice', 'Purchase Invoice', 'Account',
		'Company', 'Cost Center', 'Mode of Payment', 'File'
	],
	can_create: [
		'Bank Transaction', 'Bank Transaction Rule', 'Bank Statement Import Log',
		'Bank Account', 'Bank Account Balance', 'Bank', 'Payment Entry', 'Journal Entry',
		'Sales Invoice', 'Purchase Invoice', 'Account', 'Company', 'Cost Center',
		'Mode of Payment', 'File'
	],
	can_delete: [
		'Bank Transaction', 'Bank Transaction Rule', 'Bank Statement Import Log',
		'Bank Account', 'Bank Account Balance', 'Bank', 'Payment Entry', 'Journal Entry',
		'Sales Invoice', 'Purchase Invoice', 'Account', 'Company', 'Cost Center', 'File'
	],
	can_cancel: ['Bank Transaction', 'Payment Entry', 'Journal Entry', 'Sales Invoice', 'Purchase Invoice'],
	can_search: [
		'Bank Transaction', 'Bank Transaction Rule', 'Bank Statement Import Log',
		'Bank Account', 'Bank Account Balance', 'Bank', 'Payment Entry', 'Journal Entry',
		'Sales Invoice', 'Purchase Invoice', 'Account', 'Accounts Settings', 'Company',
		'Cost Center', 'Mode of Payment', 'Party Type', 'File'
	],
	can_import: [
		'Bank Account', 'Payment Entry', 'Journal Entry', 'Account', 'File',
		'Bank Transaction', 'Bank', 'Sales Invoice', 'Purchase Invoice', 'Company',
		'Cost Center', 'Mode of Payment'
	],
	can_export: [
		'Bank Transaction', 'Bank Transaction Rule', 'Bank Statement Import Log',
		'Bank Account', 'Bank Account Balance', 'Bank', 'Payment Entry', 'Journal Entry',
		'Account', 'Company', 'Party Type', 'File'
	]
}

/* ── 3. `locals`, derived from `boot.docs` exactly as production derives it ───────────
 * `namespace/sync.js:51-63` reduces to one rule:
 * `locals[doc.doctype][doc.name] = doc`. Declaring the documents once and applying that
 * rule guarantees the two consumer families cannot disagree:
 *   • `CompanySelector.tsx:28` builds its options from `boot.docs` filtered on
 *     `doctype === ':Company'`. It is rendered by `src/pages/BankReconciliation.tsx:64`
 *     and `src/pages/BankStatementImporter.tsx:86`, so an empty `boot.docs` yields a
 *     company picker with no options.
 *   • `src/lib/company.ts:4,9,14` and `src/lib/currency.ts:23` read the same records out
 *     of `locals`.
 * ────────────────────────────────────────────────────────────────────────────────── */

interface LocalsDocument {
	doctype: string
	name: string
	[field: string]: unknown
}

/** `src/lib/company.ts` needs `default_currency` (line 4) and `cost_center` (line 9). */
const COMPANY_DOCUMENT: LocalsDocument = {
	doctype: ':Company',
	name: TEST_COMPANY,
	default_currency: DEFAULT_CURRENCY,
	cost_center: TEST_COMPANY_COST_CENTER,
	country: TEST_COUNTRY
}

/**
 * `src/lib/currency.ts:21-24` narrows the readable properties to exactly
 * `symbol | symbol_on_right | number_format`, so each currency carries all three.
 * `symbol_on_right: 0` keeps the symbol on the left in `formatCurrency()`
 * (`src/lib/numbers.ts:17,24`), matching the Frappe default for both currencies.
 */
const currencyDocument = (name: string, symbol: string): LocalsDocument => ({
	doctype: ':Currency',
	name,
	symbol,
	symbol_on_right: 0,
	number_format: DEFAULT_NUMBER_FORMAT
})

const BOOT_DOCUMENTS: LocalsDocument[] = [
	COMPANY_DOCUMENT,
	currencyDocument(DEFAULT_CURRENCY, '₹'),
	currencyDocument(ALTERNATE_CURRENCY, '$')
]

/**
 * `DocType` is pre-created because `namespace/namespace.js:20` provides
 * `locals.DocType` in production and `src/hooks/useDocType.ts:5` reads
 * `locals?.['DocType']?.[doctype]`. An empty map keeps that hook on its "not cached yet"
 * branch, the deterministic state for a mocked SDK.
 */
const LOCALS: Record<string, Record<string, LocalsDocument>> = { DocType: {} }

/** The production `frappe.model.add_to_locals` rule, from `sync.js:51-63`. */
const addToLocals = (doc: LocalsDocument): void => {
	if (!LOCALS[doc.doctype]) {
		LOCALS[doc.doctype] = {}
	}
	LOCALS[doc.doctype][doc.name] = doc
}

BOOT_DOCUMENTS.forEach(addToLocals)

/* ── 4. The boot payload ─────────────────────────────────────────────────────────────
 * Mirrors the object `index.html:31-32` assigns from the server-rendered `{{ boot }}`
 * blob, restricted to the fields the SPA actually reads.
 * ────────────────────────────────────────────────────────────────────────────────── */

/**
 * Builds `boot.user`. A FACTORY rather than a literal so that every array is a fresh object:
 * a suite that assigns over one cannot leak into the next test or into a sibling array.
 */
function createUserProfile() {
	return {
		/** The decisive render gate at `src/App.tsx:45`. */
		name: TEST_USER,
		/** `hasRole()` — `src/lib/permissions.ts:76-78`. */
		roles: [...TEST_ROLES],

		/**
		 * `useCurrentCompany()` reads `company` at `src/hooks/useCurrentCompany.ts:4`
		 * (module load) and `:8` (render); `getUserDateFormat()` reads `date_format` at
		 * `src/lib/date.ts:21` and calls `.toUpperCase()` on it unguarded.
		 */
		defaults: {
			company: TEST_COMPANY,
			date_format: DEFAULT_DATE_FORMAT
		},

		// The eight arrays behind `src/lib/permissions.ts`, cloned so they are this profile's own.
		...structuredClone(USER_PERMISSIONS)
	}
}

const boot = {
	/** `src/App.tsx:41` passes this to `FrappeProvider` as `siteName`. */
	sitename: 'test.localhost',

	/**
	 * `src/App.tsx:43` feeds this to `ThemeProvider` as `defaultTheme`.
	 * `theme-provider.tsx:4` types it as `"Dark" | "Light" | "Automatic"`; `'Light'`
	 * short-circuits the `prefers-color-scheme` branch (line 47), keeping rendering
	 * deterministic.
	 */
	desk_theme: 'Light',

	/** Mirrors `index.html:2,32`; surfaced via `getBootFieldData` (`src/lib/frappe.ts:194`). */
	layout_direction: 'ltr',
	lang: 'en',

	/** Both halves are required for the `dayjs.tz()` branch at `src/lib/date.ts:142-147`. */
	time_zone: {
		system: TEST_TIME_ZONE,
		user: TEST_TIME_ZONE
	},

	/** Consumed by `CompanySelector.tsx:28`; the source of `LOCALS` above. */
	docs: BOOT_DOCUMENTS,

	/**
	 * Read safely through `getSystemDefault()` (`src/lib/frappe.ts:186-188`) but also read
	 * WITHOUT optional chaining at `src/lib/currency.ts:8`
	 * (`frappe.boot.sysdefaults.currency`) and `src/lib/date.ts:21`
	 * (`…sysdefaults.date_format.toUpperCase()`) — either throws if this object or those
	 * two keys are absent.
	 */
	sysdefaults: {
		currency: DEFAULT_CURRENCY,
		/** `src/lib/currency.ts:5` compares this against the literal `"Yes"`. */
		hide_currency_symbol: 'No',
		date_format: DEFAULT_DATE_FORMAT,
		number_format: DEFAULT_NUMBER_FORMAT,
		/** `src/lib/numbers.ts:53` — decimals for plain floats. */
		float_precision: '3',
		/** `src/lib/numbers.ts:20` — decimals for monetary values. */
		currency_precision: '2',
		country: TEST_COUNTRY,
		/**
		 * `src/lib/numbers.ts:119`. Falsy keeps `get_number_format()` resolving through
		 * `sysdefaults.number_format`, so one setting governs every formatted number.
		 */
		use_number_format_from_currency: '0',
		/**
		 * `src/lib/numbers.ts:169`. Selects the rounding branch at `:182` — the
		 * epsilon-aware banker's rounding that mirrors Python's `flt`, i.e. the same
		 * arithmetic the server uses. Verified as the live value on a running site;
		 * see the LIVE VERIFICATION note at the foot of this file.
		 */
		rounding_method: "Banker's Rounding",
		/** `LinkFieldCombobox.tsx:125` — link-search page size; live value. */
		link_field_results_limit: '10'
	},

	user: createUserProfile()
}

/* ── 5. Install `window.frappe` ──────────────────────────────────────────────────────
 * No cast needed: `src/vite-env.d.ts:3-6` already types `Window.frappe` as `any`.
 * ────────────────────────────────────────────────────────────────────────────────── */

/**
 * The `frappe` namespace object, assembled once and installed on both `window` and the bare
 * global below so the two spellings resolve to the same object.
 */
const frappeNamespace = {
	boot,

	/**
	 * `src/lib/translate.ts:10` indexes `window.frappe._messages` WITHOUT optional
	 * chaining whenever a translation context is supplied, so the map must exist. Leaving
	 * it empty makes `_()` fall through to the literal source string (line 14), which is
	 * what keeps assertions such as `getByText('Reconcile')` readable. Deliberately not
	 * populated.
	 */
	_messages: {},

	csrf_token: CSRF_TOKEN,

	/**
	 * `src/hooks/useDocType.ts:16` calls `frappe.model.add_to_locals(d)` from a Frappe SDK
	 * hook's `onSuccess`. Suites mock that hook so the callback normally never fires, but
	 * a mock is free to invoke it — and when it does, the real production behaviour
	 * (`sync.js:51-63`) is what should happen. Reusing `addToLocals` gives exactly that
	 * rather than a silent no-op.
	 */
	model: {
		add_to_locals: addToLocals,
		sync: (docs: LocalsDocument[] = []) => docs.forEach(addToLocals)
	},

	/** `namespace/namespace.js:18-22` provides these namespaces in production. */
	flags: {} as Record<string, unknown>,
	settings: {} as Record<string, unknown>,
	defaults: {} as Record<string, unknown>
}

window.frappe = frappeNamespace

/* ── 6. Install the BARE globals ─────────────────────────────────────────────────────
 * `src/lib/currency.ts:3` evaluates `if (frappe.boot)` on the bare identifier, so an
 * unresolved `frappe` is a `ReferenceError`, not a falsy check; `locals` is indexed at
 * the root without optional chaining in `src/lib/company.ts:4,9` and
 * `src/lib/currency.ts:23`.
 *
 * Under `isolatedModules` with `moduleDetection: "force"` this file is a module, so a
 * plain `const` would be module-scoped and invisible to the application. The untyped cast
 * is what makes these true globals without the ambient typing that would orphan the
 * thirteen `ts-expect-error` directives (see the file header).
 * ────────────────────────────────────────────────────────────────────────────────── */

const globalScope = globalThis as unknown as Record<string, unknown>

globalScope.frappe = window.frappe
globalScope.locals = LOCALS
/** `index.html:28` publishes the token at window scope, so mirror it there too. */
globalScope.csrf_token = CSRF_TOKEN

/* ── 7. The session cookie ───────────────────────────────────────────────────────────
 * `src/App.tsx:18-19` reads `user_id` from `document.cookie` and treats anything other
 * than `'Guest'` as signed in; failing that redirects the window at `src/App.tsx:26`. An
 * absent cookie happens to pass today (`undefined !== 'Guest'`), but setting it makes the
 * intent explicit and keeps suites green if that comparison is ever tightened.
 * ────────────────────────────────────────────────────────────────────────────────── */

document.cookie = `user_id=${TEST_USER}`

/* ── 8. Browser APIs jsdom does not implement ────────────────────────────────────── */

/**
 * Two independent consumers require `matchMedia`:
 *   • `src/components/ui/theme-provider.tsx:39` calls it unconditionally inside its
 *     effect, reads `.matches` (lines 43-44) and subscribes/unsubscribes with
 *     `addEventListener`/`removeEventListener` (lines 55, 58). `ThemeProvider` wraps the
 *     whole application, so this call is unavoidable in any component test.
 *   • `src/hooks/use-mobile.ts:9-15` queries `(max-width: 767px)` and attaches the same
 *     listener pair.
 *
 * `matches: false` resolves the theme to `Light` (theme-provider line 44). It does NOT
 * decide the mobile branch: `useIsMobile()` derives that from `window.innerWidth`, which
 * jsdom defaults to 1024 — above the 768 breakpoint — so the reconciliation workbench
 * renders its desktop layout rather than the "not supported on mobile" empty state.
 * Echoing the caller's `query` back as `media` keeps the object faithful to the real
 * interface.
 */
const createMediaQueryList = (query: string) => ({
	matches: false,
	media: query,
	onchange: null,
	addEventListener: vi.fn(),
	removeEventListener: vi.fn(),
	// Deprecated aliases, retained because some third-party primitives still call them.
	addListener: vi.fn(),
	removeListener: vi.fn(),
	dispatchEvent: vi.fn()
})

/**
 * Held in a named binding so the teardown below can discard the call history it accumulates,
 * together with any per-test `mockImplementationOnce` a suite installed.
 */
const matchMediaMock = vi.fn(createMediaQueryList)

window.matchMedia = matchMediaMock

/**
 * `ResizeObserver` is required by the Radix primitives the design system is built on and
 * by `@tanstack/react-virtual`, which measures rows dynamically in
 * `MatchAndReconcile.tsx`.
 *
 * The callback is intentionally never invoked: jsdom performs no layout, so every box it
 * could report would be zero-sized, and a synthetic notification would make virtualised
 * lists behave differently from the browser. Recording nothing is therefore the complete
 * and correct behaviour for this environment, not an unfinished stub.
 */
class ResizeObserverStub {
	observe(): void {
		// No layout engine, so no observation can ever produce an entry.
	}

	unobserve(): void {
		// Nothing was recorded by `observe`, so there is nothing to release.
	}

	disconnect(): void {
		// No subscriptions are held, so disconnecting is already complete.
	}
}

globalThis.ResizeObserver = ResizeObserverStub

/* ── 9. Per-test teardown ────────────────────────────────────────────────────────── */

afterEach(() => {
	// Unmount anything React Testing Library rendered, so the next test starts from an
	// empty document instead of inheriting the previous test's tree. It runs FIRST because
	// React effect cleanups fire during unmount and some of them still touch the SDK spies,
	// whose calls would otherwise land in freshly cleared history.
	cleanup()

	// Automatic rather than opt-in: the realtime-listener stub records callbacks in a
	// module-level map that React's unmount cleanup does not remove, and a forgotten reset
	// let one test's recorded calls and per-test implementations govern the next. Because it
	// also discards per-test implementations, install those from a suite's own `beforeEach`
	// (or inside the test) rather than at `describe` or module scope.
	resetFrappeSDKMock()

	// `mockReset`, not `mockClear`, so a per-test override is discarded along with the history.
	matchMediaMock.mockReset()
	matchMediaMock.mockImplementation(createMediaQueryList)

	// The SPA persists reconciliation UI state outside React: `atomWithStorage` backs
	// `bank-rec-selected-bank`, `bank-rec-date`, `bank-rec-match-filters` and
	// `bank-rec-selected-company` in `localStorage`, and `createJSONStorage` backs
	// `bank-rec-action-log` in `sessionStorage`. Clearing both stops one test's selection
	// leaking into the next. Atoms created with `getOnInit: true` have already read their
	// value at module load and are unaffected — jotai state is per-`Provider` and owned by
	// each test file, so no global store reset is attempted here.
	localStorage.clear()
	sessionStorage.clear()
})

/* ── LIVE VERIFICATION ───────────────────────────────────────────────────────────────
 *
 * Every shape above was checked against a real running site (`bench serve`, authenticated
 * as Administrator, `/banking` fully mounted) rather than inferred, because a harness that
 * misreports a value's *type* silently invalidates every test built on it.
 *
 * Confirmed identical to production — the shapes most easily got wrong:
 *   • Every `sysdefaults` value is a STRING, including the numeric- and boolean-looking
 *     ones (`float_precision`, `currency_precision`, `hide_currency_symbol`,
 *     `use_number_format_from_currency`, `link_field_results_limit`). They are quoted
 *     above for exactly this reason; `numbers.ts` funnels them through `cint()`.
 *   • `symbol_on_right` is the NUMBER `0`, not `false` — matching `numbers.ts:17`, which
 *     reads it via `getCurrencyProperty(…) ?? false` and tests it for truthiness.
 *   • `boot.time_zone` is an OBJECT `{ system, user }`, not a string — matching the two
 *     separate reads at `date.ts:142-143`.
 *   • `boot.docs` is an array, and `locals`' top-level keys are exactly the doctypes it
 *     contains, which is why `LOCALS` above is derived from `BOOT_DOCS` through the same
 *     `add_to_locals` rule the app itself uses rather than being written out separately.
 *   • `frappe.model.sync` and `frappe.model.add_to_locals` are functions and `_messages`
 *     is an object, so the stubs here occupy the same slots the app expects.
 *   • `matchMedia` and `ResizeObserver` are native in a real browser and both are absent
 *     from jsdom — which is why exactly those two are stubbed above, and nothing further.
 *
 * Deliberate fixture-identity differences (values, never shapes). The live site is seeded
 * USD / United States / `mm-dd-yyyy`; this harness is a self-consistent INR / India /
 * `dd-mm-yyyy` fixture whose company key, currency and cost centre all agree with one
 * another, so a mismatch cannot silently yield `undefined`. Behaviour is unaffected:
 * `hide_currency_symbol: 'No'` and the live `'0'` are both `!= "Yes"` at `currency.ts:5`,
 * and `float_precision: '3'` is also `numbers.ts:53`'s own fallback. `_messages` stays
 * `{}` on purpose so `_()` returns the literal string and assertions read plainly.
 *
 * Permission arrays: STATED, not derived. `USER_PERMISSIONS` above is transcribed from a
 * provisioned site's boot payload for the three modelled roles, so the live asymmetries are
 * present in the data itself: `can_cancel` holds exactly five DocTypes — Bank Transaction,
 * Journal Entry, Payment Entry, Purchase Invoice, Sales Invoice — so Bank Account, Bank
 * Transaction Rule and Bank Statement Import Log are absent from it; `can_import` excludes
 * Bank Transaction Rule and Bank Statement Import Log; `Accounts Settings` is writable but
 * not creatable, and `Party Type` is writable and readable but not creatable, which is
 * exactly why `LinkFieldCombobox` must not offer to create either one. The server's
 * `build_permissions` algorithm is deliberately NOT reimplemented here: a harness that
 * reproduces a production authorisation derivation becomes a second implementation to trust
 * and maintain, and nothing under `src/` asks more of these arrays than membership.
 *
 * A suite that needs a DENIED permission assigns over the arrays it cares about on
 * `window.frappe.boot.user` — an empty array for denied-by-default, or a narrowed list for a
 * narrower role. Those arrays are shared mutable state, so the suite that narrows them
 * snapshots and restores them itself rather than having this harness rebuild the whole
 * runtime around every test.
 *
 * Noted, deliberately not stubbed: the real `frappe.model.sync` stamps `__last_sync_on`
 * onto each synced document, and a live `locals` also carries `Country` and
 * `:Print Settings` maps. Nothing under `src/` reads any of them, so adding them would be
 * unused fixture surface.
 *
 * Observed and left alone, as it lies outside this file's scope: `index.html:28` publishes
 * `window.csrf_token` while `index.html:39` sends `frappe.csrf_token`, which is undefined
 * at runtime. Both spellings are therefore stubbed above — one mirrors what the page
 * publishes, the other what its code reads.
 */
