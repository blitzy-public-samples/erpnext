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
- [The `resolutions` override — do not remove it](#the-resolutions-override--do-not-remove-it)
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

**Node.js ≥ 24.** Verified toolchain: **Node.js v24.18.1**, **npm 11.16.0**, and
**Yarn Classic 1.22.22** (activated with `corepack`).

There is no `.nvmrc` anywhere in the repository. The authoritative version signals are:

| Signal | Value |
| --- | --- |
| `frappe/package.json` → `engines.node` | `>=24` |
| CI container image | `ghcr.io/frappe/erpnext-ci-mariadb:py3.14-node24` |
| `vitest@4.1.10` → `engines.node` | `^20.0.0 \|\| ^22.0.0 \|\| >=24.0.0` |
| `jsdom@30.0.1` → `engines.node` | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` |

Node 24 is the only line that satisfies all four at once.

**Use Yarn, not npm.** This package ships a committed **Yarn Classic (v1)** `yarn.lock`, and the
[`resolutions`](#the-resolutions-override--do-not-remove-it) field below is a Yarn feature that
`npm install` does not honour. Install with `yarn install --frozen-lockfile`.

## Quick start

```bash
yarn install --frozen-lockfile   # respects the committed v1 lockfile
yarn typecheck                   # tsc -b — must exit 0
yarn lint                        # eslint .
yarn test                        # vitest run — no bench config needed
yarn test:coverage               # enforces the >= 80% aggregate line threshold
rm -rf coverage                  # generated output — see the coverage section
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
| `vitest` | `4.1.10` | The only Vitest line that supports Vite 8 — see [`resolutions`](#the-resolutions-override--do-not-remove-it) |
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
translation messages and a non-credential CSRF placeholder; the session cookie; and
`window.matchMedia` plus `ResizeObserver` — the only two browser APIs stubbed here, because
they are the two jsdom does not implement that the application and the Radix primitives
require.

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
than membership. The live asymmetries survive in the data — `can_cancel` holds five DocTypes and
none of the banking-specific ones; `can_import` excludes both `Bank Transaction Rule` and `Bank
Statement Import Log`. A suite that needs a **denied** permission assigns over the arrays it cares
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

| Suite | Subject |
| --- | --- |
| `src/components/features/BankReconciliation/MatchAndReconcile.test.tsx` | The workbench: transaction list, suggested match, manual override, confirm, the already-reconciled guard, the currency advisory |
| `src/components/features/BankReconciliation/utils.test.ts` | The typed API-client hook layer, its five cache-key families, the post-success revalidation and the post-rejection revalidation |
| `src/components/features/BankReconciliation/BankRecErrorDialog.test.tsx` | The dismissible error dialog — server text rendered verbatim, severity, dismissal |
| `src/components/features/BankStatementImporter/CSV/StatementDetails.test.tsx` | The import step: the document-method call shape, backend-error surfacing, the realtime progress listener, and the negative assertion that this surface posts to **no** endpoint but the document-method bridge |
| `src/pages/BankStatementImporter.test.tsx` | The importer surface: the three-state per-file badge, the log list and its projected fields, and negative authorisation |
| `src/lib/frappe.test.ts` | Frappe error parsing: the nested JSON-string envelope, the `_error_message` push, the `exception` colon-slice including its index-0 truthiness quirk, and the bare-`message` fallback |
| `src/lib/company.test.ts` | The `locals[':Company']` readers |
| `src/lib/currency.test.ts` | The currency readers and formatters |

**Eight suites, 361 tests, all passing.** On the backend, `test_bank_transaction_rule.py` carries
**22 tests** — the 20 that were already there plus the two added here; the three sibling bank
DocType modules are unchanged at 8, 4 and 13 tests respectively. See
[What this change set contains](#what-this-change-set-contains).

## Coverage gate

`yarn test:coverage` uses the **V8** provider and **exits non-zero** when coverage falls short,
so it is a gate rather than a report.

**Measured scope and gated scope are identical, and that is deliberate.** The coverage obligation
is scoped to the *new React components and API-client modules* under `src/`, so `coverage.include`
names exactly those nine units and `thresholds` is a single aggregate floor over them:

```ts
thresholds: { lines: 80 }
```

Keeping the two scopes identical is a property of Vitest, not a preference: a global threshold is
applied to **every file present in the coverage report**, so widening the measurement to the whole
of `src/` would silently widen the gate to the ~107 pre-existing modules this change set does not
touch and carries no suite for — turning a real 80% floor into an unmeetable one. Narrow, honest
and enforced beats broad and permanently red.

`coverage.exclude` still names its four entries (`src/types/**`, `src/test/**`, `**/*.d.ts`,
`src/main.tsx`) so the configuration stays correct if `include` is ever widened.

The nine measured-and-gated units, with their current line coverage:

| Unit | Changed here? | Lines |
| --- | --- | --- |
| `src/components/features/BankReconciliation/utils.ts` | yes | 98.67% |
| `src/components/features/BankReconciliation/bankRecAtoms.ts` | yes | 94.44% |
| `src/components/features/BankReconciliation/BankRecErrorDialog.tsx` | yes (new) | 100% |
| `src/components/features/BankReconciliation/MatchAndReconcile.tsx` | yes | 97.96% |
| `src/components/features/BankStatementImporter/CSV/StatementDetails.tsx` | yes | 100% |
| `src/pages/BankStatementImporter.tsx` | yes | 93.54% |
| `src/lib/frappe.ts` | no — shared error parser every failure path reads through | 100% |
| `src/lib/company.ts` | no — the company/default readers those surfaces resolve through | 100% |
| `src/lib/currency.ts` | no — the currency readers the FM5 advisory is computed from | 100% |

**Aggregate: 98.18% lines (486 of 495), against the 80% floor.**

The gate is **non-vacuous, and that was verified rather than assumed**: removing a single suite
(`MatchAndReconcile.test.tsx`) drops the aggregate to **59.19%** and `yarn test:coverage` exits
**1** with `ERROR: Coverage for lines (59.19%) does not meet global threshold (80%)`. Restoring the
suite returns it to green.

> **Adding a component or API-client module to this work means adding it to `coverage.include`.**
> That is the one list that decides both what is reported and what is gated, so a new unit is
> under the floor the moment it is named there — and a unit that is *not* named is neither
> measured nor gated, which is the trade-off this scoping accepts.

Three reporters run:

| Reporter | Output | Use |
| --- | --- | --- |
| `text` | console | The summary table, with uncovered line numbers per file |
| `json-summary` | `coverage/coverage-summary.json` | Machine-readable totals |
| `lcov` | `coverage/lcov.info` plus an HTML report under `coverage/lcov-report/` | `lcov.info` is the standard interchange format, and the repository already carries a Codecov configuration at `erpnext/codecov.yml`, so no extra reporting plumbing is needed here. For line-by-line annotation, open `coverage/lcov-report/index.html` in a browser. |

`coverage/` is generated output, never authored — and **this package's `.gitignore` and ESLint flat
config do not mention it**, because both files are frozen in this change set (see
[Intentionally unchanged files](#intentionally-unchanged-files)). Two consequences worth knowing
before you run the gate:

- `git status` reports `coverage/` as untracked afterwards. **Delete it** (`rm -rf coverage`) rather
  than committing it; if you run the gate often, add it to `.git/info/exclude`, which is local to
  your clone and changes no tracked file.
- `eslint .` run *after* a coverage run reports **3 warnings and 0 errors**, all of them
  `Unused eslint-disable directive` inside the HTML report's own vendored helper scripts
  (`coverage/lcov-report/{block-navigation,prettify,sorter}.js`). They come from generated output,
  never from source. Delete `coverage/` and `eslint .` is silent again.

> ⚠️ **Do not ask for Vitest's `basic` reporter.** It was **removed in Vitest 4** and requesting
> it fails with a module-load error. Use the default reporter.

## The `resolutions` override — do not remove it

`package.json` carries this field:

```json
"resolutions": { "vitest/vite": "8.1.2" }
```

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

> ⚠️ **Do not delete this field** while cleaning up `package.json`. It looks like a leftover and it
> is load-bearing; removing it breaks `yarn install` for everyone.

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
- **Every user-visible string passes through the translation helper `_()` from
  `@/lib/translate`.** This is universal across the SPA, and new code must follow it — dialog
  titles, button labels, tooltips and badge text included.
- **Styling uses design tokens, never hardcoded values,** and UI is built from the primitives in
  `src/components/ui/` rather than raw HTML elements. Note that `Badge` declares no `amber`
  theme — `variant="subtle" theme="orange"` is what resolves to the amber ink and surface tokens.

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
| **FM5** | The transaction's currency differs from the bank account's | A **non-blocking** advisory badge beside the rule badge, with its explanation in a tooltip. It does **not** disable confirm. The predicate is *derived* from the server rather than designed: `validate_currency` on `Bank Transaction` resolves `Bank Account.account` → `Account.account_currency`, and `bank_account.get_list` attaches `account_currency` to each row through that identical lookup, so the two sides cannot disagree. Either side may legitimately be unknown — `currency` is optional on the transaction, and `account_currency` is not a native `Bank Account` field but one attached at query time — and unknown means *nothing to compare*, never *mismatch*, so no badge is shown. The tooltip states the division of responsibility plainly: the indicator does not block the reconciliation, the server applies its own currency rule, and it may refuse to post. When it does refuse, that refusal arrives through the FM1 dialog. |

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

`vite.config.ts` · `tsconfig.json` · `tsconfig.app.json` · `tsconfig.node.json` ·
`eslint.config.js` · `.gitignore` · `.env.production` · `index.html` · `src/index.css` ·
everything under `src/components/ui/` · everything under `src/types/` · and the
`"version": "0.0.0"` field in `package.json` — a Vite-scaffold artefact, not a statement about how
complete this application is.

Freezing that list is a **requirement of this change set, not a preference**: it freezes the build
and lint configuration, so a convenience edit to any of it puts a file in the diff that does not
belong there. Two of those files are the reason for caveats documented above:

| Frozen file | The caveat it produces |
| --- | --- |
| `.gitignore` | Does not list `coverage`, so a coverage run leaves an untracked directory — [delete it](#coverage-gate) instead of ignoring it. |
| `eslint.config.js` | Does not ignore `coverage` either, so `eslint .` after a coverage run reports [3 warnings from generated files](#coverage-gate). |

Three source files are worth calling out separately, because each is somewhere a well-intentioned
improvement genuinely belongs and is still out of bounds *here*:

| Frozen file | Why it is tempting, and why it is frozen anyway |
| --- | --- |
| `src/lib/frappe.ts` | The shared error parser, and the error-transport contract for the whole SPA. It calls `JSON.parse` on `_server_messages` without a guard. That is unreachable through the real transport — `_server_messages` exists only once the response body has already parsed as JSON — and `src/lib/frappe.test.ts` specifies the behaviour as it actually is, limits included, rather than as one might wish it were. |
| `src/components/ui/markdown.tsx` | The single sink through which every `ErrorBanner` renders server markup. It is a design-system primitive, and primitives here are composed, never modified. |
| `src/components/features/BankStatementImporter/import_utils.ts` | `GetStatementDetailsResponse` declares a top-level `currency` that `get_statement_details` never returns, so every screen reads `data.doc.currency` instead. Noted, not fixed: it is not a file this change set may alter. |

## What this change set contains

**Twenty-two paths: ten updated, twelve created, none deleted.** `git diff --name-status <baseline>`
should show precisely this set and nothing else. Twenty-one are under this workspace; the
twenty-second is a single additive backend test module.

Every edit to an existing file is measured in **lines, not files**, and each one carries an in-place
comment explaining itself.

### Frontend — configuration and documentation

| File | Op | Scope | The change |
| --- | --- | --- | --- |
| `package.json` | update | +15 / −2 | Exactly three scripts (`test`, `test:coverage`, `typecheck`), seven exactly-pinned test dependencies, and the [`resolutions` override](#the-resolutions-override--do-not-remove-it). |
| `yarn.lock` | update | generated | Regenerated by the install that added those seven packages. Committed deliberately: `yarn install --frozen-lockfile` is the documented install command, and it cannot resolve new dependencies from a lockfile that predates them. |
| `proxyOptions.ts` | update | +4 / −1 | An `import type` for the Node HTTP request type and the parameter annotation that removes the one implicit-`any` error in the package — the only TypeScript error the repository had, and the reason `yarn typecheck` now exits 0. |
| `README.md` | update | whole file | This document, replacing the stock Vite scaffold text. |
| `vitest.config.ts` | create | 87 lines | The runner configuration: jsdom, globals, the setup file, the test glob, the `@` alias, V8 coverage with three reporters, and the single aggregate `{ lines: 80 }` gate. Deliberately independent of `vite.config.ts`. |

### Frontend — application source

| File | Op | Scope | The change |
| --- | --- | --- | --- |
| `bankRecAtoms.ts` | update | +37 / −1 | One import and **two plain in-memory atoms** appended to the sixteen already there: the error-dialog payload (`FrappeError \| null`) and the per-log failure markers (`Record<string, FrappeError>`, holding the raw errors). Neither is persisted — a stale error dialog or failure marker must not survive a reload — and the comment says so, because neighbouring atoms *are* persisted. No existing atom, interface or persisted key changes shape. |
| `utils.ts` | update | +19 / −1 | `bankRecErrorDialogAtom` added to the existing import; four reads at the top of `useReconcileTransaction` (never inside a callback, which `react-hooks/rules-of-hooks` forbids as an error); and, in the existing `.catch`, the raw error routed to the dialog atom plus exactly two `mutate()` calls on the unreconciled-transactions and bank-transactions keys. No sixth cache key, no optimistic mutation. |
| `MatchAndReconcile.tsx` | update | +79 / −4 | Exactly three edits and one import: the dialog mount beside the three existing modal mounts; the FM5 advisory badge in the transaction row's badge cluster, reusing the currency already in scope; and the FM3 already-reconciled guard on the confirm control, with its reason on a focusable wrapper span. |
| `CSV/StatementDetails.tsx` | update | +31 / −3 | The rejection callback now *takes* the error — it previously took none and discarded it — routes it to the dialog and records the per-file marker under this import log's name; plus the dialog mount. The `run_doc_method` call shape, the success-path date extraction and navigation, and the realtime progress subscription are untouched. One edit, two flows: both the CSV and PDF importers use this module. |
| `pages/BankStatementImporter.tsx` | update | +21 / −2 | The per-row status badge gains a third, red `Failed` state driven by the failure map, and the dialog is mounted here too because this page sits in a different route tree. |
| `BankRecErrorDialog.tsx` | create | 76 lines | The dismissible dialog, composed from the existing `AlertDialog` and `ErrorBanner`. The Frappe error is passed through **by identity** — no re-encoding, no field clearing — so the banner parses the server's own envelope and picks its own severity from it. |

### Frontend — test infrastructure and suites

| File | Op | Scope | The change |
| --- | --- | --- | --- |
| `src/test/setup.ts` | create | 564 lines | The Desk-runtime harness described under [The harness](#the-harness). A pure side-effect module — zero exports. |
| `src/test/factories.ts` | create | 1991 lines | Every fixture, shaped from verified server payloads, plus the one shared 13-symbol `frappe-react-sdk` module mock. |
| Eight `*.test.{ts,tsx}` files | create | 7731 lines | The suites listed under [Suites](#suites) — **361 tests**. |

### Backend — one additive test module

| File | Tests | What was added |
| --- | --- | --- |
| `erpnext/accounts/doctype/bank_transaction_rule/test_bank_transaction_rule.py` | 20 → **22** | +113 lines, **zero deletions**, one added import. Two tests close the one mandated scenario that had no coverage anywhere in the repository — rule-based auto-match: that a matching rule stamps `matched_transaction_rule` and sets `is_rule_evaluated`, and that when two rules match, the lower priority number wins. They call the **private synchronous** evaluator, because the whitelisted entry point only checks permission and enqueues a background job, so a synchronous test asserting on the stamp could observe nothing. Clean against this repository's own `semgrep/test-correctness.yml`: no `frappe.db.commit()`, no `frappe.db.truncate()`, no `tearDown` override. |

The three sibling bank DocType test modules are **unchanged** and still pass at 8
(`test_bank_transaction.py`), 4 (`test_bank_reconciliation_tool.py`) and 13
(`test_bank_statement_import_log.py`) tests.

## Known limits of this change set

Everything below is verifiable from this change set itself. Each entry names what is not covered,
the boundary that stops it, and what closing it would take.

| # | Where | What is not covered, and why | What closing it requires |
| --- | --- | --- | --- |
| 1 | `.github/workflows/**` | **No workflow runs the frontend gate.** The Python suites, including the two tests added here, are already discovered on both database engines by the existing four-shard workflows. The frontend gate (`yarn typecheck && yarn lint && yarn test:coverage`) is not, and cannot be wired from here: the diff for this work is confined to this workspace and the bank DocType directories, so a workflow file is outside every permitted path. | A job on an existing workflow running those three commands on Node ≥ 24 — a change belonging to whoever owns those files. |
| 2 | Frontend test suite | **Every suite runs under jsdom**, which performs no layout and executes no subresources. Virtualised row measurement, real scrolling and genuine browser rendering are therefore out of reach; the suites assert on rendered output, roles and control state instead. | A browser-driven regression suite, alongside the CI job in row 1. |
| 3 | Coverage measurement | **Only the nine units named in `coverage.include` are measured or gated.** The remaining ~107 modules of the SPA — the large modal bodies, the PDF table editor, the 43 primitives and the other pre-existing pages — are untouched by this work and carry no suite, so they are neither reported nor gated. Widening the measurement would widen the single global gate onto them; see [Coverage gate](#coverage-gate). | Suites for those modules, added to `coverage.include` as they arrive. |
| 4 | Backend test suite | **Multi-session concurrency is not expressed.** Observing one session's uncommitted transaction from another requires `frappe.db.commit()`, which this repository's own `semgrep/test-correctness.yml` bans in tests at ERROR severity. | Integration tests outside the unit harness, or a harness change agreed with whoever owns those rules. |
| 5 | `yarn.lock` | **`yarn audit` exits non-zero** — see [Dependencies](#dependencies). Every vulnerable version is byte-identical to the baseline, so nothing here introduced one and nothing here upgrades one: this change set adds seven test packages and re-resolves nothing else. | A dedicated dependency change set raising the packages to the floors tabulated below. |
| 6 | `vitest.config.ts` | **It is not type-checked**, because neither `tsconfig` program includes it and both are frozen here. A type error in it surfaces at `yarn test` config load rather than at `yarn typecheck`. | Adding it to the tooling program's `include`, as a build-configuration change. |

### Dependencies

`yarn audit` currently exits **12** (17 high, 1 moderate, across 582 dependencies). **Every
vulnerable version below is byte-identical to the baseline this change set started from** —
verified by comparing the committed `yarn.lock` against the baseline's — so none was introduced by
the seven test packages added here, and none is upgraded here either. Recorded rather than silently
upgraded, with the fixed floors, so the upgrade can be planned as its own change:

| Package | Resolved | Fixed floor | Reachability |
| --- | --- | --- | --- |
| `brace-expansion` | `1.1.15` | `>= 1.1.18` | CPU/OOM advisories in development and CI glob tooling; not in the browser bundle. |
| `brace-expansion` | `5.0.7` | `>= 5.0.9` | OOM and mitigation-bypass advisories in the same tooling. |
| `react-router` | `8.1.0` | `>= 8.3.0` | An RSC-action CSRF advisory. This SPA uses the declarative `BrowserRouter`, not the unstable RSC mode, so the advisory is not on a path this app takes — upgrade as defence in depth. |
| `socket.io-parser` | `4.2.6` | `>= 4.2.7` | Zero-attachment reconstruction memory exhaustion. The intended peer is the trusted same-origin Frappe server. |
| `ws` | `8.17.1` | `>= 8.21.0` | Uninitialised-memory disclosure and fragment OOM. The browser build uses the native `WebSocket`; the Node fallback and tooling remain exposed. |

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

