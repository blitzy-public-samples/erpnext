# ERPNext Banking

The Bank Reconciliation single-page application. It is a React + TypeScript + Vite workspace that is
built into the ERPNext app and served by the host site, not deployed on its own.

The reviewer workflow it implements is: import a bank statement, review the match the rule engine
suggests, confirm it or link a different voucher by hand, and post the reconciliation. Every one of
those steps is a single call to an existing whitelisted Frappe method, and **the server's response is
the only source of truth** — nothing is written optimistically anywhere in this application.

## Where it lives at runtime

| Concern | Location |
| --- | --- |
| Route rule | `erpnext/hooks.py` (`website_route_rules`) |
| Page controller | `erpnext/www/banking.py` |
| Built assets | `erpnext/public/banking/` (git-ignored, produced by `yarn build`) |
| Host page | `erpnext/www/banking.html` (git-ignored, copied by `yarn build`) |
| Served at | `/banking` on the site |

The host page injects the CSRF token and the Frappe boot payload, so the application reads its user,
roles, permissions, system defaults and `locals` from `window.frappe` rather than fetching them.

## Requirements

- **Node.js 24 or newer.** `frappe`'s own `package.json` declares `engines.node >= 24`, the CI images
  are pinned to Node 24, and `jsdom` 30 — used by the test run — requires `^22.22.2 || ^24.15.0 ||
  >=26`.
- **Yarn 1 (Classic).** The committed lockfile is a v1 lockfile; installing with a different package
  manager will not respect it.

```bash
yarn install --frozen-lockfile
```

## Scripts

| Script | What it does | Needs a bench? |
| --- | --- | --- |
| `yarn dev` | Vite dev server on port 8080, proxying `/api`, `/app`, `/assets`, `/files` and `/private` to the site | **Yes** |
| `yarn build` | Builds into `../erpnext/public/banking` with base `/assets/erpnext/banking/`, then copies the HTML entry to `../erpnext/www/banking.html` | **Yes** |
| `yarn preview` | Serves the last build locally | No |
| `yarn typecheck` | `tsc -b` — the project references build, with no emit | No |
| `yarn lint` | `eslint .` over the whole workspace | No |
| `yarn test` | `vitest run` — one non-watch pass | **No** |
| `yarn test:coverage` | `vitest run --coverage` — the same pass, with the coverage gate enforced | **No** |

`yarn typecheck` exists because `yarn build` does **not** type-check: Vite transpiles without running
the type-checker, so a type error is invisible to the build. Run both.

### The bench prerequisite, and why `test` does not share it

`dev` and `build` load `vite.config.ts`, which imports `proxyOptions.ts`, which reads
`../../../sites/common_site_config.json` **at module scope** to discover the site's web-server port.
That path resolves to a Frappe Bench `sites` directory *above* the repository checkout. Without it,
both scripts fail immediately with `ENOENT`:

```
../../../sites/common_site_config.json
```

Point the checkout's parent directory at a bench (a symlink is enough) or run these scripts from
inside a bench, and both work.

`yarn test` and `yarn test:coverage` have **no such requirement**, and that is deliberate. Vitest
loads `vitest.config.ts`, which takes precedence over `vite.config.ts` and completely replaces it —
it re-declares the React and Tailwind plugins and the `@` alias itself rather than extending the Vite
config, specifically so that the test run never imports `proxyOptions.ts`. The suite therefore passes
in a bare checkout with no bench, no site and no database, which is what lets it run in CI.

## Tests

`jsdom` environment, `globals: true`, with `src/test/setup.ts` registered as the setup file. That
harness reproduces the slice of the Frappe Desk runtime the application reads — a non-`Guest` boot
user with `System Manager` and the accounting roles, the permission arrays, system defaults, the
`locals` company and currency records, plus `matchMedia` and `ResizeObserver`, which jsdom does not
provide. `src/test/factories.ts` supplies fixture builders shaped by the real endpoint payloads and
one shared `frappe-react-sdk` mock, so no suite hand-rolls its own module mock.

Test files live beside the code they cover, as `*.test.ts` / `*.test.tsx`.

```bash
yarn test                 # one pass, no watch mode
yarn test:coverage        # the same pass, with the coverage gate
```

### Coverage

`test:coverage` uses the V8 provider and **fails the process** when any gated unit falls below 80%
line coverage. It writes three reporters:

- a text summary to the terminal;
- `coverage/coverage-summary.json`, the machine-readable totals;
- `coverage/lcov.info`, which is the file coverage services consume.

The gate is applied **per unit, not as one average**. The units gated at 80% lines are the
reconciliation API-client layer and state store (`BankReconciliation/utils.ts`, `bankRecAtoms.ts`),
the surfaces the reconciliation and import workflow is driven through (`MatchAndReconcile.tsx`,
`BankBalance.tsx`, `BankRecErrorDialog.tsx`, `BankStatementImporter/CSV/StatementDetails.tsx`,
`pages/BankStatementImporter.tsx`) and the shared helpers they resolve errors, companies and
currencies through (`lib/frappe.ts`, `lib/company.ts`, `lib/currency.ts`). Each has to clear 80% on
its own — an average could hide a new module at 20% behind easier files, a per-unit gate cannot.

Everything else in `src/` is still **measured and reported** (the whole-application figure is printed
by the text reporter) but is not gated: those files predate this work and have no suite of their own.
If you add a component or an API-client module, add it to `thresholds` in `vitest.config.ts` as well.

`coverage/` is generated output. It is not committed, and it is not excluded from ESLint either, so
run `rm -rf coverage` before `yarn lint` if you want a clean lint run after a coverage run.

## The `resolutions` entry is required — do not delete it

`package.json` carries:

```json
"resolutions": { "vitest/vite": "8.1.2" }
```

Without it, **`yarn install` fails outright** — not with a warning, but with an invariant violation
saying Yarn could not find a copy of Vite to link inside `node_modules/vitest/node_modules`. The
cause is that Vitest 4.1.x declares `vite` in both `dependencies` and non-optional
`peerDependencies`, which Yarn Classic cannot reconcile, so it tries to link a nested private copy
that was never fetched. There is no version escape: the 4.1 line is the only Vitest line that
supports Vite 8, and this workspace is on Vite 8.

The pinned value is exactly what the lockfile already resolves for the declared Vite range, so the
override changes nothing about the resolved dependency graph — it only tells Yarn what it could not
work out for itself.
