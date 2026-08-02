import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { createElement, type PropsWithChildren } from 'react'
import {
	TEST_ALTERNATE_CURRENCY,
	TEST_ALTERNATE_REFERENCE_NUMBER,
	TEST_BANK_ACCOUNT,
	TEST_COMPANY,
	TEST_CURRENCY,
	TEST_REFERENCE_NUMBER,
	TEST_TRANSACTION_DESCRIPTION,
	createFrappeSDKMock,
	formatAlreadyReconciledMessage,
	frappePostCall,
	frappeSDKMock,
	frappeContextValue,
	frappeSWRMutate,
	makeAlreadyReconciledError,
	makeBlankReferenceLinkedPayment,
	makeLinkedPayment,
	makeNullReferenceLinkedPayment,
	makeReconciledTransaction,
	makeSelectedBank,
	makeServerMessagesError,
	makeSuggestedLinkedPayment,
	makeUnreconciledTransaction
} from '@/test/factories'

// The module under test imports the SDK's hooks at module scope, so the package is replaced
// wholesale before it loads. These particular tests exercise only the pure grading helpers, but
// the mock has to be in place for the import itself to succeed, and it keeps the suite unable to
// reach a real transport if a later test drives a hook.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import {
	bankRecBankTransactionsKey,
	bankRecClosingBalanceAsPerStatementKey,
	bankRecClosingBalanceKey,
	bankRecUnreconciledTransactionsKey,
	isFrappeErrorEnvelope,
	matchVoucherDate,
	matchVoucherReference,
	toDisplayError,
	useReconcileTransaction,
	useRefreshImportedTransactions,
	useSelectedBankAccountCurrency,
	useWaitForRuleEvaluation
} from './utils'
import {
	bankRecDateAtom,
	bankRecErrorDialogAtom,
	bankRecReconcileSettlingAtom,
	bankRecSelectedTransactionAtom,
	classifyImportAttempt,
	getImportAttempt,
	IMPORT_ATTEMPT_MARKER_LIMIT,
	selectedBankAccountAtom,
	withCompletedImportAttemptsRetired,
	withImportAttempt,
	withoutImportAttempt,
	type ImportAttemptMarkers
} from './bankRecAtoms'
import { selectedCompanyAtom } from '@/hooks/useCurrentCompany'

/**
 * Reference grading against the four voucher shapes `get_linked_payments` actually returns.
 *
 * The backend unions Payment Entry, Journal Entry, Sales Invoice and Purchase Invoice, and the
 * reference columns are NOT uniform across them: Payment Entry selects the real `reference_no`,
 * both invoice branches select `ConstantColumn("")`, and the Journal Entry branch selects
 * `Max(je.cheque_no)`, which is NULL when no row in the group carries a cheque number. A blank
 * is therefore the NORMAL shape of an invoice row rather than an edge case, and the grader has
 * to treat it as an absence of evidence rather than as agreement.
 */
describe('matchVoucherReference', () => {
	describe('genuine agreement is still recognised', () => {
		it('grades an identical reference as a full match', () => {
			expect(
				matchVoucherReference(TEST_REFERENCE_NUMBER, [TEST_REFERENCE_NUMBER, TEST_TRANSACTION_DESCRIPTION])
			).toBe('full')
		})

		it('grades a reference contained in the description as a partial match', () => {
			expect(matchVoucherReference('ACME', [undefined, TEST_TRANSACTION_DESCRIPTION])).toBe('partial')
		})

		it('prefers full over partial when the reference both equals and is contained', () => {
			// The transaction's description embeds its own reference number, so both terms hold.
			// The stronger grade must win, because the two are now mutually exclusive and the
			// badge reads directly off them.
			expect(
				matchVoucherReference(TEST_REFERENCE_NUMBER, [
					TEST_REFERENCE_NUMBER,
					`payment against ${TEST_REFERENCE_NUMBER}`
				])
			).toBe('full')
		})

		it('grades an unrelated reference as no match', () => {
			expect(
				matchVoucherReference(TEST_ALTERNATE_REFERENCE_NUMBER, [
					TEST_REFERENCE_NUMBER,
					TEST_TRANSACTION_DESCRIPTION
				])
			).toBe('none')
		})

		it('is case-sensitive, because bank references are identifiers', () => {
			expect(matchVoucherReference(TEST_REFERENCE_NUMBER.toLowerCase(), [TEST_REFERENCE_NUMBER])).toBe('none')
		})
	})

	describe('a blank voucher reference is never a match (the invoice branches)', () => {
		it('does not match an empty reference against a populated transaction', () => {
			// This is the regression that mattered: `'…'.includes('')` is ALWAYS true, so before
			// the guard every empty-reference invoice scored a partial match against every
			// transaction that had any reference at all.
			expect(matchVoucherReference('', [TEST_REFERENCE_NUMBER, TEST_TRANSACTION_DESCRIPTION])).toBe('none')
		})

		it('does not match an empty reference against an empty transaction reference', () => {
			// `'' === ''` reads as an exact match to a naive comparison.
			expect(matchVoucherReference('', ['', ''])).toBe('none')
		})

		it('does not match a whitespace-only reference', () => {
			expect(matchVoucherReference('   ', [TEST_REFERENCE_NUMBER])).toBe('none')
			expect(matchVoucherReference('\t\n ', ['   '])).toBe('none')
		})
	})

	describe('a null or absent voucher reference is never a match (the Journal Entry branch)', () => {
		it('does not match a null reference', () => {
			expect(matchVoucherReference(null, [TEST_REFERENCE_NUMBER, TEST_TRANSACTION_DESCRIPTION])).toBe('none')
		})

		it('does not match an undefined reference', () => {
			expect(matchVoucherReference(undefined, [TEST_REFERENCE_NUMBER])).toBe('none')
		})

		it('does not match null against null, which a naive comparison would accept', () => {
			expect(matchVoucherReference(null, [null, null])).toBe('none')
		})
	})

	describe('blank transaction candidates contribute nothing either', () => {
		it('ignores blank and absent candidates while still grading the populated one', () => {
			expect(matchVoucherReference(TEST_REFERENCE_NUMBER, ['', null, undefined, '  ', TEST_REFERENCE_NUMBER])).toBe(
				'full'
			)
		})

		it('returns no match when every candidate is blank or absent', () => {
			expect(matchVoucherReference(TEST_REFERENCE_NUMBER, ['', null, undefined, '   '])).toBe('none')
			expect(matchVoucherReference(TEST_REFERENCE_NUMBER, [])).toBe('none')
		})
	})

	describe('surrounding whitespace is not a difference', () => {
		it('matches a reference that differs only by padding', () => {
			expect(matchVoucherReference(`  ${TEST_REFERENCE_NUMBER}  `, [`\t${TEST_REFERENCE_NUMBER}\n`])).toBe('full')
		})
	})
})

/**
 * Date grading follows the same blank-is-not-evidence rule. `reference_date` is
 * `ConstantColumn("")` on both invoice branches and can be NULL on the Journal Entry branch,
 * while `BankTransaction.date` is itself optional - so a bare `===` reports a match whenever
 * both sides happen to be absent.
 */
describe('matchVoucherDate', () => {
	it('matches identical dates', () => {
		expect(matchVoucherDate('2024-01-15', '2024-01-15')).toBe(true)
	})

	it('does not match different dates', () => {
		expect(matchVoucherDate('2024-01-15', '2024-02-20')).toBe(false)
	})

	it('does not match a blank voucher date against a real transaction date', () => {
		expect(matchVoucherDate('', '2024-01-15')).toBe(false)
	})

	it('does not match blank against blank', () => {
		expect(matchVoucherDate('', '')).toBe(false)
	})

	it('does not match null or undefined against each other', () => {
		expect(matchVoucherDate(null, null)).toBe(false)
		expect(matchVoucherDate(undefined, undefined)).toBe(false)
		expect(matchVoucherDate(null, undefined)).toBe(false)
	})

	it('does not match a real date against an absent transaction date', () => {
		expect(matchVoucherDate('2024-01-15', undefined)).toBe(false)
	})

	it('ignores surrounding whitespace', () => {
		expect(matchVoucherDate(' 2024-01-15 ', '2024-01-15')).toBe(true)
	})
})

/**
 * The grading rules applied to the fixtures that model the real endpoint rows, exercised through
 * the same disjunction `VoucherItem` uses to decide whether to present a voucher as suggested:
 * amount agreement AND (posting date OR reference date OR any reference agreement), at index 0.
 *
 * Amount agreement alone must not be enough. Both blank-reference fixtures deliberately agree on
 * amount and disagree on both dates, which is exactly the combination that used to be promoted to
 * a green, solid-button suggestion by the blank reference alone.
 */
describe('suggestion inputs for the shapes the endpoint really returns', () => {
	const transaction = makeUnreconciledTransaction()

	const gradeVoucher = (voucher: {
		paid_amount: number
		posting_date: string
		reference_no: string | null
		reference_date: string | null
	}) => {
		const amountMatches = voucher.paid_amount === transaction.unallocated_amount
		const postingDateMatches = matchVoucherDate(voucher.posting_date, transaction.date)
		const referenceDateMatches = matchVoucherDate(voucher.reference_date, transaction.date)
		const reference = matchVoucherReference(voucher.reference_no, [
			transaction.reference_number,
			transaction.description
		])
		return {
			amountMatches,
			reference,
			wouldBeSuggested:
				amountMatches && (postingDateMatches || referenceDateMatches || reference !== 'none')
		}
	}

	it('suggests a Payment Entry that genuinely agrees', () => {
		expect(gradeVoucher(makeSuggestedLinkedPayment(transaction))).toEqual({
			amountMatches: true,
			reference: 'full',
			wouldBeSuggested: true
		})
	})

	it('does NOT suggest a Purchase Invoice whose reference columns are empty strings', () => {
		expect(gradeVoucher(makeBlankReferenceLinkedPayment())).toEqual({
			amountMatches: true,
			reference: 'none',
			wouldBeSuggested: false
		})
	})

	it('does NOT suggest a Journal Entry whose reference columns are null', () => {
		expect(gradeVoucher(makeNullReferenceLinkedPayment())).toEqual({
			amountMatches: true,
			reference: 'none',
			wouldBeSuggested: false
		})
	})

	it('still suggests a blank-reference voucher when a DATE genuinely agrees', () => {
		// The guard removes a false signal; it must not suppress a true one. Give the same
		// invoice row a posting date that matches and it is suggested again - on the date's
		// evidence, not the reference's.
		const graded = gradeVoucher(makeBlankReferenceLinkedPayment({ posting_date: transaction.date }))
		expect(graded.reference).toBe('none')
		expect(graded.wouldBeSuggested).toBe(true)
	})
})

/* ────────────────────────────────────────────────────────────────────────────────────
 * The reconcile seam: what the client is allowed to CLAIM, and what it must go and READ.
 *
 * `reconcile_vouchers` is a single server-side operation and its response is the only
 * authority on what was recorded. Everything below tests the two ways a client can betray
 * that: by asserting an outcome it cannot observe, and by continuing to act on a snapshot it
 * has just been told is unreliable.
 * ──────────────────────────────────────────────────────────────────────────────────── */

/** A promise whose settlement the test controls, so an `await` can be observed mid-flight. */
const createDeferred = <T,>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolveFn) => {
		resolve = resolveFn
	})
	return { promise, resolve }
}

const FROM_DATE = '2024-01-01'
const TO_DATE = '2024-01-31'

/** The two EXISTING cache-key families the rejection path revalidates, spelled out in full. */
const UNRECONCILED_KEY = `bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`
const ALL_TRANSACTIONS_KEY = `bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`

const SELECTED_TRANSACTION_ATOM = bankRecSelectedTransactionAtom(TEST_BANK_ACCOUNT)

/**
 * A store seeded with the state the reconcile seam reads: the selected account, the date range
 * that composes both cache keys, and the company the bank-account list is fetched for. Seeding
 * the dates explicitly is what makes the key assertions exact rather than dependent on the
 * calendar month the suite happens to run in.
 */
const createSeededStore = () => {
	const store = createStore()
	store.set(selectedBankAccountAtom, makeSelectedBank())
	store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })
	store.set(selectedCompanyAtom, TEST_COMPANY)
	return store
}

const withStore = (store: ReturnType<typeof createStore>) =>
	({ children }: PropsWithChildren) => createElement(Provider, { store }, children)

describe('useReconcileTransaction — rejection is resolved against the server, not guessed', () => {
	// The hook logs the raw rejection reason before doing anything else, which is deliberate and
	// worth keeping. It is silenced here so a passing suite stays readable, and asserted on in
	// the first test so silencing it cannot hide its removal.
	let consoleError: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		consoleError.mockRestore()
	})

	describe('a rejection carrying no response', () => {
		// `frappe-js-sdk` reads `error.response.data` with no guard, so when no response came back
		// its own TypeError becomes the rejection value. There is no server text to preserve, and -
		// critically - no server ANSWER either.
		const transportFailure = new TypeError("Cannot read properties of undefined (reading 'data')")

		const runRejectedReconcile = async () => {
			const store = createSeededStore()
			const transaction = makeUnreconciledTransaction()
			store.set(SELECTED_TRANSACTION_ATOM, [transaction])
			frappePostCall.mockImplementation(() => Promise.reject(transportFailure))

			const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
			await act(async () => {
				result.current.reconcileTransaction(transaction, makeLinkedPayment())
			})
			return store
		}

		it('never claims that nothing was posted', async () => {
			const store = await runRejectedReconcile()
			const message = store.get(bankRecErrorDialogAtom)?.message ?? ''

			// The whole point of the substitute copy. A lost response proves only that the client
			// never learned the answer; the request may have been delivered, committed and
			// acknowledged into a connection that had already gone away. Asserting otherwise is the
			// client inventing a server-side fact, and it is the dangerous direction to be wrong in
			// for a financial post - a reviewer told nothing happened will repeat the action.
			expect(message).not.toMatch(/nothing was posted/i)
			expect(message).not.toMatch(/was not (posted|recorded|saved)/i)
			expect(message).not.toMatch(/no(thing)? (was )?(recorded|saved)/i)
		})

		it('states the outcome as unknown and sends the reviewer to the server for it', async () => {
			const store = await runRejectedReconcile()
			const message = store.get(bankRecErrorDialogAtom)?.message ?? ''

			expect(message).toMatch(/no response arrived from the server/i)
			expect(message).toMatch(/not known whether this request was recorded/i)
			expect(message).toMatch(/check the current state of the affected records/i)
		})

		it('does not invite a blind retry', async () => {
			const store = await runRejectedReconcile()
			const message = store.get(bankRecErrorDialogAtom)?.message ?? ''

			// "try again" - with no instruction to verify first - is exactly the prompt that turns
			// one indeterminate post into two.
			expect(message).not.toMatch(/try again/i)
		})

		it('reports the transport failure as HTTP 0 rather than inventing a status', async () => {
			const store = await runRejectedReconcile()
			const error = store.get(bankRecErrorDialogAtom)

			expect(error?.httpStatus).toBe(0)
			expect(error?.httpStatusText).toBe('Network Error')
			// No server text exists on this path, so none is fabricated into `exception`.
			expect(error?.exception).toBe('')
		})

		it('logs the raw rejection reason for diagnosis', async () => {
			await runRejectedReconcile()
			expect(consoleError).toHaveBeenCalledWith(transportFailure)
		})
	})

	it('hands a genuine server envelope to the dialog BY IDENTITY', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])

		const serverRejection = makeAlreadyReconciledError(transaction.name)
		frappePostCall.mockImplementation(() => Promise.reject(serverRejection))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// Not cloned, not reshaped, not re-titled: the server's own object, so its wording and its
		// severity reach the reviewer verbatim.
		expect(store.get(bankRecErrorDialogAtom)).toBe(serverRejection)
		expect(store.get(bankRecErrorDialogAtom)?._server_messages).toContain(
			formatAlreadyReconciledMessage(transaction.name)
		)
	})

	it('revalidates BOTH transaction-list keys, byte for byte, and introduces no new key', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(transaction.name)))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		expect(frappeSWRMutate).toHaveBeenCalledWith(UNRECONCILED_KEY)
		expect(frappeSWRMutate).toHaveBeenCalledWith(ALL_TRANSACTIONS_KEY)
		// Exactly two revalidations, so the rejection path cannot have reached for a sixth cache-key
		// family or re-shaped an existing one.
		const revalidatedKeys = frappeSWRMutate.mock.calls.map(([key]) => key)
		expect(revalidatedKeys).toEqual([UNRECONCILED_KEY, ALL_TRANSACTIONS_KEY])
	})

	it('keeps the action closed until the refresh has landed, then reopens it', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(transaction.name)))

		// The refresh is held open, so the window between "the post failed" and "the server has been
		// re-read" becomes observable instead of collapsing into one microtask.
		const refresh = createDeferred<undefined>()
		frappeSWRMutate.mockImplementation(() => refresh.promise)

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })

		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// The post has settled and the dialog is already up - but the client is still holding the
		// pre-attempt snapshot, so the action must stay closed. This is the exact window in which a
		// second post would be fired at state the reviewer has just been told is unreliable.
		expect(store.get(bankRecErrorDialogAtom)).not.toBeNull()
		expect(result.current.loading).toBe(false)
		expect(result.current.isSettling).toBe(true)
		expect(store.get(bankRecReconcileSettlingAtom)).toBe(true)

		await act(async () => {
			refresh.resolve(undefined)
			await refresh.promise
		})

		expect(result.current.isSettling).toBe(false)
		expect(store.get(bankRecReconcileSettlingAtom)).toBe(false)
	})

	it('replaces the selection with the server\u2019s refreshed row, status and all', async () => {
		const store = createSeededStore()
		// What the client believed when it clicked: still unreconciled, fully unallocated.
		const staleSnapshot = makeUnreconciledTransaction({ name: 'ACC-BTN-2024-00003' })
		store.set(SELECTED_TRANSACTION_ATOM, [staleSnapshot])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(staleSnapshot.name)))

		// What the server actually holds: the same transaction, already fully reconciled. It is
		// therefore absent from the unreconciled list and present in the all-transactions list -
		// which is exactly why both keys are refreshed rather than only the first.
		const serverRow = makeReconciledTransaction()
		frappeSWRMutate.mockImplementation((key) =>
			Promise.resolve(key === ALL_TRANSACTIONS_KEY ? { message: [serverRow] } : { message: [] })
		)

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(staleSnapshot, makeLinkedPayment())
		})

		// Taken whole, so `status` and `unallocated_amount` - the two fields the confirm guard reads -
		// can only be the server's values. The guard now disables the action instead of the row
		// silently disappearing with no explanation.
		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([serverRow])
		expect(store.get(SELECTED_TRANSACTION_ATOM)[0].status).toBe('Reconciled')
		expect(store.get(SELECTED_TRANSACTION_ATOM)[0].unallocated_amount).toBe(0)
	})

	it('drops a selected entry the server no longer reports at all', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(transaction.name)))

		// Both lists come back EMPTY. An empty list is an authoritative answer, not an absent one.
		frappeSWRMutate.mockImplementation(() => Promise.resolve({ message: [] }))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
	})

	it('leaves the selection untouched when NEITHER refresh produced rows', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(transaction.name)))

		// Both refreshes came back with nothing to read - they failed in turn, or no mounted hook was
		// there to serve the key. Clearing the selection on the strength of a second failure would be
		// discarding the reviewer's work over an absence of information.
		frappeSWRMutate.mockImplementation(() => Promise.resolve(undefined))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([transaction])
	})

	it('reopens the action even when a refresh rejects in turn', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockImplementation(() => Promise.reject(makeAlreadyReconciledError(transaction.name)))
		frappeSWRMutate.mockImplementation(() => Promise.reject(new Error('revalidation failed')))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// `allSettled` absorbs it, so the failure cannot escape as an unhandled rejection and cannot
		// wedge the affordance closed forever - and the selection is left as it was, because nothing
		// authoritative came back.
		expect(result.current.isSettling).toBe(false)
		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([transaction])
	})
})

/* ────────────────────────────────────────────────────────────────────────────────────
 * The account currency behind the mismatch advisory.
 *
 * `selectedBankAccountAtom` persists through `localStorage`, so the stored bank is a snapshot
 * of a row as it looked whenever it was last chosen. `account_currency` is the field most
 * likely to have moved on without it: it is not stored on `Bank Account` at all, but derived
 * per row by `bank_account.get_list` from the linked `Account.account_currency`.
 * ──────────────────────────────────────────────────────────────────────────────────── */
describe('useSelectedBankAccountCurrency', () => {
	/** One row of `bank_account.get_list`, as the endpoint projects it. */
	const bankListRow = (accountCurrency?: string) => ({
		name: TEST_BANK_ACCOUNT,
		bank: 'Test Bank',
		account_name: 'Test Bank Current Account',
		is_credit_card: 0,
		is_default: 1,
		company: TEST_COMPANY,
		account: 'Test Bank - TC',
		account_type: 'Bank',
		bank_account_no: '000123456789',
		last_integration_date: undefined,
		account_currency: accountCurrency
	})

	const renderWithBankList = (rows: unknown[] | undefined, storedCurrency?: string) => {
		const store = createStore()
		store.set(selectedBankAccountAtom, makeSelectedBank({ account_currency: storedCurrency }))
		store.set(selectedCompanyAtom, TEST_COMPANY)
		frappeSDKMock.useFrappeGetCall.mockImplementation(() => ({
			data: rows === undefined ? undefined : { message: rows },
			error: undefined,
			isLoading: false,
			isValidating: false,
			mutate: () => Promise.resolve(undefined)
		}))
		return renderHook(() => useSelectedBankAccountCurrency(), { wrapper: withStore(store) })
	}

	it('reports the currency the SERVER currently gives for the selected account', () => {
		// The stored snapshot disagrees, and loses. This is the whole finding: a comparison decided
		// from the snapshot can invent a mismatch that no longer exists, or miss one that now does.
		const { result } = renderWithBankList([bankListRow(TEST_ALTERNATE_CURRENCY)], TEST_CURRENCY)
		expect(result.current).toBe(TEST_ALTERNATE_CURRENCY)
	})

	it('returns undefined when the list has not arrived yet', () => {
		const { result } = renderWithBankList(undefined, TEST_CURRENCY)
		// Never the stored value as a stand-in: "not known yet" and "known to differ" are different
		// answers, and only one of them may raise a warning.
		expect(result.current).toBeUndefined()
	})

	it('returns undefined when the selected account is absent from the list', () => {
		const { result } = renderWithBankList([{ ...bankListRow(TEST_CURRENCY), name: 'Other Bank - TC' }], TEST_CURRENCY)
		expect(result.current).toBeUndefined()
	})

	it('returns undefined when the endpoint could not derive a currency for the row', () => {
		// `account_currency` is derived, not stored, so the endpoint can legitimately omit it.
		const { result } = renderWithBankList([bankListRow(undefined)], TEST_CURRENCY)
		expect(result.current).toBeUndefined()
	})

	it('shares the bank picker\u2019s cache entry instead of opening a second request', () => {
		renderWithBankList([bankListRow(TEST_CURRENCY)])

		const [method, params, swrKey] = frappeSDKMock.useFrappeGetCall.mock.calls[0]
		expect(method).toBe('erpnext.accounts.doctype.bank_account.bank_account.get_list')
		expect(params).toEqual({ company: TEST_COMPANY })
		// `undefined` makes the SDK derive its key as `${method}?${encodeQueryData(params)}`, so an
		// identical method and identical params produce a byte-identical key - the SAME cached entry
		// and the same deduped request as `useGetBankAccounts`. Passing a key of its own here is what
		// would silently double the traffic.
		expect(swrKey).toBeUndefined()
	})

	it('leaves revalidateIfStale at its default so mounting it actually refreshes the entry', () => {
		renderWithBankList([bankListRow(TEST_CURRENCY)])

		const options = frappeSDKMock.useFrappeGetCall.mock.calls[0][3] as Record<string, unknown> | undefined
		// `useGetBankAccounts` switches this off, which is what let the shared entry go stale. Not
		// setting it here is the entire mechanism by which this value is fresh, so it is asserted
		// rather than left to be re-disabled by a later well-meaning edit.
		expect(options).not.toHaveProperty('revalidateIfStale')
		// Focus behaviour still matches the sibling hook, so nothing new fires on tab switches.
		expect(options?.revalidateOnFocus).toBe(false)
	})
})

/**
 * The cache-key builders, asserted against LITERAL strings.
 *
 * These assertions are the whole point of the builders existing. Several of these queries run with
 * `revalidateIfStale` and `revalidateOnFocus` disabled, so an entry refreshes only when a writer
 * mutates its exact key - and a key that is wrong by one character invalidates nothing while
 * reporting no error at all. The same strings are additionally spelled inline by four surfaces
 * outside the module (the action log, the balance panel, the unreconcile modal, the clearance
 * summary), so the format is a compatibility contract, not an implementation detail. Comparing
 * against hand-written literals rather than against the builders themselves is what makes these
 * tests capable of catching a "harmless tidy-up" of the format.
 */
describe('cache-key builders produce the exact existing key strings', () => {

	it('builds the unreconciled-transactions key', () => {
		expect(bankRecUnreconciledTransactionsKey('Test Bank - Test Company', '2024-01-01', '2024-01-31'))
			.toBe('bank-reconciliation-unreconciled-transactions-Test Bank - Test Company-2024-01-01-2024-01-31')
	})

	it('builds the all-transactions key', () => {
		expect(bankRecBankTransactionsKey('Test Bank - Test Company', '2024-01-01', '2024-01-31'))
			.toBe('bank-reconciliation-bank-transactions-Test Bank - Test Company-2024-01-01-2024-01-31')
	})

	it('builds the closing-balance key', () => {
		expect(bankRecClosingBalanceKey('Test Bank - Test Company', '2024-01-31'))
			.toBe('bank-reconciliation-account-closing-balance-Test Bank - Test Company-2024-01-31')
	})

	it('builds the closing-balance-as-per-statement key', () => {
		expect(bankRecClosingBalanceAsPerStatementKey('Test Bank - Test Company', '2024-01-31'))
			.toBe('bank-reconciliation-account-closing-balance-as-per-statement-Test Bank - Test Company-2024-01-31')
	})

	// The closing-balance and as-per-statement families share a prefix, which is exactly the kind
	// of near-collision a careless edit could turn into an actual collision.
	it('keeps the two balance families distinct', () => {
		const balance = bankRecClosingBalanceKey(TEST_BANK_ACCOUNT, TO_DATE)
		const statement = bankRecClosingBalanceAsPerStatementKey(TEST_BANK_ACCOUNT, TO_DATE)
		expect(balance).not.toBe(statement)
		expect(statement.startsWith('bank-reconciliation-account-closing-balance-as-per-statement-')).toBe(true)
	})

	// The two keys the reconcile rejection path revalidates are built by these functions, so the
	// Phase-4 assertions and these builders must agree on the same two strings.
	it('agrees with the literal keys the reconcile path revalidates', () => {
		expect(bankRecUnreconciledTransactionsKey(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)).toBe(UNRECONCILED_KEY)
		expect(bankRecBankTransactionsKey(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)).toBe(ALL_TRANSACTIONS_KEY)
	})
})

/**
 * Import-attempt classification.
 *
 * The rule that matters: `Not Started` is the INITIAL status and `insert_transactions` advances it
 * to `Completed` only as its final act, so it is nonterminal for the entire duration of a
 * synchronous import. Observing it after a lost response therefore distinguishes nothing - the
 * import may have rolled back, may still be running, or may have committed with the response lost.
 * Calling that "failed" is the client inventing a server-side fact, and it is the dangerous
 * direction to be wrong in, because a reviewer told the import failed will re-import.
 */
describe('classifyImportAttempt', () => {

	it('treats a confirmed Completed as completed, even when the server also refused', () => {
		expect(classifyImportAttempt({ serverRejected: true, confirmedStatus: 'Completed' })).toBe('completed')
	})

	it('treats a confirmed Completed as completed after a lost response', () => {
		expect(classifyImportAttempt({ serverRejected: false, confirmedStatus: 'Completed' })).toBe('completed')
	})

	it('marks failed only when the server refused AND the log is confirmed not completed', () => {
		expect(classifyImportAttempt({ serverRejected: true, confirmedStatus: 'Not Started' })).toBe('failed')
	})

	// The regression this whole helper exists to prevent.
	it('does NOT mark failed when a lost response leaves the log at Not Started', () => {
		expect(classifyImportAttempt({ serverRejected: false, confirmedStatus: 'Not Started' })).toBe('unknown')
	})

	it('marks unknown when no status could be obtained at all', () => {
		expect(classifyImportAttempt({ serverRejected: false, confirmedStatus: undefined })).toBe('unknown')
	})

	// A server refusal whose follow-up read also failed: the refusal is real, but nothing confirms
	// the log's state, so the honest answer is still unknown.
	it('marks unknown when the server refused but the log could not be read', () => {
		expect(classifyImportAttempt({ serverRejected: true, confirmedStatus: undefined })).toBe('unknown')
	})

	it('never returns a status that asserts failure from an ambiguous observation', () => {
		const ambiguous = [
			{ serverRejected: false, confirmedStatus: undefined },
			{ serverRejected: false, confirmedStatus: 'Not Started' as const },
			{ serverRejected: true, confirmedStatus: undefined }
		]
		ambiguous.forEach((observation) => {
			expect(classifyImportAttempt(observation)).not.toBe('failed')
		})
	})
})

/**
 * Marker storage, which is bank-scoped because visibility and retention are both per-account: the
 * importer list queries one bank with its own row limit. A flat map counted other accounts' markers
 * against that budget, so switching accounts could silently evict a marker whose row was on screen.
 */
describe('import-attempt marker storage is scoped per bank account', () => {

	const OTHER_BANK = 'Other Bank - Test Company'

	it('records a marker under its own bank', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(getImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1')).toBe('failed')
	})

	it('does not leak a marker into a different bank', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(getImportAttempt(markers, OTHER_BANK, 'LOG-1')).toBeUndefined()
	})

	it('returns undefined when no bank is selected', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(getImportAttempt(markers, undefined, 'LOG-1')).toBeUndefined()
	})

	it('keeps two banks\' markers independent', () => {
		let markers: ImportAttemptMarkers = {}
		markers = withImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		markers = withImportAttempt(markers, OTHER_BANK, 'LOG-2', 'unknown')
		expect(getImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1')).toBe('failed')
		expect(getImportAttempt(markers, OTHER_BANK, 'LOG-2')).toBe('unknown')
	})

	// The M3 regression: filling one bank to the cap must not disturb another bank's marker.
	it('caps per bank, so a busy account cannot evict another account\'s visible marker', () => {
		let markers: ImportAttemptMarkers = withImportAttempt({}, OTHER_BANK, 'KEEP-ME', 'failed')

		for (let index = 0; index < IMPORT_ATTEMPT_MARKER_LIMIT + 5; index++) {
			markers = withImportAttempt(markers, TEST_BANK_ACCOUNT, `LOG-${index}`, 'failed')
		}

		expect(getImportAttempt(markers, OTHER_BANK, 'KEEP-ME')).toBe('failed')
		expect(Object.keys(markers[TEST_BANK_ACCOUNT])).toHaveLength(IMPORT_ATTEMPT_MARKER_LIMIT)
	})

	it('evicts oldest-first within a bank and retains the newest', () => {
		let markers: ImportAttemptMarkers = {}
		for (let index = 0; index < IMPORT_ATTEMPT_MARKER_LIMIT + 1; index++) {
			markers = withImportAttempt(markers, TEST_BANK_ACCOUNT, `LOG-${index}`, 'failed')
		}
		expect(getImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-0')).toBeUndefined()
		expect(getImportAttempt(markers, TEST_BANK_ACCOUNT, `LOG-${IMPORT_ATTEMPT_MARKER_LIMIT}`)).toBe('failed')
	})

	it('returns the same object when re-recording an identical marker', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(withImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')).toBe(markers)
	})

	it('retires one marker and drops the bank entry once it is empty', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		const cleared = withoutImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1')
		expect(getImportAttempt(cleared, TEST_BANK_ACCOUNT, 'LOG-1')).toBeUndefined()
		expect(TEST_BANK_ACCOUNT in cleared).toBe(false)
	})

	it('is a no-op when retiring a marker that was never recorded', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(withoutImportAttempt(markers, TEST_BANK_ACCOUNT, 'ABSENT')).toBe(markers)
		expect(withoutImportAttempt(markers, OTHER_BANK, 'LOG-1')).toBe(markers)
	})

	// Server truth retires markers, and only for the bank whose logs were actually re-read.
	it('retires markers the server reports Completed, within that bank only', () => {
		let markers: ImportAttemptMarkers = {}
		markers = withImportAttempt(markers, TEST_BANK_ACCOUNT, 'LOG-1', 'unknown')
		markers = withImportAttempt(markers, OTHER_BANK, 'LOG-1', 'failed')

		const retired = withCompletedImportAttemptsRetired(markers, TEST_BANK_ACCOUNT, ['LOG-1'])

		expect(getImportAttempt(retired, TEST_BANK_ACCOUNT, 'LOG-1')).toBeUndefined()
		expect(getImportAttempt(retired, OTHER_BANK, 'LOG-1')).toBe('failed')
	})

	it('is a no-op when no retained marker is among the completed logs', () => {
		const markers = withImportAttempt({}, TEST_BANK_ACCOUNT, 'LOG-1', 'failed')
		expect(withCompletedImportAttemptsRetired(markers, TEST_BANK_ACCOUNT, ['LOG-9'])).toBe(markers)
		expect(withCompletedImportAttemptsRetired(markers, OTHER_BANK, ['LOG-1'])).toBe(markers)
	})
})

/**
 * Post-import cache invalidation.
 *
 * `useGetUnreconciledTransactions` runs with `revalidateIfStale` and `revalidateOnFocus` both
 * disabled, so remounting it - which is exactly what navigating to the reconciliation page does -
 * does not refetch. If an entry for the imported range is already populated, the page renders that
 * cached copy and the freshly imported transactions are simply absent, with nothing anywhere to
 * explain it. Mutating the exact keys, and awaiting it before navigation, is the whole fix.
 */
describe('useRefreshImportedTransactions', () => {

	beforeEach(() => {
		frappeSWRMutate.mockClear()
		frappeSWRMutate.mockResolvedValue(undefined)
	})

	it('revalidates the four keys the imported range affects, byte-for-byte', async () => {
		const { result } = renderHook(() => useRefreshImportedTransactions())

		await act(async () => {
			await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([
			`bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`,
			`bank-reconciliation-bank-transactions-${TEST_BANK_ACCOUNT}-${FROM_DATE}-${TO_DATE}`,
			`bank-reconciliation-account-closing-balance-${TEST_BANK_ACCOUNT}-${TO_DATE}`,
			`bank-reconciliation-account-closing-balance-as-per-statement-${TEST_BANK_ACCOUNT}-${TO_DATE}`
		])
	})

	// The dates are arguments, not atom reads, precisely so the range invalidated is the one the
	// import resolved rather than whatever the page was previously filtered to.
	it('builds the keys from the dates it is given, not from the date atom', async () => {
		const { result } = renderHook(() => useRefreshImportedTransactions())

		await act(async () => {
			await result.current(TEST_BANK_ACCOUNT, '2023-06-01', '2023-06-30')
		})

		const keys = frappeSWRMutate.mock.calls.map(([key]) => key)
		expect(keys[0]).toBe(`bank-reconciliation-unreconciled-transactions-${TEST_BANK_ACCOUNT}-2023-06-01-2023-06-30`)
		keys.forEach((key) => {
			expect(key).not.toContain(FROM_DATE)
			expect(key).not.toContain(TO_DATE)
		})
	})

	// A balance query failing must not stop the transaction lists refreshing - the page the caller
	// is continuing to takes its value from those lists.
	it('still refreshes the remaining keys when one revalidation rejects, and does not throw', async () => {
		frappeSWRMutate.mockRejectedValueOnce(new Error('balance unavailable'))

		const { result } = renderHook(() => useRefreshImportedTransactions())

		await act(async () => {
			await expect(result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)).resolves.toBeUndefined()
		})

		expect(frappeSWRMutate).toHaveBeenCalledTimes(4)
	})
})

/**
 * Waiting for rule evaluation.
 *
 * `insert_transactions` calls `run_rule_evaluation`, which enqueues the evaluator with
 * `enqueue_after_commit` defaulting to False - so the job can be picked up BEFORE the import's
 * commit, find none of the new rows, and return having stamped nothing. Re-invoking the endpoint
 * from the client is what makes this deterministic: it happens after the import's response has been
 * received, so the import has already committed and the job it enqueues cannot miss the rows.
 */
describe('useWaitForRuleEvaluation', () => {

	beforeEach(() => {
		frappePostCall.mockReset()
		frappePostCall.mockResolvedValue({ message: null })
		frappeContextValue.db.getCount.mockReset()
	})

	it('re-triggers evaluation and reports convergence once nothing is left unevaluated', async () => {
		frappeContextValue.db.getCount.mockResolvedValue(0)

		const { result } = renderHook(() => useWaitForRuleEvaluation())

		let converged: boolean | undefined
		await act(async () => {
			converged = await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(converged).toBe(true)
		expect(frappePostCall).toHaveBeenCalledTimes(1)
		expect(frappeContextValue.db.getCount).toHaveBeenCalledTimes(1)
	})

	/*
	 * The filters must mirror the evaluator's own selection, and must watch `is_rule_evaluated`
	 * rather than `matched_transaction_rule`. The evaluator sets `is_rule_evaluated = 1` for every
	 * transaction it considers, whether or not a rule matched, so a remaining count of zero is a
	 * positive statement that evaluation has been applied. Counting matched rules instead would be
	 * indistinguishable from "evaluated, and no rule matched" - it would never converge.
	 */
	it('counts unevaluated transactions in the imported range, mirroring the evaluator\'s filters', async () => {
		frappeContextValue.db.getCount.mockResolvedValue(0)

		const { result } = renderHook(() => useWaitForRuleEvaluation())
		await act(async () => {
			await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		const [doctype, filters] = frappeContextValue.db.getCount.mock.calls[0]
		expect(doctype).toBe('Bank Transaction')
		expect(filters).toEqual([
			['bank_account', '=', TEST_BANK_ACCOUNT],
			['date', 'between', [FROM_DATE, TO_DATE]],
			['docstatus', '=', 1],
			['status', '=', 'Unreconciled'],
			['is_rule_evaluated', '=', 0]
		])
	})

	// The trigger is a best-effort improvement, not a precondition: scheduled evaluation will still
	// reach these rows, so a failed trigger must not stop the client observing convergence.
	it('still polls when the re-trigger itself is refused', async () => {
		frappePostCall.mockRejectedValue(new Error('enqueue refused'))
		frappeContextValue.db.getCount.mockResolvedValue(0)

		const { result } = renderHook(() => useWaitForRuleEvaluation())

		let converged: boolean | undefined
		await act(async () => {
			converged = await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(converged).toBe(true)
	})

	// Not converged is reported honestly rather than retried blindly.
	it('reports not-converged, without looping, when the count cannot be read', async () => {
		frappeContextValue.db.getCount.mockRejectedValue(new Error('no permission'))

		const { result } = renderHook(() => useWaitForRuleEvaluation())

		let converged: boolean | undefined
		await act(async () => {
			converged = await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(converged).toBe(false)
		expect(frappeContextValue.db.getCount).toHaveBeenCalledTimes(1)
	})

	// The wait is a convenience, never a correctness requirement, so it must always END. A worker
	// that never drains the range must not strand the user on the import screen.
	it('gives up after a bounded number of attempts rather than waiting forever', async () => {
		vi.useFakeTimers()
		try {
			frappeContextValue.db.getCount.mockResolvedValue(3)

			const { result } = renderHook(() => useWaitForRuleEvaluation())

			let converged: boolean | undefined
			const pending = result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE).then((value) => { converged = value })

			await vi.advanceTimersByTimeAsync(60_000)
			await pending

			expect(converged).toBe(false)
			// Bounded: a fixed number of polls, not one per tick of the clock.
			expect(frappeContextValue.db.getCount.mock.calls.length).toBeLessThanOrEqual(10)
			expect(frappeContextValue.db.getCount.mock.calls.length).toBeGreaterThan(1)
		} finally {
			vi.useRealTimers()
		}
	})
})

/*
 * The error-normalisation boundary.
 *
 * Six call sites now depend on this pair: the reconcile rejection handler, the import rejection
 * handler, and four ErrorBanner render sites. Two properties have to hold for all of them, and
 * they pull in opposite directions, which is why they are pinned here rather than assumed:
 *
 *  - a genuine server envelope must survive UNTOUCHED, so the backend's own message, title and
 *    severity are what the user reads; and
 *  - anything that is not an envelope must never reach the user, because for a lost response the
 *    SDK hands back its own `TypeError` about `error.response.data` - an implementation detail
 *    that says nothing about whether the work was recorded.
 */
describe('error normalisation at the transport boundary', () => {

	const SDK_INTERNAL_TEXT = "Cannot read properties of undefined (reading 'data')"

	it('passes a genuine Frappe envelope through BY IDENTITY', () => {
		const envelope = makeServerMessagesError('The bank account is disabled. Please enable it')

		// toBe, not toEqual: a copy would be just as wrong as a rewrite, because it invites a
		// later "improvement" to the copied fields.
		expect(toDisplayError(envelope)).toBe(envelope)
	})

	it('converts a response-less SDK TypeError into indeterminate transport copy', () => {
		const sdkFailure = new TypeError(SDK_INTERNAL_TEXT)

		const displayed = toDisplayError(sdkFailure)

		expect(displayed.httpStatus).toBe(0)
		expect(displayed.httpStatusText).toBe('Network Error')
		expect(displayed.message).toContain('No response arrived from the server')
		expect(displayed.message).toContain('it is not known whether this request was recorded')
		expect(displayed.message).toContain('Check the current state of the affected records')
	})

	it('never leaks the SDK implementation text to the surface', () => {
		const rendered = JSON.stringify(toDisplayError(new TypeError(SDK_INTERNAL_TEXT)))

		expect(rendered).not.toContain(SDK_INTERNAL_TEXT)
		expect(rendered).not.toContain('Cannot read properties')
		expect(rendered).not.toContain('undefined')
		expect(rendered).not.toContain('TypeError')
		expect(rendered).not.toContain('.data')
	})

	it('never claims the action failed or was not recorded', () => {
		// The whole point of the copy: the outcome is UNKNOWN. Wording that asserts failure would
		// invite a blind retry of work that may already have been committed.
		const message = toDisplayError(new TypeError(SDK_INTERNAL_TEXT)).message.toLowerCase()

		expect(message).not.toContain('failed')
		expect(message).not.toContain('was not')
		expect(message).not.toContain('no changes')
	})

	it.each([
		['a plain Error', new Error('boom')],
		['a string', 'boom'],
		['undefined', undefined],
		['null', null],
		['an empty object', {}],
		['an object with only a message', { message: 'boom' }]
	])('treats %s as a lost response rather than an envelope', (_label, reason) => {
		expect(isFrappeErrorEnvelope(reason)).toBe(false)
		expect(toDisplayError(reason).httpStatus).toBe(0)
	})

	it('recognises an envelope carrying only the fallback error field', () => {
		// Frappe does not always populate _server_messages; the fallback path must still count as
		// a real server answer, or a genuine rejection would be relabelled as a transport loss.
		const envelope = { httpStatus: 417, httpStatusText: 'Expectation Failed', message: 'x', exception: '' }

		expect(isFrappeErrorEnvelope(envelope)).toBe(true)
		expect(toDisplayError(envelope)).toBe(envelope)
	})
})
