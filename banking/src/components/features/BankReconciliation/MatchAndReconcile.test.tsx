import type { FrappeError } from 'frappe-react-sdk'
import { afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createFrappeSDKMock,
	frappePostCall,
	frappeSDKMock,
	frappeSWRMutate,
	makeAlreadyReconciledError,
	makeAlternateLinkedPayment,
	makeBankTransaction,
	makeBankTransactionRule,
	makeBlankReferenceLinkedPayment,
	makeCurrencyMismatchTransaction,
	makeLinkedPayment,
	makeMessageOnlyError,
	makeNullReferenceLinkedPayment,
	makeReconcileSuccessResponse,
	makeReconciledTransaction,
	makeRuleMatchedTransaction,
	makeSelectedBank,
	makeSuggestedLinkedPayment,
	makeUnreconciledTransaction,
	resetFrappeSDKMock,
	TEST_ALTERNATE_CURRENCY,
	TEST_BANK_ACCOUNT,
	TEST_CURRENCY,
	TEST_TRANSACTION_DESCRIPTION,
	TEST_TRANSACTION_RULE
} from '@/test/factories'

// `vi.mock` factories are hoisted above every `import` in this file, so any binding they close over
// has to be created by `vi.hoisted` rather than by a plain `const`.
const { toastSuccess, toastError } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn()
}))

// Replaces the SDK wholesale: every read this workbench performs and the reconcile post itself are
// supplied by this suite, so nothing reaches the real transport.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

vi.mock('sonner', () => ({
	toast: { success: toastSuccess, error: toastError }
}))

import MatchAndReconcile from './MatchAndReconcile'
import {
	bankRecDateAtom,
	bankRecErrorDialogAtom,
	bankRecSelectedTransactionAtom,
	selectedBankAccountAtom
} from './bankRecAtoms'
import { bankRecUnreconciledTransactionsKey, bankRecBankTransactionsKey, type UnreconciledTransaction } from './utils'
import { TooltipProvider } from '@/components/ui/tooltip'

const FROM_DATE = '2024-01-01'
const TO_DATE = '2024-01-31'

/** The one endpoint behind BOTH transaction lists — `all_transactions` is a parameter, not a route. */
const BANK_TRANSACTIONS_METHOD =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions'

/** The candidate vouchers a manual override picks from. */
const LINKED_PAYMENTS_METHOD =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_linked_payments'

/** Supplies the account currency the advisory is decided against — derived per row by the endpoint. */
const BANK_ACCOUNT_LIST_METHOD = 'erpnext.accounts.doctype.bank_account.bank_account.get_list'

const OLDER_TRANSACTIONS_METHOD =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_older_unreconciled_transactions'

const emptyRead = {
	data: undefined,
	error: undefined,
	isLoading: false,
	isValidating: false,
	mutate: vi.fn(() => Promise.resolve(undefined))
}

/** The row height the component estimates for the virtualiser (`estimateSize={74}`). */
const LIST_ROW_HEIGHT = 74

const OFFSET_HEIGHT = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const OFFSET_WIDTH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')

/**
 * Both transaction and voucher lists are VIRTUALISED, and `@tanstack/virtual-core` sizes its
 * viewport from `offsetHeight` (`getRect`, `virtual-core/dist/esm/index.js:14-17`) and falls back to
 * the same property to measure each row (`measureElement`, same file:150). jsdom performs no layout,
 * so every one of those reads answers `0` - and a zero-height viewport makes the virtualiser return
 * `range = null` and render NOTHING (same file:720-723). Without this, the lists mount with the
 * correct total size and not one row in the DOM, which would make every assertion below vacuous.
 *
 * The stub is scoped to this file (Vitest isolates test files, and the original descriptors are
 * restored afterwards) and reports only what the component itself already declares: the scroll
 * viewport's own inline height, and the estimated row height for the row wrappers the virtualiser
 * stamps with `data-index`. Nothing else is affected, so no measurement is invented for any other
 * element.
 */
beforeAll(() => {
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get(this: HTMLElement) {
			return this.dataset.index === undefined ? Number.parseFloat(this.style.height) || 0 : LIST_ROW_HEIGHT
		}
	})

	Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
		configurable: true,
		get(this: HTMLElement) {
			return Number.parseFloat(this.style.width) || 1280
		}
	})
})

afterAll(() => {
	if (OFFSET_HEIGHT) {
		Object.defineProperty(HTMLElement.prototype, 'offsetHeight', OFFSET_HEIGHT)
	}
	if (OFFSET_WIDTH) {
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', OFFSET_WIDTH)
	}
})

/**
 * The suggested match, derived FROM the transaction it is offered against, so amount, dates and
 * reference genuinely agree rather than agreeing by coincidence of two independent fixtures.
 */
const suggestedVoucher = (transaction: UnreconciledTransaction = makeUnreconciledTransaction()) =>
	makeSuggestedLinkedPayment(transaction, { name: 'ACC-PAY-2024-00001' })

/**
 * The override target: a DIFFERENT ledger entry, of a different doctype, disagreeing on amount, both
 * dates and reference - so nothing about it can be confused with the suggestion above.
 */
const overrideVoucher = () => makeAlternateLinkedPayment({ name: 'ACC-JV-2024-00077' })

interface RenderOptions {
	/** The rows `get_bank_transactions` answers with; `undefined` means it has not answered. */
	transactions?: UnreconciledTransaction[]
	/** Raised while the list read is in flight. */
	isLoading?: boolean
	/** A refused list read, as the SDK hands one over. */
	listError?: FrappeError
	/** The candidate vouchers `get_linked_payments` answers with. */
	vouchers?: ReturnType<typeof makeLinkedPayment>[]
	/** Raised while the candidate read is in flight. */
	vouchersLoading?: boolean
	/** A refused candidate read, as the SDK hands one over. */
	vouchersError?: FrappeError
	/** What `get_older_unreconciled_transactions` reports for dates before the range. */
	older?: { count: number, oldest_date: string }
	/** The `account_currency` the CURRENT bank-account list reports for the selected account. */
	accountCurrency?: string
	/** Pre-selects a transaction, standing in for the reviewer having clicked its row. */
	selection?: UnreconciledTransaction[]
	/** The rule document behind a `matched_transaction_rule` stamp. */
	rule?: ReturnType<typeof makeBankTransactionRule>
	/** Omits the bank account entirely, which is the pre-selection state of the page. */
	withoutBank?: boolean
}

const renderWorkbench = ({
	transactions,
	isLoading = false,
	listError,
	vouchers,
	vouchersLoading = false,
	vouchersError,
	older = { count: 0, oldest_date: FROM_DATE },
	accountCurrency,
	selection,
	rule,
	withoutBank = false
}: RenderOptions = {}) => {

	frappeSDKMock.useFrappeGetCall.mockImplementation((method: string) => {
		if (method === BANK_TRANSACTIONS_METHOD) {
			return {
				...emptyRead,
				isLoading,
				error: listError,
				data: transactions === undefined ? undefined : { message: transactions }
			}
		}

		if (method === LINKED_PAYMENTS_METHOD) {
			return {
				...emptyRead,
				isLoading: vouchersLoading,
				error: vouchersError,
				data: vouchers === undefined ? undefined : { message: vouchers }
			}
		}

		if (method === BANK_ACCOUNT_LIST_METHOD) {
			return {
				...emptyRead,
				data: {
					message: [{
						...makeSelectedBank({ name: TEST_BANK_ACCOUNT }),
						// Optional on purpose: the endpoint derives it from the linked Account and
						// cannot always resolve one.
						account_currency: accountCurrency
					}]
				}
			}
		}

		if (method === OLDER_TRANSACTIONS_METHOD) {
			return { ...emptyRead, data: { message: older } }
		}

		return emptyRead
	})

	frappeSDKMock.useFrappeGetDoc.mockImplementation((doctype: string) =>
		doctype === 'Bank Transaction Rule' && rule ? { ...emptyRead, data: rule } : emptyRead)

	const store = createStore()

	if (!withoutBank) {
		store.set(selectedBankAccountAtom, makeSelectedBank({ name: TEST_BANK_ACCOUNT }))
	}

	store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })

	if (selection) {
		store.set(bankRecSelectedTransactionAtom(TEST_BANK_ACCOUNT), selection)
	}

	const view = render(
		<Provider store={store}>
			<MemoryRouter>
				<TooltipProvider>
					<MatchAndReconcile contentHeight={900} />
				</TooltipProvider>
			</MemoryRouter>
		</Provider>
	)

	return { ...view, store }
}

/** Every candidate voucher card carries exactly one of these. */
const reconcileButtons = () => screen.queryAllByRole('button', { name: /Reconcile/ })

/** Scopes to one voucher card by the ledger entry it links to, so no assertion depends on row order. */
const voucherCard = (voucherName: string): HTMLElement => {
	const link = screen.getByRole('link', { name: voucherName })
	const card = link.closest('div.border')
	if (!card) {
		throw new Error(`No voucher card found for ${voucherName}`)
	}
	return card as HTMLElement
}

/**
 * A shift-click, which is how the workbench extends or trims a multi-row selection
 * (`event.shiftKey` on the row's own click handler). `userEvent` expresses modifiers by holding the
 * key down around the click rather than as a click option, so the flag genuinely reaches the event.
 */
const shiftClick = async (user: ReturnType<typeof userEvent.setup>, element: HTMLElement) => {
	await user.keyboard('{Shift>}')
	await user.click(element)
	await user.keyboard('{/Shift}')
}

/**
 * The LIST row for a transaction. The description is deliberately matched through its
 * `role="button"` ancestor rather than directly: once several rows are selected, the
 * selected-transactions table repeats each description, so a bare text lookup becomes ambiguous while
 * only the list itself presents the description as an interactive row.
 */
const transactionRow = (description: string): HTMLElement => {
	const rows = screen.getAllByText(description)
		.map((node) => node.closest('[role="button"]'))
		.filter((node): node is HTMLElement => node !== null)

	if (rows.length === 0) {
		throw new Error(`No transaction row found for "${description}"`)
	}

	return rows[0]
}

/** What the client actually sent for one reconcile attempt, decoded from the posted payload. */
const postedVouchers = (callIndex = 0) => {
	const payload = frappePostCall.mock.calls[callIndex][0] as { bank_transaction_name: string, vouchers: string }
	return { bankTransaction: payload.bank_transaction_name, vouchers: JSON.parse(payload.vouchers) as unknown[] }
}

describe('MatchAndReconcile', () => {

	beforeEach(() => {
		resetFrappeSDKMock()
		toastSuccess.mockClear()
		toastError.mockClear()
	})

	/**
	 * TC1. The reviewer's entry point: whatever the server returned for the selected account and
	 * date range, rendered as it returned it. The list is virtualised, so what is asserted here is
	 * that the rows actually reach the DOM and carry the server's own values.
	 */
	describe('the unreconciled transaction list', () => {

		it('renders one row per transaction the server returned', () => {
			renderWorkbench({
				transactions: [
					makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00001', description: 'NEFT from ACME Traders' }),
					makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00002', description: 'Card settlement 4412' })
				]
			})

			expect(screen.getByText('NEFT from ACME Traders')).toBeInTheDocument()
			expect(screen.getByText('Card settlement 4412')).toBeInTheDocument()
			expect(screen.getByText('2 results')).toBeInTheDocument()
		})

		// The figures a reviewer reconciles against, so they are pinned against the payload rather
		// than assumed: the reference the server parsed off the statement, its own transaction type
		// and the amount, all read off the row.
		it('renders the server\'s reference, type and amount on the row', () => {
			renderWorkbench({
				transactions: [makeUnreconciledTransaction({
					reference_number: 'NEFT-00099',
					transaction_type: 'NEFT',
					deposit: 4500,
					withdrawal: 0,
					unallocated_amount: 4500
				})]
			})

			expect(screen.getByText(/NEFT-00099/)).toBeInTheDocument()
			expect(screen.getByText('NEFT')).toBeInTheDocument()
			expect(screen.getByText(/₹\s*4,500\.00/)).toBeInTheDocument()
		})

		it('reports the count as a singular when the server returned one row', () => {
			renderWorkbench({ transactions: [makeUnreconciledTransaction()] })

			expect(screen.getByText('1 result')).toBeInTheDocument()
			expect(screen.queryByText('1 results')).not.toBeInTheDocument()
		})

		// An empty range is not an error, and the useful thing to offer there is the importer.
		it('offers the importer when the server reported nothing to reconcile', () => {
			renderWorkbench({ transactions: [] })

			expect(screen.getByText('No unreconciled transactions found')).toBeInTheDocument()
			expect(screen.getByRole('link', { name: 'Import Bank Statement' })).toHaveAttribute('href', '/statement-importer')
			expect(reconcileButtons()).toHaveLength(0)
		})

		it('shows placeholders rather than an empty verdict while the list is being read', () => {
			renderWorkbench({ isLoading: true })

			expect(document.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
			expect(screen.queryByText('No unreconciled transactions found')).not.toBeInTheDocument()
		})

		// A refused read is surfaced with the server's own text, not swallowed into an empty list.
		it('surfaces a refused list read verbatim', () => {
			renderWorkbench({
				transactions: [],
				listError: makeMessageOnlyError('Not permitted to read Bank Transaction')
			})

			expect(screen.getByText('Not permitted to read Bank Transaction')).toBeInTheDocument()
		})

		it('asks for a bank account before reading anything', () => {
			renderWorkbench({ withoutBank: true, transactions: [makeUnreconciledTransaction()] })

			expect(screen.getByText('Select a bank account to reconcile')).toBeInTheDocument()
			expect(screen.queryByText(/NEFT/)).not.toBeInTheDocument()
		})
	})

	/**
	 * TC2. The rule engine's suggestion. The stamp itself is a server-written field
	 * (`matched_transaction_rule`), so the client's job is to show WHICH rule matched — and to show
	 * nothing at all when the server stamped nothing.
	 */
	describe('the rule-suggested match', () => {

		it('names the rule the server matched on the row', () => {
			renderWorkbench({ transactions: [makeRuleMatchedTransaction()] })

			const badge = screen.getByTitle('Matched by rule')
			expect(badge).toHaveTextContent(TEST_TRANSACTION_RULE)
			expect(badge).toHaveAttribute('data-theme', 'violet')
		})

		it('shows no rule badge on a transaction the server did not stamp', () => {
			renderWorkbench({
				transactions: [makeUnreconciledTransaction({ matched_transaction_rule: undefined })]
			})

			expect(screen.queryByTitle('Matched by rule')).not.toBeInTheDocument()
		})

		// Selecting a stamped transaction pulls the rule document itself, so the reviewer sees what
		// the rule would do rather than only that something matched.
		it('describes the matched rule\'s recommended action once the transaction is selected', () => {
			const transaction = makeRuleMatchedTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [],
				rule: makeBankTransactionRule({
					rule_name: 'Card Settlements',
					rule_description: 'Daily card settlement payouts',
					classify_as: 'Payment Entry',
					priority: 3
				})
			})

			expect(screen.getByText('Card Settlements')).toBeInTheDocument()
			expect(screen.getByText('Daily card settlement payouts')).toBeInTheDocument()
			expect(screen.getByText('Recommended Action')).toBeInTheDocument()
			expect(screen.getByText('Priority 3')).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Create Payment Entry' })).toBeEnabled()
		})

		it('shows no rule card for an unstamped transaction', () => {
			const transaction = makeUnreconciledTransaction({ matched_transaction_rule: undefined })

			renderWorkbench({ transactions: [transaction], selection: [transaction], vouchers: [] })

			expect(screen.queryByText('Recommended Action')).not.toBeInTheDocument()
		})
	})

	/**
	 * TC3. The manual override. The reviewer is not obliged to accept the suggestion, so what is
	 * pinned here is that every candidate the server offered is reachable AND that confirming a
	 * different one posts THAT one's identity — the whole point of an override.
	 */
	describe('the manual override', () => {

		it('lists every candidate voucher the server offered, marking only the suggestion', () => {
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher(), overrideVoucher()]
			})

			expect(screen.getByRole('link', { name: 'ACC-PAY-2024-00001' })).toBeInTheDocument()
			expect(screen.getByRole('link', { name: 'ACC-JV-2024-00077' })).toBeInTheDocument()
			expect(within(voucherCard('ACC-PAY-2024-00001')).getByText('Suggested')).toBeInTheDocument()
			expect(within(voucherCard('ACC-JV-2024-00077')).queryByText('Suggested')).not.toBeInTheDocument()
		})

		it('renders the candidate\'s own party and doctype so the reviewer can tell them apart', () => {
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher(), overrideVoucher()]
			})

			const override = within(voucherCard('ACC-JV-2024-00077'))
			expect(override.getByText('Journal Entry')).toBeInTheDocument()
			expect(override.getByRole('link', { name: 'Globex Supplies' })).toBeInTheDocument()
			expect(override.getByText(/₹\s*8,750\.00/)).toBeInTheDocument()
		})

		// The assertion that makes this an override rather than a click: the posted payload names the
		// overridden voucher's doctype, name and amount, and nothing of the suggestion's.
		it('posts the overridden voucher\'s own identity, not the suggestion\'s', async () => {
			const user = userEvent.setup()
			const transaction = makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00042' })
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse({ unallocated_amount: 0 }))

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher(), overrideVoucher()]
			})

			await user.click(within(voucherCard('ACC-JV-2024-00077')).getByRole('button', { name: 'Reconcile' }))

			await waitFor(() => expect(frappePostCall).toHaveBeenCalledTimes(1))

			expect(postedVouchers()).toEqual({
				bankTransaction: 'ACC-BTN-2024-00042',
				vouchers: [{
					payment_doctype: 'Journal Entry',
					payment_name: 'ACC-JV-2024-00077',
					amount: 8750
				}]
			})
		})

		// Selection is what the vouchers panel is keyed on, so clicking a row has to be what opens
		// the candidates for THAT transaction.
		it('opens the candidates for the row the reviewer clicked', async () => {
			const user = userEvent.setup()

			renderWorkbench({
				transactions: [makeUnreconciledTransaction({ description: 'NEFT from ACME Traders' })],
				vouchers: [suggestedVoucher()]
			})

			expect(screen.getByText('Select a transaction to match and reconcile with vouchers')).toBeInTheDocument()

			await user.click(transactionRow('NEFT from ACME Traders'))

			expect(await screen.findByRole('link', { name: 'ACC-PAY-2024-00001' })).toBeInTheDocument()
		})

		it('says so plainly when the server offered no candidates at all', () => {
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({ transactions: [transaction], selection: [transaction], vouchers: [] })

			expect(screen.getByText('No vouchers found for this transaction')).toBeInTheDocument()
			expect(reconcileButtons()).toHaveLength(0)
		})
	})

	/**
	 * TC4. Confirming the match. Posting is ONE server-side operation and its response is the only
	 * source of truth, so what is pinned here is that the client sends one request, tells the
	 * reviewer only what the server confirmed, and re-reads the range rather than writing a
	 * reconciliation it never read back.
	 */
	describe('confirming the match', () => {

		it('posts once and reports the reconciliation the server confirmed', async () => {
			const user = userEvent.setup()
			const transaction = makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00001' })
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse({
				name: 'ACC-BTN-2024-00001',
				status: 'Reconciled',
				unallocated_amount: 0
			}))

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher()]
			})

			await user.click(screen.getByRole('button', { name: 'Reconcile' }))

			await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Reconciled', expect.anything()))
			expect(frappePostCall).toHaveBeenCalledTimes(1)
			expect(toastError).not.toHaveBeenCalled()
		})

		// The status the reviewer then sees has to come from a re-read, not from the client patching
		// its own cache: the range's transaction list and closing balance are both revalidated.
		it('re-reads the range instead of writing the new status itself', async () => {
			const user = userEvent.setup()
			const transaction = makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00001' })
			frappePostCall.mockResolvedValue(makeReconcileSuccessResponse({ unallocated_amount: 0 }))

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher()]
			})

			await user.click(screen.getByRole('button', { name: 'Reconcile' }))

			await waitFor(() => expect(frappeSWRMutate).toHaveBeenCalledWith(
				bankRecUnreconciledTransactionsKey(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)))

			// Nothing was written INTO a cache entry: every revalidation is key-only.
			for (const call of frappeSWRMutate.mock.calls) {
				expect(call).toHaveLength(1)
			}
		})

		// A second post while the first is unresolved is the duplicate-posting risk, so the control
		// closes for the whole settling window rather than only while the request is in flight.
		it('closes the action while an attempt is unresolved', async () => {
			const user = userEvent.setup()
			const transaction = makeUnreconciledTransaction()

			let release: (value: unknown) => void = () => undefined
			frappePostCall.mockImplementation(() => new Promise((resolve) => { release = resolve }))

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher()]
			})

			const confirm = screen.getByRole('button', { name: 'Reconcile' })
			expect(confirm).toBeEnabled()

			await user.click(confirm)

			// The label is matched loosely on purpose. `loading` comes from the SDK hook, which the
			// wholesale mock holds at its initial value, so the wording resolves to the settling
			// variant here where the browser would show "Reconciling" first. What both windows share -
			// and what actually prevents a duplicate post - is that the action is CLOSED throughout.
			await waitFor(() => expect(screen.getByRole('button', { name: /Reconciling|Checking/ })).toBeDisabled())
			expect(screen.queryByRole('button', { name: 'Reconcile' })).toBeNull()

			await waitFor(() => release(makeReconcileSuccessResponse({ unallocated_amount: 0 })))
		})

		/**
		 * FM1 / TC6. A refused post must leave the transaction exactly as it was and say so with the
		 * server's own words. The dialog holds the envelope BY IDENTITY, so nothing is paraphrased.
		 */
		it('surfaces a refused post in the dismissible dialog and reconciles nothing', async () => {
			const user = userEvent.setup()
			const transaction = makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00001' })
			const refusal = makeAlreadyReconciledError('ACC-BTN-2024-00001')
			frappePostCall.mockRejectedValue(refusal)

			const { store } = renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher()]
			})

			await user.click(screen.getByRole('button', { name: 'Reconcile' }))

			await waitFor(() => expect(store.get(bankRecErrorDialogAtom)).toBe(refusal))
			expect(toastError).toHaveBeenCalled()
			expect(toastSuccess).not.toHaveBeenCalled()

			// The selection still holds the server's row, unmodified: no reconciliation was invented.
			expect(store.get(bankRecSelectedTransactionAtom(TEST_BANK_ACCOUNT))[0].status).toBe('Unreconciled')
		})
	})

	/**
	 * TC5 / FM3. The already-reconciled guard. It mirrors the backend's own predicate — a post is
	 * refused once `unallocated_amount <= 0`, and the server derives `status` from that same figure —
	 * so the affordance never offers an action that cannot succeed. The server stays authoritative;
	 * this is only about not inviting the attempt.
	 */
	describe('the already-reconciled guard', () => {

		it('offers the action for a transaction the server still reports as unreconciled', () => {
			const transaction = makeUnreconciledTransaction({ status: 'Unreconciled', unallocated_amount: 5000 })

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher()]
			})

			expect(screen.getByRole('button', { name: 'Reconcile' })).toBeEnabled()
		})

		it('withholds it once the server reports the transaction as reconciled', () => {
			const transaction = makeReconciledTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher()]
			})

			expect(screen.getByRole('button', { name: 'Reconcile' })).toBeDisabled()
		})

		// The predicate the BACKEND actually tests is the figure, not the label, so a row whose
		// status has not caught up is still refused - which is exactly the guard's reason to exist.
		it('withholds it on a fully allocated row whose status label has not caught up', () => {
			const transaction = makeUnreconciledTransaction({ status: 'Unreconciled', unallocated_amount: 0 })

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher()]
			})

			expect(screen.getByRole('button', { name: 'Reconcile' })).toBeDisabled()
		})

		it('withholds it on an over-allocated row', () => {
			const transaction = makeUnreconciledTransaction({ status: 'Unreconciled', unallocated_amount: -25 })

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher()]
			})

			expect(screen.getByRole('button', { name: 'Reconcile' })).toBeDisabled()
		})

		// A disabled control emits no pointer or focus events, so the reason is anchored to a
		// focusable wrapper - discoverable by keyboard as well as by mouse.
		it('states why the action is unavailable, reachably', async () => {
			const user = userEvent.setup()
			const transaction = makeReconciledTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher()]
			})

			const wrapper = screen.getByRole('button', { name: 'Reconcile' }).parentElement
			expect(wrapper).toHaveAttribute('tabindex', '0')

			await user.hover(wrapper as HTMLElement)

			// Radix publishes tooltip copy twice - the visible bubble and a screen-reader copy - so
			// both are accepted here; the assertion is that the reason is published at all.
			expect(await screen.findAllByText('This bank transaction is already fully reconciled, so it cannot be reconciled again.'))
				.not.toHaveLength(0)
		})

		it('stamps no reason on the row while the action is available', () => {
			const transaction = makeUnreconciledTransaction({ status: 'Unreconciled', unallocated_amount: 5000 })

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher()]
			})

			expect(screen.getByRole('button', { name: 'Reconcile' }).parentElement).not.toHaveAttribute('tabindex')
			expect(screen.queryByText(/already fully reconciled/)).not.toBeInTheDocument()
		})

		/**
		 * The stale-client case FM3 is really about. The client held a row it believed was
		 * reconcilable, the server refused the post, and the refresh that follows rebuilds the
		 * selection from the server's OWN rows - after which this guard is reading the truth and the
		 * action closes. Nothing here depends on the client having guessed the new state.
		 */
		it('closes after a refusal, from the server\'s refreshed row', async () => {
			const user = userEvent.setup()
			const stale = makeUnreconciledTransaction({
				name: 'ACC-BTN-2024-00001',
				status: 'Unreconciled',
				unallocated_amount: 5000
			})

			frappePostCall.mockRejectedValue(makeAlreadyReconciledError('ACC-BTN-2024-00001'))

			// The authoritative answer: the all-transactions view still reports the row, now settled.
			frappeSWRMutate.mockImplementation((key: unknown) =>
				Promise.resolve(key === bankRecBankTransactionsKey(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
					? {
						message: [makeBankTransaction({
							name: 'ACC-BTN-2024-00001',
							status: 'Reconciled',
							unallocated_amount: 0
						})]
					}
					: undefined))

			const { store } = renderWorkbench({
				transactions: [stale],
				selection: [stale],
				vouchers: [suggestedVoucher()]
			})

			expect(screen.getByRole('button', { name: 'Reconcile' })).toBeEnabled()

			await user.click(screen.getByRole('button', { name: 'Reconcile' }))

			// The refusal is reported in a MODAL dialog, so the page behind it is `aria-hidden` until
			// it is dismissed - which is exactly the order the reviewer experiences: read the server's
			// reason, dismiss it, find the action correctly withheld.
			await user.click(await screen.findByRole('button', { name: 'Dismiss' }))

			await waitFor(() => expect(screen.getByRole('button', { name: 'Reconcile' })).toBeDisabled())

			// The row the guard is now reading is the SERVER's, taken whole rather than patched.
			expect(store.get(bankRecSelectedTransactionAtom(TEST_BANK_ACCOUNT))[0]).toMatchObject({
				name: 'ACC-BTN-2024-00001',
				status: 'Reconciled',
				unallocated_amount: 0
			})
			expect(frappePostCall).toHaveBeenCalledTimes(1)
		})
	})

	/**
	 * FM5. The currency advisory. It is an ADVISORY: it reports what this client observed and
	 * deliberately does not block the reconciliation, because the server is the authority on the
	 * outcome. It is decided against the account currency the CURRENT bank-account list reports -
	 * never the `localStorage` snapshot - so it can neither invent a mismatch nor hide a real one.
	 */
	describe('the currency advisory', () => {

		it('flags a transaction whose currency differs from the account\'s', () => {
			renderWorkbench({
				transactions: [makeCurrencyMismatchTransaction()],
				accountCurrency: TEST_CURRENCY
			})

			const advisory = screen.getByText(
				new RegExp(`Transaction currency ${TEST_ALTERNATE_CURRENCY} differs from the bank account currency ${TEST_CURRENCY}`))
			expect(advisory).toBeInTheDocument()
			expect(advisory).toHaveTextContent('does not block the reconciliation')
		})

		it('publishes the advisory as the row\'s own description', () => {
			renderWorkbench({
				transactions: [makeCurrencyMismatchTransaction({ description: 'Wire from Contoso' })],
				accountCurrency: TEST_CURRENCY
			})

			const row = transactionRow('Wire from Contoso')
			const describedBy = row.getAttribute('aria-describedby')
			expect(describedBy).toBeTruthy()
			expect(document.getElementById(describedBy as string)?.textContent).toContain(
				`Transaction currency ${TEST_ALTERNATE_CURRENCY} differs from the bank account currency ${TEST_CURRENCY}`)
		})

		it('says nothing when the two currencies agree', () => {
			renderWorkbench({
				transactions: [makeUnreconciledTransaction({ currency: TEST_CURRENCY })],
				accountCurrency: TEST_CURRENCY
			})

			expect(screen.queryByText(/differs from the bank account currency/)).not.toBeInTheDocument()
			expect(transactionRow(TEST_TRANSACTION_DESCRIPTION)).not.toHaveAttribute('aria-describedby')
		})

		// An absent value means "nothing to compare", not "mismatch": the endpoint cannot always
		// derive an account currency, and the transaction's own is optional.
		it('says nothing when the server could not report an account currency', () => {
			renderWorkbench({
				transactions: [makeCurrencyMismatchTransaction()],
				accountCurrency: undefined
			})

			expect(screen.queryByText(/differs from the bank account currency/)).not.toBeInTheDocument()
		})

		it('says nothing when the transaction carries no currency of its own', () => {
			renderWorkbench({
				transactions: [makeUnreconciledTransaction({ currency: undefined })],
				accountCurrency: TEST_CURRENCY
			})

			expect(screen.queryByText(/differs from the bank account currency/)).not.toBeInTheDocument()
		})

		// The defining property of FM5: advisory, not blocking. The backend decides the outcome.
		it('leaves the reconciliation available', () => {
			const transaction = makeCurrencyMismatchTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher(transaction)],
				accountCurrency: TEST_CURRENCY
			})

			expect(screen.getByText(/differs from the bank account currency/)).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Reconcile' })).toBeEnabled()
		})
	})
	/**
	 * Narrowing the list. Every one of these also CLEARS the selection, which matters more than it
	 * looks: the vouchers panel is keyed on the selected transaction, so a filter that changed the
	 * list while leaving a selection behind would offer candidates for a row the reviewer can no
	 * longer see.
	 */
	describe('searching and filtering', () => {

		it('narrows the list to what the search matches', async () => {
			const user = userEvent.setup()

			renderWorkbench({
				transactions: [
					makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00001', description: 'NEFT from ACME Traders' }),
					makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00002', description: 'Card settlement 4412' })
				]
			})

			await user.type(screen.getByPlaceholderText('Search'), 'settlement')

			// The search is debounced, so the narrowed list arrives a beat later.
			expect(await screen.findByText('1 result', {}, { timeout: 2000 })).toBeInTheDocument()
			expect(screen.getByText('Card settlement 4412')).toBeInTheDocument()
			expect(screen.queryByText('NEFT from ACME Traders')).not.toBeInTheDocument()
		})

		it('drops the selection when the search changes', async () => {
			const user = userEvent.setup()
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher(transaction)]
			})

			expect(screen.getByRole('link', { name: 'ACC-PAY-2024-00001' })).toBeInTheDocument()

			await user.type(screen.getByPlaceholderText('Search'), 'ACME')

			expect(await screen.findByText('Select a transaction to match and reconcile with vouchers', {}, { timeout: 2000 }))
				.toBeInTheDocument()
		})

		// Debits and credits are the two directions a statement line can run, and the server reports
		// them as separate columns rather than a signed amount - so the filter is a real narrowing,
		// not a re-sort.
		it('narrows the list to one direction of money', async () => {
			const user = userEvent.setup()

			renderWorkbench({
				transactions: [
					makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00001', description: 'Deposit row', deposit: 5000, withdrawal: 0 }),
					makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00002', description: 'Withdrawal row', deposit: 0, withdrawal: 900 })
				]
			})

			await user.click(screen.getByRole('button', { name: /All/ }))
			await user.click(await screen.findByRole('menuitem', { name: 'Debits' }))

			expect(await screen.findByText('1 result')).toBeInTheDocument()
			expect(screen.getByText('Withdrawal row')).toBeInTheDocument()
			expect(screen.queryByText('Deposit row')).not.toBeInTheDocument()
		})

		// A filter that matches nothing says so, and offers the way back - which is a different empty
		// state from a range that genuinely holds nothing.
		it('offers a way back when the filters match nothing', async () => {
			const user = userEvent.setup()

			renderWorkbench({
				transactions: [makeUnreconciledTransaction({ description: 'NEFT from ACME Traders' })]
			})

			await user.type(screen.getByPlaceholderText('Search'), 'zzzz-no-such-row')

			expect(await screen.findByText('No transactions found for the given filters.', {}, { timeout: 2000 }))
				.toBeInTheDocument()
			expect(screen.getByText('Try adjusting your search or filter criteria.')).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Clear Filters' }))

			expect(await screen.findByText('NEFT from ACME Traders', {}, { timeout: 2000 })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: /All/ })).toBeInTheDocument()
		})
	})

	/**
	 * Statement lines that predate the range. The opening balance cannot tie out while they exist, so
	 * the workbench says so and offers to widen the range to the server's own oldest date rather than
	 * making the reviewer guess it.
	 */
	describe('the older-transactions notice', () => {

		it('says nothing when the server reports none', () => {
			renderWorkbench({ transactions: [makeUnreconciledTransaction()], older: { count: 0, oldest_date: '2023-11-02' } })

			expect(screen.queryByText(/unreconciled transaction/)).not.toBeInTheDocument()
		})

		it('reports how many there are and widens the range to the server\'s oldest date', async () => {
			const user = userEvent.setup()

			const { store } = renderWorkbench({
				transactions: [makeUnreconciledTransaction()],
				older: { count: 4, oldest_date: '2023-11-02' }
			})

			expect(screen.getByText('There are 4 unreconciled transactions before 01-01-2024.')).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: /View older transactions/ }))

			expect(store.get(bankRecDateAtom)).toEqual({ fromDate: '2023-11-02', toDate: TO_DATE })
		})

		it('reads as a singular when there is exactly one', () => {
			renderWorkbench({
				transactions: [makeUnreconciledTransaction()],
				older: { count: 1, oldest_date: '2023-12-20' }
			})

			expect(screen.getByText('There is one unreconciled transaction before 01-01-2024.')).toBeInTheDocument()
			expect(screen.getByRole('button', { name: /View older transaction/ })).toBeInTheDocument()
		})
	})

	/**
	 * Selecting more than one line. A statement often settles several lines against one entry, and the
	 * workbench answers that with the CREATE actions rather than a match list - there is no single
	 * voucher to match a set against.
	 */
	describe('selecting several transactions', () => {

		it('totals the selection and offers the create actions instead of a match list', async () => {
			const user = userEvent.setup()

			renderWorkbench({
				transactions: [
					makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00001', description: 'First row', unallocated_amount: 5000 }),
					makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00002', description: 'Second row', unallocated_amount: 2500 })
				],
				vouchers: [suggestedVoucher()]
			})

			await user.click(transactionRow('First row'))
			await shiftClick(user, transactionRow('Second row'))

			expect(await screen.findByText('2 transactions selected')).toBeInTheDocument()
			expect(screen.getByText(/₹\s*7,500\.00/)).toBeInTheDocument()
			// Each action carries an explicit `aria-label`, which is what names it in the tree.
			expect(screen.getByRole('button', { name: /Record a bank journal entry/ })).toBeEnabled()
			expect(screen.getByRole('button', { name: /Record a payment entry against a customer or supplier/ })).toBeEnabled()
			expect(screen.getByRole('button', { name: /Record an internal transfer/ })).toBeEnabled()
			expect(reconcileButtons()).toHaveLength(0)
		})

		it('drops back to one row when the reviewer shift-clicks it away', async () => {
			const user = userEvent.setup()

			renderWorkbench({
				transactions: [
					makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00001', description: 'First row' }),
					makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00002', description: 'Second row' })
				],
				vouchers: [suggestedVoucher()]
			})

			await user.click(transactionRow('First row'))
			await shiftClick(user, transactionRow('Second row'))
			expect(await screen.findByText('2 transactions selected')).toBeInTheDocument()

			await shiftClick(user, transactionRow('Second row'))

			expect(await screen.findByRole('link', { name: 'ACC-PAY-2024-00001' })).toBeInTheDocument()
		})
	})

	/**
	 * The create actions on a single selection. Each opens a DIFFERENT modal, and the rule card routes
	 * to whichever one the matched rule classifies as - so the routing is what is pinned, per branch.
	 */
	describe('the create actions', () => {

		it('opens the payment entry modal', async () => {
			const user = userEvent.setup()
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({ transactions: [transaction], selection: [transaction], vouchers: [] })

			await user.click(screen.getByRole('button', { name: /Record a payment entry against a customer or supplier/ }))

			expect(await screen.findByRole('dialog')).toHaveTextContent('Record Payment')
		})

		it('opens the bank entry modal', async () => {
			const user = userEvent.setup()
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({ transactions: [transaction], selection: [transaction], vouchers: [] })

			await user.click(screen.getByRole('button', { name: /Record a bank journal entry/ }))

			expect(await screen.findByRole('dialog')).toHaveTextContent('Bank Entry')
		})

		it('opens the transfer modal', async () => {
			const user = userEvent.setup()
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({ transactions: [transaction], selection: [transaction], vouchers: [] })

			await user.click(screen.getByRole('button', { name: /Record an internal transfer/ }))

			expect(await screen.findByRole('dialog')).toHaveTextContent('Transfer')
		})

		it('routes a Bank Entry rule to the bank entry modal', async () => {
			const user = userEvent.setup()
			const transaction = makeRuleMatchedTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [],
				rule: makeBankTransactionRule({ classify_as: 'Bank Entry', account: 'Bank Charges - TC' })
			})

			expect(screen.getByText('Create a journal entry for expenses, income or split transactions')).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Create Bank Entry' }))

			expect(await screen.findByRole('dialog')).toHaveTextContent('Bank Entry')
		})

		it('routes a Transfer rule to the transfer modal', async () => {
			const user = userEvent.setup()
			const transaction = makeRuleMatchedTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [],
				rule: makeBankTransactionRule({ classify_as: 'Transfer' })
			})

			expect(screen.getByText('Record an internal transfer to another bank/credit card/cash account')).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Create Transfer' }))

			expect(await screen.findByRole('dialog')).toHaveTextContent('Transfer')
		})

		it('routes a Payment Entry rule to the payment modal', async () => {
			const user = userEvent.setup()
			const transaction = makeRuleMatchedTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [],
				rule: makeBankTransactionRule({ classify_as: 'Payment Entry' })
			})

			await user.click(screen.getByRole('button', { name: 'Create Payment Entry' }))

			expect(await screen.findByRole('dialog')).toHaveTextContent('Record Payment')
		})
	})

	/**
	 * How closely each candidate agrees with the selected transaction. These grades are what a
	 * reviewer scans, and the ONE thing they must never do is imply agreement that is not there:
	 * several voucher types come back from the server with a blank or NULL reference, and a naive
	 * comparison reads blank-versus-blank as a match.
	 */
	describe('the match grading', () => {

		it('grades an exact reference as a complete match', () => {
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [suggestedVoucher(transaction)]
			})

			expect(screen.getByText('Complete Match')).toBeInTheDocument()
			expect(screen.queryByText('No Match')).not.toBeInTheDocument()
		})

		it('grades an unrelated reference as no match', () => {
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [overrideVoucher()]
			})

			expect(screen.getByText('No Match')).toBeInTheDocument()
			expect(screen.queryByText('Complete Match')).not.toBeInTheDocument()
		})

		// An amount-only agreement must NOT be promoted to a suggestion. The invoice branches of the
		// server's union select a constant empty string for both reference columns, so the reference
		// contributes nothing here - and a blank reference is not rendered with a grade beside it.
		it('does not suggest an invoice that only agrees on the amount', () => {
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [makeBlankReferenceLinkedPayment()]
			})

			expect(screen.getByRole('link', { name: 'ACC-PINV-2024-00001' })).toBeInTheDocument()
			expect(screen.queryByText('Suggested')).not.toBeInTheDocument()
			expect(screen.queryByText('Complete Match')).not.toBeInTheDocument()
			expect(screen.queryByText('Partial Match')).not.toBeInTheDocument()
		})

		// The same must hold for NULL, which is what the Journal Entry branch yields when no row in
		// the group carries a cheque number.
		it('treats a NULL reference as absent rather than as agreement', () => {
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchers: [makeNullReferenceLinkedPayment()]
			})

			expect(screen.getByRole('link', { name: 'ACC-JV-2024-00002' })).toBeInTheDocument()
			expect(screen.queryByText('Suggested')).not.toBeInTheDocument()
			expect(screen.queryByText('Complete Match')).not.toBeInTheDocument()
		})

		it('shows placeholders while the candidates are being read', () => {
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({ transactions: [transaction], selection: [transaction], vouchersLoading: true })

			expect(document.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
			expect(screen.queryByText('No vouchers found for this transaction')).not.toBeInTheDocument()
		})

		it('surfaces a refused candidate read verbatim', () => {
			const transaction = makeUnreconciledTransaction()

			renderWorkbench({
				transactions: [transaction],
				selection: [transaction],
				vouchersError: makeMessageOnlyError('Not permitted to read Payment Entry')
			})

			expect(screen.getByText('Not permitted to read Payment Entry')).toBeInTheDocument()
		})
	})
})
