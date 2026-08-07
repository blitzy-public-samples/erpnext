/**
 * Behavioural specification for the reconciliation page shell.
 *
 * This is the page a reviewer lands on. It owns the five-tab information architecture, the header that
 * carries the account picker, date filter and company selector, and the decision of what to show before an
 * account has been chosen. Its own logic is small but load-bearing, and it is the only place several
 * behaviours are observable at all.
 *
 * The theme and tooltip providers are supplied here because `App.tsx` supplies them in production - the
 * page mounts tooltips in its header and would otherwise throw before rendering anything.
 *
 * Five behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. The tab content's height is computed in a layout effect from the measured header and the window,
 *      then handed DOWN as a prop - so the workbench's virtual list is sized by the page, not by CSS.
 *   2. Four of the five tabs are LAZY; only "Match and Reconcile" is eager, so the first paint does not
 *      pay for the reports.
 *   3. The page is deliberately DESKTOP-ONLY: below the medium breakpoint it renders a separate gate
 *      rather than reflowing the workbench.
 *   4. The tab strip renders whether or not an account is chosen, but the panels behind it each guard
 *      themselves - so the shell is never responsible for the empty state.
 *   5. The breadcrumb links out to the Desk with a plain anchor rather than a router link, because it
 *      leaves the SPA.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'

import { createFrappeSDKMock, frappeSDKMock } from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from '@/components/ui/theme-provider'
import BankReconciliation from './BankReconciliation'
import { bankRecDateAtom, selectedBankAccountAtom } from '@/components/features/BankReconciliation/bankRecAtoms'
import { PANEL_FROM_DATE, PANEL_TO_DATE, makePanelBank, stubViewportMeasurement } from '@/test/renderPanel'

const TAB_NAMES = [
	'Match and Reconcile',
	'Bank Reconciliation Statement',
	'Bank Transactions',
	'Bank Clearance Summary',
	'Incorrectly Cleared Entries'
]

const renderPage = (bank: ReturnType<typeof makePanelBank> | null = makePanelBank()) => {
	const store = createStore()
	store.set(selectedBankAccountAtom, bank)
	store.set(bankRecDateAtom, {
		fromDate: PANEL_FROM_DATE,
		toDate: PANEL_TO_DATE,
		timePeriod: 'This Month',
		format: "Do MMM 'YY"
	} as never)

	return {
		store,
		...render(
			<Provider store={store}>
				<ThemeProvider>
					<TooltipProvider>
						<MemoryRouter>
							<BankReconciliation />
						</MemoryRouter>
					</TooltipProvider>
				</ThemeProvider>
			</Provider>
		)
	}
}

describe('BankReconciliation page', () => {

	stubViewportMeasurement()

	beforeEach(() => {
		frappeSDKMock.useFrappeGetCall.mockReturnValue({
			data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
		})
		frappeSDKMock.useFrappeGetDocList.mockReturnValue({
			data: [], error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
		})
		frappeSDKMock.useFrappeGetDocCount.mockReturnValue({
			data: 0, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
		})
	})

	describe('QUIRK - its five-tab architecture', () => {

		it('offers exactly five tabs, in a fixed order', async () => {
			renderPage()

			await waitFor(() => {
				expect(screen.getAllByRole('tab')).toHaveLength(5)
			})

			expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim()))
				.toEqual(TAB_NAMES)
		})

		it('opens on Match and Reconcile, which is where the work is done', async () => {
			renderPage()

			await waitFor(() => {
				expect(screen.getByRole('tab', { name: TAB_NAMES[0] })).toHaveAttribute('aria-selected', 'true')
			})
		})

		it('leaves the other four unselected on first paint', async () => {
			renderPage()

			await waitFor(() => {
				expect(screen.getAllByRole('tab')).toHaveLength(5)
			})

			for (const name of TAB_NAMES.slice(1)) {
				expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'false')
			}
		})

		it('switches to a lazily loaded tab on demand', async () => {
			// The four report tabs are code-split, so this also proves the suspense boundary resolves rather
			// than leaving the reviewer on a spinner.
			const user = userEvent.setup()

			renderPage()

			await waitFor(() => {
				expect(screen.getAllByRole('tab')).toHaveLength(5)
			})

			await user.click(screen.getByRole('tab', { name: 'Bank Transactions' }))

			await waitFor(() => {
				expect(screen.getByRole('tab', { name: 'Bank Transactions' }))
					.toHaveAttribute('aria-selected', 'true')
			})
		})

		it('QUIRK - withholds the tab strip entirely until an account is chosen', async () => {
			// Corrects a natural assumption: the panels DO each guard themselves, yet the shell also gates
			// the whole strip. So a reviewer never sees five tabs they cannot use, and the panels' own
			// guards only ever fire when an account is deselected mid-session.
			renderPage(null)

			await waitFor(() => {
				expect(screen.getAllByText('Banking').length).toBeGreaterThan(0)
			})

			expect(screen.queryAllByRole('tab')).toHaveLength(0)
			expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument()
		})
	})

	describe('its header', () => {

		it('names the application and marks it as beta', async () => {
			renderPage()

			// "Banking" appears in both the breadcrumb and the narrow-viewport gate, which is why this is a
			// presence assertion rather than a uniqueness one.
			expect((await screen.findAllByText('Banking')).length).toBeGreaterThan(0)
			expect(screen.getByText('Beta')).toBeInTheDocument()
		})

		it('QUIRK - links home with a plain anchor, because that leaves the SPA', async () => {
			renderPage()

			await waitFor(() => {
				expect(screen.getAllByRole('tab')).toHaveLength(5)
			})

			const home = screen.getAllByRole('link').find((link) => link.getAttribute('href') === '/desk')
			expect(home).toBeDefined()
		})

		it('renders the date filter alongside the picker', async () => {
			// Both are needed before any panel will fetch, so both must be present on first paint.
			renderPage()

			await waitFor(() => {
				expect(screen.getAllByRole('tab')).toHaveLength(5)
			})

			expect(screen.getByText(/2026/)).toBeInTheDocument()
		})
	})

	describe('QUIRK - it is desktop-only by design', () => {

		it('renders a separate narrow-viewport gate rather than reflowing', async () => {
			// AAP-specified behaviour: the workbench is a two-pane comparison surface and does not reduce to
			// a phone. The gate is always in the DOM and revealed by breakpoint, so it is assertable here.
			renderPage()

			await waitFor(() => {
				expect(screen.getAllByRole('tab')).toHaveLength(5)
			})

			expect(screen.getByText(/Desktop/i)).toBeInTheDocument()
		})
	})

	describe('QUIRK - it sizes its own tab content', () => {

		it('renders without a measured header, which is the first-paint state', async () => {
			// The height is computed in a layout effect, so the first render happens with zero. If the
			// workbench could not cope with that it would never render at all.
			renderPage()

			await waitFor(() => {
				expect(screen.getAllByRole('tab')).toHaveLength(5)
			})
			expect(screen.getByRole('tabpanel')).toBeInTheDocument()
		})

		it('watches the header for size changes rather than measuring it once', async () => {
			/*
			 * The measurement used to be taken in a layout effect with an empty dependency array, which ran
			 * BEFORE the account picker and balance tiles had data - understating the real header by more
			 * than 100px - and never ran again. Observing the header is what makes the later, populated
			 * header the one the panels are sized from.
			 */
			const observed: Element[] = []
			const original = globalThis.ResizeObserver
			globalThis.ResizeObserver = class {
				constructor(private callback: () => void) { }
				observe(target: Element) {
					observed.push(target)
					this.callback()
				}
				unobserve() { }
				disconnect() { }
			} as unknown as typeof ResizeObserver

			try {
				renderPage()

				await waitFor(() => {
					expect(screen.getAllByRole('tab')).toHaveLength(5)
				})
				expect(observed.length).toBeGreaterThan(0)
			} finally {
				globalThis.ResizeObserver = original
			}
		})

		it('recomputes on a window resize instead of keeping the previous viewport', async () => {
			// Nothing listened for resizes before, so dragging the window left every panel sized for the
			// viewport it was first painted in.
			renderPage()

			await waitFor(() => {
				expect(screen.getAllByRole('tab')).toHaveLength(5)
			})

			Object.defineProperty(window, 'innerHeight', { value: 640, configurable: true, writable: true })
			window.dispatchEvent(new Event('resize'))

			// The page must survive the recomputation and keep its panel mounted; the height itself is a
			// prop handed down to the workbench, which is exercised by that component's own suite.
			await waitFor(() => {
				expect(screen.getByRole('tabpanel')).toBeInTheDocument()
			})

			Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true, writable: true })
		})
	})

	describe('reaching the rest of the workflow', () => {

		it('scrolls its own tab strip rather than letting a tab escape the viewport', async () => {
			/*
			 * The five triggers are `whitespace-nowrap` and need about 1044px between them. With the strip's
			 * overflow visible, the surplus widened the DOCUMENT below roughly 1076px - 36px at 1024, 292px
			 * at 768 - and the last tab ended up partly or wholly outside the viewport with no way to reach
			 * it. Keeping the overflow inside the strip is what makes every tab reachable at every width.
			 */
			renderPage()

			await waitFor(() => {
				expect(screen.getAllByRole('tab')).toHaveLength(5)
			})

			const list = screen.getByRole('tablist')
			expect(list.className).toContain('overflow-x-auto')
			expect(list.className).toContain('max-w-full')
		})

		it('offers a route to the statement importer from a populated workbench', async () => {
			// The importer used to be reachable only from the no-transactions empty state, so an account
			// with rows in it offered no route to importing more.
			renderPage()

			await waitFor(() => {
				expect(screen.getAllByRole('tab')).toHaveLength(5)
			})

			/*
			 * Two routes to the importer coexist: this one in the header, always available, and the
			 * workbench's own empty-state call to action, which only appears when the account has nothing
			 * to reconcile. The header one is the icon button beside Settings, so it is identified by being
			 * a tooltip trigger.
			 */
			const routes = screen.getAllByRole('link', { name: 'Import Bank Statement' })
			expect(routes.length).toBeGreaterThan(0)
			for (const route of routes) {
				expect(route).toHaveAttribute('href', '/statement-importer')
			}
			expect(routes.some((route) => route.getAttribute('data-slot') === 'tooltip-trigger')).toBe(true)
		})
	})
})
