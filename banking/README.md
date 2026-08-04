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
> roughly 1 MB of hand-written TypeScript/TSX, including a complete five-tab reconciliation
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
yarn dev                         # requires ../../../sites/common_site_config.json
yarn build                       # requires ../../../sites/common_site_config.json
```

## Scripts

| Script | Command | Notes |
| --- | --- | --- |
| `dev` | `vite` | Dev server on host `0.0.0.0`, port `8080`, proxying `^/(app\|api\|assets\|files\|private)` to the local Frappe webserver. **Requires the bench config file** — see [below](#the-bench-config-prerequisite--and-why-test-does-not-share-it). |
| `build` | `vite build --base=/assets/erpnext/banking/ && yarn copy-html-entry` | **Does not type-check** — run `typecheck` for that. **Requires the bench config file.** |
| `lint` | `eslint .` | Flat config; lints every `**/*.{ts,tsx}`; ignores `dist` and `coverage`. |
| `preview` | `vite preview` | Serves a previously produced build. **Requires the bench config file** (it loads `vite.config.ts` too) **and a prior `build`** — without one it starts and answers 404. |
| `copy-html-entry` | `cp ../erpnext/public/banking/index.html ../erpnext/www/banking.html` | Internal helper, invoked by `build`. |
| `test` | `vitest run` | **Non-watch by construction** — a bare `vitest` enters watch mode, which is unusable in CI or any non-interactive context. **Does not require the bench config file.** |
| `test:coverage` | `vitest run --coverage` | V8 provider; emits `text` + `json-summary` + `lcov`; **fails the process** below the configured line thresholds. |
| `typecheck` | `tsc -b` | Builds the TypeScript solution. It exists because **`build` never invokes the compiler**, so without this script a type error would not be observable from this package's scripts at all. |
| `verify` | `yarn typecheck && yarn lint && yarn test:coverage` | The acceptance gate, in one non-watch, bench-independent command. Run this before proposing a change. |
| `ci` | `yarn verify && yarn build` | `verify` plus the production bundle. **Requires the bench config file**, because of the `build` step. |

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
| `src/components/features/BankStatementImporter/CSV/StatementDetails.test.tsx` | The import step, including backend-error surfacing and the realtime progress listener |
| `src/pages/BankStatementImporter.test.tsx` | The importer surface and its per-file status badge |
| `src/lib/frappe.test.ts` | Frappe error parsing, including the nested JSON-string case and the fallback path |
| `src/lib/company.test.ts` | The `locals[':Company']` readers |
| `src/lib/currency.test.ts` | The currency readers and formatters |

## Coverage gate

`yarn test:coverage` uses the **V8** provider and **exits non-zero** when coverage falls short,
so it is a gate rather than a report. The threshold is **80% lines**, enforced in two layers:

- a **global** `lines: 80`, checked against the aggregate of everything measured; and
- a **per-file** `lines: 80` for each measured unit, so a weak new module cannot be carried over
  the line by easier files around it.

Measured scope equals gated scope: `coverage.include` is an explicit list of the reconciliation
and importer units and the three shared helpers they resolve errors, companies and currencies
through, and the per-file thresholds name exactly the same files. Whatever the `All files` row
of the text reporter prints is therefore exactly what is enforced. `coverage.exclude` is
retained as a guard so that broadening `include` back to a directory glob can never silently
re-admit generated DocType declarations (`src/types/**`), the harness itself (`src/test/**`),
declaration files, or the browser entry point.

> **Adding a component or API-client module to this work means adding it to `coverage.include`
> *and* to `coverage.thresholds`.** Adding it to only one of the two makes the headline
> percentage and the gate disagree.

Three reporters run:

| Reporter | Output | Use |
| --- | --- | --- |
| `text` | console | The summary table, with uncovered line numbers per file |
| `json-summary` | `coverage/coverage-summary.json` | Machine-readable totals |
| `lcov` | `coverage/lcov.info` plus an HTML report under `coverage/lcov-report/` | `lcov.info` is the standard interchange format, and the repository already carries a Codecov configuration at `erpnext/codecov.yml`, so no extra reporting plumbing is needed here. For line-by-line annotation, open `coverage/lcov-report/index.html` in a browser. |

`coverage/` is generated output, never authored: it is listed in this package's `.gitignore` and
in the ESLint flat config's `globalIgnores`, so a coverage run leaves `git status` clean and does
not change the result of `eslint .`. Both entries are deliberate — the HTML report ships its own
pre-disabled helper scripts, which ESLint would otherwise try to lint.

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
| `tsconfig.node.json` | The tooling program: `include: ["vite.config.ts", "vitest.config.ts"]`, `types: ["node"]`, `target`/`lib` `ES2023`, with `verbatimModuleSyntax` and `erasableSyntaxOnly` enabled — which is why `proxyOptions.ts` imports its Node HTTP request type with `import type` |

`yarn typecheck` (`tsc -b`) builds both programs, so both the application **and** the two config
files are type-checked.

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

`eslint.config.js` is a flat config: `globalIgnores(["dist", "coverage"])`, then a single block
over `files: ["**/*.{ts,tsx}"]` extending the recommended JavaScript, recommended
`typescript-eslint` and React-Refresh Vite configurations, with the `react-hooks` plugin
(`rules-of-hooks` as an error, `exhaustive-deps` as a warning) and
`react-refresh/only-export-components` switched off.

`languageOptions.globals` is **browser only** — no Node or Vitest globals — which independently
reinforces point 2 above: a test that leans on an implicit `describe` fails lint as well as
type-checking.

This file is intentionally unchanged, and the stock scaffold's advice about expanding the ESLint
configuration has been deliberately removed rather than carried over.

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
  reload, such as the error-dialog payload and the import-attempt markers.
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

| # | Situation | Behaviour |
| --- | --- | --- |
| **FM1** | The confirm/post request fails — refused by the server, or no response at all | The dialog shows the server's own message. Confirm/post is **one** server-side call and **nothing is mutated optimistically**, so the transaction stays unreconciled with its state unchanged and no partial or duplicate posting is possible. A rejection carrying no envelope is reported as *indeterminate* — never as "nothing was posted" — and the reviewer is sent to check the record rather than invited to retry blindly. The two transaction-list cache keys are then re-read from the server, so the affordance re-evaluates against the server's current figures. |
| **FM2** | A malformed or empty statement file | The importer list carries a **per-file** indicator, and no transaction is ever created client-side. Three distinct states: **Failed** (the server refused the import, or refused to produce the statement's details), **No Transactions** (the server parsed the file and recognised nothing importable in it — its own words, and the reason the log sits at `Not Started` forever), and **Unknown** (no server envelope came back, so the outcome could not be established). A server `Completed` status always outranks every marker, and a marker is retired as soon as the condition that produced it has passed. The markers exist because `Bank Statement Import Log` has exactly two status values and **no error field**, so the failure has nowhere else to live. |
| **FM3** | The transaction has already been reconciled | Confirm is **disabled**, on the backend's own predicate — `status === 'Reconciled'` or `unallocated_amount <= 0`, which the server derives from each other — and a tooltip says why. This is an affordance, not the control: the authoritative guard is the first statement of the first method `reconcile_vouchers` invokes. A stale client that gets through is refused by the server, and that refusal surfaces in the same dialog before the affected caches are re-read. |
| **FM4** | A re-import produces duplicate transactions | Rendered exactly as the backend produces them. **There is no client-side deduplication, and none may be added.** |
| **FM5** | The transaction's currency differs from the bank account's | A **non-blocking** amber advisory badge beside the rule badge. It does **not** disable confirm; whatever the backend enforces is what happens, and a rejection surfaces through the FM1 path. Both sides resolve the currency through the same lookup (`Bank Account.account` → `Account.account_currency`), so the indicator cannot disagree with the server. |

## Scope boundaries

What this package does **not** do, stated so a reader does not go looking:

| Boundary | Status |
| --- | --- |
| Backend endpoints | **None added.** Every call the workflow makes already existed and was already whitelisted. |
| DocType schema | **No** field, status option, JSON edit, migration or patch entry. |
| REST/RPC contract | Unchanged, including the call style: module functions by dotted path, the one document method through the generic `run_doc_method` bridge. |
| Routes and providers | Unchanged. The dialog is mounted inside existing trees; no route or provider was added. |
| Design system | **No** new token and **no** new primitive. New affordances compose the primitives in `src/components/ui/`. |
| CI workflows | Unchanged. The Python suites are already discovered on both database engines; the frontend gate is `yarn verify`, which is **not** yet wired into a workflow — doing so is a workflow change and belongs to whoever owns those files. |
| `frappe/` submodule | Untouched, pointer and contents. `frappe/cypress/` is referenced for **conventions only**; no Cypress spec is added here. |
| Backend diff | One **additive** test module per bank DocType directory that needed coverage. No backend source file changes. |

Out of scope as features: no Plaid interface, no MT-940/XML ingestion in this SPA (the dropzone
accepts CSV, XLSX, XLS and PDF, and the server-side reader rejects anything else), no currency
conversion or revaluation, no multi-entity reconciliation, no client-side deduplication, and no
change to general-ledger posting or to the legacy Desk reconciliation tool.

## Intentionally unchanged files

These are load-bearing and are deliberately left as they are. Read them for context; do not edit
them as a side effect of feature work:

`vite.config.ts` · `tsconfig.json` · `tsconfig.app.json` · `.env.production` · `index.html` ·
`src/index.css` · everything under `src/types/` · and the `"version": "0.0.0"` field in
`package.json` — a Vite-scaffold artefact, not a statement about how complete this application is.

Four files in that neighbourhood **did** change, each for one narrow reason, and each is worth
knowing about before you assume it is untouched:

| File | The one change, and why |
| --- | --- |
| `tsconfig.node.json` | `vitest.config.ts` added to `include`, so the runner's own configuration is type-checked. `tsc -b` only ever sees a file some project includes, so without that line a type error there is silently undetected. |
| `eslint.config.js` | `coverage` added to `globalIgnores`. The V8 HTML report ships its own vendored scripts, so linting it made the result of `eslint .` depend on whether a coverage run had happened first. |
| `.gitignore` | `coverage` added, for the same output. Running the required gate must not leave the working tree dirty. |
| `src/components/ui/markdown.tsx` | Its same-origin link filter. This renderer is the sink for server-authored `_server_messages`, and the error dialog put that sink on a financial posting screen — so an off-origin `href` written by the server is refused, including every backslash spelling of the scheme-relative form, and a backslash is refused outright rather than folded into `/`. |

The same care applies to `vitest.config.ts`'s independence from `vite.config.ts` and to the
`resolutions` field: both look like tidy-up candidates and both are load-bearing, which is why
each has its own section above.
