/**
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
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *   • It does not assert client-side de-duplication of re-imported rows: FM4 mandates that as a
 *     NON-change, so there is no behaviour to assert. Rows render exactly as the endpoint returns
 *     them, which is why the ordering assertion below reads the server's order back unchanged.
 *   • It does not assert client-side transaction creation. Only the server creates transactions.
 *   • It does not reach into component state. Every assertion is on rendered output or on the
 *     disabled state of a control. The two `store.get(...)` reads are of a SHARED, exported
 *     application atom — the same public contract the import step writes — not of anything
 *     private to a component.
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
 *      skeleton. `data: []` and `data: undefined` therefore reach the SAME empty branch, and both
 *      are covered.
 *
 * Vitest's API is exposed at runtime by `globals: true` but is NOT typed ambiently, because
 * `tsconfig.app.json` declares no `types` array — hence the explicit `'vitest'` imports.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter, Route, Routes } from 'react-router'
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

// The page imports four SDK hooks at module scope, and its subtree reaches `useSWRConfig` through
// `BankPicker -> utils.ts`. Replacing the package wholesale with the ONE shared mock is what keeps
// every one of those seams resolvable and unable to reach a real transport. `vi.mock` is hoisted
// above the imports, so the factory runs lazily on first import of the mocked module.
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

/**
 * `FrappeError` is only ever reached here through the factories, so the type is derived from one
 * of them rather than imported from the mocked package — the convention the sibling suites use.
 */
type FrappeErrorFixture = ReturnType<typeof makeFrappeError>

/** The doctype the page queries; the mock branches on it so no other list query is disturbed. */
const IMPORT_LOG_DOCTYPE = 'Bank Statement Import Log'

/** Mirrors `App.tsx`, where the importer is the index child of this path. */
const IMPORTER_ROUTE = '/statement-importer'

/**
 * Stands in for `ViewBankStatementImportLog` at the `:id` child route. Proving navigation with a
 * sentinel ROUTE rather than a mocked `useNavigate` keeps the assertion about observable
 * behaviour — the detail view is reached — instead of about which function was called.
 */
const DETAIL_SENTINEL = 'import-log-detail-reached'

const SELECTED_BANK = makeSelectedBank()

/* ── Import-log fixtures ──────────────────────────────────────────────────────────────
 * Four rows, each with a DISTINCT `name` so a bank-scoped marker can target exactly one, and
 * each with a slash-bearing `file` so `file.split('/').pop()` yields a real displayed name.
 * `status` uses only the two values the DocType declares; there is no third value and no error
 * field on that DocType, which is precisely why the failure states below come from a marker.
 * ────────────────────────────────────────────────────────────────────────────────────── */

/** A fully populated, server-completed import. The row that exercises every cell. */
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

/**
 * A log the server has not advanced and that the client has observed nothing about. Its statement
 * dates are absent, which is the state a not-yet-parsed import is really in — so this row also
 * covers the date-range fallback.
 */
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

/** A log whose import the SERVER refused; a follow-up read confirmed it is still not completed. */
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

/** A log whose attempt did not succeed but where nothing observed amounts to the server saying so. */
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

/* ── Render harness ──────────────────────────────────────────────────────────────────── */

interface ImporterScenario {
	/** What the list query answers with. `undefined` is the pre-arrival state, not a loading state. */
	logs?: BankStatementImportLog[]
	/** A rejection from the list query, which renders above the table/empty branch. */
	listError?: FrappeErrorFixture
	/** Bank-scoped attempt markers seeded into the shared atom. */
	markers?: ImportAttemptMarkers
	/** Seeds the shared error-dialog atom, which is what makes the mounted dialog visible. */
	dialogError?: FrappeErrorFixture
	/** Failures attributed to a FILE because no import log existed yet. */
	preImportFailures?: Record<string, FrappeErrorFixture>
	/** An error on the file-upload hook, which drives one of the unattributed banners. */
	uploadError?: FrappeErrorFixture
	/** Set to `false` to leave the bank unselected and prove the render gate. */
	withSelectedBank?: boolean
}

/** The five members the page destructures from an SWR-backed list query. */
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

/** Puts an error on the file-upload hook, matching the shape the library declares for it. */
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

/**
 * Renders the page inside a fresh jotai store and a router whose shape mirrors `App.tsx`: the
 * importer is the index child of `/statement-importer` and the detail view is its `:id` child.
 *
 * A store PER TEST is required because the harness performs no global atom reset and
 * `selectedBankAccountAtom` is backed by `localStorage`.
 */
const renderImporter = ({
	logs,
	listError,
	markers,
	dialogError,
	preImportFailures,
	uploadError,
	withSelectedBank = true
}: ImporterScenario = {}) => {
	installImportLogQuery(logs, listError)

	if (uploadError) {
		installFileUploadError(uploadError)
	}

	const store = createStore()

	if (withSelectedBank) {
		store.set(selectedBankAccountAtom, SELECTED_BANK)
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
			{/*
			  * `TooltipProvider` mirrors `App.tsx`, which mounts it once around the whole application.
			  * The page itself deliberately does NOT mount a local one, so anything in its subtree
			  * that reaches for a tooltip - the `Unknown` status chip carries its explanation on one -
			  * throws "`Tooltip` must be used within `TooltipProvider`" without it, and the failure is
			  * the harness's rather than the page's. Placed here, outside the router, exactly as the
			  * application nests it.
			  */}
			<TooltipProvider>
				<MemoryRouter initialEntries={[IMPORTER_ROUTE]}>
					<Routes>
						<Route path={IMPORTER_ROUTE}>
							<Route index element={<BankStatementImporter />} />
							<Route path=":id" element={<div>{DETAIL_SENTINEL}</div>} />
						</Route>
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</Provider>
	)

	return { ...utils, store }
}

/** The displayed file name for a log — the same `split('/').pop()` the row itself renders. */
const displayedFileName = (log: BankStatementImportLog): string =>
	log.file.split('/').pop() ?? log.file

/**
 * The table row for one log, located through its file link. Scoping every per-row assertion to the
 * row it belongs to is what stops four rows cross-contaminating one another's matches.
 */
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

/**
 * Typed into the PDF passphrase field. An obvious placeholder by design: it is never a credential,
 * it matches no provider's secret format, and naming it here keeps that intent unmistakable to a
 * reader and to any secret scanner reading this file.
 */
const PLACEHOLDER_PDF_PASSPHRASE = 'not-a-real-passphrase'

describe('BankStatementImporter', () => {

	/* ── TC1: the import-log list ────────────────────────────────────────────────────── */

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

		/**
		 * The per-row cells are asserted together because the FM2 edit touched exactly one of the
		 * six — the status cell. Proving the other five still render the values the endpoint
		 * projected is how that one-condition change is shown not to have disturbed the row.
		 */
		it('renders every projected cell of a fully populated row', () => {
			renderImporter({ logs: [COMPLETED_LOG] })

			const row = within(rowFor(COMPLETED_LOG))

			expect(row.getByText('15th Jan 2024')).toBeInTheDocument()
			expect(row.getByText('1st Jan 2024 to 31st Jan 2024')).toBeInTheDocument()
			expect(row.getByText('24')).toBeInTheDocument()
			// The currency symbol comes from the harness's `locals[':Currency']`; the amount is
			// what this cell exists to show, so the assertion is anchored on the number.
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
			// `navigate(`/statement-importer/${item.name}`)`.
			expect(await screen.findByText(DETAIL_SENTINEL)).toBeInTheDocument()
			expect(screen.queryByText('Previous Imports')).not.toBeInTheDocument()
		})
	})

	/* ── FM2: the per-file failure indicator, row form ───────────────────────────────── */

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
		 * `Unknown` is the one label of the four that cannot carry its own meaning. "Completed",
		 * "Not Started" and "Failed" each say what happened; "Unknown" says only that the client
		 * could not find out, which is useless to a reviewer without the rest of the sentence - and
		 * the rest of the sentence lives in the dialog raised at the MOMENT of the attempt, which is
		 * long gone by the time anybody reads this row. The marker, meanwhile, persists. The group
		 * below pins that the explanation travels with the chip for pointer, keyboard and
		 * assistive-technology users alike, and that the other three chips are left exactly as they
		 * are.
		 */
		describe('the indeterminate chip explains itself', () => {

			it('carries the whole explanation as its accessible name', () => {
				renderImporter({ logs: ALL_LOGS, markers: ATTEMPT_MARKERS })

				const label = statusBadgeIn(rowFor(INDETERMINATE_LOG)).getAttribute('aria-label')

				expect(label).toBeTruthy()
				// It REPLACES the bare word rather than supplementing it, so assistive technology
				// gets the whole meaning without hovering.
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
				// Hidden from assistive technology: the accessible name already says everything the
				// glyph means, so announcing it twice would only add noise.
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

				// And it is ASSOCIATED with the chip rather than merely being on screen somewhere,
				// which is what makes it the chip's description to a screen reader.
				await waitFor(() => {
					expect(chip.getAttribute('aria-describedby')).toBeTruthy()
				})

				await userEvent.keyboard('{Escape}')
			})
		})

		/** The marker lookup must be genuinely keyed, not applied across the whole list. */
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

		/**
		 * SERVER AUTHORITY. A marker is an observation of one attempt; the document is the record.
		 * When the fetched log says `Completed`, that is what renders — and the stale marker is
		 * retired, so it cannot outlive the condition it described.
		 *
		 * The marker map is a shared, exported atom — the public contract the import step writes —
		 * so reading it back is observing this module's output, not a component's internals.
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

		/** Retirement is scoped to the account whose logs were actually re-read. */
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


	/* ── FM2: the per-file failure indicator, pre-log form ───────────────────────────── */

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

		/**
		 * No client-side transaction creation, and nothing optimistic: a rejected import leaves the
		 * list exactly as the server last reported it.
		 */
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

		/** The suppression is conditional, not a blanket removal of the hook banners. */
		it('still shows the hook banner when no failure has been attributed to a file', () => {
			const unattributed = 'Unattributed upload-hook rejection.'

			renderImporter({ logs: [], uploadError: makeServerMessagesError(unattributed) })

			expect(screen.getByText(unattributed)).toBeInTheDocument()
			expect(screen.getByRole('alert')).toBeInTheDocument()
		})
	})

	/* ── The empty branch, which is also the pre-arrival branch ──────────────────────── */

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

	/* ── The list-query rejection ────────────────────────────────────────────────────── */

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

		/** The banner renders ABOVE the branch, so a rejection does not hide the empty state. */
		it('reports the rejection without claiming the account has imports', () => {
			renderImporter({ listError: makeServerMessagesError('Permission denied.') })

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText('No bank statements imported yet')).toBeInTheDocument()
			expect(screen.queryByRole('table')).not.toBeInTheDocument()
		})
	})

	/* ── The shared error dialog, as mounted by THIS page ────────────────────────────── */

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

			// The row is still exactly what the server reported: nothing was mutated optimistically.
			expect(statusBadgeIn(rowFor(COMPLETED_LOG))).toHaveTextContent('Completed')
		})
	})

	/* ── The upload chain, which is where the pre-log FM2 marker is written ──────────── */

	/**
	 * These drive the page's OWN upload handler, because that handler is where the pre-log failure
	 * marker is written — seeding the atom proves the rendering, but only running the chain proves
	 * the attribution. The assertions stay on rendered output and on the route reached; the SDK
	 * operations are configured as seams, never inspected as internals, and nothing here reaches
	 * into the CSV import step, which is its own module's to test.
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

			expect(await screen.findByText(DETAIL_SENTINEL)).toBeInTheDocument()
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

			// The same envelope also raises the shared dialog, so the refusal cannot be missed.
			const dialog = await screen.findByRole('alertdialog')
			expect(within(dialog).getByText(message)).toBeInTheDocument()

			// Nothing was created client-side: the list still shows what the server last reported,
			// and no import-log document was requested after the refusal — the upload is the FIRST
			// step of the chain, so a refusal there must stop it rather than press on.
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

			// The identical normalised envelope reaches the per-file banner and the dialog, so the
			// copy is asserted inside the dialog rather than document-wide.
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

		/** A failure in the password step has no banner of its own, so it must still be attributed. */
		it('attributes a failure in the statement-password step to the file as well', async () => {
			const message = 'Not permitted to update Bank Account.'
			frappeUpdateDoc.mockRejectedValue(makeServerMessagesError(message))

			const { container } = renderImporter({ logs: [] })

			await chooseStatementFile(container, pdfStatementFile())

			// The password field is offered only for a PDF, and only then is it worth persisting.
			// The value typed here is deliberately an obvious non-credential placeholder.
			const passwordField = screen.getByLabelText('PDF Password')
			await userEvent.type(passwordField, PLACEHOLDER_PDF_PASSPHRASE)
			expect(passwordField).toHaveValue(PLACEHOLDER_PDF_PASSPHRASE)

			await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

			expect(
				await screen.findByText('hdfc-statement-jan-2024.pdf could not be uploaded.')
			).toBeInTheDocument()
			expect(within(await screen.findByRole('alertdialog')).getByText(message)).toBeInTheDocument()
		})
	})

	/* ── The page shell around the list ─────────────────────────────────────────────── */

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

