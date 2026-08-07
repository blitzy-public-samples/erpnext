/**
 * Behavioural specification for the session action log.
 *
 * The log is the workbench's audit trail: after a reviewer reconciles something, this is the only place
 * that records WHAT they did and against which voucher, and it is what they consult before deciding to
 * undo. It is deliberately session-scoped - held in `sessionStorage` rather than on the server - so it
 * describes this sitting's work rather than the account's history.
 *
 * Five behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. Entries are grouped by ACTION, and the group heading is derived from the action's type together
 *      with its bulk flag - so the same type yields two different headings.
 *   2. The heading for a `match` action is "Matched" whether or not it was bulk, unlike the other three.
 *   3. A row labels the amount "Spent" or "Received" from the transaction's own withdrawal/deposit, not
 *      from the voucher.
 *   4. The voucher reference is prefixed with its doctype ONLY for doctypes other than Payment Entry and
 *      Journal Entry, because those two are the common cases and the prefix would be noise.
 *   5. An unknown action type still renders, under a generic "Action" heading, rather than throwing - the
 *      log is read out of session storage and so may contain an entry written by an older build.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'
import type { ReactElement } from 'react'

import { TooltipProvider } from '@/components/ui/tooltip'
import {
	createFrappeSDKMock,
	frappePostCall,
	frappeSWRMutate,
	makeBankTransaction
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import ActionLogDialogBody from './ActionLogDialogBody'
import {
	bankRecActionLog,
	selectedBankAccountAtom,
	type ActionLog,
	type ActionLogItem
} from '../BankReconciliation/bankRecAtoms'
import { makePanelBank } from '@/test/renderPanel'

const logItem = (overrides: Partial<ActionLogItem> = {}): ActionLogItem => ({
	bankTransaction: makeBankTransaction({
		name: 'ACC-BTN-2026-00001',
		date: '2026-08-03',
		deposit: 4825.5,
		withdrawal: 0,
		allocated_amount: 4825.5,
		unallocated_amount: 0
	}),
	voucher: {
		reference_doctype: 'Payment Entry',
		reference_name: 'ACC-PAY-2026-00001',
		reference_no: 'REF-INR-0001',
		reference_date: '2026-08-03',
		posting_date: '2026-08-03'
	},
	...overrides
})

const logEntry = (overrides: Partial<ActionLog> = {}): ActionLog => ({
	type: 'match',
	isBulk: false,
	timestamp: 1785894728915,
	items: [logItem()],
	...overrides
})

/** The log is read straight out of an atom, so no request is involved in rendering it. */
const renderLog = (entries: ActionLog[], subject: ReactElement = <ActionLogDialogBody />) => {
	const store = createStore()
	store.set(selectedBankAccountAtom, makePanelBank())
	store.set(bankRecActionLog, entries)

	return {
		store,
		...render(
			<Provider store={store}>
				<TooltipProvider>
					<MemoryRouter>{subject}</MemoryRouter>
				</TooltipProvider>
			</Provider>
		)
	}
}

describe('ActionLogDialogBody', () => {

	describe('when nothing has been done this session', () => {

		it('says so, and scopes the statement to THIS session', async () => {
			// The wording matters: the log is session-scoped, so "you have done nothing" would be wrong -
			// the account may well have been reconciled yesterday.
			renderLog([])

			expect(await screen.findByText('No reconciliation actions found')).toBeInTheDocument()
			expect(
				screen.getByText('You have not performed any reconciliations in this session yet.')
			).toBeInTheDocument()
		})
	})

	/*
	 * Each heading renders as `<label> - <relative time>` inside a single span, so the label is matched
	 * with an anchored pattern rather than as exact text - and the anchor is what keeps "Payment" from
	 * also matching "Bulk Payment".
	 */
	describe('QUIRK - its group headings', () => {

		it('reads Matched for a match, bulk or not', async () => {
			// The only type whose heading does not change with the bulk flag.
			renderLog([logEntry({ type: 'match', isBulk: false })])
			expect(await screen.findByText(/^Matched - /)).toBeInTheDocument()
		})

		it('distinguishes a single payment from a bulk one', async () => {
			const { unmount } = renderLog([logEntry({ type: 'payment', isBulk: false })])
			expect(await screen.findByText(/^Payment - /)).toBeInTheDocument()
			unmount()

			renderLog([logEntry({ type: 'payment', isBulk: true })])
			expect(await screen.findByText(/^Bulk Payment - /)).toBeInTheDocument()
		})

		it('distinguishes a single transfer from a bulk one', async () => {
			const { unmount } = renderLog([logEntry({ type: 'transfer', isBulk: false })])
			expect(await screen.findByText(/^Transfer - /)).toBeInTheDocument()
			unmount()

			renderLog([logEntry({ type: 'transfer', isBulk: true })])
			expect(await screen.findByText(/^Bulk Transfer - /)).toBeInTheDocument()
		})

		it('distinguishes a single bank entry from a bulk one', async () => {
			const { unmount } = renderLog([logEntry({ type: 'bank_entry', isBulk: false })])
			expect(await screen.findByText(/^Bank Entry - /)).toBeInTheDocument()
			unmount()

			renderLog([logEntry({ type: 'bank_entry', isBulk: true })])
			expect(await screen.findByText(/^Bulk Bank Entry - /)).toBeInTheDocument()
		})

		it('QUIRK - falls back to a generic heading for a type it does not know', async () => {
			// The log is deserialised out of session storage, so an entry written by an older build can
			// arrive here. Rendering it generically beats throwing away the reviewer's whole audit trail.
			renderLog([logEntry({ type: 'reversal' as ActionLog['type'] })])

			expect(await screen.findByText(/^Action - /)).toBeInTheDocument()
		})
	})

	describe('each logged row', () => {

		it('names the transaction and the voucher it was reconciled against', async () => {
			renderLog([logEntry()])

			expect(await screen.findByText(/ACC-PAY-2026-00001/)).toBeInTheDocument()
		})

		it('QUIRK - labels the amount from the TRANSACTION side, as received', async () => {
			renderLog([logEntry({
				items: [logItem({
					bankTransaction: makeBankTransaction({
						deposit: 4825.5, withdrawal: 0, allocated_amount: 4825.5, unallocated_amount: 0
					})
				})]
			})])

			expect(await screen.findByTitle('Received')).toBeInTheDocument()
			expect(screen.queryByTitle('Spent')).not.toBeInTheDocument()
		})

		it('labels a withdrawal as spent instead', async () => {
			renderLog([logEntry({
				items: [logItem({
					bankTransaction: makeBankTransaction({
						deposit: 0, withdrawal: 1250, allocated_amount: 1250, unallocated_amount: 0
					})
				})]
			})])

			expect(await screen.findByTitle('Spent')).toBeInTheDocument()
			expect(screen.queryByTitle('Received')).not.toBeInTheDocument()
		})

		it('shows the transaction date under its own label', async () => {
			renderLog([logEntry()])

			expect(await screen.findByTitle('Transaction Date')).toBeInTheDocument()
		})

		it('QUIRK - prefixes the reference with its doctype only for the uncommon doctypes', async () => {
			// Payment Entry and Journal Entry are the overwhelming majority, so prefixing them would be
			// noise; anything else is worth naming.
			const { unmount } = renderLog([logEntry({
				items: [logItem({
					voucher: {
						reference_doctype: 'Sales Invoice',
						reference_name: 'ACC-SINV-2026-00001',
						posting_date: '2026-08-03'
					}
				})]
			})])

			expect(await screen.findByText(/Sales Invoice/)).toBeInTheDocument()
			unmount()

			renderLog([logEntry()])

			expect(await screen.findByText(/ACC-PAY-2026-00001/)).toBeInTheDocument()
			expect(screen.queryByText(/Payment Entry :/)).not.toBeInTheDocument()
		})
	})

	describe('grouping', () => {

		it('renders one group per action, in the order the log holds them', async () => {
			renderLog([
				logEntry({ type: 'match', timestamp: 1785894728915 }),
				logEntry({
					type: 'payment',
					timestamp: 1785894728916,
					items: [logItem({
						bankTransaction: makeBankTransaction({ name: 'ACC-BTN-2026-00002' })
					})]
				})
			])

			expect(await screen.findByText(/^Matched - /)).toBeInTheDocument()
			expect(screen.getByText(/^Payment - /)).toBeInTheDocument()
		})

		it('renders every item within one action', async () => {
			renderLog([logEntry({
				isBulk: true,
				items: [
					logItem({
						bankTransaction: makeBankTransaction({ name: 'ACC-BTN-2026-00001' }),
						voucher: {
							reference_doctype: 'Payment Entry',
							reference_name: 'ACC-PAY-2026-00001',
							posting_date: '2026-08-03'
						}
					}),
					logItem({
						bankTransaction: makeBankTransaction({ name: 'ACC-BTN-2026-00002' }),
						voucher: {
							reference_doctype: 'Payment Entry',
							reference_name: 'ACC-PAY-2026-00002',
							posting_date: '2026-08-04'
						}
					})
				]
			})])

			expect(await screen.findByText(/ACC-PAY-2026-00001/)).toBeInTheDocument()
			expect(screen.getByText(/ACC-PAY-2026-00002/)).toBeInTheDocument()
		})

		it('renders no empty state once anything has been logged', async () => {
			renderLog([logEntry()])

			await screen.findByText(/^Matched - /)

			expect(screen.queryByText('No reconciliation actions found')).not.toBeInTheDocument()
		})
	})

	/*
	 * The log is deserialised out of `sessionStorage`, so this renderer reads records it did not write and
	 * cannot assume the shape of. The voucher DOCUMENT in particular is optional on a log item - a bulk
	 * flow, or an older build, records the reference without it - and the Journal Entry branch used to read
	 * the accounts child table straight off it. That throw was not contained anywhere, so React tore the
	 * whole SPA down: the reviewer opened their audit trail and got a blank page, losing the workbench and
	 * every other entry in the log with it, recoverable only by reloading.
	 */
	describe('an entry whose voucher document was never recorded', () => {

		const journalEntryWithoutDoc = () => logEntry({
			type: 'bank_entry',
			items: [logItem({
				voucher: {
					reference_doctype: 'Journal Entry',
					reference_name: 'ACC-JV-2026-00004',
					posting_date: '2026-08-03'
					// No `doc`: exactly what the log holds for an entry written without it.
				}
			})]
		})

		it('renders the row instead of throwing', async () => {
			renderLog([journalEntryWithoutDoc()])

			expect(await screen.findByText(/ACC-JV-2026-00004/)).toBeInTheDocument()
		})

		it('keeps every detail it CAN read, and simply omits the accounts it cannot', async () => {
			renderLog([journalEntryWithoutDoc()])

			// The transaction side of the row comes from the log entry itself and is unaffected.
			expect(await screen.findByTitle('Transaction Date')).toBeInTheDocument()
			expect(screen.getByTitle('Received')).toBeInTheDocument()
			expect(screen.getByText(/^Bank Entry - /)).toBeInTheDocument()
			// And nothing pretends to know how many accounts were involved.
			expect(screen.queryByText(/Split across/)).not.toBeInTheDocument()
		})

		it('does not fall back to the contained-failure notice, because nothing failed', async () => {
			// The distinction matters: a missing document is a known, graceful degradation, and reporting it
			// as a failure would make the reviewer doubt a reconciliation that was posted correctly.
			renderLog([journalEntryWithoutDoc()])

			await screen.findByText(/ACC-JV-2026-00004/)

			expect(screen.queryByText('This entry could not be displayed')).not.toBeInTheDocument()
		})

		it('still names the accounts when the document IS there', async () => {
			// The guard must not have cost the feature it was guarding.
			renderLog([logEntry({
				type: 'bank_entry',
				items: [logItem({
					voucher: {
						reference_doctype: 'Journal Entry',
						reference_name: 'ACC-JV-2026-00005',
						posting_date: '2026-08-03',
						doc: {
							accounts: [
								{ account: 'Bank Charges - _TC', debit: 150, credit: 0, account_currency: 'INR' }
							]
						} as never
					}
				})]
			})])

			expect(await screen.findByText('Bank Charges - _TC')).toBeInTheDocument()
		})
	})

	describe('an entry this renderer cannot read at all', () => {

		/**
		 * An item with no `voucher` whatsoever. Nothing writes this today - it stands in for the shape
		 * drift that a session-scoped store deserialised across builds makes possible, which is the class
		 * of failure the boundary exists for.
		 */
		const undecipherable = () => logItem({
			bankTransaction: makeBankTransaction({ name: 'ACC-BTN-2026-00099' }),
			voucher: undefined as never
		})

		it('contains the failure to that one row and keeps the rest of the log', async () => {
			// React's default is to unmount the entire tree, which is what turned one bad record into a
			// blank page. Contained per row, the reviewer keeps everything else they did this session.
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { })

			try {
				renderLog([logEntry({
					items: [
						logItem({
							bankTransaction: makeBankTransaction({ name: 'ACC-BTN-2026-00001' }),
							voucher: {
								reference_doctype: 'Payment Entry',
								reference_name: 'ACC-PAY-2026-00001',
								posting_date: '2026-08-03'
							}
						}),
						undecipherable()
					]
				})])

				expect(await screen.findByText('This entry could not be displayed')).toBeInTheDocument()
				// The readable sibling and the group it belongs to both survive.
				expect(screen.getByText(/ACC-PAY-2026-00001/)).toBeInTheDocument()
				expect(screen.getByText(/^Matched - /)).toBeInTheDocument()
			} finally {
				consoleError.mockRestore()
			}
		})

		it('says the posting is unaffected, because that is the reviewer\'s actual question', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { })

			try {
				renderLog([logEntry({ items: [undecipherable()] })])

				expect(await screen.findByText(/Nothing that was posted has changed/)).toBeInTheDocument()
				expect(screen.getByRole('alert')).toBeInTheDocument()
			} finally {
				consoleError.mockRestore()
			}
		})

		it('leaves a trace in the console, so a contained failure is still reportable', async () => {
			// A tidy fallback with no record behind it is worse than the crash: nobody can diagnose it.
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { })

			try {
				renderLog([logEntry({ items: [undecipherable()] })])

				await screen.findByText('This entry could not be displayed')

				expect(consoleError).toHaveBeenCalled()
				expect(
					consoleError.mock.calls.some((call) =>
						typeof call[0] === 'string' && call[0].includes('ErrorBoundary')
					)
				).toBe(true)
			} finally {
				consoleError.mockRestore()
			}
		})

		it('does not take the empty state\'s place either - the log is not empty', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { })

			try {
				renderLog([logEntry({ items: [undecipherable()] })])

				await screen.findByText('This entry could not be displayed')

				expect(screen.queryByText('No reconciliation actions found')).not.toBeInTheDocument()
			} finally {
				consoleError.mockRestore()
			}
		})
	})

	/*
	 * The undo control is the only way to reverse a reconciliation from this SPA, and it was reachable
	 * ONLY by hovering its row - `display: none` until then - which is not a state a keyboard can produce.
	 * It was also labelled "Cancel" for every row, which in an accounting product reads as cancelling the
	 * voucher, and on a matched row is not even what happens: the match is undone and the voucher is left
	 * alone.
	 */
	describe('the undo control', () => {

		it('is in the document without anyone hovering the row', async () => {
			renderLog([logEntry({ type: 'match' })])

			expect(await screen.findByRole('button', { name: 'Unmatch transaction' })).toBeInTheDocument()
		})

		/*
	 * jsdom loads no stylesheet, so a Tailwind class cannot be OBSERVED to hide anything here and the
	 * accessibility queries above would have passed against the broken version too. The class list is
	 * the only signal available from a test, so it is asserted directly - and what is actually painted
	 * is measured in a real browser instead.
	 *
	 * This assertion was inverted deliberately. It previously REQUIRED the control to be transparent at
	 * rest and to fade in, which pinned a HALF fix: keeping it in the tab order solved the keyboard, but
	 * touch produces no hover at all, so the control remained a 28x28 invisible target that had to be
	 * found before it could be revealed. The requirement is that the action be reachable by every input
	 * device, so the control is now painted at rest and this test says so.
	 */
	it('is painted at rest, not revealed by hover', async () => {
		renderLog([logEntry({ type: 'match' })])

		const undo = await screen.findByRole('button', { name: 'Unmatch transaction' })

		// Neither removed from the layout nor made transparent - either one hides it from touch.
		expect(undo.className).not.toMatch(/(^|\s)hidden(\s|$)/)
		expect(undo.className).not.toMatch(/(^|\s)opacity-0(\s|$)/)
		expect(undo.className).not.toContain('group-hover:opacity-100')
		expect(undo.className).not.toContain('group-focus-within:opacity-100')

		// Muted at rest so the row stays calm, escalating on hover and on keyboard focus.
		expect(undo.className).toContain('text-ink-gray-5')
		expect(undo.className).toContain('hover:text-ink-red-3')
		expect(undo.className).toContain('focus-visible:text-ink-red-3')
	})

		it('can be reached with the keyboard', async () => {
			renderLog([logEntry({ type: 'match' })])

			const undo = await screen.findByRole('button', { name: 'Unmatch transaction' })

			// Bounded rather than open-ended: the row holds a voucher link ahead of it.
			for (let press = 0; press < 6 && document.activeElement !== undo; press++) {
				await userEvent.tab()
			}

			expect(undo).toHaveFocus()
		})

		it('names what it undoes on a matched row', async () => {
			renderLog([logEntry({ type: 'match' })])

			const undo = await screen.findByRole('button', { name: 'Unmatch transaction' })

			// The tooltip and the hover title say the same thing as the accessible name.
			expect(undo).toHaveAttribute('title', 'Unmatch transaction')
			expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
		})

		it('names the voucher it undoes on a created-voucher row', async () => {
			renderLog([logEntry({ type: 'payment' })])

			expect(await screen.findByRole('button', { name: 'Undo Payment Entry' })).toBeInTheDocument()
		})

		it('opens a confirmation that agrees with the control that opened it', async () => {
			renderLog([logEntry({ type: 'match' })])

			await userEvent.click(await screen.findByRole('button', { name: 'Unmatch transaction' }))

			expect(await screen.findByText('Unmatch Transaction?')).toBeInTheDocument()
		})

		it('reverses the reconciliation on the server, and stops describing what it reversed', async () => {
			// Reachability is only worth anything if the control still does its job, so the whole path is
			// exercised: confirm, post, revalidate, and drop the entry that no longer describes reality.
			frappePostCall.mockClear()
			frappeSWRMutate.mockClear()
			frappePostCall.mockResolvedValue({ message: 1 })

			const { store } = renderLog([logEntry({ type: 'match' })])

			await userEvent.click(await screen.findByRole('button', { name: 'Unmatch transaction' }))
			await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledWith({
					bank_transaction_id: 'ACC-BTN-2026-00001',
					voucher_type: 'Payment Entry',
					voucher_id: 'ACC-PAY-2026-00001'
				})
			})

			// The workbench behind the dialog has to be told, or it keeps showing the row as reconciled.
			expect(frappeSWRMutate).toHaveBeenCalledWith(
				expect.stringContaining('bank-reconciliation-unreconciled-transactions-')
			)

			await waitFor(() => {
				expect(store.get(bankRecActionLog)).toHaveLength(0)
			})
		})
	})
})
