/*
 * `BankRecErrorDialog` is a COMPOSITION and this suite specifies it as one: an `AlertDialog` wrapping
 * the shared `ErrorBanner`, handed the `FrappeError` exactly as the SDK delivered it.
 *
 * `AlertDialogContent` renders inside `AlertDialogPortal`, so the dialog is portaled to
 * `document.body` and is NOT inside the tree `render()` returns: every query goes through
 * `screen`/`document`, and the render helper exposes no `container` to reach for by mistake.
 *
 * Severity is asserted on the theme's token CLASSES because `ui/alert.tsx` emits no `data-theme` - it
 * carries the theme only in its `cva` class list, so the class is the sole observable signal.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore, useSetAtom } from 'jotai'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
	ALREADY_RECONCILED_MESSAGE_TEMPLATE,
	createFrappeSDKMock,
	formatAlreadyReconciledMessage,
	frappePostCall,
	frappeSWRMutate,
	makeAlreadyReconciledError,
	makeErrorMessageError,
	makeExceptionError,
	makeFrappeError,
	makeMessageOnlyError,
	makeSelectedBank,
	makeServerMessagesError,
	makeUnreconciledTransaction,
	makeWarningServerMessagesError
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankRecErrorDialog from './BankRecErrorDialog'
import {
	bankRecErrorDialogAtom,
	bankRecSelectedTransactionsAtom,
	selectedBankAccountAtom
} from './bankRecAtoms'

const DIALOG_TITLE = 'Something went wrong'
const DIALOG_DESCRIPTION =
	'Review the details below, then dismiss this message to continue. The server remains the authority on what was recorded.'
const DISMISS_LABEL = 'Dismiss'
const COLLAPSED_HEADING = 'There was an error.'

type ServerMessagePayload = {
	message: string
	title?: string
	indicator?: string
}

/**
 * Reproduces Frappe's real DOUBLE encoding — a JSON array whose elements are themselves JSON strings.
 * Needed only for the two envelopes the named factories deliberately do not cover: a message carrying
 * a DISTINCTIVE title, and two messages in one envelope. A drift guard below pins this against the
 * shared factory's own output, so it cannot quietly diverge from the contract the rest of the suite is
 * built on.
 */
const encodeServerMessages = (...messages: ServerMessagePayload[]): string =>
	JSON.stringify(messages.map((message) => JSON.stringify(message)))

type SeededError = ReturnType<typeof makeFrappeError>
type SeededStore = ReturnType<typeof createStore>

/*
 * A per-test store is mandatory rather than stylistic: jotai state is per-`Provider` and the harness
 * performs no global reset, so a shared store would leak one test's error into the next. `seed` reaches
 * that same store before the first render, which is how the dismissal test can show unrelated
 * reconciliation state surviving untouched.
 */
const renderDialog = (error: SeededError | null, seed?: (store: SeededStore) => void) => {
	const store = createStore()
	store.set(bankRecErrorDialogAtom, error)
	seed?.(store)

	const { unmount } = render(
		<Provider store={store}>
			<BankRecErrorDialog />
		</Provider>
	)

	return { store, unmount }
}

const getDialogContent = (): HTMLElement => screen.getByRole('alertdialog')

const getOverlay = (): HTMLElement => {
	const overlay = document.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]')
	if (!overlay) {
		throw new Error('The alert-dialog overlay was not rendered')
	}
	return overlay
}

const getBanner = (): HTMLElement => screen.getByRole('alert')

const getBannerDescription = (): HTMLElement | null =>
	getBanner().querySelector('[data-slot="alert-description"]')

const getBannerMessageText = (): string => getBannerDescription()?.textContent ?? ''

const getBannerHeading = (): string =>
	getBanner().querySelector('[data-slot="alert-title"]')?.textContent ?? ''

describe('BankRecErrorDialog', () => {
	describe('when the atom holds no error', () => {
		it('starts empty, so a store nobody has written to shows nothing', () => {
			expect(createStore().get(bankRecErrorDialogAtom)).toBeNull()
		})

		it('renders nothing at all — no content, no overlay, no chrome, no control', () => {
			renderDialog(null)

			expect(screen.queryByRole('alertdialog')).toBeNull()
			expect(document.querySelector('[data-slot="alert-dialog-overlay"]')).toBeNull()
			expect(screen.queryByText(DIALOG_TITLE)).toBeNull()
			expect(screen.queryByRole('button', { name: DISMISS_LABEL })).toBeNull()
		})
	})

	describe("renders the server's own words", () => {
		it('renders "Bank Transaction {0} is already fully reconciled" verbatim', () => {
			expect(ALREADY_RECONCILED_MESSAGE_TEMPLATE).toBe(
				'Bank Transaction {0} is already fully reconciled'
			)

			const transaction = 'ACC-BTN-2024-00001'
			const expected = formatAlreadyReconciledMessage(transaction)
			expect(expected).toBe('Bank Transaction ACC-BTN-2024-00001 is already fully reconciled')

			renderDialog(makeAlreadyReconciledError(transaction))

			expect(getDialogContent()).toBeInTheDocument()
			expect(screen.getByText(expected)).toBeInTheDocument()
			expect(getBannerMessageText()).toBe(expected)
			expect(getBannerMessageText()).toContain(transaction)
		})

		describe('across every envelope path the shared parser resolves', () => {
			it('PATH 1 — the double-encoded `_server_messages` a frappe.throw produces', () => {
				renderDialog(makeServerMessagesError('Nothing was posted'))

				expect(getBannerMessageText()).toBe('Nothing was posted')
			})

			it('PATH 2 — `_error_message`, which the parser appends', () => {
				renderDialog(makeErrorMessageError('The linked voucher is over-allocated'))

				expect(getBannerMessageText()).toBe('The linked voucher is over-allocated')
			})

			it('PATH 3 — the text after the first colon of `exception`', () => {
				renderDialog(makeExceptionError('Bank Account is disabled'))

				expect(getBannerMessageText().trim()).toBe('Bank Account is disabled')
			})

			it('PATH 4 — the bare `message`, the last resort', () => {
				renderDialog(makeMessageOnlyError())

				expect(getBannerMessageText()).toBe('Internal Server Error')
			})

			it('appends `_error_message` to `_server_messages` rather than replacing it', () => {
				renderDialog(
					makeFrappeError({
						_server_messages: encodeServerMessages({
							message: 'Reconciliation refused',
							title: 'Message',
							indicator: 'red'
						}),
						_error_message: 'Bank Transaction is already fully reconciled'
					})
				)

				expect(getBannerMessageText()).toContain('Reconciliation refused')
				expect(getBannerMessageText()).toContain('Bank Transaction is already fully reconciled')
				expect(getBannerDescription()?.children).toHaveLength(2)
			})

		})

		it('never reshapes, clears or re-encodes the rejection it was handed', () => {
			const error = makeFrappeError({
				_server_messages: encodeServerMessages({
					message: 'Nothing was posted',
					title: 'Message',
					indicator: 'red'
				}),
				_error_message: 'Bank Transaction is already fully reconciled',
				exception: 'frappe.exceptions.ValidationError: refused',
				exc: 'Traceback (most recent call last): …'
			})
			const before = structuredClone(error)

			const { store } = renderDialog(error)

			expect(store.get(bankRecErrorDialogAtom)).toBe(error)
			expect(error).toEqual(before)
		})

		describe('heading', () => {
			it("collapses Frappe's generic 'Message' title into the shared friendly heading", () => {
				renderDialog(makeServerMessagesError('Hard refusal'))

				expect(getBannerHeading()).toBe(COLLAPSED_HEADING)
				expect(getBannerMessageText()).toBe('Hard refusal')
			})

			it("collapses the generic 'Error' title the same way", () => {
				renderDialog(makeErrorMessageError('Hard refusal'))

				expect(getBannerHeading()).toBe(COLLAPSED_HEADING)
			})

			it('keeps a distinctive server title, so the dialog sets no overrideHeading', () => {
				renderDialog(
					makeFrappeError({
						_server_messages: encodeServerMessages({
							message: 'Allocated amount exceeds the unallocated amount',
							title: 'Over-allocation',
							indicator: 'red'
						})
					})
				)

				expect(getBannerHeading()).toBe('Over-allocation')
				expect(getBannerHeading()).not.toBe(COLLAPSED_HEADING)
			})

			it('renders markup in a title as literal TEXT, because the heading is a plain React child', () => {
				// `AlertTitle` receives the parsed title as a string child, so React escapes it. Nothing
				// executes and nothing is silently deleted — the reader sees exactly what was sent.
				renderDialog(
					makeFrappeError({
						_server_messages: encodeServerMessages({
							message: 'Refused',
							title: 'Over-<script>window.__pwned=true</script>allocation',
							indicator: 'red'
						})
					})
				)

				expect(getBanner().querySelector('[data-slot="alert-title"] script')).toBeNull()
				expect(getBannerHeading()).toBe('Over-<script>window.__pwned=true</script>allocation')
			})
		})

		it("keeps Frappe's own inline emphasis, which the shared markdown path renders", () => {
			renderDialog(makeServerMessagesError('Transaction currency: <b>USD</b> cannot be different'))

			const banner = getBanner()
			expect(banner.querySelector('b')).not.toBeNull()
			expect(banner).toHaveTextContent('Transaction currency: USD cannot be different')
			expect(banner.textContent).not.toContain('<b>')
		})
	})

	describe("severity follows the server's own indicator", () => {
		it("renders amber when the server marked its message 'yellow'", () => {
			renderDialog(makeWarningServerMessagesError('The statement covers an earlier period'))

			expect(getBanner().className).toContain('amber')
			expect(getBanner().className).not.toContain('red')
		})

		it('renders red for any other indicator', () => {
			renderDialog(makeServerMessagesError('Hard refusal'))

			expect(getBanner().className).toContain('red')
			expect(getBanner().className).not.toContain('amber')
		})

		it('renders red when the server sent no indicator at all', () => {
			renderDialog(makeExceptionError('Bank Account is disabled'))

			expect(getBanner().className).toContain('red')
		})

		it('tracks the server rather than fixing a severity of its own', () => {
			const { unmount } = renderDialog(makeWarningServerMessagesError('Advisory'))
			expect(getBanner().className).toContain('amber')
			unmount()

			renderDialog(makeServerMessagesError('Refusal'))
			expect(getBanner().className).toContain('red')
		})
	})

	describe('structure', () => {
		it('renders the canonical alert-dialog skeleton', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			const content = getDialogContent()
			expect(content).toBeInTheDocument()
			expect(screen.getByText(DIALOG_TITLE)).toBeInTheDocument()
			expect(screen.getByText(DIALOG_DESCRIPTION)).toBeInTheDocument()
			expect(screen.getByRole('button', { name: DISMISS_LABEL })).toBeInTheDocument()
			expect(content.querySelectorAll('button')).toHaveLength(1)
			expect(getBanner()).toBeInTheDocument()
		})

		it('portals its overlay and content directly into the document body', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			expect(getOverlay().parentElement).toBe(document.body)
			expect(getDialogContent().parentElement).toBe(document.body)
		})

		/*
		 * jsdom computes no layout and the suite loads no compiled stylesheet, so overflow cannot be
		 * measured from here - the rendered geometry is checked in a real browser instead. What this
		 * pins is the MECHANISM that overflowed: a `min-width` beats a `max-width` in CSS, so a fixed
		 * `2xl` minimum forced the box wider than a narrow viewport, and the primitive's
		 * viewport-relative cap has to survive for the box to be able to fit at all.
		 */
		it('caps its width against the viewport instead of forcing a minimum width', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			const className = getDialogContent().className

			expect(className).not.toMatch(/(^|[\s:])min-w-/)
			// The primitive's unconditional floor. Any override of it would have had to remove this.
			expect(className).toContain('max-w-[calc(100%-2rem)]')
			// Widened only from `sm` upwards, so below that breakpoint the floor above is what applies.
			expect(className).toContain('data-[size=default]:sm:max-w-2xl')
			expect(className).not.toContain('data-[size=default]:sm:max-w-lg')
		})

		it('bounds its height against the viewport and scrolls only the message region', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			expect(getDialogContent().className).toContain('max-h-[calc(100dvh-4rem)]')

			const scroller = getBanner().parentElement
			expect(scroller).not.toBeNull()
			expect(scroller?.className).toContain('overflow-y-auto')
			// Without this the grid row cannot shrink and the height cap above would be inert.
			expect(scroller?.className).toContain('min-h-0')
			// Dismiss is a SIBLING of the scroll region, so no volume of server output can push it out
			// of reach.
			expect(scroller?.contains(screen.getByRole('button', { name: DISMISS_LABEL }))).toBe(false)
		})

		/*
		 * The row template is the load-bearing half of the height cap, and it is asserted separately
		 * because it was once absent: the primitive declares `grid` with NO row template, so
		 * `grid-auto-rows: auto` sized the messages row to its content, `min-h-0` had no flexible track
		 * to shrink, `overflow-y` never engaged, and a verbose refusal pushed Dismiss outside the capped
		 * box - off screen and not hit-testable, at every viewport. jsdom computes no layout, so the
		 * class list is the only observable from here; the resulting geometry is measured in a browser.
		 */
		it('gives the messages row a FLEXIBLE track, which is what lets it scroll at all', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			const content = getDialogContent()
			expect(content.className).toContain('grid-rows-[auto_minmax(0,1fr)_auto]')
			// Header, messages, footer: the template describes exactly the three children rendered, so a
			// fourth child would silently fall outside it.
			expect(content.children).toHaveLength(3)
			expect(content.children[1]).toBe(getBanner().parentElement)
		})

		/*
		 * Server text legitimately carries tokens with nowhere to break - a reference, an SQL fragment,
		 * an absolute path. Without this the banner laid one out as a single line thousands of pixels
		 * wide, readable only by scrolling sideways. `anywhere` rather than `break-word` because only
		 * `anywhere` also lowers the intrinsic width, and the transaction list already uses it.
		 */
		it('wraps an unbroken token instead of laying it out past the dialog', () => {
			renderDialog(makeServerMessagesError(`Refused: ${'A'.repeat(800)}`))

			expect(getBanner().parentElement?.className).toContain('wrap-anywhere')
		})

		it('stays mounted and dismissible at a narrow viewport', async () => {
			const originalWidth = window.innerWidth
			try {
				window.innerWidth = 360
				window.dispatchEvent(new Event('resize'))

				const { store } = renderDialog(makeServerMessagesError('Nothing was posted'))

				expect(getDialogContent()).toBeInTheDocument()
				await userEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }))

				await waitFor(() => {
					expect(store.get(bankRecErrorDialogAtom)).toBeNull()
				})
			} finally {
				window.innerWidth = originalWidth
				window.dispatchEvent(new Event('resize'))
			}
		})
	})

	/*
	 * FOCUS, which is a FINANCIAL concern here and not only an accessibility one: the controls behind
	 * this dialog post reconciliations, so a Tab that escapes an open refusal lands on a live Reconcile
	 * button. The primitive alone does not deliver the trap for this composition - it focuses an
	 * `AlertDialogCancel` on open and a `Trigger` on close, and an atom-driven report of an error that
	 * already happened has neither - so the two anchors are supplied here and the specification below is
	 * what stops them being dropped again.
	 */
	describe('focus management', () => {
		/*
		 * Mirrors how the dialog is actually reached: a live control on the page is used, the rejection
		 * handler puts the error on the atom, and the dialog appears with focus still on that control.
		 * `renderDialog` seeds the atom BEFORE the first render, which cannot express any of that.
		 *
		 * The background controls are deliberately the two kinds the audit found reachable - a button on
		 * the workbench and a file link on the importer list.
		 */
		type TriggerFate = 'survives' | 'disappears' | 'disabledWhileInFlight'

		const renderFromTrigger = (error: SeededError, fate: TriggerFate = 'survives') => {
			const store = createStore()

			const Harness = () => {
				const setError = useSetAtom(bankRecErrorDialogAtom)
				const [triggerPresent, setTriggerPresent] = useState(true)
				const [inFlight, setInFlight] = useState(false)

				return (
					<>
						{triggerPresent && (
							<button
								type="button"
								/*
								 * Every real caller disables its control for the duration of the request, which
								 * is what stops a double post - and a browser blurs a control the moment it
								 * becomes disabled, so focus is already off it before the server answers.
								 */
								disabled={inFlight}
								onClick={(event) => {
									if (fate === 'disabledWhileInFlight') {
										const control = event.currentTarget
										setInFlight(true)
										/*
										 * The blur is EXPLICIT because jsdom does not implement it: a real browser
										 * blurs a control as it becomes disabled, which is precisely how focus
										 * reaches `<body>` before the server answers. Without reproducing it here
										 * the specification below cannot tell a working restore from a broken one -
										 * measured in a real browser, where the naive version captured `<body>`.
										 */
										control.blur()
										// The server answers on a later tick, by which time focus has already
										// been dropped by the disable above.
										setTimeout(() => {
											setInFlight(false)
											setError(error)
										}, 0)
										return
									}

									setError(error)
									if (fate === 'disappears') {
										setTriggerPresent(false)
									}
								}}
							>
								Reconcile
							</button>
						)}
						<button type="button">Create Payment Entry</button>
						<a href="/statement-importer/BSIL-2024-00001">hdfc-statement-jan-2024.csv</a>
						<BankRecErrorDialog />
					</>
				)
			}

			render(
				<Provider store={store}>
					<Harness />
				</Provider>
			)

			return { store }
		}

		/*
		 * Every background element is captured BEFORE opening, because the primitive hides the rest of
		 * the document from the accessibility tree while the dialog is open - so a role query cannot
		 * reach them, and only an element reference can prove focus never arrived on one.
		 */
		const openFromTrigger = async (
			user: ReturnType<typeof userEvent.setup>,
			error: SeededError = makeServerMessagesError('Nothing was posted'),
			fate: TriggerFate = 'survives'
		) => {
			const rendered = renderFromTrigger(error, fate)
			const trigger = screen.getByRole('button', { name: 'Reconcile' })
			const background = [
				trigger,
				screen.getByRole('button', { name: 'Create Payment Entry' }),
				screen.getByRole('link', { name: 'hdfc-statement-jan-2024.csv' })
			]

			await user.click(trigger)
			await screen.findByRole('alertdialog')

			return { ...rendered, trigger, background }
		}

		it('moves focus into the dialog, onto Dismiss, as it opens', async () => {
			const user = userEvent.setup()
			await openFromTrigger(user)

			expect(document.activeElement).toBe(screen.getByRole('button', { name: DISMISS_LABEL }))
			expect(getDialogContent().contains(document.activeElement)).toBe(true)
			expect(document.activeElement).not.toBe(document.body)
		})

		it('holds Tab inside the dialog, so no live control behind it can be reached', async () => {
			const user = userEvent.setup()
			const { background } = await openFromTrigger(user)
			const content = getDialogContent()

			// Eight presses, matching the audit that found 8 of 8 escaping onto background controls.
			for (let press = 0; press < 8; press += 1) {
				await user.tab()

				expect(content.contains(document.activeElement)).toBe(true)
				background.forEach((element) => {
					expect(document.activeElement).not.toBe(element)
				})
			}
		})

		it('holds Shift+Tab inside the dialog as well', async () => {
			const user = userEvent.setup()
			const { background } = await openFromTrigger(user)
			const content = getDialogContent()

			for (let press = 0; press < 4; press += 1) {
				await user.tab({ shift: true })

				expect(content.contains(document.activeElement)).toBe(true)
				background.forEach((element) => {
					expect(document.activeElement).not.toBe(element)
				})
			}
		})

		it('hands focus back to the control that opened it when Dismiss is pressed', async () => {
			const user = userEvent.setup()
			const { trigger } = await openFromTrigger(user)

			await user.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			await waitFor(() => {
				expect(document.activeElement).toBe(trigger)
			})
		})

		it('hands focus back to that control on Escape too', async () => {
			const user = userEvent.setup()
			const { trigger } = await openFromTrigger(user)

			await user.keyboard('{Escape}')

			await waitFor(() => {
				expect(document.activeElement).toBe(trigger)
			})
		})

		/*
		 * THE CASE THAT MATTERS MOST, because it is what every real caller does: the control is disabled
		 * for the duration of the request, the browser blurs it as it becomes disabled, and the server
		 * answers only afterwards. Anything that reads `document.activeElement` when the dialog opens
		 * finds `<body>` here - which is an `HTMLElement`, is connected, and satisfies a naive guard - and
		 * then "restores" focus to it, which is indistinguishable from restoring nothing.
		 */
		it('returns focus to a control that was disabled while its request was in flight', async () => {
			const user = userEvent.setup()
			const { trigger } = await openFromTrigger(
				user,
				makeServerMessagesError('Nothing was posted'),
				'disabledWhileInFlight'
			)

			// The premise of the test: focus really was dropped before the dialog appeared.
			expect(trigger).toBeEnabled()
			expect(document.activeElement).toBe(screen.getByRole('button', { name: DISMISS_LABEL }))

			await user.keyboard('{Escape}')

			await waitFor(() => {
				expect(document.activeElement).toBe(trigger)
			})
			expect(document.activeElement).not.toBe(document.body)
		})

		/*
		 * The re-read that follows a refusal can drop the row the reviewer was on, taking its control
		 * with it. Focusing a detached node moves focus to `<body>` silently, so the default is left in
		 * place for the primitive to resolve instead. Nothing is substituted: the nearest lookalike on a
		 * refused reconciliation is another voucher's live Reconcile control.
		 */
		it('does not chase a control that has since been removed', async () => {
			const user = userEvent.setup()
			await openFromTrigger(user, makeServerMessagesError('Nothing was posted'), 'disappears')

			await user.keyboard('{Escape}')

			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).toBeNull()
			})
			expect(document.activeElement?.isConnected).toBe(true)
		})

		it('announces itself as modal, so the page behind is not offered alongside it', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			expect(getDialogContent()).toHaveAttribute('aria-modal', 'true')
			expect(getDialogContent()).toHaveAttribute('role', 'alertdialog')
		})
	})

	describe('dismissal', () => {
		it('clears the atom when Dismiss is pressed and removes the dialog', async () => {
			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'))

			await userEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).toBeNull()
			})
		})

		it('clears the atom when Escape is pressed', async () => {
			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'))

			await userEvent.keyboard('{Escape}')

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
		})

		it('leaves every other piece of reconciliation state byte-identical', async () => {
			const bank = makeSelectedBank()
			const selection = [makeUnreconciledTransaction()]

			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'), (seeded) => {
				seeded.set(selectedBankAccountAtom, bank)
				seeded.set(bankRecSelectedTransactionsAtom, selection)
			})

			await userEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			await waitFor(() => {
				expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			})
			expect(store.get(selectedBankAccountAtom)).toBe(bank)
			expect(store.get(bankRecSelectedTransactionsAtom)).toBe(selection)
		})

		it('makes no SDK call and triggers no revalidation of its own', async () => {
			frappePostCall.mockClear()
			frappeSWRMutate.mockClear()

			renderDialog(makeServerMessagesError('Nothing was posted'))
			await userEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }))

			expect(frappePostCall).not.toHaveBeenCalled()
			expect(frappeSWRMutate).not.toHaveBeenCalled()
		})

		it('is not dismissed by a click outside, because the refusal must be acknowledged', async () => {
			const { store } = renderDialog(makeServerMessagesError('Nothing was posted'))

			await userEvent.click(getOverlay())

			expect(store.get(bankRecErrorDialogAtom)).not.toBeNull()
			expect(screen.getByRole('alertdialog')).toBeInTheDocument()
		})
	})

	/*
	 * Focus is the whole reason this dialog is worth specifying twice.
	 *
	 * Radix's alert dialog deliberately declines its own default autofocus and focuses the CANCEL control
	 * instead, so that a keyboard lands on the safe way out of a destructive prompt rather than on the
	 * destructive button. That design has one consequence which is easy to miss: with no cancel control
	 * rendered there is nothing for it to focus, focus stays on <body> OUTSIDE the focus scope, and the
	 * trap never engages either - Radix contains focus by watching where it moves away from inside the
	 * scope, and focus was never inside it to begin with. So Tab walked straight into the page behind a
	 * modal reporting a refusal, and dismissal returned focus to <body>.
	 *
	 * The tests below therefore pin the MECHANISM (the control is Radix's cancel slot) alongside the
	 * OUTCOME (focus starts inside, stays inside, and comes back somewhere real).
	 */
	describe('focus management', () => {

		/**
		 * Mounts the dialog inside the SPA's real `#root` element, with a focusable control behind it.
		 *
		 * The element id matters: `#root` is what the dialog marks `inert` while it is open, and it is
		 * where focus is placed as a last resort. RTL's default container is an anonymous div, so without
		 * this neither behaviour would be reachable from a test. The dialog itself portals to <body>, so
		 * it lands OUTSIDE this element - which is exactly what lets the background be inert while the
		 * dialog stays operable.
		 */
		const renderInAppRoot = (error: SeededError | null) => {
			const root = document.createElement('div')
			root.id = 'root'
			document.body.appendChild(root)

			const store = createStore()
			store.set(bankRecErrorDialogAtom, error)

			const view = render(
				<Provider store={store}>
					<button type="button" data-testid="behind">Behind the dialog</button>
					<BankRecErrorDialog />
				</Provider>,
				{ container: root }
			)

			return { store, root, ...view }
		}

		const getDismiss = (): HTMLElement => screen.getByRole('button', { name: DISMISS_LABEL })

		/**
		 * A control that stands in for the row's Reconcile button and can be taken out of the document
		 * mid-test, the way converging with the server takes the real one out.
		 *
		 * Built outside React's tree on purpose. Removing a React-rendered node by hand leaves React
		 * holding a fiber for it, and the teardown that follows throws `NotFoundError` trying to remove it
		 * from a parent it no longer has - which fails the test for a reason that has nothing to do with
		 * focus. This one belongs to nobody but the test.
		 */
		const addStrayOpener = (): HTMLButtonElement => {
			const shell = document.createElement('div')
			const opener = document.createElement('button')
			opener.type = 'button'
			opener.textContent = 'Reconcile'
			shell.appendChild(opener)
			document.body.appendChild(shell)
			return opener
		}

		it('renders the dismiss control as Radix\'s cancel slot, which is what gives it a focus target', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			expect(getDismiss()).toHaveAttribute('data-slot', 'alert-dialog-cancel')
			// The action slot is what it used to be, and an action is never autofocused by an alert dialog.
			expect(document.querySelector('[data-slot="alert-dialog-action"]')).toBeNull()
		})

		it('puts focus on Dismiss as soon as it opens, rather than leaving it on the body', async () => {
			renderInAppRoot(makeServerMessagesError('Nothing was posted'))

			await waitFor(() => {
				expect(getDismiss()).toHaveFocus()
			})
			expect(document.body).not.toHaveFocus()
		})

		it('declares itself modal, so a reader that honours it will not read past the dialog', () => {
			renderDialog(makeServerMessagesError('Nothing was posted'))

			expect(getDialogContent()).toHaveAttribute('aria-modal', 'true')
		})

		it('makes the application behind it inert while it is open', () => {
			const { root } = renderInAppRoot(makeServerMessagesError('Nothing was posted'))

			// `aria-hidden`, which Radix sets, hides the page from a reader but leaves it operable by
			// pointer and by Tab. `inert` is what actually takes it out of play.
			expect(root).toHaveAttribute('inert')
			// And the dialog is not inside the part that was made inert.
			expect(root.contains(getDialogContent())).toBe(false)
		})

		it('gives the application back once it is dismissed', async () => {
			const { root } = renderInAppRoot(makeServerMessagesError('Nothing was posted'))

			await userEvent.click(getDismiss())

			await waitFor(() => {
				expect(root).not.toHaveAttribute('inert')
			})
		})

		it('keeps Tab inside the dialog instead of walking into the page behind it', async () => {
			renderInAppRoot(makeServerMessagesError('Nothing was posted'))

			await waitFor(() => {
				expect(getDismiss()).toHaveFocus()
			})

			await userEvent.tab()

			// One tabbable control, so the trap cycles back to it. What matters is what focus is NOT on.
			expect(screen.getByTestId('behind')).not.toHaveFocus()
			expect(getDialogContent().contains(document.activeElement)).toBe(true)
		})

		it('returns focus to whatever the reviewer was using, when it is still there', async () => {
			const { store, root } = renderInAppRoot(null)

			const opener = screen.getByTestId('behind')
			opener.focus()
			expect(opener).toHaveFocus()

			await act(async () => {
				store.set(bankRecErrorDialogAtom, makeServerMessagesError('Nothing was posted'))
			})

			await waitFor(() => {
				expect(getDismiss()).toHaveFocus()
			})

			await userEvent.click(getDismiss())

			await waitFor(() => {
				expect(opener).toHaveFocus()
			})
			// Nothing was needed from the fallback, so the root is left exactly as it was found.
			expect(root).not.toHaveAttribute('tabindex')
		})

		it('places focus at the top of the application when the control it came from has gone', async () => {
			/*
			 * This is the common case here, not an edge one: converging with the server after a refusal
			 * removes the very row whose Reconcile control was clicked, so by the time the dialog closes
			 * there is nothing left to hand focus back to. Radix focuses a detached node, which silently
			 * does nothing, and focus falls to <body> - no announced position, and Tab starts again from
			 * the top of the document.
			 */
			const { store, root } = renderInAppRoot(null)

			const opener = addStrayOpener()
			opener.focus()

			await act(async () => {
				store.set(bankRecErrorDialogAtom, makeServerMessagesError('Nothing was posted'))
			})
			await waitFor(() => {
				expect(getDismiss()).toHaveFocus()
			})

			// Stand in for the row leaving the list.
			opener.remove()

			await userEvent.click(getDismiss())

			await waitFor(() => {
				expect(root).toHaveFocus()
			})
			expect(document.body).not.toHaveFocus()
			// Focusable programmatically, but NOT a new tab stop for everyone thereafter.
			expect(root).toHaveAttribute('tabindex', '-1')
		})

		it('takes the temporary tabindex back off the root once focus leaves it', async () => {
			const { store, root } = renderInAppRoot(null)

			const opener = addStrayOpener()
			opener.focus()

			await act(async () => {
				store.set(bankRecErrorDialogAtom, makeServerMessagesError('Nothing was posted'))
			})
			await waitFor(() => {
				expect(getDismiss()).toHaveFocus()
			})
			opener.remove()
			await userEvent.click(getDismiss())
			await waitFor(() => {
				expect(root).toHaveFocus()
			})

			// Whatever the reviewer focuses next, the document returns to the shape it had before.
			await act(async () => {
				root.blur()
			})

			await waitFor(() => {
				expect(root).not.toHaveAttribute('tabindex')
			})
		})
	})
})
