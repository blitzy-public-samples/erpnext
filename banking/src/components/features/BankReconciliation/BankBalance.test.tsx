import type { SWRConfiguration } from 'frappe-react-sdk'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createFrappeSDKMock,
	frappeContextValue,
	frappePostCall,
	frappeSDKMock,
	frappeSWRMutate,
	makeSelectedBank,
	makeServerMessagesError,
	makeUnreconciledTransaction,
	resetFrappeSDKMock,
	TEST_BANK_ACCOUNT,
	TEST_COMPANY
} from '@/test/factories'

// Replaces the SDK wholesale, so every read this panel performs is supplied by the suite and
// nothing reaches the real transport. Declared here because `vi.mock` is hoisted above the imports.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

// Created by `vi.hoisted` because the factory below is hoisted above every import in this file.
const { toastSuccess, toastError, toastPromise } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastPromise: vi.fn()
}))

vi.mock('sonner', () => ({
	toast: { success: toastSuccess, error: toastError, promise: toastPromise }
}))

import BankBalance from './BankBalance'
import { bankRecClosingBalanceAtom, bankRecDateAtom, selectedBankAccountAtom } from './bankRecAtoms'
import { bankRecClosingBalanceAsPerStatementKey } from './utils'
import { TooltipProvider } from '@/components/ui/tooltip'

const FROM_DATE = '2024-01-01'
const TO_DATE = '2024-01-31'

/** The endpoint behind `useGetUnreconciledTransactions`, which supplies the remainder of the figure. */
const BANK_TRANSACTIONS_METHOD =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions'

const emptyRead = {
	data: undefined,
	error: undefined,
	isLoading: false,
	isValidating: false,
	mutate: vi.fn(() => Promise.resolve(undefined))
}

/**
 * Renders the panel with the two reads the reconciliation figure is derived from set
 * independently, which is the whole point: they are separately cached in production and a stale
 * or in-flight one is exactly what produced a false figure.
 *
 * `totalCount` is the submitted-transaction count for the range (`useFrappeGetDocCount`);
 * `unreconciledCount` is the length of the unreconciled list, or `undefined` for "has not
 * answered yet".
 */
const renderPanel = ({
	totalCount,
	unreconciledCount
}: {
	totalCount?: number
	unreconciledCount?: number
}) => {
	frappeSDKMock.useFrappeGetDocCount.mockReturnValue({ ...emptyRead, data: totalCount })

	frappeSDKMock.useFrappeGetCall.mockImplementation((method) =>
		method === BANK_TRANSACTIONS_METHOD && unreconciledCount !== undefined
			? {
				...emptyRead,
				data: {
					message: Array.from({ length: unreconciledCount }, (_unused, index) =>
						makeUnreconciledTransaction({ name: `ACC-BTN-2024-0000${index + 1}` }))
				}
			}
			: emptyRead)

	const store = createStore()
	store.set(selectedBankAccountAtom, makeSelectedBank({ name: TEST_BANK_ACCOUNT }))
	store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })

	return render(
		<Provider store={store}>
			<TooltipProvider>
				<BankBalance />
			</TooltipProvider>
		</Provider>
	)
}

/** The `Progress` primitive renders its fill as a `translateX` of the remaining percentage. */
const progressFillTransform = () =>
	document.querySelector('[data-slot="progress-indicator"]')?.getAttribute('style')

/**
 * The reconciliation progress figure.
 *
 * It is DERIVED from two independently cached reads - a document count for the range, and the
 * length of the unreconciled list - so they can disagree, and the direction of the disagreement
 * decides how bad it is. Under-reporting is a cosmetic wobble. OVER-reporting is a financial claim
 * the server never made: it tells a reviewer that transactions have been reconciled when they have
 * not, on the same screen as the closing balance, with nothing on the page contradicting it. The
 * tests below therefore pin the figure's honesty, not merely its arithmetic.
 */
describe('ReconcileProgress', () => {

	beforeEach(() => {
		resetFrappeSDKMock()
	})

	// The case that made this a MAJOR defect. `(total ?? 0) - (list?.length ?? 0)` reads a MISSING
	// list as "nothing is unreconciled", so every transaction in range is reported as reconciled -
	// and a missing list is the NORMAL state while it is being fetched, which is precisely when the
	// count is most likely to have already answered. Nothing may be claimed until both have.
	it('claims no figure at all while the unreconciled list has not answered', () => {
		renderPanel({ totalCount: 5, unreconciledCount: undefined })

		expect(screen.queryByText(/reconciled/)).not.toBeInTheDocument()
		expect(screen.queryByText('5 / 5 reconciled')).not.toBeInTheDocument()
		expect(document.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
	})

	// The mirror image, and the one visible on every first paint: with no count the figure used to
	// render the literal string "0 / undefined reconciled".
	it('claims no figure while the transaction count has not answered', () => {
		renderPanel({ totalCount: undefined, unreconciledCount: 2 })

		expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
		expect(screen.queryByText(/reconciled/)).not.toBeInTheDocument()
	})

	// An unresolved figure must not be drawn as progress either - an unknown ratio is shown empty
	// rather than guessed.
	it('leaves the bar empty while either input is unresolved', () => {
		renderPanel({ totalCount: 5, unreconciledCount: undefined })

		expect(progressFillTransform()).toBe('transform: translateX(-100%);')
	})

	// Once both reads have answered the figure is the honest difference, and IS displayed: the
	// guard suppresses uncertainty, not information.
	it('reports the difference once both reads have answered', () => {
		renderPanel({ totalCount: 5, unreconciledCount: 2 })

		expect(screen.getByText('3 / 5 reconciled')).toBeInTheDocument()
		expect(progressFillTransform()).toBe('transform: translateX(-40%);')
	})

	// A freshly imported range: every transaction is unreconciled, so the truthful figure is zero
	// - which is the assertion the QA reproduction turned on ("0 / 5", not "3 / 5").
	it('reports zero reconciled when the whole range is unreconciled', () => {
		renderPanel({ totalCount: 5, unreconciledCount: 5 })

		expect(screen.getByText('0 / 5 reconciled')).toBeInTheDocument()
		expect(progressFillTransform()).toBe('transform: translateX(-100%);')
	})

	// The negative direction, where the count is momentarily behind the list. Clamped, because a
	// negative count of reconciliations is not a number a reviewer can act on.
	it('never renders a negative figure when the two reads are out of step', () => {
		renderPanel({ totalCount: 1, unreconciledCount: 3 })

		expect(screen.getByText('0 / 1 reconciled')).toBeInTheDocument()
		expect(screen.queryByText(/-\d/)).not.toBeInTheDocument()
	})

	// The panel renders nothing at all without a selected account, so the guard above can never be
	// reached with a half-built key.
	it('renders nothing when no bank account is selected', () => {
		frappeSDKMock.useFrappeGetDocCount.mockReturnValue({ ...emptyRead, data: 5 })

		const store = createStore()
		store.set(selectedBankAccountAtom, null)

		const { container } = render(
			<Provider store={store}>
				<TooltipProvider>
					<BankBalance />
				</TooltipProvider>
			</Provider>
		)

		expect(container).toBeEmptyDOMElement()
	})
})

/**
 * The four figures beside the progress bar, and the one of them the reviewer can EDIT.
 *
 * "Closing balance as per statement" is the only number on this panel that does not come from the
 * ledger - it is what the reviewer reads off the paper statement - and the `Difference` stat is
 * derived from it. So a mis-seeded statement balance does not merely look wrong in one place; it
 * reports a discrepancy against the ledger that does not exist.
 */
describe('the balance stats', () => {

	const OPENING = 100000
	const CLOSING = 125000
	const STATEMENT_BALANCE = 125000

	/**
	 * Renders the panel with all four reads answered. The two ledger balances come from the SAME
	 * endpoint with different arguments (`till_date` is the day before the range for the opening
	 * figure, and the range's end for the closing one), so they are told apart by that argument
	 * exactly as the cache keys do.
	 */
	const renderStats = ({
		statementBalance = STATEMENT_BALANCE,
		statementDate = TO_DATE,
		previousBalances,
		isLoading = false
	}: {
		statementBalance?: number
		statementDate?: string
		previousBalances?: { name: string, date: string, balance: number }[]
		isLoading?: boolean
	} = {}) => {
		let seedStatementBalance: (() => void) | undefined

		frappeSDKMock.useFrappeGetDocCount.mockReturnValue({ ...emptyRead, data: 4 })

		frappeSDKMock.useFrappeGetCall.mockImplementation((method, params, _key, options) => {
			if (method.endsWith('get_account_balance')) {
				return {
					...emptyRead,
					isLoading,
					data: { message: params?.till_date === TO_DATE ? CLOSING : OPENING }
				}
			}

			if (method.endsWith('get_closing_balance_as_per_statement')) {
				const data = { message: { balance: statementBalance, date: statementDate } }
				// The hook seeds the editable figure from its OWN `onSuccess`, so the suite holds on to
				// that callback and fires it deliberately - firing it during a render would set state
				// mid-render. SWR hands the callback a third argument, its fully resolved internal
				// configuration; the production callback reads only the payload, and no test can
				// meaningfully construct that object, so it is supplied as the shape SWR declares.
				const onSuccess = options?.onSuccess
				seedStatementBalance = onSuccess
					? () => onSuccess(
						data,
						bankRecClosingBalanceAsPerStatementKey(TEST_BANK_ACCOUNT, TO_DATE),
						{} as Parameters<NonNullable<SWRConfiguration['onSuccess']>>[2]
					)
					: undefined
				return { ...emptyRead, isLoading, data }
			}

			if (method.endsWith('get_bank_transactions')) {
				return { ...emptyRead, data: { message: [makeUnreconciledTransaction()] } }
			}

			return emptyRead
		})

		frappeSDKMock.useFrappeGetDocList.mockImplementation((doctype) =>
			doctype === 'Bank Account Balance' && previousBalances
				? { ...emptyRead, data: previousBalances }
				: { ...emptyRead, data: [] })

		const store = createStore()
		store.set(selectedBankAccountAtom, makeSelectedBank({ name: TEST_BANK_ACCOUNT, company: TEST_COMPANY, account_currency: 'INR' }))
		store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })

		const view = render(
			<Provider store={store}>
				<TooltipProvider>
					<BankBalance />
				</TooltipProvider>
			</Provider>
		)

		return { ...view, store, seedStatementBalance: () => act(() => seedStatementBalance?.()) }
	}

	beforeEach(() => {
		resetFrappeSDKMock()
		toastSuccess.mockClear()
		toastError.mockClear()
		toastPromise.mockClear()
	})

	it('reports the ledger figures the server returned', () => {
		renderStats()

		expect(screen.getByText('Opening Balance')).toBeInTheDocument()
		expect(screen.getByText(/₹\s*100,000\.00/)).toBeInTheDocument()
		expect(screen.getByText('Closing Balance as per system')).toBeInTheDocument()
		expect(screen.getAllByText(/₹\s*125,000\.00/).length).toBeGreaterThan(0)
	})

	it('shows placeholders instead of figures while the reads are in flight', () => {
		renderStats({ isLoading: true })

		expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
		expect(screen.queryByText(/₹\s*100,000\.00/)).not.toBeInTheDocument()
	})

	// The reviewer's own figure seeds the atom the `Difference` stat is derived from, so once the
	// statement agrees with the ledger the difference is zero.
	it('derives the difference from the reviewer\'s statement figure', () => {
		const { seedStatementBalance, store } = renderStats()

		seedStatementBalance()

		expect(store.get(bankRecClosingBalanceAtom(TEST_BANK_ACCOUNT))).toEqual({
			value: STATEMENT_BALANCE,
			stringValue: String(STATEMENT_BALANCE)
		})
		expect(screen.getByText('Difference')).toBeInTheDocument()
		expect(screen.getByText(/₹\s*0\.00/)).toBeInTheDocument()
	})

	it('reports a real discrepancy when the statement disagrees with the ledger', () => {
		const { seedStatementBalance } = renderStats({ statementBalance: 130000 })

		seedStatementBalance()

		expect(screen.getByText(/₹\s*5,000\.00/)).toBeInTheDocument()
	})

	// A stored figure from an earlier date is not the closing balance for THIS range, so the panel
	// says which date it belongs to rather than letting it read as current.
	it('dates a statement figure that belongs to an earlier day', () => {
		renderStats({ statementDate: '2024-01-20' })

		expect(screen.getByText('As of 20th Jan 2024')).toBeInTheDocument()
	})

	it('adds no date when the figure is for the range\'s own end date', () => {
		renderStats({ statementDate: TO_DATE })

		expect(screen.queryByText(/^As of /)).not.toBeInTheDocument()
	})

	/** The editor behind that figure. */
	describe('setting the statement balance', () => {

		/**
		 * Opens the editor. The trigger is addressed by its `data-slot` rather than by name because the
		 * figure is published TWICE inside it - once by the dialog trigger and once by the tooltip
		 * trigger nested in it - so both carry the identical accessible name.
		 */
		const openEditor = async (user: ReturnType<typeof userEvent.setup>) => {
			const trigger = document.querySelector('[data-slot="dialog-trigger"]')
			if (!(trigger instanceof HTMLElement)) {
				throw new Error('no dialog trigger rendered for the statement balance')
			}

			await user.click(trigger)
			return screen.findByRole('dialog')
		}

		it('opens an editor naming the account and the date it applies to', async () => {
			const user = userEvent.setup()
			renderStats()

				const dialog = await openEditor(user)

			expect(within(dialog).getByText('Set closing balance as per bank statement')).toBeInTheDocument()
			// The date is stated twice - in the description and again on the field's own label - so both
			// the account and the day the figure applies to are unambiguous wherever the reviewer looks.
			expect(within(dialog).getByText(/Test Bank Current Account/)).toBeInTheDocument()
			expect(within(dialog).getAllByText(/31st Jan 2024/)).toHaveLength(2)
		})

		// Saving posts the figure for THAT account and date, then re-reads the key the panel displays
		// from - it does not patch its own cache entry.
		it('posts the figure and re-reads the value it displays', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue({ message: 'ok' })

			const { store } = renderStats()
			const dialog = await openEditor(user)

			await user.click(within(dialog).getByRole('button', { name: 'Save' }))

			await waitFor(() => expect(frappePostCall).toHaveBeenCalledWith({
				bank_account: TEST_BANK_ACCOUNT,
				date: TO_DATE,
				balance: STATEMENT_BALANCE
			}))

			expect(frappeSWRMutate).toHaveBeenCalledWith(bankRecClosingBalanceAsPerStatementKey(TEST_BANK_ACCOUNT, TO_DATE))
			expect(toastSuccess).toHaveBeenCalledWith('Closing balance set.')
			expect(store.get(bankRecClosingBalanceAtom(TEST_BANK_ACCOUNT)).value).toBe(STATEMENT_BALANCE)
		})

		// A closing balance is a required figure, so an empty one is refused before anything is posted.
		it('refuses to post an empty figure', async () => {
			const user = userEvent.setup()
			renderStats({ statementBalance: 0 })

			const dialog = await openEditor(user)

			await user.click(within(dialog).getByRole('button', { name: 'Save' }))

			await waitFor(() => expect(toastError).toHaveBeenCalledWith('Closing balance is required.'))
			expect(frappePostCall).not.toHaveBeenCalled()
		})

		// A refused save must change nothing and must not escape as an unhandled rejection: the
		// reviewer keeps the editor, the stored figure is untouched, and no success is claimed.
		it('changes nothing when the save is refused', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(makeServerMessagesError('Not permitted to set the closing balance'))

			const { store } = renderStats()
			const dialog = await openEditor(user)

			await user.click(within(dialog).getByRole('button', { name: 'Save' }))

			await waitFor(() => expect(frappePostCall).toHaveBeenCalled())
			expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument()
			expect(toastSuccess).not.toHaveBeenCalled()
			expect(frappeSWRMutate).not.toHaveBeenCalled()
			expect(store.get(bankRecClosingBalanceAtom(TEST_BANK_ACCOUNT)).value).toBe(0)
		})

		// And the server's own words are what the reviewer reads, in the editor they are still in.
		it('reports a refusal with the server\'s own text', async () => {
			const user = userEvent.setup()
			const refusal = makeServerMessagesError('Not permitted to set the closing balance')

			frappeSDKMock.useFrappePostCall.mockReturnValue({
				call: frappePostCall,
				result: null,
				loading: false,
				error: refusal,
				isCompleted: false,
				reset: vi.fn()
			})

			renderStats()
			const dialog = await openEditor(user)

			expect(within(dialog).getByText('Not permitted to set the closing balance')).toBeInTheDocument()
		})

		// Earlier statement figures for the same account are listed, because a wrong one entered
		// yesterday is exactly what makes today's difference unexplainable.
		it('lists the figures already recorded for earlier dates', async () => {
			const user = userEvent.setup()
			renderStats({
				previousBalances: [
					{ name: 'BAB-0001', date: '2023-12-31', balance: 90000 },
					{ name: 'BAB-0002', date: '2023-11-30', balance: 80000 }
				]
			})

			const dialog = await openEditor(user)

			expect(within(dialog).getByText('31st Dec 2023')).toBeInTheDocument()
			expect(within(dialog).getByText(/₹\s*90,000\.00/)).toBeInTheDocument()
			expect(within(dialog).getByText('30th Nov 2023')).toBeInTheDocument()
			expect(within(dialog).getAllByRole('button', { name: 'Delete' })).toHaveLength(2)
		})

		it('deletes a recorded figure through the server', async () => {
			const user = userEvent.setup()
			frappeContextValue.db.deleteDoc.mockResolvedValue({ message: 'ok' })

			renderStats({ previousBalances: [{ name: 'BAB-0001', date: '2023-12-31', balance: 90000 }] })

			const dialog = await openEditor(user)
			await user.click(within(dialog).getAllByRole('button', { name: 'Delete' })[0])

			await waitFor(() => expect(frappeContextValue.db.deleteDoc)
				.toHaveBeenCalledWith('Bank Account Balance', 'BAB-0001'))
			// Reported through the shared promise toast, so the reviewer sees the outcome either way.
			expect(toastPromise).toHaveBeenCalled()
		})

		it('lists nothing when no earlier figure was ever recorded', async () => {
			const user = userEvent.setup()
			renderStats()

			const dialog = await openEditor(user)

			expect(within(dialog).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
		})
	})
})
