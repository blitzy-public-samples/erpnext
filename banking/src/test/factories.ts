/**
 * Typed fixture builders and the ONE shared `frappe-react-sdk` module mock for the ERPNext Banking
 * SPA's Vitest suites. They live here once because a fixture hand-rolled per suite drifts from the
 * contract it models, and a wrong field NAME or payload SHAPE silently invalidates every assertion
 * built on it.
 *
 * The existing backend contract is authoritative, so every default below was read off this
 * repository rather than invented. Return types are annotated with the real application types, which
 * makes that mechanically enforced by `tsc -b`: a misspelt or extra field is a compile error.
 *
 * Identity constants restate the values `src/test/setup.ts` seeds, because a company or currency name
 * that is not a `locals` key resolves to `undefined` or falls back silently instead of failing.
 *
 *   • `get_bank_transactions` projects SIXTEEN columns
 *     (`bank_reconciliation_tool.py:66-85`), while the client's `UnreconciledTransaction`
 *     `Pick` (`BankReconciliation/utils.ts:84`) deliberately narrows that to FIFTEEN by
 *     omitting `allocated_amount`. The builder in §2 models the client projection, not the
 *     raw response — it is a CONSUMER-SIDE view of the payload, and §2 says which column it
 *     drops and why.
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
 * mechanically enforced by `tsc -b` rather than merely promised: naming a field the
 * application type does not declare, or misspelling one it does, is a compile error rather
 * than a silent lie.
 */

// `globals: true` exposes the Vitest API at runtime but does not TYPE it, so `vi` is imported
// explicitly.
import { vi } from 'vitest'

import { createContext, createElement, Fragment, type ReactNode } from 'react'

import type { LinkedPayment, UnreconciledTransaction } from '@/components/features/BankReconciliation/utils'
import type { ImportAttemptStatus, SelectedBank } from '@/components/features/BankReconciliation/bankRecAtoms'
import type { BankTransaction } from '@/types/Accounts/BankTransaction'
import type { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'
import type { BankTransactionRule } from '@/types/Accounts/BankTransactionRule'
// Type-only imports, so nothing here loads the SDK module — which matters, because a suite
// replaces it wholesale with `vi.mock`. Every name below is exported by the package root
// (`frappe-react-sdk/dist/lib/index.d.ts:12-14,401,502`), which is what lets the spy
// contracts in §8 be DERIVED from the installed declarations instead of restated by hand.
import type {
	DocumentUpdateEventData,
	FileArgs,
	Filter,
	FrappeError,
	FrappeFileUploadResponse,
	GetDocListArgs,
	Key,
	SWRConfiguration
} from 'frappe-react-sdk'

/**
 * Must equal the harness's company, which is used as BOTH `boot.user.defaults.company` and the
 * `locals[':Company']` key; any other value makes `getCompanyCurrency()` return `undefined`.
 */
export const TEST_COMPANY = 'Test Company'

export const TEST_CURRENCY = 'INR'

/**
 * The harness's second registered currency. Pairing it with {@link TEST_CURRENCY} is what makes a
 * mismatch observable, because a row resolves its effective currency from `transaction.currency`
 * first and only then from the account.
 */
export const TEST_ALTERNATE_CURRENCY = 'USD'

export const TEST_USER = 'Administrator'

export const TEST_BANK_ACCOUNT = 'Test Bank - Test Company'

export const TEST_BANK = 'Test Bank'

export const TEST_BANK_LEDGER_ACCOUNT = 'Test Bank - TC'

export const TEST_TRANSACTION_RULE = 'BTR-0001'

/** Shared by the base transaction and the suggested voucher: the predicate compares dates for equality. */
export const TEST_TRANSACTION_DATE = '2024-01-15'

export const TEST_ALTERNATE_DATE = '2024-01-09'

/**
 * The base transaction's amount AND unallocated amount. The suggested voucher reuses this exact
 * number, because the predicate compares `paid_amount` against `unallocated_amount`.
 */
export const TEST_TRANSACTION_AMOUNT = 12500

export const TEST_ALTERNATE_AMOUNT = 8750

/**
 * The base transaction's `reference_number` and the suggested voucher's `reference_no`, so they form
 * a full reference match.
 *
 * A blank `reference_no` is a first-class case, NOT something to avoid. `get_linked_payments` unions
 * four voucher types and two of them - Purchase Invoice and Sales Invoice - select
 * `ConstantColumn("")` for this column, while the Journal Entry branch selects
 * `Max(je.cheque_no)`, which is NULL when no row in the group carries a cheque number. Fixtures
 * that could only produce a non-blank reference could not express the majority of the rows this
 * endpoint actually returns, and so could not detect a grader that mistakes a blank for agreement -
 * which is precisely the defect `matchVoucherReference` now prevents. Use
 * {@link makeBlankReferenceLinkedPayment} and {@link makeNullReferenceLinkedPayment} to model those
 * rows faithfully.
 */
export const TEST_REFERENCE_NUMBER = 'NEFT/2024/000145'

/**
 * The override voucher's `reference_no`, chosen so it is neither equal to nor a SUBSTRING of
 * {@link TEST_REFERENCE_NUMBER} or of the base description — otherwise it would read as a partial
 * match instead of "No Match".
 */
export const TEST_ALTERNATE_REFERENCE_NUMBER = 'JV-ADJ-2024-0007'

export const TEST_TRANSACTION_DESCRIPTION = 'NEFT credit from ACME Traders'

export const TEST_CREATION_TIMESTAMP = '2024-01-15 10:30:00.000000'

export const TEST_MODIFIED_TIMESTAMP = '2024-01-15 10:31:12.000000'

/* ═══ 2. Bank transactions ════════════════════════════════════════════════════════════
 * THE BACKEND CONTRACT. `get_bank_transactions` selects SIXTEEN columns
 * (`bank_reconciliation_tool.py:66-85`):
 *
 *   date · deposit · withdrawal · currency · description · transaction_type · name ·
 *   bank_account · company · allocated_amount · unallocated_amount · reference_number ·
 *   party_type · party · status · matched_transaction_rule
 *
 * THE CLIENT PROJECTION. `UnreconciledTransaction` (`BankReconciliation/utils.ts:84`) is a
 * `Pick` over FIFTEEN of those sixteen. The one column it does not name is
 * `allocated_amount`. That narrowing is deliberate, not an oversight: no reconciliation
 * surface reads the allocated figure off a row — the list shows the transaction value and
 * the remaining `unallocated_amount` (`MatchAndReconcile.tsx:430-431`), and the allocated
 * figure only becomes relevant on the FULL document the reconcile response returns, which
 * `makeBankTransaction` below does model.
 *
 * So the builder in this section is a faithful model of the CONSUMER projection, and is
 * not to be read as a transcription of the raw endpoint response. The distinction matters
 * for a fixture: a suite that needed the allocated figure would be asserting against the
 * wrong type, and should use `makeBankTransaction` instead.
 *
 * `status` AND `unallocated_amount` are both in the picked set — which is exactly why the
 * client-side already-reconciled guard needs no new data and no backend change.
 *
 * Only `name` is required (`types/Accounts/BankTransaction.ts:4`); the other fourteen
 * picked fields are optional. All fifteen are nonetheless written out explicitly below, so
 * the projection is auditable by reading the builder rather than by trusting this comment.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/**
 * An ordinary unreconciled DEPOSIT row: exactly one of `withdrawal`/`deposit` is positive, because
 * the displayed amount is `withdrawal > 0 ? withdrawal : deposit`. Override both for a withdrawal
 * row. `matched_transaction_rule` is explicitly `undefined` rather than omitted, so all fifteen
 * picked fields appear in one place; an unstamped row renders no rule badge.
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

export const makeRuleMatchedTransaction = (
	overrides: Partial<UnreconciledTransaction> = {}
): UnreconciledTransaction =>
	makeUnreconciledTransaction({
		name: 'ACC-BTN-2024-00002',
		matched_transaction_rule: TEST_TRANSACTION_RULE,
		...overrides
	})

/**
 * A transaction the server considers FULLY RECONCILED. Both signals are set and both are
 * load-bearing: the server derives `status` from `docstatus` and `unallocated_amount`, so
 * `status === 'Reconciled'` holds exactly when `unallocated_amount <= 0`, and setting only one would
 * model a state the server can never produce.
 *
 * Such rows do reach the UI: the "Bank Transactions" tab requests the unfiltered set, bypassing the
 * server-side filter that would otherwise exclude them.
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
 * The ONE guaranteed requirement is that the indicator is ADVISORY: it must not disable
 * confirming, and the server stays the authority. This fixture therefore promises nothing
 * about how the backend answers a post — a suite must mock whichever response it intends to
 * exercise, and assert against that:
 *
 *   • accepted — `frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())`
 *   • refused  — `frappePostCall.mockRejectedValue(makeServerMessagesError(…))`, which then
 *     surfaces through the same dismissible dialog as any other backend refusal
 *
 * Do NOT assume a mismatch is rejected. `validate_currency`
 * (`bank_transaction.py:65-82`) is reached only from `validate()`, while the reconcile path
 * saves an ALREADY-SUBMITTED document — which Frappe routes through `update_after_submit`,
 * a path that never calls `validate()`. `MatchAndReconcile.tsx:398-408` records the runtime
 * confirmation of that seam. Assuming a rejection here would make an FM5 suite assert a
 * response the real call path does not produce.
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
 * Builds a COMPLETE `Bank Transaction` document, as distinct from the fifteen-field client
 * projection above. This is the builder that carries `allocated_amount` — the one column
 * `get_bank_transactions` returns that `UnreconciledTransaction` does not pick — so a suite
 * needing the allocated figure belongs here rather than on the row builder.
 *
 * Defaults model the response to a SUCCESSFUL FULL reconciliation, so `unallocated_amount: 0` drives
 * the "advance to the next transaction" branch; override it for the partial-allocation branch.
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

/**
 * The bank account held in `selectedBankAccountAtom`.
 *
 * `account_currency` is not a native `Bank Account` field: `bank_account.get_list` derives it at
 * query time by following `Bank Account.account` to `Account.account_currency`, which is why both
 * `BankAccountWithCurrency` and `SelectedBank` type it as optional. Defaulted here so the
 * currency comparison has something to read; override it to model an unresolved currency.
 *
 * A suite that replaces the `offsetWidth`/`offsetHeight` getters to give a virtualized list a
 * non-zero viewport must restore those property spies itself — the shared teardown resets this
 * module's spies, not property getters.
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
	// Set only for accounts linked to an external banking integration; this fixture models a
	// manually maintained account.
	integration_id: undefined,
	last_integration_date: undefined,
	account_currency: TEST_CURRENCY,
	...overrides
})

/**
 * A candidate voucher. Defaults agree with {@link makeUnreconciledTransaction} on amount, posting
 * date, reference date and reference number, so at list index 0 it satisfies the suggestion
 * predicate — which also requires `index === 0`, so a voucher is only ever suggested when rendered
 * first.
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
 * The voucher a given transaction SUGGESTS, built by copying the compared fields off that
 * transaction. Deriving rather than restating is the point: this stays suggested by construction even
 * for a transaction whose amount or date a suite overrode.
 *
 * `reference_no` falls back with `||`, not `??`, so a transaction whose own `reference_number` is
 * blank still yields a voucher that genuinely agrees on SOMETHING. That keeps this builder's
 * contract honest - it promises a suggested voucher - and it is why the blank and null reference
 * cases have their own builders below rather than being reached by overriding this one.
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
 * A DIFFERENT voucher — the one a reviewer picks when overriding the suggestion. A `Journal Entry` at
 * `rank: 2` that disagrees with {@link makeUnreconciledTransaction} on amount and on both dates, and
 * whose reference is neither equal to nor a substring of the base reference or description, so the
 * row reads "No Match" rather than "Partial Match".
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

/**
 * An INVOICE row exactly as `get_linked_payments` returns one: both reference columns are the
 * literal empty string, because the Purchase Invoice and Sales Invoice branches select
 * `ConstantColumn("")` for each.
 *
 * The amount deliberately AGREES with {@link makeUnreconciledTransaction}, which is what makes this
 * fixture worth having. Amount agreement alone must NOT promote a voucher to "suggested": the
 * blank reference has to contribute nothing. Under the previous inline comparison it contributed a
 * spurious partial match - `''.includes` aside, `includes('')` is always true - and the row was
 * presented in green as though the rule engine had proposed it.
 */
export const makeBlankReferenceLinkedPayment = (overrides: Partial<LinkedPayment> = {}): LinkedPayment =>
	makeLinkedPayment({
		rank: 1,
		doctype: 'Purchase Invoice',
		name: 'ACC-PINV-2024-00001',
		paid_amount: TEST_TRANSACTION_AMOUNT,
		reference_no: '',
		reference_date: '',
		posting_date: TEST_ALTERNATE_DATE,
		party_type: 'Supplier',
		party: 'Globex Supplies',
		...overrides
	})

/**
 * A JOURNAL ENTRY row whose reference columns are NULL rather than empty, which is what
 * `Max(je.cheque_no)` yields when no row in the group carries a cheque number. Distinct from
 * {@link makeBlankReferenceLinkedPayment} because `null` and `''` reach a naive comparison
 * differently - `null === undefined` is false while `'' === ''` is true - so both shapes have to be
 * covered to prove the grader treats "absent" uniformly.
 *
 * The amount agrees here too, for the same reason.
 */
export const makeNullReferenceLinkedPayment = (overrides: Partial<LinkedPayment> = {}): LinkedPayment =>
	makeLinkedPayment({
		rank: 1,
		doctype: 'Journal Entry',
		name: 'ACC-JV-2024-00002',
		paid_amount: TEST_TRANSACTION_AMOUNT,
		reference_no: null,
		reference_date: null,
		posting_date: TEST_ALTERNATE_DATE,
		party_type: 'Supplier',
		party: 'Globex Supplies',
		...overrides
	})

/**
 * The rule DOCUMENT behind a `matched_transaction_rule` stamp — as distinct from the stamp itself,
 * which is a single field on the transaction row.
 *
 * The workbench reads this document (`useGetRuleForTransaction`, `utils.ts:872`) to describe what the
 * matched rule would DO, so every field that surface renders is populated by default: `rule_name` and
 * `rule_description` for the heading, `classify_as` for both the badge and the action button's
 * wording, `priority` for the priority badge, and `account` / `party_type` / `party` for the detail
 * rows.
 *
 * Defaults follow the DocType: `transaction_type` is `"Any"` (its declared default) and
 * `description_rules` is present because the DocType marks that table required — a rule with no
 * condition rows is a document the server cannot produce. `name` matches
 * {@link TEST_TRANSACTION_RULE} so this document and {@link makeRuleMatchedTransaction} line up
 * without either having to be overridden.
 *
 * `classify_as` has exactly three values (`Bank Entry`, `Payment Entry`, `Transfer`) and each one
 * routes the reviewer to a DIFFERENT modal, so a suite exercising that routing must override it
 * rather than assume the default.
 */
export const makeBankTransactionRule = (
	overrides: Partial<BankTransactionRule> = {}
): BankTransactionRule => ({
	name: TEST_TRANSACTION_RULE,
	creation: TEST_CREATION_TIMESTAMP,
	modified: TEST_MODIFIED_TIMESTAMP,
	owner: TEST_USER,
	modified_by: TEST_USER,
	docstatus: 0,
	rule_name: 'ACME inbound transfers',
	transaction_type: 'Any',
	priority: 1,
	rule_description: 'Credits from ACME Traders are settlement receipts',
	company: TEST_COMPANY,
	description_rules: [{
		name: 'row000000001',
		creation: TEST_CREATION_TIMESTAMP,
		modified: TEST_MODIFIED_TIMESTAMP,
		owner: TEST_USER,
		modified_by: TEST_USER,
		docstatus: 0,
		parent: TEST_TRANSACTION_RULE,
		parentfield: 'description_rules',
		parenttype: 'Bank Transaction Rule',
		idx: 1,
		check: 'Contains',
		value: 'ACME'
	}],
	classify_as: 'Payment Entry',
	account: TEST_BANK_LEDGER_ACCOUNT,
	party_type: 'Customer',
	party: 'ACME Traders',
	...overrides
})

/**
 * A statement import log row.
 *
 * `status` has exactly TWO values — `"Not Started" | "Completed"` — and the DocType carries no error
 * field of any kind. The import runs synchronously and rolls back on failure, so the status simply
 * never advances and nothing is persisted. That is why the per-file failure indicator is driven from
 * {@link makeImportFailures} rather than from the document, and why no third value is invented here.
 *
 * `file` MUST contain a slash: the row renders `file.split('/').pop()` as the displayed name.
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

/* Every backend refusal reaches the user through `getErrorMessages`, which resolves in a fixed
 * ORDER: parsed `_server_messages` first, then an APPENDED `_error_message`, then the text after the
 * first colon of `exception`, then the bare `message`. The fixtures below cover one path each.
 *
 * `_error_message` is not a member of the public `FrappeError` type, so each envelope is built as a
 * plain object and cast EXACTLY ONCE. That keeps this file free of `ts-expect-error`, and therefore
 * free of any risk of an orphaned directive. */

type ServerMessagePayload = {
	message: string
	title?: string
	indicator?: string
}

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
 * Encodes one server message the way Frappe actually transmits it: DOUBLE-ENCODED — a JSON array
 * whose element is itself a JSON string. A singly encoded fixture would arrive as a raw string and
 * take the parser's `catch` branch instead.
 */
const encodeServerMessage = (message: ServerMessagePayload): string =>
	JSON.stringify([JSON.stringify(message)])

/**
 * Assembles a Frappe error envelope and performs the single type assertion this module needs.
 *
 * Defaults describe a `frappe.throw`: HTTP 417, the status Frappe returns for a `ValidationError`,
 * with an EMPTY `exception` — the "no exception reported" state. Exposed so a suite can compose an
 * envelope the named factories below do not cover.
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
 * PATH 1 — an error carrying `_server_messages`, the form a `frappe.throw` produces and by far the
 * most common refusal.
 *
 * `title: 'Message'` is what Frappe really sends for a plain throw, and the banner collapses both
 * `'Message'` and `'Error'` into its friendly heading. `exception` is populated too, even though it
 * is unreachable while `_server_messages` is present, so a suite can prove that precedence.
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
 * PATH 1 at warning severity. The server's own `indicator` is the whole amber-versus-red decision —
 * the banner themes on `indicator === 'yellow'` and makes no judgement of its own — so this is the
 * only way to reach the amber branch.
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

/** The pre-format template; {@link formatAlreadyReconciledMessage} substitutes the transaction name. */
export const ALREADY_RECONCILED_MESSAGE_TEMPLATE = 'Bank Transaction {0} is already fully reconciled'

export const formatAlreadyReconciledMessage = (transactionName: string): string =>
	ALREADY_RECONCILED_MESSAGE_TEMPLATE.replace('{0}', transactionName)

export const makeAlreadyReconciledError = (
	transactionName: string = 'ACC-BTN-2024-00003',
	overrides: Partial<FrappeErrorPayload> = {}
): FrappeError =>
	makeServerMessagesError(formatAlreadyReconciledMessage(transactionName), overrides)

/**
 * PATH 2 — text arriving in `_error_message` rather than `_server_messages`. This step is ADDITIVE,
 * not exclusive: supplying both yields TWO parsed messages, and the banner renders both.
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
 * PATH 3 — no server messages, so the text is recovered from `exception` by slicing off everything up
 * to and including the first colon. The parsed message RETAINS the leading space that follows the
 * colon and carries no `indicator`, so the banner falls to the red theme.
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
 * PATH 3, first quirk — a colon at INDEX 0. The parser guards with a TRUTHINESS test, so `0` is falsy
 * and the colon-slice step is skipped even though a colon is plainly present; resolution falls
 * through to the bare `message`, which is given a distinct default so a suite can prove which branch
 * ran.
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
 * PATH 3, second quirk — an `exception` containing NO colon. `indexOf(':')` returns `-1`, which is
 * TRUTHY, so the slice starts at index 0 and the whole exception string survives.
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
 * PATH 4 — the message-only envelope: no server messages and an EMPTY `exception`, which is what
 * routes resolution here. The colon-slice step yields an empty string and is skipped, so the bare
 * `message` supplies the text.
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

/**
 * Builds the value held by `bankRecImportFailuresAtom`, whose type is `ImportAttemptMarkers` —
 * `Record<bankAccountName, Record<importLogName, ImportAttemptStatus>>`.
 *
 * NESTED BY BANK ACCOUNT, deliberately, because that is the shape the atom actually has. The
 * importer list is a per-bank query with a per-bank row limit, so a marker's visibility and its
 * lifetime are both properties of one account; a flat map made the retention cap count markers
 * from accounts whose rows were not even on screen. A fixture that flattened this would let a
 * suite pass against a shape the application no longer uses.
 *
 * This map supplements — and never overrides — the document, because `Bank Statement Import
 * Log` has only two status values and no error field, so an import that rolls back persists
 * nothing at all. The marker is what the client established about ONE attempt, and it holds
 * no error object: `'failed'` means the SERVER refused and a follow-up read confirmed the log is
 * still not `Completed`, while `'unknown'` means nothing observed amounts to the server saying so.
 * An authoritative `Completed` always wins over either, so a suite asserting the badge must supply
 * the log's own `status` as well as the marker.
 *
 * Accepts the log itself rather than a bare name so neither key can drift from the row it marks —
 * the bank key is read off the log's own `bank_account`.
 */
export const makeImportFailures = (
	log: BankStatementImportLog,
	attempt: ImportAttemptStatus = 'failed'
): Record<string, Record<string, ImportAttemptStatus>> => ({ [log.bank_account]: { [log.name]: attempt } })

/* Every suite mocks the SDK through {@link createFrappeSDKMock}, so none hand-rolls a module mock or
 * omits a symbol. The `vi.mock('frappe-react-sdk', () => createFrappeSDKMock())` line must stay
 * literally in the test file, so Vitest's transform can hoist it above the imports; the factory
 * itself runs lazily, which is why it may reference an imported helper.
 *
 * Only symbols used as VALUES are stubbed. `FrappeError`, `FrappeConfig`, `SWRConfiguration` and
 * `Filter` appear solely in type positions and are erased before the module is resolved, so stubbing
 * them would invent exports the library does not have.
 *
 *     vi.mock('frappe-react-sdk', () => createFrappeSDKMock())
 *
 * That line stays literally in the test file so Vitest's transform hoists it above the
 * imports; the factory itself runs lazily, on first import of the mocked module, which is
 * why it may reference this imported helper.
 *
 * ─── Which symbols are stubbed, and which must NOT be ────────────────────────────────
 * Every `from 'frappe-react-sdk'` import in the APPLICATION code under `src/` was
 * enumerated: SEVENTEEN distinct symbols, of which THIRTEEN are used as VALUES and are
 * stubbed below, while four — `FrappeError`, `FrappeConfig`, `SWRConfiguration` and
 * `Filter` — appear only in type positions.
 *
 * Those four are deliberately absent. They are erased before the module is ever resolved:
 * esbuild drops an import specifier that survives only in a type annotation, so the name
 * never reaches Vite's import validation. Verified rather than assumed — `BankBalance.tsx`
 * (`FrappeConfig`), `LinkFieldCombobox.tsx` (`Filter`), `MatchAndReconcile.tsx` and
 * `pages/BankStatementImporter.tsx` all import cleanly against this thirteen-symbol mock.
 * Adding a runtime stub for a type would be inventing an export the library does not have.
 *
 * This module itself imports five FURTHER type-only names — `Key`, `GetDocListArgs`,
 * `FileArgs`, `FrappeFileUploadResponse` and `DocumentUpdateEventData` — to derive the
 * contracts in §8a. They are `import type` and therefore erased outright, so the runtime
 * surface a suite receives is still exactly thirteen symbols.
 *
 * ─── Return shapes are the library's, not a guess ────────────────────────────────────
 * Each shape below was read off `frappe-react-sdk/dist/lib/index.d.ts`, then cross-checked
 * against what the SPA actually destructures. Two of them are easy to get wrong and both
 * break suites loudly rather than subtly:
 *
 *   • `useSWRConfig()` MUST return `{ mutate }`. `useRefreshUnreconciledTransactions`
 *     destructures it at `utils.ts:209`, and `useReconcileTransaction` calls that hook —
 *     so a mock without it fails every reconcile test at render time. Exposing the spy is
 *     also what makes the cache-revalidation assertions possible.
 *   • that `mutate` MUST return a PROMISE. `utils.ts:254-255` chains `.then(...)` onto it
 *     directly, so a plain `vi.fn()` returning `undefined` would throw. It resolves to
 *     `undefined`, which is safe because the continuation reads `res?.message` behind
 *     optional chaining (`utils.ts:258`).
 *
 * ─── Every spy carries a TYPED contract, never a bare `vi.fn()` ──────────────────────
 * §8a declares one callable contract per SDK seam, each derived from the installed
 * declarations, and every spy is created as `vi.fn<Contract>(default)`. A bare `vi.fn()`
 * would infer `(...args: any[]) => any`, which silently accepts a wrong endpoint argument,
 * a wrong hook option or a wrong response shape — exactly the mistakes a typed test client
 * exists to prevent. With the contracts in place `tsc -b` rejects them at the point the
 * suite writes them, before anything runs.
 *
 * Where the library types a parameter as `any`, the contract narrows it to the shape every
 * call site in `src/` actually passes (`Record<string, unknown>` for RPC parameter bags,
 * for instance) and says so. Narrowing is deliberate: it is what makes a mistake a compile
 * error rather than a runtime surprise. Generics are preserved only where a caller depends
 * on one — `MockedQueryResponse<T>` keeps its payload parameter so the document-count hook
 * can promise a `number` — while payload types default to `unknown`, because a suite must
 * stay free to hand back any contract-valid fixture.
 *
 * ─── Defaults: passive reads are empty, side-effecting operations REJECT ─────────────
 * The four SWR-backed READ hooks default to "no data, no error, not loading", which is what
 * lets any component mount without configuration and is why a suite opts in to data.
 *
 * Every IMPERATIVE operation defaults to rejecting with
 * {@link UNCONFIGURED_OPERATION_MESSAGE} instead: the post call, `createDoc`, `updateDoc`,
 * the file upload and all twelve `FrappeContext` operations. A resolved-by-default
 * operation is the more dangerous choice, because production `.then` handlers then run on a
 * payload the test never supplied — the reconcile flow would log an action and toast success
 * with `res.message` undefined (`utils.ts:313-341`), and the importer would navigate away on
 * a response with no `docs` (`StatementDetails.tsx:77-86`) — so a suite could assert a
 * "successful" flow it never actually configured. Rejecting makes that omission fail loudly
 * and immediately, naming the operation and how to configure it. None of these fires during
 * mount — every one is reached from a user-event handler — so the rejection only ever
 * appears once a test drives the flow it forgot to set up.
 *
 * The two `mutate` spies are the deliberate exception: they keep resolving, because
 * production chains `.then(...)` straight onto them and cache revalidation is a consequence
 * of a scenario rather than the scenario itself. So are the document-event emitters, which
 * nothing in the SPA calls.
 *
 * Opting in is a one-liner, and {@link makeReconcileSuccessResponse} /
 * {@link makeImportSuccessResponse} make the payload contract-valid by construction rather
 * than hand-shaped per suite.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/* ─── 8a. Callable contracts, derived from the installed declarations ──────────────────
 * One alias per SDK seam. Each mirrors the corresponding declaration in
 * `frappe-react-sdk/dist/lib/index.d.ts` — or, for the `FrappeContext` operations, the
 * `frappe-js-sdk` class the SDK re-exports — narrowed to what `src/` actually passes and
 * reads. They exist so every spy below can be held to a real shape by `vi.fn<Contract>(…)`
 * instead of the `(...args: any[]) => any` a bare `vi.fn()` infers.
 * ────────────────────────────────────────────────────────────────────────────────────── */

/**
 * SWR's optimistic-update options, narrowed to the members production supplies:
 * `Preferences.tsx:24-32` passes `optimisticData` (line 27) and `revalidate` (line 31). The mock never reads
 * them — typing them is what stops a suite misspelling an option and believing it applied.
 */
interface MockedMutateOptions {
	optimisticData?: unknown
	revalidate?: boolean
	rollbackOnError?: boolean
	populateCache?: boolean
}

/**
 * The keyed `mutate` from `useSWRConfig()`, which revalidates ONE named cache key. Every
 * call site passes a bare key string (`utils.ts:226-229,254,270,363-372`), and `Key` is
 * SWR's own type for that argument, re-exported by the SDK.
 */
type MockedKeyedMutate = (
	key: Key,
	data?: unknown,
	options?: MockedMutateOptions
) => Promise<unknown>

/**
 * The `mutate` returned by an individual query hook. It revalidates that hook's OWN key, so
 * it takes no key: called bare in most places, and with an optimistic payload at
 * `Preferences.tsx:24-32`.
 */
type MockedHookMutate = (data?: unknown, options?: MockedMutateOptions) => Promise<unknown>

/**
 * The five members the SPA destructures from every SWR-backed hook — the subset of SWR's own
 * `SWRResponse` this application reads. `error` is `undefined` rather than `null` when
 * absent, matching SWR, so `error && <ErrorBanner …>` stays falsy.
 *
 * `T` defaults to `unknown` so a suite may hand back any contract-valid fixture, and is
 * pinned only where the library itself fixes the payload (see {@link MockedGetDocCountHook}).
 */
interface MockedQueryResponse<T = unknown> {
	data: T | undefined
	error: FrappeError | undefined
	isLoading: boolean
	isValidating: boolean
	mutate: MockedHookMutate
}

/** `index.d.ts:301`. `params` is `Record<string, any>` there, narrowed to a record here. */
type MockedGetCallHook = (
	method: string,
	params?: Record<string, unknown>,
	swrKey?: Key,
	options?: SWRConfiguration,
	type?: 'GET' | 'POST'
) => MockedQueryResponse

/** `index.d.ts:108`. */
type MockedGetDocHook = (
	doctype: string,
	name?: string,
	swrKey?: Key,
	options?: SWRConfiguration
) => MockedQueryResponse

/** `index.d.ts:158`. */
type MockedGetDocListHook = (
	doctype: string,
	args?: GetDocListArgs,
	swrKey?: Key,
	options?: SWRConfiguration
) => MockedQueryResponse

/**
 * `index.d.ts:265`. The one query hook whose payload the LIBRARY fixes — it resolves to a
 * count — so the generic is pinned to `number` rather than left open. `BankBalance.tsx:120`
 * destructures it as `data: totalCount`.
 */
type MockedGetDocCountHook = (
	doctype: string,
	filters?: Filter[],
	debug?: boolean,
	swrKey?: Key,
	options?: SWRConfiguration
) => MockedQueryResponse<number>

/** The `call` returned by `useFrappePostCall` (`index.d.ts:335`). */
type MockedPostCall = (params: Record<string, unknown>) => Promise<unknown>

/** `index.d.ts:333-346`. `error` is `Error | null` on this hook — not `| undefined`. */
interface MockedPostCallResult {
	call: MockedPostCall
	result: unknown
	loading: boolean
	error: FrappeError | null
	isCompleted: boolean
	reset: () => void
}

type MockedPostCallHook = (method: string) => MockedPostCallResult

/** The `createDoc` returned by `useFrappeCreateDoc` (`index.d.ts:190`). */
type MockedCreateDoc = (doctype: string, doc: unknown) => Promise<unknown>

/**
 * `index.d.ts:188-199`. Two details are easy to get wrong and both are load-bearing: the
 * create hook exposes NO `result` member, and its `error` is `Error | null | undefined`.
 */
interface MockedCreateDocResult {
	createDoc: MockedCreateDoc
	loading: boolean
	error: FrappeError | null | undefined
	isCompleted: boolean
	reset: () => void
}

type MockedCreateDocHook = () => MockedCreateDocResult

/** The `updateDoc` returned by `useFrappeUpdateDoc` (`index.d.ts:214`). */
type MockedUpdateDoc = (doctype: string, docname: string | null, doc: unknown) => Promise<unknown>

/** `index.d.ts:212-223`, which likewise carries no `result` member. */
interface MockedUpdateDocResult {
	updateDoc: MockedUpdateDoc
	loading: boolean
	error: FrappeError | null | undefined
	isCompleted: boolean
	reset: () => void
}

type MockedUpdateDocHook = () => MockedUpdateDocResult

/**
 * The `upload` returned by `useFrappeFileUpload` (`index.d.ts:433`). It resolves to the File
 * document — `pages/BankStatementImporter.tsx:69` reads `file.file_url` off it — which is why
 * the resolution type is the library's own interface and {@link makeFileUploadResponse}
 * exists to satisfy it without a cast.
 */
type MockedFileUpload = (
	file: File,
	args: FileArgs<unknown>,
	apiPath?: string
) => Promise<FrappeFileUploadResponse>

/** `index.d.ts:431-444`. `progress` is a rounded percentage. */
interface MockedFileUploadResult {
	upload: MockedFileUpload
	progress: number
	loading: boolean
	error: FrappeError | null
	isCompleted: boolean
	reset: () => void
}

type MockedFileUploadHook = () => MockedFileUploadResult

/**
 * `index.d.ts:496`. The library types the payload as `T = any`; `unknown` here, because the
 * concrete payload is supplied by {@link emitFrappeEvent} at the moment a test pushes one.
 */
type MockedEventListenerHook = (
	eventName: string,
	callback: (eventData: unknown) => void
) => void

/** The emitters returned by `useFrappeDocumentEventListener` (`index.d.ts:524-526`). */
type MockedDocEventEmitter = () => void

/** `index.d.ts:520-527`. */
interface MockedDocumentEventListenerResult {
	viewers: string[]
	emitDocOpen: MockedDocEventEmitter
	emitDocClose: MockedDocEventEmitter
}

type MockedDocumentEventListenerHook = (
	doctype: string,
	docname: string,
	onUpdateCallback: (eventData: DocumentUpdateEventData) => void,
	emitOpenCloseEventsOnMount?: boolean
) => MockedDocumentEventListenerResult

/**
 * `useSWRConfig` is re-exported from SWR and really returns the whole cache configuration.
 * All seven call sites in `src/` destructure `{ mutate }` and nothing else, so the contract
 * is narrowed to that single member — anything more would be fixture surface no consumer reads.
 */
type MockedUseSWRConfigHook = () => { mutate: MockedKeyedMutate }

/**
 * `FrappeCall.get/post/put/delete` (`frappe-js-sdk/lib/call/index.d.ts`). The library types
 * `params` as `Record<string, any>` on `get` and `any` on the other three; every call site in
 * `src/` passes a parameter object, so all four share one narrowed record contract.
 */
type MockedContextRequest = (path: string, params?: Record<string, unknown>) => Promise<unknown>

/** `FrappeDB.getDoc` (`frappe-js-sdk/lib/db/index.d.ts`). */
type MockedContextGetDoc = (doctype: string, docname?: string) => Promise<unknown>

/** `FrappeDB.getDocList`. */
type MockedContextGetDocList = (doctype: string, args?: GetDocListArgs) => Promise<unknown[]>

/** `FrappeDB.getCount`, whose resolution the library fixes to a number. */
type MockedContextGetCount = (
	doctype: string,
	filters?: Filter[],
	debug?: boolean
) => Promise<number>

/** `FrappeDB.createDoc`. */
type MockedContextCreateDoc = (doctype: string, value: unknown) => Promise<unknown>

/** `FrappeDB.updateDoc`, whose `docname` is genuinely nullable. */
type MockedContextUpdateDoc = (
	doctype: string,
	docname: string | null,
	value: unknown
) => Promise<unknown>

/** `FrappeDB.deleteDoc`, whose resolution the library fixes to `{ message }`. */
type MockedContextDeleteDoc = (
	doctype: string,
	docname?: string | null
) => Promise<{ message: string }>

/**
 * `FrappeDB.setValue`. `fieldname` really is `string | object` in the library — one field, or
 * a map of several — so the union is kept rather than simplified away.
 */
type MockedContextSetValue = (
	doctype: string,
	name: string,
	fieldname: string | object,
	value?: unknown
) => Promise<unknown>

/**
 * Axios's progress event, narrowed to the ONE member every upload call site reads —
 * `progress?.progress ?? 0` (`TransferModalContent.tsx:229`,
 * `RecordPaymentModalContent.tsx:364`, `BankEntryModalContent.tsx:317`). Modelled locally so
 * a fixture module never has to import Axios's types.
 */
interface MockedUploadProgressEvent {
	progress?: number
}

/**
 * `FrappeFileUpload.uploadFile` (`frappe-js-sdk/lib/file/index.d.ts`) — the CONTEXT upload,
 * which differs from the hook's `upload` in two ways: it accepts an `onProgress` callback,
 * and it resolves to an Axios response rather than the File document. All three call sites
 * discard the resolved value, so it is `unknown` here for the same reason as above.
 */
type MockedContextUploadFile = (
	file: File,
	args: FileArgs<unknown>,
	onProgress?: (
		bytesUploaded: number,
		totalBytes?: number,
		progress?: MockedUploadProgressEvent
	) => void,
	apiPath?: string
) => Promise<unknown>

/* ─── 8b. Opting in: the rejection, and the contract-valid success payloads ────────────
 * Together these are what make a test non-vacuous: an operation nobody configured rejects
 * with a message that names itself, and a scenario that WANTS a success says so with a
 * payload shaped by the hook's own declared type.
 * ────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The message every unconfigured imperative default rejects with.
 *
 * Exported so a suite can assert positively that a flow it deliberately left unconfigured did
 * NOT quietly succeed, and so anyone meeting the message in a failure report can find its
 * origin by searching for this one constant.
 */
export const UNCONFIGURED_OPERATION_MESSAGE = 'Unconfigured frappe SDK operation'

/**
 * Builds the rejection an unconfigured imperative operation produces.
 *
 * Deliberately a plain `Error` and NOT a {@link makeFrappeError} envelope: this is a test
 * CONFIGURATION fault, not a server refusal. Dressing it as a Frappe error would let it
 * masquerade as exactly the backend rejection a failure-mode suite is supposed to configure
 * for itself — and `getErrorMessages` would render it as though the server had spoken.
 *
 * The `how` hint travels in the message so the fix appears in the failure output itself.
 */
const rejectUnconfigured = (operation: string, how: string): Promise<never> =>
	Promise.reject(
		new Error(
			`${UNCONFIGURED_OPERATION_MESSAGE}: ${operation} ran without a configured implementation, ` +
				`so this test would otherwise have asserted an outcome it never set up. Configure it — ${how}`
		)
	)

/**
 * The success payload of the reconcile post, shaped exactly as its hook declares it:
 * `useFrappePostCall<{ message: BankTransaction }>` (`utils.ts:279`).
 *
 *     frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())
 *
 * Overrides forward to {@link makeBankTransaction}, so the partial-allocation branch is
 * `makeReconcileSuccessResponse({ unallocated_amount: 2500, status: 'Unreconciled' })`.
 */
export const makeReconcileSuccessResponse = (
	overrides: Partial<BankTransaction> = {}
): { message: BankTransaction } => ({ message: makeBankTransaction(overrides) })

/**
 * The success payload of the statement import, shaped exactly as its hook declares it:
 * `useFrappePostCall<{ docs: BankStatementImportLog[] }>('run_doc_method')`
 * (`StatementDetails.tsx:58`).
 *
 * The importer reads `response.docs[0].start_date` and `.end_date` to move the reconciliation
 * date range (`StatementDetails.tsx:78-84`), so the default carries one fully populated log.
 */
export const makeImportSuccessResponse = (
	logs: BankStatementImportLog[] = [makeBankStatementImportLog()]
): { docs: BankStatementImportLog[] } => ({ docs: logs })

/**
 * The File document the hook upload resolves to (`index.d.ts:401-430`). Every member of that
 * interface is required, which is why this builder exists: without it a suite would have to
 * cast, and a cast would discard the very contract {@link MockedFileUpload} establishes.
 *
 * `file_url` is the only member production reads (`pages/BankStatementImporter.tsx:69`, which
 * passes it straight into the import log it then creates), so it is the member most worth
 * overriding.
 */
export const makeFileUploadResponse = (
	overrides: Partial<FrappeFileUploadResponse> = {}
): FrappeFileUploadResponse => ({
	name: 'file-a1b2c3d4e5',
	owner: TEST_USER,
	creation: TEST_CREATION_TIMESTAMP,
	modified: TEST_MODIFIED_TIMESTAMP,
	modified_by: TEST_USER,
	docstatus: 0,
	idx: 0,
	file_name: 'statement.csv',
	is_private: 1,
	is_home_folder: 0,
	is_attachments_folder: 0,
	file_size: 2048,
	file_url: '/private/files/statement.csv',
	folder: 'Home/Attachments',
	is_folder: 0,
	attached_to_doctype: 'Bank Statement Import Log',
	attached_to_name: 'a1b2c3d4e5',
	content_hash: 'd41d8cd98f00b204e9800998ecf8427e',
	uploaded_to_dropbox: 0,
	uploaded_to_google_drive: 0,
	doctype: 'File',
	...overrides
})

/* ─── 8c. The operation spies ──────────────────────────────────────────────────────────
 * Each is created WITH its default implementation rather than having one installed
 * afterwards. That is deliberate: `mockReset()` restores the implementation passed to
 * `vi.fn()`, so {@link resetFrappeSDKMock} needs no second copy of these defaults — and two
 * copies are exactly how a creation default and a reset default drift apart.
 * ────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Stable spy for the keyed revalidation function returned by `useSWRConfig()` — the SPA's global
 * cache-invalidation channel, called on BOTH the success and the failure path, which is how a stale
 * client is corrected after the server refuses a post.
 *
 * This is the SPA's global cache-invalidation channel: the reconcile flow calls it with
 * each affected cache key on BOTH the success and the failure path, which is how a stale
 * client is corrected after the server refuses a post. Assert on it with the exact key
 * strings built in `utils.ts:115,134,150,177,193` — those five families are fixed, and a
 * suite must reuse them rather than reshape them.
 *
 * It RESOLVES by default, unlike the imperative operations below, for two reasons: production
 * chains `.then(...)` straight onto it (`utils.ts:254-255,372-373`), and revalidation is a
 * consequence of a scenario rather than a scenario a suite would forget to configure.
 * Resolving to `undefined` is safe because every continuation guards with `res?.message`.
 */
export const frappeSWRMutate = vi.fn<MockedKeyedMutate>(() => Promise.resolve(undefined))

/**
 * Stable spy for the `mutate` returned by the individual query hooks. Kept distinct from
 * {@link frappeSWRMutate} on purpose: a single shared spy would let a local re-fetch
 * satisfy an assertion that global keyed revalidation had occurred.
 */
export const frappeHookMutate = vi.fn<MockedHookMutate>(() => Promise.resolve(undefined))

/**
 * Stable spy for the `call` returned by `useFrappePostCall`, shared by every post-call
 * site. This is the seam for both posting scenarios:
 *
 *   • success  — `frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())`
 *   • refusal  — `frappePostCall.mockRejectedValue(makeAlreadyReconciledError())`
 *
 * Unconfigured, it REJECTS. Resolving would run the production success handler on a payload
 * the test never supplied — logging an action and toasting "Reconciled" with `res.message`
 * undefined (`utils.ts:313-341`), or navigating away from the importer on a response with no
 * `docs` (`StatementDetails.tsx:77-86`) — and a suite could then assert a success it never
 * configured.
 *
 * When a component holds several post calls and a suite must distinguish them, override
 * the hook instead and branch on its `method` argument:
 * `frappeSDKMock.useFrappePostCall.mockImplementation((method) => …)`.
 */
export const frappePostCall = vi.fn<MockedPostCall>(() =>
	rejectUnconfigured(
		'useFrappePostCall(…).call',
		'frappePostCall.mockResolvedValue(makeReconcileSuccessResponse()) or .mockRejectedValue(makeAlreadyReconciledError())'
	)
)

/**
 * Stable spy for the `createDoc` returned by `useFrappeCreateDoc`. Rejects unconfigured:
 * `pages/BankStatementImporter.tsx:65-73` navigates to `doc.name` straight after it resolves,
 * so an unconfigured success would route the test to `/statement-importer/undefined`.
 */
export const frappeCreateDoc = vi.fn<MockedCreateDoc>(() =>
	rejectUnconfigured(
		'useFrappeCreateDoc().createDoc',
		'frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog())'
	)
)

/** Stable spy for the `updateDoc` returned by `useFrappeUpdateDoc`. Rejects unconfigured. */
export const frappeUpdateDoc = vi.fn<MockedUpdateDoc>(() =>
	rejectUnconfigured(
		'useFrappeUpdateDoc().updateDoc',
		'frappeUpdateDoc.mockResolvedValue(makeSelectedBank())'
	)
)

/**
 * Stable spy for the `upload` returned by `useFrappeFileUpload`. Rejects unconfigured, because
 * `pages/BankStatementImporter.tsx:59-69` feeds `file.file_url` into the import log it creates
 * next — an unconfigured success would silently attach `undefined`.
 */
export const frappeFileUpload = vi.fn<MockedFileUpload>(() =>
	rejectUnconfigured(
		'useFrappeFileUpload().upload',
		'frappeFileUpload.mockResolvedValue(makeFileUploadResponse())'
	)
)

/**
 * Stable spies for the emitters returned by `useFrappeDocumentEventListener`.
 *
 * No-ops rather than rejections: nothing in `src/` calls either one, so there is no scenario
 * a suite could forget to configure, and a rejection would only be able to fire from code that
 * does not exist. Both are still spies so a future caller is observable.
 */
const frappeEmitDocOpen = vi.fn<MockedDocEventEmitter>(() => undefined)
const frappeEmitDocClose = vi.fn<MockedDocEventEmitter>(() => undefined)

/**
 * Realtime subscriptions recorded by the `useFrappeEventListener` stub, keyed by channel. The most
 * recent callback for a channel replaces any earlier one, which mirrors the real hook and stops
 * {@link emitFrappeEvent} invoking a closure captured by an earlier render.
 *
 * LIFETIME: the map is module-level, so it outlives any component and React's unmount cleanup leaves
 * entries behind. {@link resetFrappeSDKMock} empties it from the harness's shared teardown, so no
 * test inherits a callback closed over a previous test's tree.
 */
const frappeEventListeners = new Map<string, (eventData: unknown) => void>()

export const getFrappeEventListener = (
	eventName: string
): ((eventData: unknown) => void) | undefined => frappeEventListeners.get(eventName)

/**
 * Delivers a realtime payload to the handler subscribed to `eventName`, simulating a server push.
 *
 * The `act()` wrapper is the CALLER's responsibility: the handler sets React state, and wrapping
 * here would impose act semantics on every caller and hide the update from the test's own batching.
 *
 * Throws when nothing is subscribed, rather than silently doing nothing — a no-op would let a suite
 * believe it had simulated progress the component never received.
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
 * The value carried by {@link FrappeContextMock}.
 *
 * A real context with a real default is required because the SPA reads it as
 * `useContext(FrappeContext) as FrappeConfig` and immediately DESTRUCTURES a member. With the
 * library's own `null` default, or with a non-context stand-in, the first lazily loaded modal
 * body to mount would throw before rendering anything.
 *
 * WHICH modules do that is deliberately not tallied here, because a hand-maintained count goes
 * stale the moment a call site moves and then misinforms the next reader. Regenerate it instead:
 *
 *     grep -rn 'useContext(FrappeContext)' src/ | grep -v src/test/
 *
 * The MEMBERS those modules reach for are `call.get`, `db.getDoc`, `db.getCount`, `db.setValue`,
 * `db.deleteDoc` and `file.uploadFile` (the last reached through a `file: frappeFile` alias), and
 * that list is the part worth writing down, because it is what this mock has to satisfy. Naming the modules themselves is left to the command above
 * on purpose: the set changed during this very piece of work - the reconciliation hook layer
 * joined it once the rule-evaluation watcher began counting unevaluated transactions - which is
 * exactly how a written-down tally turns into misinformation. The rest of the surface is mirrored
 * anyway so that a component reaching for one finds a spy rather than `undefined`.
 *
 * EVERY imperative member below rejects when unconfigured - all four `call.*`, all seven `db.*`
 * and `file.uploadFile`. Each is reached from a user-event handler rather than from mount: a
 * party change, a rule-list action inside `toast.promise`, a submit handler, the import step's
 * own document-method call. So none of them runs while a component is simply rendered, and a
 * rejection can only surface once a test drives the flow it left unconfigured. The read-shaped
 * members (`db.getDoc`, `db.getDocList`, `db.getCount`) reject for the same reason as the rest:
 * an unconfigured `[]` or `0` is indistinguishable from a real answer and could satisfy an
 * assertion by accident. Only the SWR-backed READ HOOKS keep empty-data defaults, because a
 * component must be able to mount before a suite has configured anything.
 */
export const frappeContextValue = {
	call: {
		get: vi.fn<MockedContextRequest>((path) =>
			rejectUnconfigured(
				`FrappeContext call.get("${path}")`,
				'frappeContextValue.call.get.mockResolvedValue({ message: … })'
			)
		),
		post: vi.fn<MockedContextRequest>((path) =>
			rejectUnconfigured(
				`FrappeContext call.post("${path}")`,
				'frappeContextValue.call.post.mockResolvedValue({ message: … })'
			)
		),
		put: vi.fn<MockedContextRequest>((path) =>
			rejectUnconfigured(
				`FrappeContext call.put("${path}")`,
				'frappeContextValue.call.put.mockResolvedValue({ message: … })'
			)
		),
		delete: vi.fn<MockedContextRequest>((path) =>
			rejectUnconfigured(
				`FrappeContext call.delete("${path}")`,
				'frappeContextValue.call.delete.mockResolvedValue({ message: … })'
			)
		)
	},
	db: {
		getDoc: vi.fn<MockedContextGetDoc>((doctype) =>
			rejectUnconfigured(
				`FrappeContext db.getDoc("${doctype}")`,
				'frappeContextValue.db.getDoc.mockResolvedValue(makeBankTransaction())'
			)
		),
		getDocList: vi.fn<MockedContextGetDocList>((doctype) =>
			rejectUnconfigured(
				`FrappeContext db.getDocList("${doctype}")`,
				'frappeContextValue.db.getDocList.mockResolvedValue([makeBankTransaction()])'
			)
		),
		getCount: vi.fn<MockedContextGetCount>((doctype) =>
			rejectUnconfigured(
				`FrappeContext db.getCount("${doctype}")`,
				'frappeContextValue.db.getCount.mockResolvedValue(0)'
			)
		),
		createDoc: vi.fn<MockedContextCreateDoc>((doctype) =>
			rejectUnconfigured(
				`FrappeContext db.createDoc("${doctype}")`,
				'frappeContextValue.db.createDoc.mockResolvedValue(makeBankStatementImportLog())'
			)
		),
		updateDoc: vi.fn<MockedContextUpdateDoc>((doctype) =>
			rejectUnconfigured(
				`FrappeContext db.updateDoc("${doctype}")`,
				'frappeContextValue.db.updateDoc.mockResolvedValue(makeSelectedBank())'
			)
		),
		deleteDoc: vi.fn<MockedContextDeleteDoc>((doctype) =>
			rejectUnconfigured(
				`FrappeContext db.deleteDoc("${doctype}")`,
				"frappeContextValue.db.deleteDoc.mockResolvedValue({ message: 'ok' })"
			)
		),
		setValue: vi.fn<MockedContextSetValue>((doctype) =>
			rejectUnconfigured(
				`FrappeContext db.setValue("${doctype}")`,
				'frappeContextValue.db.setValue.mockResolvedValue(makeBankTransaction())'
			)
		)
	},
	file: {
		uploadFile: vi.fn<MockedContextUploadFile>(() =>
			rejectUnconfigured(
				'FrappeContext file.uploadFile',
				'frappeContextValue.file.uploadFile.mockResolvedValue(makeFileUploadResponse())'
			)
		)
	}
}

/**
 * The replacement for the SDK's `FrappeContext`, created once at module scope so every consumer in a
 * suite's module graph shares one identity; a fresh context per call would hand `useContext` the
 * default value instead of a provided one.
 */
export const FrappeContextMock = createContext(frappeContextValue)

/**
 * A pass-through replacement for `FrappeProvider`, so a suite can mount `App`-shaped trees without a
 * server, a socket or a site name.
 */
export const FrappeProviderMock = ({ children }: { children?: ReactNode }) =>
	createElement(Fragment, null, children)

/**
 * The "no data yet" answer every SWR-backed READ hook gives until a suite configures one.
 *
 * A fresh object per call, matching the real hooks, which also return a new response object
 * each render. `data: undefined` with `error: undefined` and `isLoading: false` is the state
 * that lets any component mount and render its empty state without configuration.
 */
const emptyQueryResponse = (): MockedQueryResponse => ({
	data: undefined,
	error: undefined,
	isLoading: false,
	isValidating: false,
	mutate: frappeHookMutate
})

/**
 * The eleven SDK hooks, as stable spies — each typed by its contract from §8a and created
 * with its default implementation already in place.
 *
 * Exported so a suite can override any single hook's return without re-mocking the module:
 *
 *     frappeSDKMock.useFrappeGetCall.mockImplementation((method) =>
 *         method.endsWith('get_bank_transactions')
 *             ? { data: { message: [makeUnreconciledTransaction()] }, error: undefined,
 *                 isLoading: false, isValidating: false, mutate: frappeHookMutate }
 *             : emptyQueryResponse())
 *
 * Branching on the method (rather than a blanket `mockReturnValue`) matters because a
 * single render reaches `useFrappeGetCall` many times with different endpoints — and because
 * the contracts type that `method` argument as a `string`, a branch on a misspelt or
 * wrongly-typed argument now fails to compile instead of silently never matching.
 *
 * The four query hooks answer empty; the imperative hooks answer with their result object,
 * whose operation spy rejects until configured (§8b). The hooks THEMSELVES never reject:
 * a hook that threw could not be rendered at all.
 */
export const frappeSDKMock = {
	useFrappeGetCall: vi.fn<MockedGetCallHook>(() => emptyQueryResponse()),
	useFrappeGetDoc: vi.fn<MockedGetDocHook>(() => emptyQueryResponse()),
	useFrappeGetDocList: vi.fn<MockedGetDocListHook>(() => emptyQueryResponse()),

	// The count hook's payload is a `number`, so its empty answer is spelt out rather than
	// reusing `emptyQueryResponse()`, whose payload type is `unknown`.
	useFrappeGetDocCount: vi.fn<MockedGetDocCountHook>(() => ({
		data: undefined,
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: frappeHookMutate
	})),

	// `error: null` on the imperative hooks, matching the SDK, which initialises them with
	// `null` rather than leaving them undefined. Neither create nor update carries a
	// `result` member — the library does not declare one, so none is invented here.
	useFrappePostCall: vi.fn<MockedPostCallHook>(() => ({
		call: frappePostCall,
		result: null,
		loading: false,
		error: null,
		isCompleted: false,
		reset: vi.fn<() => void>(() => undefined)
	})),
	useFrappeCreateDoc: vi.fn<MockedCreateDocHook>(() => ({
		createDoc: frappeCreateDoc,
		loading: false,
		error: null,
		isCompleted: false,
		reset: vi.fn<() => void>(() => undefined)
	})),
	useFrappeUpdateDoc: vi.fn<MockedUpdateDocHook>(() => ({
		updateDoc: frappeUpdateDoc,
		loading: false,
		error: null,
		isCompleted: false,
		reset: vi.fn<() => void>(() => undefined)
	})),

	// `progress` completes the library's shape and is read by the importer's upload UI.
	useFrappeFileUpload: vi.fn<MockedFileUploadHook>(() => ({
		upload: frappeFileUpload,
		progress: 0,
		loading: false,
		error: null,
		isCompleted: false,
		reset: vi.fn<() => void>(() => undefined)
	})),

	// Records the subscription so `emitFrappeEvent` can drive it, and returns `void` just as
	// the real hook does.
	useFrappeEventListener: vi.fn<MockedEventListenerHook>((eventName, callback) => {
		frappeEventListeners.set(eventName, callback)
	}),

	useFrappeDocumentEventListener: vi.fn<MockedDocumentEventListenerHook>(() => ({
		viewers: [],
		emitDocOpen: frappeEmitDocOpen,
		emitDocClose: frappeEmitDocClose
	})),

	useSWRConfig: vi.fn<MockedUseSWRConfigHook>(() => ({ mutate: frappeSWRMutate }))
}

/**
 * The one member {@link resetFrappeSDKMock} needs from a spy, whatever that spy's signature
 * happens to be. Declared structurally so a heterogeneous collection of `Mock<…>` values can
 * be swept in a single pass without casting any of them to a common mock type.
 */
interface ResettableSpy {
	mockReset: () => unknown
}

/** Applies `mockReset()` across a list of spies whose signatures all differ. */
const resetSpies = (spies: ResettableSpy[]): void => {
	spies.forEach((spy) => {
		spy.mockReset()
	})
}

/**
 * Clears every recorded call and per-test override, restoring each spy to the default it was
 * CREATED with, and drops all realtime subscriptions.
 *
 * Note what is deliberately absent: a second copy of the defaults. `mockReset()` restores the
 * implementation passed to `vi.fn()`, so the inline defaults in §8b/§8c ARE the reset
 * defaults. Re-installing them here from a separate list is precisely how a creation default
 * and a reset default drift apart — and how a spy ends up behaving differently in the first
 * test of a file than in every test after it.
 *
 * `src/test/setup.ts` calls this from its shared `afterEach`, immediately after `cleanup()`, so
 * no suite has to opt in - the realtime-listener stub records callbacks in a module-level map
 * that React's unmount cleanup does not remove. Because it also discards per-test
 * implementations, install those from a suite's own `beforeEach` (or inside the test) rather
 * than at `describe` or module scope, which runs once at collection time.
 */
export const resetFrappeSDKMock = (): void => {
	frappeEventListeners.clear()

	resetSpies([
		frappeSWRMutate,
		frappeHookMutate,
		frappePostCall,
		frappeCreateDoc,
		frappeUpdateDoc,
		frappeFileUpload,
		frappeEmitDocOpen,
		frappeEmitDocClose
	])

	// `Object.values` rather than a hand-written list, so a symbol added to either object is
	// swept automatically instead of being silently left holding a previous test's override.
	resetSpies(Object.values(frappeSDKMock))
	resetSpies(Object.values(frappeContextValue.call))
	resetSpies(Object.values(frappeContextValue.db))
	resetSpies(Object.values(frappeContextValue.file))
}

/**
 * The exact surface {@link createFrappeSDKMock} hands back in place of `frappe-react-sdk`:
 * the eleven hook spies of {@link frappeSDKMock} plus {@link FrappeContextMock} and
 * {@link FrappeProviderMock} — the thirteen runtime symbols enumerated in this module's
 * header, and nothing else.
 *
 * Naming that surface is what lets the helper's `overrides` parameter be a typed partial of
 * it instead of an open generic: the compiler then restricts an override to a symbol some
 * module under `src/` genuinely imports, and to that symbol's real shape, so no type
 * assertion is needed anywhere in the signature — `{}` satisfies a fully-optional type on
 * its own. When the SPA starts importing a further SDK symbol it is added to
 * {@link frappeSDKMock} above, where every suite picks it up at once; that is the whole
 * point of there being ONE shared mock, and it is why an override must not be able to
 * introduce a symbol privately.
 */
export type FrappeSDKMockExports = typeof frappeSDKMock & {
	FrappeContext: typeof FrappeContextMock
	FrappeProvider: typeof FrappeProviderMock
}

/**
 * THE shared module mock — what a `vi.mock` factory hands back in place of `frappe-react-sdk`. It
 * exposes the eleven hook spies plus `FrappeContext` and `FrappeProvider`, and none of the four
 * type-only symbols. The spies are the same identities exported above.
 *
 *     vi.mock('frappe-react-sdk', () => createFrappeSDKMock())
 *
 * It exposes the thirteen runtime symbols and none of the four type-only ones. The spies
 * are the same identities exported above, so a suite mocks and asserts through
 * {@link frappeSDKMock}, {@link frappePostCall} and {@link frappeSWRMutate} without
 * re-deriving anything.
 *
 * `overrides` is an escape hatch for the rare suite that needs to replace one of those
 * symbols outright without forking this helper. It is optional, and it is spread LAST, so
 * it always wins.
 */
export const createFrappeSDKMock = (
	overrides: Partial<FrappeSDKMockExports> = {}
): FrappeSDKMockExports => ({
	...frappeSDKMock,
	FrappeContext: FrappeContextMock,
	FrappeProvider: FrappeProviderMock,
	...overrides
})
