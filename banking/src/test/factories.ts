/**
 * Typed fixture builders and the ONE shared `frappe-react-sdk` module mock for the
 * ERPNext Banking SPA's Vitest suites.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────────────
 * Every suite under `src/**` needs the same three things: bank-reconciliation records
 * shaped exactly as the server returns them, Frappe error envelopes shaped exactly as
 * the server raises them, and a stand-in for the Frappe SDK. Hand-rolling any of those
 * per suite is how fixtures drift away from the contracts they are supposed to model,
 * and a fixture that misreports a field NAME or a payload SHAPE silently invalidates
 * every assertion built on it. So all three live here, once.
 *
 * ─── The governing rule: derive, never invent ────────────────────────────────────────
 * The existing backend contract is authoritative for API shapes, field names and
 * method signatures. Accordingly, EVERY default below was read off a specific line of
 * this repository, and each is annotated with that `file:line`. Three consequences are
 * worth stating up front, because they look like omissions until you know why:
 *
 *   • `UnreconciledTransaction` carries exactly the FIFTEEN fields the endpoint's
 *     `Pick` names (`BankReconciliation/utils.ts:84`) — not fourteen, not sixteen.
 *   • `BankStatementImportLog.status` has exactly TWO values
 *     (`types/Accounts/BankStatementImportLog.ts:19`). There is no `Error` value and no
 *     error field anywhere on that DocType, which is precisely why the per-file failure
 *     indicator is driven from a session-scoped atom instead of from the document. No
 *     third value is invented here.
 *   • No fixture describes a Plaid interface, a currency conversion or a client-side
 *     deduplication rule, because no such behaviour exists to model.
 *
 * ─── Coupling to the harness ─────────────────────────────────────────────────────────
 * `src/test/setup.ts` seeds `boot.user.defaults.company = 'Test Company'`,
 * `locals[':Company']['Test Company']` and `locals[':Currency']` entries for `INR` and
 * `USD`. The identity constants in §1 restate those values so a builder and the harness
 * cannot drift: a company name that is not a `locals[':Company']` key makes
 * `getCompanyCurrency()` return `undefined` silently (`src/lib/company.ts:4`), and a
 * currency that is not a `locals[':Currency']` key makes `formatCurrency()` fall back.
 *
 * ─── Why this file is `.ts` and not `.tsx` ───────────────────────────────────────────
 * It is a fixture module, not a component module. The one element it must produce — the
 * `FrappeProvider` pass-through in §8 — is built with `createElement`, so no JSX syntax
 * is needed and the filename stays `factories.ts`.
 *
 * ─── Two properties of the Vitest wiring that shape this file ────────────────────────
 *   1. `vitest.config.ts` excludes `src/test/**` from coverage, so nothing here inflates
 *      or dilutes the measured percentage. This file's job is to help OTHER files reach
 *      the threshold.
 *   2. Its name does not match the `src/**\/*.{test,spec}.{ts,tsx}` glob, so it is never
 *      collected as a suite.
 *
 * ─── Style notes ─────────────────────────────────────────────────────────────────────
 * Every builder takes a `Partial<T>` of overrides and spreads it LAST, so a caller can
 * always replace any default — including replacing it with `undefined`. Return types are
 * annotated with the real application types, which is what makes "never invent a field"
 * mechanically enforced by `tsc -b` rather than merely promised: adding a sixteenth
 * field or misspelling an existing one is a compile error, not a silent lie.
 */

// `vitest.config.ts` sets `globals: true`, which exposes the Vitest API at RUNTIME but
// does not TYPE it — `tsconfig.app.json` declares no `types` array, and adding one is out
// of bounds. So `vi` must be imported explicitly.
import { vi } from 'vitest'

// `createElement` + `Fragment` build the `FrappeProvider` pass-through (§8) without JSX;
// `createContext` builds the real `FrappeContext` the SPA consumes with `useContext`.
// `ReactNode` is imported explicitly rather than reached through the `React` UMD global,
// which modules may not rely on.
import { createContext, createElement, Fragment, type ReactNode } from 'react'

import type { LinkedPayment, UnreconciledTransaction } from '@/components/features/BankReconciliation/utils'
import type { SelectedBank } from '@/components/features/BankReconciliation/bankRecAtoms'
import type { BankTransaction } from '@/types/Accounts/BankTransaction'
import type { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'
import type { FrappeError } from 'frappe-react-sdk'

/* ═══ 1. Shared fixture identity ══════════════════════════════════════════════════════
 * Exported so a suite never has to restate a literal that must agree with the harness or
 * with a sibling builder. Every value that must match `src/test/setup.ts` says so.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/**
 * Must equal `setup.ts`'s `TEST_COMPANY`, which is used as BOTH
 * `boot.user.defaults.company` and the `locals[':Company']` key. `src/lib/company.ts:4`
 * looks the company up in `locals` by name, so any other value resolves to `undefined`.
 */
export const TEST_COMPANY = 'Test Company'

/** The harness system default, and a registered `locals[':Currency']` key (symbol `₹`). */
export const TEST_CURRENCY = 'INR'

/**
 * The second registered `locals[':Currency']` key (symbol `$`). Pairing this with
 * {@link TEST_CURRENCY} is what makes a currency mismatch observable: the transaction row
 * resolves its effective currency as
 * `transaction.currency ?? selectedBank?.account_currency ?? getCompanyCurrency(...)`
 * (`MatchAndReconcile.tsx:336`), so a `USD` transaction against an `INR` account differs
 * at the first term.
 */
export const TEST_ALTERNATE_CURRENCY = 'USD'

/** `setup.ts`'s boot user — the owner recorded on every document fixture. */
export const TEST_USER = 'Administrator'

/** `Bank Account.name`; also every fixture's `bank_account` link target. */
export const TEST_BANK_ACCOUNT = 'Test Bank - Test Company'

/** `Bank Account.bank` — a `Bank` link. */
export const TEST_BANK = 'Test Bank'

/** `Bank Account.account` — the Chart-of-Accounts account the bank account posts to. */
export const TEST_BANK_LEDGER_ACCOUNT = 'Test Bank - TC'

/** `Bank Transaction Rule.name`; the value stamped into `matched_transaction_rule`. */
export const TEST_TRANSACTION_RULE = 'BTR-0001'

/**
 * The transaction date shared by the base transaction and the suggested voucher.
 * `isSuggested` compares dates for EQUALITY (`MatchAndReconcile.tsx:846-847`), so this
 * shared constant is what makes the suggestion deterministic rather than coincidental.
 */
export const TEST_TRANSACTION_DATE = '2024-01-15'

/** A date deliberately unequal to {@link TEST_TRANSACTION_DATE}, for the override voucher. */
export const TEST_ALTERNATE_DATE = '2024-01-09'

/**
 * The base transaction's amount AND unallocated amount. `isSuggested` compares
 * `voucher.paid_amount === transaction.unallocated_amount`
 * (`MatchAndReconcile.tsx:845`), so the suggested voucher reuses this exact number.
 */
export const TEST_TRANSACTION_AMOUNT = 12500

/** An amount deliberately unequal to {@link TEST_TRANSACTION_AMOUNT}. */
export const TEST_ALTERNATE_AMOUNT = 8750

/**
 * The base transaction's `reference_number` and the suggested voucher's `reference_no`,
 * so they form a FULL reference match (`MatchAndReconcile.tsx:848`).
 *
 * NEVER make a `reference_no` empty. `referenceMatchesPartial`
 * (`MatchAndReconcile.tsx:850`) is `transaction.reference_number?.includes(reference_no)`,
 * and `String.prototype.includes('')` is ALWAYS `true` — an empty value would make every
 * voucher a partial match and make `isSuggested` non-deterministic.
 */
export const TEST_REFERENCE_NUMBER = 'NEFT/2024/000145'

/**
 * The override voucher's `reference_no`. Chosen so it is NOT a substring of
 * {@link TEST_REFERENCE_NUMBER} or of the base transaction's description — otherwise
 * `referenceMatchesPartial` would be true and the override voucher would read as a
 * partial match instead of "No Match".
 */
export const TEST_ALTERNATE_REFERENCE_NUMBER = 'JV-ADJ-2024-0007'

/** `Bank Transaction.description`. Non-empty: the row renders it and the search indexes it. */
export const TEST_TRANSACTION_DESCRIPTION = 'NEFT credit from ACME Traders'

/** A `Frappe` datetime, microsecond-precision — the format `creation`/`modified` carry. */
export const TEST_CREATION_TIMESTAMP = '2024-01-15 10:30:00.000000'

/** A `modified` stamp strictly later than {@link TEST_CREATION_TIMESTAMP}. */
export const TEST_MODIFIED_TIMESTAMP = '2024-01-15 10:31:12.000000'

/* ═══ 2. Bank transactions ════════════════════════════════════════════════════════════
 * `UnreconciledTransaction` (`BankReconciliation/utils.ts:84`) is a `Pick` over EXACTLY
 * fifteen `BankTransaction` fields:
 *
 *   name · matched_transaction_rule · date · withdrawal · deposit · currency ·
 *   description · status · transaction_type · reference_number · party_type · party ·
 *   bank_account · company · unallocated_amount
 *
 * `status` AND `unallocated_amount` are both in that set — which is exactly why the
 * client-side already-reconciled guard needs no new data and no backend change.
 *
 * Only `name` is required (`types/Accounts/BankTransaction.ts:4`); the other fourteen are
 * optional. All fifteen are nonetheless written out explicitly below, so the "exactly
 * fifteen" property is auditable by reading the builder.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/**
 * Builds an ordinary unreconciled DEPOSIT row: the default state of a freshly imported
 * bank transaction awaiting review.
 *
 * `useIsTransactionWithdrawal` (`utils.ts:350-361`) picks the displayed amount as
 * `withdrawal > 0 ? withdrawal : deposit`, so exactly one of the two is positive here.
 * For a withdrawal row, override both:
 * `makeUnreconciledTransaction({ withdrawal: 900, deposit: 0 })`.
 *
 * `matched_transaction_rule` is explicitly `undefined` rather than omitted, so that all
 * fifteen picked fields appear in one place. The row's violet rule badge is gated on its
 * truthiness (`MatchAndReconcile.tsx:366`), so an unstamped row renders no badge.
 */
export const makeUnreconciledTransaction = (
	overrides: Partial<UnreconciledTransaction> = {}
): UnreconciledTransaction => ({
	name: 'ACC-BTN-2024-00001',
	matched_transaction_rule: undefined,
	date: TEST_TRANSACTION_DATE,
	withdrawal: 0,
	deposit: TEST_TRANSACTION_AMOUNT,
	currency: TEST_CURRENCY,
	description: TEST_TRANSACTION_DESCRIPTION,
	status: 'Unreconciled',
	transaction_type: 'NEFT',
	reference_number: TEST_REFERENCE_NUMBER,
	party_type: 'Customer',
	party: 'ACME Traders',
	bank_account: TEST_BANK_ACCOUNT,
	company: TEST_COMPANY,
	unallocated_amount: TEST_TRANSACTION_AMOUNT,
	...overrides
})

/**
 * A transaction the rule engine has already matched — the fixture behind the
 * rule-suggested-match scenario.
 *
 * `MatchAndReconcile.tsx:366-369` renders `matched_transaction_rule` as the TEXT of a
 * violet badge titled "Matched by rule", so a suite asserts on the rule NAME appearing
 * in the row.
 */
export const makeRuleMatchedTransaction = (
	overrides: Partial<UnreconciledTransaction> = {}
): UnreconciledTransaction =>
	makeUnreconciledTransaction({
		name: 'ACC-BTN-2024-00002',
		matched_transaction_rule: TEST_TRANSACTION_RULE,
		...overrides
	})

/**
 * A transaction the server considers FULLY RECONCILED — the fixture behind the
 * already-reconciled guard.
 *
 * Both signals are set, and both are load-bearing. The server derives `status` purely
 * from `docstatus` and `unallocated_amount`, and its posting guard is
 * `if 0.0 >= self.unallocated_amount: throw` — so `status === 'Reconciled'` holds exactly
 * when `unallocated_amount <= 0`. A fixture setting only one of the two would model a
 * state the server can never produce.
 *
 * Such rows DO reach the UI today: the "Bank Transactions" tab requests the unfiltered
 * set with `all_transactions: true` (`utils.ts:120`), bypassing the server-side filter
 * that would otherwise exclude them.
 */
export const makeReconciledTransaction = (
	overrides: Partial<UnreconciledTransaction> = {}
): UnreconciledTransaction =>
	makeUnreconciledTransaction({
		name: 'ACC-BTN-2024-00003',
		status: 'Reconciled',
		unallocated_amount: 0,
		...overrides
	})

/**
 * A transaction denominated in {@link TEST_ALTERNATE_CURRENCY} — the fixture behind the
 * non-blocking currency-mismatch advisory. Pair it with a {@link makeSelectedBank} whose
 * `account_currency` is {@link TEST_CURRENCY}.
 *
 * The indicator is advisory ONLY and must not disable confirming: the server is the
 * authority, and its currency validation raises on save, so the rejection surfaces
 * through the same dismissible-dialog path as any other backend refusal.
 */
export const makeCurrencyMismatchTransaction = (
	overrides: Partial<UnreconciledTransaction> = {}
): UnreconciledTransaction =>
	makeUnreconciledTransaction({
		name: 'ACC-BTN-2024-00004',
		currency: TEST_ALTERNATE_CURRENCY,
		...overrides
	})

/**
 * Builds a COMPLETE `Bank Transaction` document, as distinct from the fifteen-field
 * projection above.
 *
 * Needed because `useReconcileTransaction` is
 * `useFrappePostCall<{ message: BankTransaction }>(…)` (`utils.ts:223`) and its success
 * handler passes `res.message` on to the action log — whose `ActionLogItem.bankTransaction`
 * is typed as a full `BankTransaction` (`bankRecAtoms.ts:70`) — and to
 * `onReconcileTransaction`, which reads `updatedTransaction.unallocated_amount`
 * (`utils.ts:169`). Without this builder, every reconcile-success suite would invent its
 * own document.
 *
 * Defaults model the response to a SUCCESSFUL full reconciliation: `docstatus: 1`
 * (the endpoint only ever returns submitted rows), `status: 'Reconciled'`,
 * `allocated_amount` equal to the transaction value and `unallocated_amount: 0`. That
 * zero drives `onReconcileTransaction` down its "advance to the next transaction" branch
 * (`utils.ts:169`); for the partial-allocation branch, override
 * `{ unallocated_amount: 2500, status: 'Unreconciled' }`.
 *
 * `naming_series` is a REQUIRED literal-typed field (`BankTransaction.ts:15`), so it can
 * only ever hold the one value below.
 */
export const makeBankTransaction = (overrides: Partial<BankTransaction> = {}): BankTransaction => ({
	name: 'ACC-BTN-2024-00001',
	creation: TEST_CREATION_TIMESTAMP,
	modified: TEST_MODIFIED_TIMESTAMP,
	owner: TEST_USER,
	modified_by: TEST_USER,
	docstatus: 1,
	naming_series: 'ACC-BTN-.YYYY.-',
	date: TEST_TRANSACTION_DATE,
	status: 'Reconciled',
	bank_account: TEST_BANK_ACCOUNT,
	company: TEST_COMPANY,
	deposit: TEST_TRANSACTION_AMOUNT,
	withdrawal: 0,
	currency: TEST_CURRENCY,
	description: TEST_TRANSACTION_DESCRIPTION,
	reference_number: TEST_REFERENCE_NUMBER,
	transaction_type: 'NEFT',
	party_type: 'Customer',
	party: 'ACME Traders',
	allocated_amount: TEST_TRANSACTION_AMOUNT,
	unallocated_amount: 0,
	is_rule_evaluated: 1,
	...overrides
})

/* ═══ 3. The selected bank account ════════════════════════════════════════════════════
 * `SelectedBank` (`bankRecAtoms.ts:11-17`) is a `Pick` over eleven `Bank Account` fields
 * plus five of its own: `logo`, `logoDark`, `darkModeInvert`, `logoClassName` and
 * `account_currency`.
 *
 * Within that `Pick`, THREE members are non-optional — `name`, `bank` and `account_name`
 * (`types/Accounts/BankAccount.ts:3,18,14`) — so the builder must always supply them.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/**
 * Builds the bank account held in `selectedBankAccountAtom`.
 *
 * `account_currency` deserves the emphasis: it is NOT a native `Bank Account` field —
 * it appears nowhere in `types/Accounts/BankAccount.ts`. The `bank_account.get_list`
 * endpoint derives it at query time by following `Bank Account.account` to
 * `Account.account_currency`, which is exactly why `BankAccountWithCurrency` types it as
 * OPTIONAL (`utils.ts:283-285`) and why `SelectedBank` does too. It defaults to
 * {@link TEST_CURRENCY} here so the currency-mismatch predicate has something to compare
 * against; override it to model an account whose currency the endpoint could not resolve.
 *
 * Because the server resolves the currency it validates against through that SAME lookup,
 * a client-side indicator built on this field cannot disagree with the server.
 *
 * `is_credit_card` and `is_default` are Frappe `Check` fields, typed `0 | 1`
 * (`BankAccount.ts:44,26`) — numeric flags, never `false`/`true`.
 *
 * The four logo members are deliberately left unset. `useGetBankAccounts` attaches them
 * by keyword-matching the bank name against `BANK_LOGOS` (`utils.ts:290-306,324-332`),
 * and none of that table's 121 keywords occurs in {@link TEST_BANK} — verified, not
 * assumed — so `undefined` is the honest result for this fixture rather than an omission.
 *
 * ─── Building one is not enough: the atom must be HYDRATED ────────────────────────────
 * `MatchAndReconcile` reads `selectedBankAccountAtom` and EARLY-RETURNS an empty state
 * when it is null (`MatchAndReconcile.tsx:41-43`, "Select a bank account to reconcile"),
 * so a suite that renders the workbench without seeding the atom sees no transaction rows
 * at all — however well its endpoint mocks are set up. `selectedBankAccountAtom` is an
 * `atomWithStorage` with `getOnInit: true` (`bankRecAtoms.ts:18-20`), so it latches its
 * value at module load and writing to `localStorage` afterwards has no effect. Seed it
 * through a jotai store instead, and render inside that store's `Provider`:
 *
 *     const store = createStore()
 *     store.set(selectedBankAccountAtom, makeSelectedBank())
 *     render(<Provider store={store}>…</Provider>)
 *
 * Verified by reproduction: without the seed the workbench renders only the empty state.
 *
 * ─── And hydration alone is STILL not enough: give elements real dimensions ───────────
 * Once the atom is seeded the workbench mounts and the filter counter correctly reports
 * "1 result", yet the transaction ROW still does not render. `VirtualizedListBody`
 * (`MatchAndReconcile.tsx:73-123`) drives the list through `@tanstack/react-virtual`, and
 * `virtual-core`'s `getRect` measures its scroll container with `offsetWidth`/`offsetHeight`
 * SPECIFICALLY (`@tanstack/virtual-core/dist/esm/index.js:14-17`) — not
 * `getBoundingClientRect`, not `clientHeight`. jsdom hard-codes both `offset*` properties to
 * `0`, so the virtualizer sees a zero-height viewport, computes an empty range and renders
 * nothing. `setup.ts` installs a no-op `ResizeObserver`, so no later measurement rescues it.
 *
 * Any suite asserting on rows inside a virtualized list must therefore stub those two
 * getters before rendering:
 *
 *     vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(900)
 *     vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600)
 *
 * Verified by reproduction in both directions: with only `getBoundingClientRect` and
 * `clientHeight`/`clientWidth` stubbed the row never appears; adding the two `offset*`
 * getters makes it render. Restore the spies in `afterEach` — `setup.ts`'s own `afterEach`
 * only calls `cleanup()` and clears storage, it does NOT reset mocks.
 */
export const makeSelectedBank = (overrides: Partial<SelectedBank> = {}): SelectedBank => ({
	name: TEST_BANK_ACCOUNT,
	bank: TEST_BANK,
	account_name: 'Test Bank Current Account',
	account: TEST_BANK_LEDGER_ACCOUNT,
	account_type: 'Bank',
	bank_account_no: '000123456789',
	company: TEST_COMPANY,
	is_credit_card: 0,
	is_default: 1,
	// Set only for bank accounts linked to an external banking integration. This fixture
	// models a manually maintained account, and no integration UI is in scope.
	integration_id: undefined,
	last_integration_date: undefined,
	account_currency: TEST_CURRENCY,
	...overrides
})

/* ═══ 4. Candidate vouchers ═══════════════════════════════════════════════════════════
 * `LinkedPayment` (`utils.ts:100-111`) is what `get_linked_payments` returns. EIGHT of
 * its ten members are REQUIRED — `rank`, `doctype`, `name`, `paid_amount`,
 * `reference_no`, `reference_date`, `posting_date` and `currency`; only `party_type` and
 * `party` are optional. `rank` is the one most easily forgotten, and omitting it is a
 * compile error under `strict`.
 *
 * The suggestion predicate, verbatim from `MatchAndReconcile.tsx:845-853`:
 *
 *   amountMatches            = voucher.paid_amount   === transaction.unallocated_amount
 *   postingDateMatches       = voucher.posting_date  === transaction.date
 *   referenceDateMatches     = voucher.reference_date === transaction.date
 *   referenceMatchesFull     = voucher.reference_no  === transaction.reference_number
 *                              || voucher.reference_no === transaction.description
 *   referenceMatchesPartial  = transaction.reference_number?.includes(voucher.reference_no)
 *                              || transaction.description?.includes(voucher.reference_no)
 *   isSuggested = amountMatches
 *                 && (postingDateMatches || referenceDateMatches || referenceMatchesPartial)
 *                 && index === 0
 *
 * Note the `index === 0` term: a voucher is only ever "suggested" when rendered FIRST.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/**
 * Builds a candidate voucher. Defaults describe a `Payment Entry` that lines up with
 * {@link makeUnreconciledTransaction} on amount, posting date, reference date and
 * reference number — so at list index 0 it satisfies `isSuggested`.
 *
 * `reference_no` is non-empty in every default and every variant, and must stay that way:
 * `referenceMatchesPartial` calls `String.prototype.includes(reference_no)`, and
 * `includes('')` is always `true`, which would make every voucher a partial match.
 */
export const makeLinkedPayment = (overrides: Partial<LinkedPayment> = {}): LinkedPayment => ({
	rank: 1,
	doctype: 'Payment Entry',
	name: 'ACC-PAY-2024-00001',
	paid_amount: TEST_TRANSACTION_AMOUNT,
	reference_no: TEST_REFERENCE_NUMBER,
	reference_date: TEST_TRANSACTION_DATE,
	posting_date: TEST_TRANSACTION_DATE,
	party_type: 'Customer',
	party: 'ACME Traders',
	currency: TEST_CURRENCY,
	...overrides
})

/**
 * Builds the voucher that a given transaction SUGGESTS, by copying the four fields the
 * predicate compares straight off that transaction.
 *
 * Deriving rather than restating is the point: a suite pairing
 * `makeUnreconciledTransaction()` with `makeLinkedPayment()` is only suggested because
 * their literals happen to agree, whereas this helper is suggested BY CONSTRUCTION for
 * any transaction — including one whose amount or date a suite has overridden.
 *
 * `reference_no` falls back with `||`, not `??`, on purpose: a transaction carrying an
 * EMPTY `reference_number` must not produce an empty `reference_no` (see the `includes('')`
 * trap above), and `??` would happily propagate `''`.
 *
 * Still subject to `index === 0` — this must be the first voucher rendered.
 */
export const makeSuggestedLinkedPayment = (
	transaction: UnreconciledTransaction,
	overrides: Partial<LinkedPayment> = {}
): LinkedPayment =>
	makeLinkedPayment({
		rank: 1,
		paid_amount: transaction.unallocated_amount ?? TEST_TRANSACTION_AMOUNT,
		posting_date: transaction.date ?? TEST_TRANSACTION_DATE,
		reference_date: transaction.date ?? TEST_TRANSACTION_DATE,
		reference_no: transaction.reference_number || TEST_REFERENCE_NUMBER,
		currency: transaction.currency ?? TEST_CURRENCY,
		party_type: transaction.party_type ?? 'Customer',
		party: transaction.party ?? 'ACME Traders',
		...overrides
	})

/**
 * Builds a DIFFERENT voucher — the one a reviewer picks when manually overriding the
 * suggestion. It is a `Journal Entry` rather than a `Payment Entry`, at `rank: 2`, and it
 * disagrees with {@link makeUnreconciledTransaction} on every compared field:
 *
 *   • `paid_amount` differs        ⇒ `amountMatches` false ⇒ `isSuggested` false
 *   • `posting_date`/`reference_date` differ ⇒ neither date term holds
 *   • `reference_no` is neither equal to nor a SUBSTRING of the base transaction's
 *     reference number or description ⇒ both reference terms false ⇒ the row reads
 *     "No Match" (`MatchAndReconcile.tsx:916-917`) rather than "Partial Match"
 *
 * Reconciling against this voucher still posts through the same single, atomic server
 * call as accepting the suggestion — the override changes WHICH voucher is linked, not
 * how the posting happens.
 */
export const makeAlternateLinkedPayment = (overrides: Partial<LinkedPayment> = {}): LinkedPayment =>
	makeLinkedPayment({
		rank: 2,
		doctype: 'Journal Entry',
		name: 'ACC-JV-2024-00001',
		paid_amount: TEST_ALTERNATE_AMOUNT,
		reference_no: TEST_ALTERNATE_REFERENCE_NUMBER,
		reference_date: TEST_ALTERNATE_DATE,
		posting_date: TEST_ALTERNATE_DATE,
		party_type: 'Supplier',
		party: 'Globex Supplies',
		...overrides
	})

/* ═══ 5. Statement import logs ════════════════════════════════════════════════════════
 * `BankStatementImportLog` (`types/Accounts/BankStatementImportLog.ts`) declares 29
 * properties, EIGHT of them required: `name`, `creation`, `modified`, `owner`,
 * `modified_by`, `docstatus`, `bank_account` and `file`.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/**
 * Builds a statement import log row.
 *
 * `status` has exactly TWO values — `"Not Started" | "Completed"`
 * (`BankStatementImportLog.ts:19`) — and the DocType carries NO error field of any kind.
 * The import runs synchronously and rolls back on failure, so on failure the status
 * simply never advances and nothing is persisted. That is the whole reason the per-file
 * failure indicator is driven from {@link makeImportFailures} rather than from the
 * document, and it is why no third status value is invented here.
 *
 * Defaults populate every field the importer list requests
 * (`pages/BankStatementImporter.tsx:223`): `name`, `file`, `status`,
 * `number_of_transactions`, `start_date`, `end_date`, `closing_balance`, `creation` —
 * plus the remaining required members and `currency`.
 *
 * `file` MUST contain a slash: the row renders `item.file.split('/').pop()`
 * (`BankStatementImporter.tsx:275`) as the displayed file name.
 *
 * `name` is a random hash and `docstatus` is `0` because the DocType uses
 * `"autoname": "hash"` with `"naming_rule": "Random"` and is not submittable — verified
 * against `bank_statement_import_log.json`.
 *
 * For the not-yet-run state, override `{ status: 'Not Started', number_of_transactions: 0 }`.
 */
export const makeBankStatementImportLog = (
	overrides: Partial<BankStatementImportLog> = {}
): BankStatementImportLog => ({
	name: 'a1b2c3d4e5',
	creation: TEST_CREATION_TIMESTAMP,
	modified: TEST_MODIFIED_TIMESTAMP,
	owner: TEST_USER,
	modified_by: TEST_USER,
	docstatus: 0,
	bank_account: TEST_BANK_ACCOUNT,
	file: '/files/statement.csv',
	status: 'Completed',
	currency: TEST_CURRENCY,
	number_of_transactions: 24,
	start_date: '2024-01-01',
	end_date: '2024-01-31',
	closing_balance: 152300.75,
	...overrides
})

/* ═══ 6. Frappe error envelopes ═══════════════════════════════════════════════════════
 * `getErrorMessages` (`src/lib/frappe.ts:20-69`) is the single code path through which
 * every backend refusal reaches the user, and `ErrorBanner` renders whatever it returns
 * (`src/components/ui/error-banner.tsx:34-47`). It resolves in a fixed ORDER, and each
 * step is reachable only if the previous one produced nothing:
 *
 *   1. `:22`     `_server_messages` is JSON-parsed into an array.
 *   2. `:23-34`  each ELEMENT is JSON-parsed too, falling back to the raw element.
 *   3. `:36-44`  if `_error_message` is truthy it is APPENDED (this step is additive, and
 *                runs even when step 1 already produced messages).
 *   4. `:46-58`  only if still empty: the text after the first colon of `exception`.
 *   5. `:59-65`  only if still empty: the bare `message`.
 *
 * Step 4 hides two quirks that these fixtures make testable, because `if (indexOfFirstColon)`
 * is a TRUTHINESS test rather than a `>= 0` test:
 *
 *   • a colon at index 0 yields `0`, which is FALSY — so the whole step is SKIPPED and
 *     resolution falls through to step 5;
 *   • no colon at all yields `-1`, which is TRUTHY — so `slice(-1 + 1)` returns the WHOLE
 *     exception string.
 *
 * Two typing notes. `_error_message` is NOT a member of the public `FrappeError` type,
 * which is why the production code reaches it behind `ts-expect-error` at `frappe.ts:36,39`;
 * here the envelope is built as a plain object and cast EXACTLY ONCE, which keeps this
 * file free of `ts-expect-error` and therefore free of any risk of an orphaned directive.
 * And `FrappeError` itself requires `httpStatus`, `httpStatusText`, `message` and
 * `exception` — verified in `frappe-js-sdk/lib/frappe_app/types.d.ts` — so every fixture
 * supplies all four.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/**
 * The literal object Frappe encodes into each `_server_messages` element, restricted to
 * the three keys the client actually reads. Frappe also transmits `raise_exception` on a
 * thrown message; it is omitted because nothing in this SPA looks at it.
 *
 * Declared locally and deliberately NOT exported. `frappe.ts:3-7` keeps its own
 * `ParsedErrorMessage` private and `error-banner.tsx:14-18` declares a second private
 * copy, so there is no shared type to reuse and none is published here — suites assert
 * on parsed messages STRUCTURALLY.
 */
type ServerMessagePayload = {
	message: string
	title?: string
	indicator?: string
}

/**
 * The wire shape of a Frappe error response. Mirrors the SDK's exported error type and
 * adds the `_error_message` key the SDK's type omits but the server sometimes sends.
 * Local and unexported: it exists to type this file's builders, not to be imported.
 */
type FrappeErrorPayload = {
	httpStatus: number
	httpStatusText: string
	message: string
	exception: string
	exc?: string
	exc_type?: string
	_server_messages?: string
	_error_message?: string
}

/**
 * Encodes one server message the way Frappe actually transmits it: DOUBLE-ENCODED — a
 * JSON array whose element is itself a JSON string. `getErrorMessages` parses the outer
 * array at `frappe.ts:22` and then parses the element at `:23-34`, so a fixture that
 * encoded only once would arrive as a raw string and take the `catch` branch instead.
 *
 * A single element is the faithful shape for a `frappe.throw`, which raises exactly one
 * message.
 */
const encodeServerMessage = (message: ServerMessagePayload): string =>
	JSON.stringify([JSON.stringify(message)])

/**
 * Assembles a Frappe error envelope over realistic defaults, and performs the single type
 * assertion this module needs.
 *
 * Defaults describe a `frappe.throw`: HTTP 417, which is the status Frappe returns for a
 * `ValidationError`. `exception` defaults to EMPTY, which is the "no exception reported"
 * state and — as traced in the section header — resolves through to the bare `message`.
 *
 * Exposed so a suite can compose an envelope the named factories below do not cover, for
 * example the permission refusal the statement importer can raise:
 * `makeFrappeError({ httpStatus: 403, httpStatusText: 'Forbidden', exc_type: 'PermissionError', … })`.
 */
export const makeFrappeError = (payload: Partial<FrappeErrorPayload> = {}): FrappeError =>
	({
		httpStatus: 417,
		httpStatusText: 'Expectation Failed',
		message: 'Expectation Failed',
		exception: '',
		exc_type: 'ValidationError',
		...payload
	}) as unknown as FrappeError

/**
 * PATH 1 — an error carrying a `_server_messages` envelope, the form a `frappe.throw`
 * produces and by far the most common backend refusal.
 *
 * `title: 'Message'` is what Frappe really sends for a plain throw, and it is meaningful:
 * `parseHeading` (`error-banner.tsx:20-23`) collapses both `'Message'` and `'Error'` into
 * the friendly heading, so this fixture exercises that collapse.
 *
 * `exception` is populated too, even though it can never be reached while
 * `_server_messages` is present. That is deliberate: it is what the server genuinely
 * sends alongside, and it lets a suite prove the PRECEDENCE — that the parsed server
 * message wins over the exception text.
 */
export const makeServerMessagesError = (
	message: string,
	overrides: Partial<FrappeErrorPayload> = {}
): FrappeError =>
	makeFrappeError({
		_server_messages: encodeServerMessage({ message, title: 'Message', indicator: 'red' }),
		exception: `frappe.exceptions.ValidationError: ${message}`,
		...overrides
	})

/**
 * PATH 1, warning severity — identical to {@link makeServerMessagesError} except that the
 * server's own indicator is `'yellow'`.
 *
 * That single value is the whole amber-versus-red decision: `error-banner.tsx:39` reads
 * `<Alert theme={messages[0]?.indicator === 'yellow' ? 'amber' : 'red'}>`. The client makes
 * no severity judgement of its own, so this fixture is the only way to reach the amber
 * branch.
 */
export const makeWarningServerMessagesError = (
	message: string,
	overrides: Partial<FrappeErrorPayload> = {}
): FrappeError =>
	makeFrappeError({
		_server_messages: encodeServerMessage({ message, title: 'Message', indicator: 'yellow' }),
		exception: `frappe.exceptions.ValidationError: ${message}`,
		...overrides
	})

/**
 * The server's own wording for the already-reconciled refusal, VERBATIM, including its
 * untranslated `{0}` placeholder:
 *
 *     Bank Transaction {0} is already fully reconciled
 *
 * The backend raises it as the FIRST statement of the first method the posting endpoint
 * invokes, guarded by `if 0.0 >= self.unallocated_amount`. Because that check precedes
 * every mutation and the whole operation commits through a single save, a partial posting
 * on this path is structurally impossible rather than merely unlikely.
 *
 * Kept as a template because the client must render the server's text with NO paraphrasing
 * whatsoever, so a suite can assert against the exact server wording.
 */
export const ALREADY_RECONCILED_MESSAGE_TEMPLATE = 'Bank Transaction {0} is already fully reconciled'

/**
 * Substitutes the transaction name into {@link ALREADY_RECONCILED_MESSAGE_TEMPLATE} the
 * same way the server's `.format()` call does, producing the exact text that travels on
 * the wire.
 */
export const formatAlreadyReconciledMessage = (transactionName: string): string =>
	ALREADY_RECONCILED_MESSAGE_TEMPLATE.replace('{0}', transactionName)

/**
 * The already-reconciled refusal as a complete error envelope — the fixture behind the
 * stale-client scenario and the "a failed confirm changes nothing" scenario.
 *
 * A suite pairs it with {@link makeReconciledTransaction} and asserts two things: that the
 * server's text reaches the dialog verbatim, and that no row transitions to reconciled.
 */
export const makeAlreadyReconciledError = (
	transactionName: string = 'ACC-BTN-2024-00003',
	overrides: Partial<FrappeErrorPayload> = {}
): FrappeError =>
	makeServerMessagesError(formatAlreadyReconciledMessage(transactionName), overrides)

/**
 * PATH 2 — an error whose text arrives in `_error_message` rather than
 * `_server_messages`. `frappe.ts:36-44` pushes it as
 * `{ message, title: 'Error', indicator: 'red' }`.
 *
 * Note this step is ADDITIVE, not exclusive: supplying `_server_messages` as well through
 * `overrides` yields TWO parsed messages, and `ErrorBanner` renders both
 * (`error-banner.tsx:43-45`).
 */
export const makeErrorMessageError = (
	message: string,
	overrides: Partial<FrappeErrorPayload> = {}
): FrappeError =>
	makeFrappeError({
		_error_message: message,
		exception: `frappe.exceptions.ValidationError: ${message}`,
		...overrides
	})

/**
 * PATH 3 — no server messages at all, so the text is recovered from `exception` by
 * slicing off everything up to and including the first colon.
 *
 * Two details a suite must expect. The parsed message RETAINS the leading space that
 * follows the colon in a real Frappe exception line, and it carries NO `indicator`
 * (`frappe.ts:52-55` sets only `message` and `title`) — which means
 * `error-banner.tsx:39` falls to the red theme.
 */
export const makeExceptionError = (
	message: string,
	overrides: Partial<FrappeErrorPayload> = {}
): FrappeError =>
	makeFrappeError({
		exception: `frappe.exceptions.ValidationError: ${message}`,
		...overrides
	})

/**
 * PATH 3, first quirk — an `exception` whose colon sits at INDEX 0.
 *
 * `indexOfFirstColon` is then `0`, and `if (0)` is falsy, so `frappe.ts:49` skips the
 * entire colon-slice step even though a colon is plainly present. Resolution therefore
 * falls through to the bare `message` at `:59-65`, yielding
 * `{ message: <the bare message>, title: 'Error', indicator: 'red' }` — NOT the exception
 * text.
 *
 * `message` is given a distinct default precisely so a suite can tell the two apart and
 * prove which branch ran.
 */
export const makeLeadingColonExceptionError = (
	exceptionMessage: string,
	overrides: Partial<FrappeErrorPayload> = {}
): FrappeError =>
	makeFrappeError({
		exception: `: ${exceptionMessage}`,
		message: 'Bare message reached because the colon sits at index zero',
		...overrides
	})

/**
 * PATH 3, second quirk — an `exception` containing NO colon.
 *
 * `indexOf(':')` returns `-1`, which is TRUTHY, so `frappe.ts:50` slices from `-1 + 1`,
 * i.e. from index 0, and the parsed message is the WHOLE exception string with nothing
 * stripped. Like the ordinary colon case it carries no `indicator`.
 */
export const makeColonlessExceptionError = (
	exceptionMessage: string,
	overrides: Partial<FrappeErrorPayload> = {}
): FrappeError =>
	makeFrappeError({
		exception: exceptionMessage,
		...overrides
	})

/**
 * PATH 4 — the final fallback: nothing but a bare `message`.
 *
 * `exception` is EMPTY, and that is what routes resolution here. Traced through
 * `frappe.ts:48-57`: `''.indexOf(':')` is `-1` (truthy), `''.slice(0)` is `''`, and
 * `if ('')` is falsy — so the colon-slice step produces nothing and `:59-65` supplies
 * `{ message, title: 'Error', indicator: 'red' }`.
 *
 * This is also the fixture for the transport half of an "API or network failure": a
 * request that never reached application code has no server messages and no exception.
 * Override `message` for a specific wording, e.g. `makeMessageOnlyError('Network Error')`.
 */
export const makeMessageOnlyError = (
	message: string = 'Internal Server Error',
	overrides: Partial<FrappeErrorPayload> = {}
): FrappeError =>
	makeFrappeError({
		httpStatus: 500,
		httpStatusText: 'Internal Server Error',
		message,
		exception: '',
		exc_type: undefined,
		...overrides
	})

/* ═══ 7. Per-file import failures ═════════════════════════════════════════════════════ */

/**
 * Builds the value held by `bankRecImportFailuresAtom`, whose type is
 * `Record<string, FrappeError>` keyed by import-log NAME (`bankRecAtoms.ts:91`).
 *
 * This map — not the document — is what drives the per-file failure indicator, because
 * `Bank Statement Import Log` has only two status values and no error field, so a failed
 * import persists nothing at all. The failure is therefore observed from the synchronous
 * rejection and held for the session.
 *
 * Accepts the log itself rather than a bare name so the key cannot drift from the row it
 * marks.
 */
export const makeImportFailures = (
	log: BankStatementImportLog,
	error: FrappeError = makeServerMessagesError('No tables found in the uploaded file')
): Record<string, FrappeError> => ({ [log.name]: error })

/* ═══ 8. The ONE shared `frappe-react-sdk` module mock ════════════════════════════════
 * Every suite mocks the SDK through this single helper, so no suite hand-rolls its own
 * module mock and no suite can accidentally omit a symbol.
 *
 * Applied in one line at module level:
 *
 *     vi.mock('frappe-react-sdk', () => createFrappeSDKMock())
 *
 * That line stays literally in the test file so Vitest's transform hoists it above the
 * imports; the factory itself runs lazily, on first import of the mocked module, which is
 * why it may reference this imported helper.
 *
 * ─── Which symbols are stubbed, and which must NOT be ────────────────────────────────
 * Every `from 'frappe-react-sdk'` import across `src/` was enumerated: SEVENTEEN distinct
 * symbols, of which THIRTEEN are used as VALUES and are stubbed below, while four —
 * `FrappeError`, `FrappeConfig`, `SWRConfiguration` and `Filter` — appear only in type
 * positions.
 *
 * Those four are deliberately absent. They are erased before the module is ever resolved:
 * esbuild drops an import specifier that survives only in a type annotation, so the name
 * never reaches Vite's import validation. Verified rather than assumed — `BankBalance.tsx`
 * (`FrappeConfig`), `LinkFieldCombobox.tsx` (`Filter`), `MatchAndReconcile.tsx` and
 * `pages/BankStatementImporter.tsx` all import cleanly against this thirteen-symbol mock.
 * Adding a runtime stub for a type would be inventing an export the library does not have.
 *
 * ─── Return shapes are the library's, not a guess ────────────────────────────────────
 * Each shape below was read off `frappe-react-sdk/dist/lib/index.d.ts`, then cross-checked
 * against what the SPA actually destructures. Two of them are easy to get wrong and both
 * break suites loudly rather than subtly:
 *
 *   • `useSWRConfig()` MUST return `{ mutate }`. `useRefreshUnreconciledTransactions`
 *     destructures it at `utils.ts:153`, and `useReconcileTransaction` calls that hook —
 *     so a mock without it fails every reconcile test at render time. Exposing the spy is
 *     also what makes the cache-revalidation assertions possible.
 *   • that `mutate` MUST return a PROMISE. `utils.ts:198` chains `.then(...)` onto it
 *     directly, so a plain `vi.fn()` returning `undefined` would throw. It resolves to
 *     `undefined`, which is safe because the continuation reads `res?.message` behind
 *     optional chaining (`utils.ts:202`).
 *
 * ─── Defaults are inert, never failing ──────────────────────────────────────────────
 * Queries return no data and no error; async operations RESOLVE. A suite therefore opts
 * in to every interesting state, and — importantly for the failure-mode scenarios — must
 * opt in to failure explicitly with `.mockRejectedValue(...)`. Nothing here fails by
 * default, so a passing test never passes because a stub happened to break.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/**
 * Stable spy for the keyed revalidation function returned by `useSWRConfig()`.
 *
 * This is the SPA's global cache-invalidation channel: the reconcile flow calls it with
 * each affected cache key on BOTH the success and the failure path, which is how a stale
 * client is corrected after the server refuses a post. Assert on it with the exact key
 * strings built in `utils.ts:59,78,94,121,137` — those five families are fixed, and a
 * suite must reuse them rather than reshape them.
 */
export const frappeSWRMutate = vi.fn()

/**
 * Stable spy for the `mutate` returned by the individual query hooks. Kept distinct from
 * {@link frappeSWRMutate} on purpose: a single shared spy would let a local re-fetch
 * satisfy an assertion that global keyed revalidation had occurred.
 */
export const frappeHookMutate = vi.fn()

/**
 * Stable spy for the `call` returned by `useFrappePostCall`, shared by every post-call
 * site. This is the seam for both posting scenarios:
 *
 *   • success  — `frappePostCall.mockResolvedValue({ message: makeBankTransaction() })`
 *   • refusal  — `frappePostCall.mockRejectedValue(makeAlreadyReconciledError())`
 *
 * When a component holds several post calls and a suite must distinguish them, override
 * the hook instead and branch on its `method` argument:
 * `frappeSDKMock.useFrappePostCall.mockImplementation((method) => …)`.
 */
export const frappePostCall = vi.fn()

/** Stable spy for the `createDoc` returned by `useFrappeCreateDoc`. */
export const frappeCreateDoc = vi.fn()

/** Stable spy for the `updateDoc` returned by `useFrappeUpdateDoc`. */
export const frappeUpdateDoc = vi.fn()

/** Stable spy for the `upload` returned by `useFrappeFileUpload`. */
export const frappeFileUpload = vi.fn()

/** Stable spies for the emitters returned by `useFrappeDocumentEventListener`. */
const frappeEmitDocOpen = vi.fn()
const frappeEmitDocClose = vi.fn()

/**
 * Realtime subscriptions recorded by the `useFrappeEventListener` stub, keyed by channel.
 *
 * The most recent callback for a channel replaces any earlier one, which mirrors the real
 * hook: it re-subscribes whenever the callback identity changes. Keeping only the latest
 * is also what prevents {@link emitFrappeEvent} from invoking a stale closure captured by
 * an earlier render.
 */
const frappeEventListeners = new Map<string, (eventData: unknown) => void>()

/**
 * Returns the handler currently subscribed to a realtime channel, or `undefined` if
 * nothing is subscribed — useful for asserting that a component did (or did not) subscribe.
 *
 * The channel the statement importer uses is `"bank-rec-statement-import-progress"`
 * (`CSV/StatementDetails.tsx:88`).
 */
export const getFrappeEventListener = (
	eventName: string
): ((eventData: unknown) => void) | undefined => frappeEventListeners.get(eventName)

/**
 * Delivers a realtime payload to the handler subscribed to `eventName`, simulating a
 * server push — for example import progress:
 *
 *     act(() => { emitFrappeEvent('bank-rec-statement-import-progress', { progress: 40 }) })
 *
 * The `act()` wrapper is the CALLER's responsibility: the handler sets React state
 * (`StatementDetails.tsx:88-90`), and wrapping here would impose act semantics on every
 * caller and hide the update from the test's own batching.
 *
 * Throws when nothing is subscribed, rather than silently doing nothing. A no-op would let
 * a suite believe it had simulated progress while the component never received it, turning
 * a real wiring bug into a confusing assertion failure somewhere else.
 */
export const emitFrappeEvent = (eventName: string, eventData: unknown): void => {
	const listener = frappeEventListeners.get(eventName)
	if (!listener) {
		const subscribed = Array.from(frappeEventListeners.keys())
		throw new Error(
			`No realtime listener is subscribed to "${eventName}". ` +
				`Subscribed channels: ${subscribed.length > 0 ? subscribed.join(', ') : '(none)'}. ` +
				'Render the component that subscribes before emitting.'
		)
	}
	listener(eventData)
}

/**
 * The value carried by the replacement {@link FrappeContextMock}.
 *
 * A real context with a real default is required because the SPA reads it as
 * `useContext(FrappeContext) as FrappeConfig` and immediately destructures a member — nine
 * files do so across eighteen sites. With the library's own `null` default, or with a
 * non-context stand-in, the first lazily loaded modal body to mount would throw.
 *
 * The members the SPA actually invokes are `call.get` (five sites), `db.setValue` and
 * `db.deleteDoc` (two each) and `file.uploadFile` (three). The remaining members mirror
 * the real `FrappeCall` and `FrappeDB` surfaces so that a component reaching for one finds
 * a spy instead of `undefined`.
 */
export const frappeContextValue = {
	call: {
		get: vi.fn(() => Promise.resolve({})),
		post: vi.fn(() => Promise.resolve({})),
		put: vi.fn(() => Promise.resolve({})),
		delete: vi.fn(() => Promise.resolve({}))
	},
	db: {
		getDoc: vi.fn(() => Promise.resolve({})),
		getDocList: vi.fn(() => Promise.resolve([])),
		getCount: vi.fn(() => Promise.resolve(0)),
		createDoc: vi.fn(() => Promise.resolve({})),
		updateDoc: vi.fn(() => Promise.resolve({})),
		deleteDoc: vi.fn(() => Promise.resolve({ message: 'ok' })),
		setValue: vi.fn(() => Promise.resolve({}))
	},
	file: {
		uploadFile: vi.fn(() => Promise.resolve({}))
	}
}

/**
 * The replacement for the SDK's `FrappeContext`. Created once at module scope so every
 * consumer in a suite's module graph shares one context identity — a fresh one per
 * `createFrappeSDKMock()` call would silently hand `useContext` the default value instead
 * of a provided one.
 */
export const FrappeContextMock = createContext(frappeContextValue)

/**
 * The replacement for `FrappeProvider`: a pass-through that renders its children and
 * nothing else, so a suite can mount `App`-shaped trees without a server, a socket or a
 * site name.
 *
 * Built with `createElement` around a `Fragment` because this is a `.ts` module and JSX is
 * not available here — and the filename stays `factories.ts` by design.
 */
export const FrappeProviderMock = ({ children }: { children?: ReactNode }) =>
	createElement(Fragment, null, children)

/**
 * The thirteen SDK hooks, as stable `vi.fn()` spies.
 *
 * Exported so a suite can override any single hook's return without re-mocking the module:
 *
 *     frappeSDKMock.useFrappeGetCall.mockImplementation((method) =>
 *         method.endsWith('get_bank_transactions')
 *             ? { data: { message: [makeUnreconciledTransaction()] }, error: undefined,
 *                 isLoading: false, isValidating: false, mutate: frappeHookMutate }
 *             : { data: undefined, error: undefined, isLoading: false,
 *                 isValidating: false, mutate: frappeHookMutate })
 *
 * Branching on the method (rather than a blanket `mockReturnValue`) matters because a
 * single render reaches `useFrappeGetCall` many times with different endpoints.
 */
export const frappeSDKMock = {
	useFrappeGetCall: vi.fn(),
	useFrappeGetDoc: vi.fn(),
	useFrappeGetDocList: vi.fn(),
	useFrappeGetDocCount: vi.fn(),
	useFrappePostCall: vi.fn(),
	useFrappeCreateDoc: vi.fn(),
	useFrappeUpdateDoc: vi.fn(),
	useFrappeFileUpload: vi.fn(),
	useFrappeEventListener: vi.fn(),
	useFrappeDocumentEventListener: vi.fn(),
	useSWRConfig: vi.fn()
}

/**
 * Installs the inert default behaviour on every spy above. Run once at module load, and
 * again by {@link resetFrappeSDKMock}, because `mockReset()` discards implementations as
 * well as call history.
 */
const installFrappeSDKDefaults = (): void => {
	// Must be a promise: `utils.ts:198` chains `.then()` straight onto it. Resolving to
	// `undefined` is safe — the continuation guards with `res?.message`.
	frappeSWRMutate.mockImplementation(() => Promise.resolve(undefined))
	frappeHookMutate.mockImplementation(() => Promise.resolve(undefined))

	// Resolve to an empty object rather than `undefined`: success handlers dereference the
	// result (`res.message` at `utils.ts:247`, `response.docs` at `StatementDetails.tsx:71`),
	// and `{}` yields `undefined` for those keys instead of throwing.
	frappePostCall.mockImplementation(() => Promise.resolve({}))
	frappeCreateDoc.mockImplementation(() => Promise.resolve({}))
	frappeUpdateDoc.mockImplementation(() => Promise.resolve({}))
	frappeFileUpload.mockImplementation(() => Promise.resolve({}))

	frappeEmitDocOpen.mockImplementation(() => undefined)
	frappeEmitDocClose.mockImplementation(() => undefined)

	// SWR-backed hooks. `error` is `undefined` rather than `null`, matching SWR's own
	// "no error yet" value, so `error && <ErrorBanner …>` stays falsy.
	frappeSDKMock.useFrappeGetCall.mockImplementation(() => ({
		data: undefined,
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: frappeHookMutate
	}))
	frappeSDKMock.useFrappeGetDoc.mockImplementation(() => ({
		data: undefined,
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: frappeHookMutate
	}))
	frappeSDKMock.useFrappeGetDocList.mockImplementation(() => ({
		data: undefined,
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: frappeHookMutate
	}))
	frappeSDKMock.useFrappeGetDocCount.mockImplementation(() => ({
		data: undefined,
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: frappeHookMutate
	}))

	// Imperative hooks. `error: null` here, because the SDK initialises these with `null`
	// rather than leaving them undefined.
	frappeSDKMock.useFrappePostCall.mockImplementation(() => ({
		call: frappePostCall,
		result: null,
		loading: false,
		error: null,
		isCompleted: false,
		reset: vi.fn()
	}))
	frappeSDKMock.useFrappeCreateDoc.mockImplementation(() => ({
		createDoc: frappeCreateDoc,
		result: null,
		loading: false,
		error: null,
		isCompleted: false,
		reset: vi.fn()
	}))
	frappeSDKMock.useFrappeUpdateDoc.mockImplementation(() => ({
		updateDoc: frappeUpdateDoc,
		result: null,
		loading: false,
		error: null,
		isCompleted: false,
		reset: vi.fn()
	}))
	// `progress` completes the library's shape and is read by the importer's upload UI.
	frappeSDKMock.useFrappeFileUpload.mockImplementation(() => ({
		upload: frappeFileUpload,
		progress: 0,
		loading: false,
		error: null,
		isCompleted: false,
		reset: vi.fn()
	}))

	// Records the subscription so `emitFrappeEvent` can drive it, and returns `void` just
	// as the real hook does.
	frappeSDKMock.useFrappeEventListener.mockImplementation(
		(eventName: string, callback: (eventData: unknown) => void) => {
			frappeEventListeners.set(eventName, callback)
		}
	)

	frappeSDKMock.useFrappeDocumentEventListener.mockImplementation(() => ({
		viewers: [],
		emitDocOpen: frappeEmitDocOpen,
		emitDocClose: frappeEmitDocClose
	}))

	frappeSDKMock.useSWRConfig.mockImplementation(() => ({ mutate: frappeSWRMutate }))
}

installFrappeSDKDefaults()

/**
 * Clears every recorded call and per-test override, then reinstalls the inert defaults and
 * drops all realtime subscriptions.
 *
 * `src/test/setup.ts` unmounts trees and clears web storage after each test but does not
 * touch mocks, so call this from a suite's own `afterEach`/`beforeEach` when its tests
 * assert on call counts or install differing per-test implementations.
 */
export const resetFrappeSDKMock = (): void => {
	frappeEventListeners.clear()

	frappeSWRMutate.mockReset()
	frappeHookMutate.mockReset()
	frappePostCall.mockReset()
	frappeCreateDoc.mockReset()
	frappeUpdateDoc.mockReset()
	frappeFileUpload.mockReset()
	frappeEmitDocOpen.mockReset()
	frappeEmitDocClose.mockReset()

	Object.values(frappeSDKMock).forEach((hook) => hook.mockReset())

	Object.values(frappeContextValue).forEach((group) => {
		Object.values(group).forEach((member) => member.mockReset())
	})

	frappeContextValue.call.get.mockImplementation(() => Promise.resolve({}))
	frappeContextValue.call.post.mockImplementation(() => Promise.resolve({}))
	frappeContextValue.call.put.mockImplementation(() => Promise.resolve({}))
	frappeContextValue.call.delete.mockImplementation(() => Promise.resolve({}))
	frappeContextValue.db.getDoc.mockImplementation(() => Promise.resolve({}))
	frappeContextValue.db.getDocList.mockImplementation(() => Promise.resolve([]))
	frappeContextValue.db.getCount.mockImplementation(() => Promise.resolve(0))
	frappeContextValue.db.createDoc.mockImplementation(() => Promise.resolve({}))
	frappeContextValue.db.updateDoc.mockImplementation(() => Promise.resolve({}))
	frappeContextValue.db.deleteDoc.mockImplementation(() => Promise.resolve({ message: 'ok' }))
	frappeContextValue.db.setValue.mockImplementation(() => Promise.resolve({}))
	frappeContextValue.file.uploadFile.mockImplementation(() => Promise.resolve({}))

	installFrappeSDKDefaults()
}

/**
 * THE shared module mock. Returns the object a `vi.mock` factory should hand back in place
 * of `frappe-react-sdk`:
 *
 *     vi.mock('frappe-react-sdk', () => createFrappeSDKMock())
 *
 * It exposes the thirteen runtime symbols and none of the four type-only ones. The spies
 * are the same identities exported above, so a suite mocks and asserts through
 * {@link frappeSDKMock}, {@link frappePostCall} and {@link frappeSWRMutate} without
 * re-deriving anything.
 *
 * `overrides` is an escape hatch for the rare suite that needs to replace a symbol
 * outright — or to supply one the SPA has only just started importing — without forking
 * this helper. It is spread LAST, so it always wins.
 *
 * It is generic over the overrides so the returned type REFLECTS them: a suite supplying a
 * symbol this helper does not know about can still reference it without a cast, which a
 * plain `Record<string, unknown>` parameter would have made a `TS2339` under `strict`.
 */
export const createFrappeSDKMock = <T extends Record<string, unknown> = Record<string, never>>(
	overrides: T = {} as T
) => ({
	...frappeSDKMock,
	FrappeContext: FrappeContextMock,
	FrappeProvider: FrappeProviderMock,
	...overrides
})
