/**
 * Behavioural specification for the raw-table preview the statement importer shows before anything is
 * imported.
 *
 * This grid is the reviewer's only chance to catch a mis-parsed statement, so its job is to make the
 * importer's INTERPRETATION visible: which row it took as the header, which rows it believes are
 * transactions, and which column it mapped to which field. It approximates the backend's own row
 * detection deliberately, so that highlighting tracks an edit live rather than only after a round trip.
 *
 * Five behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. Cells are COERCED to strings, because an XLSX cell arrives as a number or a date rather than text -
 *      so a numeric cell must not crash the trim-and-render path.
 *   2. The column count is the WIDEST row, not the header's width, so a ragged statement still renders
 *      every cell it has.
 *   3. A column mapped to "Do not import" is treated as unmapped, so the two are one case.
 *   4. Editing affordances appear only when `editable` is set; the same grid is used read-only on the
 *      import-log view.
 *   5. Each mapped field carries its own icon, and an unmapped column carries none.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { ColumnMapsTo } from './import_utils'

import RawTableGrid from './RawTableGrid'

const HEADER_ROW = ['Date', 'Description', 'Withdrawal', 'Deposit']
const ROWS = [
	HEADER_ROW,
	['05-09-2026', 'NEFT ACME Traders', '', '4825.50'],
	['08-09-2026', 'RTGS Globex Supplies', '1250.00', '']
]

const MAPPING: Record<number, ColumnMapsTo> = {
	0: 'Date',
	1: 'Description',
	2: 'Withdrawal',
	3: 'Deposit'
}

const renderGrid = (props: Partial<Parameters<typeof RawTableGrid>[0]> = {}) =>
	render(
		<TooltipProvider>
			<RawTableGrid
				rows={ROWS}
				columnMapping={MAPPING}
				headerIndex={0}
				{...props}
			/>
		</TooltipProvider>
	)

describe('RawTableGrid', () => {

	describe('what it renders', () => {

		it('renders every cell of every row', () => {
			renderGrid()

			expect(screen.getByText('NEFT ACME Traders')).toBeInTheDocument()
			expect(screen.getByText('RTGS Globex Supplies')).toBeInTheDocument()
			expect(screen.getByText('4825.50')).toBeInTheDocument()
			expect(screen.getByText('1250.00')).toBeInTheDocument()
		})

		it('renders the row the importer took as the header', () => {
			renderGrid()

			expect(screen.getByText('Description')).toBeInTheDocument()
		})

		it('renders a table even when there is nothing to show', () => {
			// A statement the parser found no rows in still has to render its frame, or the reviewer sees a
			// blank area with no explanation.
			renderGrid({ rows: [], columnMapping: {}, headerIndex: null })

			expect(screen.getByRole('table')).toBeInTheDocument()
		})

		it('renders with no header row identified', () => {
			renderGrid({ headerIndex: null })

			expect(screen.getByText('NEFT ACME Traders')).toBeInTheDocument()
		})
	})

	describe('QUIRK - the shapes real statements arrive in', () => {

		it('coerces a non-string cell rather than crashing on it', () => {
			// An XLSX cell is a number or a Date, not text. The grid stringifies before trimming, which is
			// what lets the same component preview a spreadsheet and a CSV.
			renderGrid({
				rows: [
					HEADER_ROW,
					['05-09-2026', 'Numeric cell', 0, 4825.5 as unknown as string] as unknown as string[]
				]
			})

			expect(screen.getByText('Numeric cell')).toBeInTheDocument()
			expect(screen.getByText('4825.5')).toBeInTheDocument()
		})

		it('renders a null cell as empty rather than as the word null', () => {
			renderGrid({
				rows: [
					HEADER_ROW,
					['05-09-2026', 'Missing reference', null as unknown as string, '4825.50']
				]
			})

			expect(screen.getByText('Missing reference')).toBeInTheDocument()
			expect(screen.queryByText('null')).not.toBeInTheDocument()
		})

		it('QUIRK - sizes itself to the WIDEST row, so a ragged statement loses nothing', () => {
			// Bank exports routinely have a short header and longer data rows, or a trailing totals row with
			// extra columns. Sizing off the header would silently drop cells.
			renderGrid({
				rows: [
					['Date', 'Description'],
					['05-09-2026', 'NEFT ACME Traders', 'EXTRA CELL', 'ANOTHER']
				],
				columnMapping: { 0: 'Date', 1: 'Description' },
				headerIndex: 0
			})

			expect(screen.getByText('EXTRA CELL')).toBeInTheDocument()
			expect(screen.getByText('ANOTHER')).toBeInTheDocument()
		})

		it('renders a single-column statement', () => {
			renderGrid({
				rows: [['Description'], ['NEFT ACME Traders']],
				columnMapping: { 0: 'Description' },
				headerIndex: 0
			})

			expect(screen.getByText('NEFT ACME Traders')).toBeInTheDocument()
		})
	})

	describe('QUIRK - its column mapping', () => {

		it('treats "Do not import" as unmapped', () => {
			// The two are one case as far as highlighting and import are concerned, so a reviewer who
			// deliberately excludes a column sees it de-emphasised exactly like one that was never mapped.
			renderGrid({
				columnMapping: { 0: 'Date', 1: 'Description', 2: 'Do not import', 3: 'Deposit' }
			})

			expect(screen.getByText('1250.00')).toBeInTheDocument()
		})

		it('renders with no mapping at all, which is the state before detection runs', () => {
			renderGrid({ columnMapping: {} })

			expect(screen.getByText('NEFT ACME Traders')).toBeInTheDocument()
		})

		it('renders every field type the importer can map to', () => {
			// Each mapped field has its own icon branch; rendering them together exercises all of them.
			renderGrid({
				rows: [
					['Date', 'Description', 'Reference', 'Amount', 'Balance', 'Type', 'D/C', 'Withdrawal'],
					['05-09-2026', 'NEFT', 'REF-1', '100', '900', 'NEFT', 'C', '0']
				],
				columnMapping: {
					0: 'Date',
					1: 'Description',
					2: 'Reference',
					3: 'Amount',
					4: 'Balance',
					5: 'Transaction Type',
					6: 'Debit/Credit',
					7: 'Withdrawal'
				},
				headerIndex: 0
			})

			expect(screen.getByText('REF-1')).toBeInTheDocument()
			expect(screen.getByText('900')).toBeInTheDocument()
		})
	})

	describe('QUIRK - read-only versus editable', () => {

		it('offers no mapping controls by default', () => {
			// The same grid previews an already-imported log, where changing the mapping would be
			// meaningless.
			renderGrid()

			expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
		})

		it('offers one mapping control per column when editable', () => {
			renderGrid({ editable: true })

			expect(screen.getAllByRole('combobox')).toHaveLength(HEADER_ROW.length)
		})

		it('reports a header-row change to its caller', async () => {
			const user = userEvent.setup()
			const onSetHeader = vi.fn()

			renderGrid({ editable: true, onSetHeader })

			// Row numbers are the affordance for setting the header, so pressing one reports upward rather
			// than mutating anything locally.
			const rowHandles = screen.getAllByRole('button')
			expect(rowHandles.length).toBeGreaterThan(0)

			await user.click(rowHandles[0])

			expect(onSetHeader).toHaveBeenCalled()
		})

		it('renders the editable grid as disabled without losing its content', () => {
			// Disabled is the state while an import is in flight: the reviewer can still read the parse.
			renderGrid({ editable: true, disabled: true })

			expect(screen.getByText('NEFT ACME Traders')).toBeInTheDocument()
			expect(screen.getAllByRole('combobox')).toHaveLength(HEADER_ROW.length)
		})
	})
})

/**
 * Theme-correct highlighting.
 *
 * The row and cell highlights were written as raw palette utilities with hand-written dark overrides -
 * `bg-green-50 dark:bg-green-700`, `bg-yellow-100 dark:bg-yellow-400` - and the dark pairings were
 * inverted: a MID-weight background arrived under text that stayed dark, measuring 1.97:1 on the gold
 * header row and 2.59:1 on the green transaction rows. This is the one screen whose entire purpose is
 * reading a parsed statement, so unreadable rows defeat the feature outright.
 *
 * The Espresso surface tokens already inverting correctly between themes are what fix it: each is
 * paired with `ink-gray-8`, which resolves to near-black in light and near-white in dark, so one class
 * is legible in both. Asserted as classes because jsdom evaluates no stylesheet - the ratios
 * themselves are measured in the browser - but what these hold is that no raw palette utility and no
 * hand-written `dark:` override can come back.
 */
describe('RawTableGrid theme-correct highlighting', () => {

	it('highlights the detected header row with a token pair, not a raw palette colour', () => {
		renderGrid()

		const headerRow = screen.getByText('Withdrawal').closest('tr') as HTMLElement

		expect(headerRow.className).toContain('bg-surface-amber-2')
		expect(headerRow.className).toContain('text-ink-gray-8')
	})

	it('highlights the detected transaction rows with a token pair', () => {
		renderGrid()

		const transactionRow = screen.getByText('NEFT ACME Traders').closest('tr') as HTMLElement

		expect(transactionRow.className).toContain('bg-surface-green-1')
		expect(transactionRow.className).toContain('text-ink-gray-8')
	})

	it('never states a colour the theme cannot invert', () => {
		/*
		 * The general invariant. A raw `bg-green-50` has one value in both themes, so it can only ever
		 * be right in one of them - and a hand-written `dark:` override is the same bug with an extra
		 * step, since it has to be kept in step with the light value by hand.
		 */
		renderGrid()

		const markup = document.body.innerHTML

		expect(markup).not.toMatch(/\bbg-(green|yellow|red|amber)-\d{2,3}\b/)
		expect(markup).not.toMatch(/\bdark:bg-/)
		// An opacity modifier on an already mid-grey took the muted text to roughly 3.2:1.
		expect(markup).not.toContain('text-ink-gray-5/70')
	})
})
