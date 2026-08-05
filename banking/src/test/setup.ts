/**
 * Global Vitest harness: reproduces the slice of the Frappe Desk runtime the SPA reads, so the
 * application mounts unmodified under jsdom.
 *
 * Everything is installed at TOP LEVEL, synchronously, because two modules read boot state while
 * being imported rather than while rendering — `useCurrentCompany`'s `atomWithStorage` initialiser
 * and `bankRecAtoms`' date default. An assignment deferred into `beforeAll`/`beforeEach` would run
 * after those initialisers and silently leave the selected company empty.
 *
 * No ambient global declaration is introduced. `frappe` and `locals` are installed through an
 * untyped `globalThis` cast so they carry no type information: the live `ts-expect-error` directives
 * in `src/lib`, `src/hooks` and `src/main.tsx` depend on those bare globals staying undeclared, and
 * typing them here would orphan the directives and fail the build with `TS2578`. `globals: true`
 * likewise exposes the Vitest API without typing it, so every Vitest symbol is imported explicitly.
 *
 * No application module is imported: production's legacy `namespace` module is reachable only from
 * `src/main.tsx`, so §3 performs the equivalent `locals` wiring rather than executing its unrelated
 * side effects.
 */

// The `/vitest` subpath is required: the package root registers Jest-style matchers, while this
// specifier ships the declarations that satisfy `noUncheckedSideEffectImports`. Registering it from
// inside `src/` augments `expect` for the whole program, so no test file needs its own import.
import '@testing-library/jest-dom/vitest'

import { afterEach, vi } from 'vitest'

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

const DEFAULT_CURRENCY = 'INR'
const ALTERNATE_CURRENCY = 'USD'

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
 * Non-secret placeholder, deliberately not credential-shaped. Both `window.csrf_token` and
 * `frappe.csrf_token` are stubbed because the boot page publishes one spelling and reads the other,
 * and no request in a test reaches a server.
 */
const CSRF_TOKEN = 'test-csrf-token'

/* ── 2. Permission surface ───────────────────────────────────────────────────────────
 * Each helper in `src/lib/permissions.ts` indexes its own `can_*` array on `boot.user`, so all
 * eight arrays must exist.
 * ────────────────────────────────────────────────────────────────────────────────── */

/**
 * `Bank Statement Import Log` grants permissions to `System Manager` ONLY — not to
 * `Accounts Manager`, not to `Accounts User` — so accounting roles alone could not render
 * the statement importer. `Bank Account` conversely has no `System Manager` row, so both
 * families are required.
 */
const TEST_ROLES = ['System Manager', 'Accounts Manager', 'Accounts User']

/**
 * The eight `can_*` arrays, transcribed from a provisioned site rather than computed: the SPA only
 * asks whether a DocType appears in one of them, so reproducing the server's `build_permissions`
 * derivation here would add a second authorisation implementation to trust and maintain.
 *
 * These arrays are shared mutable state, so a suite that narrows one assigns over it on
 * `window.frappe.boot.user` and restores what it narrowed.
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

/* ── 3. `locals`, derived from `boot.docs` by production's own rule ───────────────────
 * That rule reduces to `locals[doc.doctype][doc.name] = doc`. Declaring the documents once and
 * applying it keeps the two consumer families from disagreeing: the company picker builds its
 * options from `boot.docs`, while the `lib/company` and `lib/currency` readers read `locals`.
 * ────────────────────────────────────────────────────────────────────────────────── */

interface LocalsDocument {
	doctype: string
	name: string
	[field: string]: unknown
}

const COMPANY_DOCUMENT: LocalsDocument = {
	doctype: ':Company',
	name: TEST_COMPANY,
	default_currency: DEFAULT_CURRENCY,
	cost_center: TEST_COMPANY_COST_CENTER,
	country: TEST_COUNTRY
}

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
 * `DocType` is pre-created because production provides `locals.DocType` and `useDocType` indexes it
 * directly; an empty map keeps that hook on its "not cached yet" branch, which is the deterministic
 * state for a mocked SDK.
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
		name: TEST_USER,
		roles: [...TEST_ROLES],

		/**
		 * `company` is read at module load as well as during render, and `date_format` is
		 * upper-cased unguarded, so both have to be present.
		 */
		defaults: {
			company: TEST_COMPANY,
			date_format: DEFAULT_DATE_FORMAT
		},

		...structuredClone(USER_PERMISSIONS)
	}
}

const boot = {
	sitename: 'test.localhost',

	/** `'Light'` short-circuits `ThemeProvider`'s `prefers-color-scheme` branch, so rendering stays
	 *  deterministic. */
	desk_theme: 'Light',

	layout_direction: 'ltr',
	lang: 'en',

	time_zone: {
		system: TEST_TIME_ZONE,
		user: TEST_TIME_ZONE
	},

	docs: BOOT_DOCUMENTS,

	/**
	 * Read without optional chaining in `src/lib/currency.ts` and `src/lib/date.ts`, so this object
	 * and its `currency`/`date_format` keys must exist or those reads throw.
	 */
	sysdefaults: {
		currency: DEFAULT_CURRENCY,
		hide_currency_symbol: 'No',
		date_format: DEFAULT_DATE_FORMAT,
		number_format: DEFAULT_NUMBER_FORMAT,
		float_precision: '3',
		currency_precision: '2',
		country: TEST_COUNTRY,
		use_number_format_from_currency: '0',
		rounding_method: "Banker's Rounding",
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
	 * `src/lib/translate.ts` indexes this map without optional chaining whenever a translation
	 * context is supplied, so it must exist. Left empty so `_()` falls through to the literal source
	 * string and assertions read plainly.
	 */
	_messages: {},

	csrf_token: CSRF_TOKEN,

	/**
	 * A mocked `useDocType` is free to invoke `add_to_locals` from its `onSuccess`; reusing the same
	 * function gives production's behaviour rather than a silent no-op.
	 */
	model: {
		add_to_locals: addToLocals,
		sync: (docs: LocalsDocument[] = []) => docs.forEach(addToLocals)
	},

	flags: {} as Record<string, unknown>,
	settings: {} as Record<string, unknown>,
	defaults: {} as Record<string, unknown>
}

window.frappe = frappeNamespace

/* ── 6. Install the BARE globals ─────────────────────────────────────────────────────
 * `src/lib/currency.ts` evaluates the bare `frappe` identifier and `src/lib/company.ts` indexes the
 * bare `locals`, so an unresolved binding is a `ReferenceError` rather than a falsy check. This file
 * is a module, so a plain `const` would be module-scoped and invisible to the application; the
 * untyped cast installs true globals without the ambient typing that would orphan the live
 * `ts-expect-error` directives.
 * ────────────────────────────────────────────────────────────────────────────────── */

const globalScope = globalThis as unknown as Record<string, unknown>

globalScope.frappe = window.frappe
globalScope.locals = LOCALS
globalScope.csrf_token = CSRF_TOKEN

/* ── 7. The session cookie ───────────────────────────────────────────────────────────
 * `src/App.tsx` treats a `user_id` cookie other than `'Guest'` as signed in and otherwise redirects
 * the window. An absent cookie happens to pass today, but setting it makes the intent explicit.
 * ────────────────────────────────────────────────────────────────────────────────── */

document.cookie = `user_id=${TEST_USER}`

/* ── 8. Browser APIs jsdom does not implement ────────────────────────────────────── */

/**
 * `matchMedia` is called unconditionally by `ThemeProvider`, which wraps the whole application, and
 * by `use-mobile`. `matches: false` resolves the theme to `Light`; it does not decide the mobile
 * branch, which `useIsMobile()` derives from `window.innerWidth` — above the breakpoint under jsdom,
 * so the workbench renders its desktop layout. Echoing `query` back as `media` keeps the object
 * faithful to the real interface.
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

const matchMediaMock = vi.fn(createMediaQueryList)

window.matchMedia = matchMediaMock

/**
 * Required by the Radix primitives and by `@tanstack/react-virtual`. The callback is never invoked:
 * jsdom performs no layout, so every box it could report would be zero-sized and a synthetic
 * notification would make virtualised lists behave unlike the browser.
 */
class ResizeObserverStub {
	observe(): void { }

	unobserve(): void { }

	disconnect(): void { }
}

globalThis.ResizeObserver = ResizeObserverStub

/**
 * The Pointer Capture API, which jsdom does not implement at all.
 *
 * Radix's Select and Slider open by capturing the pointer, and its overlay primitives release it on
 * dismiss. Without these three the trigger throws `hasPointerCapture is not a function` the moment a
 * test tries to open a select, so the whole column-mapping surface of the statement importer would be
 * undrivable. They are no-ops because there is no real pointer to capture: `hasPointerCapture` reports
 * `false` so Radix follows its "capture not held" path, which is the correct branch under a synthetic
 * pointer.
 */
HTMLElement.prototype.hasPointerCapture = HTMLElement.prototype.hasPointerCapture ??
	function hasPointerCapture(): boolean {
		return false
	}

HTMLElement.prototype.setPointerCapture = HTMLElement.prototype.setPointerCapture ??
	function setPointerCapture(): void { }

HTMLElement.prototype.releasePointerCapture = HTMLElement.prototype.releasePointerCapture ??
	function releasePointerCapture(): void { }

/**
 * Radix scrolls the active option into view when a select opens. jsdom performs no layout and so ships
 * no implementation, which would otherwise abort the open.
 */
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ??
	function scrollIntoView(): void { }

/* ── 9. Per-test teardown ────────────────────────────────────────────────────────── */

afterEach(() => {
	// Unmount anything React Testing Library rendered, so the next test starts from an
	// empty document instead of inheriting the previous test's tree. It runs FIRST because
	// React effect cleanups fire during unmount and some of them still touch the SDK spies,
	// whose calls would otherwise land in freshly cleared history.
	cleanup()

	// Automatic rather than opt-in: the realtime-listener stub records callbacks in a module-level map
	// that React's unmount cleanup does not remove. It also discards per-test implementations, so
	// install those from a suite's own `beforeEach` rather than at module or `describe` scope.
	resetFrappeSDKMock()

	// `mockReset`, not `mockClear`, so a per-test override is discarded along with the history.
	matchMediaMock.mockReset()
	matchMediaMock.mockImplementation(createMediaQueryList)

	// Reconciliation UI state is persisted outside React — `localStorage` for the selected bank,
	// company, dates and filters, `sessionStorage` for the action log — so clearing both stops one
	// test's selection leaking into the next.
	localStorage.clear()
	sessionStorage.clear()
})

