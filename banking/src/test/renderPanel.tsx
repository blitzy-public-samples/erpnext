/**
 * Shared render harness for the reconciliation panels and the surfaces that behave like them.
 *
 * Every one of those components sits behind the same two pieces of context and reads the same two atoms,
 * so re-declaring the provider stack per suite would be repetition that can silently drift. This module
 * owns the stack once:
 *
 *   - a per-render jotai store, because jotai is per-provider and the harness performs no global reset,
 *     so each test must build its own or leak selection state into the next;
 *   - `selectedBankAccountAtom` and `bankRecDateAtom`, which every panel early-returns without and which
 *     are interpolated into the SWR cache keys the panels declare;
 *   - a router, because several panels render a `<Link>` on their empty state;
 *   - a `TooltipProvider`, because the shared `ListView` renders tooltips for truncated cells and Radix
 *     throws without an ancestor provider.
 *
 * It lives under `src/test/`, which `vitest.config.ts` excludes from coverage - harness code must not
 * count toward the gate it exists to help satisfy.
 */

import { render } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'

import { TooltipProvider } from '@/components/ui/tooltip'
import {
	bankRecDateAtom,
	selectedBankAccountAtom,
	type SelectedBank
} from '@/components/features/BankReconciliation/bankRecAtoms'

import { TEST_BANK_ACCOUNT, TEST_COMPANY, TEST_CURRENCY } from './factories'

export const PANEL_FROM_DATE = '2026-08-01'
export const PANEL_TO_DATE = '2026-08-31'

/** Tall enough that the virtualiser's range covers every row a test seeds. */
const MEASURED_VIEWPORT_HEIGHT = 2000

/**
 * Gives jsdom a viewport height, for the whole file that calls it.
 *
 * The shared `ListView` renders through `@tanstack/react-virtual`, which asks its scroll container for
 * `offsetHeight` and renders NO row when that measures zero - as it always does under jsdom, which
 * performs no layout. Without this a data-bearing panel renders its chrome and an empty body, and every
 * row assertion fails for a reason that has nothing to do with the product.
 *
 * Installed per test and restored after each, because the shared teardown in `setup.ts` resets mock
 * FUNCTIONS rather than property getters, so a getter installed once would outlive the file.
 */
export const stubViewportMeasurement = () => {
	let measurement: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		measurement = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
			.mockReturnValue(MEASURED_VIEWPORT_HEIGHT)
	})

	afterEach(() => {
		measurement.mockRestore()
	})
}

/**
 * The selected bank exactly as `bank_account.get_list` returns one, including the DERIVED
 * `account_currency` the endpoint attaches per row. `null` is a legitimate value for it - the endpoint
 * cannot always resolve the linked account's currency - so it is modelled rather than assumed present.
 */
export const makePanelBank = (overrides: Partial<SelectedBank> = {}): SelectedBank => ({
	name: TEST_BANK_ACCOUNT,
	account: '_Test Bank - _TC',
	company: TEST_COMPANY,
	account_name: 'Setup Checking',
	is_default: 0,
	bank: 'Setup Test Bank',
	is_credit_card: 0,
	account_currency: TEST_CURRENCY,
	...overrides
})

export interface PanelOptions {
	/** Pass `null` to model the state before a bank account has been chosen. */
	bank?: SelectedBank | null
	fromDate?: string
	toDate?: string
	/** Omit the router when the subject under test supplies its own. */
	withRouter?: boolean
}

/**
 * Renders a panel inside the full stack and returns the store alongside the usual testing-library
 * result, so a test can assert on what the panel wrote back to an atom as well as on what it rendered.
 */
export const renderPanel = (subject: ReactElement, options: PanelOptions = {}) => {
	const {
		bank = makePanelBank(),
		fromDate = PANEL_FROM_DATE,
		toDate = PANEL_TO_DATE,
		withRouter = true
	} = options

	const store = createStore()
	store.set(selectedBankAccountAtom, bank)
	store.set(bankRecDateAtom, {
		fromDate,
		toDate,
		timePeriod: 'This Month',
		format: "Do MMM 'YY"
	} as never)

	const routed: ReactNode = withRouter ? <MemoryRouter>{subject}</MemoryRouter> : subject

	const utils = render(
		<Provider store={store}>
			<TooltipProvider>{routed}</TooltipProvider>
		</Provider>
	)

	return { ...utils, store }
}

/** A `frappe.desk.query_report.run` response, which is the shape every report panel consumes. */
export const makeReportResponse = <T,>(
	result: T[],
	overrides: Record<string, unknown> = {}
) => ({
	message: {
		prepared_report: false,
		report_summary: [],
		result,
		columns: [],
		add_total_row: false,
		...overrides
	}
})
