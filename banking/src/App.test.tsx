/**
 * Behavioural specification for the application root.
 *
 * `App` is wiring, not a view: providers, the boot-user gate, the router, and - since a render error
 * anywhere below it used to take the entire document down to a blank page - the boundary of last resort.
 * So this suite specifies the wiring itself, with the index page stubbed. Rendering the real workbench
 * here would specify the workbench instead, and it has its own suite for that.
 *
 * Four things are worth pinning:
 *   1. The routed page is reached at all, through the provider stack and the boot-user gate.
 *   2. A page that throws is CONTAINED, and what replaces it says the one thing a reviewer needs to hear
 *      after a client-side failure in an accounting product - that the failure posted nothing - and offers
 *      the only recovery a torn-down React tree has.
 *   3. WHERE an unmatched URL ends up, judged by the browser's HISTORY rather than by which screen
 *      appears. The catch-all redirect lands on the workbench either way; what the reviewer feels is
 *      whether the unmatched entry is still on the stack afterwards. It was: the redirect pushed over the
 *      bogus entry instead of replacing it, so Back returned to the bogus URL, the catch-all pushed
 *      again, and one mistyped link cost three history entries and left Back unable to leave the app at
 *      all. `history.length` is therefore asserted directly, because the visible outcome - landing on the
 *      workbench - is identical in the correct and the broken case and proves nothing.
 *   4. WHETHER any of the above runs: the shell renders no router whatsoever for a boot payload that has
 *      not been authenticated.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFrappeSDKMock } from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

/*
 * The index page is stubbed and can be told to throw. `shouldThrow` is read at RENDER time, not when this
 * factory runs, which is what lets one module mock serve both scenarios in one file.
 */
let shouldThrow = false

vi.mock('@/pages/BankReconciliation', () => ({
	default: () => {
		if (shouldThrow) {
			throw new Error('the workbench failed to render')
		}
		return <div data-testid='workbench'>Bank Reconciliation</div>
	}
}))

import App from './App'

const WORKBENCH_PATH = '/'
const UNMATCHED_PATH = '/qa-no-such-banking-route'

/**
 * The harness boots as a signed-in user, so a suite that needs the guest branch has to narrow it and
 * put it back - `setup.ts` installs the boot payload once, at module scope, for every file.
 */
const bootUser = () => (window.frappe as { boot: { user: { name: string } } }).boot.user

describe('App', () => {

	let originalUser: string

	beforeEach(() => {
		shouldThrow = false
		originalUser = bootUser().name
		// `replaceState`, not `pushState`: the history-length assertions below measure what the catch-all
		// route did, so the harness must not grow the stack on its own.
		window.history.replaceState(null, '', WORKBENCH_PATH)
	})

	afterEach(() => {
		bootUser().name = originalUser
		window.history.replaceState(null, '', WORKBENCH_PATH)
	})

	it('renders the routed page through the provider stack', () => {
		render(<App />)

		expect(screen.getByTestId('workbench')).toBeInTheDocument()
	})

	describe('when a page fails to render', () => {

		it('contains the failure instead of blanking the document', () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { })

			try {
				shouldThrow = true
				render(<App />)

				expect(screen.getByText('Banking could not be displayed')).toBeInTheDocument()
				expect(screen.queryByTestId('workbench')).not.toBeInTheDocument()
			} finally {
				consoleError.mockRestore()
			}
		})

		it('says the failure posted nothing, because that is the reviewer\'s first question', () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { })

			try {
				shouldThrow = true
				render(<App />)

				expect(
					screen.getByText(/Nothing was posted to your books by this failure/)
				).toBeInTheDocument()
				// Announced, not just written: the reviewer's focus is wherever it was when this replaced
				// the page under them.
				expect(screen.getByRole('alert')).toBeInTheDocument()
			} finally {
				consoleError.mockRestore()
			}
		})

		it('offers a reload, which is the only recovery a torn-down tree has', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { })
			const reload = vi.fn()
			const originalLocation = window.location

			// jsdom's own `reload` is unimplemented and logs, so it is replaced outright for this test.
			Object.defineProperty(window, 'location', {
				configurable: true,
				value: { ...originalLocation, reload }
			})

			try {
				shouldThrow = true
				render(<App />)

				await userEvent.click(screen.getByRole('button', { name: 'Reload' }))

				expect(reload).toHaveBeenCalledTimes(1)
			} finally {
				Object.defineProperty(window, 'location', {
					configurable: true,
					value: originalLocation
				})
				consoleError.mockRestore()
			}
		})

		it('reports the contained failure to the console, naming the boundary that caught it', () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { })

			try {
				shouldThrow = true
				render(<App />)

				expect(
					consoleError.mock.calls.some((call) =>
						typeof call[0] === 'string' && call[0].includes('[ErrorBoundary: Banking app root]')
					)
				).toBe(true)
			} finally {
				consoleError.mockRestore()
			}
		})
	})

	describe('the catch-all route', () => {

		it('sends an unmatched URL to the workbench', async () => {
			window.history.pushState(null, '', UNMATCHED_PATH)

			render(<App />)

			await waitFor(() => {
				expect(window.location.pathname).toBe(WORKBENCH_PATH)
			})
		})

		it('REPLACES the unmatched entry rather than pushing over it, so Back can still leave', async () => {
			window.history.pushState(null, '', UNMATCHED_PATH)
			const entriesBeforeRedirect = window.history.length

			render(<App />)

			await waitFor(() => {
				expect(window.location.pathname).toBe(WORKBENCH_PATH)
			})
			// A push would have grown the stack by one and kept the unmatched URL reachable by Back.
			expect(window.history.length).toBe(entriesBeforeRedirect)
		})

		it('leaves a matched URL alone, so the redirect is scoped to what it cannot route', async () => {
			const entriesBefore = window.history.length

			render(<App />)

			await waitFor(() => {
				expect(window.location.pathname).toBe(WORKBENCH_PATH)
			})
			expect(window.history.length).toBe(entriesBefore)
		})
	})

	describe('the guest gate', () => {

		it('mounts no router at all for an unauthenticated boot payload', () => {
			bootUser().name = 'Guest'

			const { container } = render(<App />)

			// The toaster still mounts, so the assertion is that no ROUTED content exists rather than
			// that the tree is empty. Both the real workbench's tabs and the stubbed index page are
			// checked, so the gate stays pinned whether or not the page module is mocked.
			expect(container.querySelector('[data-slot="tabs"]')).toBeNull()
			expect(screen.queryByTestId('workbench')).not.toBeInTheDocument()
			expect(window.location.pathname).toBe(WORKBENCH_PATH)
		})
	})
})
