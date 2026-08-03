import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createFrappeSDKMock,
	emitFrappeEvent,
	frappeContextValue,
	frappePostCall,
	frappeSDKMock,
	frappeSWRMutate,
	getFrappeEventListener,
	makeBankStatementImportLog,
	makeImportSuccessResponse,
	makeMessageOnlyError,
	makeSelectedBank,
	makeServerMessagesError,
	resetFrappeSDKMock,
	TEST_BANK_ACCOUNT
} from '@/test/factories'

// Replaces the SDK wholesale: the import post, the document read behind the rejection path, the
// realtime channel and the bank-account list are all supplied by this suite. Declared here because
// `vi.mock` is hoisted above the imports.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

// `vi.mock` factories are hoisted above every `import` in this file, so any binding they close over
// has to be created by `vi.hoisted` rather than by a plain `const` — a plain `const` is still in its
// temporal dead zone when the factory runs.
const { navigate, toastSuccess, toastError } = vi.hoisted(() => ({
	navigate: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn()
}))

// Only the navigation seam is stubbed; `Link` and the rest of the router come from MemoryRouter, so
// the component's own markup is exercised unchanged.
vi.mock('react-router', async () => {
	const actual = await vi.importActual<typeof import('react-router')>('react-router')
	return { ...actual, useNavigate: () => navigate }
})

vi.mock('sonner', () => ({
	toast: { success: toastSuccess, error: toastError }
}))

import StatementDetails from './StatementDetails'
import {
	bankRecDateAtom,
	bankRecErrorDialogAtom,
	bankRecImportFailuresAtom,
	getImportAttempt,
	selectedBankAccountAtom
} from '../../BankReconciliation/bankRecAtoms'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GetStatementDetailsResponse } from '../import_utils'
import type { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'

const LOG_NAME = 'importlog01'
const FROM_DATE = '2024-03-01'
const TO_DATE = '2024-03-31'

const IMPORT_PROGRESS_CHANNEL = 'bank-rec-statement-import-progress'

const emptyRead = {
	data: undefined,
	error: undefined,
	isLoading: false,
	isValidating: false,
	mutate: vi.fn(() => Promise.resolve(undefined))
}

const makeLog = (overrides: Partial<BankStatementImportLog> = {}): BankStatementImportLog =>
	makeBankStatementImportLog({
		name: LOG_NAME,
		bank_account: TEST_BANK_ACCOUNT,
		file: '/private/files/march.csv',
		status: 'Not Started',
		number_of_transactions: 2,
		start_date: FROM_DATE,
		end_date: TO_DATE,
		...overrides
	})

/** The server's parse result for a two-row statement, in the shape the endpoint really returns. */
const makeStatementDetails = (
	overrides: Partial<GetStatementDetailsResponse> = {}
): GetStatementDetailsResponse => ({
	doc: makeLog(),
	conflicting_transactions: [],
	final_transactions: [
		{ date: FROM_DATE, withdrawal: 0, deposit: 110, description: 'First imported row', reference: 'IMP001' },
		{ date: TO_DATE, withdrawal: 45, deposit: 0, description: 'Second imported row', reference: 'IMP002' }
	],
	date_format: '%Y-%m-%d',
	raw_data: [],
	currency: 'INR',
	...overrides
})

const renderDetails = (data: GetStatementDetailsResponse = makeStatementDetails()) => {
	frappeSDKMock.useFrappeGetCall.mockImplementation((method) =>
		method.endsWith('bank_account.get_list')
			? { ...emptyRead, data: { message: [makeSelectedBank({ name: TEST_BANK_ACCOUNT })] } }
			: emptyRead)

	const store = createStore()
	store.set(selectedBankAccountAtom, makeSelectedBank({ name: TEST_BANK_ACCOUNT }))
	store.set(bankRecDateAtom, { fromDate: '2020-01-01', toDate: '2020-01-31' })

	const utils = render(
		<MemoryRouter>
			<Provider store={store}>
				<TooltipProvider>
					<StatementDetails data={data} />
				</TooltipProvider>
			</Provider>
		</MemoryRouter>
	)

	return { ...utils, store }
}

const importButton = () => screen.queryByRole('button', { name: /Import \d+ transactions?/ })

describe('StatementDetails', () => {

	beforeEach(() => {
		resetFrappeSDKMock()
		navigate.mockClear()
		toastSuccess.mockClear()
		toastError.mockClear()
		// The rule-evaluation wait asks how many rules exist before doing anything. Zero is the
		// default-site answer and short-circuits the wait, which is what keeps these tests fast.
		frappeContextValue.db.getCount.mockResolvedValue(0)
	})

	/**
	 * TC1 - a valid statement is imported and the reviewer is handed to the reconciliation page with
	 * the imported range in view.
	 *
	 * The ORDER of the continuation is the substance of this test, not decoration. The date range has
	 * to come from the SERVER's copy of the saved document, because that is the range the new
	 * transactions actually fall in; the cache entries for that range have to be invalidated BEFORE
	 * navigation, because the unreconciled query does not refetch on mount while its entry still
	 * holds data; and only then may the hand-off happen.
	 */
	describe('a valid import', () => {

		it('posts exactly one document-method call, with the log and the method name the server expects', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeImportSuccessResponse([makeLog({ status: 'Completed' })]))

			renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(navigate).toHaveBeenCalled())

			const importCall = frappePostCall.mock.calls.find(([params]) => params.method === 'insert_transactions')
			expect(importCall).toBeDefined()
			expect((importCall?.[0] as { docs: BankStatementImportLog }).docs.name).toBe(LOG_NAME)
			// Exactly one: nothing retries a financial post.
			expect(frappePostCall.mock.calls.filter(([params]) => params.method === 'insert_transactions')).toHaveLength(1)
		})

		it('moves the reconciliation date range to the range the SERVER resolved, not the one on screen', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeImportSuccessResponse([
				makeLog({ status: 'Completed', start_date: '2024-06-05', end_date: '2024-06-25' })
			]))

			const { store } = renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(navigate).toHaveBeenCalled())

			expect(store.get(bankRecDateAtom)).toEqual({ fromDate: '2024-06-05', toDate: '2024-06-25' })
		})

		it('invalidates the imported range\'s cache entries BEFORE navigating', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeImportSuccessResponse([makeLog({ status: 'Completed' })]))

			renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))

			const keys = frappeSWRMutate.mock.calls.map(([key]) => key)
			expect(keys).toContain(`bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`)
			expect(keys).toContain(`bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`)
			// Emptied, not merely asked to revalidate: with no subscriber mounted a bare revalidation
			// has no revalidator to run, and the reconciliation page would then render its cached copy.
			frappeSWRMutate.mock.calls.forEach((call) => {
				expect(call).toHaveLength(3)
				expect(call[1]).toBeUndefined()
			})
		})

		it('reports success and hands off to the reconciliation page', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeImportSuccessResponse([makeLog({ status: 'Completed' })]))

			renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
			expect(toastSuccess).toHaveBeenCalled()
			expect(toastError).not.toHaveBeenCalled()
		})

		it('records no failure marker for an import that succeeded', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeImportSuccessResponse([makeLog({ status: 'Completed' })]))

			const { store } = renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(navigate).toHaveBeenCalled())

			expect(getImportAttempt(store.get(bankRecImportFailuresAtom), TEST_BANK_ACCOUNT, LOG_NAME)).toBeUndefined()
		})
	})

	/**
	 * The Import affordance during the continuation.
	 *
	 * Neither of the two signals this control used to read is truthful in that window: `data` is the
	 * parent's never-revalidated `get_statement_details` response, so its status still says
	 * `Not Started` after the server has recorded the import, and the post hook's `loading` flag
	 * flips back the instant the response lands - before the rule-evaluation wait and the cache
	 * invalidation have finished. Between them, an ENABLED "Import 2 transactions" button reappeared
	 * for work the server had already committed, and invited a re-click on it.
	 */
	describe('the Import control during the continuation', () => {

		it('is enabled before the import, and disabled the moment one is dispatched', async () => {
			const user = userEvent.setup()
			let releaseImport: (value: unknown) => void = () => undefined
			frappePostCall.mockImplementation(() => new Promise((resolve) => { releaseImport = resolve }))

			renderDetails()

			const button = screen.getByRole('button', { name: 'Import 2 transactions' })
			expect(button).toBeEnabled()

			await user.click(button)

			await waitFor(() => {
				expect(screen.getByRole('button', { name: /Importing/ })).toBeDisabled()
			})
			expect(importButton()).not.toBeInTheDocument()

			await act(async () => {
				releaseImport(makeImportSuccessResponse([makeLog({ status: 'Completed' })]))
			})
		})

		/*
		 * The heart of it: the server has answered, the continuation is still running, and the
		 * control must not be offering the action again. The wait is held open by a pending rule
		 * count so the assertion lands inside that window rather than after it.
		 */
		it('never re-enables between the server\'s response and the hand-off', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeImportSuccessResponse([makeLog({ status: 'Completed' })]))

			let releaseRuleCount: (value: number) => void = () => undefined
			frappeContextValue.db.getCount.mockImplementation(() => new Promise<number>((resolve) => { releaseRuleCount = resolve }))

			renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			// The post has resolved (the continuation is waiting on the rule count), so this is
			// exactly the window in which the control used to reappear.
			await waitFor(() => expect(frappePostCall).toHaveBeenCalled())

			expect(importButton()).not.toBeInTheDocument()
			expect(navigate).not.toHaveBeenCalled()

			await act(async () => {
				releaseRuleCount(0)
			})

			await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
		})

		// Once the server has confirmed, the control is not merely disabled - it is replaced by the
		// same badge the server-derived status renders. There is nothing left to click.
		it('is replaced by the Completed badge once the server confirms', async () => {
			const user = userEvent.setup()
			frappePostCall.mockResolvedValue(makeImportSuccessResponse([makeLog({ status: 'Completed' })]))

			let releaseRuleCount: (value: number) => void = () => undefined
			frappeContextValue.db.getCount.mockImplementation(() => new Promise<number>((resolve) => { releaseRuleCount = resolve }))

			renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(screen.getByText('Completed')).toBeInTheDocument())
			expect(importButton()).not.toBeInTheDocument()

			await act(async () => {
				releaseRuleCount(0)
			})
		})

		// A log the server already reports as completed shows the badge and no control at all,
		// which is the behaviour that existed before and must not change.
		it('offers no control at all for a log the server already reports as completed', () => {
			renderDetails(makeStatementDetails({ doc: makeLog({ status: 'Completed' }) }))

			expect(importButton()).not.toBeInTheDocument()
			expect(screen.getByText('Completed')).toBeInTheDocument()
		})

		// FM2's zero-row case: the server parsed the file without raising but found nothing to
		// import, so the action is closed and the reason is stated rather than left to be guessed.
		it('is disabled, with the reason stated, when the server parsed no transactions', () => {
			renderDetails(makeStatementDetails({ final_transactions: [] }))

			expect(screen.getByRole('button', { name: 'Import 0 transactions' })).toBeDisabled()
			expect(screen.getByText('No transactions found in this statement')).toBeInTheDocument()
		})
	})

	/**
	 * FM2 - a rejected import.
	 *
	 * A rejection is not by itself evidence that the import did not happen: the request may have been
	 * received and committed with only the response lost. So the server is asked what the log
	 * actually says before anything is recorded or shown, and its answer decides between three
	 * outcomes. What must never happen on any of them is a client-side transaction, or a claim about
	 * the server that the client cannot support.
	 */
	describe('a rejected import', () => {

		it('surfaces the server\'s own message, verbatim, in the shared error dialog', async () => {
			const user = userEvent.setup()
			const serverError = makeServerMessagesError('Not permitted to import into this bank account')
			frappePostCall.mockRejectedValue(serverError)
			frappeContextValue.db.getDoc.mockResolvedValue(makeLog({ status: 'Not Started' }))

			const { store } = renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(store.get(bankRecErrorDialogAtom)).toBeTruthy())
			// BY IDENTITY: the envelope is not cloned, reshaped or paraphrased on its way to the user.
			expect(store.get(bankRecErrorDialogAtom)).toBe(serverError)
			expect(toastError).toHaveBeenCalled()
		})

		it('consults the server about the log before recording anything', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(makeServerMessagesError('Invalid file type'))
			frappeContextValue.db.getDoc.mockResolvedValue(makeLog({ status: 'Not Started' }))

			renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(frappeContextValue.db.getDoc).toHaveBeenCalled())
			expect(frappeContextValue.db.getDoc).toHaveBeenCalledWith('Bank Statement Import Log', LOG_NAME)
		})

		// The server refused AND the log is confirmed not completed: only now is "this did not take
		// effect" something the client has been told rather than guessed.
		it('records the attempt as failed when the server itself refused', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(makeServerMessagesError('Invalid file type'))
			frappeContextValue.db.getDoc.mockResolvedValue(makeLog({ status: 'Not Started' }))

			const { store } = renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => {
				expect(getImportAttempt(store.get(bankRecImportFailuresAtom), TEST_BANK_ACCOUNT, LOG_NAME)).toBe('failed')
			})
		})

		/*
		 * A lost response carries no Frappe envelope at all, so the server never said anything. The
		 * log sitting at its initial `Not Started` cannot distinguish a rollback from a commit whose
		 * response went missing, so the honest record is `unknown` - claiming failure there would
		 * invite a re-import of work that may already exist.
		 */
		it('records the attempt as unknown when no response came back', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'data')"))
			frappeContextValue.db.getDoc.mockResolvedValue(makeLog({ status: 'Not Started' }))

			const { store } = renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => {
				expect(getImportAttempt(store.get(bankRecImportFailuresAtom), TEST_BANK_ACCOUNT, LOG_NAME)).toBe('unknown')
			})
		})

		// ... and what the user reads in that case is transport copy that names the outcome as
		// unknown, never the SDK's internal TypeError text.
		it('replaces a response-less rejection with outcome-indeterminate copy', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'data')"))
			frappeContextValue.db.getDoc.mockResolvedValue(makeLog({ status: 'Not Started' }))

			const { store } = renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(store.get(bankRecErrorDialogAtom)).toBeTruthy())

			const shown = store.get(bankRecErrorDialogAtom)
			expect(shown?.message).toContain('No response arrived from the server')
			expect(shown?.message).not.toContain('Cannot read properties of undefined')
		})

		// Server truth outranks the rejection: if the log says the import completed, it completed,
		// and the success continuation runs instead of a failure being reported.
		it('treats a confirmed-Completed log as a success even though the call rejected', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(makeMessageOnlyError('Network Error'))
			frappeContextValue.db.getDoc.mockResolvedValue(makeLog({ status: 'Completed' }))

			const { store } = renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
			expect(toastSuccess).toHaveBeenCalled()
			expect(store.get(bankRecErrorDialogAtom)).toBeNull()
			expect(getImportAttempt(store.get(bankRecImportFailuresAtom), TEST_BANK_ACCOUNT, LOG_NAME)).toBeUndefined()
		})

		// The retry path. An attempt that did not take effect is the one case where re-offering the
		// action is correct, so the control has to come back.
		//
		// The reviewer reaches it by dismissing the error first: the dialog is modal, so while it is
		// open Radix marks the page behind it `aria-hidden` and the control is - correctly - absent
		// from the accessibility tree. Dismissing is therefore part of the assertion, not a
		// workaround for one: what is being pinned is that the reviewer who reads the error can then
		// act on it.
		it('re-opens the control after an attempt that did not take effect', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(makeServerMessagesError('Invalid file type'))
			frappeContextValue.db.getDoc.mockResolvedValue(makeLog({ status: 'Not Started' }))

			renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(toastError).toHaveBeenCalled())
			expect(importButton()).toBeNull()

			await user.click(await screen.findByRole('button', { name: 'Dismiss' }))

			await waitFor(() => expect(importButton()).toBeEnabled())
		})

		it('does not navigate away when the import did not take effect', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(makeServerMessagesError('Invalid file type'))
			frappeContextValue.db.getDoc.mockResolvedValue(makeLog({ status: 'Not Started' }))

			renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => expect(toastError).toHaveBeenCalled())
			expect(navigate).not.toHaveBeenCalled()
		})

		// The confirmation read failing leaves the outcome unknown rather than being guessed either
		// way - and the handler must not escape as an unhandled rejection.
		it('stays with unknown when even the confirmation read fails', async () => {
			const user = userEvent.setup()
			frappePostCall.mockRejectedValue(makeServerMessagesError('Invalid file type'))
			frappeContextValue.db.getDoc.mockRejectedValue(new Error('confirmation unavailable'))

			const { store } = renderDetails()
			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			await waitFor(() => {
				expect(getImportAttempt(store.get(bankRecImportFailuresAtom), TEST_BANK_ACCOUNT, LOG_NAME)).toBe('unknown')
			})
		})

		// A retry supersedes what the previous attempt observed, so the stale marker goes BEFORE the
		// request rather than after it resolves.
		it('clears the previous marker as the retry is dispatched', async () => {
			const user = userEvent.setup()
			let releaseImport: (value: unknown) => void = () => undefined
			frappePostCall.mockImplementation(() => new Promise((resolve) => { releaseImport = resolve }))

			const { store } = renderDetails()
			store.set(bankRecImportFailuresAtom, { [TEST_BANK_ACCOUNT]: { [LOG_NAME]: 'failed' } })

			await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }))

			expect(getImportAttempt(store.get(bankRecImportFailuresAtom), TEST_BANK_ACCOUNT, LOG_NAME)).toBeUndefined()

			await act(async () => {
				releaseImport(makeImportSuccessResponse([makeLog({ status: 'Completed' })]))
			})
		})
	})

	/**
	 * The realtime progress channel. The server publishes to it while writing the transactions, so
	 * the subscription is the only thing telling the reviewer that a long import is progressing -
	 * and the channel name is a contract with the server that must not drift.
	 */
	describe('realtime import progress', () => {

		it('subscribes to the channel the server publishes on', () => {
			renderDetails()

			expect(getFrappeEventListener(IMPORT_PROGRESS_CHANNEL)).toBeDefined()
		})

		it('shows progress only once the server reports some', () => {
			renderDetails()

			expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 50 })
			})

			expect(screen.getByRole('progressbar')).toBeInTheDocument()
		})

		// The published figure has to reach the reviewer, so both the way it is drawn and the way it
		// is written out are pinned. The design-system `Progress` primitive expresses its value as
		// the indicator's `translateX` offset and as its own caption - it consumes `value` itself
		// rather than forwarding it to the Radix root - so the bar carries no `aria-valuenow`, and
		// the count beside it is what states the figure in words.
		it('follows the server\'s own progress values', () => {
			renderDetails()

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 50 })
			})
			expect(document.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({ transform: 'translateX(-50%)' })
			expect(screen.getByText('Importing 50 transactions')).toBeInTheDocument()

			act(() => {
				emitFrappeEvent(IMPORT_PROGRESS_CHANNEL, { progress: 100, total: 2 })
			})
			expect(document.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({ transform: 'translateX(-0%)' })
			expect(screen.getByText('Importing 100 transactions')).toBeInTheDocument()
		})
	})

	/**
	 * The statement summary. Every figure here is read off the SERVER's parse result, and a reviewer
	 * compares them against the paper statement before committing anything, so they are worth
	 * pinning against the payload rather than assumed.
	 */
	describe('the statement summary', () => {

		it('renders the server\'s resolved date range and transaction count', () => {
			renderDetails()

			expect(screen.getByText('1st March 2024 to 31st March 2024')).toBeInTheDocument()
			expect(screen.getByText('Import 2 transactions')).toBeInTheDocument()
		})

		it('previews every transaction the server intends to import', () => {
			renderDetails()

			expect(screen.getByText('First imported row')).toBeInTheDocument()
			expect(screen.getByText('Second imported row')).toBeInTheDocument()
			expect(screen.getByText('IMP001')).toBeInTheDocument()
			expect(screen.getByText('IMP002')).toBeInTheDocument()
		})

		// FM4: the backend reports the overlap as an advisory. It is shown, and it does NOT close the
		// action - the reviewer decides, and nothing is deduplicated client-side.
		it('shows a conflict advisory without blocking the import', () => {
			renderDetails(makeStatementDetails({
				conflicting_transactions: [{
					name: 'ACC-BTN-2024-00001',
					date: FROM_DATE,
					withdrawal: 0,
					deposit: 110,
					description: 'First imported row',
					reference_number: 'IMP001',
					currency: 'INR'
				}]
			}))

			expect(screen.getAllByText('Conflicting Transactions').length).toBeGreaterThan(0)
			expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled()
		})
	})
})
