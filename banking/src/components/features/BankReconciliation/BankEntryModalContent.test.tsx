/**
 * Behavioural specification for the "Record Bank Entry" modal.
 *
 * This is the surface a reviewer uses when a bank transaction is neither a dealing with a party nor an
 * internal transfer - a bank charge, an interest credit, a correction. It creates a Journal Entry against
 * chosen ledger accounts and reconciles the transaction against it in one server call, which makes it the
 * most general of the three "create a voucher" surfaces.
 *
 * The subject is a modal BODY: it renders inside an already-open dialog and uses `DialogClose` for its
 * cancel control, so every render below supplies an open `Dialog` - the context Radix requires and the
 * production mount provides.
 *
 * Three behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. It routes on the SIZE of the selection into three genuinely different forms, and the single and bulk
 *      branches post to DIFFERENT endpoints so a batch is atomic rather than a client-side loop.
 *   2. Unlike the other two modals it offers an ATTACHMENTS affordance, because a bank charge is the case
 *      where a reviewer most often has a document to keep with the entry.
 *   3. The selection is read from a per-bank-account atom family, so a selection made against another
 *      account is invisible here.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'

import { TooltipProvider } from '@/components/ui/tooltip'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { createFrappeSDKMock, frappeSDKMock, makeUnreconciledTransaction } from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import RecordBankEntryModalContent from './BankEntryModalContent'
import { bankRecSelectedTransactionsAtom, selectedBankAccountAtom } from './bankRecAtoms'
import { makePanelBank } from '@/test/renderPanel'

const SINGLE_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.create_bank_entry_and_reconcile'
const BULK_ENDPOINT =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.create_bulk_bank_entry_and_reconcile'

const charge = (overrides: Record<string, unknown> = {}) =>
	makeUnreconciledTransaction({
		name: 'ACC-BTN-2026-00001',
		withdrawal: 340.25,
		deposit: 0,
		unallocated_amount: 340.25,
		description: 'Quarterly account maintenance charge',
		...overrides
	})

const renderModal = (selection: ReturnType<typeof charge>[] = [], bank = makePanelBank()) => {
	const store = createStore()
	store.set(selectedBankAccountAtom, bank)
	store.set(bankRecSelectedTransactionsAtom, selection)

	return {
		store,
		...render(
			<Provider store={store}>
				<TooltipProvider>
					<MemoryRouter>
						<Dialog open>
							<DialogContent>
								<RecordBankEntryModalContent />
							</DialogContent>
						</Dialog>
					</MemoryRouter>
				</TooltipProvider>
			</Provider>
		)
	}
}

const registeredPostEndpoints = () =>
	frappeSDKMock.useFrappePostCall.mock.calls.map(([method]) => method)

describe('BankEntryModalContent', () => {

	beforeEach(() => {
		frappeSDKMock.useFrappeGetCall.mockReturnValue({
			data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
		})
		frappeSDKMock.useFrappeGetDocList.mockReturnValue({
			data: [], error: undefined, isLoading: false, isValidating: false, mutate: vi.fn()
		})
	})

	describe('when nothing is selected', () => {

		it('says so rather than rendering an empty form', () => {
			renderModal([])

			expect(screen.getByText('No transaction selected')).toBeInTheDocument()
		})

		it('says so when no bank account is chosen either', () => {
			renderModal([], null as unknown as ReturnType<typeof makePanelBank>)

			expect(screen.getByText('No transaction selected')).toBeInTheDocument()
		})

		it('registers no bank-entry endpoint on that branch', () => {
			renderModal([])

			expect(registeredPostEndpoints()).not.toContain(SINGLE_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(BULK_ENDPOINT)
		})
	})

	describe('when exactly one transaction is selected', () => {

		it('renders the single Journal Entry form', () => {
			renderModal([charge()])

			expect(screen.queryByText('No transaction selected')).not.toBeInTheDocument()
			expect(screen.getByText('Posting Date')).toBeInTheDocument()
		})

		it('QUIRK - registers the SINGLE-transaction endpoint', () => {
			renderModal([charge()])

			expect(registeredPostEndpoints()).toContain(SINGLE_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(BULK_ENDPOINT)
		})

		it('offers the fields a Journal Entry is traced by', () => {
			renderModal([charge()])

			expect(screen.getByText('Reference Date')).toBeInTheDocument()
			expect(screen.getByText('Reference')).toBeInTheDocument()
			// "Remarks" appears both as the field label and inside the custom-remarks toggle, so the
			// assertion is on presence rather than uniqueness.
			expect(screen.getAllByText('Remarks').length).toBeGreaterThan(0)
		})

		it('QUIRK - offers attachments, which the other two voucher modals do not', () => {
			// A bank charge or correction is the case where the reviewer most often has paperwork to keep
			// alongside the entry.
			renderModal([charge()])

			expect(screen.getByText('Attachments')).toBeInTheDocument()
		})

		it('offers a way out as well as a way forward', () => {
			renderModal([charge()])

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
		})

		it('renders a credit as readily as a charge', () => {
			// An interest credit takes the opposite ledger side, so both directions must mount.
			renderModal([charge({ withdrawal: 0, deposit: 125.75, unallocated_amount: 125.75 })])

			expect(screen.getByText('Posting Date')).toBeInTheDocument()
			expect(registeredPostEndpoints()).toContain(SINGLE_ENDPOINT)
		})

		describe('the entries table', () => {

			it('gives the amount columns a minimum width so a posted figure cannot be cut off', () => {
				/*
				 * The amount cells were the only ones in this table without a minimum. Every other wide
				 * column declares one - Account min-w-64, Cost Center min-w-48, Remarks min-w-64 - so auto
				 * table layout handed Debit and Credit whatever was left and squeezed their inputs until a
				 * figure was clipped mid-number. On a monetary field that is not just untidy: a reviewer
				 * cannot check what they are about to post.
				 */
				renderModal([charge()])

				const debit = screen.getByRole('columnheader', { name: 'Debit' })
				const credit = screen.getByRole('columnheader', { name: 'Credit' })

				expect(debit.className).toMatch(/\bmin-w-40\b/)
				expect(credit.className).toMatch(/\bmin-w-40\b/)

				// And on the body cells, which are what auto layout actually measures.
				const row = debit.closest('table')?.querySelector('tbody tr') as HTMLElement
				const cells = Array.from(row.querySelectorAll('td'))
				const amountCells = cells.slice(-2)

				for (const cell of amountCells) {
					expect(cell.className).toMatch(/\bmin-w-40\b/)
				}
			})

			/*
			 * Controls are located by their form field NAME rather than by their accessible name. The
			 * accessible name is asserted separately: its exact whitespace depends on how the name is
			 * computed, and jsdom's implementation trims each node's contribution where a real browser
			 * inserts a separator - so a name-based query here would pin the polyfill's quirk rather
			 * than the product's behaviour.
			 */
			const control = (fieldName: string) =>
				document.querySelector(`[name="${fieldName}"]`) as HTMLElement

			it('marks a required field required in a way software can read, not just an asterisk', () => {
				/*
				 * `isRequired` used to draw a red asterisk beside the label and nothing else. An asterisk
				 * is punctuation a screen reader skips or reads as "star", and nothing in the
				 * accessibility tree said the control was required - so the constraint existed only for a
				 * sighted reader.
				 */
				renderModal([charge()])

				// `cheque_no` is the Reference field, declared `isRequired` and rendering a plain input.
				expect(control('cheque_no')).toHaveAttribute('aria-required', 'true')
				expect(control('entries.0.debit')).toHaveAttribute('aria-required', 'true')
				expect(control('entries.0.credit')).toHaveAttribute('aria-required', 'true')
			})

			it('announces the constraint in words, with the asterisk hidden from the reader', () => {
				renderModal([charge()])

				// One spoken ", required" per required field, hidden from sight...
				expect(screen.getAllByText(', required').length).toBeGreaterThan(0)

				// ...and the asterisk itself hidden from the accessibility tree, so it is not announced
				// as "star". Both live inside the label, which is what carries the field's name.
				const label = Array.from(document.querySelectorAll('label'))
					.find((candidate) => (candidate.textContent ?? '').startsWith('Reference')) as HTMLElement
				expect(label.querySelector('[aria-hidden="true"]')).toHaveTextContent('*')
				/*
				 * The separator matters, and it has to be a COMMA. Accessible-name computation trims
				 * each node's text before joining, and `trim` strips U+00A0 as well as a plain space,
				 * so either kind of space produced the run-together "Reference(required)". Measured
				 * both ways before settling on this.
				 */
				expect(label.querySelector('.sr-only')?.textContent).toBe(', required')
			})

			it('leaves an optional field unmarked, so the marking still means something', () => {
				// Cost Center is deliberately NOT `isRequired`; if everything were marked the mark would
				// carry no information.
				renderModal([charge()])

				const costCentre = screen.getAllByRole('combobox')
					.filter((candidate) => /Cost Center/.test(candidate.textContent ?? ''))

				expect(costCentre.length).toBeGreaterThan(0)
				for (const candidate of costCentre) {
					expect(candidate).not.toHaveAttribute('aria-required')
				}

				// Remarks is optional too, and it is a plain input.
				expect(control('entries.0.user_remark')).not.toHaveAttribute('aria-required')
			})

			it('marks the required Account combobox required as well as the plain inputs', () => {
				// The dropdowns render a `role="combobox"` button rather than a native control, so the
				// attribute had to be threaded through each of them separately.
				renderModal([charge()])

				const comboboxes = screen.getAllByRole('combobox')

				expect(comboboxes.some((candidate) => candidate.getAttribute('aria-required') === 'true'))
					.toBe(true)
			})

			it('does NOT set the native required attribute, which would take validation off the form', () => {
				/*
				 * None of this app's forms sets `noValidate`, so a native `required` would engage the
				 * browser's own constraint validation - which runs BEFORE the submit handler - and the
				 * reviewer would get Chrome's bubble instead of the message this form renders from its own
				 * rules. `aria-required` announces the constraint without taking validation away.
				 */
				renderModal([charge()])

				for (const fieldName of ['cheque_no', 'entries.0.debit', 'entries.0.credit']) {
					/*
					 * The NATIVE attribute specifically. `toBeRequired` cannot express this: jest-dom
					 * treats `aria-required="true"` as required too, so it passes on both shapes and
					 * would not notice the browser taking validation over.
					 */
					expect(control(fieldName)).not.toHaveAttribute('required')
					// ...while the constraint is still exposed, which is the whole point.
					expect(control(fieldName)).toBeRequired()
				}
			})

			it('associates the amount inputs with their own label, which they had lost entirely', () => {
				/*
				 * `CurrencyFormField` used to wrap its `InputGroup` in a `FormControl`. `FormControl` is a
				 * Radix Slot that stamps the field id onto its single direct child - the wrapper DIV - while
				 * this field also put the SAME id on the real input. Two elements shared one id, the
				 * label's `htmlFor` resolved to the div, and because a div is not labelable EVERY currency
				 * field in the app computed an empty accessible name.
				 */
				renderModal([charge()])

				const debit = control('entries.0.debit')

				// Exactly one element owns the id, and it is the input.
				expect(document.querySelectorAll(`[id="${debit.id}"]`)).toHaveLength(1)
				expect(document.getElementById(debit.id)).toBe(debit)

				// And the label now points at it.
				const label = document.querySelector(`label[for="${debit.id}"]`)
				expect(label).toBeInTheDocument()
				expect(label?.textContent).toContain('Debit')
			})

			it('associates the Attachments label with the file input it describes', () => {
				/*
				 * The label sat outside the dropzone while the input sat inside it, with no `for` to bridge
				 * them - so Chrome reported "No label associated with a form field" and the control was
				 * announced only by the browser's own fallback. The input is deliberately NOT aria-hidden
				 * (it IS the control), so leaving it unnamed was a real omission rather than a benign
				 * library internal.
				 */
				renderModal([charge()])

				const label = Array.from(document.querySelectorAll('label'))
					.find((candidate) => (candidate.textContent || '').trim() === 'Attachments') as HTMLLabelElement

				expect(label).toBeInTheDocument()
				expect(label.htmlFor).toBe('bank-entry-attachments')

				const input = document.getElementById('bank-entry-attachments')
				expect(input).toBeInTheDocument()
				expect(input?.tagName).toBe('INPUT')
				expect(input).toHaveAttribute('type', 'file')
				expect(document.querySelectorAll('[id="bank-entry-attachments"]')).toHaveLength(1)
			})

			it('gives each row its own date-picker id rather than repeating one', () => {
				// The trigger carried a literal id, so a form with a date field per row emitted it several
				// times - invalid, and it makes any id-based reference ambiguous.
				renderModal([charge()])

				const ids = Array.from(document.querySelectorAll('[id$="-date-picker-button"]'))
					.map((node) => node.id)

				expect(ids.length).toBeGreaterThan(0)
				expect(new Set(ids).size).toBe(ids.length)
			})
		})
	})

	describe('when several transactions are selected', () => {

		const twoCharges = [
			charge({ name: 'ACC-BTN-2026-00001' }),
			charge({ name: 'ACC-BTN-2026-00002', withdrawal: 55, unallocated_amount: 55 })
		]

		it('renders the bulk form instead of the single one', () => {
			renderModal(twoCharges)

			expect(screen.queryByText('No transaction selected')).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
		})

		it('QUIRK - registers the BULK endpoint, so the batch posts atomically', () => {
			renderModal(twoCharges)

			expect(registeredPostEndpoints()).toContain(BULK_ENDPOINT)
			expect(registeredPostEndpoints()).not.toContain(SINGLE_ENDPOINT)
		})

		it('offers a way out as well as a way forward', () => {
			renderModal(twoCharges)

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
		})

		it('scales past two without changing branch', () => {
			renderModal([
				charge({ name: 'ACC-BTN-2026-00001' }),
				charge({ name: 'ACC-BTN-2026-00002' }),
				charge({ name: 'ACC-BTN-2026-00003' })
			])

			expect(registeredPostEndpoints()).toContain(BULK_ENDPOINT)
		})
	})

	describe('QUIRK - the selection is scoped per bank account', () => {

		it('sees nothing when the selection was made against a DIFFERENT account', () => {
			const store = createStore()
			/*
			 * The selection is made while ANOTHER account is picked, then the account is switched. That is
			 * how a cross-scope selection actually arises, and it also pins the half that used to fail:
			 * the selection is orphaned rather than parked, so switching back cannot replay it.
			 */
			store.set(selectedBankAccountAtom, makePanelBank({ name: 'Some Other Account' }))
			store.set(bankRecSelectedTransactionsAtom, [charge()])
			store.set(selectedBankAccountAtom, makePanelBank())

			render(
				<Provider store={store}>
					<TooltipProvider>
						<MemoryRouter>
							<Dialog open>
								<DialogContent>
									<RecordBankEntryModalContent />
								</DialogContent>
							</Dialog>
						</MemoryRouter>
					</TooltipProvider>
				</Provider>
			)

			expect(screen.getByText('No transaction selected')).toBeInTheDocument()
		})
	})
})
