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
- [Scope boundaries](#scope-boundaries)
- [Intentionally unchanged files](#intentionally-unchanged-files)
- [Residual risks and known gaps](#residual-risks-and-known-gaps)

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
| `typecheck` | `tsc -b && yarn typecheck:vitest-config` | The whole type gate. It exists because **`build` never invokes the compiler**, so without this script a type error would not be observable from this package's scripts at all. The second command is what makes the gate complete — see the row below and [TypeScript project layout](#typescript-project-layout). |
| `typecheck:vitest-config` | `tsc --noEmit … vitest.config.ts` | Type-checks `vitest.config.ts`, which belongs to **neither** `tsconfig.*.json` program. Invoked by `typecheck`; you should not need to run it directly. |

Those nine are the whole script set — there is deliberately no aggregate `verify` or `ci` script.
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
| `test.testTimeout` | `30000` — the component suites drive their scenarios through `user-event`, which advances real timers between steps, and the V8 coverage provider adds per-call overhead on top |
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
| `src/lib/company.test.ts` | The `locals[':Company']` readers |
| `src/lib/currency.test.ts` | The currency readers and formatters |

## Coverage gate

`yarn test:coverage` uses the **V8** provider and **exits non-zero** when coverage falls short,
so it is a gate rather than a report. The threshold is **80% lines**, enforced in two layers:

- a **global** `lines: 80`, checked against the aggregate of everything measured; and
- a **per-file** `lines: 80` for each measured unit, so a weak new module cannot be carried over
  the line by easier files around it.

**Measured scope equals gated scope, and that equality is enforced mechanically.** Both
`coverage.include` and every per-file threshold key are generated from a single `COVERED_UNITS`
array at the top of `vitest.config.ts`, so the two cannot drift:

```ts
include: [...COVERED_UNITS],
thresholds: {
  lines: LINE_COVERAGE_THRESHOLD,
  ...Object.fromEntries(COVERED_UNITS.map((unit) => [unit, { lines: LINE_COVERAGE_THRESHOLD }]))
}
```

This matters more than it looks. A threshold naming a file that `include` omits does **not** fail:
Vitest builds an empty coverage map for it, `resolveThresholds()` skips it as "not included by glob
patterns", and the gate passes on a file nothing measured. Generating both from one array is what
makes that impossible. Whatever the `All files` row of the text reporter prints is therefore exactly
what is enforced.

**`COVERED_UNITS` is a superset of the files this work changed, and that is checkable rather than
asserted.** `git diff --name-only <baseline> -- 'src/**'`, with the suites and the harness removed,
yields exactly the six source files listed first below. The three `src/lib` entries are *unchanged*
and measured anyway, because every message, company and currency the failure paths resolve goes
through them, so a regression in one of them is a regression in FM1, FM2 or FM5 whether or not the
file appears in a diff.

`src/components/ui/markdown.tsx` is deliberately **not** measured, and the reason is a scope fact:
it is byte-identical to the baseline. It is one of the design-system primitives this change set may
not touch, so it is not a boundary this work changed. The untrusted-markup sink this work *did*
introduce is the error dialog, which sanitises at its own boundary and is gated below like
everything else — see [Residual risks](#residual-risks-and-known-gaps) for what that does and does
not cover.

The nine gated units, and their measured line coverage:

| Unit | Changed here? | Lines |
| --- | --- | --- |
| `src/components/features/BankReconciliation/utils.ts` | yes | 98.97% |
| `src/components/features/BankReconciliation/bankRecAtoms.ts` | yes | 95.45% |
| `src/components/features/BankReconciliation/BankRecErrorDialog.tsx` | yes (new) | 100% |
| `src/components/features/BankReconciliation/MatchAndReconcile.tsx` | yes | 98.01% |
| `src/components/features/BankStatementImporter/CSV/StatementDetails.tsx` | yes | 100% |
| `src/pages/BankStatementImporter.tsx` | yes | 98.86% |
| `src/lib/frappe.ts` | no | 100% |
| `src/lib/company.ts` | no | 100% |
| `src/lib/currency.ts` | no | 100% |
| **Aggregate** | — | **98.91%** |

`coverage.exclude` is retained as a guard so that broadening `include` back to a directory glob can
never silently re-admit generated DocType declarations (`src/types/**`), the harness itself
(`src/test/**`), declaration files, or the browser entry point.

> **Adding a component or API-client module to this work means adding it to `COVERED_UNITS`** — one
> array, both purposes. Maintaining `include` and `thresholds` as two hand-written lists is the
> failure mode described above.

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

Three configuration files, all of them intentionally unchanged:

| File | Role |
| --- | --- |
| `tsconfig.json` | Solution file: `files: []`, references `./tsconfig.app.json` and `./tsconfig.node.json`, and declares `baseUrl: "."` with `paths { "@/*": ["./src/*"] }` |
| `tsconfig.app.json` | The application program: `include: ["src"]`, `target` `ES2020`, `lib` `["ES2020", "DOM", "DOM.Iterable"]`, `moduleResolution` `bundler`, `jsx` `react-jsx`, and `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports` all enabled. It declares **no `types` array.** |
| `tsconfig.node.json` | The tooling program: `include: ["vite.config.ts"]`, `types: ["node"]`, `target`/`lib` `ES2023`, with `verbatimModuleSyntax` and `erasableSyntaxOnly` enabled — which is why `proxyOptions.ts` imports its Node HTTP request type with `import type` |

`tsc -b` builds both programs, so the whole of `src/` — application code and colocated suites
alike — plus `vite.config.ts` and the `proxyOptions.ts` it imports are type-checked.

**`vitest.config.ts` is not part of either program, and is type-checked separately.** The tooling
program's `include` names `vite.config.ts` only, and all three `tsconfig.*.json` files are frozen in
this change set, so `tsc -b` alone never reads the runner's own configuration — a type error in the
file that owns the coverage gate would compile clean and be discovered only when `yarn test` next
failed at config load. `yarn typecheck` therefore runs a second, file-scoped compilation after
`tsc -b`:

```bash
tsc --noEmit --strict --target ES2023 --lib ES2023 --module ESNext --moduleResolution bundler \
    --types node --skipLibCheck --verbatimModuleSyntax --moduleDetection force \
    --noUnusedLocals --noUnusedParameters --erasableSyntaxOnly \
    --noFallthroughCasesInSwitch --noUncheckedSideEffectImports vitest.config.ts
```

Passing a file on the command line makes `tsc` ignore every `tsconfig.json`, so each option has to
be named explicitly. **Those flags are a copy of `tsconfig.node.json`'s `compilerOptions`** — the
runner config is tooling code that runs under Node, so it is checked under exactly the settings the
other tooling file is checked under. Keep the two in step: if `tsconfig.node.json` ever changes, the
honest fix is to move `vitest.config.ts` into its `include` and delete this script.

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
| `src/test/` | The Vitest harness: `setup.ts` and `factories.ts` |
| `src/index.css` | The Espresso theme tokens |

## Conventions

- **State is jotai, and only jotai.** There is no Redux store, no bespoke context and no service
  container. Persistence is deliberate: `atomWithStorage` over `localStorage` for the selected
  bank account, the date range and the match filters; `createJSONStorage` over `sessionStorage`
  for the session action log; plain in-memory atoms for anything that must **not** survive a
  reload — the error-dialog payload and the per-file import-failure map, which are the only two
  atoms this work added. A stale error dialog, or a stale failure marker, must not outlive the
  session that observed it.
- **Data fetching is `frappe-react-sdk` hooks with explicit SWR cache keys.** Backend calls for
  the reconciliation feature are centralised as typed hooks in
  `src/components/features/BankReconciliation/utils.ts`; new calls extend that module and reuse
  its existing key families rather than introducing new ones.
- **The server is the sole source of truth for financial state.** Confirming and posting a
  reconciliation is one server-side operation, and its response decides the outcome. No client
  state is mutated optimistically, and the client never deduplicates or synthesises
  transactions.
- **Errors are parsed and rendered through shared code.** `src/lib/frappe.ts` reads Frappe's
  `_server_messages` envelope with an `_error_message` fallback; `src/components/ui/error-banner.tsx`
  renders the result, choosing its own severity from the server's. New error surfaces compose
  those two rather than paraphrasing server text.
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
- **Server markup is sanitised before it is rendered — at this dialog only.** `_server_messages` is
  HTML and the shared renderer runs `rehypeRaw` with no sanitiser after it, so the dialog filters
  every message body through an element/attribute allow-list with a same-origin URL boundary, parsed
  inside a detached `<template>` whose contents HTML specifies as inert (scripts do not run, images
  do not load). Text is preserved character for character; only markup is removed. The ~20
  pre-existing *inline* `ErrorBanner` call sites elsewhere in the SPA keep the shared renderer's
  baseline behaviour — see [Residual risks](#residual-risks-and-known-gaps).

| # | Situation | Behaviour |
| --- | --- | --- |
| **FM1** | The confirm/post request fails — refused by the server, or no response at all | The dialog shows the server's own message, passed through **unmodified**: the client paraphrases nothing and adds no wording of its own, and the parse cannot throw (see the note under the table). Confirm/post is **one** server-side call and **nothing is mutated optimistically**, so *this client* contributes no partial state: the transaction stays unreconciled with its state unchanged. The rejection handler then does two things and only two: it **clears the transaction selection**, which withdraws the Reconcile affordance outright (see FM3), and it revalidates the two transaction-list cache keys so the next render is built from the server's current figures. **What this does not claim:** that a partial or duplicate posting is impossible *in general*. Within one browser a second post is refused by a shared single-flight guard, and the server's own state check refuses an already-reconciled transaction — but that check is not atomic across concurrent sessions, which is a server-side gap recorded under [Residual risks](#residual-risks-and-known-gaps). |
| **FM2** | A malformed or empty statement file | The server refuses the import synchronously and rolls it back; the refusal reaches the reviewer twice over. It opens the shared dialog in the server's own words, and it marks that **one file** on the importer list: a red **Failed** chip in place of the stored status, carrying the server's message as its tooltip and on its accessible name, and reachable by keyboard as well as pointer. No transaction is ever created client-side. The chip is driven from the observed rejection rather than from the document because `Bank Statement Import Log` has exactly two status values — `Not Started` and `Completed` — and **no error field**: a rolled-back import leaves the row saying `Not Started`, indistinguishable from one merely waiting to be imported, so the failure has nowhere else to live. The marker is held in memory, keyed by import-log name, and is deliberately **not** persisted. |
| **FM3** | The transaction has already been reconciled | Confirm is **disabled**, on the backend's own predicate — `status === 'Reconciled'` or `unallocated_amount <= 0`, which the server derives from one another — and a tooltip on a focusable wrapper says why. This is an affordance, not the control: the authoritative guard is the first statement of the first method `reconcile_vouchers` invokes, and this SPA never decides a financial outcome for itself. A stale client that gets through is refused by the server, and the refusal is handled **fail-closed**: the selection is cleared *unconditionally*, so the Reconcile control is withdrawn rather than merely greyed, and it cannot come back on its own — not on a timer, and not because a revalidation request also failed. The affordance returns only when the reviewer selects a transaction again, against list data re-read from the server. |
| **FM4** | A re-import produces duplicate transactions | Rendered exactly as the backend produces them. **There is no client-side deduplication, and none may be added.** |
| **FM5** | The transaction's currency differs from the bank account's | A **non-blocking** amber advisory badge beside the rule badge, with its explanation in a tooltip and in an `sr-only` description sharing the same string. It does **not** disable confirm. The account currency it compares against is read from the **current** `bank_account.get_list` response — through `useSelectedBankAccountCurrency()`, which reads the account list already in the SWR cache and therefore issues no extra request — and *not* from the `selectedBankAccountAtom` snapshot in `localStorage`, which is written once when an account is picked and is never refreshed while that account stays selected. Both sides resolve the value by the same lookup (`Bank Account.account` → `Account.account_currency`). Where no account currency is known yet, there is nothing to compare and no badge is shown. **What this does not claim:** that the backend enforces the mismatch on this path. `Bank Transaction.validate_currency()` is invoked from `validate()`, and `reconcile_vouchers` saves an already-submitted document, which Frappe routes through `update_after_submit` — so `validate()` never runs and **no server-side currency check happens during a reconcile**. The advisory is therefore a client-side observation only, and the copy says exactly that rather than promising a check that does not occur. Recorded under [Residual risks](#residual-risks-and-known-gaps). |

## Scope boundaries

What this package does **not** do, stated so a reader does not go looking:

| Boundary | Status |
| --- | --- |
| Backend endpoints | **None added.** Every call the workflow makes already existed and was already whitelisted. Their own authorisation and atomicity gaps are recorded under [Residual risks](#residual-risks-and-known-gaps) rather than fixed here. |
| DocType schema | **No** field, status option, JSON edit, migration or patch entry. |
| REST/RPC contract | Unchanged, including the call style: module functions by dotted path, the one document method through the generic `run_doc_method` bridge. |
| Routes and providers | Unchanged. The dialog is mounted inside existing trees; no route or provider was added. |
| Design system | **No** new token and **no** new primitive. New affordances compose the primitives in `src/components/ui/`. |
| CI workflows | Unchanged. The Python suites are already discovered on both database engines; the frontend gate (`yarn typecheck && yarn lint && yarn test:coverage`) is **not** yet wired into a workflow — doing so is a workflow-file change and belongs to whoever owns those files. Recorded as R13 under [Residual risks](#residual-risks-and-known-gaps). |
| `frappe/` submodule | Untouched, pointer and contents. `frappe/cypress/` is referenced for **conventions only**; no Cypress spec is added here. |
| Backend diff | **One file**: two test methods appended to `erpnext/accounts/doctype/bank_transaction_rule/test_bank_transaction_rule.py`, covering rule-based auto-match, which had no coverage anywhere. Additive only — none of the 20 existing tests is touched, and no backend source file changes. |

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

Four more files are frozen and are called out separately, because each one is somewhere a
well-intentioned improvement genuinely belongs and is still out of bounds *here*. Each carries a
known limitation that is documented under [Residual risks](#residual-risks-and-known-gaps) rather
than fixed in place:

| Frozen file | Why it is tempting, and why it is frozen anyway |
| --- | --- |
| `src/lib/frappe.ts` | The shared error parser. It calls `JSON.parse` on `_server_messages` unguarded and keeps message-less entries, both of which matter. It is frozen as the error-transport contract, so the totality lives in `readServerMessages` / `readErrorText` at the boundary this work owns. `src/lib/frappe.test.ts` specifies its real behaviour, limits included. |
| `src/components/ui/markdown.tsx` | The shared Markdown renderer, which runs `rehypeRaw` with **no** sanitiser after it. One shared sanitiser here would protect every consumer and would be the better design — but it is a design-system primitive, frozen. The new error dialog sanitises at its own boundary instead. |
| `src/components/features/BankStatementImporter/import_utils.ts` | `GetStatementDetailsResponse` declares a top-level `currency` that `get_statement_details` never returns. Every screen therefore reads `data.doc.currency`, and the suite defends that with a runtime sentinel rather than with the compiler. |
| `src/pages/ViewBankStatementImportLog.tsx` | Its render guards run no-data before error, and `useFrappeGetCall` reports no data on a *failed* read too — so a refused read shows a blank page. Out of scope here; recorded below. |

That list is a **requirement of this change set, not a preference**: the plan this work implements
freezes the build, TypeScript and lint configuration, so a convenience edit to any of them puts a
file in the diff that does not belong there. Two of them are the reason for caveats documented
above rather than fixed in place:

| Frozen file | The caveat it produces |
| --- | --- |
| `.gitignore` | Does not list `coverage`, so a coverage run leaves an untracked directory — [delete it](#coverage-gate) instead of ignoring it. |
| `eslint.config.js` | Does not ignore `coverage` either, so `eslint .` after a coverage run reports [3 warnings from generated files](#coverage-gate). |
| `tsconfig.node.json` | Includes `vite.config.ts` only, so `tsc -b` does not see `vitest.config.ts`. The gate is completed by the [separate file-scoped compilation](#typescript-project-layout) `yarn typecheck` runs afterwards, rather than by editing this file. |

### What this work did change

**Twenty-two paths**, and the count is exact because it is the acceptance criterion: nine files
updated, twelve created, none deleted — plus `yarn.lock`, which the mandated dependency additions
necessarily regenerate. Twenty-one of the twenty-two are under this workspace; the twenty-second is
an additive backend test module. `git diff --name-status <baseline>` should show precisely this set
and nothing else.

Six of the twenty-two are application source, and each edit is small and carries a comment at its
site explaining itself:

| File | Op | The change |
| --- | --- | --- |
| `package.json` | update | Four scripts (`test`, `test:coverage`, `typecheck`, `typecheck:vitest-config`), seven exactly-pinned test dependencies, and the [`resolutions` override](#the-resolutions-override--do-not-remove-it). |
| `yarn.lock` | update | Regenerated by the install that added those seven packages. It is committed deliberately: `yarn install --frozen-lockfile` is the documented install command, and it cannot resolve the new dependencies from a lockfile that predates them. |
| `proxyOptions.ts` | update | Two lines: an `import type` for the Node HTTP request type, and the parameter annotation that removes the one implicit-`any` error in the package. |
| `README.md` | update | This file, replacing the stock Vite scaffold text. |
| `bankRecAtoms.ts` | update | Five plain in-memory constructs appended to the sixteen atoms already there — the dialog payload, the per-log failure markers, the pre-log failure map and its key function, and the reconcile single-flight guard — each traced in the file to the requirement that forces it. No existing atom and no persisted key is touched. |
| `utils.ts` | update | The total server-message readers (`readServerMessages` / `readErrorText`), the reconcile rejection handler (dialog + fail-closed selection clear + revalidation), the single-flight guard, the authoritative-currency rehydration with its fail-closed clear when the selected account is absent from a permission-filtered response, and `useSelectedBankAccountCurrency()`. |
| `MatchAndReconcile.tsx` | update | Four sites: the dialog mount, the currency advisory, the already-reconciled guard on the confirm control, and the shared in-flight guard on every candidate row. |
| `CSV/StatementDetails.tsx` | update | The import outcome now requires a `Completed` doc from the server; the rejection callback *takes* the error, records the per-file failure and opens the dialog; the imported range's caches are evicted before the hand-off to review; progress renders as a percentage. It posts to **one** endpoint — the document-method bridge — and deliberately does **not** call the rule evaluator (see [Residual risks](#residual-risks-and-known-gaps)). |
| `pages/BankStatementImporter.tsx` | update | The single-flight upload chain; server-owned log identity, with the uploaded private file deleted if the log insert is refused and the relink retried once then reported as an actionable warning; pre-log failure rows; the third per-file badge state with `Completed` outranking a stale marker; the statement's own currency on the closing balance; and the dialog mount. |
| `BankRecErrorDialog.tsx` | create | The dismissible dialog, composed from the existing `AlertDialog` and `ErrorBanner`, with server markup reduced to an element/attribute allow-list — parsed inside a detached, spec-inert `<template>` — before it is rendered. |
| `vitest.config.ts`, `src/test/setup.ts`, `src/test/factories.ts` | create | The runner configuration, the Desk-runtime harness and the fixtures. |
| Eight `*.test.{ts,tsx}` files | create | The suites listed under [Testing](#suites). |
| `bank_transaction_rule/test_bank_transaction_rule.py` | update | Two appended test methods covering rule-based auto-match. Additive only — none of the twenty existing tests is touched. |

The same care as the frozen list applies to `vitest.config.ts`'s independence from
`vite.config.ts` and to the `resolutions` field: both look like tidy-up candidates and both are
load-bearing, which is why each has its own section above.

## Residual risks and known gaps

**Read this before treating anything above as a security guarantee.** Everything here was
identified during review of this change set and is *not* fixed by it, because the fix falls outside
the paths this change set may touch (see [Scope boundaries](#scope-boundaries) and
[Intentionally unchanged files](#intentionally-unchanged-files)). Each entry names where the problem
lives, what it means in practice, and what closing it requires — so the team that owns that code can
act on it rather than rediscover it.

Nothing below is mitigated by a client-side control. The client-side controls this package *does*
add — the already-reconciled guard, the shared single-flight guard, the fail-closed selection clear,
the private upload, the redacted diagnostics, the sanitising error dialog — are defence in depth.
**They are not authorisation, and they are not atomicity.**

### Server-side: authorisation and atomicity

These live in banking controllers this change set treats as reference-only. The SPA calls them, so
they bound what the workflow can honestly promise.

| # | Where | What it means in practice | What closing it requires |
| --- | --- | --- | --- |
| R1 | `bank_reconciliation_tool.py` `reconcile_vouchers` → `bank_transaction.py` `add_payment_entries` | The already-reconciled state check and the allocation/clearance/save are **not atomic**. Two authorised concurrent requests can both read the same stale `unallocated_amount`, both clear vouchers, and last-write-win the parent and its child rows. This is why FM1 above does not claim that a partial or duplicate posting is impossible in general. | Lock and reload the Bank Transaction, or use an atomic conditional state transition around the guard, the allocation, the clearance and the save. |
| R2 | `bank_statement_import_log.py` `insert_transactions` | The `status == "Completed"` check has no row lock or claim state, so two concurrent calls for the same log can both parse and both insert — duplicating submitted Bank Transactions. | Atomically claim an in-progress state, or row-lock the log, before parsing and inserting. |
| R3 | `bank_reconciliation_tool.py` `get_linked_payments` | No explicit read-permission check on the named transaction, no Bank Account resource validation, no permission-aware voucher predicates, no result bound, and no HTTP-method restriction — so a predictable transaction name can enumerate candidate vouchers and run an expensive query. | Explicit document checks, server-derived scope, permission-aware queries, an allowed-type list, date and result bounds, and a GET-only declaration. |
| R4 | `bank_transaction_rule.py` `run_rule_evaluation` | Authorises an **unscoped background write across every company and every bank account** on `Bank Transaction` *read* permission alone. This is why the statement-import step deliberately does not call it, and why its test suite asserts that it never does: rule evaluation of imported rows is left server-owned inside `insert_transactions`. | Require manager/write authority and an authorised company/account scope, or evaluate only server-owned imported rows. Deduplicate and rate-limit the jobs. |
| R5 | `bank_transaction.py` `unreconcile_transaction` | State-changing but reachable by **GET**, which Frappe does not CSRF-check — so an authorised victim can be induced to clear allocations and cancel vouchers. | Restrict to POST and add GET/CSRF rejection tests. |
| R6 | `bank_statement_import_log.py` | A statement yielding **zero** valid transactions still reports progress 100, triggers rule evaluation and saves `Completed`. The UI refuses to submit an empty import, but a direct document-method call is not the UI. | Reject an empty final transaction set on the server, before any side effect or status change. |
| R7 | `bank_transaction.py` `validate_currency` / `before_update_after_submit` | `validate_currency()` is invoked from `validate()`, which `update_after_submit` does not run — so **no currency check happens during a reconcile**. This is exactly why the FM5 advisory is described above as a client-side observation and nothing more. | Validate currency explicitly on the reconcile/update-after-submit path, inside the same transaction lock as R1. |
| R8 | `bank_reconciliation_tool.py` balance and count endpoints; `bank_account.py` | The client-supplied company is not bound to the Bank Account; the closing-balance read lacks an explicit named-account check; and the older-transaction count bypasses permissions, which can make it an existence oracle through differing responses. | Derive company server-side, check account read permission explicitly, use one permission-aware query, and answer an empty result without a differential exception. |
| R9 | `bank_reconciliation_tool.py` `reconcile_vouchers`; `bank_transaction.py` voucher clearance | Transaction write permission is not checked until the final save; voucher clearance is written through permission-bypassing DB writes; and a client-supplied `is_new_voucher` flag governs later cancellation provenance. | Check transaction write authority before any read or mutation, validate voucher scope and permission, and derive the reconciliation type from the server-owned creation flow. |

### Client-side gaps this change set does not close

| # | Where | What it means in practice | What closing it requires |
| --- | --- | --- | --- |
| R10 | `src/components/ui/markdown.tsx`, consumed by `src/components/ui/error-banner.tsx` | The shared renderer runs `rehypeRaw` with **no sanitiser**, so every *inline* `ErrorBanner` call site in the SPA (roughly twenty of them) renders server-supplied HTML as live DOM. The dismissible error dialog this change set adds is sanitised; those pre-existing inline sites are not. | One shared AST sanitiser after `rehypeRaw` in the primitive, with a restrictive schema, tested across every `ErrorBanner`/`Markdown` consumer. That is a design-system change, which this change set may not make. |
| R11 | `bankRecAtoms.ts` `selectedBankAccountAtom` and `bankRecActionLog` | The full selected bank row — including `bank_account_no`, the company and GL identifiers — is persisted in **user-agnostic** `localStorage`, and the action log persists transaction/voucher metadata in user-agnostic `sessionStorage`. On a shared browser, a previous user's financial metadata survives until something overwrites it. This change set narrows the window (a selection absent from a permission-filtered response is now discarded) but does not change the storage shape, because the existing persistence conventions are frozen. | Persist a site + user + company namespaced **identifier only**, resolve the details from current permission-filtered data, and clear on logout, user change or a missing row. Namespace or clear the action log the same way. |
| R12 | `src/pages/ViewBankStatementImportLog.tsx` | Its guards test no-data before error, and `useFrappeGetCall` reports no data on a failed read as well as a pending one — so a refused `get_statement_details` renders a blank page with no message and no way back. | Reorder to loading → error → no data. Three lines, in a file this change set may not touch. |
| R13 | Frontend test suite | Every suite runs under **jsdom**, which does not execute scripts and does not load subresources. Structural sanitisation, fail-closed behaviour and the allow-list are all specified well, but no committed suite proves real-browser script or network behaviour, and the frontend gate is not wired into CI. | A browser-driven regression suite and a CI job running `yarn typecheck && yarn lint && yarn test:coverage`. Both are file additions outside this change set's permitted paths — the frontend gate in particular is a workflow-file change belonging to whoever owns those files. |
| R14 | Backend test suite | Nothing exercises concurrent posts, cross-session races, or the authorisation boundaries in R3–R5. Note that such a test is not merely absent but currently *inexpressible*: observing one session's uncommitted transaction from another requires `frappe.db.commit()`, which this repository's own `semgrep/test-correctness.yml` bans in tests at ERROR severity. | Integration tests outside the unit harness, or a harness change agreed with whoever owns those rules. |

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

