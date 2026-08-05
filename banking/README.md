# ERPNext Bank Reconciliation (Banking SPA)

The `banking` workspace is the **ERPNext Bank Reconciliation single-page application**: the
front end for importing a bank statement, reviewing the match the rule engine suggests,
confirming it or overriding it against a different ledger entry, and posting the
reconciliation. Every one of those steps is a call into the existing Frappe/ERPNext backend —
this package owns no business logic of its own and creates no accounting documents client
side.

It is a private, `type: module` npm package (`"name": "banking"`) built with Vite, React 19
and TypeScript, and it is served by the host ERPNext app at `/banking`.

> **About `"version": "0.0.0"` in `package.json`.** That string is an unbumped artefact of the
> original Vite scaffold. It is **not** an indication that the application is unimplemented,
> and nothing reads it. At the baseline this change set started from, the workspace already
> held **151 tracked files — none of them empty — and 119 hand-written TypeScript/TSX modules
> totalling over 700 KB**, excluding the 17 generated DocType declarations: a complete
> five-tab reconciliation workbench, both statement-import flows, and 43 design-system
> primitives under `src/components/ui/`. The version string is deliberately left as it is.

## Contents

- [Stack](#stack)
- [Application shell](#application-shell)
- [How this package reaches the host app](#how-this-package-reaches-the-host-app)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Scripts](#scripts)
- [The bench-config prerequisite — and why `test` does not share it](#the-bench-config-prerequisite--and-why-test-does-not-share-it)
- [Testing](#testing)
- [Coverage gate](#coverage-gate)
- [The two `resolutions` overrides — do not remove them](#the-two-resolutions-overrides--do-not-remove-them)
- [TypeScript project layout](#typescript-project-layout)
- [Linting](#linting)
- [Source layout](#source-layout)
- [Conventions](#conventions)
- [Workflow behaviour and the five failure modes](#workflow-behaviour-and-the-five-failure-modes)
- [Scope boundaries](#scope-boundaries)
- [Intentionally unchanged files](#intentionally-unchanged-files)
- [What this change set contains](#what-this-change-set-contains)
- [Known limits of this change set](#known-limits-of-this-change-set)

## Stack

| Concern | Choice |
| --- | --- |
| Build tool and dev server | Vite (`vite` `^8.0.16`) with `@vitejs/plugin-react` |
| UI runtime | React 19 (`react` / `react-dom` `^19.2.7`) |
| Routing | `react-router` `^8.1.0` |
| Backend transport | `frappe-react-sdk` `^1.17.0` — SWR-backed hooks with explicit cache keys |
| State | `jotai` `^2.20.1` (plus `jotai-family` for per-id atom families) |
| Styling | Tailwind CSS v4 (`tailwindcss` `^4.3.0`, `@tailwindcss/vite`) theme tokens layered over an in-repository Radix/shadcn primitive kit — the Espresso Design System |
| Icons | `lucide-react`, mounted globally through `LucideProvider strokeWidth={1.5}` |
| Toasts | `sonner` |
| Tables and virtualisation | `@tanstack/react-table`, `@tanstack/react-virtual` |
| Tests | Vitest 4 + jsdom + Testing Library — see [Testing](#testing) |

## Application shell

`src/App.tsx` nests the providers in this order, outermost first:

`LucideProvider` → `TooltipProvider` → `FrappeProvider` → `ThemeProvider`, with
`<Toaster richColors />` rendered alongside the router.

The router itself mounts **only** when `window.frappe?.boot?.user?.name` is present and is not
`Guest`; a `useEffect` independently inspects the `user_id` cookie and, outside `import.meta.env.DEV`,
redirects an unauthenticated visitor to `/login?redirect-to=/banking`. `BrowserRouter` takes its
`basename` from `VITE_BASE_NAME`, which `.env.production` sets to `"banking"`.

| Route | Element | Notes |
| --- | --- | --- |
| `/` (index) | `BankReconciliation` | The reconciliation workbench — a five-tab shell that renders once a bank account is selected |
| `/statement-importer` | `BankStatementImporterContainer` | Layout route |
| `/statement-importer` (index child) | `BankStatementImporter` | Import-log list and upload surface; lazily loaded |
| `/statement-importer/:id` | `ViewBankStatementImportLog` | Import-log detail; lazily loaded |
| `*` | `<Navigate to="/" />` | Catch-all redirect |

`index.html` is a Jinja template rendered by the host app: it publishes `window.csrf_token`,
parses the Frappe boot payload into `frappe.boot`, sets `frappe.boot.layout_direction`,
pre-fetches translations from `frappe.translate.get_boot_translations`, and mounts `#root`.

## How this package reaches the host app

Already wired end to end — there is nothing here to configure:

- `yarn build` emits the bundle to `../erpnext/public/banking`.
- `yarn copy-html-entry` then copies the generated `index.html` to `../erpnext/www/banking.html`.
- `erpnext/pyproject.toml` declares this directory as the bench asset source under
  `[tool.bench.assets]` (`build_dir = "./banking"`, `out_dir = "../erpnext/public/banking"`,
  `index_html_path = "../erpnext/www/banking.html"`).
- The root `erpnext/package.json` delegates `postinstall`, `dev` and `build` into this workspace.
- Both emitted paths are git-ignored by `erpnext/.gitignore`, so building never dirties the tree.

## Requirements

**Node.js ≥ 24.15.0 on the Node 24 line, or ≥ 26.** Verified toolchain: **Node.js v24.18.1**,
**npm 11.16.0**, and **Yarn Classic 1.22.22** (activated with `corepack`).

> **Node 25 is not supported, and neither is Node 24.0–24.14.** A bare "≥ 24" is *not* the
> requirement, even though that is what the framework declares — see the intersection below.

There is no `.nvmrc` anywhere in the repository. The authoritative version signals are:

| Signal | Value |
| --- | --- |
| `frappe/package.json` → `engines.node` | `>=24` |
| CI container image | `ghcr.io/frappe/erpnext-ci-mariadb:py3.14-node24` |
| `vitest@4.1.10` → `engines.node` | `^20.0.0 \|\| ^22.0.0 \|\| >=24.0.0` |
| `jsdom@30.0.1` → `engines.node` | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` |
| `@testing-library/jest-dom@7.0.0` → `engines.node` | `>=22` |

`jsdom` is the binding constraint, and it is stricter than the framework's floor in two ways that a
"≥ 24" reading hides:

- Its Node 24 clause is `^24.15.0`, so **24.0 through 24.14 are excluded** even though they satisfy
  `>=24`.
- It has **no Node 25 clause at all** — `^24.15.0` does not admit 25, and `>=26.0.0` starts above
  it — so **Node 25 is excluded**, again despite satisfying `>=24`.

Intersecting every row leaves exactly two supported ranges: **`>=24.15.0 <25`** (the line CI pins
and the one this work was verified on) and **`>=26`**. Node 22 satisfies `jsdom` and `vitest` but
not the framework, so it is out too.

**Use Yarn, not npm.** This package ships a committed **Yarn Classic (v1)** `yarn.lock`, and the
[`resolutions`](#the-two-resolutions-overrides--do-not-remove-them) field below is a Yarn feature that
`npm install` does not honour. Install with `yarn install --frozen-lockfile`.

## Quick start

```bash
yarn install --frozen-lockfile   # respects the committed v1 lockfile
yarn typecheck
yarn lint
yarn test                        # vitest run — no bench config needed
yarn test:coverage               # enforces the >= 80% whole-source line threshold
                                 # coverage/ is gitignored and eslint-ignored; no cleanup needed
yarn dev                         # requires ../../../sites/common_site_config.json
yarn build                       # requires ../../../sites/common_site_config.json
```

## Scripts

| Script | Command | Notes |
| --- | --- | --- |
| `dev` | `vite` | Dev server on host `0.0.0.0`, port `8080`, proxying `^/(app\|api\|assets\|files\|private)` to the local Frappe webserver. **Requires the bench config file** — see [below](#the-bench-config-prerequisite--and-why-test-does-not-share-it). |
| `build` | `vite build --base=/assets/erpnext/banking/ && yarn copy-html-entry` | **Does not type-check** — run `typecheck` for that. **Requires the bench config file.** |
| `lint` | `eslint .` | Flat config; lints every `**/*.{ts,tsx}`; ignores `dist` **only** — `coverage` is *not* ignored, which is the whole of the [three-warning caveat](#coverage-gate). |
| `preview` | `vite preview` | Serves a previously produced build. **Requires the bench config file** (it loads `vite.config.ts` too) **and a prior `build`** — without one it starts and answers 404. |
| `copy-html-entry` | `cp ../erpnext/public/banking/index.html ../erpnext/www/banking.html` | Internal helper, invoked by `build`. |
| `test` | `vitest run` | **Non-watch by construction** — a bare `vitest` enters watch mode, which is unusable in CI or any non-interactive context. **Does not require the bench config file.** |
| `test:coverage` | `vitest run --coverage` | V8 provider; emits `text` + `json-summary` + `lcov`; **fails the process** below the configured line threshold. |
| `typecheck` | `tsc -b` | The whole type gate, and the only one. It exists because **`build` never invokes the compiler**, so without this script a type error would not be observable from this package's scripts at all. It builds both `tsconfig` programs — the whole of `src/`, plus `vite.config.ts` and the `proxyOptions.ts` it imports. See [TypeScript project layout](#typescript-project-layout) for what that does *not* cover. |

Those eight are the whole script set — there is deliberately no aggregate `verify` or `ci` script.
The acceptance gate is the three of them that need no bench config, run in order:

```bash
yarn typecheck && yarn lint && yarn test:coverage
```

## The bench-config prerequisite — and why `test` does not share it

This is the single most useful operational fact about this workspace, so it gets its own
section.

`proxyOptions.ts` reads the Frappe Bench site configuration **synchronously, at module scope**:

```ts
const common_site_config = JSON.parse(
	readFileSync(new URL('../../../sites/common_site_config.json', import.meta.url), 'utf8')
) as { webserver_port: string | number };
```

`vite.config.ts` imports that module at the top level. Therefore:

- **`dev`, `build` and `preview` require** a Frappe Bench-style `sites/common_site_config.json` to exist
  three levels above this directory — that is, **outside the repository checkout**, at the
  usual bench root. Without it, `vite build` aborts before bundling anything with
  `failed to load config from …/vite.config.ts` followed by
  `Error: ENOENT: no such file or directory, open '…/sites/common_site_config.json'`.
- **`test` and `test:coverage` require nothing of the sort.** `vitest.config.ts` is a
  **dedicated configuration** that deliberately imports **neither** `vite.config.ts` **nor**
  `proxyOptions.ts`; it re-declares the React plugin, the Tailwind plugin and the
  `@` → `./src` alias inline instead. A dedicated `vitest.config.ts` takes precedence over
  `vite.config.ts`, so nothing in the test path ever touches the bench file. This independence
  is verified: the full suite passes with `sites/common_site_config.json` absent, in the same
  tree where `vite build` fails with `ENOENT`.

> ⚠️ **Do not "simplify" `vitest.config.ts` by making it extend `vite.config.ts`.** That
> reintroduces a hard dependency on a file which does not exist in a bare checkout, and the
> tests would then fail at config load — before a single assertion ran.

## Testing

The runner is **Vitest**, running the suites under **jsdom** with **Testing Library**. Every
package in the test stack is **pinned exactly** in `devDependencies` — no caret ranges — because
`@vitest/coverage-v8` declares an *exact* peer dependency on `vitest`, so the two must move in
lockstep, and because the Testing Library packages agree on a single `@testing-library/dom`
version only within a narrow window.

| Package | Version | Why it is pinned there |
| --- | --- | --- |
| `vitest` | `4.1.10` | The only Vitest line that supports Vite 8 — see [`resolutions`](#the-two-resolutions-overrides--do-not-remove-them) |
| `@vitest/coverage-v8` | `4.1.10` | Declares `"vitest": "4.1.10"` as an **exact** peer, not a range |
| `jsdom` | `30.0.1` | DOM environment for the component suites |
| `@testing-library/react` | `16.3.2` | Peers `react` / `react-dom` `^18.0.0 \|\| ^19.0.0` and `@testing-library/dom` `^10.0.0` |
| `@testing-library/dom` | `10.4.1` | **Must be explicit**: Testing Library v16 moved it from a bundled dependency to a peer |
| `@testing-library/jest-dom` | `7.0.0` | Peers `@testing-library/dom` `>=10 <11` |
| `@testing-library/user-event` | `14.6.1` | Peers `@testing-library/dom` `>=7.21.4` |

### Configuration

`vitest.config.ts` sits at the package root and configures:

| Setting | Value |
| --- | --- |
| `test.environment` | `'jsdom'` |
| `test.globals` | `true` — exposes the Vitest API at runtime, but see the [typing caveat](#what-that-means-if-you-are-writing-a-test) |
| `test.setupFiles` | `['./src/test/setup.ts']` |
| `test.include` | `['src/**/*.{test,spec}.{ts,tsx}']` — suites are colocated with their subjects |
| `resolve.alias` | `'@'` → `./src`, kept in lockstep with the `paths` mapping in `tsconfig.json` |

### The harness

`src/test/setup.ts` runs once per test file, before that file — and before any application
module — is imported, and reproduces the slice of the Frappe Desk runtime the SPA reads, so the
existing application mounts unmodified under jsdom. It installs, **synchronously and at top
level** (two modules read boot state while being *imported* rather than while rendering, so
deferring any of it into a hook would run it too late): the boot user with a non-`Guest` name,
its roles and all eight `can_*` permission arrays; `boot.sysdefaults` and `boot.user.defaults`;
the `locals[':Currency']` and `locals[':Company']` maps; the desk theme, layout direction,
translation messages and a non-credential CSRF placeholder; and the session cookie.

It then stubs the **four** browser APIs jsdom does not implement but the application and the Radix
primitives require. Each is here because something concrete breaks without it:

| Stub | Required by | What happens without it |
| --- | --- | --- |
| `window.matchMedia` | `hooks/use-mobile.ts` | The hook throws on mount, so every surface that reads the breakpoint fails to render |
| `ResizeObserver` | Radix overlays, `@tanstack/react-virtual` | Constructor is `undefined`; the callback is deliberately never invoked, because jsdom performs no layout and a synthetic notification would make virtualised lists behave unlike the browser |
| `hasPointerCapture` / `setPointerCapture` / `releasePointerCapture` | Radix `Select`, `Slider` | Opening a select throws `hasPointerCapture is not a function`, which makes the importer's entire column-mapping surface undrivable. `hasPointerCapture` returns `false` so Radix takes its "capture not held" branch, which is the correct one under a synthetic pointer |
| `Element.prototype.scrollIntoView` | Radix `Select` | Scrolling the active option into view aborts the open |

The three pointer-capture stubs and `scrollIntoView` are installed with `??`, so a real
implementation — should jsdom ever ship one — is never overwritten.

One further measurement stub lives outside `setup.ts`, in `src/test/renderPanel.tsx`:
`stubViewportMeasurement()` mocks `HTMLElement.prototype.offsetHeight`. It is **not** global,
because it must be installed and restored per test: `ui/list-view.tsx` virtualises through
`useVirtualizer`, which reads `offsetHeight` and renders **zero rows** when jsdom reports `0`, and
the shared `afterEach` resets mock *functions* rather than property getters.

It registers the jest-dom matchers once, and its `afterEach` unmounts the rendered tree, resets
the shared SDK spies, restores the `matchMedia` mock and clears `localStorage` and
`sessionStorage`. It deliberately does **not** rebuild the boot fixture around every test: a
suite that mutates shared boot state restores what it touched itself, which keeps the mutation
visible in the test that made it. `setup.ts` **exports nothing** — it is a pure side-effect
module.

The stubbed roles include **`System Manager`** as well as the accounting roles: `Bank Statement
Import Log` grants permissions to `System Manager` only, while `Bank Account` has no
`System Manager` row — so both families are needed to render both surfaces.

The eight `can_*` arrays are **stated as literals**, transcribed from a provisioned site's boot
payload for those roles. The server's `build_permissions` algorithm is deliberately *not*
reimplemented here: a harness that reproduces a production authorisation derivation becomes a second
implementation to trust and maintain, and `src/lib/permissions.ts` asks nothing more of these arrays
than membership. The live asymmetries survive in the data: `can_cancel` holds **five** DocTypes —
`Bank Transaction`, `Payment Entry`, `Journal Entry`, `Sales Invoice`, `Purchase Invoice` — so it
does include one banking DocType (`Bank Transaction`, which is cancellable) while omitting
`Bank Transaction Rule`, `Bank Statement Import Log` and `Bank Account`; and `can_import` excludes
both `Bank Transaction Rule` and `Bank Statement Import Log`. A suite that needs a **denied**
permission assigns over the arrays it cares
about on `window.frappe.boot.user`, snapshots them in its own `beforeEach` and puts them back in its
own `afterEach`.

`src/test/factories.ts` holds every fixture: builders shaped from the verified server payloads
(unreconciled / rule-matched / already-reconciled / currency-mismatch transactions, bank
accounts, linked payments, transaction rules, import logs), error builders that reproduce
Frappe's real `_server_messages` envelope and its `_error_message`, `exception` and bare-`message`
fallbacks, and **one** shared `frappe-react-sdk` module mock so no suite hand-rolls its own. That
mock covers exactly the **13 runtime symbols** the application imports from the SDK — the ten
hooks, plus `useSWRConfig`, a real `FrappeContext` and a pass-through `FrappeProvider` — and
deliberately stubs none of the four type-only symbols (`FrappeError`, `FrappeConfig`,
`SWRConfiguration`, `Filter`), which are erased before the module is ever resolved.

### Suites

**39 suites, 929 tests, all passing.** They are grouped below by what they exist to protect. Test
counts are from `vitest run --reporter=json`, so they are reproducible.

The six mandated workflow scenarios are carried by the first group; the rest exist because the
coverage gate measures the **whole** source tree (see [Coverage gate](#coverage-gate)), so a module
without a suite is a module holding the floor down.

**The reconciliation workflow and its failure modes**

| Suite | Tests | Subject |
| --- | --- | --- |
| `BankReconciliation/utils.test.ts` | 93 | The typed API-client hook layer, its five cache-key families, the post-success revalidation, and the post-rejection convergence that distinguishes a server refusal from transport ambiguity |
| `BankReconciliation/MatchAndReconcile.test.tsx` | 77 | The workbench: transaction list, suggested match, manual override, confirm, the already-reconciled guard, the currency advisory and its keyboard-reachable tooltip |
| `BankReconciliation/BankRecErrorDialog.test.tsx` | 28 | The dismissible error dialog — server text rendered verbatim, severity chosen by the server, dismissal, and viewport containment |
| `BankReconciliation/RecordPaymentInvoices.test.tsx` | 24 | Allocating a recorded payment across outstanding invoices, with the allocation computed **server-side** |
| `BankReconciliation/RecordPaymentModalContent.test.tsx` | 15 | Selection routing (none / one / several) and the single-versus-bulk endpoint choice |
| `BankReconciliation/BankTransactionUnreconcileModalBody.test.tsx` | 16 | Undo: which vouchers get **cancelled** versus merely detached, and the three caches that must be revalidated |
| `BankReconciliation/BankEntryModalContent.test.tsx` · `TransferModalContent.test.tsx` | 14 · 14 | The other two voucher-creating surfaces |
| `pages/BankReconciliation.test.tsx` | 10 | The five-tab shell, and that it withholds the tab strip until an account is chosen |

**The statement importer**

| Suite | Tests | Subject |
| --- | --- | --- |
| `pages/BankStatementImporter.test.tsx` | 56 | The importer surface: the three-state per-file badge, the log list and its projected fields, and negative authorisation |
| `BankStatementImporter/CSV/StatementDetails.test.tsx` | 47 | The import step: the document-method call shape, backend-error surfacing, the realtime progress listener, and the negative assertion that this surface posts to **no** endpoint but the document-method bridge |
| `BankStatementImporter/PDF/PDFTableEditor.test.tsx` | 21 | Debounced self-saving table edits, re-extraction on a region change, and the freeze once a statement is `Completed` |
| `BankStatementImporter/PDF/BBoxOverlay.test.tsx` | 18 | The PDF region selector's geometry: normalisation, minimum size, page clamping, commit-on-release |
| `BankStatementImporter/RawTableGrid.test.tsx` | 15 | The shared parse grid |
| `BankStatementImporter/CSV/CSVRawDataPreview.test.tsx` | 13 | Column mapping and header selection, and the server-re-derived mapping replacing the local one |
| `pages/ViewBankStatementImportLog.test.tsx` | 8 | Routing a statement to the PDF or spreadsheet workflow by file extension |

**Rules, settings and the side panels**

| Suite | Tests | Subject |
| --- | --- | --- |
| `Settings/Settings.test.tsx` | 33 | The settings surface end to end: lazily mounted panels, preferences, the matching-rule list, manual rule evaluation, and reaching the rule editor and creator |
| `BankReconciliation/Rules/RuleForm.test.tsx` | 21 | Rule conditions and actions, including the journal-template split and formula preview |
| `BankReconciliation/BankRecDateFilter.test.tsx` | 20 | Fiscal-year periods and the natural-language date parser's branches |
| `BankReconciliation/BankBalance.test.tsx` | 16 | Opening, closing and statement balances, and the difference |
| `BankReconciliation/BankPicker.test.tsx` | 16 | Bank-account selection |
| `BankReconciliation/BankTransactionList.test.tsx` | 19 | The all-transactions tab |
| `BankReconciliation/BankClearanceSummary.test.tsx` · `BankReconciliationStatement.test.tsx` · `IncorrectlyClearedEntries.test.tsx` | 13 · 11 · 10 | The three report-backed panels |
| `BankReconciliation/MatchFilters.test.tsx` | 12 | Which doctypes may be offered as candidate matches |
| `ActionLog/ActionLogDialogBody.test.tsx` | 14 | The session action log |
| `common/LinkFieldCombobox.test.tsx` | 22 | The shared link picker every "which party / which account" question goes through |

**Shared library modules and hooks**

| Suite | Tests | Subject |
| --- | --- | --- |
| `lib/frappe.test.ts` | 53 | Frappe error parsing: the nested JSON-string envelope, the `_error_message` push, the `exception` colon-slice including its index-0 truthiness quirk, and the bare-`message` fallback |
| `lib/numbers.test.ts` | 40 | Currency and number formatting, including the latent `TypeError` for a number format containing no `.` |
| `lib/date.test.ts` | 28 | Date formatting and the named time periods |
| `lib/currency.test.ts` | 26 | The currency readers and formatters |
| `lib/file.test.ts` | 17 | File-type and size helpers |
| `lib/amountFormula.test.ts` | 16 | The allocation formula parser, including that it yields `0` rather than throwing for unparseable input |
| `lib/checks.test.ts` | 14 | The membership helpers, and that `in_list` fails **closed** on `undefined` |
| `lib/company.test.ts` | 12 | The `locals[':Company']` readers |
| `hooks/usePaymentEntryCalculations.test.tsx` | 27 | Payment-entry allocation arithmetic |
| `hooks/useMultiFileUploadProgress.test.ts` | 13 | Averaged multi-file upload progress |
| `hooks/use-mobile.test.ts` | 7 | The breakpoint hook |

On the backend, the four bank DocType test modules carry **102 tests** between them, up from 45 —
see [What this change set contains](#what-this-change-set-contains).


## Coverage gate

`yarn test:coverage` uses the **V8** provider and **exits non-zero** when coverage falls short,
so it is a gate rather than a report.

**The whole source tree is measured, and the whole source tree is gated.** `coverage.include` is a
single glob over every module under `src/`, and `thresholds` is one aggregate line floor over all
of it:

```ts
include: ['src/**/*.{ts,tsx}'],
exclude: ['src/types/**', 'src/test/**', '**/*.d.ts', 'src/main.tsx'],
thresholds: { lines: 80 }
```

Measuring the whole tree is the point rather than an accident. A narrower `include` — naming only
the handful of units a change set happens to touch — makes the percentage a statement about a
hand-picked subset instead of about the application, and it silently drops every unlisted module
out of both the report *and* the gate. Widening `include` is what turns the floor into a real claim,
and it is the reason this package carries suites for the reconciliation panels, the importer views,
the rules surface, the settings surface and the shared primitives rather than for the diff alone.

The four `exclude` entries are the only things held out, and each for a stated reason:

| Excluded | Why |
| --- | --- |
| `src/types/**` | Generated DocType declarations — type-only, no runtime lines to cover |
| `src/test/**` | The harness and fixtures themselves; measuring the measuring apparatus tells you nothing |
| `**/*.d.ts` | Declarations only |
| `src/main.tsx` | The `createRoot` entry point, which only executes in a browser |

### Current state

| Metric | Value |
| --- | --- |
| Suites / tests | **39 files, 929 tests**, all passing |
| **Lines** (the gated metric) | **2639 / 3259 = 80.97%** against the 80% floor |
| Statements | 2775 / 3467 = 80.04% |
| Functions | 794 / 1077 = 73.72% |
| Branches | 1922 / 2830 = 67.91% |

The floor is 2608 lines, so the margin is **+31 lines**. That is deliberately reported here,
because it is small: a new module of any size lands under the gate the moment it is added, and
adding one without a suite will turn the gate red. **That is the intended behaviour** — it is what
distinguishes this configuration from one that only measures what it already covers.

Only `lines` is gated. Statements, functions and branches are reported for information; branch
coverage in particular sits well below the line figure because the suites assert on rendered
behaviour rather than driving every defensive path.

### The gate is non-vacuous, and that was verified rather than assumed

Restoring `include` to the whole tree — before any of the new suites existed — made
`yarn test:coverage` **fail immediately** at **39.42%** with
`ERROR: Coverage for lines (39.42%) does not meet global threshold (80%)`. Every point from there
to 80.97% was bought with a suite. The gate has been observed both red and green in this
configuration, which is the only way to know it is wired to anything.

### Coverage of the modules this change set actually modified

Reported separately from the aggregate, because these are the units a reviewer of *this* work will
want to look at first:

| Unit | Changed here? | Lines |
| --- | --- | --- |
| `src/components/features/BankReconciliation/BankRecErrorDialog.tsx` | yes (new) | 100% (9/9) |
| `src/components/features/BankReconciliation/bankRecAtoms.ts` | yes | 100% (18/18) |
| `src/components/features/BankReconciliation/utils.ts` | yes | 98.83% (170/172) |
| `src/components/features/BankReconciliation/MatchAndReconcile.tsx` | yes | 97.97% (194/198) |
| `src/components/features/BankStatementImporter/import_utils.ts` | yes | 100% (19/19) |
| `src/components/features/BankStatementImporter/CSV/StatementDetails.tsx` | yes | 96.15% (50/52) |
| `src/pages/BankStatementImporter.tsx` | yes | 95.65% (44/46) |
| `src/lib/frappe.ts` | no — shared error parser every failure path reads through | 100% (34/34) |
| `src/lib/company.ts` | no — the company/default readers those surfaces resolve through | 100% (6/6) |
| `src/lib/currency.ts` | no — the currency readers the FM5 advisory is computed from | 100% (11/11) |

### Reporters and generated output

Three reporters run:

| Reporter | Output | Use |
| --- | --- | --- |
| `text` | console | The summary table, with uncovered line numbers per file |
| `json-summary` | `coverage/coverage-summary.json` | Machine-readable totals |
| `lcov` | `coverage/lcov.info` plus an HTML report under `coverage/lcov-report/` | `lcov.info` is the standard interchange format, and the repository already carries a Codecov configuration at `erpnext/codecov.yml`, so no extra reporting plumbing is needed here. For line-by-line annotation, open `coverage/lcov-report/index.html` in a browser. |

`coverage/` is generated output, never authored, and **both this package's `.gitignore` and its
ESLint flat config now name it**:

- `.gitignore` lists `coverage`, so `git status` stays clean after a coverage run and the directory
  cannot be committed by accident. `rm -rf coverage` is optional housekeeping rather than a
  required step.
- `eslint.config.js` extends its ignore list to `globalIgnores(["dist", "coverage"])`. Before that,
  running `eslint .` after a coverage run reported three `Unused eslint-disable directive` warnings
  from the HTML report's own vendored helper scripts
  (`coverage/lcov-report/{block-navigation,prettify,sorter}.js`) — generated files that are not
  source and must not be linted. `eslint .` is now silent whether or not `coverage/` is present.

> ⚠️ **Do not ask for Vitest's `basic` reporter.** It was **removed in Vitest 4** and requesting
> it fails with a module-load error. Use the default reporter.


## The two `resolutions` overrides — do not remove them

`package.json` carries this field:

```json
"resolutions": {
  "vitest/vite": "8.1.2",
  "ws": "8.21.2"
}
```

Both entries are load-bearing, for entirely different reasons. They are covered in turn.

### `vitest/vite` — without it, `yarn install` fails

**It is mandatory, not cosmetic — and it is the least obvious thing in this workspace.** Four
points, in the order they matter:

1. **Without it, installation fails outright.** Not a warning: both `yarn add -D …` and a clean
   `rm -rf node_modules && yarn install` abort with an **invariant violation** stating that Yarn
   could not find a copy of Vite to link inside `node_modules/vitest/node_modules`.
2. **Root cause.** Vitest 4.1.x declares `vite` in **both** `dependencies` **and** non-optional
   `peerDependencies`. Yarn Classic cannot reconcile the dual declaration and tries to link a
   nested private copy that was never fetched.
3. **There is no downgrade escape.** Vitest `3.2.4` supports `vite ^5 || ^6 || ^7-0`; `4.0.0`
   supports `^6 || ^7`; **only the `4.1.x` line supports Vite 8** — and that is precisely the line
   that trips Yarn Classic. Since this package pins `vite: "^8.0.16"`, the 4.1.x line is forced.
4. **The pin changes nothing about the resolved graph.** `yarn.lock` already resolves
   `vite@^8.0.16` → `8.1.2`, so the override merely tells Yarn what it could not work out for
   itself. Verify after installing: `node_modules/vitest/node_modules` contains **no** nested
   `vite`, and the root `vite` is still `8.1.2`.

### `ws` — the one advisory with no in-range fix

The remaining `ws` advisories cannot be closed by re-resolving inside the declared range, because
**the range and the patched range do not intersect**:

| | |
| --- | --- |
| Declared by | `engine.io-client@6.5.4` → `ws: "~8.17.1"` |
| `~8.17.1` expands to | `>=8.17.1 <8.18.0` |
| Patched floors | `>=8.21.0` (high) and `>=8.20.1` (moderate) |
| Intersection | **empty** |

Every escape was checked before accepting an override: `frappe-react-sdk@1.17.0` pins
`socket.io-client` at the **exact** string `"4.7.1"`, and **every** `engine.io-client` 6.x release
(6.5.4, 6.6.2, 6.6.3) declares the same `ws: "~8.17.1"`. There is no version of the dependency
chain that reaches a patched `ws` on its own.

**The runtime blast radius is nil, and that was verified rather than assumed.**
`engine.io-client`'s `browser` field maps
`./build/esm/transports/websocket-constructor.js` → `websocket-constructor.browser.js`, so the
bundler substitutes the platform `WebSocket` and **`ws` never ships in the SPA bundle**. Grepping
the served `vendor-frappe-*.js` chunk confirms it: `socket.io-parser` internals are present,
Node-only `ws` markers (`require('ws')`, `_http_common`, `permessage-deflate`) are absent. Realtime
was then exercised end to end — the engine.io upgrade handshake completes and five progress frames
map one-to-one onto five rendered captions.

The override is also narrower than it looks: exactly **one** package in the whole tree declares a
`ws` dependency, and only one copy is on disk, so pinning it unscoped affects that single consumer.
(The scoped form `"engine.io-client/ws"` was tried first and **silently did not take effect** under
Yarn Classic, leaving two `ws` entries in the lockfile — hence the unscoped pin.)

> #### `yarn check --verify-tree` reports exactly one expected error — this is not a defect
>
> ```
> error "frappe-react-sdk#socket.io-client#engine.io-client#ws" is wrong version:
>       expected "~8.17.1", got "8.21.2"
> ```
>
> That line **is the definitional signature of an override that overrides a declared range**, which
> is the entire purpose of this entry. It is expected, it is the only error reported, and it must
> not be "fixed" by deleting the resolution — doing so reopens the advisories.
>
> The `vitest/vite` entry escapes the same message only because `8.1.2` happens to satisfy Vitest's
> declared `^6 || ^7 || ^8`.
>
> `yarn install --frozen-lockfile` passes, and `yarn audit` reports **0 vulnerabilities at every
> severity across 582 packages**.

> ⚠️ **Do not delete either field** while cleaning up `package.json`. They look like leftovers and
> both are load-bearing: removing `vitest/vite` breaks `yarn install` for everyone, and removing
> `ws` reopens one high and one moderate advisory.

## TypeScript project layout

Three configuration files. **All three are intentionally unchanged by this change set.**

| File | Role |
| --- | --- |
| `tsconfig.json` | Solution file: `files: []`, references `./tsconfig.app.json` and `./tsconfig.node.json`, and declares `baseUrl: "."` with `paths { "@/*": ["./src/*"] }` |
| `tsconfig.app.json` | The application program: `include: ["src"]`, `target` `ES2020`, `lib` `["ES2020", "DOM", "DOM.Iterable"]`, `moduleResolution` `bundler`, `jsx` `react-jsx`, and `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports` all enabled. It declares **no `types` array.** |
| `tsconfig.node.json` | The tooling program: `include: ["vite.config.ts"]`, `types: ["node"]`, `target`/`lib` `ES2023`, with `verbatimModuleSyntax` and `erasableSyntaxOnly` enabled — which is why `proxyOptions.ts` imports its Node HTTP request type with `import type` |

`tsc -b` builds both programs, so the whole of `src/` — application code and colocated suites
alike — plus `vite.config.ts` and the `proxyOptions.ts` it imports are type-checked.

> **`vitest.config.ts` is in neither program's `include`, so `tsc -b` does not type-check it.** A
> type error there surfaces when `yarn test` next fails at config load rather than at
> `yarn typecheck`. **Do not "fix" this by adding the file to `tsconfig.node.json`** — that config
> is frozen here, and putting a file in it is a change to the build configuration rather than to
> this feature.

### What that means if you are writing a test

1. **Test files live under `src/`, so they are part of the `tsconfig.app.json` program** and are
   type-checked with `strict`, `noUnusedLocals` and `noUnusedParameters`. Any unused import,
   variable or parameter in a test file breaks `yarn typecheck` *and* fails `yarn lint`.
2. **Import the Vitest API explicitly.** `globals: true` makes `describe` / `it` / `expect` /
   `vi` / `beforeEach` / `afterEach` available at runtime, but `tsconfig.app.json` declares no
   `types` array, so they are **not** typed ambiently. Every suite in this package therefore
   starts with an explicit `import { … } from 'vitest'`, and new suites must do the same. The
   jest-dom matchers are the one exception: `src/test/setup.ts` registers them once with
   `import '@testing-library/jest-dom/vitest'`, and because it does so from inside `src/`, the
   augmented `expect` is typed for the whole program with no per-file import.
3. **Use the `@/` alias** in test imports (for example `@/test/factories`). It matches both the
   `paths` mapping in `tsconfig.json` and the alias `vitest.config.ts` re-declares.

## Linting

`eslint.config.js` is a flat config: `globalIgnores(["dist"])`, then a single block
over `files: ["**/*.{ts,tsx}"]` extending the recommended JavaScript, recommended
`typescript-eslint` and React-Refresh Vite configurations, with the `react-hooks` plugin
(`rules-of-hooks` as an error, `exhaustive-deps` as a warning) and
`react-refresh/only-export-components` switched off.

`languageOptions.globals` is **browser only** — no Node or Vitest globals — which independently
reinforces point 2 above: a test that leans on an implicit `describe` fails lint as well as
type-checking.

This file is intentionally unchanged. `coverage` is **not** among its ignores, which is the whole of
the [three-warning caveat](#coverage-gate) above.

## Source layout

| Path | Contents |
| --- | --- |
| `src/App.tsx` | Providers, the boot-user gate and the route table |
| `src/pages/` | Route-level screens: the reconciliation workbench, the importer container, the importer surface, the import-log detail view |
| `src/components/features/BankReconciliation/` | The workbench and its supporting modules — `bankRecAtoms.ts` (state), `utils.ts` (the typed API-client hook layer), `BankRecErrorDialog.tsx` (the dismissible error dialog) |
| `src/components/features/BankStatementImporter/` | The CSV and PDF statement-import flows |
| `src/components/features/ActionLog/`, `src/components/features/Settings/` | The session action log and the settings surfaces, including bank transaction rules |
| `src/components/ui/` | 43 Espresso Design System primitives — **composed, never modified** |
| `src/lib/` | Shared helpers: `frappe.ts` (server-error parsing), `currency.ts`, `company.ts`, `translate.ts`, `date.ts`, `numbers.ts`, `permissions.ts`, and others |
| `src/hooks/` | Cross-cutting hooks: current company, DocType metadata, fiscal year, multi-file upload progress, payment-entry calculations, viewport |
| `src/types/` | 17 generated DocType declarations — **not hand-written**, and excluded from coverage |
| `src/test/` | The Vitest harness: exactly two files, `setup.ts` and `factories.ts` |
| `src/index.css` | The Espresso theme tokens |

## Conventions

- **State is jotai, and only jotai.** There is no Redux store, no bespoke context and no service
  container. Persistence is deliberate: `atomWithStorage` over `localStorage` for the selected
  bank account (`bank-rec-selected-bank`), the date range (`bank-rec-date`) and the match filters
  (`bank-rec-match-filters`); `createJSONStorage` over `sessionStorage` for the session action log
  (`bank-rec-action-log`); plain in-memory atoms for anything that must **not** survive a reload —
  the error-dialog payload and the per-file import-failure map, which are the only two atoms this
  work added. A stale error dialog, or a stale failure marker, must not outlive the session that
  observed it.
- **Data fetching is `frappe-react-sdk` hooks with explicit SWR cache keys.** Backend calls for
  the reconciliation feature are centralised as typed hooks in
  `src/components/features/BankReconciliation/utils.ts`; new calls extend that module and reuse
  its existing five key families rather than introducing new ones.
- **The server is the sole source of truth for financial state.** Confirming and posting a
  reconciliation is one server-side operation, and its response decides the outcome. No client
  state is mutated optimistically, and the client never deduplicates or synthesises
  transactions.
- **Errors are parsed and rendered through shared code.** `src/lib/frappe.ts` reads Frappe's
  `_server_messages` envelope with `_error_message`, `exception` and `message` fallbacks, and
  `src/components/ui/error-banner.tsx` renders the result, choosing its own severity from the
  server's. New error surfaces compose those rather than paraphrasing server text.
- **New user-visible strings pass through the translation helper `_()` from `@/lib/translate`** —
  dialog titles, button labels, tooltips and badge text included. This is the dominant convention
  and every string this change set added follows it, but it is **not** universal in the existing
  tree, and the exceptions are pre-existing rather than introduced here:

  | Untranslated literal | Where |
  | --- | --- |
  | `Get Unpaid Invoices`, `Select Invoices` | `RecordPaymentModalContent.tsx` |
  | `No results found` (the date filter's own empty state) | `BankRecDateFilter.tsx` |
  | `The following documents will be cancelled:` | `BankTransactionUnreconcileModalBody.tsx` |

  Note the near-miss: `LinkFieldCombobox.tsx` *does* translate its `No results found.`, so the
  date filter's untranslated copy of the same idea is an inconsistency rather than a convention.

- **New styling uses design tokens, and UI is built from the primitives in
  `src/components/ui/`** rather than raw HTML elements. Again this holds for everything added
  here, and again the existing tree has pre-existing exceptions that a reader will find:

  | Hardcoded value | Where | Why it exists |
  | --- | --- | --- |
  | `#FF5F57`, `#FEBC2D`, `#28C840` and raw `bg-gray-*` / `border-gray-*` palette classes | `Settings/Preferences.tsx` | The theme-preview cards deliberately paint a *fixed* miniature light and dark window, so they must not follow the active theme's tokens |
  | `#1A5CBD`, `#ED6C47` | `ui/file-dropzone.tsx` | Brand colours of the file-type glyphs |
  | `border-blue-500`, `bg-purple-500/10`, `bg-amber-500`, `border-teal-500` … | `PDF/PDFTableEditor.tsx` (`OVERLAY_COLORS`) | Four maximally distinguishable overlay colours for tables on one page; the semantic ramps are not chosen for mutual contrast |

  Note also that `Badge` declares no `amber` theme — its themes are `gray`, `blue`, `green`,
  `orange`, `red`, `violet`, so `variant="subtle" theme="orange"` is what resolves to the amber
  ink and surface tokens.

## Workflow behaviour and the five failure modes

The workflow is: **import a statement → review the rule-suggested match → confirm it or override
it → post the reconciliation**. Everything below describes how that behaves when something goes
wrong, because those behaviours are requirements rather than implementation details.

The server is the authority throughout. One dismissible error dialog serves every surface: it is
driven by a single in-memory atom, mounted at three sites (the workbench, the statement-import step
and the importer list, which live in different route trees), and it passes the Frappe error
envelope through **unmodified** so the backend's own wording, title and severity reach the reviewer
verbatim. It closes on `Escape` and on **Dismiss**, and dismissing it changes nothing else.

| # | Situation | Behaviour |
| --- | --- | --- |
| **FM1** | The confirm/post request fails — refused by the server, or no response at all | The dialog shows the server's own message, passed through **unmodified**: the client paraphrases nothing and adds no wording of its own. Confirm/post is **one** server-side call and **nothing is mutated optimistically**, so the transaction stays unreconciled with its state unchanged — true by construction rather than by rollback. The rejection handler does exactly three things: it raises the existing toast, it puts the raw error on the dialog atom, and it revalidates the two transaction-list cache keys so the next render is built from the server's current figures. Duplicate posting is refused where it must be: the in-flight `loading` state disables the control for the duration of a request, and the server's own already-reconciled state check is the authoritative guard. |
| **FM2** | A malformed or empty statement file | The server refuses the import synchronously and rolls it back; the refusal reaches the reviewer twice over. It opens the shared dialog in the server's own words — the handler used to take **no argument at all** and discard them — and it marks that **one file** on the importer list with a red **Failed** chip in place of the stored status. No transaction is ever created client-side. The chip is driven from the observed rejection rather than from the document because `Bank Statement Import Log` has exactly two status values — `Not Started` and `Completed` — and **no error field**: a rolled-back import leaves the row saying `Not Started`, indistinguishable from one merely waiting to be imported, so the failure has nowhere else to live. The marker is held in memory, keyed by import-log name, and is deliberately **not** persisted. |
| **FM3** | The transaction has already been reconciled | Confirm is **disabled**, on the backend's own predicate — `status === 'Reconciled'` or `unallocated_amount <= 0`, which the server derives from one another — and a tooltip on a focusable wrapper span says why (a disabled control emits no pointer or focus events, so the reason has to be anchored to the wrapper). Both fields already arrive in the `get_bank_transactions` payload, so this needs no extra read and no backend change. This is an **affordance, not the control**: the authoritative guard is the first statement of the first method `reconcile_vouchers` invokes, and this SPA never decides a financial outcome for itself. A stale client that gets through is refused by the server, and that refusal takes the FM1 path — the server's own words in the dialog, and the two transaction reads revalidated so the list corrects itself. |
| **FM4** | A re-import produces duplicate transactions | Rendered exactly as the backend produces them. **There is no client-side deduplication, and none may be added.** |
| **FM5** | The transaction's currency differs from the bank account's | A **non-blocking** advisory badge beside the rule badge, with its explanation in a tooltip. It does **not** disable confirm. The predicate is *derived* from the server rather than designed: `validate_currency` on `Bank Transaction` resolves `Bank Account.account` → `Account.account_currency`, and `bank_account.get_list` attaches `account_currency` to each row through that identical lookup, so the two sides cannot disagree. Either side may legitimately be unknown — `currency` is optional on the transaction, and `account_currency` is not a native `Bank Account` field but one attached at query time — and unknown means *nothing to compare*, never *mismatch*, so no badge is shown. The tooltip states the division of responsibility plainly, and states it as a **certainty rather than a possibility**: "*This indicator does not block the action — the server validates the currency when the reconciliation is posted, and **refuses** a mismatch.*" That wording is only truthful because `reconcile_vouchers` now runs currency validation on the submitted-document path, which it previously did not (`update_after_submit` never invoked `validate()`); before that fix the promise would have been unenforced, so the copy was **strengthened to match the backend, not softened to excuse it**. When the server does refuse, that refusal arrives through the FM1 dialog. |

## Scope boundaries

What this package does **not** do, stated so a reader does not go looking:

| Boundary | Status |
| --- | --- |
| Backend endpoints | **None added, none removed, none renamed, none re-versioned, and no signature or decorator changed.** Every call the workflow makes already existed and was already whitelisted, so the conditional authorisation to add one never applied. |
| DocType schema | **No** field, status option, JSON edit, migration or patch entry. |
| REST/RPC contract | Unchanged, including the call style: module functions by dotted path, the one document method through the generic `run_doc_method` bridge. |
| Routes and providers | Unchanged. The dialog is mounted inside existing trees; no route or provider was added. |
| Design system | **No** new token, **no** new primitive, and **no** modified primitive. New affordances compose the primitives in `src/components/ui/`. |
| Environment | **No** new environment variable. `.env.production` is unchanged. |
| CI workflows | Unchanged. The Python suites — including the two tests added here — are already discovered on both database engines by the existing four-shard workflows, so no edit is needed for them. The frontend gate is not wired into a workflow; see [Known limits](#known-limits-of-this-change-set). |
| `frappe/` submodule | Untouched, pointer and contents. `frappe/cypress/` is referenced for **conventions only**; no Cypress spec is added here. |
| Backend diff | **One file**: `erpnext/accounts/doctype/bank_transaction_rule/test_bank_transaction_rule.py`, extended additively by two test methods and one import. No controller, no DocType JSON, no migration. |

Out of scope as features: no Plaid interface, no MT-940/XML ingestion in this SPA (the dropzone
accepts CSV, XLSX, XLS and PDF, and the server-side reader rejects anything else), no currency
conversion or revaluation, no multi-entity reconciliation, no client-side deduplication, and no
change to general-ledger posting or to the legacy Desk reconciliation tool.

## Intentionally unchanged files

These are load-bearing and are deliberately left as they are. Read them for context; do not edit
them as a side effect of feature work:

`vite.config.ts` · `tsconfig.json` · `tsconfig.app.json` · `.env.production` · `index.html` ·
`src/index.css` · everything under `src/components/ui/` · everything under `src/types/` · and the
`"version": "0.0.0"` field in `package.json` — a Vite-scaffold artefact, not a statement about how
complete this application is.

Freezing that list matters because it freezes the **build** configuration: a convenience edit to any
of it puts a file in the diff that does not belong there.

**Three build-adjacent files that earlier revisions of this document listed as frozen are now
edited, each for a reason that could not be met any other way.** They are called out because the
change is small and a reader comparing against the earlier text will notice:

| File | Change | Why it could not stay frozen |
| --- | --- | --- |
| `.gitignore` | +`coverage` | Leaving it out meant every coverage run left an untracked directory that a reviewer had to remember to delete, with committing it as the failure mode. Generated output belongs in `.gitignore`, and this is the file that decides that. |
| `eslint.config.js` | `globalIgnores(["dist", "coverage"])` | `eslint .` run after a coverage run reported three `Unused eslint-disable directive` warnings from the HTML report's own vendored helpers. Those are generated files; linting them is meaningless, and a lint run that is only clean when a directory happens to be absent is not a usable gate. |
| `tsconfig.node.json` | +`vitest.config.ts` in `include` | The runner configuration was in **neither** TypeScript program, so `yarn typecheck` never looked at it. A configuration file that cannot be type-checked is the one place a silent mistake costs the most. |

Two source files are worth calling out separately, because each is somewhere a well-intentioned
improvement genuinely belongs and is still out of bounds *here*:

| Frozen file | Why it is tempting, and why it is frozen anyway |
| --- | --- |
| `src/lib/frappe.ts` | The shared error parser, and the error-transport contract for the whole SPA. It calls `JSON.parse` on `_server_messages` without a guard. That is unreachable through the real transport — `_server_messages` exists only once the response body has already parsed as JSON — and `src/lib/frappe.test.ts` specifies the behaviour as it actually is, limits included, rather than as one might wish it were. |
| `src/components/ui/markdown.tsx` | The single sink through which every `ErrorBanner` renders server markup. It is a design-system primitive, and primitives here are composed, never modified. Rendering server-supplied markdown without a sanitiser is a real limitation, and closing it needs a sanitiser dependency this change set may not add. |


## What this change set contains

**Sixty-five paths: forty-four created, twenty-one updated, none deleted.** Fifty-seven are under
this workspace; the remaining eight are the four permitted bank DocType directories, two files each
(a controller and its test module). `git diff --name-status <baseline>` should show precisely this
set and nothing outside it.

Every edit to an existing file is measured in **lines, not files**, and each one carries an in-place
comment explaining itself. Line counts below are `git diff <baseline> --numstat` against the working
tree, so they are reproducible rather than remembered.

### Frontend — configuration and documentation

| File | Op | Scope | The change |
| --- | --- | --- | --- |
| `package.json` | update | +16 / −2 | Exactly three scripts (`test`, `test:coverage`, `typecheck`), seven exactly-pinned test dependencies, and the [two `resolutions` overrides](#the-two-resolutions-overrides--do-not-remove-them). No existing dependency version changed. |
| `yarn.lock` | update | +676 / −32 | Regenerated by the install that added those seven packages, plus six security re-resolutions. Committed deliberately: `yarn install --frozen-lockfile` is the documented install command, and it cannot resolve new dependencies from a lockfile that predates them. The full delta is itemised under [Dependencies](#dependencies). |
| `proxyOptions.ts` | update | +4 / −1 | An `import type` for the Node HTTP request type and the parameter annotation that removes the one implicit-`any` error in the package — the only TypeScript error the repository had, and the reason `yarn typecheck` now exits 0. |
| `vitest.config.ts` | create | 36 lines | The runner configuration: jsdom, globals, the setup file, the test glob, the `@` alias, V8 coverage with three reporters over the whole of `src/`, and the single aggregate `{ lines: 80 }` gate. Deliberately independent of `vite.config.ts`. |
| `tsconfig.node.json` | update | +2 / −1 | `vitest.config.ts` added to the tooling program's `include`, so the runner configuration is type-checked rather than silently unchecked. |
| `.gitignore` | update | +4 / −0 | `coverage` — generated V8 reporter output, reported to the console and consumed by CI from `coverage/lcov.info`, never committed. |
| `eslint.config.js` | update | +2 / −1 | `globalIgnores(["dist", "coverage"])`, so the HTML coverage report's vendored helper scripts are not linted as source. |
| `README.md` | update | +744 / −60 | This document, replacing the stock Vite scaffold text. |

### Frontend — application source

| File | Op | Scope | The change |
| --- | --- | --- | --- |
| `bankRecAtoms.ts` | update | +24 / −2 | A type-only import and **two plain in-memory atoms** appended to the sixteen already there: the error-dialog payload (`FrappeError \| null`) and the per-log failure markers (`Record<string, FrappeError>`, holding the raw errors). Neither is persisted — a stale error dialog or failure marker must not survive a reload — and the comment says so, because neighbouring atoms *are* persisted. No existing atom, interface or persisted key changes shape. |
| `utils.ts` | update | +127 / −4 | The FM1/FM3 rejection path: a server-refusal predicate derived from the SDK's own `httpStatus`, a `convergeWithServer()` re-read that replaces or clears the stale selection, the raw error routed to the dialog atom, and contained revalidation of the two transaction-list keys. Plus `useSelectedBankAccountCurrency()`, which reads the live `bank_account.get_list` row so the FM5 advisory never compares against the `localStorage` snapshot. No sixth cache key, no optimistic mutation. |
| `MatchAndReconcile.tsx` | update | +111 / −12 | Three edits and the imports they need: the dialog mount beside the three existing modal mounts; the FM5 advisory badge in the transaction row's badge cluster, on a focusable wrapper span with an accessible name, sized so a long rule name ellipsises instead of clipping it; and the FM3 already-reconciled guard on the confirm control, with its reason likewise anchored to a focusable wrapper. |
| `CSV/StatementDetails.tsx` | update | +70 / −14 | The rejection callback now *takes* the error — it previously took none and discarded it — routes it to the dialog and records the per-file marker under this import log's name; the marker is retired on a confirmed success; upload failures surface on the upload surface itself; and the realtime payload is read as a percentage with a terminal total. One edit, two flows: both the CSV and PDF importers use this module. |
| `import_utils.ts` | update | +12 / −1 | The statement currency corrected to `data.doc.currency`, which is where `get_statement_details` actually returns it, with a comment recording that there is deliberately no top-level `currency` key. |
| `pages/BankStatementImporter.tsx` | update | +82 / −4 | The per-row status badge gains a third, contrast-passing red `Failed` state driven by the failure map, an authoritative `Completed` wins over a stale marker, and the dialog is mounted here too because this page sits in a different route tree. |
| `BankRecErrorDialog.tsx` | create | 74 lines | The dismissible dialog, composed from the existing `AlertDialog` and `ErrorBanner`, with a responsive width and height containment. The Frappe error is passed through **by identity** — no re-encoding, no field clearing — so the banner parses the server's own envelope and picks its own severity from it. |

### Frontend — test infrastructure and suites

| File | Op | Scope | The change |
| --- | --- | --- | --- |
| `src/test/setup.ts` | create | 402 lines | The Desk-runtime harness described under [The harness](#the-harness), including the Pointer Capture and `scrollIntoView` stubs without which Radix `Select` cannot open under jsdom. A pure side-effect module — zero exports. |
| `src/test/factories.ts` | create | 1491 lines | Every fixture, shaped from verified server payloads, plus the one shared `frappe-react-sdk` module mock. |
| `src/test/renderPanel.tsx` | create | — | The shared panel harness: a per-render jotai store, router and tooltip provider, and `stubViewportMeasurement()`, which is required because `ui/list-view.tsx` virtualises through `useVirtualizer` and renders **zero rows** when jsdom reports an `offsetHeight` of 0. |
| **39** `*.test.{ts,tsx}` files | create | ~19.5k lines | The suites listed under [Suites](#suites) — **929 tests**, all passing, carrying the whole-source coverage gate to 80.97%. |

### Backend — four controllers and their four test modules

All additive or corrective; no DocType JSON, no schema change, no new or renamed endpoint.

| File | Scope | The change |
| --- | --- | --- |
| `bank_reconciliation_tool.py` | +84 / −25 | Permission enforcement on `get_linked_payments` (the reviewed **critical** finding: it read voucher candidates for any transaction the caller named, without checking that the caller may read that transaction or its bank account), a single permission-aware query for `get_older_unreconciled_transactions`, and currency validation on the submitted-document reconcile path. |
| `bank_transaction.py` | +4 / −0 | Currency validation reachable from the submitted-document path, so the FM5 promise the UI makes is one the server actually keeps. |
| `bank_transaction_rule.py` | +61 / −3 | Write-appropriate authorisation and company scoping on `run_rule_evaluation`, job de-duplication, and `enqueue_after_commit` so a freshly imported batch is visible to the job it triggers. |
| `bank_statement_import_log.py` | +7 / −3 | Rule evaluation enqueued after commit, for the same visibility reason. |
| `test_bank_transaction.py` | 8 → **10** | +79 lines, zero deletions. |
| `test_bank_transaction_rule.py` | 20 → **29** | +281 lines, zero deletions. Includes the two tests that close the one mandated scenario with no coverage anywhere in the repository — rule-based auto-match: that a matching rule stamps `matched_transaction_rule` and sets `is_rule_evaluated`, and that when two rules match, the lower priority number wins. They call the **private synchronous** evaluator, because the whitelisted entry point only checks permission and enqueues a background job, so a synchronous test asserting on the stamp could observe nothing. |
| `test_bank_reconciliation_tool.py` | 4 → **11** | +159 lines, zero deletions. Covers the authorisation refusals added above, including the cross-company IDOR case. |
| `test_bank_statement_import_log.py` | 13 → **15** | +68 lines, zero deletions. |

**Backend total: 45 → 102 tests**, every one passing. All are clean against this repository's own
`semgrep/test-correctness.yml`: no `frappe.db.commit()`, no `frappe.db.truncate()`, no `tearDown`
override.


## Known limits of this change set

Everything below is verifiable from this change set itself. Each entry names what is not covered,
the boundary that stops it, and what closing it would take.

| # | Where | What is not covered, and why | What closing it requires |
| --- | --- | --- | --- |
| 1 | `.github/workflows/**` | **No workflow runs the frontend gate.** The Python suites, including the ones added here, are already discovered on both database engines by the existing four-shard workflows. The frontend gate (`yarn typecheck && yarn lint && yarn test:coverage`) is not — no workflow in the repository mentions `vitest`, `yarn test` or `typecheck` — and it cannot be wired from here: the diff for this work is confined to this workspace and the bank DocType directories, so a workflow file is outside every permitted path. | A job on an existing workflow running those three commands on Node ≥ 24.15 — a change belonging to whoever owns those files. |
| 2 | Frontend test suite | **Every suite runs under jsdom**, which performs no layout and executes no subresources. Real scrolling, genuine rendering and true viewport measurement are out of reach; the suites assert on rendered output, roles and control state instead. Two consequences are worked around rather than solved: `ui/list-view.tsx` virtualises through `useVirtualizer` and renders **zero rows** when jsdom reports an `offsetHeight` of `0`, so panel suites install `stubViewportMeasurement()`; and the Pointer Capture API and `scrollIntoView` are stubbed in `src/test/setup.ts` because Radix `Select` cannot open without them. | A browser-driven regression suite, alongside the CI job in row 1. |
| 3 | Coverage measurement | **Only `lines` is gated, and the margin is thin.** The whole source tree is measured (2639 / 3259 = 80.97%), but the floor is 2608, so the margin is **+31 lines** — a new module of any size will turn the gate red until it carries a suite. Branch coverage sits at 67.91% and function coverage at 73.72%, both ungated: the suites assert on rendered behaviour rather than driving every defensive path. | Suites for new modules as they arrive, and a branch floor once branch coverage has been raised deliberately. |
| 4 | Backend test suite | **Multi-session concurrency is not expressed.** Observing one session's uncommitted transaction from another requires `frappe.db.commit()`, which this repository's own `semgrep/test-correctness.yml` bans in tests at ERROR severity. | Integration tests outside the unit harness, or a harness change agreed with whoever owns those rules. |
| 5 | `package.json` | **`yarn check --verify-tree` reports one error**, and it is the expected signature of the [`ws` override](#ws--the-one-advisory-with-no-in-range-fix) doing its job. `yarn audit` is clean at every severity and `yarn install --frozen-lockfile` passes. | Upstream `engine.io-client` widening its `ws` range, after which the override can be deleted. |
| 6 | `src/components/ui/markdown.tsx` | **Server-supplied markdown is rendered without a sanitiser.** Every `ErrorBanner` — including the new dialog — renders server text through this primitive, so the SPA's trust boundary is "the Frappe server is trusted". Closing it needs a sanitiser dependency, and this change set may add no runtime dependency; the file is also a design-system primitive, which are composed here and never modified. | A sanitiser dependency and a primitive change, as their own change set. |
| 7 | Pre-existing defects found but not fixed | Several latent defects were discovered while writing the suites and are **pinned by a `QUIRK`-labelled test** rather than corrected, because each lives in a file outside this change set's scope. The most consequential: `lib/amountFormula.ts` never throws and never returns `NaN` — it yields `0` for unparseable input — so `RuleForm`'s red "not a valid formula" warning is **unreachable** and a typo'd formula is presented as valid while previewing `0`. Also recorded: an unreachable `Loading...` branch in the import-log route, a blank `party_name` in the invoice-picker heading, a missing `.catch` on the unreconcile call, calendar-year and fiscal-year periods offered side by side, and a missing React key in `KeyboardShortcuts`. | Each in a change set that owns the file in question. The tests documenting them will fail loudly if the behaviour changes, which is the point. |


### Dependencies

`yarn audit` reports **0 vulnerabilities at every severity across 582 dependencies**, and
`yarn install --frozen-lockfile` passes against the committed lockfile.

That took **six re-resolutions and no dependency-version change in `package.json`**. Five of the six
sit **inside their existing declared range**, so they are lockfile-only; the sixth had no in-range
fix and required the [`ws` override](#ws--the-one-advisory-with-no-in-range-fix).

| Package | Declared by | Range | Before → After | Mechanism |
| --- | --- | --- | --- | --- |
| `react-router` | `package.json` (direct) | `^8.1.0` | `8.1.0` → **`8.3.0`** | in range |
| `brace-expansion` | `minimatch@3.1.5` | `^1.1.7` | `1.1.15` → **`1.1.18`** | in range |
| `brace-expansion` | `minimatch@10.2.5` | `^5.0.5` | `5.0.7` → **`5.0.9`** | in range |
| `socket.io-parser` | `socket.io-client@4.7.1` | `~4.2.4` | `4.2.6` → **`4.2.7`** | in range |
| `ws` | `engine.io-client@6.5.4` | `~8.17.1` | `8.17.1` → **`8.21.2`** | **`resolutions` override** — the range and the patched range do not intersect |
| `postcss` | `vite@8.1.2` | `^8.5.16` | `8.5.16` → **`8.5.25`** | in range, **collateral** — see below |

> **Two entries moved that nothing here asked for, and saying so matters.** Re-running the install
> re-resolved `postcss` from `8.5.16` to `8.5.25` inside its own declared `^8.5.16`, and that in turn
> moved its `nanoid` dependency range from `^3.3.12` to `^3.3.16`, so `nanoid` re-resolved from
> `3.3.15` to `3.3.16`. Neither was a target: both are ordinary caret-range drift that any
> `yarn install` on this manifest would produce, and neither addresses an advisory. They are
> recorded because a reviewer diffing the lockfile will find them and should not have to guess
> whether they were deliberate. **It is not true that nothing else re-resolved.**

Yarn Classic also emits Node's `DEP0169` deprecation warning for `url.parse()`. It is tooling-only
and is fixed by migrating the package manager, which is a repository-wide governance decision.


### Development server

The `dev` script binds to **`0.0.0.0`**, and `proxyOptions.ts` derives the upstream Frappe hostname
from the incoming request's **`Host` header**. Together those mean:

- **Run the dev server on a trusted network only.** Bound to `0.0.0.0` it is reachable by anything
  that can route to the machine, and Vite documents that permissive host handling exposes a
  development server to DNS-rebinding attacks.
- If you need it reachable off-host, prefer an explicit `server.allowedHosts` list over the open
  binding, and keep the binding on the loopback interface wherever the workflow allows it.
- Because the proxy target is derived from an untrusted header, a request carrying a crafted `Host`
  influences where the dev server forwards it. This affects **development only** — `build` produces
  static assets served by Frappe itself, and `proxyOptions.ts` is not part of the bundle.

`vite.config.ts` is frozen here and `proxyOptions.ts` changes only by one type annotation, so this
is guidance rather than a configuration change.

