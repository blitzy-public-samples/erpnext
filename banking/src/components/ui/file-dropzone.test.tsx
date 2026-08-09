/**
 * Behavioural specification for the shared file dropzone.
 *
 * The behaviour worth specifying here is REFUSAL, because that is what was silent. A file that fails the
 * `accept` map never reaches the drop handler - the library filters it out - so the component's own state
 * did not change, and the surface it rendered was byte-identical to idle: no message, no styling, no
 * announcement. The reviewer was left with a disabled Upload button and no stated reason, and the most
 * natural conclusion was that the application was broken.
 *
 * Four call sites share this component (the statement importer and three action modals), so the refusal
 * is specified once, here, rather than at each of them.
 *
 * `fireEvent` rather than `userEvent.upload` for the refusal paths, deliberately: `userEvent.upload`
 * applies the input's own `accept` attribute BEFORE dispatching, so a file the component is supposed to
 * refuse would never arrive and the test would pass against a component that does nothing at all.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { FileDropzone } from './file-dropzone'

/** The importer's own accept map, so the messages under test quote the extensions it really accepts. */
const STATEMENT_ACCEPT = {
	'text/csv': ['.csv'],
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
	'application/vnd.ms-excel': ['.xls'],
	'application/pdf': ['.pdf']
}

const csvFile = (name = 'statement.csv') =>
	new File(['Date,Description,Amount\n2026-08-01,Bank charge,-15\n'], name, { type: 'text/csv' })

const textFile = (name = 'notes.txt') =>
	new File(['this is not a statement'], name, { type: 'text/plain' })

/**
 * Renders the dropzone the way its callers do - as a controlled component - so a rejected file can be
 * shown NOT to have entered the caller's state, which is the half of the defect that already worked and
 * must keep working.
 */
const renderDropzone = ({ multiple = false }: { multiple?: boolean } = {}) => {
	const onDrop = vi.fn()

	const Harness = () => {
		const [files, setFiles] = useState<File[]>([])
		return (
			<FileDropzone
				files={files}
				setFiles={setFiles}
				accept={STATEMENT_ACCEPT}
				multiple={multiple}
				onDrop={onDrop} />
		)
	}

	const view = render(<Harness />)

	const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
	if (!input) {
		throw new Error('The dropzone rendered no file input')
	}

	const root = input.parentElement
	if (!root) {
		throw new Error('The dropzone rendered no root element')
	}

	return { ...view, onDrop, input, root }
}

/*
 * Both helpers are async and wrapped in `act`, and that is not incidental: react-dropzone resolves the
 * dropped or chosen files through a PROMISE before it decides anything, so every state change it makes -
 * the accepted list, the rejection list, the drag state - lands in a microtask after the event returns.
 * A synchronous `fireEvent` alone would assert against the frame before the component had reacted.
 */

/** Puts files on the input the way the file picker does. */
const choose = async (input: HTMLInputElement, files: File[]) => {
	await act(async () => {
		fireEvent.change(input, { target: { files } })
	})
}

/** Drags something over the dropzone without dropping it. */
const dragOver = async (root: HTMLElement, type: string) => {
	await act(async () => {
		fireEvent.dragEnter(root, {
			dataTransfer: { types: ['Files'], items: [{ kind: 'file', type }] }
		})
	})
}

describe('FileDropzone', () => {

	describe('when the file is one we can read', () => {

		it('hands it to the caller and says nothing', async () => {
			const { input, onDrop } = renderDropzone()

			await choose(input, [csvFile()])

			expect(onDrop).toHaveBeenCalledWith([expect.objectContaining({ name: 'statement.csv' })])
			expect(screen.getByText('statement.csv')).toBeInTheDocument()
			expect(screen.queryByRole('alert')).not.toBeInTheDocument()
			expect(input).not.toHaveAttribute('aria-invalid')
		})
	})

	describe('when the file is refused', () => {

		it('says so, naming the file and what IS accepted', async () => {
			const { input } = renderDropzone()

			await choose(input, [textFile()])

			const alert = screen.getByRole('alert')
			expect(alert).toHaveTextContent('notes.txt is not a file type we can read.')
			// Quoted from the accept map itself, so the advice cannot drift from what is enforced.
			expect(alert).toHaveTextContent('Supported types: .csv, .xlsx, .xls, .pdf.')
		})

		it('marks the control invalid and points it at the reason', async () => {
			const { input } = renderDropzone()

			await choose(input, [textFile()])

			expect(input).toHaveAttribute('aria-invalid', 'true')

			const describedBy = input.getAttribute('aria-describedby')
			expect(describedBy).toBeTruthy()
			expect(document.getElementById(describedBy ?? '')).toBe(screen.getByRole('alert'))
		})

		it('still keeps it out of the caller\'s state', async () => {
			// The half that already worked: a refused file must never reach the code that uploads it.
			const { input, onDrop } = renderDropzone()

			await choose(input, [textFile()])

			expect(onDrop).not.toHaveBeenCalled()
			expect(screen.queryByText('notes.txt')).not.toBeInTheDocument()
		})

		it('costs the reviewer nothing - a file already staged survives the refusal', async () => {
			/*
			 * The library reports every drop, including one where it accepted nothing, and in single-file
			 * mode that empty result used to REPLACE the staged file. So dropping an unsupported file on top
			 * of a good statement silently discarded the good one, and the reviewer had to go and find it
			 * again - a worse outcome than the silence this finding is about.
			 */
			const { input } = renderDropzone()

			await choose(input, [csvFile('good-statement.csv')])
			expect(screen.getByText('good-statement.csv')).toBeInTheDocument()

			await choose(input, [textFile()])

			expect(screen.getByRole('alert')).toBeInTheDocument()
			expect(screen.getByText('good-statement.csv')).toBeInTheDocument()
		})

		it('shows the refusal on the dropzone itself, not only in the message', async () => {
			const { input, root } = renderDropzone()

			await choose(input, [textFile()])

			expect(root.className).toContain('border-outline-red-3')
			expect(root.className).toContain('bg-surface-red-1')
		})

		it('refuses a second file when only one is allowed, and says which rule applied', async () => {
			const { input } = renderDropzone({ multiple: false })

			await choose(input, [csvFile('one.csv'), csvFile('two.csv')])

			expect(screen.getByRole('alert')).toHaveTextContent(
				'Only one file can be uploaded at a time.'
			)
		})

		it('names every refused file rather than only the first', async () => {
			const { input } = renderDropzone({ multiple: true })

			await choose(input, [textFile('first.txt'), textFile('second.txt')])

			const alert = screen.getByRole('alert')
			expect(alert).toHaveTextContent('first.txt')
			expect(alert).toHaveTextContent('second.txt')
		})

		it('takes the complaint back once an acceptable file is chosen', async () => {
			const { input } = renderDropzone()

			await choose(input, [textFile()])
			expect(screen.getByRole('alert')).toBeInTheDocument()

			await choose(input, [csvFile()])

			expect(screen.queryByRole('alert')).not.toBeInTheDocument()
			expect(input).not.toHaveAttribute('aria-invalid')
		})
	})

	/*
	 * The file input inside is invisible, so the dropzone as a whole is what a keyboard user sees receive
	 * focus - and it had no focus indicator at all. The only focus treatment was a background and border
	 * tint one step along the same grey ramp, which is not perceivable as focus, and
	 * `focus-within:outline-none` then removed the browser's own ring on top of that.
	 *
	 * Asserted on the class rather than on computed style because Tailwind's utilities are not compiled in
	 * this environment; what is being pinned is that the indicator is DECLARED, on a token, and that the
	 * removal is gone.
	 */
	describe('its focus indicator', () => {

		it('declares a visible ring when something inside it is focused', () => {
			const { root } = renderDropzone()

			expect(root.className).toContain('focus-within:outline-2')
			expect(root.className).toContain('focus-within:outline-outline-gray-5')
		})

		it('no longer removes the outline it used to suppress', () => {
			const { root } = renderDropzone()

			expect(root.className).not.toContain('focus-within:outline-none')
		})

		it('keeps the file input reachable by keyboard', () => {
			const { input } = renderDropzone()

			input.focus()

			expect(input).toHaveFocus()
		})
	})

	describe('while a file is being dragged over it', () => {

		it('is idle before anything is dragged', () => {
			const { root } = renderDropzone()

			expect(root).toHaveAttribute('data-drag-state', 'idle')
		})

		it('answers a droppable file before it is dropped', async () => {
			// Answering during the drag is what lets the reviewer change their mind rather than discover the
			// refusal afterwards.
			const { root } = renderDropzone()

			await dragOver(root, 'text/csv')

			expect(root).toHaveAttribute('data-drag-state', 'accept')
			expect(root.className).toContain('border-outline-green-3')
		})

		it('answers one it will refuse', async () => {
			const { root } = renderDropzone()

			await dragOver(root, 'text/plain')

			expect(root).toHaveAttribute('data-drag-state', 'reject')
			expect(root.className).toContain('border-outline-red-3')
		})

		it('returns to idle when the drag leaves', async () => {
			const { root } = renderDropzone()

			await dragOver(root, 'text/plain')
			await act(async () => {
				fireEvent.dragLeave(root)
			})

			expect(root).toHaveAttribute('data-drag-state', 'idle')
		})
	})
})
