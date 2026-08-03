/*
 * Colocated suite for the statement-importer page.
 *
 * WHAT IT PROVES.
 *   • TC1 — a statement import produces the expected list. This page's slice of that scenario is
 *     the "Previous Imports" table: every cell the row projects, in the order the SERVER returned
 *     the rows, plus the click-through to one log's detail view.
 *   • FM2 — the per-file failure indicator, in BOTH of the forms this page actually carries:
 *       – the per-ROW status chip, driven by a bank-scoped attempt marker, for a failure that
 *         happened after the import log existed; and
 *       – the per-FILE banner, driven by a file-keyed map, for a failure that happened BEFORE any
 *         log existed and therefore has no row to attach to.
 *     Both are read-only renderings of what the client observed; neither creates a transaction and
 *     neither overrides the document. The authoritative server `status` is asserted to WIN over a
 *     stale marker, and a stale marker is asserted to be RETIRED once the server reports the
 *     import as completed.
 *   • The SCOPE and the CONTRACT of what this page sends, which no rendering assertion can reach:
 *       – the import-log list query asks only about the SELECTED account, with the exact projection
 *         the row needs and the server's own ordering. A list that lost that filter would show one
 *         account's statement history — file names, closing balances, transaction counts — on
 *         another's screen, and every rendering assertion here would still pass;
 *       – the detail-view route is asserted by the `:id` it was reached WITH, not merely by having
 *         been reached, so a hard-coded, stale or `undefined` destination cannot satisfy it;
 *       – the three writes of the upload chain are asserted argument by argument: the statement
 *         passphrase goes to the selected Bank Account and nowhere else, the file is uploaded
 *         PRIVATELY and attached to the log about to be created, and that log is created under the
 *         same id, pointing at the URL the server returned, for the selected account;
 *       – the chain STOPS at the step that was refused, and runs at most ONCE per click, including
 *         while a passphrase save is still pending — the window in which a second chain used to
 *         create a second import log for the same statement.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *   • It does not assert client-side de-duplication of re-imported rows: FM4 mandates that as a
 *     NON-change, so there is no behaviour to assert. Rows render exactly as the endpoint returns
 *     them, which is why the ordering assertion below reads the server's order back unchanged.
 *   • It does not assert client-side transaction creation. Only the server creates transactions.
 *   • It does not reach into component state. Every assertion is on rendered output, on the
 *     disabled state of a control, or on the ARGUMENTS handed to an SDK seam. The `store.get(...)`
 *     reads are of a SHARED, exported application atom — the same public contract the import step
 *     writes — not of anything private to a component.
 *   • It does not duplicate FM1, FM3 or FM5, which belong to the reconciliation surface and are
 *     covered by that folder's suites, nor the error dialog's own internals, which
 *     `BankRecErrorDialog.test.tsx` covers. What is asserted here is only this page's MOUNT of
 *     that shared dialog: inert while its atom is empty, present once it is not.
 *
 * TWO THINGS THAT SILENTLY EMPTY THE TREE IF GOT WRONG.
 *   1. The list is gated on a selected bank account (`{selectedBankAccount && <StatementImportLog
 *      />}`), so every scenario that expects a table, an empty state or a list error seeds
 *      `selectedBankAccountAtom`. One test deliberately does not, to prove the gate.
 *   2. `StatementImportLog` destructures only `{ data, error }` — there is NO loading state and no
 *      skeleton, so `data: []` and `data: undefined` reach the SAME empty branch.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import {
	TEST_BANK_ACCOUNT,
	createFrappeSDKMock,
	frappeCreateDoc,
	frappeFileUpload,
	frappeHookMutate,
	frappeSDKMock,
	frappeUpdateDoc,
	makeBankStatementImportLog,
	makeErrorMessageError,
	makeFileUploadResponse,
	makeFrappeError,
	makeImportFailures,
	makeSelectedBank,
	makeServerMessagesError,
	makeWarningServerMessagesError
} from '@/test/factories'

// The page imports four SDK hooks at module scope and its subtree reaches `useSWRConfig` through
// `BankPicker -> utils.ts`, so the package is replaced wholesale to keep every one of those seams
// resolvable and unable to reach a real transport.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import BankStatementImporter from './BankStatementImporter'
import {
	bankRecErrorDialogAtom,
	bankRecImportFailuresAtom,
	bankRecPreImportFailuresAtom,
	selectedBankAccountAtom,
	type ImportAttemptMarkers
} from '@/components/features/BankReconciliation/bankRecAtoms'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BankStatementImportLog } from '@/types/Accounts/BankStatementImportLog'

type FrappeErrorFixture = ReturnType<typeof makeFrappeError>

const IMPORT_LOG_DOCTYPE = 'Bank Statement Import Log'

const IMPORTER_ROUTE = '/statement-importer'

/**
 * Stands in for `ViewBankStatementImportLog` at the `:id` child route. Proving navigation with a
 * sentinel ROUTE rather than a mocked `useNavigate` keeps the assertion about observable
 * behaviour — the detail view is reached — instead of about which function was called.
 *
 * It renders the `:id` it was reached WITH, because "a detail view opened" is a materially weaker
 * claim than "the detail view of THIS log opened". A constant sentinel is satisfied by navigating
 * to a hard-coded name, to the wrong row's name, or to `/statement-importer/undefined` — and the
 * last of those is a real possibility here, since the destination is read off a document the
 * server returns. Every navigation assertion below therefore reads the parameter back.
 */
const DETAIL_SENTINEL = 'import-log-detail-reached'

const ImportLogDetailProbe = () => {
	const { id } = useParams()

	return <div>{DETAIL_SENTINEL}:{id}</div>
}

/** The exact text the probe renders for one log — nothing else can satisfy it. */
const detailViewFor = (logName: string): string => `${DETAIL_SENTINEL}:${logName}`

const SELECTED_BANK = makeSelectedBank()

/*
 * Each row carries a slash-bearing `file` so `file.split('/').pop()` yields a real displayed name.
 * `status` uses only the two values the DocType declares; it has no third value and no error field,
 * which is why every failure state below comes from a client-side marker instead.
 */

const COMPLETED_LOG = makeBankStatementImportLog({
	name: 'BSIL-2024-00001',
	file: '/files/hdfc-statement-jan-2024.csv',
	status: 'Completed',
	creation: '2024-01-15 10:30:00.000000',
	start_date: '2024-01-01',
	end_date: '2024-01-31',
	number_of_transactions: 24,
	closing_balance: 152300.75
})

const NOT_STARTED_LOG = makeBankStatementImportLog({
	name: 'BSIL-2024-00002',
	file: '/files/hdfc-statement-feb-2024.xlsx',
	status: 'Not Started',
	creation: '2024-02-14 09:05:11.000000',
	start_date: undefined,
	end_date: undefined,
	number_of_transactions: 0,
	closing_balance: 0
})

const FAILED_LOG = makeBankStatementImportLog({
	name: 'BSIL-2024-00003',
	file: '/files/hdfc-statement-mar-2024.pdf',
	status: 'Not Started',
	creation: '2024-03-12 08:15:42.000000',
	start_date: '2024-03-01',
	end_date: '2024-03-31',
	number_of_transactions: 0,
	closing_balance: 0
})

const INDETERMINATE_LOG = makeBankStatementImportLog({
	name: 'BSIL-2024-00004',
	file: '/files/hdfc-statement-apr-2024.csv',
	status: 'Not Started',
	creation: '2024-04-08 16:42:03.000000',
	start_date: '2024-04-01',
	end_date: '2024-04-30',
	number_of_transactions: 0,
	closing_balance: 0
})

/**
 * The endpoint orders by `creation desc`, so the fixture list is newest-first. Supplying it in the
 * server's own order is what lets the ordering assertion read it back unchanged.
 */
const ALL_LOGS: BankStatementImportLog[] = [
	INDETERMINATE_LOG,
	FAILED_LOG,
	NOT_STARTED_LOG,
	COMPLETED_LOG
]

/**
 * Markers for two of those four logs, nested by bank account exactly as the atom is. Built by
 * merging the shared factory's output rather than by hand, so the key derivation — the bank key is
 * read off each log's own `bank_account` — cannot drift from the rows it marks.
 */
const ATTEMPT_MARKERS: ImportAttemptMarkers = {
	[TEST_BANK_ACCOUNT]: {
		...makeImportFailures(FAILED_LOG, 'failed')[TEST_BANK_ACCOUNT],
		...makeImportFailures(INDETERMINATE_LOG, 'unknown')[TEST_BANK_ACCOUNT]
	}
}

interface ImporterScenario {
	/** What the list query answers with. `undefined` is the pre-arrival state, not a loading state. */
	logs?: BankStatementImportLog[]
	listError?: FrappeErrorFixture
	markers?: ImportAttemptMarkers
	dialogError?: FrappeErrorFixture
	preImportFailures?: Record<string, FrappeErrorFixture>
	uploadError?: FrappeErrorFixture
	withSelectedBank?: boolean
	/** The account to select. Overridden only to prove the query scope is DERIVED from it. */
	selectedBank?: ReturnType<typeof makeSelectedBank>
}

const listQueryResponse = (logs?: BankStatementImportLog[], listError?: FrappeErrorFixture) => ({
	data: logs,
	error: listError,
	isLoading: false,
	isValidating: false,
	mutate: frappeHookMutate
})

/**
 * Installs the list answer for THIS doctype only, leaving any other list query on the shared
 * mock's own empty default. Installed per test rather than once, because the harness's shared
 * teardown discards per-test implementations.
 */
const installImportLogQuery = (logs?: BankStatementImportLog[], listError?: FrappeErrorFixture) => {
	frappeSDKMock.useFrappeGetDocList.mockImplementation((doctype) =>
		doctype === IMPORT_LOG_DOCTYPE ? listQueryResponse(logs, listError) : listQueryResponse()
	)
}

const installFileUploadError = (uploadError: FrappeErrorFixture) => {
	frappeSDKMock.useFrappeFileUpload.mockImplementation(() => ({
		upload: frappeFileUpload,
		progress: 0,
		loading: false,
		error: uploadError,
		isCompleted: false,
		reset: () => undefined
	}))
}

// A store PER TEST is required because the harness performs no global atom reset and
// `selectedBankAccountAtom` is backed by `localStorage`.
const renderImporter = ({
	logs,
	listError,
	markers,
	dialogError,
	preImportFailures,
	uploadError,
	withSelectedBank = true,
	selectedBank = SELECTED_BANK
}: ImporterScenario = {}) => {
	installImportLogQuery(logs, listError)

	if (uploadError) {
		installFileUploadError(uploadError)
	}

	const store = createStore()

	if (withSelectedBank) {
		store.set(selectedBankAccountAtom, selectedBank)
	}
	if (markers) {
		store.set(bankRecImportFailuresAtom, markers)
	}
	if (dialogError) {
		store.set(bankRecErrorDialogAtom, dialogError)
	}
	if (preImportFailures) {
		store.set(bankRecPreImportFailuresAtom, preImportFailures)
	}

	const utils = render(
		<Provider store={store}>
			{/* The page mounts no local provider, so the `Unknown` chip's tooltip throws without this
			  * one; `App.tsx` supplies it outside the router in production. */}
			<TooltipProvider>
				<MemoryRouter initialEntries={[IMPORTER_ROUTE]}>
					<Routes>
						<Route path={IMPORTER_ROUTE}>
							<Route index element={<BankStatementImporter />} />
							<Route path=":id" element={<ImportLogDetailProbe />} />
						</Route>
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</Provider>
	)

	return { ...utils, store }
}

const displayedFileName = (log: BankStatementImportLog): string =>
	log.file.split('/').pop() ?? log.file

const rowFor = (log: BankStatementImportLog): HTMLElement => {
	const link = screen.getByRole('link', { name: displayedFileName(log) })
	const row = link.closest<HTMLElement>('[data-slot="table-row"]')

	if (!row) {
		throw new Error(`No table row was rendered for import log ${log.name}`)
	}

	return row
}

/**
 * The status chip inside a row. The chip's theme is asserted through `data-theme`, never through a
 * class string: `tailwind-merge` is free to reorder and collapse classes, so a class assertion
 * would be brittle in a way that says nothing about the component's intent.
 */
const statusBadgeIn = (row: HTMLElement): HTMLElement => {
	/*
	 * Located by Badge's own variant attributes rather than by `data-slot="badge"`, because that one
	 * attribute is NOT stable across the four states. The `Unknown` chip is wrapped in a
	 * `TooltipTrigger asChild` so it can carry its explanation; Radix merges the trigger's own props
	 * into the element it clones - `data-slot="tooltip-trigger"` among them - and Badge spreads
	 * `...props` AFTER its own `data-slot`, so for that state alone the slot reads `tooltip-trigger`
	 * and a slot-only lookup finds nothing at all. `data-variant`, `data-size` and `data-theme` are
	 * set by Badge and by nothing Radix passes down, and this row renders no other variant-bearing
	 * primitive (its remaining cells are plain text and one anchor), so the three of them together
	 * identify the chip in every state.
	 */
	const badge = row.querySelector<HTMLElement>('[data-variant][data-size][data-theme]')

	if (!badge) {
		throw new Error('The row rendered no status badge')
	}

	return badge
}

/**
 * Selects a statement through the dropzone's own file input, which is how a real selection reaches
 * the page: `react-dropzone` wires that input through `getInputProps`, so a change event on it is
 * the genuine entry point rather than a shortcut around the component.
 */
const chooseStatementFile = async (container: HTMLElement, file: File): Promise<void> => {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]')

	if (!input) {
		throw new Error('The statement dropzone rendered no file input')
	}

	await userEvent.upload(input, file)
}

const csvStatementFile = (name = 'hdfc-statement-jan-2024.csv'): File =>
	new File(['Date,Description,Amount\n2024-01-15,NEFT credit,12500\n'], name, { type: 'text/csv' })

const pdfStatementFile = (name = 'hdfc-statement-jan-2024.pdf'): File =>
	new File(['%PDF-1.7 statement'], name, { type: 'application/pdf' })

const PLACEHOLDER_PDF_PASSPHRASE = 'not-a-real-passphrase'

describe('BankStatementImporter', () => {

	describe('previous imports list (TC1)', () => {

		it('renders one row per log the server returned, in the order it returned them', () => {
			renderImporter({ logs: ALL_LOGS })

			expect(screen.getByText('Previous Imports')).toBeInTheDocument()

			// Scoped to the table, because the bank picker renders a link of its own when the
			// account list is empty — a document-wide link query would collect that too.
			const table = within(screen.getByRole('table'))

			expect(table.getAllByRole('row')).toHaveLength(ALL_LOGS.length + 1)

			// The endpoint orders by `creation desc` and the list is rendered as produced — no
			// client-side re-ordering, no client-side de-duplication (FM4 mandates that absence).
			const renderedFileNames = table.getAllByRole('link').map((link) => link.textContent)

			expect(renderedFileNames).toEqual(ALL_LOGS.map(displayedFileName))
		})

		it('labels all six columns the row projects', () => {
			renderImporter({ logs: [COMPLETED_LOG] })

			const headers = screen
				.getAllByRole('columnheader')
				.map((header) => header.textContent)

			expect(headers).toEqual([
				'Imported On',
				'Status',
				'Transaction Dates',
				'Number of Transactions',
				'Closing Balance',
				'File'
			])
		})

		it('renders every projected cell of a fully populated row', () => {
			renderImporter({ logs: [COMPLETED_LOG] })

			const row = within(rowFor(COMPLETED_LOG))

			expect(row.getByText('15th Jan 2024')).toBeInTheDocument()
			expect(row.getByText('1st Jan 2024 to 31st Jan 2024')).toBeInTheDocument()
			expect(row.getByText('24')).toBeInTheDocument()
			expect(row.getByText(/152,300\.75/)).toBeInTheDocument()

			const fileLink = row.getByRole('link', { name: 'hdfc-statement-jan-2024.csv' })
			expect(fileLink).toHaveAttribute('href', COMPLETED_LOG.file)
			expect(fileLink).toHaveAttribute('target', '_blank')
		})

		it('falls back to a dash when a log carries no statement date range', () => {
			renderImporter({ logs: [NOT_STARTED_LOG] })

			const row = within(rowFor(NOT_STARTED_LOG))

			expect(row.getByText('-')).toBeInTheDocument()
			expect(row.getByText('14th Feb 2024')).toBeInTheDocument()
		})

		it('opens the detail view for the log whose row is clicked', async () => {
			renderImporter({ logs: ALL_LOGS })

			await userEvent.click(rowFor(FAILED_LOG))

			// Reaching the `:id` child route is the observable outcome of
			// `navigate(`/statement-importer/${item.name}`)` — and the parameter it was reached with
			// is what makes this THAT log's detail view rather than merely a detail view. Every row
			// on screen has a distinct name, so a handler that closed over the wrong one, or over a
			// constant, cannot satisfy this.
			expect(await screen.findByText(detailViewFor(FAILED_LOG.name))).toBeInTheDocument()
			expect(screen.queryByText('Previous Imports')).not.toBeInTheDocument()
		})

		it('opens each row on its own log, never a neighbour and never nothing', async () => {
			// Run per row rather than once, because a single-row assertion is also satisfied by a
			// handler that ignores its argument when only one candidate exists.
			for (const log of [COMPLETED_LOG, NOT_STARTED_LOG, INDETERMINATE_LOG]) {
				const { unmount } = renderImporter({ logs: ALL_LOGS })

				await userEvent.click(rowFor(log))

				expect(await screen.findByText(detailViewFor(log.name))).toBeInTheDocument()
				// Not a stale or hard-coded destination, and not the `undefined` a missing name
				// would produce.
				ALL_LOGS.filter((other) => other.name !== log.name).forEach((other) => {
					expect(screen.queryByText(detailViewFor(other.name))).not.toBeInTheDocument()
				})
				expect(screen.queryByText(detailViewFor('undefined'))).not.toBeInTheDocument()

				unmount()
			}
		})
	})

	/* ── The list query itself: scope, projection and ordering ───────────────────────── */

	/**
	 * WHAT THE QUERY ASKS FOR IS PART OF THE BEHAVIOUR.
	 *
	 * The rows above are asserted from a mocked answer, so nothing in them can tell whether the
	 * question was scoped. `Bank Statement Import Log` is readable by System Manager, and a statement
	 * import log names the file, the closing balance and the transaction count of a bank account — so
	 * a list that lost its `bank_account` filter would show one company's statement history on
	 * another account's screen, and every rendering assertion in this suite would still pass.
	 *
	 * These assertions are on the ARGUMENTS the page hands the SDK, for the same reason the
	 * reconciliation suite pins its endpoint parameters: it is the only place the scope exists.
	 */
	describe('import-log query scope', () => {

		/** The call the page makes for THIS doctype, with the arguments it made it with. */
		const importLogQueryCall = () => {
			const call = frappeSDKMock.useFrappeGetDocList.mock.calls
				.find(([doctype]) => doctype === IMPORT_LOG_DOCTYPE)

			if (!call) {
				throw new Error('The page issued no import-log list query')
			}

			return call
		}

		it("asks only for the selected account's logs, newest first, ten at a time", () => {
			renderImporter({ logs: ALL_LOGS })

			const [, args] = importLogQueryCall()

			// The filter is the whole of the data-isolation boundary on this screen.
			expect(args?.filters).toEqual([['bank_account', '=', SELECTED_BANK.name]])
			// Exactly the eight fields the row projects — no `password`-bearing or unrelated field is
			// fetched "just in case", and none the row needs is missing.
			expect(args?.fields).toEqual([
				'name',
				'file',
				'status',
				'number_of_transactions',
				'start_date',
				'end_date',
				'closing_balance',
				'creation'
			])
			// The server orders the rows; the client renders them as produced (FM4).
			expect(args?.orderBy).toEqual({ field: 'creation', order: 'desc' })
			expect(args?.limit).toBe(10)
		})

		it('scopes the query to whichever account is selected, not to a fixed one', () => {
			// Derivation, proven by changing the input: the same page against a second account must
			// ask about that account. A hard-coded or stale filter passes the test above and fails
			// this one.
			const secondBank = makeSelectedBank({
				name: 'Second Bank - Test Company',
				account_name: 'Second Bank Savings'
			})

			renderImporter({ logs: [], selectedBank: secondBank })

			const [, args] = importLogQueryCall()

			expect(args?.filters).toEqual([['bank_account', '=', 'Second Bank - Test Company']])
			expect(args?.filters).not.toEqual([['bank_account', '=', SELECTED_BANK.name]])
		})

		it('asks nothing at all until an account has been selected', () => {
			// The list lives behind `{selectedBankAccount && <StatementImportLog />}`, so with no
			// account there is no account whose logs could be listed and the query is never issued —
			// which is the stronger form of the `null`-key guard the component also passes for it.
			renderImporter({ logs: ALL_LOGS, withSelectedBank: false })

			expect(
				frappeSDKMock.useFrappeGetDocList.mock.calls
					.filter(([doctype]) => doctype === IMPORT_LOG_DOCTYPE)
			).toHaveLength(0)
		})

		it('does not revalidate the list on window focus', () => {
			// Pinned because the page compensates for it elsewhere: server truth retires client
			// markers from THIS fetch, so a change of revalidation policy changes when that happens.
			renderImporter({ logs: ALL_LOGS })

			const [, , , options] = importLogQueryCall()

			expect(options).toEqual({ revalidateOnFocus: false })
		})
	})

	describe('per-row status chip (FM2)', () => {

		it("renders the server's own status when the import completed", () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const badge = statusBadgeIn(rowFor(COMPLETED_LOG))

			expect(badge).toHaveAttribute('data-theme', 'green')
			expect(badge).toHaveTextContent('Completed')
		})

		it('renders the raw server status for a log the client has observed nothing about', () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const badge = statusBadgeIn(rowFor(NOT_STARTED_LOG))

			expect(badge).toHaveAttribute('data-theme', 'gray')
			expect(badge).toHaveTextContent('Not Started')
		})

		/**
		 * The failure indicator itself. It is driven from a marker rather than from the document
		 * because `Bank Statement Import Log` persists no error field and its status never advances
		 * past `Not Started` when a synchronous import rolls back — so the marker is the only
		 * failure signal that exists.
		 */
		it('marks a log the server refused as Failed', () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const badge = statusBadgeIn(rowFor(FAILED_LOG))

			expect(badge).toHaveAttribute('data-theme', 'red')
			// Solid rather than the subtle default, so the 12px label clears the WCAG AA contrast
			// floor in dark mode as well as light.
			expect(badge).toHaveAttribute('data-variant', 'solid')
			expect(badge).toHaveTextContent('Failed')
		})

		/**
		 * "The client could not establish what happened" is a different claim from "the import did
		 * not happen", so it renders distinctly. `orange` is the compound variant that resolves to
		 * the amber surface tokens; the Badge primitive exposes no literal amber theme.
		 */
		it('distinguishes an indeterminate attempt from a refused one', () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const badge = statusBadgeIn(rowFor(INDETERMINATE_LOG))

			expect(badge).toHaveAttribute('data-theme', 'orange')
			expect(badge).toHaveTextContent('Unknown')
			expect(badge).not.toHaveTextContent('Failed')
		})

		/*
		 * `Unknown` is the one label that cannot carry its own meaning: it says only that the client
		 * could not find out, and the rest of the sentence lived in a dialog raised at the moment of
		 * the attempt, which the marker outlives. The explanation therefore has to travel with the
		 * chip for pointer, keyboard and assistive-technology users alike.
		 */
		describe('the indeterminate chip explains itself', () => {

			it('carries the whole explanation as its accessible name', () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				const label = statusBadgeIn(rowFor(INDETERMINATE_LOG)).getAttribute('aria-label')

				expect(label).toBeTruthy()
				expect(label).toContain('Unknown')
				expect(label).toContain('did not finish')
				// Outcome-INDETERMINATE wording, deliberately: the client not learning the answer is
				// not evidence the import did not happen, and calling it a failure would invite a
				// re-import of work that may already exist.
				expect(label).toContain('could not be established whether the server recorded it')
				expect(label).not.toMatch(/\bfailed\b/i)
			})

			it('carries a glyph, so it is not distinguished by colour alone', () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				const icon = statusBadgeIn(rowFor(INDETERMINATE_LOG)).querySelector('svg')

				expect(icon).toBeTruthy()
				expect(icon).toHaveAttribute('aria-hidden', 'true')
			})

			/*
			 * Radix renders a focusable button for a tooltip trigger BY DEFAULT, but `asChild` hands
			 * that role to the Badge span and Radix adds no `tabIndex` of its own - so without an
			 * explicit one the explanation is reachable by POINTER ONLY and a sighted keyboard-only
			 * reviewer has no route to it at all.
			 */
			it('is a keyboard tab stop, and the only chip that is one', () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				expect(statusBadgeIn(rowFor(INDETERMINATE_LOG)).tabIndex).toBe(0)
				expect(statusBadgeIn(rowFor(COMPLETED_LOG)).hasAttribute('tabindex')).toBe(false)
				expect(statusBadgeIn(rowFor(FAILED_LOG)).hasAttribute('tabindex')).toBe(false)
				expect(statusBadgeIn(rowFor(NOT_STARTED_LOG)).hasAttribute('tabindex')).toBe(false)
			})

			it('shows the explanation on hover', async () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				await userEvent.hover(statusBadgeIn(rowFor(INDETERMINATE_LOG)))

				await waitFor(() => {
					expect(screen.getAllByText(/could not be established whether the server recorded it/).length)
						.toBeGreaterThan(0)
				})
			})

			it('shows the same explanation on keyboard focus, with no pointer involved', async () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				const chip = statusBadgeIn(rowFor(INDETERMINATE_LOG))
				chip.focus()

				expect(chip).toHaveFocus()

				await waitFor(() => {
					expect(screen.getAllByText(/could not be established whether the server recorded it/).length)
						.toBeGreaterThan(0)
				})

				await waitFor(() => {
					expect(chip.getAttribute('aria-describedby')).toBeTruthy()
				})

				await userEvent.keyboard('{Escape}')
			})
		})

		it('leaves rows with no marker untouched', () => {
			renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

			const unmarked = statusBadgeIn(rowFor(NOT_STARTED_LOG))

			expect(unmarked).not.toHaveAttribute('data-theme', 'red')
			expect(unmarked).not.toHaveAttribute('data-theme', 'orange')
		})

		/**
		 * Markers are nested by bank account, so one recorded against a DIFFERENT account must not
		 * reach this list. A flat map would have leaked here.
		 */
		it("ignores a marker recorded against another bank account", () => {
			renderImporter({
				logs: [NOT_STARTED_LOG],
				markers: makeImportFailures(
					makeBankStatementImportLog({
						name: NOT_STARTED_LOG.name,
						bank_account: 'Second Bank - Test Company'
					}),
					'failed'
				)
			})

			expect(statusBadgeIn(rowFor(NOT_STARTED_LOG))).toHaveAttribute('data-theme', 'gray')
		})

		/*
		 * A marker is an observation of one attempt; the document is the record. A fetched
		 * `Completed` status therefore wins, and the stale marker is retired so it cannot outlive the
		 * condition it described.
		 */
		it('lets an authoritative Completed status beat a stale failure marker, and retires it', async () => {
			const { store } = renderImporter({
				logs: [COMPLETED_LOG],
				markers: makeImportFailures(COMPLETED_LOG, 'failed')
			})

			const badge = statusBadgeIn(rowFor(COMPLETED_LOG))
			expect(badge).toHaveAttribute('data-theme', 'green')
			expect(badge).toHaveTextContent('Completed')
			expect(badge).not.toHaveTextContent('Failed')

			await waitFor(() => {
				expect(store.get(bankRecImportFailuresAtom)).toEqual({})
			})
		})

		it('retires only the completed log of the account this list queried', async () => {
			const { store } = renderImporter({
				logs: [COMPLETED_LOG],
				markers: {
					[TEST_BANK_ACCOUNT]: {
						...makeImportFailures(COMPLETED_LOG, 'failed')[TEST_BANK_ACCOUNT],
						...makeImportFailures(FAILED_LOG, 'failed')[TEST_BANK_ACCOUNT]
					}
				}
			})

			await waitFor(() => {
				expect(store.get(bankRecImportFailuresAtom)).toEqual({
					[TEST_BANK_ACCOUNT]: { [FAILED_LOG.name]: 'failed' }
				})
			})
		})
	})


	describe('per-file failure banner for a failure before any import log exists (FM2)', () => {

		/**
		 * The upload chain can fail while saving the statement password, while uploading the file or
		 * while creating the log — and in each case NO document exists, so no row could carry the
		 * outcome. The failure is attributed to the file name instead, which is the only identifier
		 * the attempt has.
		 */
		it("names the file and renders the server's own words for it", () => {
			const fileName = 'hdfc-statement-jan-2024.csv'
			const message = 'The uploaded file contains no transaction rows.'

			renderImporter({
				logs: [],
				preImportFailures: { [fileName]: makeServerMessagesError(message) }
			})

			expect(screen.getByText(`${fileName} could not be uploaded.`)).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()
		})

		it('creates no rows of its own — the list stays as the server reported it', () => {
			renderImporter({
				logs: [],
				preImportFailures: {
					'hdfc-statement-jan-2024.csv': makeServerMessagesError('Invalid file type.')
				}
			})

			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})

		/**
		 * Once a failure is attributed to a file, the unattributed hook banner is suppressed: it
		 * would otherwise print the identical normalised envelope a second time, without the file
		 * name that makes it useful.
		 */
		it('suppresses the unattributed hook banner it would otherwise duplicate', () => {
			const attributed = 'The uploaded file could not be parsed.'
			const unattributed = 'Unattributed upload-hook rejection.'

			renderImporter({
				logs: [],
				preImportFailures: { 'hdfc-statement-jan-2024.csv': makeServerMessagesError(attributed) },
				uploadError: makeServerMessagesError(unattributed)
			})

			expect(screen.getByText(attributed)).toBeInTheDocument()
			expect(screen.queryByText(unattributed)).not.toBeInTheDocument()
			expect(screen.getAllByRole('alert')).toHaveLength(1)
		})

		it('still shows the hook banner when no failure has been attributed to a file', () => {
			const unattributed = 'Unattributed upload-hook rejection.'

			renderImporter({ logs: [], uploadError: makeServerMessagesError(unattributed) })

			expect(screen.getByText(unattributed)).toBeInTheDocument()
			expect(screen.getByRole('alert')).toBeInTheDocument()
		})
	})

	describe('empty state', () => {

		it('invites a first import when the account has none', () => {
			renderImporter({ logs: [] })

			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})

		/**
		 * There is deliberately NO loading state: the component destructures only `{ data, error }`,
		 * so an un-arrived list reaches the same branch as an empty one. Asserting a skeleton here
		 * would assert a component that does not exist.
		 */
		it('reaches the same branch before the list has arrived', () => {
			renderImporter({ logs: undefined })

			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})

	describe('list query rejection', () => {

		/**
		 * PATH 1 — `_server_messages`, the double-encoded envelope a `frappe.throw` produces. The
		 * banner collapses Frappe's placeholder title into its friendly heading, and the server's
		 * own sentence reaches the user verbatim.
		 */
		it("renders the server's message from a _server_messages envelope", () => {
			const message = 'You are not permitted to read Bank Statement Import Log.'

			renderImporter({ listError: makeServerMessagesError(message) })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()
			expect(screen.getByText('There was an error.')).toBeInTheDocument()
		})

		/** PATH 2 — text arriving in `_error_message` instead, which the parser appends. */
		it("renders the server's message from an _error_message envelope", () => {
			const message = 'The linked bank account has been disabled.'

			renderImporter({ listError: makeErrorMessageError(message) })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText(message)).toBeInTheDocument()
		})

		/**
		 * Severity is the SERVER'S decision: the banner themes on the indicator the server sent and
		 * makes no judgement of its own. The theme lives in the class list only for `Alert`, which
		 * is why this one assertion reads a token class rather than a data attribute.
		 */
		it("takes severity from the server's own indicator", () => {
			const { unmount } = renderImporter({
				listError: makeWarningServerMessagesError('The statement covers a closed period.')
			})
			expect(screen.getByRole('alert')).toHaveClass('text-ink-amber-3')
			unmount()

			renderImporter({ listError: makeServerMessagesError('Permission denied.') })
			expect(screen.getByRole('alert')).toHaveClass('text-ink-red-3')
		})

		it('reports the rejection without claiming the account has imports', () => {
			renderImporter({ listError: makeServerMessagesError('Permission denied.') })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})

	describe('shared error dialog mount', () => {

		it('is inert while the shared atom holds no error', () => {
			renderImporter({ logs: ALL_LOGS })

			expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull()
		})

		/**
		 * The dialog is PORTALED to `document.body`, outside the container `render` returns, so it
		 * is queried through `screen`.
		 */
		it("shows the server's own words once the shared atom carries an error", () => {
			const message = 'The statement could not be imported because the file is empty.'

			renderImporter({ logs: ALL_LOGS, dialogError: makeServerMessagesError(message) })

			const dialog = screen.getByRole('alertdialog')

			expect(dialog).toBeInTheDocument()
			expect(within(dialog).getByText(message)).toBeInTheDocument()
			expect(within(dialog).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
		})

		it('dismisses without disturbing the list behind it', async () => {
			renderImporter({
				logs: [COMPLETED_LOG],
				dialogError: makeServerMessagesError('The statement could not be imported.')
			})

			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})

			expect(statusBadgeIn(rowFor(COMPLETED_LOG))).toHaveTextContent('Completed')
		})
	})

	/*
	 * These drive the page's OWN upload handler, because that handler is where the pre-log failure
	 * marker is written: seeding the atom proves the rendering, but only running the chain proves the
	 * attribution.
	 */
	describe('statement upload', () => {

		it('enables upload once a statement has been chosen', async () => {
			const { container } = renderImporter({ logs: [] })

			expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()

			await chooseStatementFile(container, csvStatementFile())

			expect(screen.getByText('hdfc-statement-jan-2024.csv')).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()
		})

		it('opens the new import log once the server has created it', async () => {
			const createdLog = makeBankStatementImportLog({ name: 'BSIL-2024-00009' })

			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(createdLog)

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			// The destination is the name the SERVER gave the document it created — read back off the
			// route, so navigating to a client-minted id, to the previous row's id, or to
			// `/statement-importer/undefined` cannot satisfy it.
			expect(await screen.findByText(detailViewFor('BSIL-2024-00009'))).toBeInTheDocument()
			expect(screen.queryByText(detailViewFor('undefined'))).not.toBeInTheDocument()
		})

		/**
		 * FM2 end to end for the pre-log case: an empty or malformed file is refused by the SERVER,
		 * and the refusal is reported against the file by name, in the server's own words, with no
		 * row invented for it and no transaction created.
		 */
		it("attributes a server refusal to the file and repeats the server's words", async () => {
			const message = 'The uploaded statement contains no transactions.'
			frappeFileUpload.mockRejectedValue(makeServerMessagesError(message))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(
				await screen.findByText('hdfc-statement-jan-2024.csv could not be uploaded.')
			).toBeInTheDocument()

			const dialog = await screen.findByRole('alertdialog')
			expect(within(dialog).getByText(message)).toBeInTheDocument()

			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
			expect(frappeCreateDoc).not.toHaveBeenCalled()
		})

		/**
		 * A rejection carrying NO server envelope is a statement about the connection, not about the
		 * server. The page must therefore report an indeterminate outcome rather than claim the
		 * import failed — and must not leak the SDK's own `TypeError` text to the user.
		 */
		it('reports an outcome it cannot establish as indeterminate, not as a failure', async () => {
			const sdkInternalText = "Cannot read properties of undefined (reading 'data')"
			frappeFileUpload.mockRejectedValue(new TypeError(sdkInternalText))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(
				await screen.findByText('hdfc-statement-jan-2024.csv could not be uploaded.')
			).toBeInTheDocument()

			const dialog = await screen.findByRole('alertdialog')
			expect(
				within(dialog).getByText(/it is not known whether this request was recorded/)
			).toBeInTheDocument()
			expect(screen.queryByText(sdkInternalText)).not.toBeInTheDocument()
		})

		/**
		 * A retry supersedes whatever the previous attempt observed. The marker is keyed by file
		 * name and dropped before the retry is dispatched, so one file can never accumulate two
		 * reports and a superseded message cannot linger next to its replacement.
		 */
		it('supersedes a previous report when the same file is retried', async () => {
			const firstRefusal = 'The uploaded statement contains no transactions.'
			const secondRefusal = 'A statement for this period has already been imported.'

			frappeFileUpload
				.mockRejectedValueOnce(makeServerMessagesError(firstRefusal))
				.mockRejectedValueOnce(makeServerMessagesError(secondRefusal))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
			expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
			expect(screen.getAllByText(firstRefusal).length).toBeGreaterThan(0)

			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(screen.getAllByText(secondRefusal).length).toBeGreaterThan(0)
			})
			expect(screen.queryByText(firstRefusal)).not.toBeInTheDocument()
			expect(screen.getAllByText(/could not be uploaded\.$/)).toHaveLength(1)
		})

		/**
		 * A failure in the password step has no banner of its own, so it must still be attributed.
		 * That the chain also STOPS there — nothing uploaded, no log created — is asserted under
		 * "the upload chain's call contract" below, where the step's arguments live.
		 */
		it('attributes a failure in the statement-password step to the file as well', async () => {
			const message = 'Not permitted to update Bank Account.'
			frappeUpdateDoc.mockRejectedValue(makeServerMessagesError(message))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())

			const passwordField = screen.getByLabelText('PDF Password')
			await userEvent.type(passwordField, PLACEHOLDER_PDF_PASSPHRASE)
			expect(passwordField).toHaveValue(PLACEHOLDER_PDF_PASSPHRASE)

			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(
				await screen.findByText('hdfc-statement-jan-2024.pdf could not be uploaded.')
			).toBeInTheDocument()
			expect(within(await screen.findByRole('alertdialog')).getByText(message)).toBeInTheDocument()
		})

		/**
		 * A failure in the LAST step is the one with something already on the server: the file has
		 * been uploaded and only the log is missing. It must still be attributed and must still not
		 * hand the reviewer to a document that does not exist.
		 */
		it('attributes a failure in the log-creation step to the file as well', async () => {
			const message = 'Not permitted to create Bank Statement Import Log.'
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockRejectedValue(makeServerMessagesError(message))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(
				await screen.findByText('hdfc-statement-jan-2024.csv could not be uploaded.')
			).toBeInTheDocument()
			expect(within(await screen.findByRole('alertdialog')).getByText(message)).toBeInTheDocument()

			// No hand-off to a log that was never created.
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
		})
	})

	/* ── The upload chain's call contract ────────────────────────────────────────────── */

	/**
	 * WHAT THE CHAIN SENDS, AND IN WHAT ORDER.
	 *
	 * The three operations of the upload chain are the most sensitive writes this SPA makes: one
	 * persists a statement PASSPHRASE on a Bank Account, one puts a customer's bank statement into
	 * file storage, and one creates the document the import will then run from. The rendering
	 * assertions above are satisfied by any arguments at all — they only ever observe that the chain
	 * resolved — so the arguments are asserted here, at the seam, because there is nowhere else they
	 * are visible.
	 *
	 * Each assertion below corresponds to something that would be a real defect and would otherwise
	 * be invisible: a passphrase written against the WRONG account, a statement uploaded PUBLICLY or
	 * attached to nothing, a log created for a DIFFERENT account or pointing at a different file than
	 * the one uploaded, the passphrase travelling somewhere it does not belong, and the chain pressing
	 * on after a step was refused.
	 */
	describe("the upload chain's call contract", () => {

		/** The docname the page minted for this attempt, read off the upload it performed. */
		const uploadedDocname = (): string => {
			const args = frappeFileUpload.mock.calls[0]?.[1]

			if (!args || typeof args.docname !== 'string') {
				throw new Error('The page uploaded no file, or uploaded it without a docname')
			}

			return args.docname
		}

		/** Runs the whole chain for a PDF with a passphrase typed, resolving every step. */
		const uploadProtectedPdf = async (): Promise<void> => {
			frappeUpdateDoc.mockResolvedValue(makeSelectedBank())
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00011' }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())
			await userEvent.type(screen.getByLabelText('PDF Password'), PLACEHOLDER_PDF_PASSPHRASE)
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => {
				expect(screen.getByText(detailViewFor('BSIL-2024-00011'))).toBeInTheDocument()
			})
		}

		it('saves the passphrase on the SELECTED bank account, and only there', async () => {
			await uploadProtectedPdf()

			// One write, to one account, carrying one field. A wrong `docname` here would store this
			// account's passphrase against another company's bank account.
			expect(frappeUpdateDoc).toHaveBeenCalledTimes(1)
			expect(frappeUpdateDoc).toHaveBeenCalledWith(
				'Bank Account',
				SELECTED_BANK.name,
				{ statement_password: PLACEHOLDER_PDF_PASSPHRASE }
			)
		})

		it('uploads the chosen file PRIVATELY, attached to the log it is about to create', async () => {
			await uploadProtectedPdf()

			expect(frappeFileUpload).toHaveBeenCalledTimes(1)

			const [uploadedFile, args] = frappeFileUpload.mock.calls[0]

			// The file the user chose, not a re-read or a re-encoding of it.
			expect(uploadedFile).toBeInstanceOf(File)
			expect(uploadedFile.name).toBe('hdfc-statement-jan-2024.pdf')

			// `isPrivate` is the whole of the access control on the stored statement: a public file
			// URL is readable by anyone who has it, signed in or not.
			expect(args.isPrivate).toBe(true)
			// Attached to the document, in the field the import reads, under the name the log will be
			// created with — an attachment pointing at nothing is orphaned in file storage.
			expect(args.doctype).toBe('Bank Statement Import Log')
			expect(args.fieldname).toBe('file')
			expect(args.docname).toMatch(/^new-bank-statement-import-log-\d+$/)
		})

		it('creates the log under the SAME id it uploaded against, for the selected account', async () => {
			await uploadProtectedPdf()

			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).toHaveBeenCalledWith('Bank Statement Import Log', {
				// The same generated name the attachment was made against. Two different ids here
				// would leave the uploaded statement attached to a document that never existed and
				// create a log with no file.
				name: uploadedDocname(),
				// The URL the SERVER returned for the stored file — private, and never a client-built
				// path.
				file: makeFileUploadResponse().file_url,
				bank_account: SELECTED_BANK.name
			})
		})

		it('keeps the passphrase out of the upload and out of the import log', async () => {
			await uploadProtectedPdf()

			// The passphrase belongs to the Bank Account, which stores it encrypted, and to nothing
			// else. Serialising each payload is the only way to prove it is absent from ALL of it
			// rather than merely absent from the field somebody thought to check.
			const uploadArgs = JSON.stringify(frappeFileUpload.mock.calls[0][1])
			const createPayload = JSON.stringify(frappeCreateDoc.mock.calls[0][1])

			expect(uploadArgs).not.toContain(PLACEHOLDER_PDF_PASSPHRASE)
			expect(createPayload).not.toContain(PLACEHOLDER_PDF_PASSPHRASE)
			expect(createPayload).not.toContain('statement_password')

			// Nor does it reach the route, where it would land in browser history.
			expect(screen.queryByText(new RegExp(PLACEHOLDER_PDF_PASSPHRASE))).not.toBeInTheDocument()
		})

		it('never writes a passphrase for a statement that has no password field', async () => {
			// The field is offered for PDFs only, so a CSV upload must not touch the Bank Account at
			// all — writing a blank passphrase would clear the one the account already had.
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00012' }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			expect(screen.queryByLabelText('PDF Password')).not.toBeInTheDocument()

			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
			await screen.findByText(detailViewFor('BSIL-2024-00012'))

			expect(frappeUpdateDoc).not.toHaveBeenCalled()
		})

		it('writes no passphrase for a PDF whose password field was left blank', async () => {
			// Blank means "use whatever the account already has", so there is nothing to save.
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00013' }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())
			expect(screen.getByLabelText('PDF Password')).toHaveValue('')

			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
			await screen.findByText(detailViewFor('BSIL-2024-00013'))

			expect(frappeUpdateDoc).not.toHaveBeenCalled()
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
		})

		it('STOPS when the passphrase cannot be saved — nothing is uploaded and no log is created', async () => {
			// Pressing on would upload a protected statement the server has no password for, and
			// create a log whose import can only fail — after the reviewer has been navigated to it.
			frappeUpdateDoc.mockRejectedValue(makeServerMessagesError('Not permitted to update Bank Account.'))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())
			await userEvent.type(screen.getByLabelText('PDF Password'), PLACEHOLDER_PDF_PASSPHRASE)
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await screen.findByRole('alertdialog')

			expect(frappeFileUpload).not.toHaveBeenCalled()
			expect(frappeCreateDoc).not.toHaveBeenCalled()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})

		it('STOPS when the upload is refused — no log is created for a file that was not stored', async () => {
			frappeFileUpload.mockRejectedValue(makeServerMessagesError('Invalid file type.'))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await screen.findByRole('alertdialog')

			expect(frappeCreateDoc).not.toHaveBeenCalled()
			expect(screen.queryByText(new RegExp(DETAIL_SENTINEL))).not.toBeInTheDocument()
		})
	})

	/* ── Single flight across the whole chain ────────────────────────────────────────── */

	/**
	 * ONE CLICK, ONE CHAIN.
	 *
	 * The chain is three sequential server operations, and the control used to be held closed by the
	 * upload hook's and the create hook's own in-flight flags only. Neither describes the FIRST
	 * operation: the update hook's `loading` was never read, so for the whole duration of a
	 * protected-PDF passphrase save the control was enabled. A second click there started a second
	 * chain from the beginning, each chain minted its own `new-bank-statement-import-log-…` name, and
	 * BOTH completed — leaving two import logs for one file, with no same-file de-duplication
	 * anywhere to reconcile them. Importing from each then creates every transaction twice.
	 *
	 * FM4 forbids client-side de-duplication of transactions, which is exactly why this matters: the
	 * duplicates are not going to be cleaned up downstream. The single click has to stay single.
	 *
	 * Each test below holds one step of the chain open with a deferred promise — the only way to
	 * observe the window rather than race it — and then asserts both halves: the control is closed,
	 * and each operation ran at most once.
	 */
	describe('single flight across the whole chain', () => {

		/** A promise this test resolves by hand, so one step of the chain can be held open. */
		const deferred = <T,>() => {
			let resolve: (value: T) => void = () => undefined
			const promise = new Promise<T>((res) => { resolve = res })

			return { promise, resolve }
		}

		const uploadButton = (): HTMLElement => screen.getByRole('button', { name: /Upload/ })

		/**
		 * Clicks Upload again while a chain is in flight.
		 *
		 * `pointerEventsCheck` is disabled because the control carries
		 * `disabled:pointer-events-none`, which makes user-event refuse the interaction outright and
		 * report the harness's own objection instead of exercising the page. Turning the check off
		 * lets the click be delivered exactly as a rapid second press would deliver it, and leaves
		 * the page — not the test helper — to be the thing that refuses it.
		 */
		const clickUploadAgain = async (): Promise<void> => {
			await userEvent.click(uploadButton(), { pointerEventsCheck: 0 })
		}

		it('starts no second chain while the passphrase save is pending', async () => {
			const passwordSave = deferred<unknown>()
			frappeUpdateDoc.mockReturnValue(passwordSave.promise)
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00014' }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())
			await userEvent.type(screen.getByLabelText('PDF Password'), PLACEHOLDER_PDF_PASSPHRASE)
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			// THE WINDOW: the passphrase save is in flight and neither hook flag says so.
			expect(frappeUpdateDoc).toHaveBeenCalledTimes(1)
			expect(uploadButton()).toBeDisabled()
			expect(screen.getByRole('button', { name: 'Uploading...' })).toBeInTheDocument()

			await clickUploadAgain()
			await clickUploadAgain()

			// No second chain: the passphrase is not written twice, and nothing has run ahead.
			expect(frappeUpdateDoc).toHaveBeenCalledTimes(1)
			expect(frappeFileUpload).not.toHaveBeenCalled()
			expect(frappeCreateDoc).not.toHaveBeenCalled()

			// Releasing the step lets the ONE chain finish, proving the window was transient.
			await act(async () => {
				passwordSave.resolve(makeSelectedBank())
			})

			expect(await screen.findByText(detailViewFor('BSIL-2024-00014'))).toBeInTheDocument()
			expect(frappeUpdateDoc).toHaveBeenCalledTimes(1)
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
		})

		it('starts no second chain while the file upload is pending', async () => {
			const fileUpload = deferred<ReturnType<typeof makeFileUploadResponse>>()
			frappeFileUpload.mockReturnValue(fileUpload.promise)
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00015' }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => expect(frappeFileUpload).toHaveBeenCalledTimes(1))
			expect(uploadButton()).toBeDisabled()

			await clickUploadAgain()

			// One upload, and no log created from a file that has not finished being stored.
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).not.toHaveBeenCalled()

			await act(async () => {
				fileUpload.resolve(makeFileUploadResponse())
			})

			expect(await screen.findByText(detailViewFor('BSIL-2024-00015'))).toBeInTheDocument()
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
		})

		it('starts no second chain while the import log is being created', async () => {
			// The most expensive window to lose: a second chain here creates a SECOND log for the
			// same statement, and both survive.
			const logCreation = deferred<ReturnType<typeof makeBankStatementImportLog>>()
			frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
			frappeCreateDoc.mockReturnValue(logCreation.promise)

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => expect(frappeCreateDoc).toHaveBeenCalledTimes(1))
			expect(uploadButton()).toBeDisabled()

			await clickUploadAgain()

			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)

			await act(async () => {
				logCreation.resolve(makeBankStatementImportLog({ name: 'BSIL-2024-00016' }))
			})

			expect(await screen.findByText(detailViewFor('BSIL-2024-00016'))).toBeInTheDocument()
			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
		})

		it('refuses a second entry dispatched inside the SAME batch as the first', async () => {
			/*
			 * The check-then-act race itself, which the `disabled` attribute cannot close: it is
			 * applied by a later render, and both handlers below run against the closure of the render
			 * that is already on screen. A guard reading component STATE would therefore see `false`
			 * twice and admit both chains. Two clicks are dispatched inside one `act` scope so they
			 * are processed before any re-render, which is the only way to reach that case.
			 */
			const fileUpload = deferred<ReturnType<typeof makeFileUploadResponse>>()
			frappeFileUpload.mockReturnValue(fileUpload.promise)
			frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'BSIL-2024-00017' }))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())

			const button = uploadButton()
			await act(async () => {
				button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
				button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
			})

			expect(frappeFileUpload).toHaveBeenCalledTimes(1)

			await act(async () => {
				fileUpload.resolve(makeFileUploadResponse())
			})

			// One file stored, one log created, one hand-off.
			expect(frappeFileUpload).toHaveBeenCalledTimes(1)
			expect(frappeCreateDoc).toHaveBeenCalledTimes(1)
			expect(await screen.findByText(detailViewFor('BSIL-2024-00017'))).toBeInTheDocument()
		})

		it('reopens the control only for a chain that created nothing', async () => {
			// A refused chain leaves no log, so the retry is the reviewer's to make and the control
			// must come back. This is the counterpart to the tests above: the guard closes the window,
			// it does not lock the form.
			frappeFileUpload.mockRejectedValue(makeServerMessagesError('Invalid file type.'))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, csvStatementFile())
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await screen.findByRole('alertdialog')

			// Dismissed first: an open alert dialog marks the rest of the page inert, so the control
			// is deliberately absent from the accessibility tree until the reviewer has acknowledged
			// the refusal.
			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
			await waitFor(() => {
				expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
			})

			expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()

			// And a retry genuinely dispatches again rather than being swallowed by a stuck guard.
			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			await waitFor(() => expect(frappeFileUpload).toHaveBeenCalledTimes(2))
		})
	})

	describe('page shell', () => {

		it('asks for a company and a bank account before anything else', () => {
			renderImporter({ logs: [] })

			expect(screen.getByText('Company')).toBeInTheDocument()
			expect(screen.getByText('Bank Account')).toBeInTheDocument()
		})

		it('offers the statement dropzone once an account is selected', () => {
			renderImporter({ logs: [] })

			expect(screen.getByText('Bank Statement')).toBeInTheDocument()
			expect(screen.getByText('Drop a file here, or click to select a file')).toBeInTheDocument()
		})

		it('keeps upload unavailable until a file has been chosen', () => {
			renderImporter({ logs: [] })

			expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()
		})

		it('explains the expected statement columns on request', async () => {
			renderImporter({ logs: [] })

			await userEvent.click(screen.getByRole('button', { name: 'View Instructions' }))

			const instructions = screen.getByRole('dialog')

			expect(within(instructions).getByText('Statement Import Instructions')).toBeInTheDocument()
			expect(within(instructions).getByText('Column Name')).toBeInTheDocument()
			expect(within(instructions).getByText('Maps To')).toBeInTheDocument()
		})

		/**
		 * The render gate. Without a selected account there is no account whose logs could be
		 * listed, so neither the list nor the dropzone is offered — and upload stays unavailable.
		 */
		it('withholds the list and the dropzone until an account is selected', () => {
			renderImporter({ logs: ALL_LOGS, withSelectedBank: false })

			expect(screen.queryByText('Previous Imports')).not.toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
			expect(screen.queryByText('Bank Statement')).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()
		})
	})
})
