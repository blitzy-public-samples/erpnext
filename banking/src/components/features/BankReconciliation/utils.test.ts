import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { createElement, type PropsWithChildren } from 'react'
import Fuse from 'fuse.js'
import { toast } from 'sonner'
import {
	TEST_ALTERNATE_CURRENCY,
	TEST_ALTERNATE_REFERENCE_NUMBER,
	TEST_BANK,
	TEST_BANK_ACCOUNT,
	TEST_COMPANY,
	TEST_CURRENCY,
	TEST_REFERENCE_NUMBER,
	TEST_TRANSACTION_AMOUNT,
	TEST_TRANSACTION_DATE,
	TEST_TRANSACTION_DESCRIPTION,
	TEST_TRANSACTION_RULE,
	createFrappeSDKMock,
	formatAlreadyReconciledMessage,
	frappeHookMutate,
	frappePostCall,
	frappeSDKMock,
	frappeContextValue,
	frappeSWRMutate,
	makeAlreadyReconciledError,
	makeAlternateLinkedPayment,
	makeBankTransaction,
	makeBlankReferenceLinkedPayment,
	makeLinkedPayment,
	makeNullReferenceLinkedPayment,
	makeReconcileSuccessResponse,
	makeReconciledTransaction,
	makeRuleMatchedTransaction,
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
	getSearchResults,
	isFrappeErrorEnvelope,
	matchVoucherDate,
	matchVoucherReference,
	toDisplayError,
	useGetAccountClosingBalance,
	useGetAccountClosingBalanceAsPerStatement,
	useGetAccountOpeningBalance,
	useGetBankAccounts,
	useGetBankTransactions,
	useGetRuleForTransaction,
	useGetUnreconciledTransactions,
	useGetVouchersForTransaction,
	useIsTransactionWithdrawal,
	useReconcileTransaction,
	useRefreshImportedTransactions,
	useRefreshUnreconciledTransactions,
	useSelectedBankAccountCurrency,
	useTransactionSearch,
	useUpdateActionLog,
	useWaitForRuleEvaluation,
	type UnreconciledTransaction
} from './utils'
import {
	bankRecActionLog,
	bankRecAmountFilter,
	bankRecDateAtom,
	bankRecErrorDialogAtom,
	bankRecMatchFilters,
	bankRecReconcileSettlingAtom,
	bankRecSearchText,
	bankRecSelectedTransactionAtom,
	bankRecTransactionTypeFilter,
	bankRecUnreconcileModalAtom,
	classifyImportAttempt,
	getImportAttempt,
	IMPORT_ATTEMPT_MARKER_LIMIT,
	selectedBankAccountAtom,
	withCompletedImportAttemptsRetired,
	withImportAttempt,
	withoutImportAttempt,
	type ActionLog,
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

	it('invalidates the four keys the imported range affects, byte-for-byte', async () => {
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

	/*
	 * THE DEFECT THIS PINS. SWR's keyed mutate performs a bare `mutate(key)` by invoking the key's
	 * registered revalidator, and revalidators are registered by MOUNTED subscribers. When an import
	 * finishes, the reconciliation page is not mounted, so the imported range's keys have none: the
	 * call resolves, nothing is fetched, and the populated entry survives. The unreconciled query
	 * then mounts with `revalidateIfStale: false` and skips its mount fetch precisely BECAUSE the
	 * entry still holds data - so a second import into an already-cached range rendered the
	 * pre-import list with no error anywhere to explain it.
	 *
	 * Passing `undefined` as the DATA argument is a cache WRITE, which applies with or without a
	 * subscriber and leaves the entry holding nothing; SWR's mount check ("fetch if there is no
	 * data OR stale revalidation is enabled") then fetches. Every call must therefore carry three
	 * arguments, and the second must be `undefined` - a two-argument call is the silent no-op.
	 */
	it('EMPTIES each entry rather than merely asking it to revalidate', async () => {
		const { result } = renderHook(() => useRefreshImportedTransactions())

		await act(async () => {
			await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(frappeSWRMutate).toHaveBeenCalledTimes(4)

		frappeSWRMutate.mock.calls.forEach((call) => {
			// Three arguments, not one: the length is what decides between a cache write and a
			// revalidate-only request inside SWR.
			expect(call).toHaveLength(3)
			const [, data, options] = call
			expect(data).toBeUndefined()
			// `revalidate` covers the case where a subscriber IS mounted, so the emptied entry is
			// refilled at once instead of waiting for a remount.
			expect(options).toEqual({ revalidate: true, populateCache: true })
		})
	})

	// Nothing but emptiness is written. A hook that supplied its own payload could put a
	// differently-parameterised response where a query's own answer belongs; the server stays the
	// only source of what is displayed.
	it('never writes data of its own into any entry', async () => {
		const { result } = renderHook(() => useRefreshImportedTransactions())

		await act(async () => {
			await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(frappeSWRMutate.mock.calls.every(([, data]) => data === undefined)).toBe(true)
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

	/**
	 * The hook reads TWO counts of two different doctypes - how many rules exist, then how many
	 * transactions in the range are still unevaluated - so the stub answers by doctype rather than
	 * with one blanket value. A blanket value would have the rule read swallow the answer meant for
	 * the pending read, which is a silent mis-setup rather than a failure.
	 */
	const stubCounts = ({ rules, pending }: { rules: number | Error, pending: number | Error }) => {
		frappeContextValue.db.getCount.mockImplementation(async (doctype: string) => {
			const answer = doctype === 'Bank Transaction Rule' ? rules : pending
			if (answer instanceof Error) {
				throw answer
			}
			return answer
		})
	}

	/** Every call the hook made against the pending-transaction count, in order. */
	const pendingCountCalls = () =>
		frappeContextValue.db.getCount.mock.calls.filter(([doctype]) => doctype === 'Bank Transaction')

	beforeEach(() => {
		frappePostCall.mockReset()
		frappePostCall.mockResolvedValue({ message: null })
		frappeContextValue.db.getCount.mockReset()
	})

	/*
	 * THE DEFECT THIS PINS. `_run_rule_evaluation` reads every `Bank Transaction Rule` and returns
	 * immediately when there are none - WITHOUT stamping anything. So on a site with no rules
	 * `is_rule_evaluated` stays 0 for every imported transaction however often the evaluator runs,
	 * the hook's exit condition is unreachable, and the poll exhausts its whole bound EVERY time.
	 * That delayed every import on a default site by the full bound while the server had already
	 * finished. Nothing is triggered either: there is no work for the evaluator to do.
	 */
	it('does not trigger evaluation or poll at all when the site has no rules', async () => {
		stubCounts({ rules: 0, pending: 2 })

		const { result } = renderHook(() => useWaitForRuleEvaluation())

		let converged: boolean | undefined
		await act(async () => {
			converged = await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		// Converged, because no suggested match is still on its way - none will ever arrive.
		expect(converged).toBe(true)
		expect(frappePostCall).not.toHaveBeenCalled()
		expect(pendingCountCalls()).toHaveLength(0)
		expect(frappeContextValue.db.getCount).toHaveBeenCalledTimes(1)
	})

	/*
	 * The rule count must carry NO filters, because the evaluator's own query carries none - it
	 * considers every rule, disabled or not. Narrowing here could disagree with the server about
	 * whether there is any work to wait for.
	 */
	it('mirrors the evaluator\'s unfiltered rule query', async () => {
		stubCounts({ rules: 0, pending: 0 })

		const { result } = renderHook(() => useWaitForRuleEvaluation())
		await act(async () => {
			await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		const [doctype, filters] = frappeContextValue.db.getCount.mock.calls[0]
		expect(doctype).toBe('Bank Transaction Rule')
		expect(filters).toBeUndefined()
	})

	it('re-triggers evaluation and reports convergence once nothing is left unevaluated', async () => {
		stubCounts({ rules: 1, pending: 0 })

		const { result } = renderHook(() => useWaitForRuleEvaluation())

		let converged: boolean | undefined
		await act(async () => {
			converged = await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(converged).toBe(true)
		expect(frappePostCall).toHaveBeenCalledTimes(1)
		expect(pendingCountCalls()).toHaveLength(1)
	})

	/*
	 * An unreadable rule count is NOT evidence that there are no rules: `Bank Transaction Rule` read
	 * access is a separate grant from the `Bank Transaction` read this endpoint requires. The
	 * bounded trigger and poll therefore still run.
	 */
	it('still triggers and polls when the rule count cannot be read', async () => {
		stubCounts({ rules: new Error('no permission on Bank Transaction Rule'), pending: 0 })

		const { result } = renderHook(() => useWaitForRuleEvaluation())

		let converged: boolean | undefined
		await act(async () => {
			converged = await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(converged).toBe(true)
		expect(frappePostCall).toHaveBeenCalledTimes(1)
		expect(pendingCountCalls()).toHaveLength(1)
	})

	/*
	 * The filters must mirror the evaluator's own selection, and must watch `is_rule_evaluated`
	 * rather than `matched_transaction_rule`. The evaluator sets `is_rule_evaluated = 1` for every
	 * transaction it considers, whether or not a rule matched, so a remaining count of zero is a
	 * positive statement that evaluation has been applied. Counting matched rules instead would be
	 * indistinguishable from "evaluated, and no rule matched" - it would never converge.
	 */
	it('counts unevaluated transactions in the imported range, mirroring the evaluator\'s filters', async () => {
		stubCounts({ rules: 1, pending: 0 })

		const { result } = renderHook(() => useWaitForRuleEvaluation())
		await act(async () => {
			await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		const [doctype, filters] = pendingCountCalls()[0]
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
		stubCounts({ rules: 1, pending: 0 })

		const { result } = renderHook(() => useWaitForRuleEvaluation())

		let converged: boolean | undefined
		await act(async () => {
			converged = await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(converged).toBe(true)
	})

	// Not converged is reported honestly rather than retried blindly.
	it('reports not-converged, without looping, when the pending count cannot be read', async () => {
		stubCounts({ rules: 1, pending: new Error('no permission') })

		const { result } = renderHook(() => useWaitForRuleEvaluation())

		let converged: boolean | undefined
		await act(async () => {
			converged = await result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)
		})

		expect(converged).toBe(false)
		expect(pendingCountCalls()).toHaveLength(1)
	})

	// The wait is a convenience, never a correctness requirement, so it must always END. A worker
	// that never drains the range must not strand the user on the import screen.
	it('gives up after a bounded number of attempts rather than waiting forever', async () => {
		vi.useFakeTimers()
		try {
			// Rules DO exist here, so the wait is legitimate: what is being pinned is that a range
			// which never drains still ends, rather than that it is skipped.
			stubCounts({ rules: 2, pending: 3 })

			const { result } = renderHook(() => useWaitForRuleEvaluation())

			let converged: boolean | undefined
			const pending = result.current(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE).then((value) => { converged = value })

			await vi.advanceTimersByTimeAsync(60_000)
			await pending

			expect(converged).toBe(false)
			// Bounded: a fixed number of polls, not one per tick of the clock.
			expect(pendingCountCalls().length).toBeLessThanOrEqual(10)
			expect(pendingCountCalls().length).toBeGreaterThan(1)
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

/* ════════════════════════════════════════════════════════════════════════════════════
 * THE TRANSPORT CONTRACT: endpoints, parameters, cache keys and SWR options.
 *
 * Everything below pins the exact strings this module hands the SDK. They are asserted as
 * LITERALS rather than rebuilt from the module's own helpers, because a test that recomputes a
 * value with the same expression it is testing proves only that the expression is
 * deterministic. The five cache-key families in particular are also spelled inline by surfaces
 * OUTSIDE this module - the action log, the balance panel, the unreconcile modal and the
 * clearance summary - and several of these queries switch `revalidateIfStale` and
 * `revalidateOnFocus` off, so an entry refreshes ONLY when a writer mutates that exact key. A
 * key that drifts by one character therefore invalidates nothing: the call succeeds, no error
 * is raised, and a stale list simply stays on screen. That failure is invisible at compile time
 * and at run time alike, which is the whole reason these literals are asserted here.
 * ════════════════════════════════════════════════════════════════════════════════════ */

/** The two `bank_reconciliation_tool` reads and the one write, by their dotted RPC paths. */
const GET_BANK_TRANSACTIONS =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_bank_transactions'
const GET_LINKED_PAYMENTS =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_linked_payments'
const RECONCILE_VOUCHERS =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.reconcile_vouchers'
const GET_ACCOUNT_BALANCE =
	'erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_account_balance'

/** The two `bank_account` reads. */
const GET_CLOSING_BALANCE_AS_PER_STATEMENT =
	'erpnext.accounts.doctype.bank_account.bank_account.get_closing_balance_as_per_statement'
const BANK_ACCOUNT_GET_LIST = 'erpnext.accounts.doctype.bank_account.bank_account.get_list'

/** The remaining three key families, spelled out exactly as the module builds them. */
const CLOSING_BALANCE_KEY = `bank-reconciliation-account-closing-balance-${TEST_BANK_ACCOUNT}-${TO_DATE}`
const CLOSING_BALANCE_AS_PER_STATEMENT_KEY =
	`bank-reconciliation-account-closing-balance-as-per-statement-${TEST_BANK_ACCOUNT}-${TO_DATE}`

/**
 * The voucher-list key. The trailing segment is the match filters JOINED WITH COMMAS, and it is
 * passed in already joined so the expectation states the literal suffix rather than re-running
 * the module's own `join(',')`.
 */
const vouchersKeyFor = (transactionName: string, joinedMatchFilters: string): string =>
	`bank-reconciliation-vouchers-${transactionName}-${FROM_DATE}-${TO_DATE}-${joinedMatchFilters}`

/** The default `bankRecMatchFilters` value, already joined - the suffix nearly every key carries. */
const DEFAULT_JOINED_MATCH_FILTERS = 'payment_entry,journal_entry'

/**
 * Every cache-key family this module is permitted to build. C4 fixes the set at FIVE: the
 * reconciliation surfaces share these keys with modules that spell them inline, so introducing a
 * sixth would silently orphan those writers. Ordered longest-first, because the
 * as-per-statement family is itself prefixed by the closing-balance family and a shortest-match
 * lookup would attribute it to the wrong one.
 */
const KEY_FAMILY_PREFIXES = [
	'bank-reconciliation-account-closing-balance-as-per-statement-',
	'bank-reconciliation-account-closing-balance-',
	'bank-reconciliation-unreconciled-transactions-',
	'bank-reconciliation-bank-transactions-',
	'bank-reconciliation-vouchers-'
]

/** The family a key belongs to, or `undefined` for a key from outside the permitted set. */
const familyOf = (key: unknown): string | undefined =>
	typeof key === 'string' ? KEY_FAMILY_PREFIXES.find((prefix) => key.startsWith(prefix)) : undefined

/**
 * The SWR options members this suite asserts on.
 *
 * Declared locally, and reached from an `unknown` parameter, so the captured argument can be read
 * without widening anything to `any` and without importing the library's own deeply generic
 * configuration type. `onSuccess` is narrowed to the ONE parameter production reads - the fetched
 * payload - because that is the whole of the contract being asserted: the hook forwards
 * `data?.message` to its caller's callback.
 */
interface AssertedSwrOptions {
	revalidateOnFocus?: boolean
	revalidateIfStale?: boolean
	onSuccess?: (data?: { message?: unknown[] }) => void
}

const swrOptionsOf = (options: unknown): AssertedSwrOptions => (options ?? {}) as AssertedSwrOptions

/**
 * The most recent `useFrappeGetCall` invocation for a dotted endpoint path, as a
 * `[method, params, swrKey, options, type]` tuple.
 *
 * The LAST matching call rather than the first, because a hook may legitimately render more than
 * once and the final render is the state the component settles in. Two hooks share
 * `get_bank_transactions` and two share `get_account_balance`, so each is rendered in isolation
 * below and the endpoint alone identifies the call.
 */
const lastGetCallFor = (method: string) => {
	const calls = frappeSDKMock.useFrappeGetCall.mock.calls.filter(([calledMethod]) => calledMethod === method)
	expect(calls.length).toBeGreaterThan(0)
	return calls[calls.length - 1]
}

/** The same, for the one document read this module performs. */
const lastGetDocCall = () => {
	const calls = frappeSDKMock.useFrappeGetDoc.mock.calls
	expect(calls.length).toBeGreaterThan(0)
	return calls[calls.length - 1]
}

/**
 * Answers ONE endpoint with a payload and every other with the harness's "no data yet" response.
 *
 * Branching on the method rather than blanket-returning matters because a single render reaches
 * `useFrappeGetCall` several times with different endpoints, and a blanket answer would feed one
 * endpoint's payload to all of them.
 */
const answerGetCall = (method: string, data: unknown): void => {
	frappeSDKMock.useFrappeGetCall.mockImplementation((calledMethod) =>
		calledMethod === method
			? { data, error: undefined, isLoading: false, isValidating: false, mutate: frappeHookMutate }
			: { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: frappeHookMutate })
}

/** A store with a selected account and date range, but NO company - the empty-selection case. */
const createStoreWithoutBank = () => {
	const store = createStore()
	store.set(selectedBankAccountAtom, null)
	store.set(bankRecDateAtom, { fromDate: FROM_DATE, toDate: TO_DATE })
	store.set(selectedCompanyAtom, TEST_COMPANY)
	return store
}

describe('the balance queries', () => {

	/*
	 * `get_account_balance` is reached by two hooks with the SAME endpoint and DIFFERENT
	 * `till_date` values, which is the one thing about this pair worth pinning: the opening
	 * balance is the balance as at the day BEFORE the range starts, so a hook that passed
	 * `fromDate` would report the closing balance of the first day as the opening balance of the
	 * range and every subsequent figure would be off by one day's movement.
	 */
	it('asks for the opening balance as at the day BEFORE the range starts', () => {
		const store = createSeededStore()

		renderHook(() => useGetAccountOpeningBalance(), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(GET_ACCOUNT_BALANCE)

		expect(method).toBe(GET_ACCOUNT_BALANCE)
		expect(params).toEqual({
			bank_account: TEST_BANK_ACCOUNT,
			company: TEST_COMPANY,
			// FROM_DATE is 2024-01-01, so the day before is the last day of the previous year -
			// asserted as a literal precisely because that rollover is where an off-by-one hides.
			till_date: '2023-12-31'
		})
		// No explicit key: this query is content-addressed by SWR from its method and params, and
		// nothing mutates it by name.
		expect(swrKey).toBeUndefined()
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
	})

	it('asks for the closing balance as at the end of the range, under the closing-balance key', () => {
		const store = createSeededStore()

		renderHook(() => useGetAccountClosingBalance(), { wrapper: withStore(store) })

		const [method, params, swrKey] = lastGetCallFor(GET_ACCOUNT_BALANCE)

		expect(method).toBe(GET_ACCOUNT_BALANCE)
		expect(params).toEqual({
			bank_account: TEST_BANK_ACCOUNT,
			company: TEST_COMPANY,
			till_date: TO_DATE
		})
		// Named, because the reconcile success path revalidates this exact string.
		expect(swrKey).toBe(CLOSING_BALANCE_KEY)
	})

	it('reads the statement closing balance from the bank account, under its own distinct key', () => {
		const store = createSeededStore()

		renderHook(() => useGetAccountClosingBalanceAsPerStatement(), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(GET_CLOSING_BALANCE_AS_PER_STATEMENT)

		expect(method).toBe(GET_CLOSING_BALANCE_AS_PER_STATEMENT)
		expect(params).toEqual({ bank_account: TEST_BANK_ACCOUNT, date: TO_DATE })
		expect(swrKey).toBe(CLOSING_BALANCE_AS_PER_STATEMENT_KEY)
		// Distinct from the ledger closing balance, even though both are "the closing balance":
		// one is what the ledger says, the other what the statement says, and the whole point of
		// the reconciliation is that they may disagree.
		expect(swrKey).not.toBe(CLOSING_BALANCE_KEY)
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
	})

	// The caller's config is spread AFTER the hook's own default, so a caller can opt back into
	// focus revalidation. That ordering is the contract; the reverse would silently ignore it.
	it('lets a caller override the default SWR configuration', () => {
		const store = createSeededStore()

		renderHook(() => useGetAccountClosingBalanceAsPerStatement({ revalidateOnFocus: true }), {
			wrapper: withStore(store)
		})

		expect(swrOptionsOf(lastGetCallFor(GET_CLOSING_BALANCE_AS_PER_STATEMENT)[3]).revalidateOnFocus).toBe(true)
	})
})

describe('the transaction-list queries', () => {

	/*
	 * TC1's client-side half: the reconciliation workbench lists the unreconciled transactions
	 * for the selected account and range. The endpoint filters `unallocated_amount > 0`
	 * server-side, so this list is "still reconcilable" by construction.
	 */
	it('lists unreconciled transactions for the selected account and range', () => {
		const store = createSeededStore()

		renderHook(() => useGetUnreconciledTransactions(), { wrapper: withStore(store) })

		const [method, params, swrKey] = lastGetCallFor(GET_BANK_TRANSACTIONS)

		expect(method).toBe(GET_BANK_TRANSACTIONS)
		expect(params).toEqual({
			bank_account: TEST_BANK_ACCOUNT,
			from_date: FROM_DATE,
			to_date: TO_DATE
		})
		// No `all_transactions`, so the server's own filter applies.
		expect(params).not.toHaveProperty('all_transactions')
		expect(swrKey).toBe(UNRECONCILED_KEY)
	})

	/*
	 * BOTH flags off is what makes every writer's explicit invalidation load-bearing: the entry
	 * does not refresh on focus and does not refresh on mount when already populated, so
	 * anything that changes bank transactions server-side - reconciling, importing a statement -
	 * has to mutate this key by name or the reviewer keeps looking at the previous answer.
	 */
	it('refreshes only when its key is mutated, never on focus and never merely because it is stale', () => {
		const store = createSeededStore()

		renderHook(() => useGetUnreconciledTransactions(), { wrapper: withStore(store) })

		const options = swrOptionsOf(lastGetCallFor(GET_BANK_TRANSACTIONS)[3])
		expect(options.revalidateOnFocus).toBe(false)
		expect(options.revalidateIfStale).toBe(false)
	})

	// A null key is SWR's "do not fetch" signal. Without it the query would run with
	// `bank_account: undefined` and cache the answer under a key containing the text "undefined".
	it('does not fetch unreconciled transactions at all when no bank account is selected', () => {
		const store = createStoreWithoutBank()

		renderHook(() => useGetUnreconciledTransactions(), { wrapper: withStore(store) })

		expect(lastGetCallFor(GET_BANK_TRANSACTIONS)[2]).toBeNull()
	})

	/*
	 * ⚠️ `all_transactions: true` is the single parameter that separates this query from the one
	 * above, and it is what makes the already-reconciled confirm guard genuinely user-visible
	 * rather than theoretical: it bypasses the server-side `unallocated_amount > 0` filter, so
	 * rows the server considers fully reconciled DO render in the "Bank Transactions" tab, with a
	 * confirm affordance that has to be disabled on the client.
	 */
	it('lists ALL transactions - reconciled ones included - for the Bank Transactions tab', () => {
		const store = createSeededStore()

		renderHook(() => useGetBankTransactions(), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(GET_BANK_TRANSACTIONS)

		expect(method).toBe(GET_BANK_TRANSACTIONS)
		expect(params).toEqual({
			bank_account: TEST_BANK_ACCOUNT,
			from_date: FROM_DATE,
			to_date: TO_DATE,
			all_transactions: true
		})
		expect(swrKey).toBe(ALL_TRANSACTIONS_KEY)
		// Deliberately no SWR configuration: this view keeps the library's defaults, unlike its
		// unreconciled sibling.
		expect(options).toBeUndefined()
	})

	it('does not fetch all transactions either when no bank account is selected', () => {
		const store = createStoreWithoutBank()

		renderHook(() => useGetBankTransactions(), { wrapper: withStore(store) })

		expect(lastGetCallFor(GET_BANK_TRANSACTIONS)[2]).toBeNull()
	})

	// The two lists must never collide in the cache: they are served by the same endpoint with
	// different filtering, so a shared key would have one answer overwriting the other.
	it('keeps the two transaction lists on separate cache keys', () => {
		expect(UNRECONCILED_KEY).not.toBe(ALL_TRANSACTIONS_KEY)
	})
})

describe('the candidate-voucher query', () => {

	/*
	 * TC3's data source: the vouchers a reviewer may link a transaction to instead of the
	 * suggestion. The key carries the transaction name AND the joined match filters, because
	 * changing either produces a genuinely different candidate list.
	 */
	it('asks for the linked payments of one transaction, keyed by transaction and filters', () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()

		renderHook(() => useGetVouchersForTransaction(transaction), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(GET_LINKED_PAYMENTS)

		expect(method).toBe(GET_LINKED_PAYMENTS)
		expect(params).toEqual({
			bank_transaction_name: transaction.name,
			document_types: ['payment_entry', 'journal_entry'],
			from_date: FROM_DATE,
			to_date: TO_DATE,
			filter_by_reference_date: 0
		})
		expect(swrKey).toBe(vouchersKeyFor(transaction.name, DEFAULT_JOINED_MATCH_FILTERS))
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
	})

	// Widening the filters must reach the server AND change the key, or the reviewer would be
	// shown the narrower cached list under a query they have just broadened.
	it('carries a widened filter set into both the request and the cache key', () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(bankRecMatchFilters, ['payment_entry', 'journal_entry', 'sales_invoice', 'purchase_invoice'])

		renderHook(() => useGetVouchersForTransaction(transaction), { wrapper: withStore(store) })

		const [, params, swrKey] = lastGetCallFor(GET_LINKED_PAYMENTS)

		expect(params).toMatchObject({
			document_types: ['payment_entry', 'journal_entry', 'sales_invoice', 'purchase_invoice']
		})
		expect(swrKey).toBe(
			vouchersKeyFor(transaction.name, 'payment_entry,journal_entry,sales_invoice,purchase_invoice')
		)
	})

	// Two transactions under review must not share a candidate list.
	it('keys the candidate list per transaction', () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction()
		const second = makeReconciledTransaction()

		renderHook(() => useGetVouchersForTransaction(first), { wrapper: withStore(store) })
		const firstKey = lastGetCallFor(GET_LINKED_PAYMENTS)[2]

		renderHook(() => useGetVouchersForTransaction(second), { wrapper: withStore(store) })
		const secondKey = lastGetCallFor(GET_LINKED_PAYMENTS)[2]

		expect(firstKey).toBe(vouchersKeyFor(first.name, DEFAULT_JOINED_MATCH_FILTERS))
		expect(secondKey).toBe(vouchersKeyFor(second.name, DEFAULT_JOINED_MATCH_FILTERS))
		expect(firstKey).not.toBe(secondKey)
	})
})


/**
 * Renders every keyed query this module owns in a single pass, so the FULL set of cache keys the
 * module can produce is observable from one render.
 *
 * A named `use…` function rather than an inline arrow because it genuinely is a custom hook - it
 * calls seven hooks unconditionally - and naming it that way is what keeps the hook rules
 * satisfied and the intent readable.
 */
const useEveryKeyedQuery = (transaction: UnreconciledTransaction): void => {
	useGetAccountClosingBalance()
	useGetAccountClosingBalanceAsPerStatement()
	useGetUnreconciledTransactions()
	useGetBankTransactions()
	useGetVouchersForTransaction(transaction)
	// Included so an unkeyed query cannot smuggle a key in unnoticed: both of these pass
	// `undefined` and are content-addressed by SWR from their method and parameters.
	useGetAccountOpeningBalance()
	useGetBankAccounts()
}

/**
 * C4: the cache-key surface is CLOSED at five families.
 *
 * This is the assertion that makes the other key assertions binding rather than merely present.
 * Each family above is checked individually, but only a census can catch a SIXTH family being
 * introduced - and a sixth family is the specific failure C4 forbids, because these keys are
 * shared with modules that spell them inline and cannot follow a rename.
 */
describe('the cache-key surface is closed at five families', () => {

	it('produces keys from all five families and from no other', () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()

		renderHook(() => useEveryKeyedQuery(transaction), { wrapper: withStore(store) })

		// Every non-null, non-undefined key handed to SWR by any query in the module.
		const declaredKeys = frappeSDKMock.useFrappeGetCall.mock.calls
			.map(([, , swrKey]) => swrKey)
			.filter((swrKey): swrKey is string => typeof swrKey === 'string')

		expect(declaredKeys.length).toBeGreaterThan(0)
		// Nothing outside the permitted set.
		expect(declaredKeys.filter((key) => familyOf(key) === undefined)).toEqual([])
		// And all five genuinely in use, so a family cannot be quietly retired either.
		expect(new Set(declaredKeys.map(familyOf)).size).toBe(KEY_FAMILY_PREFIXES.length)
		expect(KEY_FAMILY_PREFIXES).toHaveLength(5)
	})

	// The builders and the inline voucher key must agree with the census above, so a future
	// caller reaching for a builder lands on the same string a hand-written literal produces.
	it('agrees with the exported builders on all four builder-backed families', () => {
		expect(familyOf(bankRecUnreconciledTransactionsKey(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)))
			.toBe('bank-reconciliation-unreconciled-transactions-')
		expect(familyOf(bankRecBankTransactionsKey(TEST_BANK_ACCOUNT, FROM_DATE, TO_DATE)))
			.toBe('bank-reconciliation-bank-transactions-')
		expect(familyOf(bankRecClosingBalanceKey(TEST_BANK_ACCOUNT, TO_DATE)))
			.toBe('bank-reconciliation-account-closing-balance-')
		expect(familyOf(bankRecClosingBalanceAsPerStatementKey(TEST_BANK_ACCOUNT, TO_DATE)))
			.toBe('bank-reconciliation-account-closing-balance-as-per-statement-')
		expect(familyOf(vouchersKeyFor('ACC-BTN-2024-00001', DEFAULT_JOINED_MATCH_FILTERS)))
			.toBe('bank-reconciliation-vouchers-')
	})

	it('attributes a key from outside the five families to no family at all', () => {
		expect(familyOf('bank-reconciliation-something-new-Test Bank')).toBeUndefined()
		expect(familyOf(undefined)).toBeUndefined()
		expect(familyOf(null)).toBeUndefined()
	})
})

/**
 * The bank-account list, and the logo resolution layered on top of it.
 *
 * `account_currency` is the member worth caring about: it is NOT a `Bank Account` field. The
 * endpoint derives it per row by following `Bank Account.account` to `Account.account_currency`
 * after the query, which is exactly why it is optional here and why the currency advisory has to
 * treat its absence as "nothing to compare" rather than as a mismatch.
 */
describe('useGetBankAccounts', () => {

	it('reads the company\'s accounts, unkeyed, and refreshes neither on focus nor when stale', () => {
		const store = createSeededStore()

		renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

		const [method, params, swrKey, options] = lastGetCallFor(BANK_ACCOUNT_GET_LIST)

		expect(method).toBe(BANK_ACCOUNT_GET_LIST)
		expect(params).toEqual({ company: TEST_COMPANY })
		// Unkeyed on purpose: SWR derives the key from method plus params, which is what lets
		// `useSelectedBankAccountCurrency` share this very entry instead of opening a second
		// request. That sharing is asserted in its own suite above.
		expect(swrKey).toBeUndefined()
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
		expect(swrOptionsOf(options).revalidateIfStale).toBe(false)
	})

	it('surfaces the derived account currency the endpoint attaches to each row', () => {
		const store = createSeededStore()
		answerGetCall(BANK_ACCOUNT_GET_LIST, { message: [makeSelectedBank()] })

		const { result } = renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

		expect(result.current.banks).toHaveLength(1)
		expect(result.current.banks[0].account_currency).toBe(TEST_CURRENCY)
		// The server's row is spread through rather than reconstructed field by field, so a column
		// the hook does not know about still reaches the picker.
		expect(result.current.banks[0].name).toBe(TEST_BANK_ACCOUNT)
		expect(result.current.banks[0].bank).toBe(TEST_BANK)
		expect(result.current.isLoading).toBe(false)
		expect(result.current.error).toBeUndefined()
	})

	// A row whose GL account has no currency must come back as `undefined`, not as a default:
	// inventing one here is what would let the advisory claim a mismatch that does not exist.
	it('leaves the currency undefined when the endpoint could not derive one', () => {
		const store = createSeededStore()
		answerGetCall(BANK_ACCOUNT_GET_LIST, { message: [makeSelectedBank({ account_currency: undefined })] })

		const { result } = renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

		expect(result.current.banks[0].account_currency).toBeUndefined()
	})

	it('reports an empty list rather than undefined before any answer has arrived', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })

		expect(result.current.banks).toEqual([])
	})

	/*
	 * The `onSuccess` callback is wired into the SWR configuration, so with the transport mocked
	 * it is invoked here the way SWR would invoke it. The contract being asserted is narrow and
	 * real: the hook forwards `data?.message` - the ROWS - not the response envelope. A caller
	 * handed the envelope would have to unwrap it, and the bank picker does not.
	 */
	it('forwards the fetched rows to its caller\'s onSuccess callback', () => {
		const store = createSeededStore()
		const rows = [makeSelectedBank()]
		const onSuccess = vi.fn<(data?: unknown[]) => void>()

		renderHook(() => useGetBankAccounts(onSuccess), { wrapper: withStore(store) })

		swrOptionsOf(lastGetCallFor(BANK_ACCOUNT_GET_LIST)[3]).onSuccess?.({ message: rows })

		expect(onSuccess).toHaveBeenCalledTimes(1)
		expect(onSuccess).toHaveBeenCalledWith(rows)
	})

	it('tolerates a success with no payload, and tolerates having no callback at all', () => {
		const store = createSeededStore()

		renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })
		const options = swrOptionsOf(lastGetCallFor(BANK_ACCOUNT_GET_LIST)[3])

		// Neither of these may throw: the picker mounts without a callback, and SWR can report a
		// success whose payload is absent.
		expect(() => options.onSuccess?.(undefined)).not.toThrow()
		expect(() => options.onSuccess?.({})).not.toThrow()
	})

	it('applies a caller\'s filter to the resolved rows', () => {
		const store = createSeededStore()
		answerGetCall(BANK_ACCOUNT_GET_LIST, {
			message: [
				makeSelectedBank({ name: 'Current - TC', is_credit_card: 0 }),
				makeSelectedBank({ name: 'Card - TC', is_credit_card: 1 })
			]
		})

		const { result } = renderHook(() => useGetBankAccounts(undefined, (bank) => bank.is_credit_card === 1), {
			wrapper: withStore(store)
		})

		expect(result.current.banks.map((bank) => bank.name)).toEqual(['Card - TC'])
	})
})

/*
 * Logo resolution.
 *
 * `findBankLogoForName` is module-private, so it is exercised through the only surface that uses
 * it. That is the right way round: the guarantee that matters is what the bank picker renders,
 * not the shape of an internal helper.
 */
describe('bank logo resolution', () => {

	const logoFor = (bankName: string | undefined) => {
		const store = createSeededStore()
		answerGetCall(BANK_ACCOUNT_GET_LIST, { message: [makeSelectedBank({ bank: bankName })] })
		const { result } = renderHook(() => useGetBankAccounts(), { wrapper: withStore(store) })
		return result.current.banks[0]
	}

	it('matches a bank by its full name', () => {
		expect(logoFor('HDFC Bank').logo).toBe('HDFC.svg')
	})

	it('matches case-insensitively, since a bank name is free text', () => {
		expect(logoFor('hdfc bank').logo).toBe('HDFC.svg')
	})

	it('matches a keyword appearing inside a longer account label', () => {
		expect(logoFor('ICICI Bank - Corporate Salary Account').logo).toBe('ICICI.svg')
	})

	/*
	 * ⚠️ THE reason the longest keyword wins. "Banco de Finanzas" CONTAINS the three-letter
	 * keyword "anz", so a first-match or shortest-match lookup hands a Nicaraguan bank the
	 * Australia and New Zealand Banking Group logo. Preferring the longest match is what stops a
	 * short token inside an unrelated word beating a full bank name.
	 */
	it('prefers the longest keyword, so a short token inside another word cannot win', () => {
		const bank = logoFor('Banco de Finanzas')

		expect(bank.logo).toBe('Banco_de_Finanzas.svg')
		expect(bank.logo).not.toBe('ANZ.png')
		// The whole entry is adopted, not just its logo, so per-bank presentation travels with it.
		expect(bank.logoClassName).toBe('h-4.5')
	})

	it('carries the dark-mode variant and the invert flag when the entry declares them', () => {
		expect(logoFor('ICICI Bank').logoDark).toBe('ICICI-dark.svg')
		expect(logoFor('Macquarie Bank').darkModeInvert).toBe(true)
	})

	// No logo is a perfectly ordinary outcome - most banks in the world are not in the list - so
	// it must resolve to `undefined` rather than to a wrong logo or a thrown error.
	it('leaves every logo field undefined when nothing matches', () => {
		const bank = logoFor('Zephyr Municipal Cooperative')

		expect(bank.logo).toBeUndefined()
		expect(bank.logoDark).toBeUndefined()
		expect(bank.darkModeInvert).toBeUndefined()
		expect(bank.logoClassName).toBeUndefined()
	})

	// `bank` is optional on `Bank Account`, so an account with no bank must short-circuit rather
	// than run a substring search against nothing.
	it('resolves nothing when the account names no bank', () => {
		expect(logoFor(undefined).logo).toBeUndefined()
		expect(logoFor('').logo).toBeUndefined()
	})
})


/* ════════════════════════════════════════════════════════════════════════════════════
 * TC4 - CONFIRMING A MATCH POSTS THE RECONCILIATION AND THE STATUS FOLLOWS.
 *
 * `reconcile_vouchers` is ONE server-side operation and its response is the sole authority on
 * what was recorded. The client's entire job on the accepted path is therefore: send exactly the
 * payload the endpoint declares, record what came BACK, and invalidate the caches whose contents
 * the server has just changed. Nothing is computed locally and nothing is presumed.
 * ════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The Undo affordance attached to the success toast, read out of the captured options.
 *
 * Narrowed from `unknown` rather than from the toast library's own union, because that union
 * admits an arbitrary node in the same slot and narrowing it in place would need a type
 * assertion at every property access instead of one here.
 */
const undoActionOf = (options: unknown): { label?: unknown, onClick: () => void } | undefined =>
	(options as { action?: { label?: unknown, onClick: () => void } } | undefined)?.action

describe('useReconcileTransaction — the accepted post (TC4)', () => {

	let successToast: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		// Spied rather than left live so the assertions can read what the reviewer is shown, and
		// so the toast library is not asked to render outside a mounted Toaster.
		successToast = vi.spyOn(toast, 'success').mockReturnValue('toast-id')
		frappeSWRMutate.mockResolvedValue(undefined)
	})

	afterEach(() => {
		successToast.mockRestore()
	})

	/**
	 * Drives one accepted confirm and hands back everything the assertions need.
	 *
	 * The server's answer is a FULL `Bank Transaction` document - the reconcile hook's declared
	 * response type - so `unallocated_amount: 0` and `status: 'Reconciled'` here are the SERVER
	 * reporting a completed reconciliation, not the client deciding one happened.
	 */
	const confirmMatch = async (serverAnswer = makeReconcileSuccessResponse()) => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		const voucher = makeSuggestedLinkedPayment(transaction)
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockResolvedValue(serverAnswer)

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, voucher)
		})

		return { store, transaction, voucher, serverAnswer }
	}

	it('posts to reconcile_vouchers, and to nothing else', async () => {
		await confirmMatch()

		expect(frappeSDKMock.useFrappePostCall).toHaveBeenCalledWith(RECONCILE_VOUCHERS)
		// Exactly one post for one confirm: no retry, no second attempt, no duplicate posting.
		expect(frappePostCall).toHaveBeenCalledTimes(1)
	})

	/*
	 * ⚠️ The payload shape is the backend's contract, not the client's preference. `vouchers` is a
	 * JSON STRING rather than an array - the endpoint parses it server-side - and the inner keys
	 * are `payment_doctype`, `payment_name` and `amount`, with `amount` taken from the voucher's
	 * `paid_amount`. Every one of those is a name the server reads by; renaming any of them here
	 * would post an allocation the server silently ignores.
	 */
	it('sends exactly the payload the endpoint declares, with vouchers as a JSON string', async () => {
		const { transaction, voucher } = await confirmMatch()

		const [payload] = frappePostCall.mock.calls[0]

		expect(payload).toEqual({
			bank_transaction_name: transaction.name,
			vouchers: JSON.stringify([{
				payment_doctype: voucher.doctype,
				payment_name: voucher.name,
				amount: voucher.paid_amount
			}])
		})
		// A string, not an array - asserted separately because `toEqual` above would pass just as
		// happily against a structurally identical array if the production code stopped stringifying.
		expect(typeof payload.vouchers).toBe('string')
	})

	// Parsed rather than string-compared, so the assertion holds on the KEY NAMES and VALUES
	// independently of the order they happen to be serialised in.
	it('allocates one voucher, by doctype, name and paid amount', async () => {
		const { voucher } = await confirmMatch()

		const [payload] = frappePostCall.mock.calls[0]
		const vouchers = JSON.parse(String(payload.vouchers)) as unknown[]

		expect(vouchers).toHaveLength(1)
		expect(vouchers[0]).toEqual({
			payment_doctype: 'Payment Entry',
			payment_name: voucher.name,
			amount: voucher.paid_amount
		})
	})

	/*
	 * TC3's payload half. Overriding the suggestion must change the posted allocation and nothing
	 * else - a different doctype, a different name, a different amount - because the reviewer is
	 * linking the transaction to a genuinely different ledger entry.
	 */
	it('posts the voucher the reviewer actually chose, not the suggested one', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		const suggested = makeSuggestedLinkedPayment(transaction)
		const chosen = makeAlternateLinkedPayment()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockResolvedValue(makeReconcileSuccessResponse())

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, chosen)
		})

		const vouchers = JSON.parse(String(frappePostCall.mock.calls[0][0].vouchers)) as unknown[]

		expect(vouchers[0]).toEqual({
			payment_doctype: 'Journal Entry',
			payment_name: chosen.name,
			amount: chosen.paid_amount
		})
		expect(chosen.name).not.toBe(suggested.name)
		expect(chosen.doctype).not.toBe(suggested.doctype)
	})

	/*
	 * The status update TC4 asks for is observable exactly here: the response document is what the
	 * refresh path is handed, and the audit entry records THAT document rather than the row the
	 * client was holding. So the log cannot claim a status the server did not report.
	 */
	it('records the SERVER\'S returned document in the action log, with the voucher it matched', async () => {
		const { store, voucher, serverAnswer } = await confirmMatch()

		const log = store.get(bankRecActionLog)

		expect(log).toHaveLength(1)
		expect(log[0].type).toBe('match')
		expect(log[0].isBulk).toBe(false)
		expect(log[0].timestamp).toBeGreaterThan(0)
		expect(log[0].items).toHaveLength(1)
		// By identity: the logged transaction IS the server's answer, not a copy of the client's row.
		expect(log[0].items[0].bankTransaction).toBe(serverAnswer.message)
		expect(log[0].items[0].bankTransaction.status).toBe('Reconciled')
		expect(log[0].items[0].bankTransaction.unallocated_amount).toBe(0)
		expect(log[0].items[0].voucher).toEqual({
			reference_doctype: voucher.doctype,
			reference_name: voucher.name,
			reference_no: voucher.reference_no,
			reference_date: voucher.reference_date,
			posting_date: voucher.posting_date
		})
	})

	// A fully allocated transaction leaves the unreconciled list, so both the list and the ledger
	// closing balance it feeds have to be re-read from the server.
	it('revalidates the unreconciled list and the closing balance once the post is accepted', async () => {
		await confirmMatch()

		const revalidatedKeys = frappeSWRMutate.mock.calls.map(([key]) => key)

		expect(revalidatedKeys).toContain(UNRECONCILED_KEY)
		expect(revalidatedKeys).toContain(CLOSING_BALANCE_KEY)
		// Still only the permitted families - the success path introduces no key of its own.
		expect(revalidatedKeys.filter((key) => familyOf(key) === undefined)).toEqual([])
	})

	/*
	 * A PARTIAL allocation is a different outcome and takes a different branch: the transaction
	 * stays on the unreconciled list with a smaller unallocated amount, so its candidate-voucher
	 * list is now wrong too and has to be invalidated alongside the list and the balance.
	 */
	it('also revalidates the transaction\'s candidate vouchers when the allocation was partial', async () => {
		const { transaction } = await confirmMatch(
			makeReconcileSuccessResponse({ unallocated_amount: 2500, status: 'Unreconciled' })
		)

		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([
			UNRECONCILED_KEY,
			CLOSING_BALANCE_KEY,
			vouchersKeyFor(transaction.name, DEFAULT_JOINED_MATCH_FILTERS)
		])
	})

	it('confirms the reconciliation to the reviewer and offers to undo it', async () => {
		const { store, transaction } = await confirmMatch()

		expect(successToast).toHaveBeenCalledTimes(1)
		// `_()` falls through to the literal here because the harness leaves the message catalogue
		// empty, so this is the untranslated source string by construction.
		expect(successToast.mock.calls[0][0]).toBe('Reconciled')

		const undo = undoActionOf(successToast.mock.calls[0][1])
		expect(undo?.label).toBe('Undo')

		// Undo does not itself reverse anything: it opens the unreconcile modal for this
		// transaction, which is where the reversal is confirmed and posted.
		expect(store.get(bankRecUnreconcileModalAtom)).toBe('')
		act(() => {
			undo?.onClick()
		})
		expect(store.get(bankRecUnreconcileModalAtom)).toBe(transaction.name)
	})

	// The confirm affordance is gated on `isSettling`, which must be back down once the accepted
	// path has finished - otherwise the row stays closed after a perfectly successful post.
	it('reopens the action once the accepted post has settled', async () => {
		const { store } = await confirmMatch()

		expect(store.get(bankRecReconcileSettlingAtom)).toBe(false)
	})

	// The dialog is for refusals. A success must not raise one, or the reviewer is shown an error
	// about work that was in fact recorded.
	it('raises no error dialog on the accepted path', async () => {
		const { store } = await confirmMatch()

		expect(store.get(bankRecErrorDialogAtom)).toBeNull()
	})
})

/* ════════════════════════════════════════════════════════════════════════════════════
 * FM1 / C9 - THE SERVER IS THE SOLE SOURCE OF TRUTH, SO NOTHING IS WRITTEN OPTIMISTICALLY.
 *
 * FM1 requires that a refused or lost post leave the transaction unreconciled with its state
 * unchanged, and produce no partial or duplicate posting. The strongest available proof is
 * structural: the client never writes a reconciliation it has not read back, so there is no
 * optimistic write to roll back and no window in which a rolled-back write is observable.
 * ════════════════════════════════════════════════════════════════════════════════════ */
describe('a refused post leaves the client\'s state exactly as it was', () => {

	let consoleError: ReturnType<typeof vi.spyOn>
	let errorToast: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		errorToast = vi.spyOn(toast, 'error').mockReturnValue('toast-id')
		// No mounted fetcher answers either key, which is the honest shape of a refusal in
		// isolation: the refresh is attempted and brings back no authoritative snapshot.
		frappeSWRMutate.mockResolvedValue(undefined)
	})

	afterEach(() => {
		consoleError.mockRestore()
		errorToast.mockRestore()
	})

	const refuseConfirm = async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		const refusal = makeAlreadyReconciledError(transaction.name)
		frappePostCall.mockRejectedValue(refusal)

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		return { store, transaction, refusal }
	}

	/*
	 * ⚠️ THE assertion FM1 and C9 both reduce to. `toBe` is deliberate: the selected row is the
	 * SAME OBJECT it was before the attempt, so nothing was patched, merged or re-flagged. A
	 * client that had optimistically marked the row reconciled would fail this even if it then
	 * reverted, because the reverted copy would not be the original object.
	 */
	it('does not transition the row to reconciled, or touch it at all', async () => {
		const { store, transaction } = await refuseConfirm()

		const selection = store.get(SELECTED_TRANSACTION_ATOM)

		expect(selection).toHaveLength(1)
		expect(selection[0]).toBe(transaction)
		expect(selection[0].status).toBe('Unreconciled')
		expect(selection[0].status).not.toBe('Reconciled')
		expect(selection[0].unallocated_amount).toBe(TEST_TRANSACTION_AMOUNT)
	})

	// One refusal, one attempt. A client that retried on rejection is exactly how a refused post
	// becomes a duplicate posting against a transaction the server had already allocated.
	it('does not retry, so a refusal cannot become a duplicate posting', async () => {
		await refuseConfirm()

		expect(frappePostCall).toHaveBeenCalledTimes(1)
	})

	// The audit log records what the server DID. A refused attempt did nothing, so it records
	// nothing - a log entry here would assert a reconciliation that never happened.
	it('writes no action-log entry for work the server refused', async () => {
		const { store } = await refuseConfirm()

		expect(store.get(bankRecActionLog)).toEqual([])
	})

	it('surfaces the server\'s own refusal to the reviewer, verbatim', async () => {
		const { store, transaction, refusal } = await refuseConfirm()

		// Raw and unmodified, so the shared parser sees Frappe's native envelope and the server's
		// wording reaches the reviewer without client paraphrasing.
		expect(store.get(bankRecErrorDialogAtom)).toBe(refusal)
		expect(errorToast).toHaveBeenCalledTimes(1)
		expect(errorToast.mock.calls[0][0]).toBe('Error')
		expect(String((errorToast.mock.calls[0][1] as { description?: unknown } | undefined)?.description))
			.toContain(formatAlreadyReconciledMessage(transaction.name))
	})

	// FM3's "refresh status" half: the two keys that between them own every `status` and
	// `unallocated_amount` the confirm affordance reads are re-read from the server.
	it('re-reads both transaction lists so a stale client is corrected', async () => {
		await refuseConfirm()

		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([UNRECONCILED_KEY, ALL_TRANSACTIONS_KEY])
	})

	/*
	 * The ordinary case, not an edge case: the reviewer works the unreconciled list with the Bank
	 * Transactions tab unmounted, so only ONE of the two keys has a fetcher behind it and only one
	 * refresh can return rows. The selection must still be rebuilt from whichever list answered -
	 * treating a single silent key as "no authoritative snapshot" would strand the reviewer on the
	 * pre-attempt row even though the server had in fact just answered.
	 */
	it('rebuilds the selection from whichever list answered, when only one of them did', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		const refreshed = makeUnreconciledTransaction({ unallocated_amount: 4000 })
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockRejectedValue(makeAlreadyReconciledError(transaction.name))
		// Only the unreconciled key is served; the all-transactions key has no mounted fetcher.
		frappeSWRMutate.mockImplementation((key) => key === UNRECONCILED_KEY
			? Promise.resolve({ message: [refreshed] })
			: Promise.resolve(undefined))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)[0]).toBe(refreshed)
		expect(store.get(SELECTED_TRANSACTION_ATOM)[0].unallocated_amount).toBe(4000)
	})

	it('rebuilds the selection from the all-transactions list when that is the one serving', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		// The server now reports it reconciled, so it is absent from the unreconciled list by
		// construction and can only be found in the unfiltered one.
		const refreshed = makeReconciledTransaction({ name: transaction.name })
		store.set(SELECTED_TRANSACTION_ATOM, [transaction])
		frappePostCall.mockRejectedValue(makeAlreadyReconciledError(transaction.name))
		frappeSWRMutate.mockImplementation((key) => key === ALL_TRANSACTIONS_KEY
			? Promise.resolve({ message: [refreshed] })
			: Promise.resolve(undefined))

		const { result } = renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })
		await act(async () => {
			result.current.reconcileTransaction(transaction, makeLinkedPayment())
		})

		// Kept, with the server's TRUE status, which is what lets the confirm guard disable the
		// action rather than the row silently vanishing.
		expect(store.get(SELECTED_TRANSACTION_ATOM)[0]).toBe(refreshed)
		expect(store.get(SELECTED_TRANSACTION_ATOM)[0].status).toBe('Reconciled')
		expect(store.get(SELECTED_TRANSACTION_ATOM)[0].unallocated_amount).toBe(0)
	})

	// The hook is instantiated during render, before a bank account has necessarily been chosen, so
	// the selection atom family has to tolerate an empty instance key rather than throwing.
	it('can be instantiated before any bank account has been selected', () => {
		const store = createStoreWithoutBank()

		expect(() => renderHook(() => useReconcileTransaction(), { wrapper: withStore(store) })).not.toThrow()
	})
})


/* ════════════════════════════════════════════════════════════════════════════════════
 * POST-RECONCILE HOUSEKEEPING: which caches are invalidated, and which row is reviewed next.
 *
 * This is the hook the accepted post delegates to, tested directly so both of its branches are
 * pinned independently of the post that reaches them. The branch is chosen by the SERVER'S
 * reported `unallocated_amount`, never by the client's own arithmetic - a partial allocation
 * leaves the transaction on the list, a full one takes it off - which is why the branch condition
 * reads a field off the response document.
 * ════════════════════════════════════════════════════════════════════════════════════ */
describe('useRefreshUnreconciledTransactions', () => {

	beforeEach(() => {
		frappeSWRMutate.mockResolvedValue(undefined)
	})

	it('invalidates the list, the balance and the transaction\'s own vouchers on a PARTIAL allocation', () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		act(() => {
			result.current(transaction, makeBankTransaction({ unallocated_amount: 2500, status: 'Unreconciled' }))
		})

		// Three keys, in this order, and then it stops: the transaction is still under review, so
		// the selection is deliberately left where the reviewer put it.
		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([
			UNRECONCILED_KEY,
			CLOSING_BALANCE_KEY,
			vouchersKeyFor(transaction.name, DEFAULT_JOINED_MATCH_FILTERS)
		])
	})

	it('keys the partial-allocation voucher invalidation to the reviewer\'s current filters', () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()
		store.set(bankRecMatchFilters, ['payment_entry'])

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		act(() => {
			result.current(transaction, makeBankTransaction({ unallocated_amount: 2500 }))
		})

		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toContain(
			vouchersKeyFor(transaction.name, 'payment_entry')
		)
	})

	/*
	 * A FULL allocation retires the transaction, so the reviewer is moved on to the next row -
	 * and "next" means next in the list AS FILTERED AND SEARCHED, not next in the raw response.
	 * Anything else would jump the reviewer to a row their own filters had excluded.
	 */
	it('advances the selection to the next row the refreshed list still contains', async () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction()
		const second = makeRuleMatchedTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [first])
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [first, second] })
		// The refreshed list the server hands back: `first` is gone, `second` remains.
		frappeSWRMutate.mockResolvedValue({ message: [second] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(first, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([second])
		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([UNRECONCILED_KEY, CLOSING_BALANCE_KEY])
	})

	// The row taken from the REFRESHED response, not from the pre-reconcile list, so the newly
	// selected transaction carries the server's current status rather than a stale snapshot.
	it('selects the refreshed instance of that row rather than the stale one it was holding', async () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction()
		const staleSecond = makeRuleMatchedTransaction({ unallocated_amount: 9999 })
		const refreshedSecond = makeRuleMatchedTransaction({ unallocated_amount: 4321 })
		store.set(SELECTED_TRANSACTION_ATOM, [first])
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [first, staleSecond] })
		frappeSWRMutate.mockResolvedValue({ message: [refreshedSecond] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(first, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)[0]).toBe(refreshedSecond)
		expect(store.get(SELECTED_TRANSACTION_ATOM)[0].unallocated_amount).toBe(4321)
	})

	// The candidate next row may itself have been reconciled by someone else in the meantime. It
	// is then absent from the refreshed list, and the selection is cleared rather than pointed at
	// a row the server no longer offers.
	it('clears the selection when the next row is absent from the refreshed list', async () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction()
		const second = makeRuleMatchedTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [first])
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [first, second] })
		frappeSWRMutate.mockResolvedValue({ message: [] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(first, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
	})

	it('clears the selection when the reconciled row was the last one', async () => {
		const store = createSeededStore()
		const only = makeUnreconciledTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [only])
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [only] })
		frappeSWRMutate.mockResolvedValue({ message: [] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(only, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([])
	})

	/*
	 * "Next" is computed over the list the reviewer is actually looking at. With a Credits-only
	 * filter in force, the debit row sitting between two credits must be skipped - selecting it
	 * would drop the reviewer onto a row their own filter had hidden.
	 */
	it('respects the reviewer\'s active filters when choosing the next row', async () => {
		const store = createSeededStore()
		const credit = makeUnreconciledTransaction({ name: 'CREDIT-1', withdrawal: 0, deposit: 1000 })
		const debit = makeUnreconciledTransaction({ name: 'DEBIT-1', withdrawal: 750, deposit: 0 })
		const laterCredit = makeUnreconciledTransaction({ name: 'CREDIT-2', withdrawal: 0, deposit: 1250 })
		store.set(SELECTED_TRANSACTION_ATOM, [credit])
		store.set(bankRecTransactionTypeFilter, 'Credits')
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [credit, debit, laterCredit] })
		frappeSWRMutate.mockResolvedValue({ message: [debit, laterCredit] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(credit, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([laterCredit])
	})

	/*
	 * The amount filter narrows the same list, so it narrows "next" too. A reviewer working a
	 * single statement figure must not be moved onto a row of a different amount just because it
	 * happens to sit next in the raw response.
	 */
	it('respects an active amount filter when choosing the next row', async () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction({ name: 'AMT-1', withdrawal: 0, deposit: 1500 })
		const otherAmount = makeUnreconciledTransaction({ name: 'AMT-OTHER', withdrawal: 0, deposit: 999 })
		const sameAmount = makeUnreconciledTransaction({ name: 'AMT-2', withdrawal: 0, deposit: 1500 })
		store.set(SELECTED_TRANSACTION_ATOM, [first])
		store.set(bankRecAmountFilter, { value: 1500, stringValue: '1500' })
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [first, otherAmount, sameAmount] })
		frappeSWRMutate.mockResolvedValue({ message: [otherAmount, sameAmount] })

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(first, makeBankTransaction({ unallocated_amount: 0 }))
		})

		expect(store.get(SELECTED_TRANSACTION_ATOM)).toEqual([sameAmount])
	})

	// The updated document is optional, and its absence means "nothing is known about the
	// allocation" - which takes the same path as a full allocation rather than the partial one.
	it('takes the full-allocation path when no updated document is supplied at all', async () => {
		const store = createSeededStore()
		const transaction = makeUnreconciledTransaction()

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(transaction)
		})

		expect(frappeSWRMutate.mock.calls.map(([key]) => key)).toEqual([UNRECONCILED_KEY, CLOSING_BALANCE_KEY])
	})

	// Instantiated during render, so it has to be safe before a bank account exists: the selection
	// atom family is then addressed by an empty instance key rather than by an account name.
	it('can be instantiated, and invoked, before any bank account has been selected', async () => {
		const store = createStoreWithoutBank()
		const transaction = makeUnreconciledTransaction()

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })
		await act(async () => {
			result.current(transaction, makeBankTransaction({ unallocated_amount: 0 }))
		})

		// The keys still come from the same builders, so they remain within the permitted families.
		expect(frappeSWRMutate.mock.calls.map(([key]) => key).filter((key) => familyOf(key) === undefined))
			.toEqual([])
	})

	// A refresh that resolves with nothing - no mounted fetcher for the key - must not throw while
	// looking for the next row inside a response that never arrived.
	it('survives a refresh that resolves without a payload', async () => {
		const store = createSeededStore()
		const first = makeUnreconciledTransaction()
		const second = makeRuleMatchedTransaction()
		store.set(SELECTED_TRANSACTION_ATOM, [first])
		answerGetCall(GET_BANK_TRANSACTIONS, { message: [first, second] })
		frappeSWRMutate.mockResolvedValue(undefined)

		const { result } = renderHook(() => useRefreshUnreconciledTransactions(), { wrapper: withStore(store) })

		await act(async () => {
			await expect(Promise.resolve(result.current(first, makeBankTransaction({ unallocated_amount: 0 }))))
				.resolves.toBeUndefined()
		})
	})
})

/* ════════════════════════════════════════════════════════════════════════════════════
 * THE DISPLAY AND FILTERING HELPERS.
 *
 * Small, pure and heavily reused: every transaction row in the workbench reads the amount
 * through one of these, and the list the reviewer sees is whatever `getSearchResults` returns.
 * ════════════════════════════════════════════════════════════════════════════════════ */
describe('useIsTransactionWithdrawal', () => {

	/*
	 * A bank transaction carries its amount in ONE of two columns and the row renders whichever is
	 * positive, so the classification and the displayed figure have to come from the same decision.
	 * Splitting them is how a debit ends up displaying a credit's amount.
	 */
	it('classifies a debit and reports the withdrawn amount', () => {
		const { result } = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: 750, deposit: 0 })))

		expect(result.current.isWithdrawal).toBe(true)
		expect(result.current.isDeposit).toBeFalsy()
		expect(result.current.amount).toBe(750)
	})

	it('classifies a credit and reports the deposited amount', () => {
		const { result } = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: 0, deposit: 1250 })))

		expect(result.current.isDeposit).toBe(true)
		expect(result.current.isWithdrawal).toBeFalsy()
		expect(result.current.amount).toBe(1250)
	})

	// Both columns are optional on the DocType, so an absent pair must classify as neither rather
	// than defaulting a transaction into one direction or the other.
	it('classifies a transaction with neither column as neither', () => {
		const { result } = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: undefined, deposit: undefined })))

		expect(result.current.isWithdrawal).toBeFalsy()
		expect(result.current.isDeposit).toBeFalsy()
		expect(result.current.amount).toBeUndefined()
	})

	// A zero in a column is not an amount: it is the empty column of a transaction whose value
	// sits in the other one.
	it('treats a zero as an empty column rather than as an amount', () => {
		const { result } = renderHook(() =>
			useIsTransactionWithdrawal(makeUnreconciledTransaction({ withdrawal: 0, deposit: 0 })))

		expect(result.current.isWithdrawal).toBeFalsy()
		expect(result.current.isDeposit).toBeFalsy()
	})
})

/*
 * TC2's client-side half. A rule-stamped transaction names the rule that matched it, and the
 * workbench reads that rule to show WHY the row was suggested. The document read must be
 * suppressed entirely for an unstamped row, or every unmatched transaction in the list would fire
 * a request for a document called `undefined`.
 */
describe('useGetRuleForTransaction', () => {

	it('reads the rule a stamped transaction names', () => {
		renderHook(() => useGetRuleForTransaction(makeRuleMatchedTransaction()))

		const [doctype, name, swrKey, options] = lastGetDocCall()

		expect(doctype).toBe('Bank Transaction Rule')
		expect(name).toBe(TEST_TRANSACTION_RULE)
		// `undefined` lets SWR derive the key from the doctype and name, so the fetch proceeds.
		expect(swrKey).toBeUndefined()
		expect(swrOptionsOf(options).revalidateOnFocus).toBe(false)
		expect(swrOptionsOf(options).revalidateIfStale).toBe(false)
	})

	it('does not read anything for a transaction no rule matched', () => {
		renderHook(() => useGetRuleForTransaction(makeUnreconciledTransaction()))

		const [doctype, name, swrKey] = lastGetDocCall()

		expect(doctype).toBe('Bank Transaction Rule')
		expect(name).toBeUndefined()
		// A null key is SWR's "do not fetch": no request is made for an unstamped row.
		expect(swrKey).toBeNull()
	})
})

/*
 * The search box.
 *
 * Debounced, and published into a SHARED atom rather than held locally, because the search string
 * is read by the transaction list, by the next-transaction selection above and by the bulk-action
 * surfaces. Publishing on every keystroke would re-filter a virtualised list per character.
 *
 * NOTE ON THE TWO UNCOVERED LINES IN THIS HOOK. Its "initial value changed" re-sync block is
 * PROVABLY unreachable: the ref is seeded with the same empty-string constant it is compared
 * against and is only ever reassigned that same constant, so the guard is always false. No input
 * to this hook can reach those lines, and reaching them would require editing the module - which
 * the minimal-change clause forbids for a coverage figure. Recorded here rather than worked
 * around, so the next reader knows it was analysed rather than missed.
 */
describe('useTransactionSearch', () => {

	it('holds a keystroke back, then publishes it to the shared search atom', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useTransactionSearch(), { wrapper: withStore(store) })

		expect(result.current[0]).toBe('')

		act(() => {
			result.current[1]('acme')
		})
		// Debounced: the atom has NOT moved yet, which is the whole point of the hook.
		expect(store.get(bankRecSearchText)).toBe('')

		act(() => {
			result.current[1].flush()
		})
		expect(store.get(bankRecSearchText)).toBe('acme')
	})

	// The returned value is the atom's, so an input bound to it and a list filtered by it cannot
	// disagree about what is currently being searched for.
	it('reports the shared atom\'s current value', () => {
		const store = createSeededStore()
		store.set(bankRecSearchText, TEST_TRANSACTION_DESCRIPTION)

		const { result } = renderHook(() => useTransactionSearch(), { wrapper: withStore(store) })

		expect(result.current[0]).toBe(TEST_TRANSACTION_DESCRIPTION)
	})

	// A pending keystroke can be abandoned - the reviewer clearing the box or navigating away must
	// not have a stale search land afterwards.
	it('can abandon a keystroke that has not been published yet', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useTransactionSearch(), { wrapper: withStore(store) })

		act(() => {
			result.current[1]('abandoned')
			result.current[1].cancel()
		})

		expect(store.get(bankRecSearchText)).toBe('')
	})
})

/**
 * The list the reviewer actually sees.
 *
 * `getSearchResults` composes three independent narrowings - fuzzy search, direction and exact
 * amount - and it is also what decides which row is reviewed next after a reconciliation, so its
 * behaviour is load-bearing twice over.
 */
describe('getSearchResults', () => {

	const debit = makeUnreconciledTransaction({
		name: 'ACC-BTN-2024-09001',
		withdrawal: 500,
		deposit: 0,
		unallocated_amount: 500,
		description: 'ATM cash withdrawal Bengaluru',
		reference_number: 'ATM-9001'
	})
	const credit = makeUnreconciledTransaction({
		name: 'ACC-BTN-2024-09002',
		withdrawal: 0,
		deposit: 750,
		unallocated_amount: 750,
		description: 'Salary credit from Globex',
		reference_number: 'SAL-9002'
	})
	/** A transaction with no value in either column - the row an amount filter cannot match. */
	const valueless = makeUnreconciledTransaction({
		name: 'ACC-BTN-2024-09003',
		withdrawal: 0,
		deposit: 0,
		unallocated_amount: 0,
		description: 'Adjustment placeholder',
		reference_number: 'ADJ-9003'
	})

	const rows = [debit, credit, valueless]

	/** The very index the workbench builds: the same keys, threshold and scoring. */
	const searchIndex = () => new Fuse(rows, {
		keys: ['description', 'reference_number'],
		threshold: 0.5,
		includeScore: true
	})

	const names = (results: UnreconciledTransaction[]) => results.map((transaction) => transaction.name)

	it('returns every row when there is no index to search', () => {
		expect(names(getSearchResults(null, 'anything', 'All', 0, rows))).toEqual(names(rows))
	})

	it('returns every row when the search box is empty', () => {
		expect(names(getSearchResults(searchIndex(), '', 'All', 0, rows))).toEqual(names(rows))
	})

	// Nothing to filter is an empty list, not `undefined`: the caller iterates the result directly.
	it('returns an empty list when there are no transactions at all', () => {
		expect(getSearchResults(null, '', 'All', 0, undefined)).toEqual([])
	})

	it('narrows to the fuzzy matches once a search string is given', () => {
		const results = getSearchResults(searchIndex(), 'Salary', 'All', 0, rows)

		expect(names(results)).toContain(credit.name)
		expect(names(results)).not.toContain(valueless.name)
	})

	it('searches the reference number as well as the description', () => {
		expect(names(getSearchResults(searchIndex(), 'ATM-9001', 'All', 0, rows))).toContain(debit.name)
	})

	it('keeps only debits under the Debits filter', () => {
		expect(names(getSearchResults(null, '', 'Debits', 0, rows))).toEqual([debit.name])
	})

	it('keeps only credits under the Credits filter', () => {
		expect(names(getSearchResults(null, '', 'Credits', 0, rows))).toEqual([credit.name])
	})

	// An unrecognised filter narrows to nothing rather than falling through to everything. Failing
	// closed is the safer default here: a reviewer sees an obviously empty list rather than an
	// unfiltered one they believe is filtered.
	it('narrows to nothing under a filter it does not recognise', () => {
		expect(getSearchResults(null, '', 'Something Else', 0, rows)).toEqual([])
	})

	it('matches an exact amount in the withdrawal column', () => {
		expect(names(getSearchResults(null, '', 'All', 500, rows))).toEqual([debit.name])
	})

	it('matches an exact amount in the deposit column', () => {
		expect(names(getSearchResults(null, '', 'All', 750, rows))).toEqual([credit.name])
	})

	// Exact, not "at least": the reviewer is looking for a specific figure off a statement line.
	it('does not match an amount that merely differs', () => {
		expect(getSearchResults(null, '', 'All', 501, rows)).toEqual([])
	})

	// A row with nothing in either column can never satisfy an amount filter, and must be dropped
	// rather than passed through for want of a column to compare.
	it('drops a row with no value in either column when an amount filter is set', () => {
		expect(names(getSearchResults(null, '', 'All', 500, rows))).not.toContain(valueless.name)
	})

	it('applies the direction and amount filters together', () => {
		expect(getSearchResults(null, '', 'Credits', 500, rows)).toEqual([])
		expect(names(getSearchResults(null, '', 'Debits', 500, rows))).toEqual([debit.name])
	})

	// Zero means "no amount filter", not "match a zero amount" - which is why the valueless row is
	// not selected by it.
	it('treats a zero amount filter as no amount filter', () => {
		expect(names(getSearchResults(null, '', 'All', 0, rows))).toEqual(names(rows))
	})
})

/**
 * The session action log.
 *
 * It is the reviewer's own audit trail of what they did in this sitting, which is why it is
 * prepended (newest first, matching how it is displayed) and capped (an unbounded log in session
 * storage grows for as long as the tab lives).
 */
describe('useUpdateActionLog', () => {

	const makeMatchAction = (timestamp: number): ActionLog => ({
		type: 'match',
		isBulk: false,
		timestamp,
		items: [{
			bankTransaction: makeBankTransaction(),
			voucher: {
				reference_doctype: 'Payment Entry',
				reference_name: 'ACC-PAY-2024-00001',
				reference_no: TEST_REFERENCE_NUMBER,
				reference_date: TEST_TRANSACTION_DATE,
				posting_date: TEST_TRANSACTION_DATE
			}
		}]
	})

	it('records an action', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useUpdateActionLog(), { wrapper: withStore(store) })
		act(() => {
			result.current(makeMatchAction(1))
		})

		expect(store.get(bankRecActionLog)).toHaveLength(1)
		expect(store.get(bankRecActionLog)[0].timestamp).toBe(1)
	})

	it('puts the newest action first', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useUpdateActionLog(), { wrapper: withStore(store) })
		act(() => {
			result.current(makeMatchAction(1))
			result.current(makeMatchAction(2))
			result.current(makeMatchAction(3))
		})

		expect(store.get(bankRecActionLog).map((action) => action.timestamp)).toEqual([3, 2, 1])
	})

	// The cap retires the OLDEST entries, so a long session keeps the actions a reviewer might
	// still want to undo and discards the ones they have moved well past.
	it('caps the log at a hundred actions, discarding the oldest', () => {
		const store = createSeededStore()

		const { result } = renderHook(() => useUpdateActionLog(), { wrapper: withStore(store) })
		act(() => {
			for (let timestamp = 1; timestamp <= 101; timestamp++) {
				result.current(makeMatchAction(timestamp))
			}
		})

		const log = store.get(bankRecActionLog)

		expect(log).toHaveLength(100)
		expect(log[0].timestamp).toBe(101)
		expect(log[99].timestamp).toBe(2)
		// The very first action is the one that fell off the end.
		expect(log.map((action) => action.timestamp)).not.toContain(1)
	})
})

