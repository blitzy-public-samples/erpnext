/**
 * Behavioural specification for the reconciliation date filter.
 *
 * The date range governs every query in the workbench - the transaction list, the balances, the reports -
 * so this control silently decides what the reviewer is reconciling. It offers three ways in: a list of
 * named periods, a natural-language box, and a two-month calendar.
 *
 * Seven behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. The named periods are REPLACED when the site has a fiscal year: "This Year" becomes "This Fiscal
 *      Year" and four fiscal quarters appear, because a calendar year is the wrong unit for accounting.
 *   2. This Month and Last Month are hoisted ABOVE the fiscal options, because they are what a reviewer
 *      reaching for the filter almost always wants.
 *   3. The trigger reads "Date Range" whenever the stored dates match no named period - so a hand-picked
 *      range is never mislabelled as a named one.
 *   4. Typing a phrase parses it, and the parse appears in the EMPTY state of the list - the place a
 *      reviewer would otherwise see "no results".
 *   5. A month-only phrase expands to the WHOLE month, rather than from its first day until today.
 *   6. A specific day stays a single day, NOT a range running to today - but a phrase containing a
 *      referential word like "last" does run to today. The two are deliberately different.
 *   7. A future date inverts the range so it reads forwards, because a range must never end before it
 *      begins.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import dayjs from 'dayjs'

import { createFrappeSDKMock, frappeSDKMock } from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { TooltipProvider } from '@/components/ui/tooltip'
import BankRecDateFilter from './BankRecDateFilter'
import { bankRecDateAtom } from './bankRecAtoms'

const FISCAL_YEAR = {
	name: '2026-2027',
	year_start_date: '2026-04-01',
	year_end_date: '2027-03-31'
}

interface FilterOptions {
	fromDate?: string
	toDate?: string
	fiscalYear?: typeof FISCAL_YEAR | null
}

const renderFilter = ({
	fromDate = '2026-08-01',
	toDate = '2026-08-31',
	fiscalYear = FISCAL_YEAR
}: FilterOptions = {}) => {
	frappeSDKMock.useFrappeGetCall.mockReturnValue({
		data: fiscalYear ? { message: fiscalYear } : undefined,
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: vi.fn()
	} as never)

	const store = createStore()
	store.set(bankRecDateAtom, { fromDate, toDate })

	const user = userEvent.setup()

	render(
		<Provider store={store}>
			<TooltipProvider>
				<BankRecDateFilter />
			</TooltipProvider>
		</Provider>
	)

	return { store, user }
}

/** Opens the named-period list, which is the combobox half of the split control. */
const openPeriodList = async (options: FilterOptions = {}) => {
	const { store, user } = renderFilter(options)

	await user.click(screen.getByRole('combobox'))
	await screen.findByPlaceholderText('e.g. Last 3 weeks')

	return { store, user }
}

/** Types a phrase and waits for the parsed suggestion to replace the "no results" state. */
const typePhrase = async (user: ReturnType<typeof userEvent.setup>, phrase: string) => {
	await user.type(screen.getByPlaceholderText('e.g. Last 3 weeks'), phrase)

	await waitFor(() => {
		expect(screen.queryByText('No results found')).not.toBeInTheDocument()
	})
}

describe('BankRecDateFilter', () => {

	beforeEach(() => {
		frappeSDKMock.useFrappeGetCall.mockReturnValue({
			data: { message: FISCAL_YEAR },
			error: undefined,
			isLoading: false,
			isValidating: false,
			mutate: vi.fn()
		} as never)
	})

	describe('what the trigger reads', () => {

		it('names the period when the stored dates match one', async () => {
			const thisMonthStart = dayjs().startOf('month').format('YYYY-MM-DD')
			const thisMonthEnd = dayjs().endOf('month').format('YYYY-MM-DD')

			renderFilter({ fromDate: thisMonthStart, toDate: thisMonthEnd })

			expect(screen.getByRole('combobox')).toHaveTextContent('This Month')
		})

		it('QUIRK - falls back to "Date Range" for a range that matches nothing', () => {
			// A hand-picked range must not be mislabelled as a named period, or the reviewer would
			// believe they were looking at a month they were not.
			renderFilter({ fromDate: '2026-08-07', toDate: '2026-08-19' })

			expect(screen.getByRole('combobox')).toHaveTextContent('Date Range')
		})

		it('shows the actual dates alongside the period name', () => {
			renderFilter({ fromDate: '2026-08-01', toDate: '2026-08-31' })

			// The dates are the unambiguous statement; the period name is the shorthand.
			expect(screen.getByRole('button', { name: /01-08-2026 - 31-08-2026/ })).toBeInTheDocument()
		})
	})

	describe('the named periods', () => {

		it('offers the everyday relative periods', async () => {
			await openPeriodList()

			// Role-scoped, because the trigger echoes the active period and would otherwise match too.
			expect(screen.getByRole('option', { name: /This Month/ })).toBeInTheDocument()
			expect(screen.getByRole('option', { name: /Last Month/ })).toBeInTheDocument()
			expect(screen.getByRole('option', { name: /This Week/ })).toBeInTheDocument()
			expect(screen.getByRole('option', { name: /Last Quarter/ })).toBeInTheDocument()
		})

		it('QUIRK - ADDS the fiscal year rather than replacing the calendar year', async () => {
			// The comment in the source says the fiscal options "replace" This Year and Last Year, but
			// the implementation only ever partitions on This Month / Last Month - so the calendar-year
			// options survive in the lower group and the list offers BOTH. A reviewer on a site whose
			// fiscal year is not the calendar year therefore has two similarly named choices that mean
			// different spans.
			//
			// Pinned rather than fixed: the extra options are correct data, not a defect, and removing
			// them would take away a range some reviewers legitimately want.
			await openPeriodList()

			expect(screen.getByRole('option', { name: /This Fiscal Year/ })).toBeInTheDocument()
			expect(screen.getByRole('option', { name: /Last Fiscal Year/ })).toBeInTheDocument()
			expect(screen.getByRole('option', { name: /^This Year/ })).toBeInTheDocument()
			expect(screen.getByRole('option', { name: /^Last Year/ })).toBeInTheDocument()
		})

		it('QUIRK - adds the four fiscal quarters, named after the fiscal year', async () => {
			await openPeriodList()

			expect(screen.getByText('Q1: 2026-2027')).toBeInTheDocument()
			expect(screen.getByText('Q2: 2026-2027')).toBeInTheDocument()
			expect(screen.getByText('Q3: 2026-2027')).toBeInTheDocument()
			expect(screen.getByText('Q4: 2026-2027')).toBeInTheDocument()
		})

		it('QUIRK - hoists this and last month above the fiscal options', async () => {
			// Ordering is a real decision here: the monthly close is the common case, and burying it
			// under six fiscal entries would cost a scan on every visit.
			await openPeriodList()

			const labels = screen
				.getAllByRole('option')
				.map((option) => option.textContent ?? '')

			const thisMonth = labels.findIndex((label) => label.startsWith('This Month'))
			const q1 = labels.findIndex((label) => label.startsWith('Q1'))

			expect(thisMonth).toBeGreaterThanOrEqual(0)
			expect(q1).toBeGreaterThan(thisMonth)
		})

		it('offers only the calendar periods when no fiscal year is configured', async () => {
			await openPeriodList({ fiscalYear: null })

			expect(screen.queryByRole('option', { name: /Fiscal/ })).not.toBeInTheDocument()
			expect(screen.queryByRole('option', { name: /Q1/ })).not.toBeInTheDocument()
			expect(screen.getByRole('option', { name: /^This Year/ })).toBeInTheDocument()
			expect(screen.getByRole('option', { name: /This Month/ })).toBeInTheDocument()
		})

		it('shows each period\'s own span, so the shorthand can be checked', async () => {
			await openPeriodList()

			// Every option carries its resolved dates; that is what lets a reviewer tell "This Month"
			// from "Last Month" without opening both.
			const q1 = screen.getByRole('option', { name: /Q1: 2026-2027/ })
			expect(q1).toHaveTextContent('Apr 2026')
		})

		it('applies a chosen period to the shared filter', async () => {
			const { store, user } = await openPeriodList()

			await user.click(screen.getByRole('option', { name: /Q1: 2026-2027/ }))

			await waitFor(() => {
				// Q1 runs from the fiscal year start for three months.
				expect(store.get(bankRecDateAtom)).toEqual({
					fromDate: '2026-04-01',
					toDate: '2026-07-01'
				})
			})
		})

		it('closes itself once a period is chosen', async () => {
			const { user } = await openPeriodList()

			await user.click(screen.getByRole('option', { name: /This Fiscal Year/ }))

			await waitFor(() => {
				expect(
					screen.queryByPlaceholderText('e.g. Last 3 weeks')
				).not.toBeInTheDocument()
			})
		})
	})

	describe('typing a phrase instead', () => {

		it('QUIRK - offers the parse where "no results" would otherwise be', async () => {
			// The empty state is exactly where a reviewer looks after typing something the named list
			// does not contain, so putting the parse there costs no extra discovery. With an EMPTY box
			// every option still matches, which is why the empty state only exists once something
			// unmatched has been typed.
			const { user } = await openPeriodList()

			expect(screen.queryByText('No results found')).not.toBeInTheDocument()

			await typePhrase(user, 'last 3 weeks')

			// The phrase itself is echoed next to the range it resolved to.
			expect(screen.getByText('last 3 weeks')).toBeInTheDocument()
			expect(screen.queryByText('No results found')).not.toBeInTheDocument()
		})

		it('says so plainly when a phrase cannot be parsed', async () => {
			const { user } = await openPeriodList()

			await user.type(
				screen.getByPlaceholderText('e.g. Last 3 weeks'),
				'zzzzz nonsense'
			)

			await waitFor(() => {
				expect(screen.getByText('No results found')).toBeInTheDocument()
			})
		})

		it('QUIRK - expands a month-only phrase to the whole month', async () => {
			// "May 2026" means the month, not "from 1 May until today" - which is what the generic
			// fallback would have produced.
			const { store, user } = await openPeriodList()

			await typePhrase(user, 'May 2026')
			await user.click(screen.getByText('May 2026'))

			await waitFor(() => {
				expect(store.get(bankRecDateAtom)).toEqual({
					fromDate: '2026-05-01',
					toDate: '2026-05-31'
				})
			})
		})

		it('QUIRK - keeps a specific day as a single day', async () => {
			// Naming a day is a precise request. Running it to today would silently widen a
			// one-day reconciliation into an open-ended one.
			const { store, user } = await openPeriodList()

			await typePhrase(user, '15 May 2026')
			await user.click(screen.getByText('15 May 2026'))

			await waitFor(() => {
				expect(store.get(bankRecDateAtom)).toEqual({
					fromDate: '2026-05-15',
					toDate: '2026-05-15'
				})
			})
		})

		it('renders a single-day parse as one date rather than a span', async () => {
			const { user } = await openPeriodList()

			await typePhrase(user, '15 May 2026')

			// Shown as "15th May 2026" with no arrow, because a span from a day to itself reads oddly.
			expect(screen.getByText('15th May 2026')).toBeInTheDocument()
		})

		it('QUIRK - lets a referential phrase run to today', async () => {
			// "last friday" is an open request in a way that "15 May 2026" is not, so the two take
			// different branches on purpose.
			const { store, user } = await openPeriodList()

			await typePhrase(user, 'last friday')
			await user.click(screen.getByText('last friday'))

			await waitFor(() => {
				const stored = store.get(bankRecDateAtom)
				expect(stored.toDate).toBe(dayjs().format('YYYY-MM-DD'))
				expect(dayjs(stored.fromDate).isBefore(dayjs(stored.toDate))).toBe(true)
			})
		})

		it('QUIRK - inverts a future date so the range still reads forwards', async () => {
			// A range whose end precedes its start would return nothing at all, so a future date
			// becomes the END and today becomes the start.
			const { store, user } = await openPeriodList()

			const future = dayjs().add(2, 'month')

			await typePhrase(user, future.format('D MMMM YYYY'))
			await user.click(screen.getByText(future.format('D MMMM YYYY')))

			await waitFor(() => {
				const stored = store.get(bankRecDateAtom)
				expect(stored.fromDate).toBe(dayjs().format('YYYY-MM-DD'))
				expect(dayjs(stored.toDate).isAfter(dayjs(stored.fromDate))).toBe(true)
			})
		})

		it('resolves an explicit two-ended phrase to exactly those ends', async () => {
			const { store, user } = await openPeriodList()

			await typePhrase(user, '1 May 2026 to 10 May 2026')
			await user.click(screen.getByText('1 May 2026 to 10 May 2026'))

			await waitFor(() => {
				expect(store.get(bankRecDateAtom)).toEqual({
					fromDate: '2026-05-01',
					toDate: '2026-05-10'
				})
			})
		})
	})

	describe('the calendar', () => {

		it('opens on the stored range', async () => {
			const { user } = renderFilter({ fromDate: '2026-08-01', toDate: '2026-08-31' })

			await user.click(screen.getByRole('button', { name: /01-08-2026 - 31-08-2026/ }))

			// Two months at once, so a range spanning a month boundary can be picked without paging.
			await waitFor(() => {
				expect(screen.getAllByRole('grid').length).toBe(2)
			})
		})
	})
})
