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
| `lint` | `eslint .` | Flat config; lints every `**/*.{ts,tsx}`; ignores `dist` **and** `coverage`, so it is silent whether or not a coverage run has happened — see [Linting](#linting). |
| `preview` | `vite preview` | **Does not show you the build** — it serves the built HTML and the SPA fallback, but the proxy takes every asset URL. **Requires the bench config file** (it loads `vite.config.ts` too); with no prior `build` it starts and answers 404. Read [below](#preview-cannot-show-you-a-built-bundle) before reaching for it. |
| `copy-html-entry` | `cp ../erpnext/public/banking/index.html ../erpnext/www/banking.html` | Internal helper, invoked by `build`. |
| `test` | `vitest run` | **Non-watch by construction** — a bare `vitest` enters watch mode, which is unusable in CI or any non-interactive context. **Does not require the bench config file.** |
| `test:coverage` | `vitest run --coverage` | V8 provider; emits `text` + `json-summary` + `lcov`; **fails the process** below the configured line threshold. |
| `typecheck` | `tsc -b` | The whole type gate, and the only one. It exists because **`build` never invokes the compiler**, so without this script a type error would not be observable from this package's scripts at all. It builds both `tsconfig` programs — the whole of `src/`, plus `vite.config.ts`, `vitest.config.ts` and the `proxyOptions.ts` they import. See [TypeScript project layout](#typescript-project-layout). |

Those eight are the whole script set — there is deliberately no aggregate `verify` or `ci` script.
The acceptance gate is the three of them that need no bench config, run in order:

```bash
yarn typecheck && yarn lint && yarn test:coverage
```

### `preview` cannot show you a built bundle

`vite preview` is the one script whose name promises more than it delivers here, so it gets its own
note rather than a footnote. **It starts, it answers `/`, and the page stays blank.** Two independent
causes stack up, and neither is fixable from this package — both live in files this change set
deliberately leaves alone.

**Cause 1 — the proxy takes the asset URLs.** `vite.config.ts` sets `server.proxy` from
`proxyOptions.ts`, whose single rule is the regex `^/(app|api|assets|files|private)`, and
`vite preview` **inherits `server.proxy`**. `build` runs with `--base=/assets/erpnext/banking/`, so
**every** emitted asset URL begins `/assets/` and matches. Measured against a running preview server:

| Request | Served by | Result |
| --- | --- | --- |
| `/`, `/index.html`, `/statement-importer` (SPA fallback) | the preview server | `200`, the 3,366-byte built HTML |
| `/assets/erpnext/banking/assets/index-*.js` (the entry module) | **Frappe** | `404`, `content-type: text/html` — the body is byte-identical to Frappe's own 404 page |
| `/assets/erpnext/banking/assets/index-*.css` (the stylesheet) | **Frappe** | `404`, `content-type: text/html` |
| `/api/method/ping` | **Frappe** | `200 {"message":"pong"}` — the control proving the proxy is live |
| `/files/…`, `/app` | **Frappe** | `500`, `301` |

In a browser the consequence is total: `#root` ends with **0** descendants, `document.body.innerText`
is empty, `document.styleSheets` exposes **0** applied rules, and `body` falls back to Times New
Roman. **0 of the asset requests are answered by the preview server.**

> **The 404s are the honest outcome; watch for the 200s.** On a shared bench, `sites/assets/erpnext`
> symlinks to *one* checkout, so a sibling clone's build answers these URLs. Vendor chunk filenames
> are content-hashed, so unchanged vendor code produces the **same** filename in every clone — in one
> measured run 12 of 14 asset requests returned `200 text/javascript` **from a different clone's
> build**. Only the two hashes unique to this build 404'd. Nothing executed (they arrived via
> `modulepreload`, and the entry module they would have fed never loaded), but the hazard is real: if
> an entry hash ever collided, `preview` would boot a **stale bundle from another checkout** while
> looking like it worked.

**Cause 2 — the HTML is an unrendered template.** `index.html` is a Jinja template that the host app
renders; `preview` serves the raw file. So the inline bootstrap reaches
`frappe.boot = JSON.parse({{ boot }})`, which is not valid JavaScript, and the browser reports
`Uncaught SyntaxError: Unexpected token '{'`. A `SyntaxError` is a parse-time failure, so the **whole**
inline block is discarded and `window.frappe` is never created — which means the router's boot gate
(`window.frappe?.boot?.user?.name` present and not `Guest`) can never pass. **Fixing the proxy alone
would not make `preview` usable.**

**To look at a real build, go through the host app** — `yarn build` already emits to
`../erpnext/public/banking` and copies the HTML to `../erpnext/www/banking.html`, so a bench serving
this checkout renders it at `/banking` with a real boot payload. `preview` remains useful only for
what it can actually answer: confirming the built HTML and the SPA fallback exist.

### Stopping `dev` and `preview`

Both are long-running, and **Yarn Classic does not forward signals to the `vite` child.** Measured on
both scripts: `SIGTERM` to the `yarn` wrapper kills the wrapper, and the child keeps serving — the port
stays bound and still answers `200`. Signal the process **group** instead, which is what a terminal
`Ctrl-C` does and why this never shows up interactively:

```bash
kill <yarn-pid>          # wrapper dies; vite keeps serving; port still bound
kill -- -<yarn-pid>      # stops both — yarn is the group leader, so its pid is the pgid
```

The distinction matters for scripting, not for typing. Anything that stops the server by signalling
only the wrapper it spawned leaks the child and then cannot rebind port `8080` or `4173`. If you need
the child's own pid, ask the port rather than the command line — `ss -ltnp | grep :8080` names the
process actually holding it, whereas matching on `vite` also matches every other Vite process on the
machine, which on a shared host is not only yours. This is Yarn Classic behaviour rather than
something this package configures.

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

Its `afterAll` then waits out one debounce window — 550 ms, one window past the longest any surface
here arms — before the file ends. That is not tidiness: it is what keeps the exit code meaningful,
and the reasoning is in [Order independence](#order-independence-and-the-four-rules-that-keep-it).

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

**47 suites, 1,236 tests, all passing.** They are grouped below by what they exist to protect. Test
counts are from `vitest run --reporter=json`, so they are reproducible.

The six mandated workflow scenarios are carried by the first group; the rest exist because the
coverage gate measures the **whole** source tree (see [Coverage gate](#coverage-gate)), so a module
without a suite is a module holding the floor down.

**The reconciliation workflow and its failure modes**

| Suite | Tests | Subject |
| --- | --- | --- |
| `BankReconciliation/utils.test.ts` | 98 | The typed API-client hook layer, its five cache-key families, the post-success revalidation, and the post-rejection convergence that distinguishes a server refusal from transport ambiguity |
| `BankReconciliation/MatchAndReconcile.test.tsx` | 78 | The workbench: transaction list, suggested match, manual override, confirm, the already-reconciled guard, the currency advisory and its keyboard-reachable tooltip |
| `BankReconciliation/BankRecErrorDialog.test.tsx` | 38 | The dismissible error dialog — server text rendered verbatim, severity chosen by the server, dismissal, and viewport containment |
| `BankReconciliation/RecordPaymentInvoices.test.tsx` | 24 | Allocating a recorded payment across outstanding invoices, with the allocation computed **server-side** |
| `BankReconciliation/RecordPaymentModalContent.test.tsx` | 15 | Selection routing (none / one / several) and the single-versus-bulk endpoint choice |
| `BankReconciliation/BankTransactionUnreconcileModalBody.test.tsx` | 16 | Undo: which vouchers get **cancelled** versus merely detached, and the three caches that must be revalidated |
| `BankReconciliation/BankEntryModalContent.test.tsx` · `TransferModalContent.test.tsx` | 14 · 14 | The other two voucher-creating surfaces |
| `pages/BankReconciliation.test.tsx` | 10 | The five-tab shell, and that it withholds the tab strip until an account is chosen |

**The statement importer**

| Suite | Tests | Subject |
| --- | --- | --- |
| `pages/BankStatementImporter.test.tsx` | 65 | The importer surface: the three-state per-file badge, the log list and its projected fields, and negative authorisation |
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

On the backend, the four bank DocType test modules carry **65 tests** between them, up from 45 —
see [What this change set contains](#what-this-change-set-contains).

### Order independence, and the four rules that keep it

Declaration order is not part of the contract: the suite is expected to pass in **any order the
runner supports**, so a shuffled run belongs in the gate rather than in the curiosities.

```bash
# Whole suite, files AND tests shuffled.
CI=true npx vitest run --sequence.shuffle --sequence.seed=1

# One file, tests shuffled within it — the sharper of the two, since it isolates within-file order.
CI=true npx vitest run src/components/features/BankReconciliation/MatchAndReconcile.test.tsx \
  --sequence.shuffle.tests --sequence.seed=1
```

Verified over the ten seeds `1 2 3 4 5 6 7 42 20260805 987654321`, whole-suite and per-file:
**1236/1236 with `Errors 0`** on every one. Also verified under `--coverage`, and with four spinners
saturating a four-core machine — the condition that exposed the last two rules below.

Four harness rules are what make that true. Each is here because breaking it produced a verdict that
moved with test order or with machine speed rather than with the behaviour under test:

| Rule | What breaking it looked like |
| --- | --- |
| A test that opens a lazily loaded **modal body** renders inside an ancestor `TooltipProvider` | `BankEntryModalContent` and `RecordPaymentModalContent` render a bare `Tooltip` and consume the provider `App.tsx` mounts. A routing test that waits only on the dialog **shell** title may or may not have mounted the body by the time it asserts, so Radix threw `` `Tooltip` must be used within `TooltipProvider` `` on 7 of 10 shuffle seeds. The workbench's own tooltips are a different matter: they are asserted **without** an ancestor provider on purpose, because it supplies its own |
| A suite whose surface sits behind `lazy()` **warms the chunk in `beforeAll`** | Otherwise whichever case opens it first pays the whole transform-and-evaluate cost inside its own timeout, and the charge moves between cases with `--sequence.shuffle`. Under `--coverage` the first settings open measured **4.19 s against the 5 s default**; warmed, it measures 0.9 s. Both `MatchAndReconcile.test.tsx` (three modal bodies) and `Settings.test.tsx` (the panels chunk) do this, and both also declare a suite-level `timeout` so an inner allowance is actually reachable |
| No assertion may turn on **wall-clock time** | The importer's mapping saves debounce at 500 ms while one Radix `Select` interaction measures 230-410 ms here, so "these two edits collapse into one save" was really "this machine is fast enough". `CSVRawDataPreview.test.tsx` asserts the invariant instead — every save carries the mapping as it stood when its timer fired — and says so in place. Its PDF sibling *can* count saves, because two region switches are dispatched synchronously with `fireEvent` |
| `setup.ts` drains one debounce window in an `afterAll` | `usehooks-ts`'s `useDebounceCallback` cancels a **different** `lodash.debounce` instance on unmount from the one it invokes, so a timer armed by the last test in a file outlives `cleanup()`, fires against a torn-down jsdom, and React's `resolveUpdatePriority` reads `window`. Vitest counts that as an unhandled error and **exits non-zero while reporting every test passed** |

### A filter that matches nothing still exits 0

`vitest run -t <pattern>` **skips** every test when the pattern matches none, and skipped is not
failed:

```
$ CI=true npx vitest run -t "no-such-test-name"
 Test Files  47 skipped (47)
      Tests  1236 skipped (1236)
   Duration  … (… tests 0ms …)
$ echo $?
0
```

That is the runner's own filtering semantics rather than anything this package controls, but it means
a mistyped `-t` in a script is silently green. Either guard closes it:

- **Confirm the name first.** `npx vitest list` prints all 1,236 as `<file> > <suite> > <test>`, so the
  string can be checked before it is filtered on.
- **Require an executed count.** `--reporter=json` reports `numPassedTests` and `numPendingTests`; for
  the run above they are `0` and `1236` while `success` is still `true`, so automation should assert
  `numPassedTests > 0` rather than trusting the exit code alone.


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
| Suites / tests | **47 files, 1,236 tests**, all passing |
| **Lines** (the gated metric) | **2992 / 3571–3572 = 83.76–83.78%** against the 80% floor |
| Statements | 3149 / 3800–3801 = 82.84–82.86% |
| Functions | 885 / 1145 = 77.29% |
| Branches | 2234–2236 / 3133–3137 = 71.27–71.30% |

The floor is 2857 or 2858 lines, so the margin is **+134 lines** at its narrowest. That is deliberately reported here,
because it is small: a new module of any size lands under the gate the moment it is added, and
adding one without a suite will turn the gate red. **That is the intended behaviour** — it is what
distinguishes this configuration from one that only measures what it already covers.

> **Why those are ranges and not single numbers.** The test count is exact, and so is every COVERED
> count for lines and statements: `yarn test:coverage` reports 2992 covered lines and 3149 covered
> statements on an unchanged tree, run after run. What moves is the **denominator** — the number of
> lines and statements V8 reports as instrumented at all — by exactly one each (3571 or 3572, and 3800
> or 3801), which is what shifts the percentage between 83.76% and 83.78%. Branch coverage moves on
> both sides of the fraction (2234–2236 of 3133–3137); function coverage does not move at all. Nothing
> else in the report varies. Treat a figure inside these ranges as reproduction and a figure outside
> them as a real change — and do not "correct" a 3571 reading to 3572, because both are genuine.
> Because only the denominator drifts, plan against the **lower** percentage: 83.76%, a margin of
> **+134 lines** over the floor.

Only `lines` is gated. Statements, functions and branches are reported for information; branch
coverage in particular sits well below the line figure because the suites assert on rendered
behaviour rather than driving every defensive path.

### The gate is non-vacuous, and that was verified rather than assumed

Restoring `include` to the whole tree — before any of the new suites existed — made
`yarn test:coverage` **fail immediately** at **39.42%** with
`ERROR: Coverage for lines (39.42%) does not meet global threshold (80%)`. Every point from there
to today's ~83.8% was bought with a suite. The gate has been observed both red and green in this
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

### `vitest/vite` — without it, adding or updating Vitest fails

**It is mandatory, not cosmetic — and it is the least obvious thing in this workspace.** Four
points, in the order they matter:

1. **Without it, any install that has to *add* Vitest to a graph an existing lockfile has already
   pinned fails outright.** Not a warning — it aborts with

   ```
   error Invariant Violation: could not find a copy of vite to link in
         …/node_modules/vitest/node_modules
   ```

   Which installs those are is worth stating exactly, because the two obvious experiments land on
   opposite sides of the line. All four rows below were run with `rm -rf node_modules` first:

   | Install | Field removed | Result |
   | --- | --- | --- |
   | `yarn add -D vitest@4.1.10 @vitest/coverage-v8@4.1.10` onto the pre-change-set lockfile | — | **exit 1**, invariant violation |
   | `yarn install` against **any lockfile predating these packages** (the pre-change-set baseline, or an older branch) | yes | **exit 1**, invariant violation |
   | `yarn install` against the **committed** lockfile | yes | **exit 0** — and it rewrites `yarn.lock` |
   | `yarn install` with **no `yarn.lock` at all** | yes | **exit 0** — a from-scratch resolution hoists `vite` to the root by itself |

   So the failure needs a lockfile that constrains the graph but does not yet describe the
   vitest→vite pair. Given a complete lockfile Yarn reads the pair, and given no lockfile it derives
   the pair; it only fails in between, which is precisely the state a contributor adding or updating
   Vitest is in.

   **Two things follow, and the second is the one that bites.** Do not conclude from a green install
   that the field is stale and delete it — the check that looks like it disproves the warning is
   exercising a case the field is not needed for. And that green install is not inert: it **silently
   rewrites `yarn.lock`**, dropping the deduped `vite@8.1.2` alias, so the committed key

   ```
   vite@8.1.2, "vite@^6.0.0 || ^7.0.0 || ^8.0.0", vite@^8.0.16:
   ```

   becomes `"vite@^6.0.0 || ^7.0.0 || ^8.0.0", vite@^8.0.16:`. The tree on disk is still correct, so
   nothing looks wrong locally, but the lockfile has drifted from the committed graph and the next
   contributor who *does* need a fresh resolution gets the invariant violation with no field left to
   explain it. `yarn install --frozen-lockfile` also exits 0 in this state and leaves the lockfile
   untouched, which is why the drift is easy to commit without noticing.
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
> `yarn install --frozen-lockfile` passes, and the two `ws` advisories this override exists to
> close stay closed — see [Dependencies](#dependencies) for what `yarn audit` reports today and why
> that number is not a fixed property of this lockfile.

> ⚠️ **Do not delete either field** while cleaning up `package.json`. They look like leftovers and
> both are load-bearing: removing `vitest/vite` breaks `yarn install` for everyone, and removing
> `ws` reopens one high and one moderate advisory.

## TypeScript project layout

Three configuration files. `tsconfig.json` and `tsconfig.app.json` are intentionally unchanged;
`tsconfig.node.json` gained one entry, noted in its row and explained under
[Intentionally unchanged files](#intentionally-unchanged-files).

| File | Role |
| --- | --- |
| `tsconfig.json` | Solution file: `files: []`, references `./tsconfig.app.json` and `./tsconfig.node.json`, and declares `baseUrl: "."` with `paths { "@/*": ["./src/*"] }` |
| `tsconfig.app.json` | The application program: `include: ["src"]`, `target` `ES2020`, `lib` `["ES2020", "DOM", "DOM.Iterable"]`, `moduleResolution` `bundler`, `jsx` `react-jsx`, and `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports` all enabled. It declares **no `types` array.** |
| `tsconfig.node.json` | The tooling program: `include: ["vite.config.ts", "vitest.config.ts"]` — the second entry added here — plus `types: ["node"]`, `target`/`lib` `ES2023`, with `verbatimModuleSyntax` and `erasableSyntaxOnly` enabled, which is why `proxyOptions.ts` imports its Node HTTP request type with `import type` |

`tsc -b` builds both programs, so **everything in this package that TypeScript can check is checked**:
the whole of `src/` — application code and colocated suites alike — plus `vite.config.ts`,
`vitest.config.ts`, and the `proxyOptions.ts` that `vite.config.ts` imports.

> **The runner configuration used to be the one blind spot, and it no longer is.** `vitest.config.ts`
> was in neither program's `include`, so a type error in it surfaced only when `yarn test` next failed
> at config load — the one file where a silent mistake costs the most, since a broken runner config
> takes the whole gate with it. Adding it to the tooling program's `include` is one of the three
> build-adjacent edits this change set makes; the reasoning is in the table under
> [Intentionally unchanged files](#intentionally-unchanged-files).

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

The rules are unchanged; the ignore list is the one thing this change set touched. `coverage` was
added to it because `eslint .` after a coverage run otherwise reported three
`Unused eslint-disable directive` warnings from the HTML report's own vendored helper scripts — see
[Reporters and generated output](#reporters-and-generated-output). `eslint .` is now silent either way,
which is what makes it usable as a gate.

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
| `src/test/` | The Vitest harness: exactly three files — `setup.ts` (global stubs), `factories.ts` (fixtures and the shared SDK mock) and `renderPanel.tsx` (the shared panel harness) |
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
| **FM1** | The confirm/post request fails — refused by the server, or no response at all | The dialog shows the server's own message, passed through **unmodified**: the client paraphrases nothing and adds no wording of its own. Confirm/post is **one** server-side call and **nothing is mutated optimistically**, so the transaction stays unreconciled with its state unchanged — true by construction rather than by rollback. The rejection handler does exactly three things: it raises the existing toast, it puts the raw error on the dialog atom, and it revalidates the two transaction-list cache keys so the next render is built from the server's current figures. Duplicate posting is refused where it must be: the in-flight `loading` state disables the control for the duration of a request, and the server's own already-reconciled state check is the authoritative guard.<br><br>Each surface renders the refusal in the form it can actually render. The **dialog** gets the error object by identity, so the banner's markdown renderer shows the server's emphasis as emphasis. The **toast** gets the same words as plain text, because a toast has no markup renderer and was otherwise printing `<strong>` at the reviewer as literal characters; the markup is stripped by reading back the text of an inert `DOMParser` document rather than by assigning `innerHTML`, so nothing in the server's string is ever parsed into the live page. That toast also carries a **stable id**, so a reviewer who retries a doomed post sees one toast update rather than a stack of identical ones. Finally, what reaches the **console** is a narrowed summary — the call that failed, the HTTP status, `exc_type`, and the parsed server messages. Frappe answers a refusal with its full `exc` traceback, and logging the error object whole published roughly seventy lines of it, naming ten server-side file paths, to anyone with the console open. The traceback is not the client's to disclose. |
| **FM2** | A malformed or empty statement file | The server refuses the import synchronously and rolls it back; the refusal reaches the reviewer twice over. It opens the shared dialog in the server's own words — the handler used to take **no argument at all** and discard them — and it marks that **one file** with a red **Failed** chip. No transaction is ever created client-side. The chip is driven from the observed rejection rather than from the document because `Bank Statement Import Log` has exactly two status values — `Not Started` and `Completed` — and **no error field**: a rolled-back import leaves the row saying `Not Started`, indistinguishable from one merely waiting to be imported, so the failure has nowhere else to live. Nothing held for this is persisted — a stale failure marker must not survive a reload.<br><br>**Where the chip appears depends on how far the import got, and this distinction is the whole of the mechanism.** A statement can be refused at either of two stages. If the import log was created and `insert_transactions` then failed, there is a row to mark, and the chip replaces that row's stored status in **Previous Imports**, keyed by log name. If the refusal came earlier — `upload_file` rejecting the content, or `Bank Statement Import Log.before_insert` failing to parse a file the framework accepted — then **no log exists**, and there is no row to mark and no detail screen to show it on. That path is marked on the **upload form itself**, against the pending file by name, which is the only place left that can honestly say which file was refused; the marker retires when a different file is chosen or a retry is dispatched. Neither marker can contradict the server: an authoritative `Completed` is checked first and always wins, and markers are pruned against the rows the list actually returns.<br><br>**One refusal is presented one way at a time.** The rejected promise reaches the dialog, and the same object also lands on the failing hook's `error` member, which renders the page's inline banner — so a single refusal used to announce itself in three places simultaneously, with the banner mounting *behind* the modal and pushing the form down while the modal was still being read. The banner is now suppressed while the modal is reporting that **same error object**, compared by identity: it returns the moment the modal is dismissed, which is what keeps the server's words on the page afterwards, and a genuinely separate later failure is a different object and is never hidden by a stale one. |
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
| CI workflows | Unchanged. The Python suites — including the 20 tests added here — are already discovered on both database engines by the existing four-shard workflows, so no edit is needed for them. The frontend gate is not wired into a workflow; see [Known limits](#known-limits-of-this-change-set). |
| `frappe/` submodule | Untouched, pointer and contents. `frappe/cypress/` is referenced for **conventions only**; no Cypress spec is added here. |
| Backend diff | **Eight files, and only the four permitted bank DocType directories** — one controller and one test module in each, itemised with line counts under [What this change set contains](#what-this-change-set-contains). The controller edits are authorisation and enqueue-timing corrections; **no** DocType JSON, **no** migration, **no** new, renamed or re-signed endpoint, and **zero** deletions of existing tests. |

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

**One hundred and eight paths: fifty-five created, fifty-three updated, none deleted.** One hundred are under
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
| `vitest.config.ts` | create | 49 lines | The runner configuration: jsdom, globals, the setup file, the test glob, the `@` alias, V8 coverage with three reporters over the whole of `src/`, and the single aggregate `{ lines: 80 }` gate. Deliberately independent of `vite.config.ts`. |
| `tsconfig.node.json` | update | +2 / −1 | `vitest.config.ts` added to the tooling program's `include`, so the runner configuration is type-checked rather than silently unchecked. |
| `.gitignore` | update | +4 / −0 | `coverage` — generated V8 reporter output, reported to the console and consumed by CI from `coverage/lcov.info`, never committed. |
| `eslint.config.js` | update | +2 / −1 | `globalIgnores(["dist", "coverage"])`, so the HTML coverage report's vendored helper scripts are not linted as source. |
| `README.md` | update | +1100 / −60 | This document, replacing the stock Vite scaffold text. Its own figure is the one in this table that goes stale the moment the file is edited again; re-read it with the same `git diff <baseline> --numstat` command as the rest. |

### Frontend — application source

| File | Op | Scope | The change |
| --- | --- | --- | --- |
| `bankRecAtoms.ts` | update | +133 / −6 | A type-only import and **two plain in-memory atoms** appended to the sixteen already there: the error-dialog payload (`FrappeError \| null`) and the per-log failure markers (`Record<string, FrappeError>`, holding the raw errors). Neither is persisted — a stale error dialog or failure marker must not survive a reload — and the comment says so, because neighbouring atoms *are* persisted. No existing atom, interface or persisted key changes shape. |
| `utils.ts` | update | +322 / −18 | The FM1/FM3 rejection path: a server-refusal predicate derived from the SDK's own `httpStatus`, a `convergeWithServer()` re-read that replaces or clears the stale selection, the raw error routed to the dialog atom, and contained revalidation of the two transaction-list keys. Plus `useSelectedBankAccountCurrency()`, which reads the live `bank_account.get_list` row so the FM5 advisory never compares against the `localStorage` snapshot. No sixth cache key, no optimistic mutation. |
| `MatchAndReconcile.tsx` | update | +465 / −103 | Three edits and the imports they need: the dialog mount beside the three existing modal mounts; the FM5 advisory badge in the transaction row's badge cluster, on a focusable wrapper span with an accessible name, sized so a long rule name ellipsises instead of clipping it; and the FM3 already-reconciled guard on the confirm control, with its reason likewise anchored to a focusable wrapper. |
| `CSV/StatementDetails.tsx` | update | +152 / −19 | The rejection callback now *takes* the error — it previously took none and discarded it — routes it to the dialog and records the per-file marker under this import log's name; the marker is retired on a confirmed success; upload failures surface on the upload surface itself; and the realtime payload is read as a percentage with a terminal total. One edit, two flows: both the CSV and PDF importers use this module. |
| `import_utils.ts` | update | +12 / −1 | The statement currency corrected to `data.doc.currency`, which is where `get_statement_details` actually returns it, with a comment recording that there is deliberately no top-level `currency` key. |
| `pages/BankStatementImporter.tsx` | update | +301 / −23 | The per-row status badge gains a third, contrast-passing red `Failed` state driven by the failure map, an authoritative `Completed` wins over a stale marker, and the dialog is mounted here too because this page sits in a different route tree. The upload form carries its own per-file `Failed` marker for a refusal that happened before any log existed — held in component state, because the failure map is keyed by log name and this path produces no log to key against — and the inline banner is suppressed while the dialog is reporting that same error object, so one refusal is presented one way at a time. |
| `BankRecErrorDialog.tsx` | create | 273 lines | The dismissible dialog, composed from the existing `AlertDialog` and `ErrorBanner`, with a responsive width and height containment. The Frappe error is passed through **by identity** — no re-encoding, no field clearing — so the banner parses the server's own envelope and picks its own severity from it. |

### Frontend — test infrastructure and suites

| File | Op | Scope | The change |
| --- | --- | --- | --- |
| `src/test/setup.ts` | create | 440 lines | The Desk-runtime harness described under [The harness](#the-harness), including the Pointer Capture and `scrollIntoView` stubs without which Radix `Select` cannot open under jsdom. A pure side-effect module — zero exports. |
| `src/test/factories.ts` | create | 1513 lines | Every fixture, shaped from verified server payloads, plus the one shared `frappe-react-sdk` module mock. |
| `src/test/renderPanel.tsx` | create | 136 lines | The shared panel harness: a per-render jotai store, router and tooltip provider, and `stubViewportMeasurement()`, which is required because `ui/list-view.tsx` virtualises through `useVirtualizer` and renders **zero rows** when jsdom reports an `offsetHeight` of 0. |
| **47** `*.test.{ts,tsx}` files | create | 23,029 lines | The suites listed under [Suites](#suites) — **1,236 tests**, all passing, carrying the whole-source coverage gate to 83.8%. |

### Backend — four controllers and their four test modules

All additive or corrective; no DocType JSON, no schema change, no new or renamed endpoint.

| File | Scope | The change |
| --- | --- | --- |
| `bank_reconciliation_tool.py` | +342 / −42 | Permission enforcement on `get_linked_payments` (the reviewed **critical** finding: it read voucher candidates for any transaction the caller named, without checking that the caller may read that transaction or its bank account), a single permission-aware query for `get_older_unreconciled_transactions`, and currency validation on the submitted-document reconcile path. |
| `bank_transaction.py` | +48 / −3 | Currency validation reachable from the submitted-document path, so the FM5 promise the UI makes is one the server actually keeps. |
| `bank_transaction_rule.py` | +61 / −3 | Write-appropriate authorisation and company scoping on `run_rule_evaluation`, job de-duplication, and `enqueue_after_commit` so a freshly imported batch is visible to the job it triggers. |
| `bank_statement_import_log.py` | +84 / −8 | Rule evaluation enqueued after commit, for the same visibility reason. |
| `test_bank_transaction.py` | 8 → **14** | +273 / −0. |
| `test_bank_transaction_rule.py` | 20 → **29** | +281 / −0. Includes the two tests that close the one mandated scenario with no coverage anywhere in the repository — rule-based auto-match: that a matching rule stamps `matched_transaction_rule` and sets `is_rule_evaluated`, and that when two rules match, the lower priority number wins. They call the **private synchronous** evaluator, because the whitelisted entry point only checks permission and enqueues a background job, so a synchronous test asserting on the stamp could observe nothing. |
| `test_bank_reconciliation_tool.py` | 4 → **29** | +596 / −1. Covers the authorisation refusals added above, including the cross-company IDOR case. The one deleted line is an `import` that the new tests widened — no test was removed, here or anywhere. |
| `test_bank_statement_import_log.py` | 13 → **20** | +234 / −0. |

**Backend total: 45 → 92 tests** (14 + 29 + 29 + 20), every one passing on MariaDB. All are clean against this
repository's own `semgrep/test-correctness.yml`: no `frappe.db.commit()`, no `frappe.db.truncate()`,
no `tearDown` override.


## Known limits of this change set

Everything below is verifiable from this change set itself. Each entry names what is not covered,
the boundary that stops it, and what closing it would take.

| # | Where | What is not covered, and why | What closing it requires |
| --- | --- | --- | --- |
| 1 | `.github/workflows/**` | **No workflow runs the frontend gate.** The Python suites, including the ones added here, are already discovered on both database engines by the existing four-shard workflows. The frontend gate is not — `grep -RniE 'vitest\|yarn test\|npm test\|test:coverage' .github/workflows` returns **zero matches**, re-confirmed against the current tree — so the 1,236-case suite, the 80% line threshold and the shuffled-order check are not CI-gated, and none of them can be wired from here: the diff for this work is confined to this workspace and the bank DocType directories, so a workflow file is outside every permitted path. | A job on an existing workflow, on Node ≥ 24.15, running exactly what the acceptance gate runs plus one shuffled seed — `yarn install --frozen-lockfile`, then `CI=true yarn typecheck`, `CI=true yarn lint`, `CI=true yarn test:coverage`, then `CI=true npx vitest run --sequence.shuffle --sequence.seed=1`. A change belonging to whoever owns those files. |
| 2 | Frontend test suite | **Every suite runs under jsdom**, which performs no layout and executes no subresources. Real scrolling, genuine rendering and true viewport measurement are out of reach; the suites assert on rendered output, roles and control state instead. Two consequences are worked around rather than solved: `ui/list-view.tsx` virtualises through `useVirtualizer` and renders **zero rows** when jsdom reports an `offsetHeight` of `0`, so panel suites install `stubViewportMeasurement()`; and the Pointer Capture API and `scrollIntoView` are stubbed in `src/test/setup.ts` because Radix `Select` cannot open without them. | A browser-driven regression suite, alongside the CI job in row 1. |
| 3 | Coverage measurement | **Only `lines` is gated.** The whole source tree is measured (2992 / 3571–3572 = 83.76–83.78%, a [one-line run-to-run range](#current-state)), and the floor is 2857–2858, so the margin is **+134 lines** at its narrowest — a large new module still turns the gate red until it carries a suite. Branch coverage sits at ~71.3% and function coverage at 77.29%, both ungated: the suites assert on rendered behaviour rather than driving every defensive path. | Suites for new modules as they arrive, and a branch floor once branch coverage has been raised deliberately. |
| 4 | Backend test suite | **Multi-session concurrency is not expressed.** Observing one session's uncommitted transaction from another requires `frappe.db.commit()`, which this repository's own `semgrep/test-correctness.yml` bans in tests at ERROR severity. | Integration tests outside the unit harness, or a harness change agreed with whoever owns those rules. |
| 5 | `package.json` | **`yarn check --verify-tree` reports one error, and every install prints one matching warning** — both are the expected signature of the [`ws` override](#ws--the-one-advisory-with-no-in-range-fix) doing its job, not defects. `yarn install --frozen-lockfile` passes. Separately, **`yarn audit` is a live registry query and is not clean today**: it exits `8` with one High advisory on a dev-only `eslint` dependency path, which is a dependency change set rather than this one — see [Dependencies](#dependencies). | Upstream `engine.io-client` widening its `ws` range, after which the override can be deleted. |
| 6 | `src/components/ui/markdown.tsx` | **Server-supplied markdown is rendered without a sanitiser.** Every `ErrorBanner` — including the new dialog — renders server text through this primitive, so the SPA's trust boundary is "the Frappe server is trusted". Closing it needs a sanitiser dependency, and this change set may add no runtime dependency; the file is also a design-system primitive, which are composed here and never modified. | A sanitiser dependency and a primitive change, as their own change set. |
| 7 | `frappe-react-sdk` — the file-upload hook | **A refused upload still publishes the server's traceback to the browser console, and this SPA cannot stop it.** The [FM1 narrowing](#workflow-behaviour-and-the-five-failure-modes) covers what *this* code logs, and the importer page contains no `console` call at all — but `useFrappeFileUpload` ends its own promise chain with `.catch(e => { throw console.error(e), … })`, logging the whole error object *before* any application handler runs. When a site returns Frappe's `exc` key, that object carries the full Python traceback and the server paths in it. Verified against a 0-byte statement: the modal, banner, toast and per-file marker all showed only the two human-readable `_server_messages`, while the console carried the traceback from the SDK frame. It is unreachable from here — the logging is inside a dependency, and not using the hook would mean replacing the upload path, which is well outside a minimal change. | Upstream dropping that `console.error`, or the site not returning `exc` to clients. Both belong to owners other than this workspace. |
| 8 | Pre-existing defects found but not fixed | Several latent defects were discovered while writing the suites and are **pinned by a `QUIRK`-labelled test** rather than corrected, because each lives in a file outside this change set's scope. The most consequential: `lib/amountFormula.ts` never throws and never returns `NaN` — it yields `0` for unparseable input — so `RuleForm`'s red "not a valid formula" warning is **unreachable** and a typo'd formula is presented as valid while previewing `0`. Also recorded: an unreachable `Loading...` branch in the import-log route, a blank `party_name` in the invoice-picker heading, a missing `.catch` on the unreconcile call, calendar-year and fiscal-year periods offered side by side, and a missing React key in `KeyboardShortcuts`. | Each in a change set that owns the file in question. The tests documenting them will fail loudly if the behaviour changes, which is the point. |


### Performance limits measured against a running site

The rows below were each reproduced and measured against a seeded site rather than inferred, and
every one of them **pre-dates this change set**. They are recorded here because the numbers are the
useful part: a reader deciding whether any of this matters at their data volume should not have to
re-measure it. None is fixed here, and each row names the boundary that stops it.

| # | Where | What was measured | What closing it requires |
| --- | --- | --- | --- |
| 8 | `bank_reconciliation_tool.get_bank_transactions`, `…get_linked_payments` | **Neither endpoint is bounded and neither validates its dates.** Their signatures accept no `limit_start` / `limit_page_length`, and `frappe.get_list` is called with no limit: a request carrying `limit_start=390&limit_page_length=10` returned **all 400 rows / 176,813 B**, as did a request with no dates at all, a 1990–2090 range, and `from_date=not-a-date` (an unparseable date silently widens the query instead of failing). `get_linked_payments` with `limit_page_length=10` likewise returned all 120 candidates. `EXPLAIN` on the list query reports `type=ALL, key=NULL, rows=491, Using where; Using filesort`, and `tabBank Transaction` carries only two indexes — `PRIMARY(name)` and `creation` — so nothing covers `bank_account`, `docstatus`, `date` or `unallocated_amount`. | Bounded/cursor pagination and date validation on those endpoints, plus a composite index. Both are barred here: the bank DocType directories admit **additive whitelisted methods only**, and this change set makes **no schema change of any kind — no DocType JSON edit, no field, no migration, no index**. |
| 9 | `reconcile_vouchers` under concurrency | **Simultaneous confirm/post attempts against one transaction return low-level 5xx rather than an application answer.** Four POSTs fired at the same barrier produced **1 × HTTP 200 and 3 × HTTP 508 `QueryDeadlockError`**, MariaDB error 1020 *"Record has changed since last read in table 'tabJournal Entry'"*, raised from `bank_transaction.py:277 clear_linked_payment_entry` → `frappe.db.set_value`. **Data integrity held**: the final state was `status=Reconciled, allocated=1000.0, unallocated=0.0` with exactly **one** child row — no partial and no duplicate posting. The winner took 105 ms; the three losers 382 ms. | Per-transaction serialisation with a re-read after the lock, and mapping the record-changed conflict to a stable user-level response. Three separate boundaries stop it here: the 1020 → `QueryDeadlockError` → 508 mapping lives in the framework submodule, which is immutable; the contended write targets Journal Entry / Payment Entry, which are on the immutable component list; and an idempotency-key layer is a **formally rejected alternative** — ERPNext already implements state-based idempotency at the `unallocated_amount <= 0` guard. |
| 10 | `reconcile_vouchers` → `Bank Transaction.save()` | **The allocation and clearance pass runs twice per reconcile.** One single-voucher reconcile issued **33 SQL statements, 22 distinct, 11 duplicate executions**. The repeats are the pass itself: the total-allocated aggregate, the related-GL-entries query, the bank GL-account lookup, the `SELECT … FOR UPDATE` reload, the child-table reload and the status `UPDATE` each ran twice. The cause is visible in the code — `reconcile_vouchers` calls `add_payment_entries`, `validate_duplicate_references`, `allocate_payment_entries`, `update_allocated_amount` and `set_status` explicitly, and then `save()` re-runs four of the five through `before_update_after_submit`. | Making one lifecycle layer authoritative. That is a refactor of existing validation and posting logic, which this change set may not perform — and it is not a free deletion either: `before_update_after_submit` carries an in-code note that it is what enforces the currency rule on the submitted-document reconcile path, so removing either side changes enforcement. |
| 11 | `BankStatementImporter/CSV/StatementDetails.tsx` | **The import-log preview renders every row of the file, twice over, unvirtualised.** A 500-row statement materialised **11,282 DOM elements, 1,013 `<tr>`, 6,517 `<td>`, and zero `[data-index]`** — 22.6 elements and 13.0 cells per statement row, with 99.2% of the document being table content. The rows are *clipped*, not windowed: the parsed table is capped at `max-h-[400px]` while holding 16,635 px of content and the raw table pane holds 12,563 px, so ~11 rows are visible while all 1,001 are built, styled and laid out. Scrolling is then cheap — **zero style recalculation, zero layout, no task over 50 ms, ~62 fps** — because the DOM never mutates; the whole cost is paid once, up front. Mobile Lighthouse on that route: performance 28–55, LCP 16.1–18.5 s, TBT up to 1.69 s, main-thread work 3.0–4.0 s. | Virtualising or paginating both preview tables and isolating the progress state. The render tree of that component is preserved verbatim here, and row 2 above is the second obstacle: under jsdom a virtualised list renders zero rows, so the change would also invalidate the existing preview suites. |
| 12 | `pages/BankReconciliation.tsx` | **The unsupported-screen gate is CSS only, so a narrow viewport saves nothing.** Cold loads of `/banking` at 375 × 812 and at 1600 × 1000 cost **exactly the same 35 requests and exactly the same 2,672,310 bytes — a delta of zero** — including the full 176,813-byte / 400-row transaction payload, 1,394,268 B of JavaScript, a 345,588-byte font and a 246,293-byte stylesheet. The narrow viewport then displays **69 characters**: *"Banking / This screen is not supported on mobile devices. / Go to Desktop"* — about 38,700 downloaded bytes per visible character. The gated element's class attribute is identical at both widths (`p-4 flex-col gap-4 md:flex hidden`); only the computed `display` differs. It holds **262 descendants and 53,173 characters of never-painted markup**, and its own hidden text reads "400 results" and "Progress 0 / 400 reconciled" — so the subtree mounted, fetched and counted all 400 transactions before being hidden. | Turning the breakpoint into a real render and data guard, with the desktop app lazily loaded only once it passes. The desktop-only breakpoint behaviour of that page is **preserved unchanged** here, and the file carries no task in this change set. |
| 13 | `BankReconciliation/BankPicker.tsx`, `bankRecDateAtom` | **The statement-importer route downloads a transaction list it never renders, and downloads it twice.** A cold load of `/statement-importer` issued **two** `get_bank_transactions` calls ~4 ms apart for the same bank account but different windows — the current month (14 B, 0 rows) and the persisted range (**176,813 B, 400 rows**) — against a page rendering **0 tables, 0 rows and 0 occurrences** of any transaction reference, whose entire visible text is 644 characters. Two of that page's four API calls, and ~99.99% of its API bytes, are waste. Two causes: `BankPickerItem` mounts the fetching hook purely to obtain `mutate`, and `bankRecDateAtom` is persisted **without `getOnInit`** while its sibling `selectedBankAccountAtom` has it, so the bank hydrates synchronously and the dates one render tick later. The same late-hydration wave costs five superseded calls on `/banking` rather than one. | Obtaining `mutate` from `useSWRConfig()` instead of mounting the hook, and giving the date atom `getOnInit: true`. Neither file may change here: `BankPicker.tsx` carries no task in this change set, and `bankRecAtoms.ts` is confined to appending exactly the two atoms it appends, with all thirteen pre-existing atoms byte-identical. |
| 14 | `MatchAndReconcile.tsx` candidate virtualiser | **The candidate card has no single height, so its `estimateSize` constant cannot be right for every row.** Measured at a fixed viewport, a candidate card is **121.7969 px** when the voucher carries no party and **147.7969 px** when it does — exactly +26.000 px for the conditional party row. Against `estimateSize={121}` that means a scroll-range drift of **+120 px over 14,520 px (+0.83%)** in the first case and **14,871 → 17,760 px (+19.4%)** in the second, and the spacer never shrinks back. The transactions list is the control: its `estimateSize={74}` matches its real 74.0000 px row exactly and drifts not at all. Virtualisation is otherwise healthy in both cases — windowed at 12–23 of 120 rows, indices always contiguous, worst inter-row seam 0.204 px, no network traffic while scrolling. | A per-index estimator (≈148 px for a candidate with a party, ≈122 px without) rather than a scalar — which changes the shared `VirtualizedListBody` prop signature and both call sites. `estimateSize={121}` is preserved verbatim here. Note that raising the scalar to a flat 148 would be **wrong**: it would overstate every party-less candidate by 26 px and turn the drift into mirror-image shrinkage. |


### Dependencies

`yarn install --frozen-lockfile` passes against the committed lockfile, and **six advisories were
closed** with **no dependency-version change in `package.json`**. Five of the six were closed
**inside their existing declared range**, so they are lockfile-only; the sixth had no in-range fix
and required the [`ws` override](#ws--the-one-advisory-with-no-in-range-fix).

> **`yarn audit` is a live query, so treat its total as a reading rather than as a property of this
> lockfile.** It resolves the installed tree against the registry's advisory database *at the moment
> you run it*, and that database only grows. When the six re-resolutions below were made the audit
> reported **0 vulnerabilities across 582 packages**; re-running it later reports whatever has been
> published since. At the time of writing it exits **8** with **1 High** — advisory `1138115`
> against `js-yaml` `4.3.0`, reached through `eslint > @eslint/eslintrc > js-yaml`, patched in
> `>=4.3.1`. That is a **dev-only** path: `eslint`
> is a `devDependency` and nothing in it reaches the browser bundle. It is in range of the declared
> `^4.1.1`, so it is closable the same lockfile-only way as five of the six below — **as a dependency
> change set, not here.** What this section can honestly promise is the part that *is* a property of
> the lockfile: the six entries below are pinned where they are on purpose, and the `ws` override in
> particular must not be removed. A non-zero audit total is therefore not evidence that this lockfile
> has regressed; compare against the table before concluding anything.

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

#### The three things every install prints, none of which is a problem

Listed because two of them look like defects and one of them looks like a defect in *this* package.
A clean `yarn install` prints all three; `yarn install --frozen-lockfile` against an already-linked
tree prints the first two.

| Output | Where it comes from | Why it is expected |
| --- | --- | --- |
| `(node:…) [DEP0169] DeprecationWarning: url.parse() behavior is not standardized …` | Node, about Yarn Classic's own internals | Tooling-only, and nothing in this package calls `url.parse()`. Fixing it means migrating the package manager, which is a repository-wide governance decision. |
| `warning Resolution field "ws@8.21.2" is incompatible with requested version "ws@~8.17.1"` | Yarn, about the [`ws` override](#ws--the-one-advisory-with-no-in-range-fix) | The install-time twin of the `yarn check --verify-tree` error above, and the same definitional signature: an override that overrides a declared range **is** incompatible with it, which is the point. Silencing it means deleting the override and reopening two advisories. |
| `warning Workspaces can only be enabled in private projects.` | Yarn, about a **pre-existing transitive dependency** — `react-hotkeys-hook@5.3.3` declares `workspaces: ["packages/*"]` without `private: true` | Not about this workspace. This package is `"private": true` and declares no `workspaces` field, so nothing here can trigger it and nothing here can fix it; it is emitted while resolving somebody else's manifest. |


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


### Serving the built assets in production

The `build` output is static, and Frappe's own web server hands it to the browser. Serving it
**directly from the application origin** — gunicorn in production, Werkzeug in development — leaves
three things on the table that a reverse proxy or CDN in front of it is expected to supply. All
three were measured against a running site rather than assumed, and none of them is something this
workspace can configure: they are properties of the serving stack, and no file here is part of it.

**1. Nothing is compressed.** A request for the hashed entry chunk carrying
`Accept-Encoding: gzip, deflate, br` came back with **no `Content-Encoding` header at all** and
`Content-Length: 366924` — the same 367 kB the build reports as ~106 kB gzipped, so roughly 3.4× more
bytes than necessary. The same is true of the HTML document and of every JSON response: on a cold
load of `/banking` all 35 responses reported `encodedBodySize === decodedBodySize`, for a total of
**2,672,310 bytes**. Put Brotli or gzip in front of the origin.

**2. It is HTTP/1.1.** `curl` negotiates `http_version=1.1` against the origin. With 13 JavaScript
chunks plus CSS and a font on the critical path, HTTP/2 or HTTP/3 multiplexing is worth having.

**3. Content-hashed assets are cached for twelve hours, not forever.** Every file under
`assets/erpnext/banking/assets/` has a content hash in its name — `index-<hash>.js` — so its URL
changes whenever its bytes change and it can safely be cached indefinitely. The origin instead
returns `Cache-Control: max-age=43200, public` with a matching `Expires`, so a returning visitor
re-validates or re-downloads them every half day. Serve hashed assets with a long `max-age` and
`immutable`; keep the HTML document itself uncached, which the origin already does correctly
(`Cache-Control: no-store,no-cache,must-revalidate,max-age=0`).

**And one thing that *is* configurable from outside this workspace: the realtime port.**
`src/App.tsx` passes `socketPort={import.meta.env.VITE_SOCKET_PORT}` to `FrappeProvider`, and
`.env.production` defines only `VITE_BASE_NAME`. So `VITE_SOCKET_PORT` is `undefined` at build time
and `frappe-react-sdk` falls back to its hard-coded default — `this.socket_port = i ?? "9000"`. On a
bench whose `sites/common_site_config.json` sets `socketio_port` to anything other than 9000, the
SPA still dials **9000**. Two things are worth knowing about that: the value the SPA needs is already
available at runtime, because `frappe/boot.py` puts `socketio_port` into the boot payload whenever
site config sets it; and a mismatch is quiet rather than loud — the statement-import progress
channel simply never delivers, while every request-response feature keeps working. Until the port is
wired from boot rather than from a build-time variable, deployments that move `socketio_port` must
set `VITE_SOCKET_PORT` to the same value **before** running `build`.

`src/App.tsx` and `.env.production` are both frozen here — the application root is not modified by
this change set and it introduces no environment variable — so this section documents the behaviour
rather than changing it.

