/*
 * The reconciliation workbench. Three properties of this environment shape the harness:
 *
 *  1. Both lists render through `@tanstack/react-virtual`, whose range calculation returns nothing
 *     when the scroll container measures zero - and jsdom performs no layout. The virtualiser reads
 *     the viewport from `offsetHeight`, so {@link stubLayoutMeasurement} gives that one property a
 *     non-zero value; without it NO row renders. The spy is restored per test, because the shared
 *     teardown resets mock functions and not property getters.
 *
 *  2. A router is required, not decorative: the "no transactions" empty state renders a `<Link>`.
 *     A `TooltipProvider` is deliberately NOT supplied by default - the subject wraps every tooltip
 *     it renders in its own provider, and a harness-supplied one would hide a missing local provider
 *     (see `withAncestorTooltipProvider` for the single scoped opt-in, which exists only for the
 *     out-of-scope modal bodies). Jotai is per-provider and the harness performs no global store
 *     reset, so each test builds its own store and seeds `selectedBankAccountAtom` (the component
 *     early-returns without it) and `bankRecDateAtom` (interpolated into the cache keys, so seeding
 *     it keeps key assertions independent of the calendar month).
 *
 *  3. The currency advisory chip is a `Badge` inside a `TooltipTrigger asChild`, and Radix's `Slot`
 *     spreads the trigger's props AFTER the Badge's - so `data-slot="badge"` is OVERWRITTEN with
 *     `data-slot="tooltip-trigger"` while `data-variant`, `data-size` and `data-theme` survive.
 *     {@link currencyAdvisoryChip} therefore selects on the surviving variant triple, scoped to one
 *     row so it cannot collide with the voucher panel's own orange "Partial Match" badge.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	TEST_ALTERNATE_CURRENCY,
	TEST_ALTERNATE_DATE,
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
	makeBankAccountListRow,
	makeBankTransactionRule,
	makeBlankReferenceLinkedPayment,
	makeCurrencyMismatchTransaction,
	makeLinkedPayment,
	makeReconcileSuccessResponse,
	makeReconciledTransaction,
	makeRuleMatchedTransaction,
	makeSelectedBank,
	makeServerMessagesError,
	makeSuggestedLinkedPayment,
	sortLinkedPaymentsAsEndpoint,
	makeUnreconciledTransaction
} from '@/test/factories'

// Use the shared SDK mock because `useReconcileTransaction` requires `useSWRConfig`; `vi.mock` is
// hoisted above the imports.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

/**
 * Toast spies, created with `vi.hoisted` so the `vi.mock` factory below - which the transform lifts
 * above every import - can close over them.
 *
 * ⚠️ MOCKED FOR ISOLATION, NOT FOR CONVENIENCE. `sonner` keeps every emitted notification in a
 * MODULE-LEVEL store, and nothing in this environment ever dismisses one: the toaster itself is
 * mounted in `App.tsx`, which this suite never renders, so a real `toast.success` leaves an entry
 * behind that outlives the test that raised it and is carried into every test that follows in this
 * file. Replacing the module keeps each test's notifications its own, and it also makes them
 * ASSERTABLE - which is the second half of the point: a mock that merely silenced the calls would be
 * weaker than the code it replaced, so the confirm-success and confirm-rejection paths below assert
 * exactly which notification was raised and that the other was not.
 *
 * Only `success` and `error` are stubbed, because they are the only members this component's module
 * graph reaches: `utils.ts:688,710` on the reconcile paths, and the three lazily-imported modal
 * bodies use the same two. `toast.promise` lives in `BankBalance.tsx`, which is not in this graph.
 */
const { toastSuccess, toastError } = vi.hoisted(() => ({
	toastSuccess: vi.fn<(message: string, options?: unknown) => void>(),
	toastError: vi.fn<(message: string, options?: unknown) => void>()
}))

vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))

import MatchAndReconcile from './MatchAndReconcile'
import {
	bankRecAmountFilter,
	bankRecDateAtom,
	bankRecErrorDialogAtom,
	bankRecSelectedTransactionAtom,
	selectedBankAccountAtom
} from './bankRecAtoms'
import type { LinkedPayment, UnreconciledTransaction, useGetRuleForTransaction } from './utils'

type QueryResponse = ReturnType<typeof frappeSDKMock.useFrappeGetCall>

type QueryError = NonNullable<QueryResponse['error']>

/**
 * The rule document `RuleAction` renders, taken from the hook that fetches it. Deriving the
 * type from `useGetRuleForTransaction` rather than importing the generated declaration keeps
 * this fixture bound to the same contract the component consumes.
 */
type RuleDocument = NonNullable<ReturnType<typeof useGetRuleForTransaction>['data']>

/**
 * The date range every test seeds. Fixed rather than derived from "this month", because both
 * revalidated cache keys interpolate it and the assertions below spell those keys out in full.
 */
const FROM_DATE = '2024-01-01'
const TO_DATE = '2024-01-31'

const UNRECONCILED_KEY = `bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`
const CLOSING_BALANCE_KEY = `bank-reconciliation-account-closing-balance-${TEST_BANK_ACCOUNT}-${TO_DATE}`

/**
 * The all-transactions key, which the REJECTION path re-reads alongside the unreconciled one. It is
 * the key that can still carry a now-reconciled row, because the unreconciled endpoint filters on
 * `unallocated_amount > 0` and therefore cannot.
 */
const BANK_TRANSACTIONS_KEY = `bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`

const DEFAULT_MATCH_FILTERS = 'payment_entry,journal_entry'

const vouchersKeyFor = (transactionName: string): string =>
	`bank-reconciliation-vouchers-${transactionName}-${FROM_DATE}-${TO_DATE}-${DEFAULT_MATCH_FILTERS}`

const RECONCILE_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.reconcile_vouchers'

/**
 * A realistic non-zero pane height. The component sizes both virtualised viewports from it
 * (`contentHeight - 72` and `contentHeight - 120`), so a zero would starve them even with the
 * measurement stub in place.
 */
const CONTENT_HEIGHT = 800

const BANK = makeSelectedBank()

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
 *
 * Built from the SHARED builder rather than assembled here, because the DocType marks
 * `description_rules` REQUIRED: a rule with no condition rows is a document the server cannot
 * produce, so a locally-written fixture with an empty table would be asserting against an
 * impossible response. The builder supplies one valid `Contains` row; only the members these tests
 * actually read are overridden.
 */
const MATCHED_RULE: RuleDocument = {
	...makeBankTransactionRule({
		name: TEST_TRANSACTION_RULE,
		rule_name: 'ACME inbound NEFT credits',
		rule_description: 'Credits whose description names ACME Traders',
		transaction_type: 'Deposit',
		priority: 4,
		// The constant rather than `BANK.company`: `company` is optional on a bank account and
		// required on a rule, so reading it off the account would not type-check - and the harness
		// seeds exactly this company, so the two cannot disagree.
		company: TEST_COMPANY,
		classify_as: 'Payment Entry',
		// Deliberately NOT the bank account's own GL account: the card renders this string, and a
		// value shared with the account cell would make `getByText` ambiguous.
		account: 'Debtors - TC',
		party_type: 'Customer',
		party: 'ACME Traders'
	}),
	// Required by the SDK's document wrapper, which is what deriving this type from the hook
	// rather than from the generated declaration surfaces: `FrappeDoc` makes `idx` mandatory even
	// though the DocType declares it optional.
	idx: 0
}

const answered = (data: unknown): QueryResponse => ({
	data,
	error: undefined,
	isLoading: false,
	isValidating: false,
	mutate: frappeHookMutate
})

const fetching = (): QueryResponse => ({
	data: undefined,
	error: undefined,
	isLoading: true,
	isValidating: false,
	mutate: frappeHookMutate
})

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
	transactions?: UnreconciledTransaction[]
	vouchers?: LinkedPayment[]
	selected?: UnreconciledTransaction[]
	/**
	 * The account currency the CURRENT `bank_account.get_list` response carries - i.e. the server's
	 * present answer, which is what the mismatch advisory is required to compare against.
	 *
	 * `account_currency` is not a `Bank Account` field: the endpoint derives it per row from the
	 * linked `Account.account_currency`. Pass `null` to model an account whose currency the endpoint
	 * could not derive; `null` rather than `undefined`, because an omitted option has to remain
	 * distinguishable from one deliberately left unresolved.
	 */
	accountCurrency?: string | null
	withoutBank?: boolean
	transactionsState?: 'loading' | 'error'
	vouchersState?: 'loading' | 'error'
	listError?: QueryError
	rule?: RuleDocument
	olderCount?: number
	dialogError?: QueryError
	amountFilter?: number
	/*
	 * Supplies an ANCESTOR `TooltipProvider`, for the two tests that open a create-a-voucher modal.
	 *
	 * It is off by default and must stay that way. The subject wraps every tooltip IT renders in its
	 * own provider, so the default (absent) case is the real production contract for this file and
	 * is what proves that composition - a harness-supplied provider would hide a missing local one.
	 *
	 * The exception is the lazily-loaded modal BODIES (`TransferModalContent`,
	 * `RecordPaymentModalContent`, `BankEntryModalContent`). Those are separate, out-of-scope
	 * components that legitimately consume the application-level provider `App.tsx` wraps the whole
	 * router in, and they throw without an ancestor. Opting in for exactly those two tests keeps the
	 * compensation visible and scoped, instead of blanketing the whole file with it.
	 */
	withAncestorTooltipProvider?: boolean
}

/*
 * Routes responses by endpoint so the real hooks generate the cache keys, the search grading and the
 * reconcile payload. A single render calls `useFrappeGetCall` with several different methods, so a
 * blanket stub cannot serve them.
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
		dialogError,
		amountFilter,
		withAncestorTooltipProvider = false
	} = options

	const store = createStore()

	if (!withoutBank) {
		store.set(selectedBankAccountAtom, makeSelectedBank({ account_currency: accountCurrency ?? undefined }))
	}
	store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })
	store.set(SELECTED_TRANSACTION_ATOM, selected)

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

		// Shared with the bank picker, which resolves the row's logo. The mismatch advisory compares
		// against the account currency carried by the SELECTED-BANK atom, not against this response.
		//
		// Answered with the ENDPOINT-row builder rather than by spreading `BANK`: that constant is
		// the persisted selection, whose shape differs from this endpoint's projection in both
		// directions (it carries `integration_id`, which is not projected, and lacks
		// `account_subtype`, which is). The row's `name` still matches the selection.
		if (method.endsWith('bank_account.bank_account.get_list')) {
			return answered({
				message: [makeBankAccountListRow({ name: BANK.name, account_currency: accountCurrency ?? undefined })]
			})
		}

		if (method.endsWith('bank_reconciliation_tool.get_older_unreconciled_transactions')) {
			return answered({ message: { count: olderCount, oldest_date: '2023-12-01' } })
		}

		return answered(undefined)
	})

	frappeSDKMock.useFrappeGetDoc.mockImplementation(() => answered(rule))

	/*
	 * By DEFAULT there is no outer `TooltipProvider`. The subject composes its own provider around
	 * every tooltip it renders, and supplying one here unconditionally would MASK a missing local
	 * provider - the component would look mountable in the suite while throwing wherever it is not
	 * wrapped at this level. See `withAncestorTooltipProvider` for the one scoped exception.
	 */
	const subject = (
		<MemoryRouter>
			<MatchAndReconcile contentHeight={CONTENT_HEIGHT} />
		</MemoryRouter>
	)

	const utils = render(
		<Provider store={store}>
			{withAncestorTooltipProvider ? <TooltipProvider>{subject}</TooltipProvider> : subject}
		</Provider>
	)

	return { ...utils, store }
}

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

const ruleBadge = (row: HTMLElement): HTMLElement | null =>
	row.querySelector<HTMLElement>('[data-slot="badge"][data-theme="violet"]')

/**
 * The voucher card enclosing a named voucher, so a confirm control can be scoped to ONE candidate.
 *
 * Resolved upwards from the voucher's own link to the enclosing VIRTUAL ROW - the element the
 * virtualiser stamps with `data-index` and hands to its `measureElement` ref
 * (`MatchAndReconcile.tsx:113-117`). That attribute is functional rather than presentational, so it
 * is exactly as stable as the list itself; scoping on a utility class instead would couple these
 * posting tests to Tailwind, and a harmless restyle of the card's wrapper would fail TC3/TC4 while
 * the behaviour they assert was still correct.
 *
 * The link is unique to the voucher panel, so there is no risk of resolving to a transaction row's
 * virtual wrapper even though both lists are built from the same component.
 */
const voucherCard = (voucher: LinkedPayment): HTMLElement => {
	const card = screen.getByRole('link', { name: voucher.name }).closest<HTMLElement>('[data-index]')

	if (!card) {
		throw new Error(`No voucher card is rendered for "${voucher.name}"`)
	}

	return card
}

const confirmControlFor = (voucher: LinkedPayment): HTMLElement =>
	within(voucherCard(voucher)).getByRole('button', { name: 'Reconcile' })

const capturedReconcileRequest = (): { bank_transaction_name: unknown, vouchers: unknown } => {
	const [payload] = frappePostCall.mock.calls[0] ?? []

	if (!payload) {
		throw new Error('No reconcile request was dispatched')
	}

	return payload as { bank_transaction_name: unknown, vouchers: unknown }
}

const postEndpointsUsed = (): string[] => [
	...new Set(frappeSDKMock.useFrappePostCall.mock.calls.map(([method]) => method))
]

/** Every dialog surface currently mounted, in document order, whether or not Radix has hidden it. */
const dialogSurfaces = (): HTMLElement[] =>
	Array.from(
		document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"], [data-slot="alert-dialog-content"]')
	)

/** The text of every mounted dialog's title, again regardless of whether Radix has hidden it. */
const dialogTitles = (): (string | null)[] =>
	Array.from(
		document.querySelectorAll<HTMLElement>('[data-slot="dialog-title"], [data-slot="alert-dialog-title"]')
	).map((node) => node.textContent)

/**
 * Asserts that a dialog titled `title` is open, then closes EVERY open dialog and waits for the
 * document to be clear of them.
 *
 * ⚠️ WHY THE TITLE IS MATCHED ACROSS ALL DIALOGS RATHER THAN ON `getByRole('dialog')`.
 * Opening the record-payment body auto-opens a NESTED dialog: `RecordPaymentModalContent.tsx:295`
 * raises the "Select Invoices" dialog from an effect whenever the rule it was opened from carries a
 * party, a party type and an account - which the rule fixture here does. Radix marks everything
 * beneath a nested modal `aria-hidden`, and Testing Library's role queries skip hidden subtrees, so
 * `getByRole('dialog')` legitimately resolves to the CHILD dialog and never sees the parent's title.
 * Whether that happens depends only on how quickly the lazily-imported body arrives - i.e. on
 * whether an earlier test in this file already warmed the module cache - which made the previous
 * single-dialog query pass in declaration order and fail under `--sequence.shuffle`. Reading the
 * title slots directly is immune to both the nesting and the timing.
 *
 * Closing is not tidiness either. A Radix dialog manages document-level state while open - it hides
 * the rest of the tree from assistive technology and takes over pointer handling - and a tree
 * unmounted with one still open leaves that state behind for whatever renders next, which
 * suppresses the following test's own dialog. One Escape dismisses one layer, so the loop runs
 * until none is left; each pass must strictly reduce the count, which is what bounds it.
 */
const expectDialogTitled = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
	await waitFor(() => {
		expect(dialogTitles()).toContain(title)
	})

	while (dialogSurfaces().length > 0) {
		const openBefore = dialogSurfaces().length

		await user.keyboard('{Escape}')
		await waitFor(() => {
			expect(dialogSurfaces().length).toBeLessThan(openBefore)
		})
	}

	expect(dialogSurfaces()).toHaveLength(0)
}

/*
 * TIMEOUT: this file declares a per-case budget above Vitest's 5s default, and it is a measurement
 * rather than a preference.
 *
 * These cases mount the whole reconciliation workbench - a virtualised list, the Radix tab shell and
 * the tooltip/theme providers - and several of them then open a voucher route, which awaits a
 * DYNAMICALLY IMPORTED modal body: `RecordPaymentModalContent` is 52 KB of source,
 * `BankEntryModalContent` 34 KB and `TransferModalContent` 24 KB. The first `await import()` of each
 * pays transform and evaluation cost inside the case that happens to reach it first, and the
 * remainder are then served from the module cache - so the expense is real but MOVES: under
 * `--sequence.shuffle` it lands on whichever case runs first, and under `--coverage` V8
 * instrumentation multiplies it. Measured on a four-core runner: the same case ran at 3.0s
 * uninstrumented, 5.1s instrumented, and a different case in the same group peaked at 5.7s once the
 * order changed - i.e. cases whose every assertion passes were failing the `test` and
 * `test:coverage` gates on timing alone, and never the same case twice.
 *
 * A per-case budget was therefore the wrong instrument (it just moves the failure to its neighbour)
 * and a global `testTimeout` in `vitest.config.ts` would be the wrong place - the other seven suites
 * are fast and should keep the strict default, which is what catches a genuine hang early. Declaring
 * it once here scopes the allowance to exactly the suite that needs it: every case in this file
 * inherits it, no case outside it does, and 20s still fails a real hang rather than running forever.
 */
describe('MatchAndReconcile', { timeout: 20000 }, () => {
	let layoutMeasurement: ReturnType<typeof stubLayoutMeasurement>

	/**
	 * Loads the three lazily-imported modal bodies ONCE, before any test runs.
	 *
	 * They are large - 52 KB, 34 KB and 24 KB of TSX with their own dependency graphs - and each is
	 * behind a `lazy()` boundary, so whichever test opens one FIRST pays the whole import cost inside
	 * its own 5 s budget. Under V8 coverage instrumentation with several workers competing that first
	 * open measured over 5 s, which surfaced as an intermittent timeout rather than as a behavioural
	 * failure, and it moved from test to test with `--sequence.shuffle`.
	 *
	 * Warming the cache here makes the cost a fixed, once-per-file charge on a hook with its own
	 * budget, and it makes the module-cache state the same for every test regardless of the order the
	 * runner chose - which is also the second guard against the nested-dialog race documented on
	 * {@link expectDialogTitled}. Nothing is rendered or asserted here: the imports are evaluated for
	 * their side effect on the loader cache alone, and every module they reach that talks to a server
	 * is already mocked above.
	 */
	beforeAll(async () => {
		await Promise.all([
			import('./RecordPaymentModalContent'),
			import('./BankEntryModalContent'),
			import('./TransferModalContent')
		])
	}, 60_000)

	beforeEach(() => {
		// Installed per test rather than once: the shared teardown resets spies created by the
		// fixture module, and a property getter installed at module scope would outlive this file.
		layoutMeasurement = stubLayoutMeasurement()

		// The toast spies belong to THIS file rather than to the shared fixture module, so the shared
		// teardown does not reach them. Reset here so a notification raised by one test can never be
		// read as another test's.
		toastSuccess.mockReset()
		toastError.mockReset()
	})

	afterEach(() => {
		layoutMeasurement.mockRestore()
	})

	describe('before a bank account is chosen', () => {
		it('asks for one and renders no transaction rows', () => {
			renderWorkbench({ withoutBank: true, transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			expect(screen.getByText('Select a bank account to reconcile')).toBeInTheDocument()

			expect(screen.queryByText(DEPOSIT_ROW.description ?? '')).not.toBeInTheDocument()
			expect(screen.queryByText(WITHDRAWAL_ROW.description ?? '')).not.toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
		})
	})

	describe('TC1 - the unreconciled list', () => {
		it('renders one row per transaction the server returned', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})
			expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()

			expect(within(transactionRow(DEPOSIT_ROW)).getByText(/ZEN-778/)).toBeInTheDocument()
			expect(within(transactionRow(WITHDRAWAL_ROW)).getByText(/QUI-991/)).toBeInTheDocument()

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
			expect(within(row).getByText('15-01-2024')).toBeInTheDocument()
			expect(within(row).getByText('NEFT')).toBeInTheDocument()
		})
	})

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

			expect(screen.queryByText('Recommended Action')).not.toBeInTheDocument()
		})

		it("offers the action the rule's OWN classification calls for", async () => {
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

		/**
		 * Offering the right label and then opening the wrong document would be worse than offering
		 * nothing, so the routing is asserted for each classification rather than inferred from the
		 * label.
		 *
		 * One case per test, deliberately. Each pass mounts the workbench and then lazily imports a
		 * modal body of 24-52 KB, so driving all three from a single `it` put one test at ~3 s of the
		 * 5 s default budget in isolation - and over it whenever coverage instrumentation and worker
		 * contention were added, which showed up as an intermittent timeout rather than as a
		 * behavioural failure. Splitting keeps every case comfortably inside the budget and names
		 * exactly which classification broke when one does.
		 */
		const openRecommendedAction = async (
			user: ReturnType<typeof userEvent.setup>,
			classification: RuleDocument['classify_as'],
			expectedTitle: string
		) => {
			// One object in both the list and the selection, exactly as the reviewer's own click would
			// leave it.
			const stamped = makeRuleMatchedTransaction({ description: 'Rule-stamped ACME credit' })

			renderWorkbench({
				transactions: [stamped],
				selected: [stamped],
				rule: { ...MATCHED_RULE, classify_as: classification }
			})

			await user.click(await screen.findByRole('button', { name: new RegExp(`Create ${classification}`) }))
			await expectDialogTitled(user, expectedTitle)
		}

		it('routes a Payment Entry classification to the record-payment document', async () => {
			await openRecommendedAction(userEvent.setup(), 'Payment Entry', 'Record Payment')
		})

		it('routes a Bank Entry classification to the bank-entry document', async () => {
			await openRecommendedAction(userEvent.setup(), 'Bank Entry', 'Bank Entry')
		})

		it('routes a Transfer classification to the transfer document', async () => {
			await openRecommendedAction(userEvent.setup(), 'Transfer', 'Transfer')
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

	describe('creating a voucher instead of matching one', () => {
		it('opens each create-a-voucher route for the transaction under review', async () => {
			const user = userEvent.setup()
			// The only two tests that need an ancestor provider: the lazily-loaded modal BODIES are
			// separate, out-of-scope components that consume the application-level provider.
			renderWorkbench({ transactions: [DEPOSIT_ROW], selected: [DEPOSIT_ROW], withAncestorTooltipProvider: true })

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
				selected: [DEPOSIT_ROW, WITHDRAWAL_ROW],
				// Same reason: this path opens the out-of-scope modal bodies too.
				withAncestorTooltipProvider: true
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
			// Opens the same modal bodies as the test above, hence the same scoped opt-in.
			renderWorkbench({ transactions: [DEPOSIT_ROW], selected: [DEPOSIT_ROW], withAncestorTooltipProvider: true })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			await user.keyboard('{Meta>}p{/Meta}')
			await expectDialogTitled(user, 'Record Payment')

			await user.keyboard('{Meta>}b{/Meta}')
			await expectDialogTitled(user, 'Bank Entry')

			await user.keyboard('{Meta>}i{/Meta}')
			await expectDialogTitled(user, 'Transfer')
		})
	})

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

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})
			expect(store.get(SELECTED_TRANSACTION_ATOM).map((row) => row.name)).toEqual([DEPOSIT_ROW.name])

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
			// reference columns are the empty string. It is included so the badge grid is asserted
			// against the shapes the endpoint actually produces, not only against tidy ones.
			const blankReference = makeBlankReferenceLinkedPayment()

			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested, unrelated, blankReference]
			})

			await waitFor(() => {
				expect(screen.getByRole('link', { name: suggested.name })).toBeInTheDocument()
			})

			// The suggestion is the FIRST candidate that agrees on amount AND on a date or reference —
			// the scoring is `index === 0` gated, which is why position matters here and why the two
			// later rows carry no Suggested badge whatever they agree on.
			const suggestedBadge = within(voucherCard(suggested)).getByText('Suggested')
			expect(suggestedBadge).toHaveAttribute('data-theme', 'green')
			expect(within(voucherCard(unrelated)).queryByText('Suggested')).not.toBeInTheDocument()
			expect(within(voucherCard(blankReference)).queryByText('Suggested')).not.toBeInTheDocument()

			expect(within(voucherCard(suggested)).getByText('Complete Match')).toBeInTheDocument()
			expect(within(voucherCard(unrelated)).getByText('No Match')).toBeInTheDocument()

			// An empty `reference_no` renders no reference row at all, so no grade badge accompanies it.
			expect(within(voucherCard(blankReference)).queryByText('No Match')).not.toBeInTheDocument()
			expect(within(voucherCard(blankReference)).queryByText('Complete Match')).not.toBeInTheDocument()
		})

		it('still suggests a first candidate whose reference genuinely matches', async () => {
			// The legitimate path: a real reference and no date agreement, promoted at index 0 on the
			// strength of the reference alone.
			const candidate = makeLinkedPayment({
				name: 'ACC-PAY-2024-04091',
				reference_no: DEPOSIT_ROW.reference_number,
				paid_amount: DEPOSIT_ROW.unallocated_amount,
				posting_date: TEST_ALTERNATE_DATE,
				reference_date: TEST_ALTERNATE_DATE
			})

			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [candidate]
			})

			await waitFor(() => {
				expect(screen.getByRole('link', { name: candidate.name })).toBeInTheDocument()
			})

			expect(within(voucherCard(candidate)).getByText('Suggested')).toBeInTheDocument()
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

	describe('TC3 - a manual override to a different voucher', () => {
		/**
		 * The suggestion and the override, ORDERED BY THE ENDPOINT'S OWN RULE rather than by hand.
		 *
		 * `check_matching` concatenates every branch's rows and returns them sorted by `rank`
		 * DESCENDING, and each builder derives its rank from its own branch formula - the suggested
		 * Payment Entry agrees on reference, amount and party, giving 4 of that branch's maximum 4,
		 * while the Journal Entry agrees on neither of the two indicators its branch measures, giving
		 * 1 of 3. Passing them through `sortLinkedPaymentsAsEndpoint` is what makes the order a
		 * CONSEQUENCE of those ranks instead of an arrangement the suite asserts and the fixtures
		 * contradict. It matters because the suggestion predicate additionally requires `index === 0`,
		 * so this sort decides which candidate the workbench proposes.
		 */
		const suggested = makeSuggestedLinkedPayment(DEPOSIT_ROW)
		const different = makeAlternateLinkedPayment()
		const candidatesAsReturned = sortLinkedPaymentsAsEndpoint([different, suggested])

		const renderWithBothCandidates = () =>
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: candidatesAsReturned
			})

		it('returns the higher-ranked candidate first, as the endpoint sorts them', () => {
			// The premise every test in this block rests on, asserted rather than assumed.
			expect(suggested.rank).toBe(4)
			expect(different.rank).toBe(1)
			expect(candidatesAsReturned.map((voucher) => voucher.name)).toEqual([suggested.name, different.name])
		})

		it('sends the identity of the voucher the reviewer actually chose', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

			renderWithBothCandidates()

			await waitFor(() => {
				expect(screen.getByRole('link', { name: different.name })).toBeInTheDocument()
			})

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

			// Posting an existing voucher's doctype and name is what selects the server's `Matched`
			// path, so the client side of that is what is asserted: an existing voucher was named and
			// nothing was created.
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

			expect(String(capturedReconcileRequest().vouchers)).not.toContain(suggested.name)
		})
	})

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

			// The request is asserted as the SERVER reads it. `add_payment_entries` consumes
			// `payment_doctype` and `payment_name` and nothing else; it appends the child row at
			// `allocated_amount: 0.0` and `allocate_payment_entries` then derives the real allocation
			// from the voucher's GL entries and its prior allocations. `amount` is a legacy member of
			// the Desk tool's payload that the server IGNORES, so it is asserted as a field that is
			// still sent - not as one that controls anything.
			const [voucherPayload] = JSON.parse(String(capturedReconcileRequest().vouchers)) as {
				payment_doctype: string
				payment_name: string
				amount: number
			}[]

			expect(voucherPayload.payment_doctype).toBe(suggested.doctype)
			expect(voucherPayload.payment_name).toBe(suggested.name)
			expect(voucherPayload.amount).toBe(suggested.paid_amount)

			// And the reviewer is told it succeeded, once, with an Undo offered - not told it failed.
			await waitFor(() => {
				expect(toastSuccess).toHaveBeenCalledTimes(1)
			})
			expect(toastSuccess).toHaveBeenCalledWith(
				'Reconciled',
				expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
			)
			expect(toastError).not.toHaveBeenCalled()
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
			// The unallocated figure alone states the branch: the builder derives the allocated
			// amount, the status and the child allocation row that must accompany it.
			frappePostCall.mockResolvedValue(
				makeReconcileSuccessResponse({ unallocated_amount: 2500 })
			)

			const { store } = await confirmSuggested()

			await waitFor(() => {
				expect(frappeSWRMutate).toHaveBeenCalledWith(vouchersKeyFor(DEPOSIT_ROW.name))
			})
			expect(frappeSWRMutate).toHaveBeenCalledWith(UNRECONCILED_KEY)
			expect(frappeSWRMutate).toHaveBeenCalledWith(CLOSING_BALANCE_KEY)

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

			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
		})

		/*
		 * FM1/FM3/TC6. A refusal is reported and NOTHING is mutated optimistically: the selected row
		 * keeps the state the server gave it, no row is marked reconciled, and the authoritative reads
		 * are revalidated so the server's own answer is what corrects the client.
		 */
		it('reports the refusal and leaves the transaction unreconciled and unchanged', async () => {
			const user = userEvent.setup()
			const refusal = makeAlreadyReconciledError(DEPOSIT_ROW.name)
			frappePostCall.mockRejectedValue(refusal)

			const { store } = renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested]
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})
			await user.click(confirmControlFor(suggested))

			// The raw rejection reaches the shared dialog by identity, and the row is untouched.
			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
			})
			expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([DEPOSIT_ROW])
			expect(store.get(SELECTED_TRANSACTION_ATOM)?.[0].status).toBe('Unreconciled')

			// One request, and nothing was posted: the reviewer is told it failed.
			expect(frappePostCall).toHaveBeenCalledTimes(1)
			expect(toastSuccess).not.toHaveBeenCalled()
			await waitFor(() => {
				expect(toastError).toHaveBeenCalledTimes(1)
			})
		})

		it('does not retry a refused post, so a refusal cannot become a duplicate posting', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(makeAlreadyReconciledError(DEPOSIT_ROW.name))

			// Even when the follow-up revalidation itself fails, the client makes exactly one attempt:
			// a second post would be one made without knowing the outcome of the first.
			frappeSWRMutate.mockRejectedValue(new Error('revalidation unavailable'))

			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested]
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})
			await user.click(confirmControlFor(suggested))

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledTimes(1)
			})

			// Given time for any deferred retry to land, there is still exactly one request.
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(frappePostCall).toHaveBeenCalledTimes(1)
		})

		/*
		 * The ACCEPTED path advances the reviewer from the REFRESHED list rather than from the
		 * snapshot it posted against. Holding the invalidation open makes that observable: until it
		 * resolves the selection is untouched, and when it does the transaction is absent from the
		 * refreshed list, so the selection is emptied and there is nothing left to confirm.
		 */
		it('advances the selection only once the accepted post\'s refresh converges', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

			let releaseRefresh!: () => void
			const heldRefresh = new Promise<undefined>((resolve) => {
				releaseRefresh = () => resolve(undefined)
			})
			frappeSWRMutate.mockImplementation(() => heldRefresh)

			const { store } = renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested]
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})
			await user.click(confirmControlFor(suggested))

			await waitFor(() => {
				expect(toastSuccess).toHaveBeenCalledTimes(1)
			})

			// Not yet converged: nothing has been written to the selection from a list nobody has read.
			expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([DEPOSIT_ROW])

			await act(async () => {
				releaseRefresh()
				await heldRefresh
			})

			await waitFor(() => {
				expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
			})
			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
			expect(frappePostCall).toHaveBeenCalledTimes(1)
		})
	})

	describe('TC5 and FM3 - an already-reconciled transaction cannot be reconciled again', () => {
		/**
		 * A transaction the server considers fully reconciled. BOTH signals are set because the
		 * server derives them from one another - `status === 'Reconciled'` holds exactly when
		 * `unallocated_amount <= 0` - so setting only one would model a state the server can never
		 * produce, and the guard would be tested against a fiction.
		 *
		 * HOW SUCH A ROW REACHES THIS SURFACE, precisely. It does NOT arrive in this tab's list:
		 * `useGetUnreconciledTransactions` calls `get_bank_transactions` WITHOUT `all_transactions`,
		 * and the endpoint filters `unallocated_amount > 0` server-side, so a reconciled row is never
		 * among the rows rendered here. The unfiltered set is requested by a DIFFERENT tab
		 * (`BankTransactionList`), which renders no Reconcile control at all.
		 *
		 * It reaches this surface through the SELECTION, which is where the guard reads it from:
		 * `bankRecSelectedTransactionAtom` holds a row captured earlier, and this tab's list
		 * revalidates neither on focus nor when stale - so a selection made before a reconciliation
		 * (performed here in another tab, in the Desk, or by a rule) outlives it. Every case below
		 * therefore seeds the SELECTION with the settled row while the list answers with rows the
		 * endpoint could really return.
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
				// The endpoint's own answer, which cannot contain the settled row.
				transactions: [stillUnreconciled],
				// ...while the persisted selection still names it.
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
				transactions: [stillUnreconciled],
				selected: [reconciled],
				vouchers: [makeSuggestedLinkedPayment(reconciled)]
			})

			const control = await screen.findByRole('button', { name: 'Reconcile' })
			await user.click(control)

			expect(frappePostCall).not.toHaveBeenCalled()
		})

		it('keeps the reason discoverable, since a disabled control fires no events of its own', async () => {
			renderWorkbench({
				transactions: [stillUnreconciled],
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

			expect(control.parentElement).not.toHaveAttribute('data-slot', 'tooltip-trigger')
		})

		/*
		 * The guard governs the ACTION, never the VISIBILITY, and this is asserted on rows the
		 * endpoint can really return.
		 *
		 * It previously handed the workbench list a RECONCILED row and asserted that it rendered - a
		 * premise this endpoint cannot satisfy, because `useGetUnreconciledTransactions` omits
		 * `all_transactions` and the server filters `unallocated_amount > 0`. Passing an impossible
		 * response made the test unfalsifiable in the direction that mattered: it would have gone on
		 * passing if the client had started filtering by status itself, since the fixture guaranteed
		 * a row the client would then have hidden. Rendering exactly what the endpoint returns is the
		 * contract, so the fixture is now exactly what it returns.
		 */
		it('renders every row the endpoint returns, filtering none of them client-side', async () => {
			const secondOpenRow = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-05005',
				description: 'Second open wire',
				status: 'Unreconciled',
				unallocated_amount: TEST_TRANSACTION_AMOUNT
			})

			renderWorkbench({ transactions: [stillUnreconciled, secondOpenRow] })

			await waitFor(() => {
				expect(transactionRow(stillUnreconciled)).toBeInTheDocument()
			})

			expect(transactionRow(secondOpenRow)).toBeInTheDocument()
			expect(screen.getByText('2 results')).toBeInTheDocument()
		})

		/*
		 * THE STALE-CLIENT CASE, end to end. A client holding a row the server has since settled can
		 * still reach an enabled control, because its list revalidates neither on focus nor when
		 * stale - so the guard cannot be a first-load-only check. The server refuses, its own words
		 * are reported verbatim in the dismissible dialog, and BOTH authoritative reads are
		 * revalidated so the server's answer is what corrects the client. No status is written
		 * locally anywhere and nothing is mutated optimistically.
		 */
		it('reports the server\'s own words and re-reads the server after a refusal', async () => {
			const user = userEvent.setup()
			const stale = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-05004',
				description: 'Reconciled behind this client\'s back',
				status: 'Unreconciled',
				unallocated_amount: TEST_TRANSACTION_AMOUNT
			})

			frappePostCall.mockRejectedValue(makeAlreadyReconciledError(stale.name))

			const { store } = renderWorkbench({
				transactions: [stale],
				selected: [stale],
				vouchers: [makeSuggestedLinkedPayment(stale)]
			})

			// The stale snapshot genuinely offers the action - which is the premise of the case.
			const control = await screen.findByRole('button', { name: 'Reconcile' })
			expect(control).toBeEnabled()

			await user.click(control)

			// The refusal is reported in the dismissible dialog, verbatim.
			expect(await screen.findByRole('alertdialog')).toHaveTextContent(
				formatAlreadyReconciledMessage(stale.name)
			)

			await user.click(await screen.findByRole('button', { name: 'Dismiss' }))

			// ...and dismissing it changes nothing else: the row is exactly as the server left it, with
			// no local status written and nothing marked reconciled.
			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
			expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([stale])
			expect(store.get(SELECTED_TRANSACTION_ATOM)?.[0].status).toBe('Unreconciled')

			// Both authoritative reads were revalidated, so the row's true state comes from the
			// server's current answer rather than from this client.
			expect(frappeSWRMutate).toHaveBeenCalledWith(UNRECONCILED_KEY)
			expect(frappeSWRMutate).toHaveBeenCalledWith(BANK_TRANSACTIONS_KEY)

			expect(frappePostCall).toHaveBeenCalledTimes(1)

			// The notification carries the SERVER's own words, and no success is ever claimed - the
			// dialog and the toast read the same resolved error, so they cannot disagree about it.
			expect(toastError).toHaveBeenCalledTimes(1)
			expect(toastError).toHaveBeenCalledWith(
				'Error',
				expect.objectContaining({ description: formatAlreadyReconciledMessage(stale.name) })
			)
			expect(toastSuccess).not.toHaveBeenCalled()
		})
	})

	describe('FM5 - a currency mismatch warns without blocking', () => {
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
			renderWorkbench({
				transactions: [makeReconciledTransaction({ description: 'Already reconciled wire' })],
				dialogError: makeAlreadyReconciledError('ACC-BTN-2024-00003')
			})

			const dialog = await screen.findByRole('alertdialog')

			expect(dialog).toHaveTextContent(formatAlreadyReconciledMessage('ACC-BTN-2024-00003'))
		})
	})

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

			const amountInput = screen.getByPlaceholderText('₹0.00')

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
			expect(screen.queryByRole('button', { name: 'Clear Filters' })).not.toBeInTheDocument()
		})
	})

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
