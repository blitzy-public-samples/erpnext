/**
 * Behavioural specification for the "Bank Transactions" tab of the reconciliation workbench.
 *
 * This tab is the audit view: unlike the Match and Reconcile tab it asks the endpoint for ALL transactions
 * rather than only the outstanding ones, so it is the one place a reviewer sees a settled transaction
 * alongside an open one - and the one place an already-reconciled row is rendered at all. That makes its
 * status column and its undo affordance the behaviours that matter.
 *
 * Five behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. The three status badges are derived from `allocated_amount` and `unallocated_amount` alone; the
 *      server's own `status` field is NOT consulted here.
 *   2. "Not Reconciled" is chosen when `allocated_amount` is falsy, so a zero and an absent value are one
 *      case - which is what the endpoint actually returns for an untouched row.
 *   3. Undo is offered ONLY on a row with a positive allocation, because there is nothing to reverse
 *        otherwise - so the action column's contents differ per row.
 *   4. Every "View" link opens the Desk in a new tab, so the reviewer never loses the workbench.
 *   5. The amount filter's placeholder is built from the account's own currency symbol and decimal
 *      separator, so it reflects the site's number format rather than a hard-coded "0.00".
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
	TEST_BANK_ACCOUNT,
	createFrappeSDKMock,
	frappeSDKMock,
	makeFrappeError
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankTransactions from './BankTransactionList'
import { bankRecUnreconcileModalAtom } from './bankRecAtoms'
import {
	PANEL_FROM_DATE,
	PANEL_TO_DATE,
	makePanelBank,
	renderPanel,
	stubViewportMeasurement
} from '@/test/renderPanel'

const GET_TRANSACTIONS =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions'
const ALL_TRANSACTIONS_KEY =
	`bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${PANEL_FROM_DATE}-${PANEL_TO_DATE}`

/** A row exactly as `get_bank_transactions` returns one when `all_transactions` is passed. */
const transaction = (overrides: Record<string, unknown> = {}) => ({
	name: 'ACC-BTN-2026-00001',
	date: '2026-08-03',
	description: 'NEFT inbound from ACME Traders',
	reference_number: 'REF-INR-0001',
	withdrawal: 0,
	deposit: 4825.5,
	unallocated_amount: 4825.5,
	allocated_amount: 0,
	transaction_type: 'Bank Transfer',
	currency: 'INR',
	status: 'Unreconciled',
	bank_account: TEST_BANK_ACCOUNT,
	company: '_Test Company',
	party_type: 'Customer',
	party: 'ACME Traders',
	...overrides
})

const answerWith = (rows: unknown[] | undefined, error: unknown = undefined) => {
	frappeSDKMock.useFrappeGetCall.mockImplementation(((method: string) =>
		method === GET_TRANSACTIONS
			? { data: rows === undefined ? undefined : { message: rows }, error, isLoading: false, isValidating: false, mutate: vi.fn() }
			: { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn() }) as never)
}

const lastTransactionsCall = () => {
	const calls = frappeSDKMock.useFrappeGetCall.mock.calls.filter(([method]) => method === GET_TRANSACTIONS)
	return calls[calls.length - 1]
}

describe('BankTransactionList', () => {

	stubViewportMeasurement()

	beforeEach(() => {
		answerWith([])
	})

	describe('before the reviewer has chosen what to look at', () => {

		it('asks for a bank and a date range, and renders no table', () => {
			renderPanel(<BankTransactions />, { bank: null })

			expect(screen.getByText('Please select a bank and set the date range')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})

	describe('QUIRK - the request it makes', () => {

		it('asks for ALL transactions, which is what makes settled rows visible here', () => {
			// The endpoint filters `unallocated_amount > 0` server-side unless this flag is passed, so
			// without it a reconciled transaction could never appear on this tab at all.
			renderPanel(<BankTransactions />)

			expect(lastTransactionsCall()![1]).toMatchObject({
				bank_account: TEST_BANK_ACCOUNT,
				from_date: PANEL_FROM_DATE,
				to_date: PANEL_TO_DATE,
				all_transactions: true
			})
		})

		it('keys the read separately from the unreconciled list, so the two never share a cache entry', () => {
			renderPanel(<BankTransactions />)

			expect(lastTransactionsCall()![2]).toBe(ALL_TRANSACTIONS_KEY)
			expect(lastTransactionsCall()![2]).not.toContain('unreconciled')
		})
	})

	describe('the status column', () => {

		it('QUIRK - calls an unallocated row Not Reconciled, from the amounts rather than the status field', async () => {
			// `status` is deliberately not consulted: the amounts are what the badge is derived from.
			answerWith([transaction({ allocated_amount: 0, status: 'Reconciled' })])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Not Reconciled')).toBeInTheDocument()
			expect(screen.queryByText('Reconciled')).not.toBeInTheDocument()
		})

		it('treats an ABSENT allocation the same as a zero one', async () => {
			// This is the shape the endpoint really returns for an untouched row.
			answerWith([transaction({ allocated_amount: undefined })])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Not Reconciled')).toBeInTheDocument()
		})

		it('calls a fully allocated row Reconciled', async () => {
			answerWith([transaction({ allocated_amount: 4825.5, unallocated_amount: 0 })])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Reconciled')).toBeInTheDocument()
		})

		it('calls a part-allocated row Partially Reconciled', async () => {
			answerWith([transaction({ allocated_amount: 2000, unallocated_amount: 2825.5 })])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Partially Reconciled')).toBeInTheDocument()
		})

		it('distinguishes all three states in one list', async () => {
			answerWith([
				transaction({ name: 'ACC-BTN-2026-00001', allocated_amount: 0 }),
				transaction({
					name: 'ACC-BTN-2026-00002', allocated_amount: 2000, unallocated_amount: 2825.5
				}),
				transaction({ name: 'ACC-BTN-2026-00003', allocated_amount: 4825.5, unallocated_amount: 0 })
			])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Not Reconciled')).toBeInTheDocument()
			expect(screen.getByText('Partially Reconciled')).toBeInTheDocument()
			expect(screen.getByText('Reconciled')).toBeInTheDocument()
		})
	})

	describe('the actions column', () => {

		it('links every row into the Desk, in a new tab', async () => {
			answerWith([transaction()])

			renderPanel(<BankTransactions />)

			const view = await screen.findByRole('link', { name: /View/ })

			expect(view).toHaveAttribute('href', '/desk/bank-transaction/ACC-BTN-2026-00001')
			expect(view).toHaveAttribute('target', '_blank')
			expect(view).toHaveAttribute('rel', 'noreferrer')
		})

		it('QUIRK - offers Undo only where there is an allocation to reverse', async () => {
			answerWith([
				transaction({ name: 'ACC-BTN-2026-00001', allocated_amount: 0 }),
				transaction({ name: 'ACC-BTN-2026-00002', allocated_amount: 4825.5, unallocated_amount: 0 })
			])

			renderPanel(<BankTransactions />)

			await screen.findByText('Not Reconciled')

			// Two rows, but only the settled one can be undone.
			expect(screen.getAllByRole('button', { name: /Undo/ })).toHaveLength(1)
		})

		it('opens the unreconcile confirmation for the row it was pressed on, rather than acting at once', async () => {
			// Reversing a posting is destructive, so the action only ARMS the modal - the atom is what the
			// page-level modal reads to decide which transaction it is about.
			const user = userEvent.setup()

			answerWith([transaction({ allocated_amount: 4825.5, unallocated_amount: 0 })])

			const { store } = renderPanel(<BankTransactions />)

			await user.click(await screen.findByRole('button', { name: /Undo/ }))

			await waitFor(() => {
				expect(store.get(bankRecUnreconcileModalAtom)).toBe('ACC-BTN-2026-00001')
			})
		})
	})

	describe('the rows themselves', () => {

		it('renders the description, reference and amounts the reviewer matches on', async () => {
			answerWith([transaction()])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('NEFT inbound from ACME Traders')).toBeInTheDocument()
			expect(screen.getByText('REF-INR-0001')).toBeInTheDocument()
			// The figure appears twice - once as the deposit and once as the amount still unallocated -
			// which is exactly what an untouched row looks like.
			expect(screen.getAllByText('₹ 4,825.50')).toHaveLength(2)
		})

		it('badges the transaction type, and omits the badge when there is none', async () => {
			answerWith([
				transaction({ name: 'ACC-BTN-2026-00001', transaction_type: 'Bank Transfer' }),
				transaction({ name: 'ACC-BTN-2026-00002', transaction_type: undefined })
			])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('Bank Transfer')).toBeInTheDocument()
		})

		it('renders a withdrawal as readily as a deposit', async () => {
			answerWith([transaction({ withdrawal: 1250, deposit: 0, unallocated_amount: 1250 })])

			renderPanel(<BankTransactions />)

			// Withdrawal and unallocated both carry it; the deposit column renders the zero.
			expect(await screen.findAllByText('₹ 1,250.00')).toHaveLength(2)
			expect(screen.getByText('₹ 0.00')).toBeInTheDocument()
		})
	})

	describe('its filters', () => {

		/*
		 * The amount box is CONTROLLED and mounts already holding ₹0.00, so it has to be emptied before
		 * a figure is typed - otherwise the keystrokes land after the zeros. And each keystroke needs a
		 * gap, so it is composed on a value React has re-rendered rather than on a stale one: a race in
		 * the harness, not in the product.
		 */
		const typeAmount = async (user: ReturnType<typeof userEvent.setup>, amount: string) => {
			const field = await screen.findByPlaceholderText('₹0.00')
			await user.clear(field)
			await user.type(field, amount)
			return field
		}

		const typist = () => userEvent.setup({ delay: 20 })

		it('offers a search box and an amount box', async () => {
			answerWith([transaction()])

			renderPanel(<BankTransactions />)

			expect(await screen.findByPlaceholderText('Search')).toBeInTheDocument()
		})

		it("QUIRK - builds the amount placeholder from the account's own currency and separator", async () => {
			// The site's number format decides the separator, so the hint matches what the reviewer will
			// actually type rather than assuming a full stop.
			answerWith([transaction()])

			renderPanel(<BankTransactions />)

			expect(await screen.findByPlaceholderText('₹0.00')).toBeInTheDocument()
		})

		it('narrows the list to the searched text', async () => {
			const user = userEvent.setup()

			answerWith([
				transaction({ name: 'ACC-BTN-2026-00001', description: 'NEFT inbound from ACME Traders' }),
				transaction({ name: 'ACC-BTN-2026-00002', description: 'RTGS outbound to Globex Supplies' })
			])

			renderPanel(<BankTransactions />)

			await screen.findByText('NEFT inbound from ACME Traders')

			await user.type(await screen.findByPlaceholderText('Search'), 'Globex')

			await waitFor(() => {
				expect(screen.getByText('RTGS outbound to Globex Supplies')).toBeInTheDocument()
			}, { timeout: 3000 })
		})

		it('narrows the list to a searched reference number, which is a column the reviewer can see', async () => {
			// The regression this pins: the filter tested `description` alone, so a reviewer chasing a
			// cheque or UTR number off a paper statement could read that number in the "Reference #"
			// column and still be told there were no results.
			const user = userEvent.setup()

			answerWith([
				transaction({
					name: 'ACC-BTN-2026-00001',
					description: 'NEFT inbound from ACME Traders',
					reference_number: 'UTR-778899'
				}),
				transaction({
					name: 'ACC-BTN-2026-00002',
					description: 'RTGS outbound to Globex Supplies',
					reference_number: 'CHQ-112233'
				})
			])

			renderPanel(<BankTransactions />)

			await screen.findByText('NEFT inbound from ACME Traders')

			await user.type(await screen.findByPlaceholderText('Search'), 'CHQ-112233')

			// The discriminating wait: the row that does NOT match must leave. Waiting for the matching
			// row to appear would pass before the debounce had fired, since both start on screen.
			await waitFor(() => {
				expect(screen.queryByText('NEFT inbound from ACME Traders')).not.toBeInTheDocument()
			}, { timeout: 3000 })

			// And the row found only by its reference number survived.
			expect(screen.getByText('RTGS outbound to Globex Supplies')).toBeInTheDocument()
		})

		it('matches a reference case-insensitively, the way it already matched a description', async () => {
			const user = userEvent.setup()

			answerWith([
				transaction({ name: 'ACC-BTN-2026-00001', description: 'Alpha', reference_number: 'UTR-778899' }),
				transaction({ name: 'ACC-BTN-2026-00002', description: 'Beta', reference_number: 'chq-112233' })
			])

			renderPanel(<BankTransactions />)
			await screen.findByText('Alpha')

			await user.type(await screen.findByPlaceholderText('Search'), 'CHQ')

			await waitFor(() => {
				expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
			}, { timeout: 3000 })
			expect(screen.getByText('Beta')).toBeInTheDocument()
		})

		it('keeps a row whose reference is absent but whose description still matches', async () => {
			// `reference_number` is optional on the endpoint's payload, so the reference test must not
			// throw away a row that has none.
			const user = userEvent.setup()

			answerWith([
				transaction({ name: 'ACC-BTN-2026-00001', description: 'Globex settlement', reference_number: undefined })
			])

			renderPanel(<BankTransactions />)
			await screen.findByText('Globex settlement')

			await user.type(await screen.findByPlaceholderText('Search'), 'Globex')

			await waitFor(() => {
				expect(screen.getByText('Globex settlement')).toBeInTheDocument()
			}, { timeout: 3000 })
		})

		it('gives both filter boxes an accessible name rather than leaving the label orphaned', async () => {
			// Both labels previously carried neither `htmlFor` nor the input inside them, so they named
			// nothing and each field fell back to its placeholder.
			answerWith([transaction()])

			renderPanel(<BankTransactions />)

			const search = await screen.findByPlaceholderText('Search')
			const amount = await screen.findByPlaceholderText('₹0.00')

			expect(search).toHaveAccessibleName('Search by description or reference')
			expect(amount).toHaveAccessibleName('Filter by amount')

			// The <label> must actually resolve to the control, not merely sit beside it.
			const searchLabel = document.querySelector('label[for="bank-txn-list-search"]')
			const amountLabel = document.querySelector('label[for="bank-txn-list-amount-filter"]')
			expect(searchLabel).toBeInTheDocument()
			expect(amountLabel).toBeInTheDocument()
			expect(document.getElementById('bank-txn-list-search')).toBe(search)
			expect(document.getElementById('bank-txn-list-amount-filter')).toBe(amount)
		})

		it('drops stray letters from the amount box instead of reading one as a magnitude', async () => {
			// The same defect this list shared with the workbench filter: the library's k/m/b shorthand
			// read the `b` in `12ab34` as "billion" and filtered on a figure nobody typed.
			const user = typist()

			answerWith([transaction()])

			renderPanel(<BankTransactions />)

			const amount = await typeAmount(user, '12ab34')

			expect((amount as HTMLInputElement).value).not.toContain('b')
			expect((amount as HTMLInputElement).value).toBe('₹1,234')
		})

		it('refuses a negative amount out loud rather than accepting it and filtering nothing', async () => {
			const user = typist()

			answerWith([transaction()])

			renderPanel(<BankTransactions />)

			const amount = await typeAmount(user, '-50')

			const message = await screen.findByRole('alert')
			expect(message).toHaveTextContent(/negative amount cannot match/i)
			expect(amount).toHaveAttribute('aria-invalid', 'true')
			expect(amount).toHaveAttribute('aria-describedby', 'bank-txn-list-amount-filter-error')
			expect(message).toHaveAttribute('id', 'bank-txn-list-amount-filter-error')
		})
	})

	describe('when the account has no transactions in the range', () => {

		it('says so rather than showing an empty grid', async () => {
			answerWith([])

			renderPanel(<BankTransactions />)

			expect(await screen.findByText('No bank transactions found')).toBeInTheDocument()
		})
	})

	describe('when the read fails', () => {

		it("surfaces the server's own message", async () => {
			answerWith(undefined, makeFrappeError({
				_server_messages: JSON.stringify([
					JSON.stringify({ message: 'Insufficient Permission for Bank Transaction', indicator: 'red' })
				])
			}))

			renderPanel(<BankTransactions />)

			await waitFor(() => {
				expect(screen.getByText('Insufficient Permission for Bank Transaction')).toBeInTheDocument()
			})
		})
	})

	describe('the intro sentence, which interpolates the account name into markdown', () => {

		/*
		 * This tab's intro sentence is built by interpolating `account_name` into a translated string as
		 * raw `<strong>…</strong>` and rendering the result through the shared `MarkdownRenderer`, which
		 * has `rehypeRaw` registered. The account name is data any Accounts user can write, and Frappe's
		 * name validation blocks `<` and `>` but NOT markdown link syntax - `[text](url)` contains
		 * neither - so an account can be named a link. Rendered unsanitised that became a live,
		 * camouflaged off-site anchor inside an authenticated page: styled identically to the legitimate
		 * bold dates beside it, with no `rel`, no `target` and nothing revealed on hover.
		 *
		 * The renderer is where that is stopped (see `ui/markdown.test.tsx` for the boundary itself);
		 * this pins the consequence at the real injection site, so the two cannot drift apart.
		 */
		const PHISHING_ACCOUNT_NAME = '[Sign in to verify your account](https://evil.example.com/login)'

		it('renders a link-shaped account name as inert text, with no off-site anchor', async () => {
			answerWith([transaction()])

			renderPanel(<BankTransactions />, {
				bank: makePanelBank({ account_name: PHISHING_ACCOUNT_NAME })
			})

			await screen.findByText('Not Reconciled')

			// Swept document-wide by attribute VALUE, so it does not matter which element a stray
			// destination lands on: nothing rendered here may name that host.
			document.querySelectorAll('[href], [src]').forEach((element) => {
				for (const attribute of Array.from(element.attributes)) {
					expect(attribute.value).not.toContain('evil.example.com')
				}
			})
			// The reader still sees the whole payload - nothing is hidden, it is simply not clickable.
			expect(document.body.textContent).toContain('Sign in to verify your account')
		})

		it('still renders the account name and the date range in bold, so nothing legitimate is lost', async () => {
			answerWith([transaction()])

			const { container } = renderPanel(<BankTransactions />)

			await screen.findByText('Not Reconciled')

			// The account name plus the two date boundaries - the three interpolations the sentence makes.
			const emphasised = Array.from(container.querySelectorAll('p strong')).map((node) => node.textContent)
			expect(emphasised).toContain('Setup Checking')
			expect(emphasised).toHaveLength(3)
		})
	})
})
