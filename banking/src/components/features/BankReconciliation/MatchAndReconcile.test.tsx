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
 *  3. Radix's `Slot` spreads a `TooltipTrigger asChild`'s props AFTER its child's, so the advisory
 *     chip loses `data-slot="badge"` and keeps `data-variant`/`data-size`/`data-theme`.
 *     {@link currencyAdvisoryChip} therefore selects on that surviving triple.
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
	bankRecSelectedTransactionAtom,
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

		// Answered with the ENDPOINT-row builder rather than by spreading `BANK`: that constant is the
		// persisted selection, whose shape differs from this endpoint's projection in both directions. The
		// advisory compares against the selected-bank atom's currency, not against this response.
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
 * The currency-mismatch advisory chip inside one row, or `null` when the row shows none. Selected on
 * the variant triple that SURVIVES the `asChild` merge; scoping to a row and pinning
 * `data-size="sm"` is what stops it matching the voucher panel's own orange "Partial Match" badge.
 */
const currencyAdvisoryChip = (row: HTMLElement): HTMLElement | null =>
	row.querySelector<HTMLElement>('[data-theme="orange"][data-variant="subtle"][data-size="sm"]')

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

		const openRecommendedAction = async (
			user: ReturnType<typeof userEvent.setup>,
			classification: RuleDocument['classify_as'],
			expectedTitle: string
		) => {
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

		it('returns the higher-ranked candidate first, as the endpoint sorts them', () => {
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

		it('closes the affordance while a post is in flight', async () => {
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

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
			})
			expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([DEPOSIT_ROW])
			expect(store.get(SELECTED_TRANSACTION_ATOM)?.[0].status).toBe('Unreconciled')

			expect(frappePostCall).toHaveBeenCalledTimes(1)
			expect(toastSuccess).not.toHaveBeenCalled()
			await waitFor(() => {
				expect(toastError).toHaveBeenCalledTimes(1)
			})
		})

		it('does not retry a refused post, so a refusal cannot become a duplicate posting', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(makeAlreadyReconciledError(DEPOSIT_ROW.name))

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

			await new Promise((resolve) => setTimeout(resolve, 50))
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
		 * `bankRecSelectedTransactionAtom` holds a row captured earlier, and this tab's list revalidates
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
			expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([stale])
			expect(store.get(SELECTED_TRANSACTION_ATOM)?.[0].status).toBe('Unreconciled')

			expect(frappeSWRMutate).toHaveBeenCalledWith(UNRECONCILED_KEY)
			expect(frappeSWRMutate).toHaveBeenCalledWith(BANK_TRANSACTIONS_KEY)

			expect(frappePostCall).toHaveBeenCalledTimes(1)

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

			expect(chip).toHaveAttribute('data-theme', 'orange')
			expect(chip).toHaveAttribute('data-variant', 'subtle')
			expect(chip).toHaveTextContent(TEST_ALTERNATE_CURRENCY)
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
})
