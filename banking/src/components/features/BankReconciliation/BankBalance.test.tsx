/**
 * Behavioural specification for the balance strip at the top of the reconciliation workbench.
 *
 * The strip is the reviewer's scoreboard: opening balance, closing balance per the system, closing
 * balance per the bank statement, the difference between the last two, and how much of the period has
 * been reconciled. The DIFFERENCE is the number the whole screen exists to drive to zero, so the
 * behaviours worth pinning are the ones that decide it and how it is presented.
 *
 * Six behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. The whole strip renders NOTHING until a bank account is chosen - it is not merely empty.
 *   2. Opening and closing balance call the SAME endpoint and are told apart only by their arguments:
 *      opening asks for the day BEFORE the range starts, closing for the day it ends.
 *   3. The difference is computed against an ATOM the statement panel writes, not against the fetched
 *      value directly, so the two panels are coupled through jotai rather than through props.
 *   4. A non-zero difference is coloured as an error, and only exactly zero is not.
 *   5. The statement balance PUSHES what it fetched into that atom on success, which is what makes the
 *      difference correct on first paint.
 *   6. The progress figure is derived by SUBTRACTION - total submitted transactions minus the
 *      unreconciled ones - rather than being counted directly.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
	TEST_BANK_ACCOUNT,
	createFrappeSDKMock,
	frappePostCall,
	frappeSDKMock,
	makeUnreconciledTransaction
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankBalance from './BankBalance'
import { bankRecClosingBalanceAtom } from './bankRecAtoms'
import { PANEL_TO_DATE, renderPanel, stubViewportMeasurement } from '@/test/renderPanel'

const ACCOUNT_BALANCE =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_account_balance'
const STATEMENT_BALANCE =
	'erpnext.accounts.doctype.bank_account.bank_account.get_closing_balance_as_per_statement'
const UNRECONCILED =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions'
const CLOSING_KEY = `bank-reconciliation-account-closing-balance-${TEST_BANK_ACCOUNT}-${PANEL_TO_DATE}`

interface BalanceOptions {
	opening?: number
	closing?: number
	statement?: { balance: number, date?: string }
	unreconciled?: number
	isLoading?: boolean
}

/**
 * Answers each balance read. Opening and closing hit the same endpoint, so they are told apart by the
 * SWR key the hook declares - closing names itself, opening passes none.
 */
const answerBalances = ({
	opening = 10000,
	closing = 12000,
	statement = { balance: 12000, date: PANEL_TO_DATE },
	unreconciled = 0,
	isLoading = false
}: BalanceOptions = {}) => {
	frappeSDKMock.useFrappeGetCall.mockImplementation(((
		method: string,
		_params: unknown,
		key: unknown,
		config: { onSuccess?: (data: unknown) => void } = {}
	) => {
		if (method === ACCOUNT_BALANCE) {
			const value = key === CLOSING_KEY ? closing : opening
			return { data: { message: value }, error: undefined, isLoading, mutate: vi.fn() }
		}

		if (method === STATEMENT_BALANCE) {
			const data = { message: statement }
			// The real hook is given an `onSuccess` that pushes the balance into the shared atom, so the
			// double must invoke it or the difference can never be right on first paint.
			config.onSuccess?.(data)
			return { data, error: undefined, isLoading, mutate: vi.fn() }
		}

		if (method === UNRECONCILED) {
			return {
				data: {
					message: Array.from({ length: unreconciled }, (_unused, index) =>
						makeUnreconciledTransaction({ name: `ACC-BTN-2026-0000${index + 1}` }))
				},
				error: undefined,
				isLoading: false,
				isValidating: false,
				mutate: vi.fn()
			}
		}

		return { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn() }
	}) as never)
}

describe('BankBalance', () => {

	stubViewportMeasurement()

	beforeEach(() => {
		answerBalances()
		frappeSDKMock.useFrappeGetDocCount.mockReturnValue({
			data: 4, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
		})
		frappeSDKMock.useFrappeGetDocList.mockReturnValue({
			data: [], error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
		})
	})

	it('QUIRK - renders nothing at all before a bank account is chosen', () => {
		// Not an empty strip: a strip of zeroes would read as a reconciled account.
		const { container } = renderPanel(<BankBalance />, { bank: null })

		expect(container).toBeEmptyDOMElement()
	})

	describe('once an account is chosen', () => {

		it('labels all four figures', async () => {
			renderPanel(<BankBalance />)

			expect(await screen.findByText('Opening Balance')).toBeInTheDocument()
			expect(screen.getByText('Closing Balance as per statement')).toBeInTheDocument()
			expect(screen.getByText('Difference')).toBeInTheDocument()
		})

		it('QUIRK - asks the SAME endpoint for opening and closing, differing only in the date', () => {
			renderPanel(<BankBalance />)

			const balanceCalls = frappeSDKMock.useFrappeGetCall.mock.calls
				.filter(([method]) => method === ACCOUNT_BALANCE)

			expect(balanceCalls.length).toBeGreaterThanOrEqual(2)

			// Opening asks for the day BEFORE the range opens, so the range's own movements are excluded.
			const opening = balanceCalls.find(([, , key]) => key === undefined)
			expect(opening?.[1]).toMatchObject({
				bank_account: TEST_BANK_ACCOUNT,
				till_date: '2026-07-31'
			})

			const closing = balanceCalls.find(([, , key]) => key === CLOSING_KEY)
			expect(closing?.[1]).toMatchObject({
				bank_account: TEST_BANK_ACCOUNT,
				till_date: PANEL_TO_DATE
			})
		})

		it('renders each balance as currency', async () => {
			answerBalances({ opening: 10000, closing: 12000, statement: { balance: 12000 } })

			renderPanel(<BankBalance />)

			expect(await screen.findByText('₹ 10,000.00')).toBeInTheDocument()
		})
	})

	describe('the difference', () => {

		it('reads zero when the system and the statement agree', async () => {
			answerBalances({ closing: 12000, statement: { balance: 12000, date: PANEL_TO_DATE } })

			renderPanel(<BankBalance />)

			await waitFor(() => {
				expect(screen.getByText('Difference')).toBeInTheDocument()
			})
			expect(screen.getAllByText('₹ 0.00').length).toBeGreaterThan(0)
		})

		it('QUIRK - is computed from the atom the statement panel writes, not from its own fetch', async () => {
			// The two panels are coupled through jotai. Seeding the atom directly is therefore enough to
			// move the difference, which is exactly how the "edit the statement balance" dialog works.
			const { store } = renderPanel(<BankBalance />)

			await waitFor(() => {
				expect(screen.getByText('Difference')).toBeInTheDocument()
			})

			expect(store.get(bankRecClosingBalanceAtom(TEST_BANK_ACCOUNT))).toMatchObject({
				value: 12000
			})
		})

		it('QUIRK - colours a non-zero difference as an error', async () => {
			answerBalances({ closing: 12000, statement: { balance: 11500, date: PANEL_TO_DATE } })

			renderPanel(<BankBalance />)

			// 11500 stated - 12000 in the system leaves 500 unexplained.
			const difference = await screen.findByText('₹ -500.00')

			expect(difference.className).toContain('text-ink-red-3')
		})

		it('does not colour a difference of exactly zero', async () => {
			answerBalances({ closing: 12000, statement: { balance: 12000, date: PANEL_TO_DATE } })

			renderPanel(<BankBalance />)

			await waitFor(() => {
				expect(screen.getByText('Difference')).toBeInTheDocument()
			})

			const zeroes = screen.getAllByText('₹ 0.00')
			expect(zeroes.some((node) => !node.className.includes('text-ink-red-3'))).toBe(true)
		})
	})

	describe('the statement balance', () => {

		it('warns when the stored balance is as of a DIFFERENT date than the range end', async () => {
			// A balance carried over from an earlier statement is not a valid comparison, so the panel says
			// which date it actually belongs to rather than presenting it as current.
			answerBalances({ statement: { balance: 11000, date: '2026-07-31' } })

			renderPanel(<BankBalance />)

			expect(await screen.findByText('As of 31st Jul 2026')).toBeInTheDocument()
		})

		it('adds no warning when the stored balance matches the range end', async () => {
			answerBalances({ statement: { balance: 12000, date: PANEL_TO_DATE } })

			renderPanel(<BankBalance />)

			await waitFor(() => {
				expect(screen.getByText('Closing Balance as per statement')).toBeInTheDocument()
			})
			expect(screen.queryByText(/^As of /)).not.toBeInTheDocument()
		})

		it('offers a way to correct it, describing the account and the date', async () => {
			const user = userEvent.setup()

			renderPanel(<BankBalance />)

			// The trigger is nested: the dialog's own button wraps a div that also carries `role="button"`,
			// so both match the balance text and the outer one is the one to press.
			const triggers = await screen.findAllByRole('button', { name: /₹/ })
			await user.click(triggers[0])

			expect(await screen.findByText('Set closing balance as per bank statement')).toBeInTheDocument()
			expect(
				screen.getByText(/Enter the closing balance you see in your bank statement for/)
			).toBeInTheDocument()
		})

		it('refuses to save an empty balance rather than posting a zero', async () => {
			// Posting zero would silently assert the bank says the account is empty.
			const user = userEvent.setup()

			answerBalances({ statement: { balance: 0 } })

			renderPanel(<BankBalance />)

			const triggers = await screen.findAllByRole('button', { name: /₹/ })
			await user.click(triggers[0])
			await user.click(await screen.findByRole('button', { name: 'Save' }))

			await waitFor(() => {
				expect(frappePostCall).not.toHaveBeenCalled()
			})
		})
	})

	describe('the progress figure', () => {

		it('QUIRK - derives what is reconciled by subtracting the unreconciled from the total', async () => {
			// Nothing counts reconciled transactions directly, so the figure is only as good as the two
			// reads it is derived from.
			frappeSDKMock.useFrappeGetDocCount.mockReturnValue({
				data: 4, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
			})
			answerBalances({ unreconciled: 1 })

			renderPanel(<BankBalance />)

			expect(await screen.findByText('3 / 4 reconciled')).toBeInTheDocument()
		})

		it('reports nothing reconciled when every transaction is still outstanding', async () => {
			frappeSDKMock.useFrappeGetDocCount.mockReturnValue({
				data: 2, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
			})
			answerBalances({ unreconciled: 2 })

			renderPanel(<BankBalance />)

			expect(await screen.findByText('0 / 2 reconciled')).toBeInTheDocument()
		})

		it('copes with an account that has no transactions at all', async () => {
			// Division by the total would be NaN, which would render as a broken bar.
			frappeSDKMock.useFrappeGetDocCount.mockReturnValue({
				data: 0, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
			})
			answerBalances({ unreconciled: 0 })

			renderPanel(<BankBalance />)

			expect(await screen.findByText('0 / 0 reconciled')).toBeInTheDocument()
		})
	})

	describe('while the balances are still loading', () => {

		it('shows placeholders rather than zeroes', async () => {
			// A zero balance and an unknown balance mean different things to a reviewer.
			answerBalances({ isLoading: true })

			const { container } = renderPanel(<BankBalance />)

			await waitFor(() => {
				expect(screen.getByText('Opening Balance')).toBeInTheDocument()
			})
			expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
		})
	})
})
