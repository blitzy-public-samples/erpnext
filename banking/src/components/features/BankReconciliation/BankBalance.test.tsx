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
 *
 * Two presentation rules are load-bearing rather than cosmetic and are pinned alongside them: the
 * difference names its state in WORDS (surplus / shortfall / balanced) rather than relying on colour, and
 * announces it once through a live region; and the progress bar is determinate, so it exposes the figure
 * it is drawing rather than reporting itself as indeterminate.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
	TEST_BANK_ACCOUNT,
	createFrappeSDKMock,
	frappeContextValue,
	frappePostCall,
	frappeSDKMock,
	frappeSWRMutate,
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
	/**
	 * Leaves the outstanding-transaction read UNANSWERED - `data` undefined with `isLoading` set - which
	 * is the state the progress figure must withhold itself in rather than treat as "none outstanding".
	 */
	unreconciledPending?: boolean
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
	isLoading = false,
	unreconciledPending = false
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
			if (unreconciledPending) {
				return { data: undefined, error: undefined, isLoading: true, isValidating: true, mutate: vi.fn() }
			}
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

		/**
		 * The strip was a `w-[80%]` wrapping flex row with `justify-between`, which is the one
		 * combination that guarantees a void. Once the longest label pushed a stat onto a second line,
		 * `justify-between` shoved the remaining items to opposite ends of an 800px row with nothing
		 * between them; at 1920 the same rule spread four ~190px stats across a 1500px track. Both were
		 * reported as large empty areas in the middle of the most-read part of the screen.
		 *
		 * A grid removes the failure mode rather than tuning it: equal tracks cannot be spread apart, and
		 * the reflow happens on a breakpoint instead of on whatever the longest translated label measures.
		 */
		it('lays the four figures out on a grid that reflows on a breakpoint', async () => {
			renderPanel(<BankBalance />)

			const label = await screen.findByText('Opening Balance')
			const strip = label.closest('.grid')

			expect(strip).not.toBeNull()
			// Two columns by default, four from `xl` up.
			expect(strip!.className).toContain('grid-cols-2')
			expect(strip!.className).toContain('xl:grid-cols-4')
			// The two rules that produced the void.
			expect(strip!.className).not.toContain('justify-between')
			expect(strip!.className).not.toContain('flex-wrap')
			expect(strip!.className).not.toContain('w-[80%]')
		})

		/**
		 * The progress bar was `w-[18%]`: 184px at 1024, too narrow for its own "x / y reconciled" hint,
		 * and 345px at 1920, which is where the trailing gap in the strip came from.
		 */
		it('gives the progress bar a definite width rather than a percentage', async () => {
			renderPanel(<BankBalance />)

			const bar = await screen.findByRole('progressbar', { name: 'Reconciliation progress' })
			const column = bar.closest('.shrink-0')

			expect(column).not.toBeNull()
			expect(column!.className).toContain('w-64')
			expect(column!.className).not.toContain('w-[18%]')
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

		it('names a shortfall in words, not only in red', async () => {
			/*
			 * A surplus and a shortfall were rendered in the identical red and a balanced account differed
			 * only in being grey, so the tile carried three meanings in two colours and named none of them.
			 */
			answerBalances({ closing: 12000, statement: { balance: 11500, date: PANEL_TO_DATE } })

			renderPanel(<BankBalance />)

			expect(await screen.findByText('Shortfall')).toBeInTheDocument()
			expect(screen.queryByText('Surplus')).not.toBeInTheDocument()
			expect(screen.queryByText('Balanced')).not.toBeInTheDocument()
		})

		it('names a surplus, which used to look exactly like a shortfall', async () => {
			answerBalances({ closing: 11500, statement: { balance: 12000, date: PANEL_TO_DATE } })

			renderPanel(<BankBalance />)

			expect(await screen.findByText('Surplus')).toBeInTheDocument()
			expect(screen.queryByText('Shortfall')).not.toBeInTheDocument()
		})

		it('says a balanced account is balanced, rather than leaving a bare zero to be inferred', async () => {
			answerBalances({ closing: 12000, statement: { balance: 12000, date: PANEL_TO_DATE } })

			renderPanel(<BankBalance />)

			expect(await screen.findByText('Balanced')).toBeInTheDocument()
		})

		it('calls an account balanced to the last paisa balanced, whatever residue the sum carries', async () => {
			/*
			 * The system's closing balance is a sum of ledger amounts, so a fully reconciled account can
			 * answer 7.275957614183426e-12 instead of 0. The state used to be decided on that unrounded
			 * figure, so the tile displayed zero while calling it a shortfall and colouring it red.
			 */
			answerBalances({
				closing: 7.275957614183426e-12,
				statement: { balance: 0, date: PANEL_TO_DATE }
			})

			renderPanel(<BankBalance />)

			expect(await screen.findByText('Balanced')).toBeInTheDocument()
			expect(screen.queryByText('Shortfall')).not.toBeInTheDocument()

			const zero = screen.getAllByText('₹ 0.00').find((node) => node.className.includes('font-numeric'))
			expect(zero).toBeDefined()
			expect(zero?.className).not.toContain('text-ink-red-3')
		})

		it('announces the figure and its state once, through a live region', async () => {
			/*
			 * One sentence, with the visual figure and word hidden from assistive technology, so a change
			 * is announced in full rather than as a bare number read twice.
			 */
			answerBalances({ closing: 12000, statement: { balance: 11500, date: PANEL_TO_DATE } })

			renderPanel(<BankBalance />)

			const live = await screen.findByRole('status')

			expect(live).toHaveAttribute('aria-live', 'polite')
			// A live region announces its CONTENT rather than its name, so the sentence lives inside it.
			expect(live).toHaveTextContent(
				'Difference ₹ -500.00, a shortfall against the closing balance as per system.'
			)
			// And the figure and the word are hidden from assistive technology, so nothing is read twice.
			expect(screen.getByText('₹ -500.00').closest('[aria-hidden="true"]')).not.toBeNull()
			expect(screen.getByText('Shortfall').closest('[aria-hidden="true"]')).not.toBeNull()
			// The sentence itself is NOT hidden - it is the thing that gets announced.
			expect(
				screen.getByText('Difference ₹ -500.00, a shortfall against the closing balance as per system.')
					.closest('[aria-hidden="true"]')
			).toBeNull()
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

		it('saves a zero balance, because a statement can genuinely close at zero', async () => {
			/*
			 * The guard here used to be `if (data.balance)`, which is falsy for 0: a reviewer whose
			 * statement closed at zero was told the balance was "required", no request was sent, and there
			 * was no way to record it at all - while the difference tile went on comparing against a value
			 * that could not be entered.
			 */
			const user = userEvent.setup()

			frappePostCall.mockResolvedValue({ message: 'ok' })
			answerBalances({ statement: { balance: 0 } })

			renderPanel(<BankBalance />)

			const triggers = await screen.findAllByRole('button', { name: /₹/ })
			await user.click(triggers[0])
			await user.click(await screen.findByRole('button', { name: 'Save' }))

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledWith(expect.objectContaining({
					bank_account: TEST_BANK_ACCOUNT,
					date: PANEL_TO_DATE,
					balance: 0
				}))
			})
		})

		it('refuses to save when the field has been emptied, because that is no figure at all', async () => {
			// The distinction the fix turns on: zero is a balance, an empty field is a missing one.
			const user = userEvent.setup()

			answerBalances({ statement: { balance: 12000 } })

			renderPanel(<BankBalance />)

			const triggers = await screen.findAllByRole('button', { name: /₹/ })
			await user.click(triggers[0])

			const field = await screen.findByRole('textbox')
			await user.clear(field)
			await user.click(await screen.findByRole('button', { name: 'Save' }))

			await waitFor(() => {
				expect(frappePostCall).not.toHaveBeenCalled()
			})
		})

		it('saves a negative balance with its sign intact, because an account can be overdrawn', async () => {
			/*
			 * Typing past the decimal point is the part that broke: the field is controlled by what this
			 * handler stores, so storing the parsed number for `-250.` echoed `-250` back, swallowed the
			 * separator, and sent the final digit into the units - saving -25050 for -250.50.
			 */
			/*
			 * A gap between events, because the field is CONTROLLED: each character is echoed back through
			 * React before the next one is composed, and with no gap a keystroke can be built on a value
			 * React has not re-rendered yet and be lost. That is a race in the harness rather than in the
			 * product - it appeared only under the slower coverage run - and the gap removes it.
			 */
			const user = userEvent.setup({ delay: 20 })

			frappePostCall.mockResolvedValue({ message: 'ok' })
			answerBalances({ statement: { balance: 12000 } })

			renderPanel(<BankBalance />)

			const triggers = await screen.findAllByRole('button', { name: /₹/ })
			await user.click(triggers[0])

			const field = await screen.findByRole('textbox')
			await user.clear(field)
			await user.type(field, '-250.50')
			await user.click(await screen.findByRole('button', { name: 'Save' }))

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledWith(expect.objectContaining({ balance: -250.5 }))
			})
		})
	})

	describe('deleting a saved statement balance', () => {

		const STATEMENT_KEY =
			`bank-reconciliation-account-closing-balance-as-per-statement-${TEST_BANK_ACCOUNT}-${PANEL_TO_DATE}`

		it('re-reads the statement balance, so the tiles do not keep the figure that was just removed', async () => {
			/*
			 * Deletion used to refresh only the table it was performed in. The tile and the Difference beside
			 * it went on showing the deleted balance until the page was reloaded, which reads as a
			 * reconciliation gap that no longer exists.
			 */
			const user = userEvent.setup()

			frappeSDKMock.useFrappeGetDocList.mockReturnValue({
				data: [{ name: 'bab-1', date: PANEL_TO_DATE, balance: 12000 }],
				error: undefined,
				isLoading: false,
				isValidating: false,
				mutate: vi.fn()
			} as never)
			frappeContextValue.db.deleteDoc.mockResolvedValue({ message: 'ok' } as never)
			answerBalances({ statement: { balance: 12000, date: PANEL_TO_DATE } })

			renderPanel(<BankBalance />)

			const triggers = await screen.findAllByRole('button', { name: /₹/ })
			await user.click(triggers[0])

			await user.click(await screen.findByRole('button', { name: 'Delete' }))

			await waitFor(() => {
				expect(frappeContextValue.db.deleteDoc).toHaveBeenCalledWith('Bank Account Balance', 'bab-1')
			})
			await waitFor(() => {
				expect(frappeSWRMutate).toHaveBeenCalledWith(STATEMENT_KEY)
			})
		})

		it('adopts a zero from the server, which is what it answers once no balance is left', async () => {
			/*
			 * The success handler used to test the balance for truthiness, so the `{balance: 0}` the endpoint
			 * returns when no row remains was discarded and the atom - and therefore the Difference - kept
			 * the deleted figure. Zero is an answer, not the absence of one.
			 */
			answerBalances({ closing: 12000, statement: { balance: 0, date: undefined } })

			const { store } = renderPanel(<BankBalance />)

			await waitFor(() => {
				expect(store.get(bankRecClosingBalanceAtom(TEST_BANK_ACCOUNT))).toMatchObject({ value: 0 })
			})
			// 0 stated against 12,000 in the system is the whole balance outstanding, as a shortfall.
			expect(await screen.findByText('₹ -12,000.00')).toBeInTheDocument()
			expect(screen.getByText('Shortfall')).toBeInTheDocument()
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

		it('exposes the figure it is drawing, rather than reporting itself as indeterminate', async () => {
			/*
			 * The primitive was handed a label and a hint but never the VALUE: every bar in the application
			 * rendered `data-state="indeterminate"` with no `aria-valuenow`, so a screen reader was told a
			 * known figure - here 3 of 4 - was simply loading.
			 */
			frappeSDKMock.useFrappeGetDocCount.mockReturnValue({
				data: 4, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
			})
			answerBalances({ unreconciled: 1 })

			renderPanel(<BankBalance />)

			const bar = await screen.findByRole('progressbar')

			expect(bar).toHaveAttribute('data-state', 'loading')
			expect(bar).toHaveAttribute('aria-valuenow', '75')
			expect(bar).toHaveAttribute('aria-valuemax', '100')
			expect(bar).toHaveAccessibleName('Reconciliation progress')
			// The spoken value is the same wording a sighted reviewer reads beside the bar.
			expect(bar).toHaveAttribute('aria-valuetext', '3 / 4 reconciled')
		})

		it('shows no figure at all while the total is still being counted', async () => {
			/*
			 * Rather than "0 / undefined reconciled", which is what interpolating a missing total produced.
			 *
			 * This case is pinned on the ABSENCE of a figure rather than on a stand-in caption. An earlier
			 * fix for the same defect kept the bar up and swapped the figures for a "Counting
			 * transactions..." hint; that removes the literal "undefined", but leaves a determinate bar
			 * reporting a `value` derived from only one of the two reads - it asserts "0% reconciled" when
			 * the truth is not yet known. The behaviour that ships withholds the whole widget instead, so
			 * what this test guarantees is that neither a number nor a percentage is put in front of the
			 * reviewer while the pair is incomplete. `isValidating: false` is the point of this case: it is
			 * the same in-flight state as the one below, reached without the revalidation flag set.
			 */
			frappeSDKMock.useFrappeGetDocCount.mockReturnValue({
				data: undefined, error: undefined, isLoading: true, isValidating: false, mutate: vi.fn()
			})
			answerBalances({ unreconciled: 0 })

			const { container } = renderPanel(<BankBalance />)

			await waitFor(() => {
				expect(screen.getByText('Opening Balance')).toBeInTheDocument()
			})
			expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
			expect(screen.queryByText(/reconciled/)).not.toBeInTheDocument()
			expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
			expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1)
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

		it('withholds the figure behind a placeholder while the transaction COUNT is in flight', async () => {
			// The subtraction has only one of its two operands here, and half a subtraction is not an
			// approximation: it reported "-1 / undefined reconciled" to the reviewer AND to the
			// accessibility tree, so neither number may be shown at all until both reads have answered.
			frappeSDKMock.useFrappeGetDocCount.mockReturnValue({
				data: undefined, error: undefined, isLoading: true, isValidating: true, mutate: vi.fn()
			})
			answerBalances({ unreconciled: 1 })

			const { container } = renderPanel(<BankBalance />)

			await waitFor(() => {
				expect(screen.getByText('Opening Balance')).toBeInTheDocument()
			})
			expect(screen.queryByText('Progress')).not.toBeInTheDocument()
			expect(screen.queryByText(/reconciled/)).not.toBeInTheDocument()
			expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
			expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1)
		})

		it('withholds it too when the count has answered but the outstanding list has NOT', async () => {
			// The other half of the same pair. Treating an unanswered list as "none outstanding" would
			// report a fully reconciled period to a reviewer who is looking at an unread one.
			frappeSDKMock.useFrappeGetDocCount.mockReturnValue({
				data: 4, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
			})
			answerBalances({ unreconciledPending: true })

			const { container } = renderPanel(<BankBalance />)

			await waitFor(() => {
				expect(screen.getByText('Opening Balance')).toBeInTheDocument()
			})
			expect(screen.queryByText(/reconciled/)).not.toBeInTheDocument()
			expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1)
		})

		it('QUIRK - withholds it when a read reports NOT loading while still carrying no data', async () => {
			// SWR reports `isLoading: false` for a key it has not resolved yet, so the load flags alone
			// would let the raw `undefined` through; the figures are gated on the DATA as well.
			frappeSDKMock.useFrappeGetDocCount.mockReturnValue({
				data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
			})
			answerBalances({ unreconciled: 3 })

			const { container } = renderPanel(<BankBalance />)

			await waitFor(() => {
				expect(screen.getByText('Opening Balance')).toBeInTheDocument()
			})
			expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
			expect(screen.queryByText(/-3/)).not.toBeInTheDocument()
			expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1)
		})

		it('floors the figure at zero when the two reads disagree about the same period', async () => {
			// They are independent queries over different filter sets, so the outstanding list can be
			// longer than the count. A negative count of reconciled transactions is never a true
			// statement about a bank account, so it is floored rather than rendered.
			frappeSDKMock.useFrappeGetDocCount.mockReturnValue({
				data: 1, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
			})
			answerBalances({ unreconciled: 4 })

			renderPanel(<BankBalance />)

			expect(await screen.findByText('0 / 1 reconciled')).toBeInTheDocument()
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
