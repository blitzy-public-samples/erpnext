/**
 * Behavioural specification for the bank-account picker at the top of the workbench.
 *
 * Nothing else on the reconciliation screen renders until this component has put an account into
 * `selectedBankAccountAtom`, so its auto-selection rules decide what a reviewer sees on first paint.
 *
 * Five behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. It AUTO-SELECTS: one account is chosen outright, and with several it prefers the company default,
 *      falling back to the first. A reviewer with one account therefore never picks anything.
 *   2. It will NOT overwrite an existing selection that is still present in the fetched list - which is
 *      what stops a re-fetch from moving the reviewer off the account they were working on.
 *   3. Conversely, if the persisted selection is ABSENT from the list it is replaced, because a selection
 *      the endpoint no longer returns cannot be reconciled against.
 *   4. While loading it renders a skeleton strip and announces itself busy, so a page that is merely
 *      waiting for data cannot be mistaken for a company with no bank accounts.
 *   5. Its empty state links out to the Desk with the company pre-filled, so the remedy is one click.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'

import {
	TEST_COMPANY,
	createFrappeSDKMock,
	frappeSDKMock,
	makeFrappeError
} from '@/test/factories'

/*
 * Declared before every module that transitively loads the SDK. `theme-provider` is one of them, so
 * importing it above this line puts it in the hoisted factory's initialisation path and the mock fails
 * with an uninitialised-binding error.
 */
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from '@/components/ui/theme-provider'
import BankPicker from './BankPicker'
import { selectedBankAccountAtom, type SelectedBank } from './bankRecAtoms'
import { makePanelBank } from '@/test/renderPanel'

const BANK_ACCOUNTS = 'erpnext.accounts.doctype.bank_account.bank_account.get_list'

const bank = (overrides: Partial<SelectedBank> = {}): SelectedBank =>
	makePanelBank({ ...overrides })

/**
 * Answers the account list. The real hook is given an `onLoadingSuccess` callback that performs the
 * auto-selection, so the double must invoke it or none of that behaviour runs.
 */
const answerAccounts = (accounts: SelectedBank[] | undefined, error: unknown = undefined, isLoading = false) => {
	frappeSDKMock.useFrappeGetCall.mockImplementation(((
		method: string,
		_params: unknown,
		_key: unknown,
		config: { onSuccess?: (data: unknown) => void } = {}
	) => {
		if (method === BANK_ACCOUNTS) {
			const data = accounts === undefined ? undefined : { message: accounts }
			if (data) config.onSuccess?.(data)
			return { data, error, isLoading, mutate: vi.fn() }
		}
		return { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn() }
	}) as never)
}

const renderPicker = (preselected: SelectedBank | null = null) => {
	const store = createStore()
	store.set(selectedBankAccountAtom, preselected)

	return {
		store,
		...render(
			<Provider store={store}>
				<ThemeProvider>
					<TooltipProvider>
						<MemoryRouter>
							<BankPicker />
						</MemoryRouter>
					</TooltipProvider>
				</ThemeProvider>
			</Provider>
		)
	}
}

describe('BankPicker', () => {

	beforeEach(() => {
		answerAccounts([bank()])
	})

	describe('while the accounts are loading', () => {

		it('says so, rather than rendering an empty page', async () => {
			/*
			 * The whole workbench is gated on the selection this strip makes, and the panels below withhold
			 * their tabs until an account is chosen - so rendering nothing here made a page that was merely
			 * waiting for data look like a company with no bank accounts at all. The busy state is
			 * announced as well as drawn, because the visible difference is skeletons versus cards.
			 */
			answerAccounts(undefined, undefined, true)

			renderPicker()

			expect(await screen.findByText('Loading bank accounts...')).toBeInTheDocument()
			expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
			// Still no cards and no empty state: nothing is asserted about the accounts yet.
			expect(screen.queryByRole('button')).not.toBeInTheDocument()
			expect(screen.queryByText('No bank accounts found')).not.toBeInTheDocument()
		})
	})

	describe('QUIRK - its auto-selection', () => {

		it('selects the only account outright, so a single-account reviewer never picks', async () => {
			const single = bank({ name: 'Only Account', account_name: 'Only Account' })
			answerAccounts([single])

			const { store } = renderPicker()

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)).toMatchObject({ name: 'Only Account' })
			})
		})

		it("prefers the company's default when several are available", async () => {
			answerAccounts([
				bank({ name: 'Current', account_name: 'Current', is_default: 0 }),
				bank({ name: 'Savings', account_name: 'Savings', is_default: 1 })
			])

			const { store } = renderPicker()

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)).toMatchObject({ name: 'Savings' })
			})
		})

		it('falls back to the first when none is marked default', async () => {
			answerAccounts([
				bank({ name: 'Current', account_name: 'Current', is_default: 0 }),
				bank({ name: 'Savings', account_name: 'Savings', is_default: 0 })
			])

			const { store } = renderPicker()

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)).toMatchObject({ name: 'Current' })
			})
		})

		it('QUIRK - leaves an existing selection alone when it is still in the list', async () => {
			// This is what stops a routine re-fetch from moving the reviewer off the account they are
			// part-way through reconciling.
			const current = bank({ name: 'Current', account_name: 'Current', is_default: 0 })
			const savings = bank({ name: 'Savings', account_name: 'Savings', is_default: 1 })
			answerAccounts([current, savings])

			const { store } = renderPicker(current)

			await waitFor(() => {
				expect(screen.getByText('Current')).toBeInTheDocument()
			})
			// The default is Savings, but Current was already chosen and is still offered.
			expect(store.get(selectedBankAccountAtom)).toMatchObject({ name: 'Current' })
		})

		it('QUIRK - replaces a selection the endpoint no longer returns', async () => {
			// A persisted selection can name an account that has since been disabled or reassigned, and a
			// transaction cannot be reconciled against one the endpoint will not serve.
			const stale = bank({ name: 'Closed Account', account_name: 'Closed Account' })
			const live = bank({ name: 'Current', account_name: 'Current' })
			answerAccounts([live])

			const { store } = renderPicker(stale)

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)).toMatchObject({ name: 'Current' })
			})
		})

		it('leaves the selection untouched when the list comes back empty', async () => {
			// An empty list is not evidence that the selection is wrong - it is evidence the read failed to
			// find anything, and clearing on it would strand a reviewer whose account was merely filtered.
			const current = bank({ name: 'Current', account_name: 'Current' })
			answerAccounts([])

			const { store } = renderPicker(current)

			await waitFor(() => {
				expect(screen.getByText('No bank accounts found')).toBeInTheDocument()
			})
			expect(store.get(selectedBankAccountAtom)).toMatchObject({ name: 'Current' })
		})
	})

	describe('the cards it renders', () => {

		it('names each account and its ledger account', async () => {
			answerAccounts([bank({ account_name: 'Setup Checking', account: '_Test Bank - _TC' })])

			renderPicker()

			expect(await screen.findByText('Setup Checking')).toBeInTheDocument()
			expect(screen.getByText('_Test Bank - _TC')).toBeInTheDocument()
		})

		it('offers each card as a control carrying its own hint', async () => {
			// The card is a `role="button"` div whose ACCESSIBLE NAME comes from its content, so the
			// "Select ..." hint lives in `title` and is queried as such.
			answerAccounts([bank({ account_name: 'Setup Checking' })])

			renderPicker()

			const card = await screen.findByTitle('Select Setup Checking')
			expect(card).toHaveAttribute('role', 'button')
		})

		it('badges the account type when the endpoint supplies one', async () => {
			answerAccounts([bank({ account_type: 'Savings' } as Partial<SelectedBank>)])

			renderPicker()

			expect(await screen.findByText('Savings')).toBeInTheDocument()
		})

		it('changes the selection when a different card is pressed', async () => {
			const user = userEvent.setup()
			answerAccounts([
				bank({ name: 'Current', account_name: 'Current' }),
				bank({ name: 'Savings', account_name: 'Savings' })
			])

			const { store } = renderPicker(bank({ name: 'Current', account_name: 'Current' }))

			await user.click(await screen.findByTitle('Select Savings'))

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)).toMatchObject({ name: 'Savings' })
			})
		})

		it('renders one card per account', async () => {
			answerAccounts([
				bank({ name: 'A', account_name: 'A' }),
				bank({ name: 'B', account_name: 'B' }),
				bank({ name: 'C', account_name: 'C' })
			])

			renderPicker()

			await screen.findByText('A')
			expect(screen.getAllByTitle(/^Select /)).toHaveLength(3)
		})
	})

	describe('choosing an account by keyboard', () => {

		/*
		 * The cards advertise `role="button"` to assistive technology, but a `div` gets no implicit
		 * keyboard activation from the browser: before this they carried no `tabIndex` and no key handler,
		 * so the account - which gates the entire workbench - could not be changed by keyboard at all.
		 */

		it('places every card in the tab order', async () => {
			answerAccounts([
				bank({ name: 'Current', account_name: 'Current' }),
				bank({ name: 'Savings', account_name: 'Savings' })
			])

			renderPicker()

			const cards = await screen.findAllByTitle(/^Select /)
			expect(cards).toHaveLength(2)
			for (const card of cards) {
				expect(card).toHaveAttribute('tabindex', '0')
			}
		})

		it('selects on Enter', async () => {
			const user = userEvent.setup()
			answerAccounts([
				bank({ name: 'Current', account_name: 'Current' }),
				bank({ name: 'Savings', account_name: 'Savings' })
			])

			const { store } = renderPicker(bank({ name: 'Current', account_name: 'Current' }))

			const savings = await screen.findByTitle('Select Savings')
			savings.focus()
			await user.keyboard('{Enter}')

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)).toMatchObject({ name: 'Savings' })
			})
		})

		it('selects on Space', async () => {
			const user = userEvent.setup()
			answerAccounts([
				bank({ name: 'Current', account_name: 'Current' }),
				bank({ name: 'Savings', account_name: 'Savings' })
			])

			const { store } = renderPicker(bank({ name: 'Current', account_name: 'Current' }))

			const savings = await screen.findByTitle('Select Savings')
			savings.focus()
			await user.keyboard(' ')

			await waitFor(() => {
				expect(store.get(selectedBankAccountAtom)).toMatchObject({ name: 'Savings' })
			})
		})

		it('ignores keys that are not activation keys', async () => {
			const user = userEvent.setup()
			answerAccounts([
				bank({ name: 'Current', account_name: 'Current' }),
				bank({ name: 'Savings', account_name: 'Savings' })
			])

			const { store } = renderPicker(bank({ name: 'Current', account_name: 'Current' }))

			const savings = await screen.findByTitle('Select Savings')
			savings.focus()
			await user.keyboard('{Escape}')
			await user.keyboard('a')

			expect(store.get(selectedBankAccountAtom)).toMatchObject({ name: 'Current' })
		})

		it('exposes which card is selected, rather than relying on colour alone', async () => {
			answerAccounts([
				bank({ name: 'Current', account_name: 'Current' }),
				bank({ name: 'Savings', account_name: 'Savings' })
			])

			renderPicker(bank({ name: 'Savings', account_name: 'Savings' }))

			expect(await screen.findByTitle('Select Savings')).toHaveAttribute('aria-pressed', 'true')
			expect(screen.getByTitle('Select Current')).toHaveAttribute('aria-pressed', 'false')
		})

		/**
		 * The reveal scroll, and the guard in front of it.
		 *
		 * The scroll itself is needed: the selection is persisted, so a reload can restore an account
		 * sitting outside the strip's visible scroll range, where it looked unselected.
		 *
		 * The guard is needed for a reason that has nothing to do with scrolling. Chrome moves the
		 * document's sequential-focus-navigation starting point to the target of a programmatic
		 * `scrollIntoView`, so calling it unconditionally on mount - which nearly always scrolled by zero
		 * pixels - moved the first Tab press to just after the selected card. Measured in the browser: the
		 * first Tab landed on the SECOND account card, skipping nine controls including the skip link and
		 * the whole header toolbar, which left the skip link unreachable by the one gesture it exists for.
		 *
		 * So both branches are specified: scroll when the card is genuinely out of view, and do nothing at
		 * all when it is already there.
		 */
		const stubStripGeometry = ({ cardVisible }: { cardVisible: boolean }) => {
			const original = HTMLElement.prototype.getBoundingClientRect

			HTMLElement.prototype.getBoundingClientRect = function () {
				const isCard = this.getAttribute('role') === 'button'
				const box = isCard
					// A card either sits inside the strip's 0-1000 range, or well past its trailing edge.
					? (cardVisible ? { left: 100, right: 340 } : { left: 1200, right: 1440 })
					: { left: 0, right: 1000 }

				return {
					...box,
					top: 0,
					bottom: 100,
					width: box.right - box.left,
					height: 100,
					x: box.left,
					y: 0,
					toJSON: () => ({})
				} as DOMRect
			}

			return () => {
				HTMLElement.prototype.getBoundingClientRect = original
			}
		}

		it('scrolls the selected card into view when it sits outside the strip', async () => {
			const scrollIntoView = vi.fn()
			const originalScroll = HTMLElement.prototype.scrollIntoView
			HTMLElement.prototype.scrollIntoView = scrollIntoView
			const restoreGeometry = stubStripGeometry({ cardVisible: false })

			try {
				answerAccounts([
					bank({ name: 'Current', account_name: 'Current' }),
					bank({ name: 'Savings', account_name: 'Savings' })
				])

				renderPicker(bank({ name: 'Savings', account_name: 'Savings' }))

				await screen.findByTitle('Select Savings')
				await waitFor(() => {
					expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
				})
				// Only the selected card asks to be revealed.
				expect(scrollIntoView).toHaveBeenCalledTimes(1)
			} finally {
				restoreGeometry()
				HTMLElement.prototype.scrollIntoView = originalScroll
			}
		})

		it('does NOT scroll when the selected card is already in view, so the tab order is left alone', async () => {
			const scrollIntoView = vi.fn()
			const originalScroll = HTMLElement.prototype.scrollIntoView
			HTMLElement.prototype.scrollIntoView = scrollIntoView
			const restoreGeometry = stubStripGeometry({ cardVisible: true })

			try {
				answerAccounts([
					bank({ name: 'Current', account_name: 'Current' }),
					bank({ name: 'Savings', account_name: 'Savings' })
				])

				renderPicker(bank({ name: 'Savings', account_name: 'Savings' }))

				await screen.findByTitle('Select Savings')
				expect(screen.getByTitle('Select Savings')).toHaveAttribute('aria-pressed', 'true')
				expect(scrollIntoView).not.toHaveBeenCalled()
			} finally {
				restoreGeometry()
				HTMLElement.prototype.scrollIntoView = originalScroll
			}
		})
	})

	describe('QUIRK - when the company has no bank accounts', () => {

		it('explains why and links out with the company already filled in', async () => {
			answerAccounts([])

			renderPicker()

			expect(await screen.findByText('No bank accounts found')).toBeInTheDocument()
			expect(
				screen.getByText('You have not added any bank accounts to your company.')
			).toBeInTheDocument()

			const remedy = screen.getByRole('link', { name: 'Configure Bank Accounts' })
			expect(remedy).toHaveAttribute(
				'href',
				`/desk/bank-account?company=${encodeURIComponent(TEST_COMPANY)}&is_company_account=1`
			)
		})
	})

	describe('when the account list cannot be read', () => {

		it("surfaces the server's own message instead of an empty picker", async () => {
			answerAccounts(undefined, makeFrappeError({
				_server_messages: JSON.stringify([
					JSON.stringify({ message: 'Insufficient Permission for Bank Account', indicator: 'red' })
				])
			}))

			renderPicker()

			await waitFor(() => {
				expect(screen.getByText('Insufficient Permission for Bank Account')).toBeInTheDocument()
			})
			expect(screen.queryByText('No bank accounts found')).not.toBeInTheDocument()
		})
	})

	describe('the request it makes', () => {

		it('asks for the accounts of the current company', () => {
			renderPicker()

			const call = frappeSDKMock.useFrappeGetCall.mock.calls
				.find(([method]) => method === BANK_ACCOUNTS)

			expect(call?.[1]).toMatchObject({ company: TEST_COMPANY })
		})

		/*
		 * The strip asks for accounts and NOTHING ELSE.
		 *
		 * Every card used to call `useGetUnreconciledTransactions()` for its `mutate` alone, which is a
		 * query hook: calling it subscribes to the workbench's transaction key and therefore fetches it -
		 * once per card. This strip is also mounted on the statement importer route, where that list is
		 * never rendered, so merely opening the importer pulled roughly 40KB of transactions down several
		 * times over to reach a function that only needed to invalidate a cache entry.
		 */
		it('issues no transaction query, because a card only needs to INVALIDATE one', () => {
			renderPicker()

			const transactionCalls = frappeSDKMock.useFrappeGetCall.mock.calls
				.filter(([method]) => String(method).endsWith('get_bank_transactions'))

			expect(transactionCalls).toHaveLength(0)
		})

		it('QUIRK - declares NO explicit cache key, so SWR derives one from the arguments', () => {
			// Unlike the transaction and report reads, this one is left to SWR's own key derivation. That is
			// why every consumer that passes the same company shares one entry without coordinating a
			// string, and why changing the company refetches without any key plumbing.
			renderPicker()

			const call = frappeSDKMock.useFrappeGetCall.mock.calls
				.find(([method]) => method === BANK_ACCOUNTS)

			expect(call?.[2]).toBeUndefined()
			expect(call?.[1]).toMatchObject({ company: TEST_COMPANY })
		})
	})
})
