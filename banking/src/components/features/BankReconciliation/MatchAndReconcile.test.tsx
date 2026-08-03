/**
 * The reconciliation workbench, exercised end to end through the surface a reviewer actually
 * touches.
 *
 * WHAT IS PROVEN HERE, AND WHY EACH ASSERTION IS SHAPED THE WAY IT IS
 *   TC1  the unreconciled list renders one row per transaction the SERVER returned, with its
 *        amounts resolved through the currency helpers
 *   TC2  a rule-stamped transaction shows the violet rule badge, and an unstamped one does not
 *   TC3  confirming a DIFFERENT, non-suggested voucher sends THAT voucher's identity - the
 *        manual-override path the backend records as `reconciliation_type: "Matched"`
 *   TC4  confirming the suggested voucher posts ONCE, on the reconcile endpoint, and the row's
 *        status is then refreshed FROM THE SERVER rather than invented locally
 *   TC5  an already-reconciled transaction cannot be reconciled again (FM3)
 *   FM5  a currency mismatch shows a NON-BLOCKING advisory: the chip appears AND confirm stays
 *        enabled, because the server - not this badge - decides whether a post is allowed
 *
 * EVERYTHING IS ASSERTED ON RENDERED OUTPUT OR ON WHAT THE SERVER WAS ASKED TO DO. No test
 * reaches into component state or treats an atom as a proxy for behaviour: the two things that
 * matter about a financial posting surface are what the reviewer is shown and what request is
 * dispatched, and both are observable from outside.
 *
 * NOTHING IN THE APPLICATION WAS CHANGED TO MAKE THIS TESTABLE. No test-only identifier attribute
 * was added, no test-only prop, no export, no extracted sub-component. Queries go through
 * accessible roles and text, or through the `data-slot` / `data-variant` / `data-size` /
 * `data-theme` attributes the design-system primitives already emit - which is also why no
 * assertion here reads a class string, a detail those primitives are free to change.
 *
 * ─── Four mechanical properties of this environment that shape the harness ────────────
 *
 *  1. VIRTUALISATION. Both lists render through `@tanstack/react-virtual`, whose range
 *     calculation returns NOTHING when the scroll container measures zero - and jsdom performs
 *     no layout, so every box is zero-sized. `ResizeObserver` is stubbed by the shared harness
 *     but deliberately never fires, for the same reason. The virtualiser reads the viewport
 *     from `offsetHeight`, so {@link stubLayoutMeasurement} gives that one property a non-zero
 *     value; without it NO ROW RENDERS AT ALL, which is verified by the empty-state test below
 *     continuing to pass while every row assertion would fail. The spy is restored per test,
 *     because the shared teardown resets mock functions and not property getters.
 *
 *  2. PROVIDERS. `App.tsx` wraps the whole router in one `TooltipProvider`, and Radix's tooltip
 *     root THROWS without a provider ancestor - so a suite that mounts this component directly
 *     has to supply one. A router is needed too: the "no transactions" empty state renders a
 *     `<Link>`.
 *
 *  3. JOTAI IS PER-PROVIDER, and the shared harness performs no global store reset, so every
 *     test builds its own store. Three atoms are load-bearing: without `selectedBankAccountAtom`
 *     the component early-returns its empty state; `bankRecDateAtom` is interpolated into the
 *     cache keys, so seeding it explicitly is what makes the key assertions exact rather than
 *     dependent on the calendar month the suite happens to run in; and the
 *     `bankRecSelectedTransactionAtom` family entry is the transaction under review that the
 *     confirm affordance and its guard both read.
 *
 *  4. `_()` FALLS THROUGH to the literal source string, because the harness leaves the
 *     translation map empty - so `getByRole('button', { name: 'Reconcile' })` reads plainly.
 *
 * ─── One attribute subtlety worth stating, because it is invisible in the source ──────
 * The currency advisory chip is a `Badge` inside a `TooltipTrigger asChild`. Radix's `Slot`
 * spreads the trigger's own props AFTER the Badge's, so the Badge's `data-slot="badge"` is
 * OVERWRITTEN with `data-slot="tooltip-trigger"` while `data-variant`, `data-size` and
 * `data-theme` survive. A query for `[data-slot="badge"][data-theme="orange"]` therefore matches
 * nothing at all. {@link currencyAdvisoryChip} selects on the surviving variant triple instead,
 * scoped to one row - which is also what keeps it from colliding with the voucher panel's own
 * orange "Partial Match" badge.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	TEST_ALTERNATE_CURRENCY,
	TEST_BANK_ACCOUNT,
	TEST_COMPANY,
	TEST_CURRENCY,
	TEST_TRANSACTION_AMOUNT,
	TEST_TRANSACTION_RULE,
	createFrappeSDKMock,
	formatAlreadyReconciledMessage,
	frappeHookMutate,
	frappePostCall,
	frappeSDKMock,
	frappeSWRMutate,
	makeAlreadyReconciledError,
	makeAlternateLinkedPayment,
	makeBlankReferenceLinkedPayment,
	makeCurrencyMismatchTransaction,
	makeLinkedPayment,
	makeReconcileSuccessResponse,
	makeReconciledTransaction,
	makeRuleMatchedTransaction,
	makeSelectedBank,
	makeServerMessagesError,
	makeSuggestedLinkedPayment,
	makeUnreconciledTransaction
} from '@/test/factories'

// The component's module graph loads the SDK at module scope, so the package is replaced
// wholesale before it can resolve. It MUST be the shared helper: that mock is the only one
// carrying `useSWRConfig`, which `useRefreshUnreconciledTransactions` destructures and
// `useReconcileTransaction` calls - a hand-rolled mock missing it fails every confirm test at
// render time. The line stays literally here so Vitest's transform hoists it above the imports.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { TooltipProvider } from '@/components/ui/tooltip'
import MatchAndReconcile from './MatchAndReconcile'
import {
	bankRecAmountFilter,
	bankRecDateAtom,
	bankRecErrorDialogAtom,
	bankRecReconcileSettlingAtom,
	bankRecSelectedTransactionAtom,
	selectedBankAccountAtom
} from './bankRecAtoms'
import type { LinkedPayment, UnreconciledTransaction, useGetRuleForTransaction } from './utils'

/* ═══ 1. Contracts derived from the code under test ═══════════════════════════════════
 * Every shape below is READ OFF the application rather than restated, so a signature that
 * moves breaks this file at compile time instead of letting an assertion quietly describe a
 * contract that no longer exists.
 * ══════════════════════════════════════════════════════════════════════════════════ */

/** The five members the SPA destructures from an SWR-backed hook, as the shared mock declares them. */
type QueryResponse = ReturnType<typeof frappeSDKMock.useFrappeGetCall>

/** The error envelope those hooks surface. */
type QueryError = NonNullable<QueryResponse['error']>

/**
 * The rule document `RuleAction` renders, taken from the hook that fetches it. Deriving the
 * type from `useGetRuleForTransaction` rather than importing the generated declaration keeps
 * this fixture bound to the same contract the component consumes.
 */
type RuleDocument = NonNullable<ReturnType<typeof useGetRuleForTransaction>['data']>

/* ═══ 2. Identity constants ═══════════════════════════════════════════════════════════ */

/**
 * The date range every test seeds. Fixed rather than derived from "this month", because both
 * revalidated cache keys interpolate it and the assertions below spell those keys out in full.
 */
const FROM_DATE = '2024-01-01'
const TO_DATE = '2024-01-31'

/** The two cache keys the successful confirm path revalidates, composed exactly as `utils.ts` builds them. */
const UNRECONCILED_KEY = `bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`
const CLOSING_BALANCE_KEY = `bank-reconciliation-account-closing-balance-${TEST_BANK_ACCOUNT}-${TO_DATE}`

/**
 * The all-transactions key, which the REJECTION path re-reads alongside the unreconciled one. It is
 * the key that can still carry a now-reconciled row, because the unreconciled endpoint filters on
 * `unallocated_amount > 0` and therefore cannot.
 */
const BANK_TRANSACTIONS_KEY = `bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`

/** The default match filters, which the voucher cache key joins with a comma. */
const DEFAULT_MATCH_FILTERS = 'payment_entry,journal_entry'

const vouchersKeyFor = (transactionName: string): string =>
	`bank-reconciliation-vouchers-${transactionName}-${FROM_DATE}-${TO_DATE}-${DEFAULT_MATCH_FILTERS}`

/** The ONE endpoint a confirm is allowed to post to. */
const RECONCILE_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.reconcile_vouchers'

/**
 * A realistic non-zero pane height. The component sizes both virtualised viewports from it
 * (`contentHeight - 72` and `contentHeight - 120`), so a zero would starve them even with the
 * measurement stub in place.
 */
const CONTENT_HEIGHT = 800

/** The account the whole suite reconciles against; its `account_currency` is {@link TEST_CURRENCY}. */
const BANK = makeSelectedBank()

/** The atom-family entry keyed by that account, holding the transaction(s) under review. */
const SELECTED_TRANSACTION_ATOM = bankRecSelectedTransactionAtom(BANK.name)

/**
 * Two transactions whose descriptions share no tokens. Fuse indexes `description` and
 * `reference_number` at threshold 0.5, which is loose enough that near-identical phrasings
 * cross-match - so the search test needs genuinely distinct copy to be meaningful.
 */
const DEPOSIT_ROW = makeUnreconciledTransaction({
	name: 'ACC-BTN-2024-01001',
	description: 'Zenith Foods inbound wire',
	reference_number: 'ZEN-778',
	deposit: TEST_TRANSACTION_AMOUNT,
	withdrawal: 0,
	unallocated_amount: TEST_TRANSACTION_AMOUNT
})

const WITHDRAWAL_ROW = makeUnreconciledTransaction({
	name: 'ACC-BTN-2024-01002',
	description: 'Quill Stationers office supplies',
	reference_number: 'QUI-991',
	deposit: 0,
	withdrawal: 4300,
	unallocated_amount: 4300
})

/**
 * A rule as the server stores it, used to drive the recommended-action card that a rule-matched
 * transaction opens. `classify_as: 'Payment Entry'` selects the green branch of that card.
 */
const MATCHED_RULE: RuleDocument = {
	name: TEST_TRANSACTION_RULE,
	creation: '2024-01-02 09:00:00.000000',
	modified: '2024-01-02 09:00:00.000000',
	owner: 'Administrator',
	modified_by: 'Administrator',
	docstatus: 0,
	// Required by the SDK's document wrapper, which is what deriving this type from the hook
	// rather than from the generated declaration surfaces: `FrappeDoc` makes `idx` mandatory even
	// though the DocType declares it optional.
	idx: 0,
	rule_name: 'ACME inbound NEFT credits',
	rule_description: 'Credits whose description names ACME Traders',
	transaction_type: 'Deposit',
	priority: 4,
	// The constant rather than `BANK.company`: `company` is optional on a bank account and
	// required on a rule, so reading it off the account would not type-check - and the harness
	// seeds exactly this company, so the two cannot disagree.
	company: TEST_COMPANY,
	description_rules: [],
	classify_as: 'Payment Entry',
	account: 'Debtors - TC',
	party_type: 'Customer',
	party: 'ACME Traders'
}

/* ═══ 3. The harness ══════════════════════════════════════════════════════════════════ */

/** The "answered" state of an SWR-backed hook. */
const answered = (data: unknown): QueryResponse => ({
	data,
	error: undefined,
	isLoading: false,
	isValidating: false,
	mutate: frappeHookMutate
})

/** The "still fetching" state, which drives the skeleton branches. */
const fetching = (): QueryResponse => ({
	data: undefined,
	error: undefined,
	isLoading: true,
	isValidating: false,
	mutate: frappeHookMutate
})

/** The "refused" state, which drives the inline error banners. */
const refused = (error: QueryError): QueryResponse => ({
	data: undefined,
	error,
	isLoading: false,
	isValidating: false,
	mutate: frappeHookMutate
})

/**
 * Gives the virtualised scroll containers a non-zero viewport.
 *
 * `@tanstack/react-virtual` reads its container height from `offsetHeight`, and jsdom reports
 * zero for every element because it performs no layout - at which point the virtualiser's range
 * calculation returns nothing and the lists render no rows whatsoever. This is the ONE property
 * that has to be answered honestly for a virtualised list to be observable headlessly; the
 * component itself is untouched.
 *
 * Returned so the caller can restore it: the shared teardown resets mock FUNCTIONS, not property
 * getters, so a suite that installs one owns putting it back.
 */
const stubLayoutMeasurement = () =>
	vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(CONTENT_HEIGHT)

interface WorkbenchOptions {
	/** Rows `get_bank_transactions` answers with. */
	transactions?: UnreconciledTransaction[]
	/** Rows `get_linked_payments` answers with, in the order the endpoint returns them. */
	vouchers?: LinkedPayment[]
	/** The transaction(s) under review, seeded into the atom family for {@link BANK}. */
	selected?: UnreconciledTransaction[]
	/**
	 * The account currency the SERVER'S CURRENT bank-account list reports.
	 *
	 * This - not the stored selection - is what the mismatch advisory compares against, because
	 * `account_currency` is derived by the endpoint from the linked GL account and a stored
	 * snapshot can name a currency the account no longer uses. Pass `null` to model an account
	 * whose currency the endpoint could not derive; `null` rather than `undefined`, because an
	 * omitted option has to remain distinguishable from one deliberately left unresolved.
	 */
	accountCurrency?: string | null
	/** Omits the bank account entirely, which is what drives the component's own empty state. */
	withoutBank?: boolean
	/** Puts the transaction list into its loading or refused state instead of answering. */
	transactionsState?: 'loading' | 'error'
	/** Puts the voucher list into its loading or refused state instead of answering. */
	vouchersState?: 'loading' | 'error'
	/** The envelope the refused states surface. */
	listError?: QueryError
	/** The rule document `RuleAction` fetches for a rule-stamped transaction. */
	rule?: RuleDocument
	/** How many unreconciled transactions exist BEFORE the seeded range. */
	olderCount?: number
	/** Raises the settle window, the state a rejected confirm leaves the affordance in. */
	settling?: boolean
	/** Seeds the shared error dialog, so its mount point can be observed. */
	dialogError?: QueryError
	/** Seeds the amount filter directly, which is deterministic where typing into it is not. */
	amountFilter?: number
}

/**
 * Mounts the workbench with its own jotai store, a tooltip provider and a router, and routes
 * every endpoint the component reaches.
 *
 * Endpoints are matched on the METHOD argument rather than blanket-stubbed, because a single
 * render calls `useFrappeGetCall` several times with different methods - the transaction list,
 * the candidate vouchers, the bank-account list behind the currency comparison, the
 * older-transaction count and the match-filter document types. Routing keeps the REAL hook layer
 * in the call path, so the cache keys, the search grading and the reconcile payload are all
 * produced by production code rather than by the test.
 */
const renderWorkbench = (options: WorkbenchOptions = {}) => {
	const {
		transactions = [],
		vouchers = [],
		selected = [],
		accountCurrency = TEST_CURRENCY,
		withoutBank = false,
		transactionsState,
		vouchersState,
		listError = makeServerMessagesError('Something went wrong on the server'),
		rule,
		olderCount = 0,
		settling = false,
		dialogError,
		amountFilter
	} = options

	const store = createStore()

	if (!withoutBank) {
		store.set(selectedBankAccountAtom, BANK)
	}
	store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })
	store.set(SELECTED_TRANSACTION_ATOM, selected)

	if (settling) {
		store.set(bankRecReconcileSettlingAtom, true)
	}
	if (dialogError) {
		store.set(bankRecErrorDialogAtom, dialogError)
	}
	if (amountFilter !== undefined) {
		store.set(bankRecAmountFilter, { value: amountFilter, stringValue: String(amountFilter) })
	}

	frappeSDKMock.useFrappeGetCall.mockImplementation((method) => {
		if (method.endsWith('bank_reconciliation_tool.get_bank_transactions')) {
			if (transactionsState === 'loading') return fetching()
			if (transactionsState === 'error') return refused(listError)
			return answered({ message: transactions })
		}

		if (method.endsWith('bank_reconciliation_tool.get_linked_payments')) {
			if (vouchersState === 'loading') return fetching()
			if (vouchersState === 'error') return refused(listError)
			return answered({ message: vouchers })
		}

		// Shared with the bank picker, and the source of the FRESH account currency the mismatch
		// advisory compares against.
		if (method.endsWith('bank_account.bank_account.get_list')) {
			return answered({ message: [{ ...BANK, account_currency: accountCurrency ?? undefined }] })
		}

		if (method.endsWith('bank_reconciliation_tool.get_older_unreconciled_transactions')) {
			return answered({ message: { count: olderCount, oldest_date: '2023-12-01' } })
		}

		// Anything else the tree reaches for - the match-filter document types among them - gets
		// an honest "nothing yet" rather than a fabricated answer.
		return answered(undefined)
	})

	frappeSDKMock.useFrappeGetDoc.mockImplementation(() => answered(rule))

	const utils = render(
		<Provider store={store}>
			<TooltipProvider>
				<MemoryRouter>
					<MatchAndReconcile contentHeight={CONTENT_HEIGHT} />
				</MemoryRouter>
			</TooltipProvider>
		</Provider>
	)

	return { ...utils, store }
}

/* ═══ 4. Queries ══════════════════════════════════════════════════════════════════════ */

/**
 * The row element for one transaction.
 *
 * Located from the description text upwards to the enclosing `role="button"`, which is the row
 * itself - the only interactive element in it. Resolving upwards rather than filtering every
 * button by text content keeps the lookup unambiguous when the same description also appears in
 * the multi-selection table.
 */
const transactionRow = (transaction: UnreconciledTransaction): HTMLElement => {
	const label = transaction.description ?? transaction.name
	const row = screen
		.getAllByText(label)
		.map((node) => node.closest<HTMLElement>('[role="button"]'))
		.find((candidate): candidate is HTMLElement => candidate !== null)

	if (!row) {
		throw new Error(`No unreconciled-transaction row is rendered for "${label}"`)
	}

	return row
}

/**
 * The currency-mismatch advisory chip inside one row, or `null` when the row shows none.
 *
 * Selected on the variant triple that SURVIVES the `asChild` merge (see the file header: the chip
 * loses `data-slot="badge"` to the tooltip trigger). Scoping the query to a row, and pinning
 * `data-size="sm"`, is what makes it impossible for this to match the voucher panel's own orange
 * "Partial Match" badge, which is a default-size badge in a different subtree.
 */
const currencyAdvisoryChip = (row: HTMLElement): HTMLElement | null =>
	row.querySelector<HTMLElement>('[data-theme="orange"][data-variant="subtle"][data-size="sm"]')

/** The violet rule badge inside one row, or `null` when the transaction carries no rule stamp. */
const ruleBadge = (row: HTMLElement): HTMLElement | null =>
	row.querySelector<HTMLElement>('[data-slot="badge"][data-theme="violet"]')

/** The voucher card enclosing a named voucher, so a confirm control can be scoped to ONE candidate. */
const voucherCard = (voucher: LinkedPayment): HTMLElement => {
	const card = screen.getByRole('link', { name: voucher.name }).closest<HTMLElement>('div.relative')

	if (!card) {
		throw new Error(`No voucher card is rendered for "${voucher.name}"`)
	}

	return card
}

/** The confirm control of one candidate voucher. */
const confirmControlFor = (voucher: LinkedPayment): HTMLElement =>
	within(voucherCard(voucher)).getByRole('button', { name: 'Reconcile' })

/** The parameter bag of the single reconcile post, parsed back out of the spy. */
const capturedReconcileRequest = (): { bank_transaction_name: unknown, vouchers: unknown } => {
	const [payload] = frappePostCall.mock.calls[0] ?? []

	if (!payload) {
		throw new Error('No reconcile request was dispatched')
	}

	return payload as { bank_transaction_name: unknown, vouchers: unknown }
}

/** Every method a `useFrappePostCall` was instantiated with during the render, de-duplicated. */
const postEndpointsUsed = (): string[] => [
	...new Set(frappeSDKMock.useFrappePostCall.mock.calls.map(([method]) => method))
]

/**
 * Asserts that the dialog now open is the expected one, then DISMISSES it and waits for it to
 * leave the document.
 *
 * Closing is not tidiness. A Radix dialog manages document-level state while open - it hides the
 * rest of the tree from assistive technology and takes over pointer handling - and a tree
 * unmounted with one still open can leave that state behind for whatever renders next. Verified
 * the hard way: a test that pressed a keyboard shortcut immediately after a preceding test had
 * unmounted mid-dialog never saw its own dialog appear. Every dialog opened here is therefore
 * closed before the test ends.
 */
const expectDialogTitled = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
	expect(await screen.findByRole('dialog')).toHaveTextContent(title)

	await user.keyboard('{Escape}')
	await waitFor(() => {
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})
}

/* ═══ 5. The suites ═══════════════════════════════════════════════════════════════════ */

describe('MatchAndReconcile', () => {
	let layoutMeasurement: ReturnType<typeof stubLayoutMeasurement>

	beforeEach(() => {
		// Installed per test rather than once: the shared teardown resets spies created by the
		// fixture module, and a property getter installed at module scope would outlive this file.
		layoutMeasurement = stubLayoutMeasurement()
	})

	afterEach(() => {
		layoutMeasurement.mockRestore()
	})

	/* ─── Before a bank account is chosen ───────────────────────────────────────────── */

	describe('before a bank account is chosen', () => {
		it('asks for one and renders no transaction rows', () => {
			renderWorkbench({ withoutBank: true, transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			expect(screen.getByText('Select a bank account to reconcile')).toBeInTheDocument()

			// The rows are deliberately withheld even though the endpoint would have answered with
			// them, so nothing is presented as reconcilable before an account frames it.
			expect(screen.queryByText(DEPOSIT_ROW.description ?? '')).not.toBeInTheDocument()
			expect(screen.queryByText(WITHDRAWAL_ROW.description ?? '')).not.toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
		})
	})

	/* ─── TC1 ───────────────────────────────────────────────────────────────────────── */

	describe('TC1 - the unreconciled list', () => {
		it('renders one row per transaction the server returned', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})
			expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()

			// Each row is distinguished by its OWN data, so neither is a duplicate of the other.
			expect(within(transactionRow(DEPOSIT_ROW)).getByText(/ZEN-778/)).toBeInTheDocument()
			expect(within(transactionRow(WITHDRAWAL_ROW)).getByText(/QUI-991/)).toBeInTheDocument()

			// The result counter agrees with the row count, so nothing was rendered twice or dropped.
			expect(screen.getByText('2 results')).toBeInTheDocument()
		})

		it('renders each row exactly as the backend produced it, with no client-side deduplication', async () => {
			// A re-import legitimately produces two Bank Transaction records that agree on every
			// visible field. The list must show BOTH: collapsing them would hide real duplicated
			// bank activity that a reviewer has to resolve, and the server is the only authority on
			// whether two rows are the same event.
			const first = makeUnreconciledTransaction({ name: 'ACC-BTN-2024-02001', description: 'Repeat wire' })
			const second = makeUnreconciledTransaction({ name: 'ACC-BTN-2024-02002', description: 'Repeat wire' })

			renderWorkbench({ transactions: [first, second] })

			await waitFor(() => {
				expect(screen.getAllByText('Repeat wire')).toHaveLength(2)
			})
			expect(screen.getByText('2 results')).toBeInTheDocument()
		})

		it('resolves amounts through the currency helpers', async () => {
			// The row falls back transaction currency -> fresh account currency -> stored account
			// currency -> company default, then formats with the symbol and grouping the currency
			// document carries. Asserting the rendered figure is what proves that whole chain ran.
			const partlyAllocated = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-03001',
				description: 'Partly allocated wire',
				deposit: TEST_TRANSACTION_AMOUNT,
				withdrawal: 0,
				unallocated_amount: 9000
			})

			renderWorkbench({ transactions: [partlyAllocated] })

			await waitFor(() => {
				expect(transactionRow(partlyAllocated)).toBeInTheDocument()
			})

			const row = transactionRow(partlyAllocated)
			expect(row.textContent).toMatch(/₹\s?12,500\.00/)

			// The remaining figure is shown only when it differs from the transaction value, which
			// is exactly the case a reviewer needs to see. Matched loosely because the label shares
			// its element with the formatted figure.
			expect(row.textContent).toMatch(/₹\s?9,000\.00/)
			expect(within(row).getByText(/Unallocated/)).toBeInTheDocument()
		})

		it('omits the remaining figure when nothing has been allocated yet', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			expect(within(transactionRow(DEPOSIT_ROW)).queryByText(/Unallocated/)).not.toBeInTheDocument()
		})

		it('reports the server date and transaction type on each row', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			const row = transactionRow(DEPOSIT_ROW)
			// Formatted with the user's own date format, which the harness seeds as `dd-mm-yyyy`.
			expect(within(row).getByText('15-01-2024')).toBeInTheDocument()
			expect(within(row).getByText('NEFT')).toBeInTheDocument()
		})
	})

	/* ─── TC2 ───────────────────────────────────────────────────────────────────────── */

	describe('TC2 - the rule-suggested match', () => {
		it('shows the violet rule badge, naming the rule that matched', async () => {
			const stamped = makeRuleMatchedTransaction({ description: 'Rule-stamped ACME credit' })

			renderWorkbench({ transactions: [stamped] })

			await waitFor(() => {
				expect(transactionRow(stamped)).toBeInTheDocument()
			})

			const badge = ruleBadge(transactionRow(stamped))
			expect(badge).not.toBeNull()

			// Both halves matter: the badge has to be the violet one AND it has to name the rule,
			// because a reviewer acts on WHICH rule proposed the match, not merely on the fact that
			// one did.
			expect(badge).toHaveAttribute('data-theme', 'violet')
			expect(badge).toHaveTextContent(TEST_TRANSACTION_RULE)
		})

		it('shows no rule badge on a transaction the rule engine did not stamp', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			expect(ruleBadge(transactionRow(DEPOSIT_ROW))).toBeNull()
		})

		it('badges only the stamped row when a stamped and an unstamped row sit side by side', async () => {
			const stamped = makeRuleMatchedTransaction({ description: 'Rule-stamped ACME credit' })

			renderWorkbench({ transactions: [stamped, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(stamped)).toBeInTheDocument()
			})

			expect(ruleBadge(transactionRow(stamped))).not.toBeNull()
			expect(ruleBadge(transactionRow(WITHDRAWAL_ROW))).toBeNull()
		})

		it('opens the rule-recommended action for the stamped transaction under review', async () => {
			const stamped = makeRuleMatchedTransaction({ description: 'Rule-stamped ACME credit' })

			renderWorkbench({ transactions: [stamped], selected: [stamped], rule: MATCHED_RULE })

			await waitFor(() => {
				expect(screen.getByText(MATCHED_RULE.rule_name)).toBeInTheDocument()
			})

			// The card restates the rule the badge named, so the reviewer sees WHY it was proposed
			// and WHAT the rule asks for.
			expect(screen.getByText(MATCHED_RULE.rule_description ?? '')).toBeInTheDocument()
			expect(screen.getByText('Recommended Action')).toBeInTheDocument()
			expect(screen.getByText(`Priority ${MATCHED_RULE.priority}`)).toBeInTheDocument()
			expect(screen.getByText(MATCHED_RULE.account ?? '')).toBeInTheDocument()
			expect(screen.getByRole('button', { name: /Create Payment Entry/ })).toBeInTheDocument()
		})

		it('renders no recommended action while the rule document has not arrived', async () => {
			const stamped = makeRuleMatchedTransaction({ description: 'Rule-stamped ACME credit' })

			renderWorkbench({ transactions: [stamped], selected: [stamped] })

			await waitFor(() => {
				expect(screen.getByText('No vouchers found for this transaction')).toBeInTheDocument()
			})

			// Nothing is invented from the stamp alone: the card appears only once the server has
			// supplied the rule it describes.
			expect(screen.queryByText('Recommended Action')).not.toBeInTheDocument()
		})

		it("offers the action the rule's OWN classification calls for", async () => {
			// The card is not decoration: the classification decides which document the reviewer is
			// steered towards, so a rule classified as a bank entry must not offer to record a
			// payment. Each classification is checked separately, because they are three distinct
			// branches of that decision.
			const stamped = makeRuleMatchedTransaction({ description: 'Rule-stamped ACME credit' })

			const { unmount } = renderWorkbench({
				transactions: [stamped],
				selected: [stamped],
				rule: { ...MATCHED_RULE, classify_as: 'Bank Entry' }
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: /Create Bank Entry/ })).toBeInTheDocument()
			})
			expect(
				screen.getByText('Create a journal entry for expenses, income or split transactions')
			).toBeInTheDocument()
			expect(screen.queryByRole('button', { name: /Create Payment Entry/ })).not.toBeInTheDocument()
			unmount()

			renderWorkbench({
				transactions: [stamped],
				selected: [stamped],
				rule: { ...MATCHED_RULE, classify_as: 'Transfer' }
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: /Create Transfer/ })).toBeInTheDocument()
			})
			expect(
				screen.getByText('Record an internal transfer to another bank/credit card/cash account')
			).toBeInTheDocument()
		})

		it('routes the recommended action to the document the classification names', async () => {
			// Offering the right label and then opening the wrong document would be worse than
			// offering nothing, so the routing is asserted for each classification rather than
			// inferred from the label.
			const user = userEvent.setup()
			const stamped = makeRuleMatchedTransaction({ description: 'Rule-stamped ACME credit' })

			const openRecommendedAction = async (
				classification: RuleDocument['classify_as'],
				expectedTitle: string
			) => {
				const { unmount } = renderWorkbench({
					transactions: [stamped],
					selected: [stamped],
					rule: { ...MATCHED_RULE, classify_as: classification }
				})

				await user.click(await screen.findByRole('button', { name: new RegExp(`Create ${classification}`) }))
				await expectDialogTitled(user, expectedTitle)

				unmount()
			}

			await openRecommendedAction('Payment Entry', 'Record Payment')
			await openRecommendedAction('Bank Entry', 'Bank Entry')
			await openRecommendedAction('Transfer', 'Transfer')
		})

		it('reaches the recommended action from the keyboard as well', async () => {
			const user = userEvent.setup()
			const stamped = makeRuleMatchedTransaction({ description: 'Rule-stamped ACME credit' })

			renderWorkbench({
				transactions: [stamped],
				selected: [stamped],
				rule: { ...MATCHED_RULE, classify_as: 'Transfer' }
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: /Create Transfer/ })).toBeInTheDocument()
			})

			await user.keyboard('{Alt>}r{/Alt}')

			await expectDialogTitled(user, 'Transfer')
		})
	})

	/* ─── Creating a voucher instead of matching one ─────────────────────────────────── */

	describe('creating a voucher instead of matching one', () => {
		/**
		 * The three alternatives to matching. Only the DIALOG opening is asserted - each modal body
		 * is lazily loaded and owns its own behaviour - because what this surface is responsible for
		 * is offering the right three routes and opening the right one.
		 */
		it('opens each create-a-voucher route for the transaction under review', async () => {
			const user = userEvent.setup()
			renderWorkbench({ transactions: [DEPOSIT_ROW], selected: [DEPOSIT_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			await user.click(screen.getByRole('button', { name: /Record a payment entry/ }))
			await expectDialogTitled(user, 'Record Payment')

			await user.click(screen.getByRole('button', { name: /Record a bank journal entry/ }))
			await expectDialogTitled(user, 'Bank Entry')

			await user.click(screen.getByRole('button', { name: /Record an internal transfer/ }))
			await expectDialogTitled(user, 'Transfer')
		})

		it('opens the same routes for a multi-transaction selection', async () => {
			const user = userEvent.setup()
			renderWorkbench({
				transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW],
				selected: [DEPOSIT_ROW, WITHDRAWAL_ROW]
			})

			await waitFor(() => {
				expect(screen.getByText('2 transactions selected')).toBeInTheDocument()
			})

			await user.click(screen.getByRole('button', { name: /Record a bank journal entry/ }))
			await expectDialogTitled(user, 'Bank Entry')

			await user.click(screen.getByRole('button', { name: /Record a payment entry/ }))
			await expectDialogTitled(user, 'Record Payment')

			await user.click(screen.getByRole('button', { name: /Record an internal transfer/ }))
			await expectDialogTitled(user, 'Transfer')
		})

		it('honours the shortcuts its own tooltips advertise', async () => {
			const user = userEvent.setup()
			renderWorkbench({ transactions: [DEPOSIT_ROW], selected: [DEPOSIT_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			// The tooltips promise these three chords, so they are part of the contract rather than a
			// convenience: a promised shortcut that does nothing is a defect.
			await user.keyboard('{Meta>}p{/Meta}')
			await expectDialogTitled(user, 'Record Payment')

			await user.keyboard('{Meta>}b{/Meta}')
			await expectDialogTitled(user, 'Bank Entry')

			await user.keyboard('{Meta>}i{/Meta}')
			await expectDialogTitled(user, 'Transfer')
		})
	})

	/* ─── Candidate vouchers ────────────────────────────────────────────────────────── */

	describe('the candidate vouchers for the transaction under review', () => {
		it('invites a selection until one is made', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			expect(
				screen.getByText('Select a transaction to match and reconcile with vouchers')
			).toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
		})

		it('selects a transaction when its row is clicked', async () => {
			const user = userEvent.setup()
			const { store } = renderWorkbench({
				transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW],
				vouchers: [makeSuggestedLinkedPayment(DEPOSIT_ROW)]
			})

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			await user.click(transactionRow(DEPOSIT_ROW))

			// Asserted on the surface the click opened, not on the atom: the voucher panel is what
			// the reviewer now sees.
			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})
			expect(store.get(SELECTED_TRANSACTION_ATOM).map((row) => row.name)).toEqual([DEPOSIT_ROW.name])

			// A plain click REPLACES the selection rather than accumulating it.
			await user.click(transactionRow(WITHDRAWAL_ROW))
			expect(store.get(SELECTED_TRANSACTION_ATOM).map((row) => row.name)).toEqual([WITHDRAWAL_ROW.name])
		})

		it('accumulates a selection when rows are shift-clicked, and offers the bulk actions', async () => {
			const user = userEvent.setup()
			const { store } = renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			await user.click(transactionRow(DEPOSIT_ROW))
			await user.keyboard('{Shift>}')
			await user.click(transactionRow(WITHDRAWAL_ROW))
			await user.keyboard('{/Shift}')

			await waitFor(() => {
				expect(screen.getByText('2 transactions selected')).toBeInTheDocument()
			})
			expect(store.get(SELECTED_TRANSACTION_ATOM).map((row) => row.name)).toEqual([
				DEPOSIT_ROW.name,
				WITHDRAWAL_ROW.name
			])

			// Several transactions cannot be matched to one voucher, so the confirm affordance is
			// withheld and only the create-a-voucher actions remain.
			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: /Record a bank journal entry/ })).toBeInTheDocument()
		})

		it('grades each candidate against the transaction under review', async () => {
			const suggested = makeSuggestedLinkedPayment(DEPOSIT_ROW)
			const unrelated = makeAlternateLinkedPayment()
			// An invoice row as `get_linked_payments` really returns one: the amount agrees but both
			// reference columns are the empty string, which is evidence of nothing.
			const blankReference = makeBlankReferenceLinkedPayment()

			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested, unrelated, blankReference]
			})

			await waitFor(() => {
				expect(screen.getByRole('link', { name: suggested.name })).toBeInTheDocument()
			})

			// Only the first candidate, which agrees on amount AND on a date or reference, is
			// presented as the suggestion.
			const suggestedBadge = within(voucherCard(suggested)).getByText('Suggested')
			expect(suggestedBadge).toHaveAttribute('data-theme', 'green')
			expect(within(voucherCard(unrelated)).queryByText('Suggested')).not.toBeInTheDocument()
			expect(within(voucherCard(blankReference)).queryByText('Suggested')).not.toBeInTheDocument()

			// The reference grades the reviewer reads off each card.
			expect(within(voucherCard(suggested)).getByText('Complete Match')).toBeInTheDocument()
			expect(within(voucherCard(unrelated)).getByText('No Match')).toBeInTheDocument()

			// A blank reference paints no grade at all rather than an empty label beside one.
			expect(within(voucherCard(blankReference)).queryByText('No Match')).not.toBeInTheDocument()
			expect(within(voucherCard(blankReference)).queryByText('Complete Match')).not.toBeInTheDocument()
		})

		it('grades a reference contained in the transaction description as a partial match', async () => {
			const transaction = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-04001',
				description: 'Settlement for ACME-4417 batch',
				reference_number: 'BATCH-4417'
			})
			const partial = makeLinkedPayment({
				name: 'ACC-PAY-2024-04001',
				paid_amount: transaction.unallocated_amount,
				reference_no: 'ACME-4417',
				reference_date: transaction.date,
				posting_date: transaction.date
			})

			renderWorkbench({ transactions: [transaction], selected: [transaction], vouchers: [partial] })

			await waitFor(() => {
				expect(screen.getByRole('link', { name: partial.name })).toBeInTheDocument()
			})

			expect(within(voucherCard(partial)).getByText('Partial Match')).toBeInTheDocument()
		})

		it('says so plainly when the server offers no candidate at all', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW], selected: [DEPOSIT_ROW], vouchers: [] })

			await waitFor(() => {
				expect(screen.getByText('No vouchers found for this transaction')).toBeInTheDocument()
			})

			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
		})
	})

	/* ─── TC3 ───────────────────────────────────────────────────────────────────────── */

	describe('TC3 - a manual override to a different voucher', () => {
		/**
		 * The suggestion and the override, arranged the way the endpoint would return them: the
		 * suggested Payment Entry first (the suggestion predicate additionally requires index 0),
		 * and a Journal Entry that agrees on nothing after it.
		 */
		const suggested = makeSuggestedLinkedPayment(DEPOSIT_ROW)
		const different = makeAlternateLinkedPayment()

		const renderWithBothCandidates = () =>
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested, different]
			})

		it('sends the identity of the voucher the reviewer actually chose', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

			renderWithBothCandidates()

			await waitFor(() => {
				expect(screen.getByRole('link', { name: different.name })).toBeInTheDocument()
			})

			// The override is genuinely the non-suggested candidate: it disagrees on amount, so the
			// test cannot accidentally pass by clicking the suggestion.
			expect(within(voucherCard(different)).queryByText('Suggested')).not.toBeInTheDocument()
			expect(different.paid_amount).not.toBe(DEPOSIT_ROW.unallocated_amount)

			await user.click(confirmControlFor(different))

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledTimes(1)
			})

			const request = capturedReconcileRequest()
			expect(request.bank_transaction_name).toBe(DEPOSIT_ROW.name)

			// `vouchers` travels as a JSON STRING, so it is parsed back rather than compared
			// structurally against an object that would never match.
			expect(typeof request.vouchers).toBe('string')
			expect(JSON.parse(String(request.vouchers))).toEqual([
				{
					payment_doctype: different.doctype,
					payment_name: different.name,
					amount: different.paid_amount
				}
			])
		})

		it('takes the match path rather than creating a voucher', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

			renderWithBothCandidates()

			await waitFor(() => {
				expect(screen.getByRole('link', { name: different.name })).toBeInTheDocument()
			})
			await user.click(confirmControlFor(different))

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledTimes(1)
			})

			// An EXISTING voucher's doctype and name are what the server keys on to record the link
			// as `Matched` rather than `Voucher Created`. That is a server-side consequence, so what
			// is asserted here is the client side of it: an existing voucher was named, and nothing
			// was created - no document was inserted and no create endpoint was reached.
			const [{ payment_doctype: doctype, payment_name: name }] = JSON.parse(
				String(capturedReconcileRequest().vouchers)
			)
			expect(doctype).toBe('Journal Entry')
			expect(name).toBe(different.name)
			expect(postEndpointsUsed()).toEqual([RECONCILE_ENDPOINT])
			expect(frappeSDKMock.useFrappeCreateDoc).not.toHaveBeenCalled()
		})

		it('does not post the suggestion when the override is the control that was clicked', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

			renderWithBothCandidates()

			await waitFor(() => {
				expect(screen.getByRole('link', { name: different.name })).toBeInTheDocument()
			})
			await user.click(confirmControlFor(different))

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledTimes(1)
			})

			// Exactly one post, and it does not name the suggested voucher anywhere.
			expect(String(capturedReconcileRequest().vouchers)).not.toContain(suggested.name)
		})
	})

	/* ─── TC4 ───────────────────────────────────────────────────────────────────────── */

	describe('TC4 - confirming a match posts the reconciliation', () => {
		const suggested = makeSuggestedLinkedPayment(DEPOSIT_ROW)

		const confirmSuggested = async () => {
			const user = userEvent.setup()
			const rendered = renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested]
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})
			await user.click(confirmControlFor(suggested))

			return rendered
		}

		it('posts once, on the reconcile endpoint, with the suggested voucher', async () => {
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

			await confirmSuggested()

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledTimes(1)
			})

			// One server-side operation, on one endpoint. Confirm/post is atomic on the server, so
			// the client's whole contribution is to make exactly this one request.
			expect(postEndpointsUsed()).toEqual([RECONCILE_ENDPOINT])
			expect(JSON.parse(String(capturedReconcileRequest().vouchers))).toEqual([
				{
					payment_doctype: suggested.doctype,
					payment_name: suggested.name,
					amount: suggested.paid_amount
				}
			])
		})

		it('refreshes the status from the server instead of inventing it locally', async () => {
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

			const { store } = await confirmSuggested()

			await waitFor(() => {
				expect(frappeSWRMutate).toHaveBeenCalledWith(UNRECONCILED_KEY)
			})

			// The balance panel is revalidated alongside the list, because a posted reconciliation
			// moves both.
			expect(frappeSWRMutate).toHaveBeenCalledWith(CLOSING_BALANCE_KEY)

			// The selection is rebuilt from that refresh rather than patched: the server reported
			// the transaction fully allocated, so it leaves the unreconciled list and the reviewer
			// is advanced off it. No status was written client-side anywhere.
			await waitFor(() => {
				expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
			})
		})

		it('revalidates the candidate list too when the server reports a partial allocation', async () => {
			// A partial allocation keeps the reviewer on the same transaction, so its remaining
			// candidates have to be re-read as well - the voucher just consumed is no longer one.
			frappePostCall.mockResolvedValue(
				makeReconcileSuccessResponse({ unallocated_amount: 2500, status: 'Unreconciled' })
			)

			const { store } = await confirmSuggested()

			await waitFor(() => {
				expect(frappeSWRMutate).toHaveBeenCalledWith(vouchersKeyFor(DEPOSIT_ROW.name))
			})
			expect(frappeSWRMutate).toHaveBeenCalledWith(UNRECONCILED_KEY)
			expect(frappeSWRMutate).toHaveBeenCalledWith(CLOSING_BALANCE_KEY)

			// The reviewer stays on the transaction, because there is still something to allocate.
			expect(store.get(SELECTED_TRANSACTION_ATOM).map((row) => row.name)).toEqual([DEPOSIT_ROW.name])
		})

		it('closes the affordance while a post is in flight', async () => {
			// The in-flight window is the double-click guard, and it is the one state that has to be
			// driven from the hook rather than from a fixture: `loading` belongs to the post hook.
			frappeSDKMock.useFrappePostCall.mockImplementation(() => ({
				call: frappePostCall,
				result: null,
				loading: true,
				error: null,
				isCompleted: false,
				reset: vi.fn<() => void>(() => undefined)
			}))

			renderWorkbench({ transactions: [DEPOSIT_ROW], selected: [DEPOSIT_ROW], vouchers: [suggested] })

			const control = await screen.findByRole('button', { name: /Reconciling/ })
			expect(control).toBeDisabled()

			// The label states what is actually happening, and the idle label is gone.
			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
		})

		it('keeps the affordance closed while a settled attempt is still being resolved', async () => {
			const user = userEvent.setup()

			// The settle window outlasts the request: after a rejection the client still holds the
			// pre-attempt snapshot until the server has been re-read, and posting again against it
			// is exactly the stale-client mistake the guard exists to prevent.
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested],
				settling: true
			})

			const control = await screen.findByRole('button', { name: /Checking/ })
			expect(control).toBeDisabled()

			await user.click(control)
			expect(frappePostCall).not.toHaveBeenCalled()
		})
	})

	/* ─── TC5 / FM3 ─────────────────────────────────────────────────────────────────── */

	describe('TC5 and FM3 - an already-reconciled transaction cannot be reconciled again', () => {
		/**
		 * A transaction the server considers fully reconciled. BOTH signals are set because the
		 * server derives them from one another - `status === 'Reconciled'` holds exactly when
		 * `unallocated_amount <= 0` - so setting only one would model a state the server can never
		 * produce, and the guard would be tested against a fiction.
		 *
		 * Such rows do reach this surface: the "Bank Transactions" tab requests the unfiltered set,
		 * bypassing the server-side filter that would otherwise exclude them, and a stored selection
		 * can also outlive the reconciliation it was made before.
		 */
		const reconciled = makeReconciledTransaction({ description: 'Already reconciled wire' })
		const stillUnreconciled = makeUnreconciledTransaction({
			name: 'ACC-BTN-2024-05001',
			description: 'Still open wire',
			status: 'Unreconciled',
			unallocated_amount: TEST_TRANSACTION_AMOUNT
		})

		it('disables the confirm control', async () => {
			renderWorkbench({
				transactions: [reconciled],
				selected: [reconciled],
				vouchers: [makeSuggestedLinkedPayment(reconciled)]
			})

			const control = await screen.findByRole('button', { name: 'Reconcile' })
			expect(control).toBeDisabled()
		})

		/*
		 * The predicate the BACKEND actually tests is the FIGURE, not the label - its guard reads
		 * `if 0.0 >= self.unallocated_amount`. The two rows below are the ones that separate the two
		 * halves of the client's `status === 'Reconciled' || unallocated_amount <= 0`, and they are
		 * the reason the second half exists: a label that has not caught up, and an over-allocation,
		 * are both states the server refuses while `status` still reads `Unreconciled`.
		 */
		it('withholds it on a fully allocated row whose status label has not caught up', async () => {
			const laggingLabel = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-05002',
				description: 'Fully allocated, label behind',
				status: 'Unreconciled',
				unallocated_amount: 0
			})

			renderWorkbench({
				transactions: [laggingLabel],
				selected: [laggingLabel],
				vouchers: [makeSuggestedLinkedPayment(laggingLabel)]
			})

			expect(await screen.findByRole('button', { name: 'Reconcile' })).toBeDisabled()
		})

		it('withholds it on an over-allocated row', async () => {
			const overAllocated = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-05003',
				description: 'Over-allocated wire',
				status: 'Unreconciled',
				unallocated_amount: -25
			})

			renderWorkbench({
				transactions: [overAllocated],
				selected: [overAllocated],
				vouchers: [makeSuggestedLinkedPayment(overAllocated)]
			})

			expect(await screen.findByRole('button', { name: 'Reconcile' })).toBeDisabled()
		})

		it('leaves the same control enabled for its unreconciled counterpart', async () => {
			// The other half of the pair, and the half that matters: it is what proves the guard is
			// evaluating the server's predicate rather than disabling confirm across the board.
			renderWorkbench({
				transactions: [stillUnreconciled],
				selected: [stillUnreconciled],
				vouchers: [makeSuggestedLinkedPayment(stillUnreconciled)]
			})

			const control = await screen.findByRole('button', { name: 'Reconcile' })
			expect(control).toBeEnabled()
		})

		it('dispatches no request when the disabled control is clicked', async () => {
			const user = userEvent.setup()

			renderWorkbench({
				transactions: [reconciled],
				selected: [reconciled],
				vouchers: [makeSuggestedLinkedPayment(reconciled)]
			})

			const control = await screen.findByRole('button', { name: 'Reconcile' })
			await user.click(control)

			// Not one post. The server would refuse it anyway - its own guard is the authority - but
			// the affordance must not offer an action that cannot succeed.
			expect(frappePostCall).not.toHaveBeenCalled()
		})

		it('keeps the reason discoverable, since a disabled control fires no events of its own', async () => {
			renderWorkbench({
				transactions: [reconciled],
				selected: [reconciled],
				vouchers: [makeSuggestedLinkedPayment(reconciled)]
			})

			const control = await screen.findByRole('button', { name: 'Reconcile' })

			// A disabled button emits no pointer or focus events, so the explanation is anchored to a
			// focusable wrapper around it. Asserting the wrapper - rather than hovering for the
			// tooltip text, which is portaled behind a delay - is the stable way to prove the reason
			// is reachable by mouse AND keyboard.
			const trigger = control.parentElement
			expect(trigger).toHaveAttribute('data-slot', 'tooltip-trigger')
			expect(trigger).toHaveAttribute('tabindex', '0')
		})

		it('anchors no such explanation on the enabled path', async () => {
			renderWorkbench({
				transactions: [stillUnreconciled],
				selected: [stillUnreconciled],
				vouchers: [makeSuggestedLinkedPayment(stillUnreconciled)]
			})

			const control = await screen.findByRole('button', { name: 'Reconcile' })

			// The tooltip is mounted only when the guard fires, so an enabled control never points at
			// content that is not rendered.
			expect(control.parentElement).not.toHaveAttribute('data-slot', 'tooltip-trigger')
		})

		it('still lists the reconciled transaction, exactly as the server reported it', async () => {
			renderWorkbench({ transactions: [reconciled, stillUnreconciled] })

			await waitFor(() => {
				expect(transactionRow(reconciled)).toBeInTheDocument()
			})

			// Nothing is hidden client-side. Which rows are returned is the endpoint's decision, and
			// the guard governs the ACTION rather than the visibility.
			expect(transactionRow(stillUnreconciled)).toBeInTheDocument()
			expect(screen.getByText('2 results')).toBeInTheDocument()
		})

		/**
		 * The stale-client case FM3 is really about, end to end on this surface.
		 *
		 * The client held a row it believed was reconcilable, the server refused the post, and the
		 * refresh that follows rebuilds the selection from the SERVER'S OWN rows - after which this
		 * guard is reading the truth and the action closes. Nothing on the path depends on the client
		 * having guessed the new state: no status is written locally, and the refreshed row is taken
		 * whole. The all-transactions key is what carries it, because a now-reconciled transaction is
		 * absent from the unreconciled list by construction (that endpoint filters on
		 * `unallocated_amount > 0`).
		 */
		it('closes after a refusal, from the server\'s refreshed row', async () => {
			const user = userEvent.setup()
			const stale = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-05004',
				description: 'Reconciled behind this client\'s back',
				status: 'Unreconciled',
				unallocated_amount: TEST_TRANSACTION_AMOUNT
			})

			frappePostCall.mockRejectedValue(makeAlreadyReconciledError(stale.name))

			// The authoritative answer to the post-rejection refresh: the all-transactions view still
			// reports the row, now settled.
			frappeSWRMutate.mockImplementation((key: unknown) =>
				Promise.resolve(key === BANK_TRANSACTIONS_KEY
					? {
						message: [{ ...stale, status: 'Reconciled', unallocated_amount: 0 }]
					}
					: undefined))

			const { store } = renderWorkbench({
				transactions: [stale],
				selected: [stale],
				vouchers: [makeSuggestedLinkedPayment(stale)]
			})

			const control = await screen.findByRole('button', { name: 'Reconcile' })
			expect(control).toBeEnabled()

			await user.click(control)

			// The refusal is reported in a MODAL dialog, so the page behind it is inert until it is
			// dismissed - which is exactly the order the reviewer experiences: read the server's own
			// reason, dismiss it, find the action correctly withheld.
			await user.click(await screen.findByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeDisabled()
			})

			// The row the guard is now reading is the SERVER's, taken whole rather than patched.
			expect(store.get(SELECTED_TRANSACTION_ATOM)[0]).toMatchObject({
				name: stale.name,
				status: 'Reconciled',
				unallocated_amount: 0
			})
			// One post, and no retry of it anywhere on the rejection path.
			expect(frappePostCall).toHaveBeenCalledTimes(1)
		})
	})

	/* ─── FM5 ───────────────────────────────────────────────────────────────────────── */

	describe('FM5 - a currency mismatch warns without blocking', () => {
		/** Denominated in the alternate currency, against an account the server reports in {@link TEST_CURRENCY}. */
		const mismatched = makeCurrencyMismatchTransaction({ description: 'Cross-currency inbound wire' })

		it('shows the advisory chip, naming the transaction currency', async () => {
			renderWorkbench({
				transactions: [mismatched],
				accountCurrency: TEST_CURRENCY
			})

			await waitFor(() => {
				expect(transactionRow(mismatched)).toBeInTheDocument()
			})

			const chip = currencyAdvisoryChip(transactionRow(mismatched))
			expect(chip).not.toBeNull()

			// `orange` - Badge declares no `amber` theme at all - in its subtle variant, which is what
			// resolves to the amber tokens a caution calls for.
			expect(chip).toHaveAttribute('data-theme', 'orange')
			expect(chip).toHaveAttribute('data-variant', 'subtle')
			expect(chip).toHaveTextContent(TEST_ALTERNATE_CURRENCY)
		})

		it('leaves the confirm control ENABLED, because the server decides the outcome', async () => {
			// The half of FM5 that carries the requirement. "Non-blocking" is a statement about the
			// INDICATOR: the interface must not pre-emptively refuse an action on the strength of a
			// comparison it made itself. The server remains the authority on whether the post is
			// allowed, and a refusal surfaces through the shared dismissible dialog like any other.
			renderWorkbench({
				transactions: [mismatched],
				selected: [mismatched],
				vouchers: [makeSuggestedLinkedPayment(mismatched)],
				accountCurrency: TEST_CURRENCY
			})

			const control = await screen.findByRole('button', { name: 'Reconcile' })
			expect(control).toBeEnabled()
			expect(currencyAdvisoryChip(transactionRow(mismatched))).not.toBeNull()
		})

		it('still dispatches the confirm for a mismatched transaction', async () => {
			const user = userEvent.setup()
			const voucher = makeSuggestedLinkedPayment(mismatched)
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

			renderWorkbench({
				transactions: [mismatched],
				selected: [mismatched],
				vouchers: [voucher],
				accountCurrency: TEST_CURRENCY
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})
			await user.click(confirmControlFor(voucher))

			// The advisory changes nothing about the request that is made. No conversion, no rate and
			// no revaluation is involved anywhere: the chip is display only.
			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledTimes(1)
			})
			expect(capturedReconcileRequest().bank_transaction_name).toBe(mismatched.name)
		})

		it('shows no chip when the two currencies agree', async () => {
			renderWorkbench({
				transactions: [makeUnreconciledTransaction({ description: 'Same-currency wire' })],
				accountCurrency: TEST_CURRENCY
			})

			const row = await waitFor(() =>
				transactionRow(makeUnreconciledTransaction({ description: 'Same-currency wire' }))
			)

			expect(currencyAdvisoryChip(row)).toBeNull()
		})

		it('shows no chip when the account currency is unknown, because there is nothing to compare', async () => {
			// `account_currency` is derived by the endpoint from the linked GL account and cannot
			// always be resolved. An absent value is an ABSENCE OF EVIDENCE, not a mismatch - a
			// warning that is wrong in that direction is worse than no warning.
			renderWorkbench({
				transactions: [mismatched],
				accountCurrency: null
			})

			await waitFor(() => {
				expect(transactionRow(mismatched)).toBeInTheDocument()
			})

			expect(currencyAdvisoryChip(transactionRow(mismatched))).toBeNull()
		})

		it('warns on only the mismatched row when a matching row sits beside it', async () => {
			renderWorkbench({
				transactions: [mismatched, DEPOSIT_ROW],
				accountCurrency: TEST_CURRENCY
			})

			await waitFor(() => {
				expect(transactionRow(mismatched)).toBeInTheDocument()
			})

			expect(currencyAdvisoryChip(transactionRow(mismatched))).not.toBeNull()
			expect(currencyAdvisoryChip(transactionRow(DEPOSIT_ROW))).toBeNull()
		})
	})

	/* ─── The shared error dialog's mount point ─────────────────────────────────────── */

	describe('the shared error dialog', () => {
		it('renders nothing while no rejection is being reported', async () => {
			const { container } = renderWorkbench({ transactions: [DEPOSIT_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			// Queried through `screen`, because the dialog portals to `document.body` and would be
			// invisible to a container-scoped lookup whether it were mounted or not.
			expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			expect(container.ownerDocument.querySelectorAll('[data-slot="alert-dialog-content"]')).toHaveLength(0)
		})

		it('is mounted by this surface, so a rejection reaches the reviewer here', async () => {
			// Only the MOUNT is asserted: the dialog's own parsing, severity and dismissal behaviour
			// belong to its own suite and are not restated.
			renderWorkbench({
				transactions: [makeReconciledTransaction({ description: 'Already reconciled wire' })],
				dialogError: makeAlreadyReconciledError('ACC-BTN-2024-00003')
			})

			const dialog = await screen.findByRole('alertdialog')

			// The server's own wording, verbatim - no client paraphrasing anywhere on the path.
			expect(dialog).toHaveTextContent(formatAlreadyReconciledMessage('ACC-BTN-2024-00003'))
		})
	})

	/* ─── Narrowing the list ────────────────────────────────────────────────────────── */

	describe('narrowing the list', () => {
		it('narrows to the searched transaction', async () => {
			const user = userEvent.setup()
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			await user.type(screen.getByPlaceholderText('Search'), 'Zenith')

			// The input is debounced, so the narrowing lands a beat after the last keystroke.
			await waitFor(
				() => {
					expect(screen.queryByText(WITHDRAWAL_ROW.description ?? '')).not.toBeInTheDocument()
				},
				{ timeout: 4000 }
			)
			expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			expect(screen.getByText('1 result')).toBeInTheDocument()
		})

		it('narrows to debits, then to credits', async () => {
			const user = userEvent.setup()
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			await user.click(screen.getByRole('button', { name: 'All' }))
			await user.click(await screen.findByRole('menuitem', { name: 'Debits' }))

			await waitFor(() => {
				expect(screen.queryByText(DEPOSIT_ROW.description ?? '')).not.toBeInTheDocument()
			})
			expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Debits' }))
			await user.click(await screen.findByRole('menuitem', { name: 'Credits' }))

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})
			expect(screen.queryByText(WITHDRAWAL_ROW.description ?? '')).not.toBeInTheDocument()
		})

		it('narrows to an exact amount', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW], amountFilter: 4300 })

			await waitFor(() => {
				expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()
			})

			expect(screen.queryByText(DEPOSIT_ROW.description ?? '')).not.toBeInTheDocument()
			expect(screen.getByText('1 result')).toBeInTheDocument()
		})

		it('narrows as an amount is typed, formatted in the account currency', async () => {
			const user = userEvent.setup()
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			// The placeholder is composed from the account's currency symbol and its decimal
			// separator, which is what identifies this input without a test-only hook.
			const amountInput = screen.getByPlaceholderText('₹0.00')

			// Cleared first, because the field starts showing a zero rather than empty - typing over
			// it without clearing appends to that zero, exactly as it would for a real reviewer.
			await user.clear(amountInput)
			await user.type(amountInput, '4300')

			await waitFor(() => {
				expect(screen.queryByText(DEPOSIT_ROW.description ?? '')).not.toBeInTheDocument()
			})
			expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()
		})

		it('restores the whole list when the type filter is set back to all', async () => {
			const user = userEvent.setup()
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			await user.click(screen.getByRole('button', { name: 'All' }))
			await user.click(await screen.findByRole('menuitem', { name: 'Credits' }))

			await waitFor(() => {
				expect(screen.queryByText(WITHDRAWAL_ROW.description ?? '')).not.toBeInTheDocument()
			})

			await user.click(screen.getByRole('button', { name: 'Credits' }))
			await user.click(await screen.findByRole('menuitem', { name: 'All' }))

			await waitFor(() => {
				expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()
			})
			expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
		})

		it('offers a way back when a filter matches nothing, and restores the list', async () => {
			const user = userEvent.setup()
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW], amountFilter: 999999 })

			await waitFor(() => {
				expect(screen.getByText('No transactions found for the given filters.')).toBeInTheDocument()
			})

			// The empty state distinguishes "your filters excluded everything" from "there is nothing
			// to reconcile", and offers the corresponding way out.
			expect(screen.getByText('Try adjusting your search or filter criteria.')).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Clear Filters' }))

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})
			expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()
		})

		it('points at the importer when the account genuinely has nothing to reconcile', async () => {
			renderWorkbench({ transactions: [] })

			await waitFor(() => {
				expect(screen.getByText('No unreconciled transactions found')).toBeInTheDocument()
			})

			expect(screen.getByText('Import your bank statement to get started.')).toBeInTheDocument()
			expect(screen.getByRole('link', { name: 'Import Bank Statement' })).toHaveAttribute(
				'href',
				'/statement-importer'
			)
			// No filter is in force, so no "clear filters" escape is offered.
			expect(screen.queryByRole('button', { name: 'Clear Filters' })).not.toBeInTheDocument()
		})
	})

	/* ─── While the server has not answered ─────────────────────────────────────────── */

	describe('while the server has not answered', () => {
		it('shows placeholders instead of an empty list', () => {
			renderWorkbench({ transactionsState: 'loading' })

			// A skeleton, not "no unreconciled transactions" - which would be a claim about the
			// account that has not been established yet.
			expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
			expect(screen.queryByText('No unreconciled transactions found')).not.toBeInTheDocument()
		})

		it('shows placeholders for the candidate list too', async () => {
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchersState: 'loading'
			})

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			expect(screen.queryByText('No vouchers found for this transaction')).not.toBeInTheDocument()
			expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
		})
	})

	/* ─── When the server refuses ───────────────────────────────────────────────────── */

	describe('when the server refuses a read', () => {
		it("reports the transaction list's own refusal verbatim", async () => {
			renderWorkbench({
				transactionsState: 'error',
				listError: makeServerMessagesError('Bank account is disabled')
			})

			await waitFor(() => {
				expect(screen.getByText('Bank account is disabled')).toBeInTheDocument()
			})
		})

		it("reports the candidate list's own refusal verbatim, and offers no confirm", async () => {
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchersState: 'error',
				listError: makeServerMessagesError('Not permitted to read Payment Entry')
			})

			await waitFor(() => {
				expect(screen.getByText('Not permitted to read Payment Entry')).toBeInTheDocument()
			})

			// Nothing is offered for confirmation while the candidate list is unknown.
			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
		})
	})

	/* ─── Transactions older than the chosen range ──────────────────────────────────── */

	describe('transactions older than the chosen range', () => {
		it('warns that the opening balance may not tie out, and widens the range on request', async () => {
			const user = userEvent.setup()
			const { store } = renderWorkbench({ transactions: [DEPOSIT_ROW], olderCount: 3 })

			await waitFor(() => {
				expect(
					screen.getByText(`There are 3 unreconciled transactions before ${'01-01-2024'}.`)
				).toBeInTheDocument()
			})

			await user.click(screen.getByRole('button', { name: /View older transactions/ }))

			// The range moves to the oldest date the server reported, so the next read covers them.
			expect(store.get(bankRecDateAtom)).toEqual({ fromDate: '2023-12-01', toDate: TO_DATE })
		})

		it('words the warning for a single older transaction', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW], olderCount: 1 })

			await waitFor(() => {
				expect(
					screen.getByText(`There is one unreconciled transaction before ${'01-01-2024'}.`)
				).toBeInTheDocument()
			})

			expect(screen.getByRole('button', { name: /View older transaction/ })).toBeInTheDocument()
		})

		it('stays silent when there are none', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW], olderCount: 0 })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			expect(screen.queryByText(/unreconciled transaction/)).not.toBeInTheDocument()
		})
	})
})
