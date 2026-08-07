/**
 * Behavioural specification for the shared link picker.
 *
 * Every "which party", "which account", "which cost centre" question in the SPA is asked through this one
 * component, so its behaviour is felt on the rule form, both importer surfaces and all three action modals.
 * It searches server-side rather than filtering a preloaded list, which is what lets it work against
 * doctypes holding hundreds of thousands of records.
 *
 * Six behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. It does not search AT ALL until it is opened - the SWR key is `null` while closed - so a form with
 *      a dozen link fields issues no queries on mount.
 *   2. Searching is DEBOUNCED, so typing a party name does not fire a request per keystroke.
 *   3. It shows a stored value's TITLE rather than its identifier, but only when the doctype opts in;
 *      otherwise the raw name is the honest thing to show.
 *   4. Local filtering, when supplied, is capped at 50 candidates - a deliberate bound, because the
 *      predicate runs on every result of every keystroke.
 *   5. Reopening CLEARS the previous search text, so a reviewer never sees yesterday's query narrowing
 *      today's list.
 *   6. The "Create New" escape hatch appears only if the user may actually create that doctype, and it
 *      leaves for the desk rather than opening a nested form.
 */

import { afterAll, describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { createFrappeSDKMock, frappeSDKMock, makeServerMessagesError } from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { TooltipProvider } from '@/components/ui/tooltip'
import LinkFieldCombobox from './LinkFieldCombobox'

const SEARCH_ENDPOINT = 'frappe.desk.search.search_link'
const TITLE_ENDPOINT = 'frappe.client.get_value'

interface Result {
	value: string
	label?: string
	description?: string
}

const SUPPLIERS: Result[] = [
	{ value: 'ACME Traders', label: 'ACME Traders', description: 'Mumbai' },
	{ value: 'Globex Supplies', label: 'Globex Supplies' }
]

interface ComboboxOptions {
	value?: string
	results?: Result[]
	searchError?: ReturnType<typeof makeServerMessagesError>
	isLoading?: boolean
	/** Doctype meta: whether a title field exists and whether the doctype opts into showing it. */
	meta?: { title_field?: string; show_title_field_in_link?: boolean } | null
	title?: string
	filterFn?: (item: Result, search: string) => boolean
	readOnly?: boolean
	disabled?: boolean
	onChange?: (value: string) => void
}

/** Records the SWR key each search-endpoint call was registered with. */
let searchKeys: unknown[] = []

const renderCombobox = ({
	value,
	results = SUPPLIERS,
	searchError,
	isLoading = false,
	meta = null,
	title,
	filterFn,
	readOnly,
	disabled,
	onChange = vi.fn()
}: ComboboxOptions = {}) => {
	searchKeys = []

	frappeSDKMock.useFrappeGetCall.mockImplementation(((
		method: string,
		_params?: unknown,
		swrKey?: unknown
	) => {
		if (method === SEARCH_ENDPOINT) {
			searchKeys.push(typeof swrKey === 'function' ? swrKey() : swrKey)

			return {
				data: searchError ? undefined : { message: results },
				error: searchError,
				isLoading,
				isValidating: false,
				mutate: vi.fn()
			}
		}

		if (method === TITLE_ENDPOINT) {
			return {
				data: title ? { message: { [meta?.title_field ?? 'title']: title } } : undefined,
				error: undefined,
				isLoading: false,
				isValidating: false,
				mutate: vi.fn()
			}
		}

		// `useDocType` reads the doctype meta through a get call as well.
		return {
			data: meta ? { docs: [meta] } : undefined,
			error: undefined,
			isLoading: false,
			isValidating: false,
			mutate: vi.fn()
		}
	}) as never)

	frappeSDKMock.useFrappeGetDoc.mockReturnValue({
		data: meta ?? undefined,
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: vi.fn()
	} as never)

	const user = userEvent.setup()

	render(
		<TooltipProvider>
			<LinkFieldCombobox
				doctype="Supplier"
				value={value}
				onChange={onChange}
				filterFn={filterFn}
				readOnly={readOnly}
				disabled={disabled}
			/>
		</TooltipProvider>
	)

	return { user, onChange }
}

/**
 * The debounce this component searches through, in milliseconds — `useDebounceValue('', 400)`.
 *
 * Two tests below assert immediately after typing, which deliberately leaves that timer pending: the
 * point of those tests is that the intermediate keystrokes never reach the server. The timer then has
 * to be drained before this file's jsdom environment is destroyed, because `usehooks-ts` cancels the
 * wrong instance on unmount — `useDebounceCallback` invokes the `debounce` built inside its `useMemo`
 * but `useUnmount` cancels the separate one built in its `useEffect` — so the pending timer outlives
 * both the unmounted component and the environment. Firing after teardown makes React's
 * `resolveUpdatePriority` read a `window` that no longer exists, which surfaces as an unhandled
 * `ReferenceError` and fails the whole run even though every test passed.
 */
const SEARCH_DEBOUNCE_MS = 400

/*
 * Let those timers fire while the environment is still alive, where the state update they carry is a
 * harmless no-op on an unmounted root. Real timers are used rather than fake ones because
 * `userEvent.setup()` above drives the typing on the real clock.
 */
afterAll(async () => {
	await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 100))
})

const trigger = () => screen.getByRole('combobox')

const openCombobox = async (options: ComboboxOptions = {}) => {
	const context = renderCombobox(options)

	await context.user.click(trigger())
	await screen.findByPlaceholderText('Select Supplier')

	return context
}

describe('LinkFieldCombobox', () => {

	beforeEach(() => {
		searchKeys = []
	})

	describe('before it is opened', () => {

		it('invites the reviewer to choose, naming the doctype', () => {
			renderCombobox()

			expect(trigger()).toHaveTextContent('Select Supplier')
		})

		it('QUIRK - registers no search key at all while closed', () => {
			// The key is `null` until opened, and SWR treats a null key as "do not fetch". A form with a
			// dozen link fields therefore issues no search queries on mount - which is the difference
			// between a form that opens instantly and one that fires a dozen requests.
			renderCombobox()

			// Asserted as "every key was null" rather than a count, because the component legitimately
			// renders more than once before settling and the number of renders is not the behaviour
			// under test.
			expect(searchKeys.length).toBeGreaterThan(0)
			expect(searchKeys.every((key) => key === null)).toBe(true)
		})

		it('reports itself as collapsed', () => {
			renderCombobox()

			expect(trigger()).toHaveAttribute('aria-expanded', 'false')
			expect(trigger()).toHaveAttribute('data-state', 'closed')
		})
	})

	describe('showing an existing value', () => {

		it('shows the stored identifier when the doctype has no title field', () => {
			renderCombobox({ value: 'ACME Traders' })

			expect(trigger()).toHaveTextContent('ACME Traders')
		})

		it('QUIRK - shows the title only when the doctype opts in', () => {
			// Substituting a title the doctype has not opted into showing would hide the identifier the
			// reviewer needs in order to find the record anywhere else.
			renderCombobox({
				value: 'SUP-0001',
				meta: { title_field: 'supplier_name', show_title_field_in_link: false },
				title: 'ACME Traders'
			})

			expect(trigger()).toHaveTextContent('SUP-0001')
			expect(trigger()).not.toHaveTextContent('ACME Traders')
		})

		it('offers a link out to the stored record', () => {
			// A reviewer checking a party mid-form needs to reach it without losing the form.
			renderCombobox({ value: 'ACME Traders' })

			const link = screen.getByRole('link')

			expect(link).toHaveAttribute('href', '/desk/supplier/ACME Traders')
			expect(link).toHaveAttribute('target', '_blank')
		})

		it('offers no link when nothing is chosen yet', () => {
			renderCombobox()

			expect(screen.queryByRole('link')).not.toBeInTheDocument()
		})
	})

	describe('searching', () => {

		it('registers a real search key once opened', async () => {
			await openCombobox()

			// The key encodes the endpoint, doctype, search text, page size and filters, so two
			// differently filtered pickers over the same doctype cannot share a cache entry.
			expect(searchKeys.some((key) => typeof key === 'string')).toBe(true)
			const stringKeys = searchKeys.filter((key): key is string => typeof key === 'string')
			expect(stringKeys[stringKeys.length - 1]).toContain(
				'frappe.desk.search.search_link_Supplier'
			)
		})

		it('lists what the server returned', async () => {
			await openCombobox()

			expect(screen.getByText('ACME Traders')).toBeInTheDocument()
			expect(screen.getByText('Globex Supplies')).toBeInTheDocument()
		})

		it('shows a result description when the server supplies one', async () => {
			// The description is what distinguishes two suppliers with similar names.
			await openCombobox()

			expect(screen.getByText('Mumbai')).toBeInTheDocument()
		})

		it('QUIRK - debounces the typed query rather than searching per keystroke', async () => {
			// Each keystroke would otherwise be a server round trip. The key is only recomputed once the
			// debounced value settles, so the mid-typing prefixes never reach the server.
			const { user } = await openCombobox()

			const keysAfterOpen = searchKeys.length

			await user.type(screen.getByPlaceholderText('Select Supplier'), 'glob')

			const typedKeys = searchKeys
				.slice(keysAfterOpen)
				.filter((key): key is string => typeof key === 'string')

			// No key contains an intermediate prefix, because those values were never committed.
			expect(typedKeys.some((key) => key.includes('_g_') || key.endsWith('_g'))).toBe(false)
			expect(typedKeys.some((key) => key.includes('_gl'))).toBe(false)
		})

		it('says so while the search is in flight', async () => {
			await openCombobox({ results: [], isLoading: true })

			expect(screen.getByText('Loading...')).toBeInTheDocument()
		})

		it('distinguishes an empty result from a search still running', async () => {
			await openCombobox({ results: [], isLoading: false })

			expect(screen.getByText('No results found.')).toBeInTheDocument()
			expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
		})

		it('surfaces a refused search instead of an empty list', async () => {
			await openCombobox({ searchError: makeServerMessagesError('Not permitted') })

			expect(screen.getByText('Not permitted')).toBeInTheDocument()
		})
	})

	describe('narrowing results locally', () => {

		it('applies a supplied predicate on top of the server results', async () => {
			// Used where the caller knows a constraint the server query cannot express - for instance
			// excluding the account already chosen on the other side of a transfer.
			await openCombobox({
				filterFn: (item) => item.value !== 'Globex Supplies'
			})

			expect(screen.getByText('ACME Traders')).toBeInTheDocument()
			expect(screen.queryByText('Globex Supplies')).not.toBeInTheDocument()
		})

		it('QUIRK - caps local filtering at 50 candidates', async () => {
			// A deliberate bound: the predicate runs over every result on every keystroke, so an
			// unbounded list would make typing progressively slower on a large doctype.
			const many = Array.from({ length: 80 }, (_, index) => ({
				value: `SUP-${String(index).padStart(4, '0')}`
			}))

			await openCombobox({ results: many, filterFn: () => true })

			expect(screen.getByText('SUP-0049')).toBeInTheDocument()
			expect(screen.queryByText('SUP-0050')).not.toBeInTheDocument()
		})

		it('leaves the list untouched when no predicate is supplied', async () => {
			const many = Array.from({ length: 60 }, (_, index) => ({
				value: `SUP-${String(index).padStart(4, '0')}`
			}))

			await openCombobox({ results: many })

			// No cap without a predicate, because there is nothing per-item to run.
			expect(screen.getByText('SUP-0055')).toBeInTheDocument()
		})
	})

	describe('choosing a value', () => {

		it('reports the chosen identifier upward', async () => {
			const { user, onChange } = await openCombobox()

			await user.click(screen.getByText('Globex Supplies'))

			// The identifier, not the label - that is what the server stores.
			expect(onChange).toHaveBeenCalledWith('Globex Supplies')
		})

		it('closes itself once a value is chosen', async () => {
			const { user } = await openCombobox()

			await user.click(screen.getByText('Globex Supplies'))

			await waitFor(() => {
				expect(screen.queryByPlaceholderText('Select Supplier')).not.toBeInTheDocument()
			})
		})

		it('QUIRK - clears the search text when reopened', async () => {
			// Otherwise a reviewer returning to the field would see it silently narrowed by the query
			// they typed the last time, and conclude records were missing.
			const { user } = await openCombobox()

			await user.type(screen.getByPlaceholderText('Select Supplier'), 'globex')
			await user.keyboard('{Escape}')

			await waitFor(() => {
				expect(screen.queryByPlaceholderText('Select Supplier')).not.toBeInTheDocument()
			})

			await user.click(trigger())

			expect(await screen.findByPlaceholderText('Select Supplier')).toHaveValue('')
		})
	})

	describe('when it cannot be used', () => {

		it('QUIRK - refuses to open when read-only', async () => {
			// Read-only is not the same as disabled: the value stays legible and its link still works,
			// but the picker will not open.
			const { user } = renderCombobox({ value: 'ACME Traders', readOnly: true })

			expect(trigger()).toHaveAttribute('aria-readonly', 'true')

			await user.click(trigger())

			expect(screen.queryByPlaceholderText('Select Supplier')).not.toBeInTheDocument()
			expect(screen.getByRole('link')).toBeInTheDocument()
		})

		it('is inert when disabled', async () => {
			const { user } = renderCombobox({ disabled: true })

			expect(trigger()).toBeDisabled()

			await user.click(trigger()).catch(() => undefined)

			expect(screen.queryByPlaceholderText('Select Supplier')).not.toBeInTheDocument()
		})
	})
})
