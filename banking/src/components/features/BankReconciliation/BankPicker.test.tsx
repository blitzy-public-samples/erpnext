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
 *   4. It renders NOTHING while loading rather than a spinner, because the whole page is gated on it.
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

	describe('QUIRK - while the accounts are loading', () => {

		it('renders nothing at all rather than a placeholder', () => {
			// The entire workbench is gated on the selection this makes, so a skeleton here would imply the
			// page below it is merely waiting for data when in fact it cannot render at all yet.
			answerAccounts(undefined, undefined, true)

			const { container } = renderPicker()

			expect(container).toBeEmptyDOMElement()
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
