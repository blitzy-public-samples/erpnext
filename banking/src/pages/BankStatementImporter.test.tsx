import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createFrappeSDKMock,
	frappeCreateDoc,
	frappeFileUpload,
	frappeSDKMock,
	frappeUpdateDoc,
	makeBankStatementImportLog,
	makeFileUploadResponse,
	makeMessageOnlyError,
	makeSelectedBank,
	makeServerMessagesError,
	resetFrappeSDKMock,
	TEST_BANK_ACCOUNT
} from '@/test/factories'

// Replaces the SDK wholesale, so the log list, the upload chain and the document reads are all
// supplied by this suite. Declared here because `vi.mock` is hoisted above the imports.
vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

// Created by `vi.hoisted` because the factory below is hoisted above every import in this file.
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))

// Only the navigation seam is stubbed; `Link` and the rest of the router come from MemoryRouter, so
// the page's own markup is exercised unchanged.
vi.mock('react-router', async () => {
	const actual = await vi.importActual<typeof import('react-router')>('react-router')
	return { ...actual, useNavigate: () => navigate }
})

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

const emptyRead = {
	data: undefined,
	error: undefined,
	isLoading: false,
	isValidating: false,
	mutate: vi.fn(() => Promise.resolve(undefined))
}

const COMPLETED_LOG = makeBankStatementImportLog({
	name: 'completedlog',
	file: '/private/files/completed.csv',
	status: 'Completed'
})

const NOT_STARTED_LOG = makeBankStatementImportLog({
	name: 'notstartedlog',
	file: '/private/files/pending.csv',
	status: 'Not Started'
})

const SECOND_NOT_STARTED_LOG = makeBankStatementImportLog({
	name: 'secondpending',
	file: '/private/files/second-pending.csv',
	status: 'Not Started'
})

/**
 * Renders the importer with a given set of server-side logs and a given set of client-side attempt
 * markers, which is the only combination that produces the four chip states.
 */
const renderImporter = ({
	logs,
	markers = {}
}: {
	logs: BankStatementImportLog[]
	markers?: ImportAttemptMarkers
}) => {
	frappeSDKMock.useFrappeGetDocList.mockImplementation((doctype) =>
		doctype === 'Bank Statement Import Log'
			? { ...emptyRead, data: logs }
			: emptyRead)

	const store = createStore()
	store.set(selectedBankAccountAtom, makeSelectedBank({ name: TEST_BANK_ACCOUNT }))
	store.set(bankRecImportFailuresAtom, markers)

	const utils = render(
		<MemoryRouter>
			<Provider store={store}>
				<TooltipProvider>
					<BankStatementImporter />
				</TooltipProvider>
			</Provider>
		</MemoryRouter>
	)

	return { ...utils, store }
}

/** The row whose File cell links to the given file name. */
const rowForFile = (fileName: string) => {
	const link = screen.getByRole('link', { name: fileName })
	const row = link.closest('tr')
	if (!row) {
		throw new Error(`no row found for ${fileName}`)
	}
	return row
}

/** The status chip of a row: the first element child of its second cell. */
const chipForFile = (fileName: string): HTMLElement => {
	const cells = rowForFile(fileName).querySelectorAll('td')
	const chip = cells[1]?.firstElementChild
	if (!(chip instanceof HTMLElement)) {
		throw new Error(`no status chip found for ${fileName}`)
	}
	return chip
}

/**
 * The per-file import status chip.
 *
 * This is FM2's "per-file failure indicator", and its whole value is that four different situations
 * read differently. Two of them come from the server's own status; the other two come from what the
 * client observed about ONE attempt, and the difference between those two is a genuine distinction
 * rather than a shade of the same thing:
 *
 *   - `Failed`  - the server itself refused AND a follow-up read confirmed the log is not completed.
 *     This is the only state that asserts the import did not take effect.
 *   - `Unknown` - the attempt did not succeed, but nothing observed amounts to the server saying so.
 *     The client does not know, and must not claim it does.
 *
 * The tests below therefore pin which state renders for which input, that the server's own status
 * OUTRANKS any client marker, that a marker is scoped to the bank account it was recorded against,
 * and that `Unknown` carries its meaning with it - because the dialog that explained it at the time
 * of the attempt is long gone by the time anybody reads this row.
 */
describe('ImportLogStatusBadge', () => {

	beforeEach(() => {
		resetFrappeSDKMock()
	})

	it('renders the server status when the client observed nothing', () => {
		renderImporter({ logs: [COMPLETED_LOG, NOT_STARTED_LOG] })

		expect(chipForFile('completed.csv')).toHaveTextContent('Completed')
		expect(chipForFile('pending.csv')).toHaveTextContent('Not Started')
	})

	it('renders Failed for a log whose attempt the server refused', () => {
		renderImporter({
			logs: [NOT_STARTED_LOG],
			markers: { [TEST_BANK_ACCOUNT]: { [NOT_STARTED_LOG.name]: 'failed' } }
		})

		const chip = chipForFile('pending.csv')
		expect(chip).toHaveTextContent('Failed')
		// Solid rather than the subtle default: subtle red does not clear the contrast floor for a
		// 12px label in dark mode, and this is the one state that asserts a failure.
		expect(chip.getAttribute('data-variant')).toBe('solid')
		expect(chip.getAttribute('data-theme')).toBe('red')
	})

	it('renders Unknown, distinctly from Failed, when the client could not establish the outcome', () => {
		renderImporter({
			logs: [NOT_STARTED_LOG],
			markers: { [TEST_BANK_ACCOUNT]: { [NOT_STARTED_LOG.name]: 'unknown' } }
		})

		const chip = chipForFile('pending.csv')
		expect(chip).toHaveTextContent('Unknown')
		// The amber surface, and NOT solid - the fill treatment is one of the axes that keeps the two
		// states apart in greyscale and under colour-vision deficiency.
		expect(chip.getAttribute('data-theme')).toBe('orange')
		expect(chip.getAttribute('data-variant')).not.toBe('solid')
	})

	/*
	 * The precedence that matters most. A marker is an observation of one attempt; the document is
	 * the record. A log the server reports as completed must render as completed even if an earlier
	 * attempt against it was recorded as failed - otherwise a transient failure would permanently
	 * misreport a successful import.
	 */
	it('lets the server\'s Completed status outrank a client failure marker', () => {
		renderImporter({
			logs: [COMPLETED_LOG],
			markers: { [TEST_BANK_ACCOUNT]: { [COMPLETED_LOG.name]: 'failed' } }
		})

		expect(chipForFile('completed.csv')).toHaveTextContent('Completed')
		expect(screen.queryByText('Failed')).not.toBeInTheDocument()
	})

	// Markers are keyed by bank account and then by log, so one recorded against another account
	// must not colour this account's rows.
	it('ignores a marker recorded against a different bank account', () => {
		renderImporter({
			logs: [NOT_STARTED_LOG],
			markers: { 'Some Other Account': { [NOT_STARTED_LOG.name]: 'failed' } }
		})

		expect(chipForFile('pending.csv')).toHaveTextContent('Not Started')
		expect(screen.queryByText('Failed')).not.toBeInTheDocument()
	})

	// Only the row the marker names, never its neighbours.
	it('marks only the row the marker names', () => {
		renderImporter({
			logs: [NOT_STARTED_LOG, SECOND_NOT_STARTED_LOG, COMPLETED_LOG],
			markers: { [TEST_BANK_ACCOUNT]: { [NOT_STARTED_LOG.name]: 'failed' } }
		})

		expect(chipForFile('pending.csv')).toHaveTextContent('Failed')
		expect(chipForFile('second-pending.csv')).toHaveTextContent('Not Started')
		expect(chipForFile('completed.csv')).toHaveTextContent('Completed')
	})

	it('renders all four states at once when the data calls for it', () => {
		renderImporter({
			logs: [COMPLETED_LOG, NOT_STARTED_LOG, SECOND_NOT_STARTED_LOG],
			markers: {
				[TEST_BANK_ACCOUNT]: {
					[NOT_STARTED_LOG.name]: 'failed',
					[SECOND_NOT_STARTED_LOG.name]: 'unknown'
				}
			}
		})

		expect(chipForFile('completed.csv')).toHaveTextContent('Completed')
		expect(chipForFile('pending.csv')).toHaveTextContent('Failed')
		expect(chipForFile('second-pending.csv')).toHaveTextContent('Unknown')
	})
})

/**
 * The `Unknown` chip's explanation.
 *
 * "Unknown" is the one label that cannot carry its own meaning: it says the client could not find
 * out, which is useless without the rest of the sentence - and the rest of the sentence previously
 * only ever existed in the dialog raised at the moment of the attempt. These tests pin that the
 * explanation now travels with the row, for pointer, keyboard and assistive-technology users alike.
 */
describe('the Unknown chip explains itself', () => {

	const UNKNOWN_MARKERS: ImportAttemptMarkers = {
		[TEST_BANK_ACCOUNT]: { [NOT_STARTED_LOG.name]: 'unknown' }
	}

	beforeEach(() => {
		resetFrappeSDKMock()
	})

	it('carries the whole explanation as its accessible name', () => {
		renderImporter({ logs: [NOT_STARTED_LOG], markers: UNKNOWN_MARKERS })

		const label = chipForFile('pending.csv').getAttribute('aria-label')

		expect(label).toBeTruthy()
		expect(label).toContain('Unknown')
		expect(label).toContain('did not finish')
		// Outcome-INDETERMINATE wording: the client not learning the answer is not evidence the
		// import did not happen, and telling a reviewer it failed would invite a duplicate import.
		expect(label).toContain('could not be established whether the server recorded it')
		expect(label).not.toMatch(/\bfailed\b/i)
	})

	it('carries a glyph, so it is not distinguished by colour alone', () => {
		renderImporter({ logs: [NOT_STARTED_LOG], markers: UNKNOWN_MARKERS })

		const icon = chipForFile('pending.csv').querySelector('svg')

		expect(icon).toBeTruthy()
		// Hidden from assistive technology: the aria-label already says everything the glyph means.
		expect(icon?.getAttribute('aria-hidden')).toBe('true')
	})

	/*
	 * Radix renders a focusable button for a tooltip trigger by DEFAULT, but `asChild` hands that
	 * role to the Badge span and adds no tabIndex of its own - so without this the explanation is
	 * reachable by pointer only, and a sighted keyboard-only reviewer has no route to it at all.
	 */
	it('is a keyboard tab stop, and the only chip that is one', () => {
		renderImporter({
			logs: [NOT_STARTED_LOG, COMPLETED_LOG],
			markers: UNKNOWN_MARKERS
		})

		expect(chipForFile('pending.csv').tabIndex).toBe(0)
		expect(chipForFile('completed.csv').hasAttribute('tabindex')).toBe(false)
	})

	it('shows the explanation on hover', async () => {
		const user = userEvent.setup()
		renderImporter({ logs: [NOT_STARTED_LOG], markers: UNKNOWN_MARKERS })

		await user.hover(chipForFile('pending.csv'))

		await waitFor(() => {
			expect(screen.getAllByText(/could not be established whether the server recorded it/).length)
				.toBeGreaterThan(0)
		})
	})

	it('shows the same explanation on keyboard focus, with no pointer involved', async () => {
		const user = userEvent.setup()
		renderImporter({ logs: [NOT_STARTED_LOG], markers: UNKNOWN_MARKERS })

		const chip = chipForFile('pending.csv')
		chip.focus()

		expect(chip).toHaveFocus()

		await waitFor(() => {
			expect(screen.getAllByText(/could not be established whether the server recorded it/).length)
				.toBeGreaterThan(0)
		})

		// And it is associated with the chip rather than merely being on screen somewhere.
		await waitFor(() => {
			expect(chip.getAttribute('aria-describedby')).toBeTruthy()
		})

		await user.keyboard('{Escape}')
	})
})

/**
 * The list itself. Cheap assertions, but each covers a cell a reviewer reconciles against a bank
 * statement, and one of them - the closing balance - is a monetary figure.
 */
describe('the previous-imports list', () => {

	beforeEach(() => {
		resetFrappeSDKMock()
	})

	it('renders one row per log, with the file name linking to the stored file', () => {
		renderImporter({ logs: [COMPLETED_LOG, NOT_STARTED_LOG] })

		expect(screen.getByRole('link', { name: 'completed.csv' }))
			.toHaveAttribute('href', '/private/files/completed.csv')
		expect(screen.getByRole('link', { name: 'pending.csv' }))
			.toHaveAttribute('href', '/private/files/pending.csv')
	})

	it('renders the statement date range, transaction count and closing balance for a row', () => {
		renderImporter({
			logs: [makeBankStatementImportLog({
				name: 'onerow',
				file: '/private/files/one-row.csv',
				status: 'Completed',
				number_of_transactions: 7,
				closing_balance: 1234.5,
				start_date: '2024-03-01',
				end_date: '2024-03-31'
			})]
		})

		const row = rowForFile('one-row.csv')

		expect(within(row).getByText('1st Mar 2024 to 31st Mar 2024')).toBeInTheDocument()
		expect(within(row).getByText('7')).toBeInTheDocument()
		// Two decimals preserved on a value that carries only one.
		expect(within(row).getByText(/1,234\.50/)).toBeInTheDocument()
	})

	it('shows a dash rather than a broken range when the log has no dates', () => {
		renderImporter({
			logs: [makeBankStatementImportLog({
				name: 'nodates',
				file: '/private/files/no-dates.csv',
				status: 'Not Started',
				start_date: undefined,
				end_date: undefined
			})]
		})

		expect(within(rowForFile('no-dates.csv')).getByText('-')).toBeInTheDocument()
	})

	it('renders an empty state, and no table, when this account has no imports', () => {
		renderImporter({ logs: [] })

		expect(screen.queryByRole('table')).not.toBeInTheDocument()
		expect(screen.getByText('Previous Imports')).toBeInTheDocument()
	})
})

/**
 * Uploading a statement, which is the step BEFORE an import log exists.
 *
 * That ordering is the whole reason this surface needs its own failure indicator: the chain can fail
 * while saving a PDF password, while uploading the file, or while creating the log - and in every one
 * of those cases there is no document to carry a status and no row in the list on the right. FM2's
 * per-file indicator is therefore keyed by FILE NAME here, which is the only identifier the attempt
 * has.
 */
describe('uploading a statement', () => {

	beforeEach(() => {
		resetFrappeSDKMock()
		navigate.mockClear()
	})

	/** The dropzone's own file input, which react-dropzone renders hidden inside the drop target. */
	const fileInput = (): HTMLInputElement => {
		const input = document.querySelector('input[type="file"]')
		if (!(input instanceof HTMLInputElement)) {
			throw new Error('no file input rendered')
		}
		return input
	}

	const uploadButton = () => screen.getByRole('button', { name: /Upload/ })

	const chooseFile = async (user: ReturnType<typeof userEvent.setup>, name: string, type = 'text/csv') => {
		await user.upload(fileInput(), new File(['date,amount\n2024-01-15,100'], name, { type }))
	}

	it('offers no upload until a file has been chosen', () => {
		renderImporter({ logs: [] })

		expect(uploadButton()).toBeDisabled()
	})

	it('uploads the chosen file privately and opens the log it created', async () => {
		const user = userEvent.setup()
		frappeFileUpload.mockResolvedValue(makeFileUploadResponse({ file_url: '/private/files/march.csv' }))
		frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'freshlog01' }))

		renderImporter({ logs: [] })

		await chooseFile(user, 'march.csv')
		expect(uploadButton()).toBeEnabled()

		await user.click(uploadButton())

		await waitFor(() => expect(navigate).toHaveBeenCalledWith('/statement-importer/freshlog01'))

		const [uploadedFile, uploadArgs] = frappeFileUpload.mock.calls[0]
		expect(uploadedFile.name).toBe('march.csv')
		expect(uploadArgs).toMatchObject({
			isPrivate: true,
			doctype: 'Bank Statement Import Log',
			fieldname: 'file'
		})

		// The log is created against the SERVER's returned file URL and the selected account, under
		// the same name the file was uploaded against.
		const [createdDoctype, createdDoc] = frappeCreateDoc.mock.calls[0]
		expect(createdDoctype).toBe('Bank Statement Import Log')
		expect(createdDoc).toMatchObject({
			name: uploadArgs.docname,
			file: '/private/files/march.csv',
			bank_account: TEST_BANK_ACCOUNT
		})
	})

	// A password is only asked for where it can be needed, and it is persisted on the ACCOUNT so it
	// is available before any import document exists - which is why it is saved ahead of the upload
	// rather than alongside it.
	it('asks for a password only for a PDF, and saves it before uploading', async () => {
		const user = userEvent.setup()
		frappeUpdateDoc.mockResolvedValue(makeSelectedBank())
		frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
		frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'pdflog01' }))

		renderImporter({ logs: [] })

		expect(screen.queryByLabelText('PDF Password')).not.toBeInTheDocument()

		await chooseFile(user, 'march.pdf', 'application/pdf')

		await user.type(await screen.findByLabelText('PDF Password'), 'letmein')
		await user.click(uploadButton())

		await waitFor(() => expect(frappeUpdateDoc).toHaveBeenCalledWith(
			'Bank Account', TEST_BANK_ACCOUNT, { statement_password: 'letmein' }))
		await waitFor(() => expect(navigate).toHaveBeenCalledWith('/statement-importer/pdflog01'))
	})

	it('does not touch the account when no password was given', async () => {
		const user = userEvent.setup()
		frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
		frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'pdflog02' }))

		renderImporter({ logs: [] })

		await chooseFile(user, 'march.pdf', 'application/pdf')
		await user.click(uploadButton())

		await waitFor(() => expect(navigate).toHaveBeenCalledWith('/statement-importer/pdflog02'))
		expect(frappeUpdateDoc).not.toHaveBeenCalled()
	})

	/**
	 * FM2, pre-log case. The refusal is reported verbatim in the dismissible dialog AND attributed to
	 * the file by name, because there is no row to attribute it to. Nothing is navigated to, because
	 * nothing was created.
	 */
	it('names the file a refused upload belongs to, and reports the server verbatim', async () => {
		const user = userEvent.setup()
		const refusal = makeServerMessagesError('Only CSV, XLSX, XLS and PDF files are supported')
		frappeFileUpload.mockRejectedValue(refusal)

		const { store } = renderImporter({ logs: [] })

		await chooseFile(user, 'broken.csv')
		await user.click(uploadButton())

		await waitFor(() => expect(store.get(bankRecErrorDialogAtom)).toBe(refusal))
		expect(store.get(bankRecPreImportFailuresAtom)['broken.csv']).toBe(refusal)
		expect(await screen.findByText('broken.csv could not be uploaded.')).toBeInTheDocument()
		expect(navigate).not.toHaveBeenCalled()
		expect(frappeCreateDoc).not.toHaveBeenCalled()
	})

	// A rejection with no response is not evidence that nothing happened, so the copy says the
	// outcome is unknown instead of showing the SDK's own dereference error.
	it('reports a response-less rejection as an unknown outcome', async () => {
		const user = userEvent.setup()
		frappeFileUpload.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'data')"))

		const { store } = renderImporter({ logs: [] })

		await chooseFile(user, 'lost.csv')
		await user.click(uploadButton())

		await waitFor(() => expect(store.get(bankRecErrorDialogAtom)).toBeTruthy())

		const shown = store.get(bankRecErrorDialogAtom)
		expect(shown?.message).toContain('No response arrived from the server')
		expect(shown?.message).not.toContain('Cannot read properties of undefined')
	})

	// A failure while CREATING the log is the same pre-log situation: the file reached the server but
	// no import log exists, so the attempt is still only identifiable by file name.
	it('attributes a failed log creation to the file too', async () => {
		const user = userEvent.setup()
		frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
		frappeCreateDoc.mockRejectedValue(makeMessageOnlyError('Not permitted'))

		const { store } = renderImporter({ logs: [] })

		await chooseFile(user, 'denied.csv')
		await user.click(uploadButton())

		await waitFor(() => expect(store.get(bankRecPreImportFailuresAtom)['denied.csv']).toBeTruthy())
		expect(navigate).not.toHaveBeenCalled()
	})

	// A retry supersedes what the previous attempt observed, so the stale marker is discarded when the
	// new request goes out rather than when it comes back.
	it('clears the previous marker for a file as soon as it is retried', async () => {
		const user = userEvent.setup()
		frappeFileUpload.mockRejectedValueOnce(makeServerMessagesError('Invalid file type'))
		frappeFileUpload.mockResolvedValue(makeFileUploadResponse())
		frappeCreateDoc.mockResolvedValue(makeBankStatementImportLog({ name: 'retrylog01' }))

		const { store } = renderImporter({ logs: [] })

		await chooseFile(user, 'retry.csv')
		await user.click(uploadButton())

		await waitFor(() => expect(store.get(bankRecPreImportFailuresAtom)['retry.csv']).toBeTruthy())

		await user.click(await screen.findByRole('button', { name: 'Dismiss' }))
		await user.click(uploadButton())

		await waitFor(() => expect(navigate).toHaveBeenCalledWith('/statement-importer/retrylog01'))
		expect(store.get(bankRecPreImportFailuresAtom)['retry.csv']).toBeUndefined()
		expect(screen.queryByText('retry.csv could not be uploaded.')).not.toBeInTheDocument()
	})

	// The hooks' own error state and the per-file surface describe the SAME failure, so once one is
	// attributed to a file the unattributed banner stands down rather than printing it twice.
	it('states an attributed failure once, not twice', async () => {
		const user = userEvent.setup()
		const refusal = makeServerMessagesError('Only CSV, XLSX, XLS and PDF files are supported')
		frappeFileUpload.mockRejectedValue(refusal)

		frappeSDKMock.useFrappeFileUpload.mockReturnValue({
			upload: frappeFileUpload,
			progress: 0,
			loading: false,
			// The hook exposes the same refusal, which is what the unattributed banner reads.
			error: refusal,
			isCompleted: false,
			reset: vi.fn()
		})

		renderImporter({ logs: [] })

		expect(screen.getAllByText('Only CSV, XLSX, XLS and PDF files are supported')).toHaveLength(1)

		await chooseFile(user, 'broken.csv')
		await user.click(uploadButton())

		await waitFor(() => expect(screen.getByText('broken.csv could not be uploaded.')).toBeInTheDocument())

		// Dismissing the dialog leaves the page's own banners, and there the SAME sentence must appear
		// exactly once: attributed to the file, with the unattributed hook banner stood down.
		await user.click(await screen.findByRole('button', { name: 'Dismiss' }))

		await waitFor(() => expect(screen.getAllByText('Only CSV, XLSX, XLS and PDF files are supported')).toHaveLength(1))
		expect(screen.getByText('broken.csv could not be uploaded.')).toBeInTheDocument()
	})
})
