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
import { afterEach, beforeEach, vi } from 'vitest'

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
 * The bounded universe of DocTypes this harness models. Sourced from the working tree: the
 * reconciliation and import core plus the voucher types a manual override may link to; the
 * DocTypes reached through Frappe SDK document hooks (Account, Accounts Settings, Bank
 * Account Balance, Bank Statement Import Log, Bank Transaction, Bank Transaction Rule,
 * Party Type); and the DocTypes passed to `LinkFieldCombobox`, which calls
 * `canCreateDocument(doctype)` at `src/components/common/LinkFieldCombobox.tsx:130`
 * (Company, Cost Center, Mode of Payment, Payment Entry Deduction).
 *
 * Membership of this list is NOT itself a grant. What each `can_*` array contains is
 * DERIVED below from the real DocPerm rows and DocType flags, exactly as the server
 * derives them, so the harness reproduces production authorisation rather than asserting
 * a blanket one.
 */
const MODELLED_DOCTYPES = [
	'Bank Transaction',
	'Bank Transaction Rule',
	'Bank Statement Import Log',
	'Bank Account',
	'Bank Account Balance',
	'Bank',
	'Payment Entry',
	'Payment Entry Deduction',
	'Journal Entry',
	'Sales Invoice',
	'Purchase Invoice',
	'Account',
	'Accounts Settings',
	'Company',
	'Cost Center',
	'Mode of Payment',
	'Party Type',
	'File'
]

/**
 * The DocType flags `build_permissions` branches on (`frappe/frappe/utils/user.py`).
 * Transcribed from `tabDocType` on a provisioned site, so only the non-default values are
 * listed and every omission means "0":
 *
 *   • `Payment Entry Deduction` is the only child table (`istable`), which is why it
 *     reaches NO array — Frappe excludes child tables from create/write/read/search, and
 *     it carries no DocPerm rows of its own either.
 *   • `Accounts Settings` is the only Single (`issingle`), so it can be written but never
 *     "created".
 *   • `Party Type` is the only `in_create` DocType, so it is writable and readable but is
 *     excluded from `can_create` — which is exactly why `LinkFieldCombobox` must not offer
 *     to create one.
 *   • `read_only` is 0 for all eighteen, so the `all_read` / no-list-view-link branch of
 *     the server's algorithm is unreachable here and is deliberately not modelled.
 */
const DOCTYPE_FLAGS: Record<string, { istable?: boolean, issingle?: boolean, in_create?: boolean, allow_import?: boolean }> = {
	'Account': { allow_import: true },
	'Accounts Settings': { issingle: true },
	'Bank': { allow_import: true },
	'Bank Account': { allow_import: true },
	'Bank Account Balance': {},
	'Bank Statement Import Log': {},
	'Bank Transaction': { allow_import: true },
	'Bank Transaction Rule': {},
	'Company': { allow_import: true },
	'Cost Center': { allow_import: true },
	'File': { allow_import: true },
	'Journal Entry': { allow_import: true },
	'Mode of Payment': { allow_import: true },
	'Party Type': { in_create: true },
	'Payment Entry': { allow_import: true },
	'Payment Entry Deduction': { istable: true },
	'Purchase Invoice': { allow_import: true },
	'Sales Invoice': { allow_import: true }
}

/**
 * The rights `build_permissions` consults on the way to the eight arrays
 * `src/lib/permissions.ts` reads.
 *
 * `submit`, `amend`, `report`, `print`, `email`, `share` and `select` are deliberately NOT
 * modelled: none of those eight arrays is derived from them, so including them would be
 * unused fixture surface — the same reasoning applied elsewhere in this file.
 */
type DocPermRight = 'read' | 'write' | 'create' | 'delete' | 'cancel' | 'import' | 'export'

interface DocPermRow {
	doctype: string
	role: string
	rights: Set<DocPermRight>
}

/** Declares one DocPerm row; only the GRANTED rights are named, every omission is a zero. */
const perm = (doctype: string, role: string, granted: string): DocPermRow => ({
	doctype,
	role,
	rights: new Set(granted.split(' ').filter(Boolean) as DocPermRight[])
})

/**
 * The authoritative DocPerm rows for the three modelled roles, read from `tabDocPerm` on a
 * provisioned site rather than invented.
 *
 * Two DocTypes ship a second, narrower Accounts Manager row upstream (Purchase Invoice and
 * Sales Invoice each have a read+write-only row alongside the full one). Those pairs are
 * merged here by union, which is precisely what the server's own `build_perm_map` does when
 * it ORs every matching row together — so one row per (DocType, role) pair is faithful, not
 * a simplification.
 *
 * The asymmetries that matter for this SPA are visible directly in the data: `Bank
 * Statement Import Log` and `Bank` are granted to System Manager ONLY, `Bank Account` has
 * no System Manager row at all, `Accounts User` gets read-only Company / Cost Center /
 * Mode of Payment, and only five DocTypes grant `cancel` to anyone.
 */
const DOCPERM_ROWS: DocPermRow[] = [
	perm('Account', 'Accounts Manager', 'read write create delete import export'),
	perm('Account', 'Accounts User', 'read write create delete import export'),
	perm('Accounts Settings', 'Accounts Manager', 'read write create'),
	perm('Bank', 'System Manager', 'read write create delete export'),
	perm('Bank Account', 'Accounts Manager', 'read write create delete import export'),
	perm('Bank Account', 'Accounts User', 'read write create delete export'),
	perm('Bank Account Balance', 'Accounts Manager', 'read write create delete export'),
	perm('Bank Account Balance', 'Accounts User', 'read write create delete export'),
	perm('Bank Account Balance', 'System Manager', 'read write create delete export'),
	perm('Bank Statement Import Log', 'System Manager', 'read write create delete export'),
	perm('Bank Transaction', 'Accounts Manager', 'read write create delete cancel export'),
	perm('Bank Transaction', 'Accounts User', 'read write create delete export'),
	perm('Bank Transaction', 'System Manager', 'read write create delete cancel export'),
	perm('Bank Transaction Rule', 'Accounts Manager', 'read write create delete export'),
	perm('Bank Transaction Rule', 'Accounts User', 'read write create delete export'),
	perm('Bank Transaction Rule', 'System Manager', 'read write create delete export'),
	perm('Company', 'Accounts Manager', 'read write create delete export'),
	perm('Company', 'Accounts User', 'read'),
	perm('Company', 'System Manager', 'read write create delete'),
	perm('Cost Center', 'Accounts Manager', 'read write create delete'),
	perm('Cost Center', 'Accounts User', 'read'),
	perm('File', 'System Manager', 'read write create delete import export'),
	perm('Journal Entry', 'Accounts Manager', 'read write create delete cancel import export'),
	perm('Journal Entry', 'Accounts User', 'read write create delete cancel'),
	perm('Mode of Payment', 'Accounts Manager', 'read write create'),
	perm('Mode of Payment', 'Accounts User', 'read'),
	perm('Party Type', 'Accounts Manager', 'read export'),
	perm('Party Type', 'Accounts User', 'read export'),
	perm('Party Type', 'System Manager', 'read export'),
	perm('Payment Entry', 'Accounts Manager', 'read write create delete cancel import export'),
	perm('Payment Entry', 'Accounts User', 'read write create delete cancel import export'),
	perm('Purchase Invoice', 'Accounts Manager', 'read write create delete cancel'),
	perm('Purchase Invoice', 'Accounts User', 'read write create cancel'),
	perm('Sales Invoice', 'Accounts Manager', 'read write create delete cancel'),
	perm('Sales Invoice', 'Accounts User', 'read write create')
]

/** The eight arrays `src/lib/permissions.ts` indexes, and nothing else. */
export interface UserPermissionArrays {
	can_read: string[]
	can_write: string[]
	can_create: string[]
	can_delete: string[]
	can_cancel: string[]
	can_search: string[]
	can_import: string[]
	can_export: string[]
}

/**
 * Derives the eight `can_*` arrays for a set of roles, following the server's own
 * `build_permissions` algorithm (`frappe/frappe/utils/user.py`) step for step:
 *
 *  1. Rights are OR-ed across every DocPerm row whose role the user holds.
 *  2. Child tables are excluded from create / write / read / search entirely.
 *  3. `create && !issingle` places a DocType in `can_create`, or in the internal
 *     `in_create` bucket when the DocType is `in_create`; otherwise `write` places it in
 *     `can_write`; otherwise `read` places it in `can_read`.
 *  4. `cancel` and `delete` are independent of that chain.
 *  5. `import` and `export` require read, write or create first.
 *  6. `can_search` needs read, write or create and a non-child DocType; Singles and
 *     read-only DocTypes are excluded for every user EXCEPT Administrator, which is the
 *     one place the fixture identity changes the result.
 *  7. The buckets cascade upward: `can_write += can_create + in_create`, then
 *     `can_read += can_write`.
 *  8. A System Manager additionally gains `can_import` for every importable DocType —
 *     applied here across the modelled universe, which is what keeps the fixture bounded.
 *
 * DocShare and Property Setter contributions are omitted: the harness seeds neither, so
 * both would add empty sets.
 *
 * This is what replaces the previous blanket grant, and it is why a suite can now write a
 * meaningful NEGATIVE authorisation test: the arrays genuinely differ per role, so
 * `installRoleProfile(['Accounts User'])` really cannot read `Bank Statement Import Log`.
 */
export const buildUserPermissions = (roles: string[], userName: string = TEST_USER): UserPermissionArrays => {
	const held = new Set(roles)

	const canCreate: string[] = []
	const inCreate: string[] = []
	const canWrite: string[] = []
	const canRead: string[] = []
	const canDelete: string[] = []
	const canCancel: string[] = []
	const canSearch: string[] = []
	const canImport: string[] = []
	const canExport: string[] = []

	MODELLED_DOCTYPES.forEach((doctype) => {
		const flags = DOCTYPE_FLAGS[doctype] ?? {}

		const granted = new Set<DocPermRight>()
		DOCPERM_ROWS.forEach((row) => {
			if (row.doctype === doctype && held.has(row.role)) {
				row.rights.forEach((right) => granted.add(right))
			}
		})

		if (!flags.istable) {
			if (granted.has('create') && !flags.issingle) {
				(flags.in_create ? inCreate : canCreate).push(doctype)
			} else if (granted.has('write')) {
				canWrite.push(doctype)
			} else if (granted.has('read')) {
				canRead.push(doctype)
			}
		}

		if (granted.has('cancel')) {
			canCancel.push(doctype)
		}

		if (granted.has('delete')) {
			canDelete.push(doctype)
		}

		if (granted.has('read') || granted.has('write') || granted.has('create')) {
			if (granted.has('import')) {
				canImport.push(doctype)
			}

			if (granted.has('export')) {
				canExport.push(doctype)
			}

			if (!flags.istable && (userName === 'Administrator' || !flags.issingle)) {
				canSearch.push(doctype)
			}
		}
	})

	const write = [...canWrite, ...canCreate, ...inCreate]
	const read = [...canRead, ...write]

	const importable = held.has('System Manager')
		? Array.from(new Set([...canImport, ...MODELLED_DOCTYPES.filter((doctype) => DOCTYPE_FLAGS[doctype]?.allow_import)]))
		: canImport

	return {
		can_read: read,
		can_write: write,
		can_create: canCreate,
		can_delete: canDelete,
		can_cancel: canCancel,
		can_search: canSearch,
		can_import: importable,
		can_export: canExport
	}
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
 * Builds `boot.user`. A FACTORY rather than a literal for two reasons: every array is a
 * fresh object, so a test that mutates one cannot leak into another test or into a sibling
 * array; and {@link installRoleProfile} can rebuild the whole profile for a different role
 * set without hand-assembling it.
 */
function createUserProfile(roles: string[], userName: string) {
	return {
		/** The decisive render gate at `src/App.tsx:45`. */
		name: userName,
		/** `hasRole()` — `src/lib/permissions.ts:76-78`. */
		roles: [...roles],

		/**
		 * `useCurrentCompany()` reads `company` at `src/hooks/useCurrentCompany.ts:4`
		 * (module load) and `:8` (render); `getUserDateFormat()` reads `date_format` at
		 * `src/lib/date.ts:21` and calls `.toUpperCase()` on it unguarded.
		 */
		defaults: {
			company: TEST_COMPANY,
			date_format: DEFAULT_DATE_FORMAT
		},

		// The eight arrays behind `src/lib/permissions.ts`, DERIVED from the DocPerm rows
		// above rather than granted wholesale.
		...buildUserPermissions(roles, userName)
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

	/** Mirrors `index.html:2,32`; surfaced via `getBootFieldData` (`src/lib/frappe.ts:93`). */
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
	 * Read safely through `getSystemDefault()` (`src/lib/frappe.ts:85-87`) but also read
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

	user: createUserProfile(TEST_ROLES, TEST_USER)
}

/* ── 5. Install `window.frappe` ──────────────────────────────────────────────────────
 * No cast needed: `src/vite-env.d.ts:3-6` already types `Window.frappe` as `any`.
 * ────────────────────────────────────────────────────────────────────────────────── */

/**
 * The `frappe` namespace object, held in a const so {@link resetHarnessState} can restore
 * it - and reset the mutable maps inside it - rather than leaving a test's pollution in
 * place for the next one.
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

/* ── 7b. Per-test reconstruction of the Frappe runtime ───────────────────────────────
 * Everything above is installed once, synchronously, at module scope - that ordering is
 * load-bearing and is preserved exactly (see the file header). What follows ADDS a rebuild
 * of the same state around every test, because installing once is not isolation: boot
 * data, the eight permission arrays, `locals`, the translation map and the cookie are all
 * mutable objects reachable from any test through a global, so one test narrowing a
 * permission array or stamping a document into `locals` would otherwise change the
 * environment every later test runs in.
 * ────────────────────────────────────────────────────────────────────────────────── */

/** Pristine copies taken before any test can touch them, so restoration cannot drift. */
const PRISTINE_SYSDEFAULTS = structuredClone(boot.sysdefaults)
const PRISTINE_BOOT_DOCUMENTS = structuredClone(BOOT_DOCUMENTS)

/**
 * Rebuilds `locals` from a document set using the production rule, clearing whatever was
 * there first. The object IDENTITY is preserved rather than replaced, so any module that
 * captured the global still sees the rebuilt contents.
 */
const rebuildLocals = (docs: LocalsDocument[]): void => {
	Object.keys(LOCALS).forEach((doctype) => {
		delete LOCALS[doctype]
	})

	LOCALS.DocType = {}
	docs.forEach(addToLocals)
}

/**
 * Installs a role profile, deriving the eight `can_*` arrays from the real DocPerm rows.
 *
 * This is the affordance that makes a NEGATIVE authorisation test possible, which the
 * previous blanket grant could not express:
 *
 *     installRoleProfile(['Accounts User'])   // cannot read Bank Statement Import Log
 *     installRoleProfile([])                  // every array empty: denied by default
 *     installRoleProfile(TEST_ROLES, 'accountant@example.com')
 *
 * The second argument also lets a suite stop modelling the superuser: `Administrator` is
 * the one identity the server's own algorithm treats specially (it keeps Singles in
 * `can_search`), so passing an ordinary user name exercises the same path a real reviewer
 * would. The cookie is re-set to match, because `src/App.tsx:18-19` gates rendering on it.
 *
 * The default profile is restored before and after every test, so a suite calling this
 * cannot leak its narrowed profile into another test.
 */
export const installRoleProfile = (roles: string[], userName: string = TEST_USER): void => {
	boot.user = createUserProfile(roles, userName)
	document.cookie = `user_id=${userName}`
}

/**
 * Restores the whole harness to its as-installed state: the default role profile and its
 * derived permission arrays, a fresh `sysdefaults`, a fresh document set with `locals`
 * rebuilt from those very documents (so the two cannot disagree), empty translation and
 * namespace maps, and the three bare globals plus the cookie re-pointed at them.
 */
const resetHarnessState = (): void => {
	installRoleProfile(TEST_ROLES, TEST_USER)

	boot.sysdefaults = structuredClone(PRISTINE_SYSDEFAULTS)

	const docs = structuredClone(PRISTINE_BOOT_DOCUMENTS)
	boot.docs = docs
	rebuildLocals(docs)

	frappeNamespace.boot = boot
	frappeNamespace._messages = {}
	frappeNamespace.flags = {}
	frappeNamespace.settings = {}
	frappeNamespace.defaults = {}

	window.frappe = frappeNamespace
	globalScope.frappe = frappeNamespace
	globalScope.locals = LOCALS
	globalScope.csrf_token = CSRF_TOKEN
}

beforeEach(resetHarnessState)

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

/**
 * jsdom implements no scrolling, so `Element.prototype.scrollIntoView` is absent and any
 * call to it is a `TypeError`. `cmdk` — the engine behind `@/components/ui/command`, and
 * therefore behind `CompanySelector` and the `LinkFieldCombobox` used to pick an override
 * voucher — calls `scrollIntoView({ block: 'nearest' })` every time the active item
 * changes, so merely opening one of those popovers throws without this.
 *
 * Verified rather than assumed: mounting `CompanySelector` and opening its popover fails
 * with `TypeError: e.scrollIntoView is not a function` until this is installed. Keeping
 * the active option in view has no observable meaning in a headless DOM, so doing nothing
 * is the complete behaviour here.
 */
Element.prototype.scrollIntoView = function scrollIntoView(): void {
	// No viewport and no scrolling in jsdom, so there is nothing to bring into view.
}

/**
 * jsdom implements no pointer-capture API. Radix's Select primitive — which backs
 * `@/components/ui/select`, and therefore `RawTableGrid` in the statement importer,
 * `Rules/RuleForm`, `Preferences` and `PartyTypeDropdown` — interrogates
 * `hasPointerCapture()` on `pointerdown` before it will open its listbox.
 *
 * Verified rather than assumed: without these three methods a `userEvent.click()` on a
 * Select trigger silently does nothing and the test fails with the misleading
 * "Unable to find role=option" instead of a missing-API error; installing them makes the
 * same interaction open the listbox and render its options.
 *
 * `hasPointerCapture` returns `false` because no element ever captures a pointer here,
 * which is the honest answer and the one that keeps Radix on its normal open path.
 */
Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
	return false
}

Element.prototype.setPointerCapture = function setPointerCapture(): void {
	// No pointer-capture bookkeeping exists to update.
}

Element.prototype.releasePointerCapture = function releasePointerCapture(): void {
	// Nothing was ever captured, so there is nothing to release.
}

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

	// Rebuild the Frappe runtime AFTER the test as well as before it. Doing both ends is
	// deliberate: `beforeEach` protects the test that is about to run, while this call makes
	// sure nothing a test installed - a narrowed permission array, a synced document, a
	// translation override, a changed identity cookie - is still observable to anything that
	// inspects the environment between tests, or to a `beforeAll` in a later suite.
	resetHarnessState()
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
 *   • `matchMedia`, `ResizeObserver`, `scrollIntoView`, `hasPointerCapture`,
 *     `setPointerCapture` and `releasePointerCapture` are all native functions in a real
 *     browser and all six are absent from jsdom — which is why all six are stubbed above.
 *
 * Deliberate fixture-identity differences (values, never shapes). The live site is seeded
 * USD / United States / `mm-dd-yyyy`; this harness is a self-consistent INR / India /
 * `dd-mm-yyyy` fixture whose company key, currency and cost centre all agree with one
 * another, so a mismatch cannot silently yield `undefined`. Behaviour is unaffected:
 * `hide_currency_symbol: 'No'` and the live `'0'` are both `!= "Yes"` at `currency.ts:5`,
 * and `float_precision: '3'` is also `numbers.ts:53`'s own fallback. `_messages` stays
 * `{}` on purpose so `_()` returns the literal string and assertions read plainly.
 *
 * Permission arrays: DERIVED, not granted. `DOCPERM_ROWS` and `DOCTYPE_FLAGS` above are
 * transcribed from `tabDocPerm` and `tabDocType` on a provisioned site, and
 * `buildUserPermissions` reproduces the server's own `build_permissions` algorithm over
 * them, so the harness reproduces production authorisation instead of asserting a blanket
 * one. The derivation is what makes the live asymmetries appear by themselves rather than
 * having to be remembered:
 *   • `can_cancel` contains exactly five DocTypes — Bank Transaction, Journal Entry,
 *     Payment Entry, Purchase Invoice, Sales Invoice — so Bank Account, Bank Transaction
 *     Rule and Bank Statement Import Log are absent, matching the live Administrator.
 *   • `can_import` excludes Bank Transaction Rule and Bank Statement Import Log, again
 *     matching the live payload: neither DocType grants `import` and neither is
 *     `allow_import`, so the System Manager expansion cannot reach them either.
 *   • `Payment Entry Deduction` reaches NO array, because a child table is excluded from
 *     create/write/read/search and carries no DocPerm rows of its own.
 *   • `Accounts Settings` is writable but not creatable (Single), and `Party Type` is
 *     writable and readable but not creatable (`in_create`) — which is exactly why
 *     `LinkFieldCombobox` must not offer to create either one.
 * The System Manager import expansion is applied across the MODELLED universe rather than
 * every importable DocType on a site, which keeps the fixture bounded; that is the single
 * deliberate narrowing, and it changes no array the SPA reads.
 *
 * A test asserting a DENIED permission no longer has to hand-narrow an array: call
 * `installRoleProfile([])` for denied-by-default, or `installRoleProfile(['Accounts User'])`
 * for a genuinely narrower role, and pass a non-Administrator user name to stop modelling
 * the superuser. Both the default profile and every other piece of mutable runtime state
 * are reconstructed before AND after every test, so no suite can leak a profile into
 * another.
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
