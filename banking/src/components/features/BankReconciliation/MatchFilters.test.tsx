/**
 * Behavioural specification for the voucher match filters.
 *
 * These filters decide which document types the workbench will even OFFER as candidate matches, so they
 * silently shape every suggestion a reviewer sees. A filter left off is not a cosmetic choice: the
 * matching voucher simply never appears.
 *
 * Three behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. The doctype list comes from the SERVER, but falls back to a hard-coded four when the server has
 *      not answered yet - so the filters are usable on first paint rather than empty.
 *   2. The switch identity is the SCRUBBED doctype name, not the label, because that is what the
 *      reconciliation endpoints expect on the wire.
 *   3. "Bank Transaction" is offered separately from the server-driven list, because a bank-to-bank
 *      transfer is matched against another transaction rather than against a voucher.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'

import { createFrappeSDKMock, frappeSDKMock } from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { TooltipProvider } from '@/components/ui/tooltip'
import MatchFilters from './MatchFilters'
import { bankRecMatchFilters } from './bankRecAtoms'

const renderMatchFilters = (
	{
		serverDoctypes,
		selected = []
	}: { serverDoctypes?: string[]; selected?: string[] } = {}
) => {
	frappeSDKMock.useFrappeGetCall.mockReturnValue({
		data: serverDoctypes ? { message: serverDoctypes } : undefined,
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: vi.fn()
	} as never)

	const store = createStore()
	store.set(bankRecMatchFilters, selected)

	const user = userEvent.setup()

	render(
		<Provider store={store}>
			<TooltipProvider>
				<MatchFilters />
			</TooltipProvider>
		</Provider>
	)

	return { store, user }
}

const openFilters = async (options: Parameters<typeof renderMatchFilters>[0] = {}) => {
	const { store, user } = renderMatchFilters(options)

	await user.click(
		screen.getByRole('button', { name: 'Configure match filters for vouchers' })
	)
	await screen.findByText('Show Only Exact Amount')

	return { store, user }
}

describe('MatchFilters', () => {

	beforeEach(() => {
		frappeSDKMock.useFrappeGetCall.mockReturnValue({
			data: undefined,
			error: undefined,
			isLoading: false,
			isValidating: false,
			mutate: vi.fn()
		} as never)
	})

	describe('its trigger', () => {

		it('names itself, because it renders as an icon only', () => {
			renderMatchFilters()

			expect(
				screen.getByRole('button', { name: 'Configure match filters for vouchers' })
			).toBeInTheDocument()
		})

		it('keeps the filters out of the way until asked for', () => {
			renderMatchFilters()

			expect(screen.queryByText('Show Only Exact Amount')).not.toBeInTheDocument()
		})
	})

	describe('what it offers', () => {

		it('QUIRK - falls back to the four standard doctypes before the server answers', async () => {
			// Without the fallback the panel would open empty on first paint, reading as "no filters
			// available" rather than "not loaded yet".
			await openFilters()

			expect(screen.getByText('Payment Entry')).toBeInTheDocument()
			expect(screen.getByText('Journal Entry')).toBeInTheDocument()
			expect(screen.getByText('Purchase Invoice')).toBeInTheDocument()
			expect(screen.getByText('Sales Invoice')).toBeInTheDocument()
		})

		it('prefers the server list once it arrives', async () => {
			// The server list reflects what this site actually reconciles against, which can be
			// narrower or wider than the standard four.
			await openFilters({ serverDoctypes: ['Payment Entry', 'Expense Claim'] })

			expect(screen.getByText('Expense Claim')).toBeInTheDocument()
			expect(screen.queryByText('Sales Invoice')).not.toBeInTheDocument()
		})

		it('QUIRK - offers Bank Transaction separately from the voucher list', async () => {
			// A bank-to-bank transfer is matched against the OTHER side's transaction, not against a
			// voucher, so it is not part of the server-driven doctype list.
			await openFilters({ serverDoctypes: ['Payment Entry'] })

			expect(screen.getByText('Bank Transaction')).toBeInTheDocument()
		})

		it('offers an exact-amount constraint alongside the doctypes', async () => {
			await openFilters()

			expect(screen.getByText('Show Only Exact Amount')).toBeInTheDocument()
		})
	})

	describe('reflecting what is already selected', () => {

		it('shows a filter as on when it is in the stored selection', async () => {
			await openFilters({ selected: ['payment_entry', 'exact_match'] })

			expect(screen.getByRole('switch', { name: 'Payment Entry' })).toBeChecked()
			expect(screen.getByRole('switch', { name: 'Show Only Exact Amount' })).toBeChecked()
			expect(screen.getByRole('switch', { name: 'Journal Entry' })).not.toBeChecked()
		})

		it('QUIRK - keys each switch on the scrubbed doctype name, not the label', async () => {
			// The reconciliation endpoints receive these identifiers, so the label is presentation
			// only. Storing "Purchase Invoice" instead of "purchase_invoice" would filter nothing.
			const { store, user } = await openFilters()

			await user.click(screen.getByRole('switch', { name: 'Purchase Invoice' }))

			await waitFor(() => {
				expect(store.get(bankRecMatchFilters)).toContain('purchase_invoice')
			})
		})
	})

	describe('changing a filter', () => {

		it('adds a doctype to the selection', async () => {
			const { store, user } = await openFilters({ selected: ['payment_entry'] })

			await user.click(screen.getByRole('switch', { name: 'Journal Entry' }))

			await waitFor(() => {
				expect(store.get(bankRecMatchFilters)).toEqual(['payment_entry', 'journal_entry'])
			})
		})

		it('removes a doctype without disturbing the others', async () => {
			const { store, user } = await openFilters({
				selected: ['payment_entry', 'journal_entry', 'sales_invoice']
			})

			await user.click(screen.getByRole('switch', { name: 'Journal Entry' }))

			await waitFor(() => {
				expect(store.get(bankRecMatchFilters)).toEqual(['payment_entry', 'sales_invoice'])
			})
		})

		it('toggles the exact-amount constraint independently of the doctypes', async () => {
			const { store, user } = await openFilters({ selected: ['payment_entry'] })

			await user.click(screen.getByRole('switch', { name: 'Show Only Exact Amount' }))

			await waitFor(() => {
				expect(store.get(bankRecMatchFilters)).toEqual(['payment_entry', 'exact_match'])
			})
		})

		it('toggles the bank-transaction filter independently too', async () => {
			const { store, user } = await openFilters()

			await user.click(screen.getByRole('switch', { name: 'Bank Transaction' }))

			await waitFor(() => {
				expect(store.get(bankRecMatchFilters)).toEqual(['bank_transaction'])
			})
		})
	})
})
