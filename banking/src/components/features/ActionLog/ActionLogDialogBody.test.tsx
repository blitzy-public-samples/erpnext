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
import { render, screen } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'
import type { ReactElement } from 'react'

import { TooltipProvider } from '@/components/ui/tooltip'
import { createFrappeSDKMock, makeBankTransaction } from '@/test/factories'

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
})
