/**
 * Typed fixture builders and the one shared `frappe-react-sdk` module mock for the Banking SPA's
 * Vitest suites. They live here once because a fixture hand-rolled per suite drifts from the contract
 * it models, and a wrong field name or payload shape silently invalidates every assertion built on it.
 *
 * Every builder takes a `Partial<T>` of overrides and spreads it LAST, so a caller can always replace
 * any default, including replacing it with `undefined`. Return types are annotated with the real
 * application types, which is what makes "never invent a field" enforced by `tsc -b` rather than
 * merely promised.
 *
 * The identity constants restate the values `src/test/setup.ts` seeds, because a company or currency
 * name that is not a `locals` key resolves to `undefined` or falls back silently instead of failing.
 */

import { vi } from 'vitest'

import { createContext, createElement, Fragment, type ReactNode } from 'react'

import type { LinkedPayment, UnreconciledTransaction } from '@/components/features/BankReconciliation/utils'
import type { SelectedBank } from '@/components/features/BankReconciliation/bankRecAtoms'
import type { BankTransaction } from '@/types/Accounts/BankTransaction'
import type { BankTransactionPayments } from '@/types/Accounts/BankTransactionPayments'
import type { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'
import type { BankTransactionRule } from '@/types/Accounts/BankTransactionRule'
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

export const TEST_COMPANY_COST_CENTER = 'Main - TC'

export const TEST_ALTERNATE_CURRENCY = 'USD'

export const TEST_USER = 'Administrator'

export const TEST_BANK_ACCOUNT = 'Test Bank - Test Company'

export const TEST_BANK = 'Test Bank'

export const TEST_BANK_LEDGER_ACCOUNT = 'Test Bank - TC'

export const TEST_TRANSACTION_RULE = 'BTR-0001'

export const TEST_TRANSACTION_DATE = '2024-01-15'

export const TEST_ALTERNATE_DATE = '2024-01-09'

export const TEST_TRANSACTION_AMOUNT = 12500

const TEST_ALTERNATE_AMOUNT = 8750

export const TEST_REFERENCE_NUMBER = 'NEFT/2024/000145'

/**
 * The override voucher's `reference_no`, chosen so it is neither equal to nor a SUBSTRING of
 * {@link TEST_REFERENCE_NUMBER} or of the base description — otherwise it would read as a partial
 * match instead of "No Match".
 */
const TEST_ALTERNATE_REFERENCE_NUMBER = 'JV-ADJ-2024-0007'

export const TEST_TRANSACTION_DESCRIPTION = 'NEFT credit from ACME Traders'

const TEST_CREATION_TIMESTAMP = '2024-01-15 10:30:00.000000'

const TEST_MODIFIED_TIMESTAMP = '2024-01-15 10:31:12.000000'

/* ═══ 2. Bank transactions ═════════════════════════════════════════════════
 * `UnreconciledTransaction` is a `Pick` over fifteen of the sixteen columns `get_bank_transactions`
 * projects, omitting `allocated_amount`. The builder below models that CONSUMER projection, so a suite
 * needing the allocated figure belongs on {@link makeBankTransaction} instead. Both `status` and
 * `unallocated_amount` are in the picked set, which is why the client-side already-reconciled guard
 * needs no extra read.
 * ════════════════════════════════════════════════════════════════════════════════ */

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
 * A transaction the server considers FULLY RECONCILED. Both signals are set because the server derives
 * `status` from `unallocated_amount`; setting only one would model a state it cannot produce.
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
 * A transaction denominated in {@link TEST_ALTERNATE_CURRENCY}, for the currency-mismatch advisory.
 * Pair it with a {@link makeBankAccountListRow} whose `account_currency` is {@link TEST_CURRENCY} -
 * that endpoint response, not the persisted selection, is what the advisory compares against.
 *
 * The advisory itself never blocks, so a suite mocks whichever post response it intends to exercise.
 * The server does refuse a mismatch: `Bank Transaction` runs `validate_currency` from
 * `before_update_after_submit` as well as `validate`, and the reconcile path saves an already-submitted
 * document, so the refusal arrives as an ordinary rejection on that path.
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
 * The `Bank Transaction Payments` child row a reconciliation writes — the only place an allocation
 * physically lives. `update_allocated_amount` recomputes the parent's `allocated_amount` as the sum of
 * these rows on every save, so a parent claiming an allocation with no child row underneath it is a
 * document the controller cannot emit.
 *
 * THE ALLOCATED FIGURE IS THE SERVER'S. `add_payment_entries` reads only the voucher's doctype and
 * name out of the request and appends the row at `0.0`; `allocate_payment_entries` then computes the
 * real figure from the voucher's GL entries. The `amount` the client sends alongside those two
 * identity fields is ignored, so this value models what the server derived and is never evidence that
 * a client-supplied figure was honoured.
 */
export const makeBankTransactionPayment = (
	overrides: Partial<BankTransactionPayments> = {}
): BankTransactionPayments => ({
	name: 'btp-a1b2c3d4e5',
	creation: TEST_CREATION_TIMESTAMP,
	modified: TEST_MODIFIED_TIMESTAMP,
	owner: TEST_USER,
	modified_by: TEST_USER,
	docstatus: 1,
	parent: 'ACC-BTN-2024-00001',
	parentfield: 'payment_entries',
	parenttype: 'Bank Transaction',
	idx: 1,
	payment_document: 'Payment Entry',
	payment_entry: 'ACC-PAY-2024-00001',
	allocated_amount: TEST_TRANSACTION_AMOUNT,
	clearance_date: TEST_TRANSACTION_DATE,
	reconciliation_type: 'Matched',
	...overrides
})

/**
 * The three relations `Bank Transaction` maintains between its amount columns, its child rows and its
 * status, asserted at construction so a suite cannot build a document the server could never produce:
 *
 *   1. `allocated_amount === sum(payment_entries[].allocated_amount)`
 *   2. `allocated_amount + unallocated_amount === abs(withdrawal - deposit)`
 *   3. for a SUBMITTED document, `status` is `Reconciled` when `unallocated_amount <= 0`
 *
 * (1) and (2) come from `update_allocated_amount`, (3) from `set_status`, which derives a draft or
 * cancelled document's status from `docstatus` alone. Throwing rather than silently correcting is
 * deliberate: quietly reshaping the fixture would leave a wrong mental model of the contract intact
 * while making the test pass.
 */
const assertBankTransactionInvariants = (transaction: BankTransaction): void => {
	const allocated = transaction.allocated_amount ?? 0
	const unallocated = transaction.unallocated_amount ?? 0
	const childTotal = (transaction.payment_entries ?? []).reduce(
		(total, row) => total + (row.allocated_amount ?? 0),
		0
	)
	const transactionAmount = Math.abs((transaction.withdrawal ?? 0) - (transaction.deposit ?? 0))

	if (allocated !== childTotal) {
		throw new Error(
			`makeBankTransaction: allocated_amount (${allocated}) must equal the sum of ` +
				`payment_entries allocations (${childTotal}) — update_allocated_amount recomputes it ` +
				'from the child rows on every save, so pass matching `payment_entries`.'
		)
	}

	if (allocated + unallocated !== transactionAmount) {
		throw new Error(
			`makeBankTransaction: allocated_amount + unallocated_amount (${allocated + unallocated}) ` +
				`must equal abs(withdrawal - deposit) (${transactionAmount}). Override ONE of the two ` +
				'allocation figures and let the builder derive the other.'
		)
	}

	if (transaction.docstatus === 1) {
		const derivedStatus = unallocated > 0 ? 'Unreconciled' : 'Reconciled'
		if (transaction.status !== derivedStatus) {
			throw new Error(
				`makeBankTransaction: a submitted transaction with unallocated_amount ${unallocated} ` +
					`has status "${derivedStatus}", not "${transaction.status}" — set_status derives the ` +
					'status from the unallocated amount, so the two cannot be set independently.'
			)
		}
	}
}

/**
 * Builds a COMPLETE `Bank Transaction` document, as distinct from the fifteen-field client projection
 * above; this is the builder that carries `allocated_amount`. Defaults model the response to a
 * successful full reconciliation.
 *
 * `allocated_amount`, `unallocated_amount`, `status` and the `payment_entries` child rows are four
 * views of ONE fact, so a caller overrides one of them and the rest follow:
 *
 *     makeBankTransaction({ unallocated_amount: 2500 })   // partial: allocated 10000, one child row
 *     makeBankTransaction({ allocated_amount: 0 })        // untouched: unallocated 12500, no rows
 *
 * Supplying `payment_entries` explicitly opts out of the derivation and takes ownership of the
 * figures. Either way the result is checked against {@link assertBankTransactionInvariants} before it
 * is returned, so an impossible document throws here rather than being asserted against downstream.
 */
export const makeBankTransaction = (overrides: Partial<BankTransaction> = {}): BankTransaction => {

	const deposit = overrides.deposit ?? TEST_TRANSACTION_AMOUNT
	const withdrawal = overrides.withdrawal ?? 0
	const transactionAmount = Math.abs(withdrawal - deposit)

	// Precedence runs from the most specific statement of intent to the least: the child rows ARE the
	// allocation, an explicit `allocated_amount` states it directly, and `unallocated_amount` states its
	// complement.
	const allocatedFromChildren = overrides.payment_entries
		? overrides.payment_entries.reduce((total, row) => total + (row.allocated_amount ?? 0), 0)
		: undefined

	const allocated = allocatedFromChildren
		?? overrides.allocated_amount
		?? (overrides.unallocated_amount === undefined
			? transactionAmount
			: transactionAmount - overrides.unallocated_amount)

	const unallocated = transactionAmount - allocated

	// A figure supplied ALONGSIDE a more specific one is checked against it rather than silently
	// superseded, so a caller who supplied two inputs that disagree hears about it instead of quietly
	// receiving a different document than the one the test describes.
	if (
		allocatedFromChildren !== undefined
		&& overrides.allocated_amount !== undefined
		&& overrides.allocated_amount !== allocatedFromChildren
	) {
		throw new Error(
			`makeBankTransaction: allocated_amount (${overrides.allocated_amount}) must equal the sum of ` +
				`payment_entries allocations (${allocatedFromChildren}) — update_allocated_amount recomputes ` +
				'it from the child rows on every save, so supply one or the other, not both.'
		)
	}

	if (overrides.unallocated_amount !== undefined && overrides.unallocated_amount !== unallocated) {
		throw new Error(
			'makeBankTransaction: allocated_amount + unallocated_amount ' +
				`(${allocated + overrides.unallocated_amount}) must equal abs(withdrawal - deposit) ` +
				`(${transactionAmount}). Override ONE of the two allocation figures and let the builder ` +
				'derive the other.'
		)
	}

	const paymentEntries = overrides.payment_entries
		?? (allocated > 0
			? [makeBankTransactionPayment({
				parent: overrides.name ?? 'ACC-BTN-2024-00001',
				allocated_amount: allocated
			})]
			: [])

	const docstatus = overrides.docstatus ?? 1

	const transaction: BankTransaction = {
		name: 'ACC-BTN-2024-00001',
		creation: TEST_CREATION_TIMESTAMP,
		modified: TEST_MODIFIED_TIMESTAMP,
		owner: TEST_USER,
		modified_by: TEST_USER,
		naming_series: 'ACC-BTN-.YYYY.-',
		date: TEST_TRANSACTION_DATE,
		bank_account: TEST_BANK_ACCOUNT,
		company: TEST_COMPANY,
		currency: TEST_CURRENCY,
		description: TEST_TRANSACTION_DESCRIPTION,
		reference_number: TEST_REFERENCE_NUMBER,
		transaction_type: 'NEFT',
		party_type: 'Customer',
		party: 'ACME Traders',
		is_rule_evaluated: 1,
		...overrides,
		// The derived figures come AFTER the spread, because they are what the server would have
		// written for the amounts the caller asked for.
		docstatus,
		deposit,
		withdrawal,
		allocated_amount: allocated,
		unallocated_amount: unallocated,
		payment_entries: paymentEntries,
		// An explicit `status` is HONOURED rather than overwritten, so a caller who states one the
		// allocation contradicts is told so by the invariant check below. Absent an override it is derived
		// as `set_status` derives it: from the unallocated amount when submitted, from `docstatus`
		// otherwise.
		status: overrides.status
			?? (docstatus === 1
				? (unallocated > 0 ? 'Unreconciled' : 'Reconciled')
				: docstatus === 2 ? 'Cancelled' : 'Pending')
	}

	assertBankTransactionInvariants(transaction)

	return transaction
}

/**
 * The bank account held in `selectedBankAccountAtom`.
 *
 * `account_currency` is not a native `Bank Account` field: `bank_account.get_list` derives it at query
 * time by following `Bank Account.account` to `Account.account_currency`, which is why both the
 * response row and `SelectedBank` type it as optional. Override it to model an unresolved currency.
 *
 * A suite that replaces the `offsetWidth`/`offsetHeight` getters to give a virtualized list a non-zero
 * viewport must restore those property spies itself — the shared teardown resets this module's spies,
 * not property getters.
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
	integration_id: undefined,
	last_integration_date: undefined,
	account_currency: TEST_CURRENCY,
	...overrides
})

/**
 * ONE ROW OF `bank_account.get_list`, exactly as that endpoint projects it — the fixture for a SERVER
 * RESPONSE, as distinct from {@link makeSelectedBank}, which models the PERSISTED selection.
 *
 * The two shapes are not interchangeable, and they differ in both directions: `integration_id` is on
 * `SelectedBank` but is not projected here, while `account_subtype` is projected here but is absent
 * from `SelectedBank`. The logo members are likewise absent by design, because `useGetBankAccounts`
 * adds them client-side and a fixture that pre-supplied them could not detect the resolution failing.
 *
 * `order_by` is `is_default desc`, so the first row of a multi-row answer is the company's default
 * account. Override `account_currency` with `null` to model a row whose GL account carries no
 * currency: the endpoint always attaches the key and `Account.account_currency` is itself nullable, so
 * `null` is what arrives, and the currency advisory must read it as "nothing to compare".
 *
 * The row type is declared here rather than imported because `utils.ts` keeps
 * `BankAccountWithCurrency` module-private.
 */
interface BankAccountListRow {
	name: string
	account?: string
	company?: string
	account_name?: string
	is_default?: 0 | 1
	bank?: string
	account_type?: string
	account_subtype?: string
	bank_account_no?: string
	last_integration_date?: string
	is_credit_card?: 0 | 1
	/**
	 * REQUIRED and NULLABLE, matching the endpoint rather than the persisted selection: the endpoint
	 * attaches this key to every row in an unconditional loop, and `Account.account_currency` is itself
	 * nullable. Optional would let a suite omit the key entirely — a response this endpoint cannot
	 * produce — and would erase the difference from `SelectedBank`, where a stored snapshot may
	 * genuinely predate the key.
	 */
	account_currency: string | null
}

export const makeBankAccountListRow = (
	overrides: Partial<BankAccountListRow> = {}
): BankAccountListRow => ({
	name: TEST_BANK_ACCOUNT,
	account: TEST_BANK_LEDGER_ACCOUNT,
	company: TEST_COMPANY,
	account_name: 'Test Bank Current Account',
	is_default: 1,
	bank: TEST_BANK,
	account_type: 'Bank',
	account_subtype: 'Current',
	bank_account_no: '000123456789',
	// Supplied only for accounts fed by an external banking integration; this row models a manually
	// maintained account, so this fixture supplies no integration timestamp.
	last_integration_date: undefined,
	is_credit_card: 0,
	account_currency: TEST_CURRENCY,
	...overrides
})

/**
 * The match indicators each branch of `get_linked_payments` sums into its `rank` column, read off the
 * five rank expressions in `bank_reconciliation_tool.py`, each of them `(<indicators summed> + 1)`:
 *
 *   Bank Transaction  ref + amount + party + unallocated + 1   -> 1..5
 *   Payment Entry     ref + amount + party + 1                 -> 1..4
 *   Journal Entry     ref + amount + 1                         -> 1..3
 *   Sales Invoice     ref + party + amount + 1                 -> 1..4
 *   Purchase Invoice  party + amount + 1                       -> 1..3
 *
 * So `rank` is not a score on a common scale — the same quality of match ranks 4 as a Payment Entry
 * and 3 as a Journal Entry — and a Purchase Invoice can never earn a reference point, because that
 * branch projects a constant empty reference.
 */
const LINKED_PAYMENT_RANK_INDICATORS = {
	'Bank Transaction': ['reference', 'amount', 'party', 'unallocated'],
	'Payment Entry': ['reference', 'amount', 'party'],
	'Journal Entry': ['reference', 'amount'],
	'Sales Invoice': ['reference', 'party', 'amount'],
	'Purchase Invoice': ['party', 'amount']
} as const satisfies Record<string, readonly LinkedPaymentRankIndicator[]>

type LinkedPaymentRankIndicator = 'reference' | 'amount' | 'party' | 'unallocated'

type LinkedPaymentBranch = keyof typeof LINKED_PAYMENT_RANK_INDICATORS

const linkedPaymentRank = (
	branch: LinkedPaymentBranch,
	matched: Partial<Record<LinkedPaymentRankIndicator, boolean>> = {}
): number =>
	1 + LINKED_PAYMENT_RANK_INDICATORS[branch].filter((indicator) => matched[indicator] === true).length

/**
 * Orders candidate vouchers the way the endpoint hands them over: `check_matching` concatenates every
 * branch's rows and sorts on `rank` descending. Both Python's `sorted` and `Array.prototype.sort` are
 * stable, so comparing on rank alone reproduces that ordering, including how it leaves equal-rank rows
 * in branch-emission order.
 *
 * Suites should pass their fixtures through this rather than writing an order out by hand, because the
 * suggestion predicate additionally requires `index === 0`.
 */
export const sortLinkedPaymentsAsEndpoint = (vouchers: LinkedPayment[]): LinkedPayment[] =>
	[...vouchers].sort((left, right) => right.rank - left.rank)

export const makeLinkedPayment = (overrides: Partial<LinkedPayment> = {}): LinkedPayment => ({
	rank: linkedPaymentRank('Payment Entry', { reference: true, amount: true, party: true }),
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
 * The voucher a given transaction SUGGESTS, built by copying the compared fields off that transaction
 * so it stays suggested by construction even for a transaction whose amount or date a suite overrode.
 *
 * `reference_no` falls back with `||`, not `??`, so a transaction whose own `reference_number` is blank
 * still yields a voucher that agrees on something. That is why the blank and null reference cases have
 * their own builders below rather than being reached by overriding this one.
 */
export const makeSuggestedLinkedPayment = (
	transaction: UnreconciledTransaction,
	overrides: Partial<LinkedPayment> = {}
): LinkedPayment =>
	makeLinkedPayment({
		rank: linkedPaymentRank('Payment Entry', { reference: true, amount: true, party: true }),
		paid_amount: transaction.unallocated_amount ?? TEST_TRANSACTION_AMOUNT,
		posting_date: transaction.date ?? TEST_TRANSACTION_DATE,
		reference_date: transaction.date ?? TEST_TRANSACTION_DATE,
		reference_no: transaction.reference_number || TEST_REFERENCE_NUMBER,
		currency: transaction.currency ?? TEST_CURRENCY,
		party_type: transaction.party_type ?? 'Customer',
		party: transaction.party ?? 'ACME Traders',
		...overrides
	})

export const makeAlternateLinkedPayment = (overrides: Partial<LinkedPayment> = {}): LinkedPayment =>
	makeLinkedPayment({
		rank: linkedPaymentRank('Journal Entry'),
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
 * A PURCHASE INVOICE row exactly as `get_linked_payments` returns one: both reference columns are the
 * literal empty string, because that branch selects a constant for `reference_no` and `reference_date`
 * alike. It is the Purchase Invoice branch specifically — Sales Invoice blanks only the reference date
 * and projects a real, nullable `reference_no` — so pass `reference_no` explicitly to model that half.
 *
 * The amount deliberately agrees with {@link makeUnreconciledTransaction}, which lets a suite assert
 * the badge grid against a shape the endpoint really produces rather than only against tidy ones.
 */
export const makeBlankReferenceLinkedPayment = (overrides: Partial<LinkedPayment> = {}): LinkedPayment =>
	makeLinkedPayment({
		rank: linkedPaymentRank('Purchase Invoice', { amount: true }),
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
 * The rule DOCUMENT behind a `matched_transaction_rule` stamp, as distinct from the stamp itself,
 * which is a single field on the transaction row. Every field the workbench renders is populated by
 * default, and `name` matches {@link TEST_TRANSACTION_RULE} so this document and
 * {@link makeRuleMatchedTransaction} line up without either being overridden.
 *
 * Defaults follow the DocType: `transaction_type` is its declared `"Any"`, and `description_rules` is
 * present because that table is required — a rule with no condition rows is a document the server
 * cannot produce. `classify_as` has exactly three values and each routes the reviewer to a DIFFERENT
 * modal, so a suite exercising that routing must override it rather than assume the default.
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
 * A statement import log row. `status` has exactly TWO values — `"Not Started" | "Completed"` — and
 * the DocType carries no error field of any kind, which is why the per-file failure indicator is
 * driven from {@link makeImportFailures} rather than from the document.
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

/* `getErrorMessages` resolves a refusal in a fixed ORDER: parsed `_server_messages` first, then an
 * appended `_error_message`, then the text after the first colon of `exception`, then the bare
 * `message`. The fixtures below cover one path each.
 *
 * `_error_message` is not a member of the public `FrappeError` type, so each envelope is built as a
 * plain object and cast EXACTLY ONCE, which keeps this file free of `ts-expect-error`. */

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
 * Assembles a Frappe error envelope and performs the single type assertion this module needs. Defaults
 * describe a `frappe.throw`: HTTP 417 with an EMPTY `exception`, the "no exception reported" state.
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

export const makeServerMessagesError = (
	message: string,
	overrides: Partial<FrappeErrorPayload> = {}
): FrappeError =>
	makeFrappeError({
		_server_messages: encodeServerMessage({ message, title: 'Message', indicator: 'red' }),
		exception: `frappe.exceptions.ValidationError: ${message}`,
		...overrides
	})

export const makeWarningServerMessagesError = (
	message: string,
	overrides: Partial<FrappeErrorPayload> = {}
): FrappeError =>
	makeFrappeError({
		_server_messages: encodeServerMessage({ message, title: 'Message', indicator: 'yellow' }),
		exception: `frappe.exceptions.ValidationError: ${message}`,
		...overrides
	})

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
 * routes resolution past the colon-slice step to the bare `message`.
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
 * The verbatim text the SDK's own failure handler produces when a request never reaches a server.
 *
 * Both the call layer and the file layer build their rejection by spreading `error.response.data`
 * without checking that `response` exists, so on a dropped, cancelled or unroutable request the
 * handler itself throws and THAT `TypeError` becomes the rejection the SPA receives. This exact
 * string is what a reviewer was shown.
 */
export const TRANSPORT_FAILURE_MESSAGE = "Cannot read properties of undefined (reading 'data')"

/**
 * PATH 5 — a rejection that carries NO Frappe envelope at all: no server messages, no error message,
 * no exception, and no HTTP status, because no response was ever received.
 *
 * A real `TypeError` instance rather than a shaped object, because that is literally what the SDK
 * throws, and because an `Error` carries its `message` on the prototype chain - a fixture spreading
 * `{ message }` into a plain object would test a shape the runtime never produces.
 */
export const makeTransportFailureError = (
	message: string = TRANSPORT_FAILURE_MESSAGE
): FrappeError => new TypeError(message) as unknown as FrappeError

/** The default refusal message this module attaches; a caller passes the message it wants to model. */
const IMPORT_FAILURE_MESSAGE = 'No tables found in the PDF file'

/**
 * Builds the value held by `bankRecImportFailuresAtom`: a `Record` from `Bank Statement Import Log`
 * name to the RAW `FrappeError` that import was refused with.
 *
 * The raw error rather than a parsed string, because that is the atom's contract: the rendering layer
 * parses it through the same shared path every other reported failure goes through, so a marker and a
 * dialog can never disagree about the same refusal.
 *
 * The marker supplements the document rather than replacing it. `Bank Statement Import Log` offers
 * only `Not Started` and `Completed` and carries no error field, and a refused import rolls back, so
 * the log persists nothing about the failure and reads exactly as one nobody has tried yet.
 *
 * Accepts the log itself rather than a bare name so the key cannot drift from the row it marks.
 */
export const makeImportFailures = (
	log: BankStatementImportLog,
	message: string = IMPORT_FAILURE_MESSAGE
): Record<string, FrappeError> => ({ [log.name]: makeServerMessagesError(message) })

/* Every suite mocks the SDK through {@link createFrappeSDKMock}, so none hand-rolls a module mock or
 * omits a symbol. The `vi.mock('frappe-react-sdk', () => createFrappeSDKMock())` line must stay
 * literally in the test file, so Vitest's transform can hoist it above the imports; the factory itself
 * runs lazily, which is why it may reference an imported helper.
 *
 * Only symbols used as VALUES are stubbed. `FrappeError`, `FrappeConfig`, `SWRConfiguration` and
 * `Filter` appear solely in type positions and are erased before the module is resolved, so stubbing
 * them would invent exports the library does not have.
 *
 * Two return shapes are load-bearing. `useSWRConfig()` must return `{ mutate }`, because the
 * reconciliation hooks destructure it at render time; and that `mutate` must return a PROMISE, because
 * production chains `.then(...)` straight onto it.
 *
 * Every spy carries a typed contract from §8a rather than a bare `vi.fn()`, which would infer
 * `(...args: any[]) => any` and silently accept a wrong endpoint argument or response shape. Where the
 * library types a parameter as `any`, the contract narrows it to the shape every call site in `src/`
 * passes, so a mistake is a compile error rather than a runtime surprise.
 *
 * The SWR-backed READ hooks default to "no data, no error, not loading" so any component mounts
 * unconfigured. Every IMPERATIVE operation defaults to REJECTING with
 * {@link UNCONFIGURED_OPERATION_MESSAGE} instead: resolving would run production's success handlers on
 * a payload the test never supplied, letting a suite assert an outcome it never configured. None fires
 * during mount, so the rejection only surfaces once a test drives the flow it forgot to set up. The
 * two `mutate` spies and the document-event emitters are the deliberate exceptions.
 * ════════════════════════════════════════════════════════════════════════════════ */

/* ─── 8a. Callable contracts, derived from the installed declarations ──────────────────
 * One alias per SDK seam. Each mirrors the corresponding declaration in
 * `frappe-react-sdk/dist/lib/index.d.ts` — or, for the `FrappeContext` operations, the
 * `frappe-js-sdk` class the SDK re-exports — narrowed to what `src/` actually passes and
 * reads. They exist so every spy below can be held to a real shape by `vi.fn<Contract>(…)`
 * instead of the `(...args: any[]) => any` a bare `vi.fn()` infers.
 * ────────────────────────────────────────────────────────────────────────────────────── */

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

interface MockedQueryResponse<T = unknown> {
	data: T | undefined
	error: FrappeError | undefined
	isLoading: boolean
	isValidating: boolean
	mutate: MockedHookMutate
}

type MockedGetCallHook = (
	method: string,
	params?: Record<string, unknown>,
	swrKey?: Key,
	options?: SWRConfiguration,
	type?: 'GET' | 'POST'
) => MockedQueryResponse

type MockedGetDocHook = (
	doctype: string,
	name?: string,
	swrKey?: Key,
	options?: SWRConfiguration
) => MockedQueryResponse

type MockedGetDocListHook = (
	doctype: string,
	args?: GetDocListArgs,
	swrKey?: Key,
	options?: SWRConfiguration
) => MockedQueryResponse

type MockedGetDocCountHook = (
	doctype: string,
	filters?: Filter[],
	debug?: boolean,
	swrKey?: Key,
	options?: SWRConfiguration
) => MockedQueryResponse<number>

type MockedPostCall = (params: Record<string, unknown>) => Promise<unknown>

interface MockedPostCallResult {
	call: MockedPostCall
	result: unknown
	loading: boolean
	error: FrappeError | null
	isCompleted: boolean
	reset: () => void
}

type MockedPostCallHook = (method: string) => MockedPostCallResult

type MockedCreateDoc = (doctype: string, doc: unknown) => Promise<unknown>

interface MockedCreateDocResult {
	createDoc: MockedCreateDoc
	loading: boolean
	error: FrappeError | null | undefined
	isCompleted: boolean
	reset: () => void
}

type MockedCreateDocHook = () => MockedCreateDocResult

type MockedUpdateDoc = (doctype: string, docname: string | null, doc: unknown) => Promise<unknown>

interface MockedUpdateDocResult {
	updateDoc: MockedUpdateDoc
	loading: boolean
	error: FrappeError | null | undefined
	isCompleted: boolean
	reset: () => void
}

type MockedUpdateDocHook = () => MockedUpdateDocResult

/**
 * The `upload` returned by `useFrappeFileUpload`. It resolves to the File document, whose `file_url`
 * the importer reads, which is why the resolution type is the library's own interface and
 * {@link makeFileUploadResponse} exists to satisfy it without a cast.
 */
type MockedFileUpload = (
	file: File,
	args: FileArgs<unknown>,
	apiPath?: string
) => Promise<FrappeFileUploadResponse>

interface MockedFileUploadResult {
	upload: MockedFileUpload
	progress: number
	loading: boolean
	error: FrappeError | null
	isCompleted: boolean
	reset: () => void
}

type MockedFileUploadHook = () => MockedFileUploadResult

type MockedEventListenerHook = (
	eventName: string,
	callback: (eventData: unknown) => void
) => void

type MockedDocEventEmitter = () => void

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

type MockedUseSWRConfigHook = () => { mutate: MockedKeyedMutate }

/**
 * `FrappeCall.get/post/put/delete`. The library types `params` as `any` on three of the four; every
 * call site in `src/` passes a parameter object, so all four share one narrowed record contract.
 */
type MockedContextRequest = (path: string, params?: Record<string, unknown>) => Promise<unknown>

type MockedContextGetDoc = (doctype: string, docname?: string) => Promise<unknown>

type MockedContextGetDocList = (doctype: string, args?: GetDocListArgs) => Promise<unknown[]>

type MockedContextGetCount = (
	doctype: string,
	filters?: Filter[],
	debug?: boolean
) => Promise<number>

type MockedContextCreateDoc = (doctype: string, value: unknown) => Promise<unknown>

type MockedContextUpdateDoc = (
	doctype: string,
	docname: string | null,
	value: unknown
) => Promise<unknown>

type MockedContextDeleteDoc = (
	doctype: string,
	docname?: string | null
) => Promise<{ message: string }>

type MockedContextSetValue = (
	doctype: string,
	name: string,
	fieldname: string | object,
	value?: unknown
) => Promise<unknown>

interface MockedUploadProgressEvent {
	progress?: number
}

/**
 * `FrappeFileUpload.uploadFile` — the CONTEXT upload, which differs from the hook's `upload` in
 * accepting an `onProgress` callback and resolving to an Axios response rather than the File document.
 * Every call site discards the resolved value, so it stays `unknown` here.
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

const UNCONFIGURED_OPERATION_MESSAGE = 'Unconfigured frappe SDK operation'

/**
 * Builds the rejection an unconfigured imperative operation produces.
 *
 * Deliberately a plain `Error` and not a {@link makeFrappeError} envelope: this is a test
 * CONFIGURATION fault, not a server refusal, and dressing it as a Frappe error would let it
 * masquerade as the backend rejection a failure-mode suite is supposed to configure for itself. The
 * `how` hint travels in the message so the fix appears in the failure output itself.
 */
const rejectUnconfigured = (operation: string, how: string): Promise<never> =>
	Promise.reject(
		new Error(
			`${UNCONFIGURED_OPERATION_MESSAGE}: ${operation} ran without a configured implementation, ` +
				`so this test would otherwise have asserted an outcome it never set up. Configure it — ${how}`
		)
	)

/**
 * The success payload of the reconcile post, shaped exactly as its hook declares it.
 *
 * Overrides forward to {@link makeBankTransaction}, which DERIVES the rest of the allocation from
 * whichever figure is given, so the partial-allocation branch is stated with the one figure that
 * distinguishes it:
 *
 *     makeReconcileSuccessResponse({ unallocated_amount: 2500 })
 *
 * Restating `status` alongside it is unnecessary, and restating an `allocated_amount` that does not
 * complement the unallocated figure throws.
 */
export const makeReconcileSuccessResponse = (
	overrides: Partial<BankTransaction> = {}
): { message: BankTransaction } => ({ message: makeBankTransaction(overrides) })

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
 * client is corrected after a post is refused. Assert on it with the exact key strings `utils.ts`
 * builds, since those families are fixed and a suite must reuse rather than reshape them.
 *
 * It RESOLVES by default, unlike the imperative operations below, because production chains
 * `.then(...)` straight onto it and revalidation is a consequence of a scenario rather than a scenario
 * a suite would forget to configure.
 *
 * The default mirrors SWR's own resolution contract, which is ARGUMENT-COUNT DEPENDENT.
 * `internalMutate` branches on `args.length < 3`:
 *
 *   • fewer than three arguments is the "revalidate this key" form, which resolves with
 *     `cache.get(key)?.data` — the refetched value with a mounted subscriber, and the entry's
 *     EXISTING data with none. This mock holds no cache, so it resolves `undefined`: the honest
 *     stand-in for an entry nothing has seeded.
 *   • three or more arguments is a cache WRITE, which resolves with the data it wrote, awaiting it
 *     first when a promise was supplied and rejecting when that promise rejects.
 *
 * `await data` reproduces both halves in one line, which is what stops a suite passing while
 * production reads a stale entry back as though it were a server response.
 */
export const frappeSWRMutate = vi.fn<MockedKeyedMutate>(async (_key, data) => await data)

/**
 * Stable spy for the `mutate` returned by the individual query hooks. Kept distinct from
 * {@link frappeSWRMutate} on purpose: a single shared spy would let a local re-fetch
 * satisfy an assertion that global keyed revalidation had occurred.
 */
export const frappeHookMutate = vi.fn<MockedHookMutate>(() => Promise.resolve(undefined))

/**
 * Stable spy for the `call` returned by `useFrappePostCall`, shared by every post-call site:
 *
 *   • success  — `frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())`
 *   • refusal  — `frappePostCall.mockRejectedValue(makeAlreadyReconciledError())`
 *
 * Unconfigured, it REJECTS, because resolving would run a production success handler on a payload the
 * test never supplied and let a suite assert an outcome it never configured.
 *
 * When a component holds several post calls and a suite must distinguish them, override the hook
 * instead and branch on its `method` argument.
 */
export const frappePostCall = vi.fn<MockedPostCall>(() =>
	rejectUnconfigured(
		'useFrappePostCall(…).call',
		'frappePostCall.mockResolvedValue(makeReconcileSuccessResponse()) or .mockRejectedValue(makeAlreadyReconciledError())'
	)
)

/**
 * Stable spy for the `createDoc` returned by `useFrappeCreateDoc`. Rejects unconfigured, because the
 * importer navigates to `doc.name` straight after it resolves and an unconfigured success would route
 * the test to `/statement-importer/undefined`.
 */
export const frappeCreateDoc = vi.fn<MockedCreateDoc>(() =>
	rejectUnconfigured(
		'useFrappeCreateDoc().createDoc',
		'frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog())'
	)
)

export const frappeUpdateDoc = vi.fn<MockedUpdateDoc>(() =>
	rejectUnconfigured(
		'useFrappeUpdateDoc().updateDoc',
		'frappeUpdateDoc.mockResolvedValue(makeSelectedBank())'
	)
)

/**
 * Stable spy for the `upload` returned by `useFrappeFileUpload`. Rejects unconfigured, because the
 * importer feeds `file.file_url` into the import log it creates next and an unconfigured success would
 * silently attach `undefined`.
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
 * recent callback for a channel replaces any earlier one, mirroring the real hook and stopping
 * {@link emitFrappeEvent} from invoking a closure captured by an earlier render.
 *
 * LIFETIME: the map is module-level, so it outlives any component and React's unmount cleanup leaves
 * entries behind. {@link resetFrappeSDKMock} empties it from the harness's shared teardown.
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
 * `useContext(FrappeContext) as FrappeConfig` and immediately DESTRUCTURES a member; with the
 * library's own `null` default the first lazily loaded modal body to mount would throw before
 * rendering anything. The members those call sites reach for are `call.get`, `db.getDoc`,
 * `db.getDocList`, `db.getCount`, `db.setValue`, `db.deleteDoc` and `file.uploadFile`. The rest of the
 * surface is mirrored anyway, so a component reaching for one finds a spy rather than `undefined`.
 *
 * Every imperative member below REJECTS when unconfigured, including the read-shaped `db.getDoc`,
 * `db.getDocList` and `db.getCount`: an unconfigured `[]` or `0` is indistinguishable from a real
 * answer and could satisfy an assertion by accident. Each is reached from a user-event handler rather
 * than from mount, so a rejection can only surface once a test drives the flow it left unconfigured.
 * Only the SWR-backed READ HOOKS keep empty-data defaults, because a component must be able to mount
 * before a suite has configured anything.
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
const FrappeContextMock = createContext(frappeContextValue)

const FrappeProviderMock = ({ children }: { children?: ReactNode }) =>
	createElement(Fragment, null, children)

const emptyQueryResponse = (): MockedQueryResponse => ({
	data: undefined,
	error: undefined,
	isLoading: false,
	isValidating: false,
	mutate: frappeHookMutate
})

/**
 * The eleven SDK hooks, as stable spies — each typed by its contract from §8a and created with its
 * default implementation already in place.
 *
 * Exported so a suite can override any single hook's return without re-mocking the module:
 *
 *     frappeSDKMock.useFrappeGetCall.mockImplementation((method) =>
 *         method.endsWith('get_bank_transactions')
 *             ? { data: { message: [makeUnreconciledTransaction()] }, error: undefined,
 *                 isLoading: false, isValidating: false, mutate: frappeHookMutate }
 *             : emptyQueryResponse())
 *
 * Branching on the method rather than a blanket `mockReturnValue` matters because a single render
 * reaches `useFrappeGetCall` many times with different endpoints, and because the contract types that
 * argument as a `string`, so a branch on a misspelt one fails to compile instead of never matching.
 *
 * The hooks THEMSELVES never reject: a hook that threw could not be rendered at all.
 */
export const frappeSDKMock = {
	useFrappeGetCall: vi.fn<MockedGetCallHook>(() => emptyQueryResponse()),
	useFrappeGetDoc: vi.fn<MockedGetDocHook>(() => emptyQueryResponse()),
	useFrappeGetDocList: vi.fn<MockedGetDocListHook>(() => emptyQueryResponse()),

	useFrappeGetDocCount: vi.fn<MockedGetDocCountHook>(() => ({
		data: undefined,
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: frappeHookMutate
	})),

	// `error: null` on the imperative hooks, matching the SDK, which initialises them with `null` rather
	// than leaving them undefined.
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
	useFrappeFileUpload: vi.fn<MockedFileUploadHook>(() => ({
		upload: frappeFileUpload,
		progress: 0,
		loading: false,
		error: null,
		isCompleted: false,
		reset: vi.fn<() => void>(() => undefined)
	})),

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

interface ResettableSpy {
	mockReset: () => unknown
}

const resetSpies = (spies: ResettableSpy[]): void => {
	spies.forEach((spy) => {
		spy.mockReset()
	})
}

/**
 * Clears every recorded call and per-test override, restoring each spy to the default it was CREATED
 * with, and drops all realtime subscriptions.
 *
 * `mockReset()` restores the implementation passed to `vi.fn()`, so the inline defaults in §8b/§8c ARE
 * the reset defaults; re-installing them here from a separate list is how a creation default and a
 * reset default drift apart.
 *
 * `src/test/setup.ts` calls this from its shared `afterEach`, so no suite has to opt in. Because it
 * also discards per-test implementations, install those from a suite's own `beforeEach` rather than at
 * module or `describe` scope.
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

type FrappeSDKMockExports = typeof frappeSDKMock & {
	FrappeContext: typeof FrappeContextMock
	FrappeProvider: typeof FrappeProviderMock
}

/**
 * THE shared module mock — what a `vi.mock` factory hands back in place of `frappe-react-sdk`. It
 * exposes the runtime symbols and none of the four type-only ones, and its spies are the same
 * identities exported above, so a suite mocks and asserts through {@link frappeSDKMock},
 * {@link frappePostCall} and {@link frappeSWRMutate} without re-deriving anything.
 *
 * `overrides` is an escape hatch for the rare suite that needs to replace one of those symbols
 * outright; it is spread LAST, so it always wins.
 */
export const createFrappeSDKMock = (
	overrides: Partial<FrappeSDKMockExports> = {}
): FrappeSDKMockExports => ({
	...frappeSDKMock,
	FrappeContext: FrappeContextMock,
	FrappeProvider: FrappeProviderMock,
	...overrides
})
