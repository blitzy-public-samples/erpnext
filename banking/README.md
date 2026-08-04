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
> and nothing reads it. The workspace holds 163 tracked files — none of them empty — and
> over 1.2 MB of hand-written TypeScript/TSX, including a complete five-tab reconciliation
> workbench, 43 design-system primitives under `src/components/ui/` and 17 generated DocType
> declarations under `src/types/`. The version string is deliberately left as it is.

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
- [The hand-off from import to review](#the-hand-off-from-import-to-review)
- [Scope boundaries](#scope-boundaries)
- [Intentionally unchanged files](#intentionally-unchanged-files)
- [Accepted limitations](#accepted-limitations)

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
yarn test:coverage               # enforces the >= 80% line threshold
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
| `test:coverage` | `vitest run --coverage` | V8 provider; emits `text` + `json-summary` + `lcov`; **fails the process** below the configured line thresholds. |
| `typecheck` | `tsc -b` | The whole type gate, and the only one. It exists because **`build` never invokes the compiler**, so without this script a type error would not be observable from this package's scripts at all. `tsc -b` covers both programs — including `vitest.config.ts`, which `tsconfig.node.json` names in its `include` — so no second command is needed; see [TypeScript project layout](#typescript-project-layout). |

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
existing application mounts unmodified under jsdom. It installs, synchronously and at top
level: the boot user (a non-`Guest` name, because the router is gated on it) with its roles and
all eight `can_*` permission arrays; `boot.sysdefaults` and `boot.user.defaults`; the
`locals[':Currency']` and `locals[':Company']` maps; the desk theme, layout direction,
translation messages and a non-credential CSRF placeholder; the session cookie; and
`window.matchMedia` plus `ResizeObserver`, neither of which jsdom implements and both of which
the app and the Radix primitives require. It also registers the jest-dom matchers and restores
the whole boot fixture between tests.

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
about on `window.frappe.boot.user` with a two-line local helper, and the harness rebuilds the whole
profile before and after every test, so nothing leaks. `setup.ts` **exports nothing**: it is a pure
side-effect module.

`src/test/factories.ts` holds every fixture: builders shaped from the verified server payloads
(unreconciled / rule-matched / reconciled / currency-mismatch transactions, bank accounts,
linked payments, transaction rules, import logs), error builders that reproduce Frappe's real
`_server_messages` envelope and its `_error_message` fallback, success-response builders, and a
single `frappe-react-sdk` mock surface (`frappeSDKMock`, `createFrappeSDKMock`,
`resetFrappeSDKMock`, the individual call spies, and helpers for the realtime listeners) so no
suite hand-rolls its own module mock.

### Suites

| Suite | Subject |
| --- | --- |
| `src/components/features/BankReconciliation/MatchAndReconcile.test.tsx` | The workbench: transaction list, suggested match, manual override, confirm, the already-reconciled guard, the currency advisory |
| `src/components/features/BankReconciliation/utils.test.ts` | The typed API-client hook layer, its cache keys, and the post-rejection revalidation |
| `src/components/features/BankReconciliation/BankRecErrorDialog.test.tsx` | The dismissible error dialog — server text rendered verbatim, severity, dismissal |
| `src/components/features/BankStatementImporter/CSV/StatementDetails.test.tsx` | The import step: the `Completed`-doc outcome requirement, backend-error surfacing, the cache eviction before review, the realtime progress listener, and the negative assertion that this surface posts to **no** endpoint but the document-method bridge |
| `src/pages/BankStatementImporter.test.tsx` | The importer surface: the single-flight upload chain, server-owned log identity, the uploaded file's lifecycle (cleanup and relink retry), per-file status for failures with and without a log, the log's own currency, and negative authorisation |
| `src/lib/frappe.test.ts` | Frappe error parsing: the nested JSON-string case, the fallback chain, and the two specified **limits** of this frozen shared parser — it throws on a malformed or non-array envelope, and keeps message-less entries — which is why the failure paths read through `readServerMessages` instead |
| `src/lib/sanitize-html.test.ts` | The shared markup sanitiser: the element and attribute allow-lists, dropped subtrees, unwrapping, the same-origin URL boundary and every refused `href` spelling |
| `src/lib/company.test.ts` | The `locals[':Company']` readers |
| `src/lib/currency.test.ts` | The currency readers and formatters |

Nine suites, **576 tests**, all passing. The backend suites for the four bank DocTypes carry a
further **70 tests** — see [What this work did change](#what-this-work-did-change).

## Coverage gate

`yarn test:coverage` uses the **V8** provider and **exits non-zero** when coverage falls short,
so it is a gate rather than a report.

**Measured scope is the whole application.** `coverage.include` is `src/**/*.{ts,tsx}`, with only
four exclusions — the generated DocType declarations (`src/types/**`), the harness itself
(`src/test/**`), declaration files, and the browser entry point (`src/main.tsx`). Nothing else is
hidden from the measurement, so the `All files` row of the text reporter is the honest figure for the
SPA as a whole and is currently **≈42% lines**.

**The 80% floor is enforced per unit, over the scope the obligation names.** The requirement this
work implements scopes the ≥80% line-coverage obligation to *new React components and API-client
modules*, and `thresholds` therefore carries an explicit `{ lines: 80 }` key for each of the ten
units below — the six source files this change set modified, plus the four shared helpers every
failure path resolves through. There is deliberately **no global aggregate floor**: a single
whole-SPA `lines: 80` would be unsatisfiable by the eight-suite test list the plan prescribes (the
untested remainder is ~150 files of pre-existing screens), and setting one would leave the gate
permanently red for a reason unrelated to this change set. Per-unit keys make the floor precise
instead of approximate — a weak new module cannot be carried over the line by easier files around it,
and the whole-SPA figure is still reported rather than hidden.

> ⚠️ A threshold key naming a file that `include` omits does **not** fail: Vitest builds an empty
> coverage map for it, `resolveThresholds()` skips it as "not included by glob patterns", and the
> gate passes on a file nothing measured. That is precisely why `include` is the broad glob here —
> every threshold key is inside it by construction.

The ten gated units, and their measured line coverage:

| Unit | Changed here? | Lines |
| --- | --- | --- |
| `src/components/features/BankReconciliation/utils.ts` | yes | 99.01% |
| `src/components/features/BankReconciliation/bankRecAtoms.ts` | yes | 95.45% |
| `src/components/features/BankReconciliation/BankRecErrorDialog.tsx` | yes (new) | 100% |
| `src/components/features/BankReconciliation/MatchAndReconcile.tsx` | yes | 98.01% |
| `src/components/features/BankStatementImporter/CSV/StatementDetails.tsx` | yes | 100% |
| `src/pages/BankStatementImporter.tsx` | yes | 98.66% |
| `src/lib/sanitize-html.ts` | yes (new) | 100% |
| `src/lib/frappe.ts` | no | 100% |
| `src/lib/company.ts` | no | 100% |
| `src/lib/currency.ts` | no | 100% |

`src/components/ui/markdown.tsx` is also changed here — it is the single sink where the shared
sanitiser is wired in — and measures **100%** lines. It is not a gated key because it is a
design-system primitive rather than a component or API-client module this work authored; the
sanitiser it calls is gated in its place.

`coverage.exclude` names exactly four things and keeps the broad `include` honest: generated DocType
declarations (`src/types/**`), the harness itself (`src/test/**`), declaration files, and the browser
entry point (`src/main.tsx`).

> **Adding a component or API-client module to this work means adding a `thresholds` key for it.**
> `include` already covers it — the glob is the whole of `src/` — so the only thing a new unit needs is
> its own `{ lines: 80 }` entry, which is what puts it under the floor rather than merely in the
> report.

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
"resolutions": {
  "vitest/vite": "8.1.2"
}
```

It looks cosmetic. It is not — **installation fails outright without it**, and the four points
below are the whole reason it exists.

1. **It is mandatory, not a warning-silencer.** Both an incremental `yarn add -D …` and a clean
   `rm -rf node_modules && yarn install` abort with a Yarn **invariant violation**, complaining
   that it could not find a copy of Vite to link inside `node_modules/vitest/node_modules`.
2. **Root cause.** Vitest 4.1.x declares `vite` in **both** `dependencies` **and** non-optional
   `peerDependencies` (`^6.0.0 || ^7.0.0 || ^8.0.0`, with `peerDependenciesMeta.vite.optional`
   false). Yarn Classic cannot reconcile the dual declaration and tries to link a nested private
   copy that was never fetched.
3. **There is no downgrade escape.** Vitest `3.2.4` supports `vite` `^5 || ^6 || ^7-0`;
   `4.0.0` supports `^6 || ^7`; only the **`4.1.x`** line supports Vite 8 — and that is
   precisely the line that trips Yarn Classic. Since this package pins `vite: "^8.0.16"`, the
   `4.1.x` line is forced and the override is the only viable path. Check any of those for
   yourself with `npm view vitest@<version> peerDependencies.vite`.
4. **The pin changes nothing about the resolved graph.** `yarn.lock` already resolves
   `vite@^8.0.16` to `8.1.2`, and its single deduped entry covers the app's range, Vitest's peer
   range and this pin together. The override merely tells Yarn what it could not work out for
   itself.

Verify after installing: `node_modules/vitest/node_modules` contains **no** nested `vite` (only
an unrelated glob helper), and the root `vite` is still `8.1.2`.

## TypeScript project layout

Three configuration files. Two are intentionally unchanged; `tsconfig.node.json` gains exactly one
entry in its `include`, for the reason below:

| File | Role |
| --- | --- |
| `tsconfig.json` | Solution file: `files: []`, references `./tsconfig.app.json` and `./tsconfig.node.json`, and declares `baseUrl: "."` with `paths { "@/*": ["./src/*"] }` |
| `tsconfig.app.json` | The application program: `include: ["src"]`, `target` `ES2020`, `lib` `["ES2020", "DOM", "DOM.Iterable"]`, `moduleResolution` `bundler`, `jsx` `react-jsx`, and `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports` all enabled. It declares **no `types` array.** |
| `tsconfig.node.json` | The tooling program: `include: ["vite.config.ts", "vitest.config.ts"]`, `types: ["node"]`, `target`/`lib` `ES2023`, with `verbatimModuleSyntax` and `erasableSyntaxOnly` enabled — which is why `proxyOptions.ts` imports its Node HTTP request type with `import type` |

`tsc -b` builds both programs, so the whole of `src/` — application code and colocated suites
alike — plus `vite.config.ts`, `vitest.config.ts` and the `proxyOptions.ts` that the former imports
are all type-checked.

**`vitest.config.ts` is inside the tooling program, and that is the one line of configuration this
change set adds.** The runner's own configuration owns the coverage gate, so a type error in it must
not compile clean — yet the tooling program's `include` originally named `vite.config.ts` only, which
meant `tsc -b` never read it and such an error would surface only when `yarn test` next failed at
config load. Adding the file to that `include` is a one-entry, additive change inside this workspace,
and it makes `yarn typecheck` a single command (`tsc -b`) rather than a compound one. The runner
config is tooling code that runs under Node, so being checked under the tooling program's settings is
also the correct choice on the merits.

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
| `src/components/ui/` | 43 Espresso Design System primitives — **composed, never modified**, with one exception: `markdown.tsx`, the single sink where the shared sanitiser is registered |
| `src/lib/` | Shared helpers: `frappe.ts` (server-error parsing), `sanitize-html.ts` (the shared markup allow-list), `currency.ts`, `company.ts`, `translate.ts`, `date.ts`, `numbers.ts`, `permissions.ts`, and others |
| `src/hooks/` | Cross-cutting hooks: current company, DocType metadata, fiscal year, multi-file upload progress, payment-entry calculations, viewport |
| `src/types/` | 17 generated DocType declarations — **not hand-written**, and excluded from coverage |
| `src/test/` | The Vitest harness: `setup.ts` and `factories.ts` |
| `src/index.css` | The Espresso theme tokens |

## Conventions

- **State is jotai, and only jotai.** There is no Redux store, no bespoke context and no service
  container. Persistence is deliberate: `atomWithStorage` over `localStorage` for the selected
  bank account, the date range and the match filters; `createJSONStorage` over `sessionStorage`
  for the session action log; plain in-memory atoms for anything that must **not** survive a
  reload — the error-dialog payload and the per-file import-failure map, which are the only two
  atoms this work added. A stale error dialog, or a stale failure marker, must not outlive the
  session that observed it. All four persisted keys are suffixed `::<site>::<user>`, so one
  reviewer's selection, dates, filters and action log are never read back under another's session.
- **Data fetching is `frappe-react-sdk` hooks with explicit SWR cache keys.** Backend calls for
  the reconciliation feature are centralised as typed hooks in
  `src/components/features/BankReconciliation/utils.ts`; new calls extend that module and reuse
  its existing key families rather than introducing new ones.
- **The server is the sole source of truth for financial state.** Confirming and posting a
  reconciliation is one server-side operation, and its response decides the outcome. No client
  state is mutated optimistically, and the client never deduplicates or synthesises
  transactions.
- **Errors are parsed, sanitised and rendered through shared code.** `src/lib/frappe.ts` reads
  Frappe's `_server_messages` envelope with an `_error_message` fallback;
  `src/components/ui/error-banner.tsx` renders the result, choosing its own severity from the
  server's; and `src/components/ui/markdown.tsx` filters the markup through
  `src/lib/sanitize-html.ts` before it becomes DOM. New error surfaces compose those rather than
  paraphrasing server text or sanitising for themselves — one sink, one allow-list.
- **Every user-visible string passes through the translation helper `_()` from
  `@/lib/translate`.** This is universal across the SPA, and new code must follow it — dialog
  titles, button labels, tooltips and badge text included.
- **Styling uses design tokens, never hardcoded values,** and UI is built from the primitives in
  `src/components/ui/` rather than raw HTML elements.

## Workflow behaviour and the five failure modes

The workflow is: **import a statement → review the rule-suggested match → confirm it or override
it → post the reconciliation**. Everything below describes how that behaves when something goes
wrong, because those behaviours are requirements rather than implementation details.

The server is the authority throughout. One dismissible error dialog serves every surface: it is
driven by a single in-memory atom, mounted at three sites (the workbench, the statement-import step
and the importer list, which live in different route trees), and it passes the Frappe error
envelope through **unmodified** so the backend's own wording, title and severity reach the reviewer
verbatim. It closes on `Escape` and on **Dismiss**, and dismissing it changes nothing else.

Two boundaries in that path are worth naming, because both were places where a failure could have
denied the reviewer the account of a refusal they were owed:

- **The parse cannot throw.** `lib/frappe.ts` is the shared parser every `ErrorBanner` in the SPA
  reads through, and it is frozen by this change set — it calls `JSON.parse` on `_server_messages`
  unguarded. Every failure path here therefore reads through `readServerMessages` /
  `readErrorText` in `BankReconciliation/utils.ts`, which is total. That matters because the parse
  used to run *before* the dialog was raised, the selection cleared and the caches revalidated, so a
  truncated response would have abandoned all three. When the envelope is unreadable, resolution
  falls back through the shared module's own `_error_message → exception → message` chain rather
  than to silence.
- **Server markup is sanitised before it is rendered — at the shared sink, for every consumer.**
  `_server_messages` is HTML, and `src/components/ui/markdown.tsx` runs `rehypeRaw`, which turns it
  into live DOM. One restrictive AST sanitiser (`src/lib/sanitize-html.ts`) now runs immediately after
  `rehypeRaw` in that single renderer, so **every** consumer is behind it: the new dialog, the ~23
  pre-existing *inline* `ErrorBanner` call sites, and the six other `MarkdownRenderer` users alike.
  It filters by allow-list rather than by denial — 35 elements, four global attributes plus a short
  per-element list, a same-origin boundary on every URL attribute, `rel="noreferrer noopener"` stamped
  on surviving anchors, and 34 subtrees (script, style, iframe, img, form controls, svg, template)
  dropped whole. An element that is neither allowed nor dropped is **unwrapped**, so no server text is
  ever lost: text is preserved character for character and only markup is removed. Wiring it at the
  one sink, rather than at each consumer, is why the dialog itself passes the error through
  **unmodified**.

| # | Situation | Behaviour |
| --- | --- | --- |
| **FM1** | The confirm/post request fails — refused by the server, or no response at all | The dialog shows the server's own message, passed through **unmodified**: the client paraphrases nothing and adds no wording of its own, and the parse cannot throw (see the note under the table). Confirm/post is **one** server-side call and **nothing is mutated optimistically**, so *this client* contributes no partial state: the transaction stays unreconciled with its state unchanged. The rejection handler then does two things and only two: it **clears the transaction selection**, which withdraws the Reconcile affordance outright (see FM3), and it revalidates the two transaction-list cache keys so the next render is built from the server's current figures. Concurrent duplication is refused at three depths: a shared single-flight guard within one browser, the server's already-reconciled state check, and — since this change set — a `SELECT … FOR UPDATE` row lock around that check, the allocation, the clearance writes and the status transition, so two concurrent sessions can no longer both act on the same stale `unallocated_amount`. |
| **FM2** | A malformed or empty statement file | The server refuses the import synchronously and rolls it back; the refusal reaches the reviewer twice over. It opens the shared dialog in the server's own words, and it marks that **one file** on the importer list: a red **Failed** chip in place of the stored status, carrying the server's message as its tooltip and on its accessible name, and reachable by keyboard as well as pointer. No transaction is ever created client-side. The chip is driven from the observed rejection rather than from the document because `Bank Statement Import Log` has exactly two status values — `Not Started` and `Completed` — and **no error field**: a rolled-back import leaves the row saying `Not Started`, indistinguishable from one merely waiting to be imported, so the failure has nowhere else to live. The marker is held in memory, keyed by import-log name, and is deliberately **not** persisted. |
| **FM3** | The transaction has already been reconciled | Confirm is **disabled**, on the backend's own predicate — `status === 'Reconciled'` or `unallocated_amount <= 0`, which the server derives from one another — and a tooltip on a focusable wrapper says why. This is an affordance, not the control: the authoritative guard is the first statement of the first method `reconcile_vouchers` invokes, and this SPA never decides a financial outcome for itself. A stale client that gets through is refused by the server, and the refusal is handled **fail-closed**: the selection is cleared *unconditionally*, so the Reconcile control is withdrawn rather than merely greyed, and it cannot come back on its own — not on a timer, and not because a revalidation request also failed. The affordance returns only when the reviewer selects a transaction again, against list data re-read from the server. |
| **FM4** | A re-import produces duplicate transactions | Rendered exactly as the backend produces them. **There is no client-side deduplication, and none may be added.** |
| **FM5** | The transaction's currency differs from the bank account's | A **non-blocking** amber advisory badge beside the rule badge, with its explanation in a tooltip and in an `sr-only` description sharing the same string. It does **not** disable confirm. The account currency it compares against is read from the **current** `bank_account.get_list` response — through `useSelectedBankAccountCurrency()`, which reads the account list already in the SWR cache and therefore issues no extra request — and *not* from the `selectedBankAccountAtom` snapshot in `localStorage`, which is written once when an account is picked and is never refreshed while that account stays selected. Both sides resolve the value by the same lookup (`Bank Account.account` → `Account.account_currency`). Where no account currency is known yet, there is nothing to compare and no badge is shown. The backend now enforces the mismatch on this path too: `validate_currency()` is called from `reconcile_vouchers` immediately after the locked load — before anything is written — and again from `before_update_after_submit`, which covers every other update-after-submit path. (`validate()` alone was insufficient, because Frappe routes a save on a submitted document through `update_after_submit`, which never runs it.) So the badge is advisory and the server is authoritative, which is exactly the required division: the indicator does not block, and the refusal, when it comes, arrives through the FM1 dialog. |

### The hand-off from import to review

Two things stand between a committed import and the reviewer seeing its rows with their suggested
matches. Both were defects, both are fixed, and both are the kind that a green test suite can miss —
so they are recorded here in full.

**The imported range's cache entries are EVICTED, not merely "revalidated".** SWR's global `mutate`
behaves differently depending on how many arguments it is given. Called as `mutate(key)` it takes the
`args.length < 3` branch: it notifies the revalidators that **mounted** `useSWR` hooks registered for
that key, and touches the cached data not at all. Navigating from the importer to the workbench
unmounts those hooks, so at the moment of the call the keys have *no* revalidators — the call resolves
having done nothing, the stale entry stays in the cache, and because
`useGetUnreconciledTransactions` is configured `revalidateIfStale: false` the remounted hook serves
that stale entry and issues no request. For the very common case of importing a statement covering the
range already on screen, the import appeared to have done nothing at all. The fix is the three-argument
form, `mutate(key, undefined, { revalidate: true })`: SWR writes `data: undefined` into the entry
(`populateCache` defaults to true), and `useSWR`'s initial-revalidation decision is
`isUndefined(data) || revalidateIfStale`, so an entry with no data is always re-fetched whatever the
stale setting says. A suite asserts both halves — the one-argument form reproducing the stale list, and
the three-argument form producing the imported row — against a **real** SWR cache across an
unmount/remount, not against a mock.

**Rule evaluation is queued after the rows commit.** `insert_transactions` used to enqueue the
evaluation pass *before* it saved the log, with `enqueue_after_commit` off — so a worker could pick the
job up immediately, read none of the just-inserted rows on its own connection, and finish having
stamped nothing. The reviewer then opened the workbench to no suggested match at all and had to wait
for the next scheduled pass. The save now comes first and the pass is queued through
`enqueue_rule_evaluation(bank_account=self.bank_account)`, which sets `enqueue_after_commit=True` and
does **not** deduplicate, so the worker is guaranteed to see the rows and a second import of the same
account can never be collapsed into a pass that already started. The client is not involved in either
half: it does not call the rule evaluator, and a suite asserts that it never does.

## Scope boundaries

What this package does **not** do, stated so a reader does not go looking:

| Boundary | Status |
| --- | --- |
| Backend endpoints | **None added, none removed, none renamed.** Every call the workflow makes already existed and was already whitelisted, so the conditional authorisation to add one never applied. Four of them were **hardened in place** — row locks, authority ordering, voucher validation, HTTP-method restriction and server-derived scope — see [What this work did change](#what-this-work-did-change). |
| DocType schema | **No** field, status option, JSON edit, migration or patch entry. |
| REST/RPC contract | Unchanged, including the call style: module functions by dotted path, the one document method through the generic `run_doc_method` bridge. |
| Routes and providers | Unchanged. The dialog is mounted inside existing trees; no route or provider was added. |
| Design system | **No** new token and **no** new primitive. New affordances compose the primitives in `src/components/ui/`. |
| CI workflows | Unchanged, and necessarily so. The Python suites — including every test added here — are already discovered on both database engines by the existing four-shard workflows, so no edit is needed for them. The frontend gate (`yarn typecheck && yarn lint && yarn test:coverage`) is **not** wired into a workflow, and cannot be from here: `.github/workflows/**` lies outside every path this change set may touch. Recorded as an [accepted limitation](#accepted-limitations). |
| `frappe/` submodule | Untouched, pointer and contents. `frappe/cypress/` is referenced for **conventions only**; no Cypress spec is added here. |
| Backend diff | **Eight files, all inside the four bank DocType directories the acceptance criterion permits** — the four controllers, hardened in place, and their four test modules, extended additively. No DocType JSON, no migration, no fifth directory. See [What this work did change](#what-this-work-did-change) for every line, and [why those directories are in the diff](#why-the-four-controllers-are-in-the-diff). |

Out of scope as features: no Plaid interface, no MT-940/XML ingestion in this SPA (the dropzone
accepts CSV, XLSX, XLS and PDF, and the server-side reader rejects anything else), no currency
conversion or revaluation, no multi-entity reconciliation, no client-side deduplication, and no
change to general-ledger posting or to the legacy Desk reconciliation tool.

## Intentionally unchanged files

These are load-bearing and are deliberately left as they are. Read them for context; do not edit
them as a side effect of feature work:

`vite.config.ts` · `tsconfig.json` · `tsconfig.app.json` · `eslint.config.js` · `.gitignore` ·
`.env.production` · `index.html` · `src/index.css` · everything under `src/components/ui/` except
`markdown.tsx` · everything under `src/types/` · and the `"version": "0.0.0"` field in
`package.json` — a Vite-scaffold artefact, not a statement about how complete this application is.

Two files are frozen and are called out separately, because each one is somewhere a well-intentioned
improvement genuinely belongs and is still out of bounds *here*. Each carries a known limitation
documented under [Accepted limitations](#accepted-limitations) rather than fixed in place:

| Frozen file | Why it is tempting, and why it is frozen anyway |
| --- | --- |
| `src/lib/frappe.ts` | The shared error parser. It calls `JSON.parse` on `_server_messages` unguarded and keeps message-less entries, both of which matter. It is frozen as the error-transport contract, so the totality lives in `readServerMessages` / `readErrorText` at the boundary this work owns. `src/lib/frappe.test.ts` specifies its real behaviour, limits included. |
| `src/components/features/BankStatementImporter/import_utils.ts` | `GetStatementDetailsResponse` declares a top-level `currency` that `get_statement_details` never returns. Every screen therefore reads `data.doc.currency`, and the suite defends that with a runtime sentinel rather than with the compiler. |

Two files that earlier drafts of this document listed as frozen are **no longer** frozen, and both
changed for the same reason — the fix belonged where the defect was:

- **`src/components/ui/markdown.tsx`** is the single sink for every `rehypeRaw` render in the SPA.
  Sanitising at the ~23 individual `ErrorBanner` call sites instead would have been both larger and
  weaker, so the two-line plugin registration went here. It is the only design-system primitive
  touched, and its behaviour for legitimate markup is unchanged.
- **`src/pages/ViewBankStatementImportLog.tsx`** had its render guards in the order no-data → loading
  → error, and `useFrappeGetCall` reports no data on a *failed* read as well as a pending one, so a
  refused read produced a blank page with no message and no way back. Reordered to loading → error →
  no data; three lines.

The remainder of the frozen list is a **requirement of this change set, not a preference**: it freezes
the build and lint configuration, so a convenience edit to any of it puts a file in the diff that does
not belong there. Two of those files are the reason for caveats documented above:

| Frozen file | The caveat it produces |
| --- | --- |
| `.gitignore` | Does not list `coverage`, so a coverage run leaves an untracked directory — [delete it](#coverage-gate) instead of ignoring it. |
| `eslint.config.js` | Does not ignore `coverage` either, so `eslint .` after a coverage run reports [3 warnings from generated files](#coverage-gate). |

### What this work did change

**Thirty-four paths: twenty updated, fourteen created, none deleted.** `git diff --name-status
<baseline>` should show precisely this set and nothing else. Twenty-six are under this workspace; the
other eight are inside the four bank DocType directories the acceptance criterion permits.

The honest summary of size is this: **most edits are a handful of lines each, but three files are not
small.** Naming which is which matters more than a flattering adjective, so the tables below give the
scope of every one.

#### Frontend — configuration and documentation

| File | Op | Scope | The change |
| --- | --- | --- | --- |
| `package.json` | update | ~12 lines | Exactly three scripts (`test`, `test:coverage`, `typecheck`), seven exactly-pinned test dependencies, and the [`resolutions` override](#the-resolutions-override--do-not-remove-it). |
| `yarn.lock` | update | generated | Regenerated by the install that added those seven packages. Committed deliberately: `yarn install --frozen-lockfile` is the documented install command, and it cannot resolve new dependencies from a lockfile that predates them. |
| `tsconfig.node.json` | update | 1 line | `vitest.config.ts` added to `include`, so `tsc -b` type-checks the file that owns the coverage gate. |
| `proxyOptions.ts` | update | 2 lines | An `import type` for the Node HTTP request type, and the parameter annotation that removes the one implicit-`any` error in the package. |
| `README.md` | update | whole file | This document, replacing the stock Vite scaffold text. |

#### Frontend — application source

| File | Op | Scope | The change |
| --- | --- | --- | --- |
| `bankRecAtoms.ts` | update | +2 atoms | Two plain in-memory atoms appended to the sixteen already there: the error-dialog payload and the per-log failure markers. Neither is persisted — a stale error dialog or failure marker must not survive a reload — and the comment says so, because neighbouring atoms *are* persisted. No existing atom and no persisted key changes shape. |
| `utils.ts` | update | **substantial** | The largest client edit, and it is not a one-liner. `useReconcileTransaction` moved from `.then(ok).catch(bad)` to `.then(ok, bad)` so a client fault *after* a committed post can no longer be reported as a server refusal; a shared `revalidateTransactionReads()` serves both the refusal and the recovery path; `scopedStorageKey()` namespaces the four persisted keys per site and user; the reconcile single-flight guard now lives here rather than in the atom store; plus the total server-message readers (`readServerMessages` / `readErrorText`) and `useSelectedBankAccountCurrency()`. |
| `MatchAndReconcile.tsx` | update | 4 sites | The dialog mount, the currency advisory badge, the already-reconciled guard on the confirm control, and the shared in-flight guard on every candidate row. |
| `CSV/StatementDetails.tsx` | update | ~30 lines | The rejection callback now *takes* the error, records the per-file failure and opens the dialog; the imported range's caches are **evicted** before the hand-off to review; an unconfirmed response is reported as a warning rather than as a fabricated server error. It posts to **one** endpoint — the document-method bridge — and deliberately does not call the rule evaluator. |
| `pages/BankStatementImporter.tsx` | update | **substantial** | The single-flight upload chain restructured so the pre-log rejection handler is a *sibling* of the post-create step rather than downstream of it; server-owned log identity, with the uploaded private file deleted if the log insert is refused and the relink retried once then reported as an actionable warning; the third per-file badge state with `Completed` outranking a stale marker; the statement's own currency on the closing balance; and the dialog mount. |
| `pages/ViewBankStatementImportLog.tsx` | update | 3 lines | Render guards reordered to loading → error → no data. |
| `src/components/ui/markdown.tsx` | update | 2 lines | `rehypeSanitizeServerMarkup` registered after `rehypeRaw`, which puts every consumer of the shared renderer behind one allow-list. |
| `src/lib/sanitize-html.ts` | create | new | The sanitiser itself: a rehype plugin with a 35-element allow-list, 34 dropped subtrees, four global attributes (`align`, `dir`, `lang`, `title` — deliberately **not** `class`, `id` or `style`) plus per-element extras, a same-origin URL boundary, `rel` stamping, and unwrap-rather-than-delete for anything unrecognised. No new dependency. |
| `BankRecErrorDialog.tsx` | create | ~50 lines of code | The dismissible dialog, composed from the existing `AlertDialog` and `ErrorBanner`. The Frappe error is passed through **by identity** — no sanitising, no re-encoding, no field clearing — because sanitisation now happens at the shared sink. |
| `vitest.config.ts`, `src/test/setup.ts`, `src/test/factories.ts` | create | new | The runner configuration, the Desk-runtime harness (a pure side-effect module, zero exports) and the fixtures. |
| Nine `*.test.{ts,tsx}` files | create | new | The suites listed under [Testing](#suites) — 576 tests. |

#### Why the four controllers are in the diff

The plan this work implements classified the four bank DocType controllers as *reference-only*,
because its own gap analysis found nothing in them that needed changing. Review then found ten
defects there — non-atomic posting, an unlocked import claim, an empty import reported as success,
evaluation queued before its rows commit, a state-changing endpoint reachable by GET, authority
checked only after mutation, and three information-disclosure gaps. The acceptance criterion is
explicit that the diff may include **`erpnext/accounts/doctype/{bank_transaction,
bank_reconciliation_tool, bank_statement_import_log, bank_transaction_rule}/`, additions only**, so
these are in bounds; the reference-only classification described a conclusion, not a prohibition.

`bank_account/` is a **fifth** directory this SPA depends on and the criterion does **not** name, so
it stays untouched — which is why one half of one finding is [accepted rather than
fixed](#accepted-limitations).

#### Backend — the four controllers, hardened in place

Additions only. **Fifteen lines are replaced rather than added, and every one is the same statement
made stricter** — listed individually so it can be checked rather than taken on trust: the
`bank_transaction` import widened to also bring in `get_doctypes_for_bank_reconciliation`;
`account = get_value(…, "account")` → `account, company = get_value(…, ["account", "company"])`;
`frappe.get_doc("Bank Transaction", …)` → the same call with `for_update=True`; two bare
`@frappe.whitelist()` decorators → `methods=["GET"]` and `methods=["POST"]`;
`return subtract_allocations(gl_account, matching)` → the same with the result cap;
`if self.status == "Completed":` → a locked read of that same field; the rule-evaluation import and
call relocated below the save; and the two rule-evaluation signatures widened by one optional
parameter. Nothing is removed and no behaviour is dropped.

| File | The change |
| --- | --- |
| `bank_statement_import_log.py` | The import claims its own log row with `SELECT … FOR UPDATE` **before** testing the status, so a stale in-memory snapshot can no longer let two concurrent callers both insert and submit the same statement. An empty final transaction set is refused before any insert, any realtime event, the closing-balance write or the status change — leaving the log at `Not Started` so the file can be corrected and retried. Rule evaluation is queued **after** the save and **after commit**, scoped to the log's own bank account. |
| `bank_transaction_rule.py` | `run_rule_evaluation` now requires `Bank Transaction` **write** authority (it stamps fields through `frappe.get_all` and `frappe.db.set_value`, which ignore permissions, so read was never the right gate), authorises any bank account named as its scope, and deduplicates its job. A new module-level `enqueue_rule_evaluation` queues after commit and, by default, does **not** deduplicate — RQ skips a twin that is queued *or already started*, and a started pass cannot see rows committed after it began, so collapsing the importer's pass into one would silently discard its stamping. `_run_rule_evaluation` gained an optional bank-account filter. |
| `bank_reconciliation_tool.py` | `reconcile_vouchers` checks doctype-level write authority **before** the row is read, loads the transaction under a row lock, checks document-level authority, then validates every requested voucher — non-empty list, both identifiers present, a type inside the hook-derived allow-list, the document exists, the caller may **write** it, and it belongs to this transaction's company — and finally validates the currency, all before the first mutation. `get_linked_payments` is GET-only, proves read authority on both the transaction and its bank account, normalises `document_types` to a list (a bare string had turned every membership test into a *substring* test) and caps its response. `get_account_balance` derives the company from the authorised Bank Account instead of trusting the caller's. `get_older_unreconciled_transactions` gained both permission gates, closing an existence oracle. |
| `bank_transaction.py` | `unreconcile_transaction` is POST-only, matching the strictly smaller sibling beside it — it cancels vouchers, and Frappe applies no CSRF protection to GET. `before_update_after_submit` now runs `validate_currency()`, which `validate()` never reaches on a save to a submitted document. |

One consequence is worth recording because a test found it rather than a reviewer: `set_status()`
writes with `db_set`, an *immediate* write, and `reconcile_vouchers` calls it before `save()`. A
currency check living only in `before_update_after_submit` therefore fires after the new status is
already on disk — harmless in a request, which rolls back, but not the guarantee the requirement asks
for. Hence the second `validate_currency()` call, in `reconcile_vouchers`, before anything is written.

#### Backend — the four test modules, extended additively

**Twenty-three new tests, 47 → 70 passing, zero deletions.** Every rejection path and authority
boundary the hardening introduced is covered, and all of it stays clean against this repository's own
`semgrep/test-correctness.yml`: no `frappe.db.commit()`, no `frappe.db.truncate()`, no `tearDown`
override.

| File | Tests | What they cover |
| --- | --- | --- |
| `test_bank_transaction_rule.py` | 22 → 27 | Scoped evaluation leaves other accounts' rows untouched *and* unevaluated; Guest is refused and nothing is queued; a recorder pins the authority level as **write**, which a Guest-only test could not detect; after-commit, dedup and a scope-carrying job id; and the importer path proven non-deduplicating with distinct job ids. |
| `test_bank_statement_import_log.py` | 13 → 16 | An empty statement refused with `publish_realtime`, `enqueue`, the row count and the stored status all asserted untouched; the stale-snapshot claim the old guard would have failed; and an enqueue-time database read proving the log is already `Completed` with its rows written. |
| `test_bank_reconciliation_tool.py` | 4 → 17 | `for_update` on the first load; one ordered list proving authority precedes the read; four voucher-rejection cases; company mismatch; the hook-derived allow-list; the HTTP-method declarations; read-authority refusal; the result cap applied *before* the allocation subtraction; `normalize_document_types` including the substring case; server-derived company; and the older-count authority gate. |
| `test_bank_transaction.py` | 8 → 10 | The GET rejection driven through `frappe.handler.is_valid_http_method` with a faked request, so the **dispatcher's** guard is what proves it rather than a registry lookup; and the currency-mismatch refusal with its full post-conditions — status, unallocated and allocated amounts all unchanged. |
| `test_bank_transaction_rule.py` (earlier) | — | The two rule-based auto-match tests that closed the one mandated scenario with no coverage anywhere. They call the private synchronous evaluator, because the whitelisted entry point queues a job and would silently no-op. |

Committed multi-session concurrency is the one thing these suites cannot express, and it is
[recorded as such](#accepted-limitations) rather than approximated.

The same care as the frozen list applies to `vitest.config.ts`'s independence from `vite.config.ts`
and to the `resolutions` field: both look like tidy-up candidates and both are load-bearing, which is
why each has its own section above.

## Accepted limitations

**Read this before treating anything above as a complete guarantee.** Every server-side
authorisation and atomicity gap an earlier draft of this document recorded here has since been
**closed** — the row locks, the authority ordering, the voucher validation, the POST-only
declaration, the empty-import refusal, the reconcile-time currency check, the server-derived company
binding and the shared markup sanitiser are all described under
[What this work did change](#what-this-work-did-change), and each has a test named beside it.

What remains below is what this change set **may not** close, or can close only partially. Each entry
names the boundary that stops it, what the residue means in practice, and the exact change that would
finish it — so the team that owns that code can act rather than rediscover.

| # | Where | What remains, and why it is accepted here | What closing it requires |
| --- | --- | --- | --- |
| A1 | `.github/workflows/**` | **No workflow runs the frontend gate.** The Python suites, including all 23 tests added here, are already discovered on both database engines by the existing four-shard workflows, so the backend is covered. The frontend gate (`yarn typecheck && yarn lint && yarn test:coverage`) is not, and cannot be wired from here: the acceptance criterion confines the diff to this workspace and the four bank DocType directories, and the plan states in terms that no new CI workflow file is added. Adding one would place a diff outside every permitted path. | A job on the existing workflow, or a new one, running those three commands on Node ≥ 24 — a workflow-file change belonging to whoever owns those files. |
| A2 | Frontend test suite | **Every committed suite runs under jsdom**, which neither executes scripts nor loads subresources. The sanitiser is specified structurally and exhaustively — 41 unit tests over the hast tree, plus end-to-end assertions through the real `rehypeRaw` pipeline — and it *was* additionally verified in a real headless Chrome against twelve payloads (inline script, `img onerror`, off-origin `img`, `javascript:` href, off-origin anchor, `onclick`/`class`/`id`/`style`, `iframe`, `svg animate onbegin`, `form`/`input`/`button`, `style`), through both the shared `ErrorBanner` surface and `MarkdownRenderer` directly: nothing executed, no `on*` attribute survived anywhere in the document, the only surviving anchors were same-origin with `rel="noreferrer noopener"`, every payload's text was preserved character for character, and **zero** network requests left the origin. That was an ad-hoc probe, not a committed artefact — a browser suite and the CI job to run it are new files outside the plan's list, the same boundary as A1. | A committed browser-driven regression suite exercising every `ErrorBanner` and `MarkdownRenderer` consumer with active-content payloads, alongside the CI job in A1. |
| A3 | `yarn.lock` | **`yarn audit` still exits non-zero** — see [Dependencies](#dependencies) below. Every vulnerable version is byte-identical to the baseline, so nothing here introduced one, and nothing here upgrades one either: the plan freezes every existing runtime and development dependency at its current version, so an upgrade would be an out-of-scope change to files this work is not authorised to re-resolve. Recorded with fixed floors so it can be planned properly. | A dedicated dependency change set raising the five packages to the floors tabulated below, then re-running `yarn audit`. |
| A4 | `bankRecAtoms.ts` `selectedBankAccountAtom`, `bankRecActionLog` | **Persisted state is now namespaced but still holds full rows.** All four persisted keys carry a `::<site>::<user>` suffix, so a previous user's selection and action log are never read again; and a selection absent from a permission-filtered response is discarded. What is *not* changed is the storage shape — the full bank row, including `bank_account_no` and the GL identifiers, is still what gets written. Persisting an identifier only would mean refactoring every consumer of that atom across the SPA, and the plan freezes the sixteen existing atoms' shapes and persistence conventions. | Persist a namespaced **identifier only**, resolve the details from current permission-filtered data on read, and clear on logout, user change or a missing row. |
| A5 | `bank_reconciliation_tool.py` `reconcile_vouchers` | **`is_new_voucher` is still caller-supplied.** It records whether a voucher was created by the reconciliation flow (`Voucher Created`) or merely matched (`Matched`), and `unreconcile_transaction` cancels the former — so a mislabelled flag decides a later cancellation. It cannot be derived server-side without removing the parameter's effect from the whitelisted RPC surface, which callers that create a voucher and then reconcile it depend on (the module's own creation endpoints do exactly that), and that surface is frozen as an immutable contract. What *is* now guaranteed is that a mislabelled voucher is still one that exists, is of a reconcilable type, is in this transaction's company, and is one the caller may write. | Derive the reconciliation type from a server-owned creation flow, as part of a deliberate contract revision of that endpoint. |
| A6 | `bank_account.py` | **One half of one hardening is not applied.** The balance and older-count paths in `bank_reconciliation_tool.py` now derive their scope server-side and check account authority explicitly; the closing-balance helper in `bank_account.py` does not. `bank_account/` is a fifth directory this SPA depends on and the acceptance criterion does not name, so it is reference-only here. | The same explicit named-account read check and permission-aware query, applied in that file. |
| A7 | Backend test suite | **Committed multi-session concurrency is untested — and currently inexpressible.** Observing one session's uncommitted transaction from another requires `frappe.db.commit()`, which this repository's own `semgrep/test-correctness.yml` bans in tests at ERROR severity. The row locks and the claim guard are instead tested at the mechanism — that the load carries `for_update`, and that the claim reads the database rather than a stale snapshot, which is exactly the state a second concurrent caller holds. | Integration tests outside the unit harness, or a harness change agreed with whoever owns those rules. |
| A8 | `src/lib/frappe.ts` | The shared error parser calls `JSON.parse` on `_server_messages` unguarded and keeps message-less entries. It is frozen as the error-transport contract, so every failure path this work owns reads through the total `readServerMessages` / `readErrorText` instead. Unreachable through the real transport — `_server_messages` only exists once the body has already parsed as JSON — and `src/lib/frappe.test.ts` specifies the real behaviour, limits included. | Guard the parse in the shared module, as an error-transport change. |

### Dependencies

`yarn audit` currently exits **12** (17 high, 1 moderate paths across 582 dependencies). **Every
vulnerable version below is byte-identical at the baseline this change set started from** — verified
by comparing the committed `yarn.lock` — so none was introduced by the seven test packages added
here, and none is upgraded here either: the change set freezes every existing runtime and development
dependency at its current version. Deliberately recorded rather than silently upgraded, with the
fixed floors, so the upgrade can be planned as its own change:

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

Both are frozen files here (`vite.config.ts`, and `proxyOptions.ts` beyond its one type annotation),
so this is guidance rather than a configuration change.
