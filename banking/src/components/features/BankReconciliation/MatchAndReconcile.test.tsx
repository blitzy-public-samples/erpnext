/*
 * The reconciliation workbench. Three properties of this environment shape the harness:
 *
 *  1. Both lists render through `@tanstack/react-virtual`, which reads its viewport from
 *     `offsetHeight` and renders NO row when that measures zero - as it does under jsdom, which
 *     performs no layout. {@link stubLayoutMeasurement} answers that one property.
 *
 *  2. A router is required rather than decorative: the empty state renders a `<Link>`. A
 *     `TooltipProvider` is deliberately NOT supplied by default, because the subject wraps every
 *     tooltip it renders in its own provider and a harness-supplied one would hide a missing local
 *     provider. Jotai is per-provider and the harness performs no global store reset, so each test
 *     builds its own store and seeds `selectedBankAccountAtom` (the component early-returns without
 *     it) and `bankRecDateAtom` (interpolated into the cache keys).
 *
 *  3. Radix's `Slot` spreads a `TooltipTrigger asChild`'s props AFTER its child's, so whatever the
 *     trigger wraps is stamped `data-slot="tooltip-trigger"`. The advisory's trigger is the focusable
 *     span AROUND its badge, so the badge keeps its own slot and the span is addressable by its
 *     accessible name.
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
	frappeContextValue,
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
 * Mocked for ISOLATION, not convenience: `sonner` keeps every emitted notification in a module-level
 * store and nothing here ever dismisses one, because the toaster is mounted in `App.tsx`, which this
 * suite never renders. Replacing the module keeps each test's notifications its own and makes them
 * assertable. Only `success` and `error` are stubbed, the two members this module graph reaches.
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
	bankRecLastRefusalAtom,
	bankRecReconcileInFlightAtom,
	bankRecSelectedTransactionsAtom,
	selectedBankAccountAtom
} from './bankRecAtoms'
import type { LinkedPayment, UnreconciledTransaction, useGetRuleForTransaction } from './utils'

type QueryResponse = ReturnType<typeof frappeSDKMock.useFrappeGetCall>

type QueryError = NonNullable<QueryResponse['error']>

type RuleDocument = NonNullable<ReturnType<typeof useGetRuleForTransaction>['data']>

const FROM_DATE = '2024-01-01'
const TO_DATE = '2024-01-31'

const UNRECONCILED_KEY = `bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`
const CLOSING_BALANCE_KEY = `bank-reconciliation-account-closing-balance-${TEST_BANK_ACCOUNT}-${TO_DATE}`

const BANK_TRANSACTIONS_KEY = `bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`

const DEFAULT_MATCH_FILTERS = 'payment_entry,journal_entry'

const vouchersKeyFor = (transactionName: string): string =>
	`bank-reconciliation-vouchers-${transactionName}-${FROM_DATE}-${TO_DATE}-${DEFAULT_MATCH_FILTERS}`

const RECONCILE_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.reconcile_vouchers'

/**
 * A realistic non-zero pane height. The component sizes both virtualised viewports from it, so a
 * zero would starve them even with the measurement stub in place.
 */
const CONTENT_HEIGHT = 800

const BANK = makeSelectedBank()

const SELECTED_TRANSACTION_ATOM = bankRecSelectedTransactionsAtom

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
 * A rule as the server stores it, driving the recommended-action card a rule-matched transaction
 * opens; `classify_as: 'Payment Entry'` selects that card's green branch. Built from the shared
 * builder because the DocType marks `description_rules` REQUIRED, so a locally written fixture with
 * an empty table would assert against a document the server cannot produce.
 */
const MATCHED_RULE: RuleDocument = {
	...makeBankTransactionRule({
		name: TEST_TRANSACTION_RULE,
		rule_name: 'ACME inbound NEFT credits',
		rule_description: 'Credits whose description names ACME Traders',
		transaction_type: 'Deposit',
		priority: 4,
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
 * `@tanstack/react-virtual` reads its container height from `offsetHeight`, and jsdom reports zero
 * for every element, at which point the range calculation returns nothing and the lists render no
 * rows at all. Returned so the caller can restore it: the shared teardown resets mock FUNCTIONS, not
 * property getters.
 */
const stubLayoutMeasurement = () =>
	vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(CONTENT_HEIGHT)

interface WorkbenchOptions {
	transactions?: UnreconciledTransaction[]
	vouchers?: LinkedPayment[]
	selected?: UnreconciledTransaction[]
	/**
	 * The account currency the CURRENT `bank_account.get_list` response carries. It is not a
	 * `Bank Account` field - the endpoint derives it per row from the linked `Account.account_currency`
	 * - so pass `null` to model an account whose currency it could not derive, `null` rather than
	 * `undefined` so an omitted option stays distinguishable from one deliberately unresolved.
	 *
	 * This, and NOT {@link WorkbenchOptions.persistedAccountCurrency}, is what the advisory compares
	 * against.
	 */
	accountCurrency?: string | null
	/**
	 * The account currency the `localStorage`-backed selection remembers, which defaults to whatever
	 * the endpoint currently reports. Set it apart from {@link WorkbenchOptions.accountCurrency} to
	 * model a snapshot that has gone stale - the endpoint answer must win.
	 */
	persistedAccountCurrency?: string | null
	/** Leaves `bank_account.get_list` in flight, so no current account currency is known yet. */
	bankAccountsState?: 'loading'
	withoutBank?: boolean
	transactionsState?: 'loading' | 'error'
	vouchersState?: 'loading' | 'error'
	listError?: QueryError
	rule?: RuleDocument
	olderCount?: number
	dialogError?: QueryError
	amountFilter?: number
	/**
	 * Pre-set the SHARED reconcile in-flight atom, i.e. render as though a post were already
	 * outstanding for this transaction. Distinct from the per-instance `loading` flag that
	 * `useFrappePostCall` returns - the whole point of N-10 is that those two are not the same thing.
	 */
	reconcileInFlight?: string
	/*
	 * Supplies an ANCESTOR `TooltipProvider`, and is off by default deliberately: the subject wraps
	 * every tooltip IT renders in its own provider, so the absent case is the production contract this
	 * file proves. The exception is the lazily loaded modal BODIES, which are separate components that
	 * legitimately consume the application-level provider and throw without an ancestor.
	 */
	withAncestorTooltipProvider?: boolean
}

const renderWorkbench = (options: WorkbenchOptions = {}) => {
	const {
		transactions = [],
		vouchers = [],
		selected = [],
		accountCurrency = TEST_CURRENCY,
		persistedAccountCurrency = accountCurrency,
		bankAccountsState,
		withoutBank = false,
		transactionsState,
		vouchersState,
		listError = makeServerMessagesError('Something went wrong on the server'),
		rule,
		olderCount = 0,
		dialogError,
		amountFilter,
		reconcileInFlight,
		withAncestorTooltipProvider = false
	} = options

	const store = createStore()

	if (!withoutBank) {
		store.set(selectedBankAccountAtom, makeSelectedBank({ account_currency: persistedAccountCurrency }))
	}
	store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })
	store.set(SELECTED_TRANSACTION_ATOM, selected)

	if (dialogError) {
		store.set(bankRecErrorDialogAtom, dialogError)
	}
	if (amountFilter !== undefined) {
		store.set(bankRecAmountFilter, { value: amountFilter, stringValue: String(amountFilter) })
	}
	if (reconcileInFlight !== undefined) {
		store.set(bankRecReconcileInFlightAtom, reconcileInFlight)
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

		// Answered with the ENDPOINT-row builder rather than by spreading `BANK`: that constant is the
		// persisted selection, whose shape differs from this endpoint's projection in both directions.
		// THIS is the response the currency advisory compares against.
		if (method.endsWith('bank_account.bank_account.get_list')) {
			if (bankAccountsState === 'loading') return fetching()
			return answered({
				message: [makeBankAccountListRow({ name: BANK.name, account_currency: accountCurrency })]
			})
		}

		if (method.endsWith('bank_reconciliation_tool.get_older_unreconciled_transactions')) {
			return answered({ message: { count: olderCount, oldest_date: '2023-12-01' } })
		}

		return answered(undefined)
	})

	frappeSDKMock.useFrappeGetDoc.mockImplementation(() => answered(rule))

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
 * Found through its own trigger's accessible name rather than through Badge's presentational
 * attributes. An earlier version pinned `data-size="sm"`, which quietly made the chip's geometry part
 * of the contract these tests enforce - so correcting that geometry to match its neighbours would have
 * failed fourteen assertions that were never about size. The accessible name is what actually
 * identifies this affordance, and it is also what a reviewer using assistive technology hears, so it
 * cannot drift without a user-visible change.
 */
const currencyAdvisoryChip = (row: HTMLElement): HTMLElement | null =>
	row.querySelector<HTMLElement>('[aria-label^="Currency mismatch"] [data-slot="badge"]')

const ruleBadge = (row: HTMLElement): HTMLElement | null =>
	row.querySelector<HTMLElement>('[data-slot="badge"][data-theme="violet"]')

/**
 * The voucher card enclosing a named voucher, so a confirm control can be scoped to ONE candidate.
 *
 * Resolved upwards from the voucher's own link to the virtual row the virtualiser stamps with
 * `data-index`. That attribute is functional rather than presentational, so it is as stable as the
 * list itself, whereas scoping on a utility class would couple these tests to Tailwind.
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

const dialogSurfaces = (): HTMLElement[] =>
	Array.from(
		document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"], [data-slot="alert-dialog-content"]')
	)

const dialogTitles = (): (string | null)[] =>
	Array.from(
		document.querySelectorAll<HTMLElement>('[data-slot="dialog-title"], [data-slot="alert-dialog-title"]')
	).map((node) => node.textContent)

/**
 * Asserts that a dialog titled `title` is open, then closes EVERY open dialog and waits for the
 * document to be clear of them.
 *
 * The title is matched across all dialogs rather than through `getByRole('dialog')` because opening
 * the record-payment body auto-opens a NESTED dialog. Radix marks everything beneath a nested modal
 * `aria-hidden` and role queries skip hidden subtrees, so a role query can resolve to the CHILD and
 * never see the parent's title - and whether it does depends on how quickly the lazily imported body
 * arrives, i.e. on module-cache warmth and therefore on test order.
 *
 * Closing is not tidiness: a Radix dialog manages document-level state while open, and a tree
 * unmounted with one still open suppresses the next test's dialog. One Escape dismisses one layer, so
 * the loop runs until none is left and each pass must strictly reduce the count.
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
 * TIMEOUT: this file declares a per-suite budget above Vitest's 5 s default because these cases mount
 * the whole workbench and several then await a DYNAMICALLY IMPORTED modal body. The first
 * `await import()` pays transform and evaluation cost inside whichever case reaches it first, so the
 * expense moves with test order and is multiplied by coverage instrumentation, which can fail a case
 * on timing alone.
 *
 * Declared here rather than as a global `testTimeout`, so the allowance is scoped to the one suite
 * that needs it while the other suites keep the strict default that catches a genuine hang early.
 */
describe('MatchAndReconcile', { timeout: 20000 }, () => {
	let layoutMeasurement: ReturnType<typeof stubLayoutMeasurement>

	/**
	 * Loads the three lazily imported modal bodies ONCE, before any test runs. Each is large and sits
	 * behind a `lazy()` boundary, so whichever test opens one first would otherwise pay the whole
	 * import cost inside its own budget - which surfaced as an intermittent timeout that moved between
	 * tests with `--sequence.shuffle`.
	 *
	 * Warming the cache makes that a fixed once-per-file charge and makes module-cache state identical
	 * for every test regardless of order, which is also the second guard against the nested-dialog race
	 * documented on {@link expectDialogTitled}. Nothing is rendered or asserted here.
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

		// The refusal path re-reads the all-transactions list imperatively, because SWR revalidates a key
		// only through a MOUNTED subscriber and the tab rendering that list is never mounted here. The
		// imperative seam rejects when unconfigured, so it is answered for every test rather than only in
		// the ones that assert on it - individual tests override this with their own answer.
		frappeContextValue.call.get.mockResolvedValue({ message: [] })
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
			const first = makeUnreconciledTransaction({ name: 'ACC-BTN-2024-02001', description: 'Repeat wire' })
			const second = makeUnreconciledTransaction({ name: 'ACC-BTN-2024-02002', description: 'Repeat wire' })

			renderWorkbench({ transactions: [first, second] })

			await waitFor(() => {
				expect(screen.getAllByText('Repeat wire')).toHaveLength(2)
			})
			expect(screen.getByText('2 results')).toBeInTheDocument()
		})

		it('resolves amounts through the currency helpers', async () => {
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

	/*
	 * Every row states an amount and a direction, and the three directions the server can report are
	 * three states rather than two. A statement row carrying nothing in either amount column is a real
	 * thing: it used to render a bare, unformatted `0` text node with no amount element at all, above the
	 * green arrow that means money arrived.
	 */
	describe('the amount and the direction on every row', () => {

		const ZERO_ROW = makeUnreconciledTransaction({
			name: 'ACC-BTN-2024-09001',
			description: 'Statement row carrying no amount',
			reference_number: 'NIL-000',
			withdrawal: 0,
			deposit: 0,
			unallocated_amount: 500
		})

		/** Every non-empty text node directly rendered inside the row, so a stray `0` cannot hide. */
		const textNodesIn = (row: HTMLElement): string[] => {
			const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
			const found: string[] = []

			while (walker.nextNode()) {
				const text = walker.currentNode.textContent?.trim()
				if (text) found.push(text)
			}

			return found
		}

		it('formats a zero amount as currency rather than printing a bare 0', async () => {
			renderWorkbench({ transactions: [ZERO_ROW] })

			await waitFor(() => {
				expect(transactionRow(ZERO_ROW)).toBeInTheDocument()
			})

			const row = transactionRow(ZERO_ROW)

			expect(row.textContent).toMatch(/₹\s?0\.00/)
			// The regression was a text node holding exactly "0", produced by `amount && amount > 0 &&`.
			expect(textNodesIn(row)).not.toContain('0')
		})

		it('reports no direction at all on a row with no amount, rather than claiming money arrived', async () => {
			renderWorkbench({ transactions: [ZERO_ROW] })

			await waitFor(() => {
				expect(transactionRow(ZERO_ROW)).toBeInTheDocument()
			})

			const row = transactionRow(ZERO_ROW)
			const direction = within(row).getByRole('img', { name: 'No amount recorded' })

			expect(direction).toHaveAttribute('data-direction', 'none')
			expect(within(row).queryByRole('img', { name: 'Money in' })).not.toBeInTheDocument()
			expect(within(row).queryByRole('img', { name: 'Money out' })).not.toBeInTheDocument()
		})

		it('still shows the unallocated figure on a zero-amount row, since the two differ', async () => {
			renderWorkbench({ transactions: [ZERO_ROW] })

			await waitFor(() => {
				expect(transactionRow(ZERO_ROW)).toBeInTheDocument()
			})

			const row = transactionRow(ZERO_ROW)
			expect(within(row).getByText(/Unallocated/)).toBeInTheDocument()
			expect(row.textContent).toMatch(/₹\s?500\.00/)
		})

		it('names the direction of a credit and of a debit, so colour is not the only signal', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			const credit = within(transactionRow(DEPOSIT_ROW)).getByRole('img', { name: 'Money in' })
			expect(credit).toHaveAttribute('data-direction', 'deposit')
			// The same words within reach of the pointer, not only of a screen reader.
			expect(credit).toHaveAttribute('title', 'Money in')

			const debit = within(transactionRow(WITHDRAWAL_ROW)).getByRole('img', { name: 'Money out' })
			expect(debit).toHaveAttribute('data-direction', 'withdrawal')
			expect(debit).toHaveAttribute('title', 'Money out')
		})
	})

	/*
	 * A long narrative, reference or type must not be able to grow a row without limit or to sit across
	 * the amount it belongs to. jsdom computes no layout, so what is pinned here is the mechanism that
	 * constrains it; the rendered geometry is measured in a real browser.
	 */
	describe('long transaction content stays constrained', () => {

		const LONG_ROW = makeUnreconciledTransaction({
			name: 'ACC-BTN-2024-09101',
			// Trimmed: the text queries normalise and trim, so a trailing space would never match.
			description: 'Multi-line statement narrative that runs on '.repeat(6).trim(),
			reference_number: 'LONGREF-'.repeat(12).concat('END'),
			transaction_type: 'International Wire Transfer Credit Advice With A Very Long Name',
			deposit: 987654.32,
			withdrawal: 0,
			unallocated_amount: 987654.32
		})

		it('clamps the description and leaves the whole of it on the title', async () => {
			renderWorkbench({ transactions: [LONG_ROW] })

			await waitFor(() => {
				expect(transactionRow(LONG_ROW)).toBeInTheDocument()
			})

			const description = within(transactionRow(LONG_ROW)).getByTitle(LONG_ROW.description ?? '')
			expect(description.className).toContain('line-clamp-2')
			expect(description).toHaveTextContent('Multi-line statement narrative that runs on')
		})

		it('keeps the date on one line and stops it shrinking', async () => {
			renderWorkbench({ transactions: [LONG_ROW] })

			await waitFor(() => {
				expect(transactionRow(LONG_ROW)).toBeInTheDocument()
			})

			const date = within(transactionRow(LONG_ROW)).getByText('15-01-2024')
			expect(date.className).toContain('whitespace-nowrap')
			expect(date.className).toContain('shrink-0')
		})

		it('lets the text column narrow and refuses to let the amount column give way', async () => {
			renderWorkbench({ transactions: [LONG_ROW] })

			await waitFor(() => {
				expect(transactionRow(LONG_ROW)).toBeInTheDocument()
			})

			const row = transactionRow(LONG_ROW)
			const amount = within(row).getByText(/₹\s?987,654\.32/)
			const amountColumn = amount.parentElement

			expect(amountColumn?.className).toContain('shrink-0')

			// `min-width:auto` is the flex default, and it is what let this column push itself over the
			// amounts instead of narrowing.
			const textColumn = amountColumn?.previousElementSibling as HTMLElement | null
			expect(textColumn?.className).toContain('min-w-0')
			expect(textColumn?.className).toContain('flex-1')
		})

		it('bounds the reference and type badges and keeps each full value discoverable', async () => {
			renderWorkbench({ transactions: [LONG_ROW] })

			await waitFor(() => {
				expect(transactionRow(LONG_ROW)).toBeInTheDocument()
			})

			const row = transactionRow(LONG_ROW)

			expect(within(row).getByTitle(LONG_ROW.reference_number ?? '').className).toMatch(/max-w-/)
			expect(within(row).getByTitle(LONG_ROW.transaction_type ?? '').className).toMatch(/max-w-/)
		})
	})

	/*
	 * The row advertises `role="button"`, and a `div` receives no keyboard activation from the browser -
	 * so Enter did nothing and Space scrolled the virtualised list, carrying the focused row out of sight.
	 */
	describe('selecting a transaction from the keyboard', () => {

		it('selects the focused row on Enter', async () => {
			const user = userEvent.setup()
			const { store } = renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			act(() => {
				transactionRow(DEPOSIT_ROW).focus()
			})
			expect(transactionRow(DEPOSIT_ROW)).toHaveFocus()

			await user.keyboard('{Enter}')

			expect(store.get(SELECTED_TRANSACTION_ATOM).map((row) => row.name)).toEqual([DEPOSIT_ROW.name])
		})

		it('selects the focused row on Space', async () => {
			const user = userEvent.setup()
			const { store } = renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()
			})

			act(() => {
				transactionRow(WITHDRAWAL_ROW).focus()
			})

			await user.keyboard('[Space]')

			expect(store.get(SELECTED_TRANSACTION_ATOM).map((row) => row.name)).toEqual([WITHDRAWAL_ROW.name])
		})

		it('swallows the Space keypress, so the list cannot scroll the focused row away', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
			act(() => {
				transactionRow(DEPOSIT_ROW).dispatchEvent(space)
			})

			expect(space.defaultPrevented).toBe(true)
		})

		it('leaves any other key to the browser', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
			act(() => {
				transactionRow(DEPOSIT_ROW).dispatchEvent(arrow)
			})

			expect(arrow.defaultPrevented).toBe(false)
		})

		it('extends the selection when Shift is held, exactly as shift-clicking does', async () => {
			const user = userEvent.setup()
			const { store } = renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			act(() => {
				transactionRow(DEPOSIT_ROW).focus()
			})
			await user.keyboard('{Enter}')

			act(() => {
				transactionRow(WITHDRAWAL_ROW).focus()
			})
			await user.keyboard('{Shift>}{Enter}{/Shift}')

			await waitFor(() => {
				expect(screen.getByText('2 transactions selected')).toBeInTheDocument()
			})
			expect(store.get(SELECTED_TRANSACTION_ATOM).map((row) => row.name)).toEqual([
				DEPOSIT_ROW.name,
				WITHDRAWAL_ROW.name
			])
		})

		it('announces which row is selected, and carries a focus treatment', async () => {
			const user = userEvent.setup()
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})

			expect(transactionRow(DEPOSIT_ROW)).toHaveAttribute('aria-pressed', 'false')
			// `aria-selected` is not allowed on `role="button"` and would be discarded, so the state a
			// button may carry is the one used - the same one the bank cards use.
			expect(transactionRow(DEPOSIT_ROW)).not.toHaveAttribute('aria-selected')
			expect(transactionRow(DEPOSIT_ROW)).toHaveAttribute('tabindex', '0')
			expect(transactionRow(DEPOSIT_ROW).className).toContain('focus-visible:shadow-focus-gray')

			await user.click(transactionRow(DEPOSIT_ROW))

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toHaveAttribute('aria-pressed', 'true')
			})
			expect(transactionRow(WITHDRAWAL_ROW)).toHaveAttribute('aria-pressed', 'false')
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
		 * Opens the recommended action for a rule-stamped transaction and asserts which document the
		 * classification routed to, by the title on the dialog SHELL.
		 *
		 * `withAncestorTooltipProvider` is REQUIRED here, and this is the documented modal-BODY
		 * exception rather than a convenience: the bodies these routes open are separate components
		 * that legitimately consume the application-level provider `App.tsx` mounts, and
		 * `BankEntryModalContent` and `RecordPaymentModalContent` each render a bare `Tooltip`. The
		 * shell title this helper waits on appears BEFORE the lazily imported body mounts, so without
		 * an ancestor provider whether the body's tooltip renders at all - and therefore whether Radix
		 * throws `Tooltip must be used within TooltipProvider` - depends on test order. Supplying the
		 * provider is what makes the assertion about routing and nothing else.
		 */
		const openRecommendedAction = async (
			user: ReturnType<typeof userEvent.setup>,
			classification: RuleDocument['classify_as'],
			expectedTitle: string
		) => {
			const stamped = makeRuleMatchedTransaction({ description: 'Rule-stamped ACME credit' })

			renderWorkbench({
				transactions: [stamped],
				selected: [stamped],
				rule: { ...MATCHED_RULE, classify_as: classification },
				withAncestorTooltipProvider: true
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

			// Opens a modal BODY, so the ancestor provider is supplied for the reason given on
			// {@link openRecommendedAction}: the routing assertion must not depend on whether the
			// lazily imported body has mounted by the time the shell title is observed.
			renderWorkbench({
				transactions: [stamped],
				selected: [stamped],
				rule: { ...MATCHED_RULE, classify_as: 'Transfer' },
				withAncestorTooltipProvider: true
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

			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: /Record a bank journal entry/ })).toBeInTheDocument()
		})

		it('grades each candidate against the transaction under review', async () => {
			const suggested = makeSuggestedLinkedPayment(DEPOSIT_ROW)
			const unrelated = makeAlternateLinkedPayment()
			const blankReference = makeBlankReferenceLinkedPayment()

			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested, unrelated, blankReference]
			})

			await waitFor(() => {
				expect(screen.getByRole('link', { name: suggested.name })).toBeInTheDocument()
			})

			const suggestedBadge = within(voucherCard(suggested)).getByText('Suggested')
			expect(suggestedBadge).toHaveAttribute('data-theme', 'green')
			expect(within(voucherCard(unrelated)).queryByText('Suggested')).not.toBeInTheDocument()
			expect(within(voucherCard(blankReference)).queryByText('Suggested')).not.toBeInTheDocument()

			expect(within(voucherCard(suggested)).getByText('Complete Match')).toBeInTheDocument()
			expect(within(voucherCard(unrelated)).getByText('No Match')).toBeInTheDocument()

			expect(within(voucherCard(blankReference)).queryByText('No Match')).not.toBeInTheDocument()
			expect(within(voucherCard(blankReference)).queryByText('Complete Match')).not.toBeInTheDocument()
		})

		it('still suggests a first candidate whose reference genuinely matches', async () => {
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
		const suggested = makeSuggestedLinkedPayment(DEPOSIT_ROW)
		const different = makeAlternateLinkedPayment()
		const candidatesAsReturned = sortLinkedPaymentsAsEndpoint([different, suggested])

		const renderWithBothCandidates = () =>
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: candidatesAsReturned
			})

		/*
		 * A second candidate matching the transaction on value exactly as the first one does, so the ONLY
		 * thing separating the two is the slot the endpoint put them in. That is what makes the pair worth
		 * rendering: `isSuggested` requires `index === 0` on top of the value match, so the marker has to
		 * follow the position rather than anything about the voucher itself.
		 */
		const equallyPlausible = makeSuggestedLinkedPayment(DEPOSIT_ROW, {
			name: 'ACC-PAY-2024-00002',
			rank: suggested.rank - 1
		})

		it('marks only the first candidate the endpoint returned as the suggestion', async () => {
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: sortLinkedPaymentsAsEndpoint([equallyPlausible, suggested])
			})

			await waitFor(() => {
				expect(within(voucherCard(suggested)).getByText('Suggested')).toBeInTheDocument()
			})
			expect(within(voucherCard(equallyPlausible)).queryByText('Suggested')).not.toBeInTheDocument()
		})

		it('moves the suggestion with the position, not with the voucher', async () => {
			// The same two rows handed over in the opposite order, as they would arrive had the endpoint
			// ranked the other one higher.
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [equallyPlausible, suggested]
			})

			await waitFor(() => {
				expect(within(voucherCard(equallyPlausible)).getByText('Suggested')).toBeInTheDocument()
			})
			expect(within(voucherCard(suggested)).queryByText('Suggested')).not.toBeInTheDocument()
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

			expect(postEndpointsUsed()).toEqual([RECONCILE_ENDPOINT])

			// Asserted as the SERVER reads it: `add_payment_entries` consumes `payment_doctype` and
			// `payment_name` and derives the allocation itself, so `amount` is asserted as a field that is
			// still sent, not as one that controls anything.
			const [voucherPayload] = JSON.parse(String(capturedReconcileRequest().vouchers)) as {
				payment_doctype: string
				payment_name: string
				amount: number
			}[]

			expect(voucherPayload.payment_doctype).toBe(suggested.doctype)
			expect(voucherPayload.payment_name).toBe(suggested.name)
			expect(voucherPayload.amount).toBe(suggested.paid_amount)

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

			expect(frappeSWRMutate).toHaveBeenCalledWith(CLOSING_BALANCE_KEY)

			await waitFor(() => {
				expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
			})
		})

		it('revalidates the candidate list too when the server reports a partial allocation', async () => {
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

		/**
		 * N-10. `useFrappePostCall`'s `loading` flag belongs to the hook INSTANCE, and
		 * `useReconcileTransaction` is called inside every candidate row - so each row had its own flag and
		 * clicking one candidate left every sibling for the same transaction fully live for the whole round
		 * trip. The two signals now do different jobs and both are pinned here: `loading` labels the button
		 * that was clicked, the SHARED atom disables all of them.
		 *
		 * The test this replaced forced `loading: true` and asserted the button was disabled - which is
		 * precisely the per-instance mechanism the finding is about, so it could only ever have described
		 * the defect.
		 */
		it('labels the clicked candidate from its own request state', async () => {
			frappeSDKMock.useFrappePostCall.mockImplementation(() => ({
				call: frappePostCall,
				result: null,
				loading: true,
				error: null,
				isCompleted: false,
				reset: vi.fn<() => void>(() => undefined)
			}))

			renderWorkbench({ transactions: [DEPOSIT_ROW], selected: [DEPOSIT_ROW], vouchers: [suggested] })

			expect(await screen.findByRole('button', { name: /Reconciling/ })).toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
		})

		it('disables EVERY candidate while a post is in flight, not only the one clicked', async () => {
			const alternative = makeLinkedPayment({
				name: 'ACC-PAY-2026-09999',
				reference_no: 'ALT-REF-9999',
				paid_amount: DEPOSIT_ROW.unallocated_amount
			})

			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested, alternative],
				reconcileInFlight: DEPOSIT_ROW.name
			})

			const controls = await screen.findAllByRole('button', { name: /^Reconcil/ })
			expect(controls).toHaveLength(2)
			// Both, including the sibling that was never clicked. Before the shared atom this was 1 of 2.
			controls.forEach((control) => expect(control).toBeDisabled())
		})

		it('leaves every candidate enabled when nothing is in flight', async () => {
			// The negative half of the case above, so a permanently-disabled button could not pass it.
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested, makeLinkedPayment({ name: 'ACC-PAY-2026-09998', reference_no: 'ALT-9998' })]
			})

			const controls = await screen.findAllByRole('button', { name: /^Reconcil/ })
			expect(controls).toHaveLength(2)
			controls.forEach((control) => expect(control).toBeEnabled())
		})

		it('explains why a candidate is unavailable while a post is outstanding', async () => {
			/*
			 * A disabled control fires no pointer or focus events, so the reason lives on a focusable
			 * wrapper - the same arrangement the already-reconciled explanation uses. Without it the
			 * siblings went from live to disabled with nothing on screen saying why.
			 *
			 * Both halves are asserted: that the wrapper exists and is reachable, and that focusing it
			 * yields THESE words rather than the already-reconciled ones. Radix opens on focus with no
			 * hover delay to wait out.
			 */
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested],
				reconcileInFlight: DEPOSIT_ROW.name
			})

			const control = await screen.findByRole('button', { name: /^Reconcil/ })
			const trigger = control.parentElement
			expect(trigger).toHaveAttribute('data-slot', 'tooltip-trigger')
			expect(trigger).toHaveAttribute('tabindex', '0')

			await act(async () => {
				;(trigger as HTMLElement).focus()
			})

			/*
			 * `findAllByText`, because Radix renders the tooltip text twice on purpose: once in the visible
			 * bubble and once in a visually-hidden node so it is announced. The visible bubble is asserted
			 * explicitly by slot so this cannot pass on the hidden copy alone.
			 */
			const shown = await screen.findAllByText(/A reconciliation is being posted for this transaction/)
			expect(shown.length).toBeGreaterThan(0)
			expect(
				shown.some((node) => node.closest('[data-slot="tooltip-content"]') !== null)
			).toBe(true)
			expect(screen.queryByText(/already fully reconciled/)).not.toBeInTheDocument()
		})

		it('refuses a second post while one is outstanding', async () => {
			/*
			 * The guard in the hook, not the disabled attribute. The attribute can be bypassed - a keyboard
			 * activation landing in the same tick as the state update, or any direct call - so the refusal
			 * is asserted where it cannot be: exactly one request leaves the client.
			 */
			const user = userEvent.setup()
			const alternative = makeLinkedPayment({
				name: 'ACC-PAY-2026-09997',
				reference_no: 'ALT-REF-9997',
				paid_amount: DEPOSIT_ROW.unallocated_amount
			})
			// Never settles, so the post stays in flight for the whole test.
			frappePostCall.mockReturnValue(new Promise(() => undefined))

			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested, alternative]
			})

			const controls = await screen.findAllByRole('button', { name: /^Reconcil/ })
			await user.click(controls[0])

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledTimes(1)
			})

			// Re-queried: the first click re-rendered the panel, so the earlier nodes may be stale.
			const afterFirst = await screen.findAllByRole('button', { name: /^Reconcil/ })
			afterFirst.forEach((control) => expect(control).toBeDisabled())

			// Straight past the disabled attribute, which is what a same-tick activation does.
			afterFirst[1].removeAttribute('disabled')
			await user.click(afterFirst[1])

			expect(frappePostCall).toHaveBeenCalledTimes(1)
		})

		it('releases the shared flag once the server answers', async () => {
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

			const { store } = await confirmSuggested()

			await waitFor(() => {
				expect(store.get(bankRecReconcileInFlightAtom)).toBeNull()
			})
		})

		it('releases the shared flag on a refusal, so another candidate can be tried', async () => {
			// A flag left raised here would disable Reconcile for the rest of the session with nothing on
			// screen able to clear it - strictly worse than the defect being fixed.
			frappePostCall.mockRejectedValue(makeAlreadyReconciledError(DEPOSIT_ROW.name))

			const { store } = await confirmSuggested()

			await waitFor(() => {
				expect(store.get(bankRecReconcileInFlightAtom)).toBeNull()
			})
		})

		it('reports the refusal and leaves the transaction unreconciled', async () => {
			const user = userEvent.setup()
			const refusal = makeAlreadyReconciledError(DEPOSIT_ROW.name)
			frappePostCall.mockRejectedValue(refusal)
			// The server's current answer for this account, which the refusal path re-reads: the row is
			// still unreconciled, but its unallocated figure has moved on.
			const serverCopy = makeUnreconciledTransaction({
				...DEPOSIT_ROW,
				unallocated_amount: TEST_TRANSACTION_AMOUNT / 2
			})
			frappeSWRMutate.mockImplementation((key) =>
				Promise.resolve(key === UNRECONCILED_KEY ? { message: [serverCopy] } : undefined))

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
				expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
			})
			// Nothing was posted, so the row is still unreconciled - but the copy the client holds is now
			// the server's, not the one it had before the attempt.
			await waitFor(() => {
				expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([serverCopy])
			})
			expect(store.get(SELECTED_TRANSACTION_ATOM)?.[0].status).toBe('Unreconciled')

			expect(frappePostCall).toHaveBeenCalledTimes(1)
			expect(toastSuccess).not.toHaveBeenCalled()
			await waitFor(() => {
				expect(toastError).toHaveBeenCalledTimes(1)
			})
			// The server answered, so the client is entitled to name the outcome.
			expect(toastError.mock.calls[0][0]).toBe('Reconciliation refused')
		})

		/*
		 * "No retry" is asserted against the rejection path's own completion rather than against the
		 * clock. The convergence read is the LAST thing that path awaits, so holding it open and then
		 * releasing it by hand brackets the whole handler: the first count is taken while it is still
		 * suspended, and the second only once the selection has converged, which cannot happen before
		 * every continuation the handler could schedule has already run. A retry would have to appear
		 * inside that bracket, so no wall-clock wait is needed to rule one out - and unlike a sleep,
		 * this cannot pass merely because the machine was slow enough to finish after the assertion.
		 */
		it('does not retry a refused post, so a refusal cannot become a duplicate posting', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(makeAlreadyReconciledError(DEPOSIT_ROW.name))

			let releaseRefresh!: () => void
			const heldRefresh = new Promise<{ message: UnreconciledTransaction[] }>((resolve) => {
				// The row is absent from the re-read, which is what "already fully reconciled" looks like
				// through `get_bank_transactions`: it filters on `unallocated_amount > 0`.
				releaseRefresh = () => resolve({ message: [] })
			})
			frappeSWRMutate.mockImplementation((key) =>
				key === UNRECONCILED_KEY ? heldRefresh : Promise.resolve(undefined))

			const { store } = renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [suggested]
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})
			await user.click(confirmControlFor(suggested))

			// The refusal has been handled - the dialog holds it - while the re-read is still suspended.
			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).not.toBeNull()
			})
			expect(frappePostCall).toHaveBeenCalledTimes(1)

			await act(async () => {
				releaseRefresh()
				await heldRefresh
			})

			// Convergence has now run to completion, so nothing the handler scheduled is still pending.
			await waitFor(() => {
				expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
			})
			expect(frappePostCall).toHaveBeenCalledTimes(1)
		})

		/*
		 * Holding the invalidation open is what makes the advance observable: until it resolves the
		 * selection is untouched, and when it does the transaction is absent from the refreshed list.
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
		 * A transaction the server considers fully reconciled. BOTH signals are set because the server
		 * derives them from one another, so setting only one would model a state it can never produce.
		 *
		 * Such a row does not arrive in THIS tab's list - `get_bank_transactions` filters
		 * `unallocated_amount > 0` server-side unless `all_transactions` is passed, and this tab does not
		 * pass it. It reaches the guard through the SELECTION, which is where the guard reads it from:
		 * `bankRecSelectedTransactionsAtom` holds a row captured earlier, and this tab's list revalidates
		 * neither on focus nor when stale, so a selection made before a reconciliation outlives it. Every
		 * case below therefore seeds the SELECTION with the settled row while the list answers with rows
		 * the endpoint could really return.
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
				transactions: [stillUnreconciled],
				selected: [reconciled],
				vouchers: [makeSuggestedLinkedPayment(reconciled)]
			})

			const control = await screen.findByRole('button', { name: 'Reconcile' })
			expect(control).toBeDisabled()
		})

		/*
		 * The predicate the BACKEND tests is the FIGURE, not the label: its guard reads
		 * `if 0.0 >= self.unallocated_amount`. The two rows below separate the two halves of the client's
		 * `status === 'Reconciled' || unallocated_amount <= 0` - a label that has not caught up, and an
		 * over-allocation - both of which the server refuses while `status` still reads `Unreconciled`.
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
			// focusable wrapper around it; asserting the wrapper rather than hovering for the portaled
			// tooltip text is the stable way to prove the reason is reachable by mouse and keyboard.
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

		it('reports the server\'s own words and re-reads the server after a refusal', async () => {
			const user = userEvent.setup()
			const stale = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-05004',
				description: 'Reconciled behind this client\'s back',
				status: 'Unreconciled',
				unallocated_amount: TEST_TRANSACTION_AMOUNT
			})

			frappePostCall.mockRejectedValue(makeAlreadyReconciledError(stale.name))
			// The stale row is absent from the re-read, which is what the server saying "already fully
			// reconciled" looks like through `get_bank_transactions`: it filters on `unallocated_amount > 0`.
			frappeSWRMutate.mockImplementation((key) =>
				Promise.resolve(key === UNRECONCILED_KEY ? { message: [] } : undefined))
			// The all-transactions list is re-read imperatively rather than through SWR, because the tab
			// that renders it is unmounted here and SWR only revalidates keys with a mounted subscriber.
			frappeContextValue.call.get.mockResolvedValue({ message: [makeReconciledTransaction(stale)] })

			const { store } = renderWorkbench({
				transactions: [stale],
				selected: [stale],
				vouchers: [makeSuggestedLinkedPayment(stale)]
			})

			const control = await screen.findByRole('button', { name: 'Reconcile' })
			expect(control).toBeEnabled()

			await user.click(control)

			expect(await screen.findByRole('alertdialog')).toHaveTextContent(
				formatAlreadyReconciledMessage(stale.name)
			)

			await user.click(await screen.findByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})

			// The stale client is corrected rather than merely warned: the selection the guard was computed
			// from is dropped, so no Reconcile control is left offering the refused action again.
			await waitFor(() => {
				expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
			})
			expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()

			expect(frappeSWRMutate).toHaveBeenCalledWith(UNRECONCILED_KEY)
			// Both cached lists are corrected. The all-transactions one is corrected by writing the
			// imperative read's answer onto its key, which is the only form that reaches the network while
			// the tab rendering it is unmounted.
			expect(frappeSWRMutate).toHaveBeenCalledWith(
				BANK_TRANSACTIONS_KEY,
				expect.any(Promise),
				{ revalidate: false }
			)
			expect(frappeContextValue.call.get).toHaveBeenCalledWith(
				'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions',
				expect.objectContaining({ bank_account: TEST_BANK_ACCOUNT, all_transactions: true })
			)

			expect(frappePostCall).toHaveBeenCalledTimes(1)

			expect(toastError).toHaveBeenCalledTimes(1)
			expect(toastError).toHaveBeenCalledWith(
				'Reconciliation refused',
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

			expect(chip).toHaveAttribute('data-theme', 'orange')
			expect(chip).toHaveAttribute('data-variant', 'subtle')
			expect(chip).toHaveTextContent(TEST_ALTERNATE_CURRENCY)
		})

		it('carries the same size as every other badge sharing its row', async () => {
			const busy = makeCurrencyMismatchTransaction({
				description: 'Cross-currency inbound wire with neighbours',
				transaction_type: 'SWIFT',
				reference_number: 'FX-1000',
				matched_transaction_rule: 'Inbound wire rule'
			})

			renderWorkbench({ transactions: [busy], accountCurrency: TEST_CURRENCY })

			await waitFor(() => {
				expect(transactionRow(busy)).toBeInTheDocument()
			})

			const row = transactionRow(busy)
			const chip = currencyAdvisoryChip(row)
			expect(chip).not.toBeNull()

			// Asserted as a relation rather than a literal, so this stays true if the design system ever
			// re-scales its badges: what matters is that the advisory is not the odd one out. Badge maps
			// `sm` to a 16px pill with a 10px icon and `md` to 20px with 12px, a difference visible as a
			// shorter pill on the same line.
			const siblings = Array.from(row.querySelectorAll<HTMLElement>('[data-slot="badge"]')).filter(
				(badge) => badge !== chip
			)
			expect(siblings.length).toBeGreaterThan(0)

			const chipSize = chip?.getAttribute('data-size')
			expect(chipSize).toBe('md')
			siblings.forEach((sibling) => {
				expect(sibling).toHaveAttribute('data-size', chipSize as string)
			})
		})

		it('leaves the confirm control ENABLED, because the server decides the outcome', async () => {
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

		/*
		 * The advisory has to agree with the rule the SERVER applies, and the persisted selection cannot
		 * be trusted to: `selectedBankAccountAtom` is `localStorage`-backed and is only rewritten when
		 * the selection changes, so re-selecting the same account replays a snapshot of unbounded age.
		 * These two cases pin the source of truth from both directions.
		 */
		describe('reads the account currency from the server, not from the persisted selection', () => {
			it('warns when the stale snapshot agrees with the row but the server does not', async () => {
				renderWorkbench({
					transactions: [mismatched],
					// The snapshot claims the account is in the transaction's own currency, so a predicate
					// reading it would conclude there is nothing to warn about.
					persistedAccountCurrency: TEST_ALTERNATE_CURRENCY,
					accountCurrency: TEST_CURRENCY
				})

				await waitFor(() => {
					expect(transactionRow(mismatched)).toBeInTheDocument()
				})

				const chip = currencyAdvisoryChip(transactionRow(mismatched))
				expect(chip).not.toBeNull()
				expect(chip).toHaveTextContent(TEST_ALTERNATE_CURRENCY)
			})

			it('stays silent when the stale snapshot disagrees with the row but the server does not', async () => {
				renderWorkbench({
					transactions: [mismatched],
					// The reverse error: a predicate reading the snapshot would warn about a mismatch the
					// server no longer sees.
					persistedAccountCurrency: TEST_CURRENCY,
					accountCurrency: TEST_ALTERNATE_CURRENCY
				})

				await waitFor(() => {
					expect(transactionRow(mismatched)).toBeInTheDocument()
				})

				expect(currencyAdvisoryChip(transactionRow(mismatched))).toBeNull()
			})

			it('stays silent while the account list is still in flight', async () => {
				renderWorkbench({
					transactions: [mismatched],
					bankAccountsState: 'loading',
					persistedAccountCurrency: TEST_CURRENCY
				})

				await waitFor(() => {
					expect(transactionRow(mismatched)).toBeInTheDocument()
				})

				// No current answer is not the same as a different answer.
				expect(currencyAdvisoryChip(transactionRow(mismatched))).toBeNull()
			})
		})

		describe('is reachable by keyboard', () => {
			const advisoryTrigger = (): HTMLElement =>
				screen.getByLabelText(
					`Currency mismatch: transaction in ${TEST_ALTERNATE_CURRENCY}, bank account in ${TEST_CURRENCY}`
				)

			it('names the advisory for assistive technology and takes focus', async () => {
				renderWorkbench({ transactions: [mismatched], accountCurrency: TEST_CURRENCY })

				await waitFor(() => {
					expect(transactionRow(mismatched)).toBeInTheDocument()
				})

				const trigger = advisoryTrigger()
				expect(trigger).toHaveAttribute('tabindex', '0')
				expect(trigger.contains(currencyAdvisoryChip(transactionRow(mismatched)))).toBe(true)

				act(() => {
					trigger.focus()
				})
				expect(trigger).toHaveFocus()
			})

			it('reveals the full explanation on focus alone, with no pointer involved', async () => {
				renderWorkbench({ transactions: [mismatched], accountCurrency: TEST_CURRENCY })

				await waitFor(() => {
					expect(transactionRow(mismatched)).toBeInTheDocument()
				})

				// Radix opens on focus with no hover delay to wait out.
				act(() => {
					advisoryTrigger().focus()
				})

				expect(await screen.findByRole('tooltip')).toHaveTextContent(
					`Transaction currency ${TEST_ALTERNATE_CURRENCY} differs from the bank account currency ${TEST_CURRENCY}. This indicator does not block the action - the server validates the currency when the reconciliation is posted, and refuses a mismatch.`
				)
			})

			it('points the trigger at the open explanation', async () => {
				renderWorkbench({ transactions: [mismatched], accountCurrency: TEST_CURRENCY })

				await waitFor(() => {
					expect(transactionRow(mismatched)).toBeInTheDocument()
				})

				const trigger = advisoryTrigger()
				act(() => {
					trigger.focus()
				})

				const tooltip = await screen.findByRole('tooltip')
				expect(trigger).toHaveAttribute('aria-describedby', tooltip.id)
			})
		})

		/*
		 * The advisory is last in a badge cluster that sits inside an `overflow-hidden` pane, and every
		 * Badge is `shrink-0 whitespace-nowrap` by design. Without wrapping and a bound on the
		 * variable-length badges ahead of it, a long rule name or reference pushed the warning clean out
		 * of the visible area. jsdom computes no layout, so what is pinned here is that mechanism; the
		 * rendered geometry is checked in a real browser.
		 */
		describe('survives a narrow pane and long neighbouring values', () => {
			const crowded = makeCurrencyMismatchTransaction({
				description: 'Cross-currency inbound wire with a long narrative',
				reference_number: 'REF-'.repeat(20).concat('END'),
				transaction_type: 'International Wire Transfer Credit Advice',
				matched_transaction_rule: 'Rule for cross-currency inbound wires from the EU treasury desk'
			})

			it('still renders the advisory alongside them', async () => {
				renderWorkbench({ transactions: [crowded], accountCurrency: TEST_CURRENCY })

				await waitFor(() => {
					expect(transactionRow(crowded)).toBeInTheDocument()
				})

				expect(currencyAdvisoryChip(transactionRow(crowded))).not.toBeNull()
			})

			it('lets the cluster wrap and bounds every badge ahead of the advisory', async () => {
				renderWorkbench({ transactions: [crowded], accountCurrency: TEST_CURRENCY })

				await waitFor(() => {
					expect(transactionRow(crowded)).toBeInTheDocument()
				})

				const row = transactionRow(crowded)
				const cluster = currencyAdvisoryChip(row)?.closest('div')
				expect(cluster).not.toBeNull()
				expect(cluster?.className).toContain('flex-wrap')

				const rule = ruleBadge(row)
				expect(rule?.className).toMatch(/max-w-/)
				// A bound that ellipsises the name has to leave it discoverable somewhere.
				expect(rule).toHaveAttribute(
					'title',
					`Matched by rule: ${crowded.matched_transaction_rule}`
				)

				row.querySelectorAll<HTMLElement>('[data-slot="badge"]').forEach((badge) => {
					if (badge === currencyAdvisoryChip(row)) return
					expect(badge.className).toMatch(/max-w-/)
				})
			})
		})
	})

	/*
	 * A refusal has to leave something behind. The dialog reporting it is modal and momentary, and in the
	 * case this path exists for the client then re-reads the server and the row leaves the unreconciled
	 * list - so dismissing the dialog used to leave the reviewer looking at an emptied pane with nothing
	 * on screen saying why what they were working on had gone.
	 */
	describe('the explanation a refusal leaves behind', () => {

		const suggested = makeSuggestedLinkedPayment(DEPOSIT_ROW)

		/** Refuses one confirmation and returns once the refusal has been reported. */
		const refuseConfirmation = async (refreshedRows: UnreconciledTransaction[] = []) => {
			const user = userEvent.setup()
			const refusal = makeAlreadyReconciledError(DEPOSIT_ROW.name)
			frappePostCall.mockRejectedValue(refusal)
			frappeSWRMutate.mockImplementation((key) =>
				Promise.resolve(key === UNRECONCILED_KEY ? { message: refreshedRows } : undefined))

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
				expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
			})

			return { store, user, refusal }
		}

		const refusalNotice = (): HTMLElement | null =>
			document.querySelector<HTMLElement>('[data-testid="bank-rec-last-refusal"]')

		it('is absent until something is refused', async () => {
			renderWorkbench({ transactions: [DEPOSIT_ROW], selected: [DEPOSIT_ROW], vouchers: [suggested] })

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})
			expect(refusalNotice()).toBeNull()
		})

		it("survives dismissing the dialog, still carrying the server's own words", async () => {
			const { store } = await refuseConfirmation()

			// Exactly what dismissing the dialog must NOT take with it.
			act(() => {
				store.set(bankRecErrorDialogAtom, null)
			})

			await waitFor(() => {
				expect(refusalNotice()).not.toBeNull()
			})
			const notice = refusalNotice() as HTMLElement
			expect(notice).toHaveTextContent('The server refused this reconciliation')
			expect(notice).toHaveTextContent(formatAlreadyReconciledMessage(DEPOSIT_ROW.name))
			// And it says what the reviewer most needs to know about a refusal.
			expect(notice.textContent).toContain('Nothing was posted')
		})

		it('stays on screen when convergence has emptied the pane', async () => {
			// A row reconciled elsewhere drops out of `get_bank_transactions`, so the selection clears and
			// the pane falls back to its empty state - the exact moment an explanation is needed most.
			const { store } = await refuseConfirmation([])

			await waitFor(() => {
				expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
			})
			act(() => {
				store.set(bankRecErrorDialogAtom, null)
			})

			expect(screen.getByText('Select a transaction to match and reconcile with vouchers')).toBeInTheDocument()
			await waitFor(() => {
				expect(refusalNotice()).not.toBeNull()
			})
			expect(refusalNotice()).toHaveTextContent(formatAlreadyReconciledMessage(DEPOSIT_ROW.name))
		})

		it('goes when the reviewer dismisses it themselves', async () => {
			const { store, user } = await refuseConfirmation()
			act(() => {
				store.set(bankRecErrorDialogAtom, null)
			})

			await waitFor(() => {
				expect(refusalNotice()).not.toBeNull()
			})

			await user.click(within(refusalNotice() as HTMLElement).getByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(refusalNotice()).toBeNull()
			})
			expect(store.get(bankRecLastRefusalAtom)).toBeNull()
		})

		it('describes an unanswered request as an unknown outcome rather than a refusal', async () => {
			const user = userEvent.setup()
			// No readable response, so the SDK rejects with a plain Error and nothing may be claimed about
			// whether the post was applied.
			frappePostCall.mockRejectedValue(new Error('Network request failed'))
			frappeSWRMutate.mockResolvedValue(undefined)

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
				expect(refusalNotice()).not.toBeNull()
			})
			const notice = refusalNotice() as HTMLElement
			expect(notice).toHaveTextContent('This reconciliation was not confirmed')
			expect(notice.textContent).toContain('it is not known whether this was recorded')
			expect(notice.textContent).not.toContain('Nothing was posted')
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

			expect(screen.getByText('Try adjusting your search or filter criteria.')).toBeInTheDocument()

			/*
			 * Two ways back exist deliberately, so this scopes to one: the filter row carries a reset
			 * control whenever a filter is active, and the empty state repeats it where a reviewer who has
			 * filtered everything away is actually looking.
			 */
			const resets = screen.getAllByRole('button', { name: 'Clear Filters' })
			expect(resets).toHaveLength(2)

			await user.click(resets[0])

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})
			expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()
		})

		describe('the amount a reviewer types', () => {

			/*
			 * The field is never empty to begin with: the filter atom starts at `0.00`, and the library
			 * re-pads to the decimal scale on blur. Typing without emptying it first appends to that
			 * zero, so every case below clears the field the way a reviewer would.
			 */
			const typeAmount = async (user: ReturnType<typeof userEvent.setup>, amount: string) => {
				const field = screen.getByPlaceholderText('₹0.00')
				await user.clear(field)
				await user.type(field, amount)
				return field
			}

			/*
			 * A gap between events, because the field is CONTROLLED: each character is echoed back through
			 * React before the next is composed, and with no gap a keystroke can be built on a value React
			 * has not re-rendered yet and be lost - a race in the harness, not in the product, which showed
			 * up only under the slower coverage run.
			 */
			const typist = () => userEvent.setup({ delay: 20 })

			/*
			 * This filter compares the typed figure against `withdrawal` and `deposit`, so a figure that is
			 * altered on its way in silently filters on something the reviewer never asked for. Three
			 * distinct alterations were possible and each is pinned below: a small decimal inflated by
			 * orders of magnitude, a long figure truncated to its first digits, and a figure that cannot be
			 * used at all being accepted without a word.
			 */
			const SMALL_DECIMAL_ROW = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-09001',
				description: 'Interest credited',
				withdrawal: 0,
				deposit: 1.23,
				unallocated_amount: 1.23
			})

			const INFLATED_ROW = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-09002',
				description: 'Property purchase',
				withdrawal: 0,
				deposit: 1230000000,
				unallocated_amount: 1230000000
			})

			const TWELVE_DIGIT_ROW = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-09003',
				description: 'Treasury sweep',
				withdrawal: 0,
				deposit: 123456789012,
				unallocated_amount: 123456789012
			})

			it('matches the figure typed rather than one inflated by orders of magnitude', async () => {
				// 1.23 was previously re-read out of the formatted text and became 1,230,000,000 - which is
				// a real row in this list, so the reviewer was shown a confident, wrong result.
				const user = typist()
				renderWorkbench({ transactions: [SMALL_DECIMAL_ROW, INFLATED_ROW] })

				await waitFor(() => {
					expect(transactionRow(SMALL_DECIMAL_ROW)).toBeInTheDocument()
				})

				await typeAmount(user, '1.23')

				await waitFor(() => {
					expect(screen.queryByText(INFLATED_ROW.description ?? '')).not.toBeInTheDocument()
				})
				expect(transactionRow(SMALL_DECIMAL_ROW)).toBeInTheDocument()
				expect(screen.getByRole('textbox', { name: 'Filter by amount' }))
					.not.toHaveAttribute('aria-invalid', 'true')
			})

			it('keeps every digit of a long figure rather than filtering on a truncated prefix', async () => {
				const user = typist()
				renderWorkbench({ transactions: [TWELVE_DIGIT_ROW, SMALL_DECIMAL_ROW] })

				await waitFor(() => {
					expect(transactionRow(TWELVE_DIGIT_ROW)).toBeInTheDocument()
				})

				await typeAmount(user, '123456789012')

				await waitFor(() => {
					expect(screen.queryByText(SMALL_DECIMAL_ROW.description ?? '')).not.toBeInTheDocument()
				})
				expect(transactionRow(TWELVE_DIGIT_ROW)).toBeInTheDocument()
			})

			it('says so when a negative is typed, rather than accepting it and filtering nothing', async () => {
				/*
				 * The server stores both sides as positive magnitudes, so a negative can never match. It
				 * used to be accepted in silence: the field showed `-₹1` while the list stayed complete,
				 * which reads as a filter that is on and working.
				 */
				const user = typist()
				renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

				await waitFor(() => {
					expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
				})

				await typeAmount(user, '-1')

				const alert = await screen.findByRole('alert')
				expect(alert).toHaveTextContent(
					'Amounts are matched by magnitude, so a negative amount cannot match a transaction.'
				)

				const field = screen.getByRole('textbox', { name: 'Filter by amount' })
				expect(field).toHaveAttribute('aria-invalid', 'true')
				expect(field).toHaveAttribute('aria-describedby', alert.id)

				// Refused out loud AND not applied, so what is on screen still matches what is filtered.
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
				expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()
			})

			it('offers the reset while the amount box holds a refused figure', async () => {
				/*
				 * A refused amount filters on nothing, so keying the reset on "is a filter applied" left a
				 * reviewer looking at a field full of red text with no control to clear it. What is in the
				 * box decides it now.
				 */
				const user = typist()
				renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

				await waitFor(() => {
					expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
				})
				// Nothing typed yet, so there is nothing to reset.
				expect(screen.queryByRole('button', { name: 'Clear Filters' })).not.toBeInTheDocument()

				await typeAmount(user, '-1')
				await screen.findByRole('alert')

				const reset = await screen.findByRole('button', { name: 'Clear Filters' })
				await user.click(reset)

				await waitFor(() => {
					expect(screen.queryByRole('alert')).not.toBeInTheDocument()
				})
				expect(screen.getByPlaceholderText('₹0.00')).toHaveValue('')
				expect(screen.queryByRole('button', { name: 'Clear Filters' })).not.toBeInTheDocument()
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
				expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()
			})

			it('starts with an empty box rather than a typed zero, so a first keystroke is not appended to it', async () => {
				// The default text used to be `0.00`, which looked exactly like the placeholder: typing `5`
				// produced `0.005` -> 0, and the reviewer had no way to tell why nothing matched.
				const user = typist()
				renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

				await waitFor(() => {
					expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
				})

				const field = screen.getByPlaceholderText('₹0.00')
				expect(field).toHaveValue('')

				// Typed WITHOUT clearing first, which is the point of the case.
				await user.type(field, String(WITHDRAWAL_ROW.withdrawal))

				await waitFor(() => {
					expect(screen.queryByText(DEPOSIT_ROW.description ?? '')).not.toBeInTheDocument()
				})
				expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()
			})

			it('withdraws the objection once the field is emptied', async () => {
				const user = typist()
				renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW] })

				await waitFor(() => {
					expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
				})

				await typeAmount(user, '-1')
				await screen.findByRole('alert')

				await user.clear(screen.getByPlaceholderText('₹0.00'))

				await waitFor(() => {
					expect(screen.queryByRole('alert')).not.toBeInTheDocument()
				})
				expect(screen.getByRole('textbox', { name: 'Filter by amount' }))
					.not.toHaveAttribute('aria-invalid', 'true')
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
				expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()
			})
		})

		describe('what a filter does to the row under review', () => {

			/*
			 * Narrowing a filter used to discard the selection outright, so a reviewer who searched for a
			 * voucher reference lost the transaction they were matching. Changing the DATE RANGE, which
			 * genuinely can remove the row from the list, used to keep it - leaving live create-and-
			 * reconcile actions pointed at a transaction that was no longer on screen.
			 */
			it('keeps the row under review while a filter hides it, and still has it afterwards', async () => {
				// Gapped for the same reason as the amount cases above: the amount field is controlled.
				const user = userEvent.setup({ delay: 20 })
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

				/*
				 * Filtered by AMOUNT rather than by search text, deliberately: the amount filter is an exact
				 * comparison applied immediately, whereas the search box is a debounced fuzzy rank that may
				 * still return the row. This makes "the selected row is no longer listed" a fact.
				 */
				const field = screen.getByPlaceholderText('₹0.00')
				await user.clear(field)
				await user.type(field, String(WITHDRAWAL_ROW.withdrawal))

				await waitFor(() => {
					expect(screen.queryByText(DEPOSIT_ROW.description ?? '')).not.toBeInTheDocument()
				})

				// The row has left the list, but the review it belongs to is untouched.
				expect(store.get(SELECTED_TRANSACTION_ATOM).map((row) => row.name)).toEqual([DEPOSIT_ROW.name])
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()

				await user.click(screen.getByRole('button', { name: 'Clear Filters' }))

				await waitFor(() => {
					expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
				})
				expect(store.get(SELECTED_TRANSACTION_ATOM).map((row) => row.name)).toEqual([DEPOSIT_ROW.name])
			})

			it('ends the review when the date range moves away from the row', async () => {
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

				act(() => {
					store.set(bankRecDateAtom, { fromDate: '2023-07-01', toDate: '2023-07-31' })
				})

				await waitFor(() => {
					expect(
						screen.getByText('Select a transaction to match and reconcile with vouchers')
					).toBeInTheDocument()
				})
				expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
				expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
			})

			it('ends the review when the account is switched, and switching back does not replay it', async () => {
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

				act(() => {
					store.set(selectedBankAccountAtom, makeSelectedBank({ name: 'Other Account - Other Bank' }))
				})

				await waitFor(() => {
					expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
				})

				// Coming back must not resurrect it: a selection retained per account did exactly that.
				act(() => {
					store.set(selectedBankAccountAtom, makeSelectedBank())
				})

				expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
				await waitFor(() => {
					expect(
						screen.getByText('Select a transaction to match and reconcile with vouchers')
					).toBeInTheDocument()
				})
			})
		})

		it('keeps the filter reset reachable while a filter is active but still matching rows', async () => {
			/*
			 * The reset used to appear only once the filters had hidden everything, so a reviewer looking at
			 * a filtered-but-populated list had to empty each control by hand and had no cue that anything
			 * was being hidden at all.
			 */
			const user = userEvent.setup()
			renderWorkbench({ transactions: [DEPOSIT_ROW, WITHDRAWAL_ROW], amountFilter: DEPOSIT_ROW.deposit })

			await waitFor(() => {
				expect(transactionRow(DEPOSIT_ROW)).toBeInTheDocument()
			})
			expect(screen.queryByText('No transactions found for the given filters.')).not.toBeInTheDocument()

			const reset = screen.getByRole('button', { name: 'Clear Filters' })
			await user.click(reset)

			await waitFor(() => {
				expect(transactionRow(WITHDRAWAL_ROW)).toBeInTheDocument()
			})
			// With no filter active there is nothing to reset, so the control retires.
			expect(screen.queryByRole('button', { name: 'Clear Filters' })).not.toBeInTheDocument()
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

	/**
	 * Accessible names on the icon-only controls.
	 *
	 * Every candidate voucher renders three or four match indicators, and each one is a
	 * `TooltipTrigger` - which Radix renders as a focusable BUTTON that takes its accessible name from
	 * its children. The children were a bare icon, so on a normal working screen roughly a hundred and
	 * eighty focusable buttons announced as nothing at all, and the information they carry - whether the
	 * amount, the posting date and the reference actually match the transaction being reconciled - was
	 * available only by sight. This was the single largest accessibility defect in the application by
	 * count.
	 *
	 * The name states the finding rather than the glyph ("Amount matches..." rather than "tick"), so it
	 * carries the same meaning the icon does, and the glyph itself is hidden so it cannot contribute a
	 * second wordless name.
	 */
	describe('the match indicators name what they found', () => {

		it('names the amount and posting-date indicators on a candidate voucher', async () => {
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [makeSuggestedLinkedPayment(DEPOSIT_ROW)]
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})

			// The suggested voucher is built to match the transaction, so both read as a match.
			expect(
				screen.getByRole('button', { name: 'Amount matches the selected transaction' })
			).toBeInTheDocument()
			expect(
				screen.getByRole('button', { name: 'Posting date matches the selected transaction' })
			).toBeInTheDocument()
		})

		it('says so when the amount does NOT match, rather than showing a wordless cross', async () => {
			const voucher = makeSuggestedLinkedPayment(DEPOSIT_ROW)

			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [{ ...voucher, paid_amount: (voucher.paid_amount ?? 0) + 100 }]
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})

			expect(
				screen.getByRole('button', { name: 'Amount does not match the selected transaction' })
			).toBeInTheDocument()
		})

		it('leaves no unnamed control anywhere in the voucher panel', async () => {
			/*
			 * The invariant behind the two cases above, and the one that would catch a NEW icon-only
			 * trigger being added later. Every button on screen must resolve to a name - computed the
			 * way a browser computes it, not read back off an attribute, so a name that comes from
			 * visible text counts just as much as one from `aria-label`.
			 */
			renderWorkbench({
				transactions: [DEPOSIT_ROW],
				selected: [DEPOSIT_ROW],
				vouchers: [makeSuggestedLinkedPayment(DEPOSIT_ROW)]
			})

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()
			})

			// An empty `name` matches only controls whose computed accessible name IS empty, so this is
			// the whole population of unnamed buttons on screen - reported with their markup so a
			// regression names the culprit instead of just failing a count.
			const unnamed = screen.queryAllByRole('button', { name: '' })

			expect(unnamed.map((control) => control.outerHTML.slice(0, 120))).toEqual([])
		})
	})
})
