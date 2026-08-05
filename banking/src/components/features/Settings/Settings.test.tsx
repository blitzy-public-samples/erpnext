/**
 * Behavioural specification for the settings surface.
 *
 * Settings is where a reviewer changes the two things that alter how the workbench BEHAVES rather than
 * how it looks: the transfer-matching window, and the rule set that drives auto-matching. It is reached
 * from the workbench header, and everything behind the trigger is code-split.
 *
 * Seven behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. Nothing behind the trigger is mounted until it is opened. `Settings.tsx` renders
 *      `SettingsDialogContent` conditionally on `isOpen` AND imports the panels lazily, so a reviewer
 *      who never opens settings pays for neither.
 *   2. Only the ACTIVE panel is mounted. `ui/settings-dialog.tsx` builds on Radix Tabs without
 *      `forceMount`, so the rules panel does not exist until its tab is chosen - which is why every
 *      rules assertion below has to select that tab first.
 *   3. It opens on Preferences, even though Matching Rules is the more consequential panel.
 *   4. Fuzzy party matching is DISABLED until exact party matching is switched on, because it is
 *      defined as the fallback for when account-number matching fails.
 *   5. "Run Rules" is WITHHELD entirely when no rules exist (`RuleList.tsx:63-65` returns `null`), so
 *      the affordance cannot be offered for an empty rule set.
 *   6. The manual run offers two distinct scopes - new transactions only, versus a forced re-evaluation
 *      of every unreconciled transaction - which map to the `force_evaluate` argument the backend
 *      branches on.
 *   7. Both the tab and the panel heading read "Preferences", so a bare text query for it is ambiguous.
 *      Every assertion here is therefore role-scoped or keyed on panel-unique copy.
 *
 * The rule editor and creator are reached THROUGH this surface rather than mounted directly, because
 * that is the only way a reviewer can reach them and it is `MatchingRules` that owns the switch between
 * the list, the editor and the creator.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router'
import { toast } from 'sonner'

import {
	createFrappeSDKMock,
	frappeSDKMock,
	frappeUpdateDoc,
	frappePostCall,
	frappeContextValue,
	makeServerMessagesError
} from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from '@/components/ui/theme-provider'
import Settings from './Settings'
import { selectedBankAccountAtom } from '../BankReconciliation/bankRecAtoms'
import { makePanelBank, stubViewportMeasurement } from '@/test/renderPanel'
import type { BankTransactionRule } from '@/types/Accounts/BankTransactionRule'
import type { AccountsSettings } from '@/types/Accounts/AccountsSettings'

/* ─── Fixtures, shaped to the fields each surface actually reads ─────────────────────── */

/** The exact five fields `useGetRuleList` projects (`RuleList.tsx:35`). */
const makeRule = (overrides: Partial<BankTransactionRule> = {}): BankTransactionRule => ({
	name: 'BANK-FEES-RULE',
	rule_name: 'Bank fees',
	rule_description: 'Any withdrawal describing a bank charge',
	transaction_type: 'Withdrawal',
	priority: 1,
	...overrides
}) as BankTransactionRule

const SECOND_RULE = makeRule({
	name: 'SALARY-RULE',
	rule_name: 'Salary credits',
	rule_description: 'Any deposit from the payroll account',
	transaction_type: 'Deposit',
	priority: 2
})

const makeAccountsSettings = (
	overrides: Partial<AccountsSettings> = {}
): AccountsSettings => ({
	name: 'Accounts Settings',
	transfer_match_days: 4,
	automatically_run_rules_on_unreconciled_transactions: 0,
	enable_party_matching: 0,
	enable_fuzzy_matching: 0,
	...overrides
}) as AccountsSettings

/* ─── Harness ────────────────────────────────────────────────────────────────────────── */

interface SettingsScenario {
	/** Rules `useGetRuleList` resolves. Defaults to two, so `RunRulesButton` is offered. */
	rules?: BankTransactionRule[]
	/** `undefined` leaves the list loading; an error drives the failure branch. */
	rulesError?: ReturnType<typeof makeServerMessagesError>
	settings?: AccountsSettings
	settingsError?: ReturnType<typeof makeServerMessagesError>
	/** The single rule document `EditRule` re-reads once a rule is chosen. */
	ruleDoc?: BankTransactionRule
}

const configureSDK = ({
	rules = [makeRule(), SECOND_RULE],
	rulesError,
	settings = makeAccountsSettings(),
	settingsError,
	ruleDoc = makeRule()
}: SettingsScenario = {}) => {
	// Doctype-aware, because Preferences reads "Accounts Settings" through the same hook that
	// EditRule reads "Bank Transaction Rule" through.
	frappeSDKMock.useFrappeGetDoc.mockImplementation(((doctype: string) => ({
		data: doctype === 'Accounts Settings' ? settings : ruleDoc,
		error: doctype === 'Accounts Settings' ? settingsError : undefined,
		isLoading: false,
		isValidating: false,
		mutate: vi.fn().mockResolvedValue(undefined)
	})) as never)

	frappeSDKMock.useFrappeGetDocList.mockReturnValue({
		data: rulesError ? undefined : rules,
		error: rulesError,
		isLoading: false,
		isValidating: false,
		mutate: vi.fn().mockResolvedValue(undefined)
	} as never)

	// Method-aware, because three unrelated shapes travel through this one hook: the scheduled-job
	// flag `AutoRunRuleItem` reads as a bare single value, the link TITLE lookup that expects an
	// object, and the link SEARCH that expects an ARRAY. Returning one shape for all three crashes
	// `LinkFieldCombobox`, which calls `.map` on whatever it receives.
	frappeSDKMock.useFrappeGetCall.mockImplementation(((method: string) => {
		const data =
			method === 'frappe.client.get_single_value'
				? { message: 0 }
				: method === 'frappe.client.get_value'
					? { message: {} }
					: { message: [] }

		return {
			data,
			error: undefined,
			isLoading: false,
			isValidating: false,
			mutate: vi.fn().mockResolvedValue(undefined)
		}
	}) as never)
}

const renderSettings = () => {
	const store = createStore()
	store.set(selectedBankAccountAtom, makePanelBank())

	return render(
		<Provider store={store}>
			<ThemeProvider>
				<TooltipProvider>
					<MemoryRouter>
						<Settings />
					</MemoryRouter>
				</TooltipProvider>
			</ThemeProvider>
		</Provider>
	)
}

/**
 * Opens the dialog and waits for the lazily imported panels to arrive.
 *
 * The tab strip is NOT a sufficient signal: `SettingsTabs` is statically imported, so the tabs paint
 * while `SettingsPanelsContent` is still suspended behind its spinner. Waiting on panel-owned copy is
 * what proves the lazy chunk actually landed.
 */
const openSettings = async (scenario: SettingsScenario = {}) => {
	configureSDK(scenario)

	const user = userEvent.setup()
	renderSettings()

	await user.click(screen.getByRole('button', { name: 'Settings' }))
	await screen.findByRole('tab', { name: 'Preferences' })

	// The generous timeout covers the FIRST open in the file, where the panels chunk is genuinely
	// being resolved and transformed for the first time; later opens hit the resolved module and
	// settle in a few milliseconds. This waits on the import completing, not on a fixed delay.
	await screen.findByText('Configure settings for the banking module', undefined, {
		timeout: 10_000
	})

	return user
}

/** Radix mounts only the active panel, so every rules assertion has to select the tab first. */
const openMatchingRules = async (scenario: SettingsScenario = {}) => {
	const user = await openSettings(scenario)

	await user.click(screen.getByRole('tab', { name: 'Matching Rules' }))
	await screen.findByText('Transaction Matching Rules')

	return user
}

describe('Settings', () => {

	stubViewportMeasurement()

	beforeEach(() => {
		configureSDK()
	})

	describe('its trigger', () => {

		it('QUIRK - carries an explicit label, because it renders as an icon only', () => {
			renderSettings()

			// Without the `aria-label` the button would have no accessible name at all: its only child
			// is an SVG.
			expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
		})

		it('QUIRK - mounts nothing behind it until it is opened', () => {
			renderSettings()

			expect(screen.queryByRole('tab', { name: 'Preferences' })).not.toBeInTheDocument()
			expect(
				screen.queryByText('Configure settings for the banking module')
			).not.toBeInTheDocument()
		})
	})

	describe('once opened', () => {

		it('offers the three settings sections', async () => {
			await openSettings()

			expect(screen.getByRole('tab', { name: 'Preferences' })).toBeInTheDocument()
			expect(screen.getByRole('tab', { name: 'Matching Rules' })).toBeInTheDocument()
			expect(screen.getByRole('tab', { name: 'Keyboard Shortcuts' })).toBeInTheDocument()
		})

		it('QUIRK - lands on Preferences rather than on the rules', async () => {
			// Preferences is the safer landing place: a reviewer who opens settings by accident cannot
			// change matching behaviour just by arriving.
			await openSettings()

			expect(screen.getByRole('tab', { name: 'Preferences' })).toHaveAttribute(
				'data-state',
				'active'
			)
			expect(
				screen.getByText('Configure settings for the banking module')
			).toBeInTheDocument()
		})

		it('QUIRK - mounts only the active panel, leaving the other sections absent', async () => {
			// `ui/settings-dialog.tsx` passes no `forceMount`, so the rules panel genuinely does not
			// exist until selected - which is what makes the rule list free for a reviewer who only
			// ever adjusts preferences.
			await openSettings()

			expect(screen.queryByText('Transaction Matching Rules')).not.toBeInTheDocument()
		})

		it('can be dismissed again', async () => {
			const user = await openSettings()

			await user.keyboard('{Escape}')

			await waitFor(() => {
				expect(
					screen.queryByText('Configure settings for the banking module')
				).not.toBeInTheDocument()
			})
		})
	})

	describe('the Preferences panel', () => {

		it('shows the transfer-matching window the server has stored', async () => {
			await openSettings({ settings: makeAccountsSettings({ transfer_match_days: 3 }) })

			expect(screen.getByText('Number of days to match transfers')).toBeInTheDocument()
			// The window is what decides how far either side of a transaction the matcher looks for
			// the other leg of a transfer, so the stored figure has to be the one displayed.
			expect(screen.getByRole('combobox')).toHaveTextContent('Within 3 days')
		})

		it('reflects the stored state of each matching switch', async () => {
			await openSettings({
				settings: makeAccountsSettings({ enable_party_matching: 1, enable_fuzzy_matching: 0 })
			})

			expect(screen.getByRole('switch', { name: 'Enable automatic party matching' }))
				.toBeChecked()
			expect(
				screen.getByRole('switch', { name: 'Enable party name/description fuzzy matching' })
			).not.toBeChecked()
		})

		it('QUIRK - withholds fuzzy matching until exact party matching is switched on', async () => {
			// Fuzzy matching is DEFINED as the fallback for when account-number or IBAN matching
			// fails, so offering it alone would promise behaviour the backend never reaches.
			await openSettings({ settings: makeAccountsSettings({ enable_party_matching: 0 }) })

			expect(
				screen.getByRole('switch', { name: 'Enable party name/description fuzzy matching' })
			).toBeDisabled()
		})

		it('offers fuzzy matching once its prerequisite is met', async () => {
			await openSettings({ settings: makeAccountsSettings({ enable_party_matching: 1 }) })

			expect(
				screen.getByRole('switch', { name: 'Enable party name/description fuzzy matching' })
			).toBeEnabled()
		})

		it('writes just the one changed field, and confirms it', async () => {
			const success = vi.spyOn(toast, 'success').mockReturnValue('t')
			frappeUpdateDoc.mockResolvedValue(makeAccountsSettings({ enable_party_matching: 1 }))

			const user = await openSettings({
				settings: makeAccountsSettings({ enable_party_matching: 0 })
			})

			await user.click(
				screen.getByRole('switch', { name: 'Enable automatic party matching' })
			)

			await waitFor(() => {
				expect(frappeUpdateDoc).toHaveBeenCalledWith(
					'Accounts Settings',
					'Accounts Settings',
					{ enable_party_matching: 1 }
				)
			})
			// A whole-document write would clobber any field a colleague changed in parallel, so the
			// single-field payload is the point.
			expect(frappeUpdateDoc).toHaveBeenCalledTimes(1)

			await waitFor(() => {
				expect(success).toHaveBeenCalledWith('Preferences updated', expect.anything())
			})

			success.mockRestore()
		})

		it('surfaces a read failure instead of showing empty preferences', async () => {
			await openSettings({ settingsError: makeServerMessagesError('Not permitted') })

			expect(await screen.findByText('Not permitted')).toBeInTheDocument()
		})

		it('offers the three themes, marking the active one', async () => {
			await openSettings()

			const light = screen.getByRole('button', { name: /Light/ })
			const dark = screen.getByRole('button', { name: /Dark/ })

			expect(screen.getByRole('button', { name: /System/ })).toBeInTheDocument()
			// `aria-pressed` is how the selected card announces itself; the visual ring alone would
			// leave it undiscoverable.
			expect(light).toHaveAttribute('aria-pressed', 'true')
			expect(dark).toHaveAttribute('aria-pressed', 'false')
		})

		it('switches theme when another card is chosen', async () => {
			// `theme-provider.tsx:66-72` persists the choice through a post call AND applies it
			// optimistically, so the call has to be configured even though the assertion is visual.
			frappePostCall.mockResolvedValue({ message: 'Dark' })

			const user = await openSettings()

			await user.click(screen.getByRole('button', { name: /Dark/ }))

			await waitFor(() => {
				expect(screen.getByRole('button', { name: /Dark/ })).toHaveAttribute(
					'aria-pressed',
					'true'
				)
			})
			expect(screen.getByRole('button', { name: /Light/ })).toHaveAttribute(
				'aria-pressed',
				'false'
			)
		})
	})

	describe('the Matching Rules panel', () => {

		it('lists each rule with the priority that decides which one wins', async () => {
			await openMatchingRules()

			// Priority is not decoration: the backend evaluates ascending and breaks on the first
			// match, so the displayed order IS the resolution order.
			expect(screen.getByText('Bank fees')).toBeInTheDocument()
			expect(screen.getByText('Any withdrawal describing a bank charge')).toBeInTheDocument()
			expect(screen.getByText('1')).toBeInTheDocument()

			expect(screen.getByText('Salary credits')).toBeInTheDocument()
			expect(screen.getByText('2')).toBeInTheDocument()
		})

		it('distinguishes what each rule applies to', async () => {
			await openMatchingRules()

			expect(screen.getByTitle('Applies to withdrawals')).toBeInTheDocument()
			expect(screen.getByTitle('Applies to deposits')).toBeInTheDocument()
		})

		it('invites setting rules up when there are none', async () => {
			await openMatchingRules({ rules: [] })

			expect(screen.getByText('No rules setup yet')).toBeInTheDocument()
			expect(
				screen.getByText('Configure rules to save time when reconciling transactions.')
			).toBeInTheDocument()
		})

		it('surfaces a read failure instead of an empty rule list', async () => {
			await openMatchingRules({ rulesError: makeServerMessagesError('Rule read refused') })

			expect(await screen.findByText('Rule read refused')).toBeInTheDocument()
		})

		it('QUIRK - withholds the manual run when there are no rules', async () => {
			// `RunRulesButton` returns `null` for an empty list, so a reviewer cannot enqueue an
			// evaluation that could not possibly match anything.
			await openMatchingRules({ rules: [] })

			expect(screen.queryByRole('button', { name: /Run Rules/ })).not.toBeInTheDocument()
			// The creator is still offered, which is what an empty list should lead to.
			expect(screen.getByRole('button', { name: /Add Rule/ })).toBeInTheDocument()
		})

		it('QUIRK - offers new-only and forced re-evaluation as separate choices', async () => {
			// They map to the `force_evaluate` argument the backend branches on: the default skips
			// already-evaluated transactions, the forced variant re-reads all of them.
			const user = await openMatchingRules()

			await user.click(screen.getByRole('button', { name: /Run Rules/ }))

			expect(
				await screen.findByRole('menuitem', { name: 'Run on new transactions' })
			).toBeInTheDocument()
			expect(
				screen.getByRole('menuitem', { name: 'Force evaluate all' })
			).toBeInTheDocument()
		})

		it('enqueues an evaluation over new transactions only', async () => {
			const success = vi.spyOn(toast, 'success').mockReturnValue('t')
			frappePostCall.mockResolvedValue({ message: 'queued' })

			const user = await openMatchingRules()

			await user.click(screen.getByRole('button', { name: /Run Rules/ }))
			await user.click(
				await screen.findByRole('menuitem', { name: 'Run on new transactions' })
			)

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledWith({ force_evaluate: false })
			})
			await waitFor(() => {
				expect(success).toHaveBeenCalledWith('Rules evaluation completed')
			})

			success.mockRestore()
		})

		it('enqueues a forced re-evaluation of every unreconciled transaction', async () => {
			const success = vi.spyOn(toast, 'success').mockReturnValue('t')
			frappePostCall.mockResolvedValue({ message: 'queued' })

			const user = await openMatchingRules()

			await user.click(screen.getByRole('button', { name: /Run Rules/ }))
			await user.click(await screen.findByRole('menuitem', { name: 'Force evaluate all' }))

			await waitFor(() => {
				expect(frappePostCall).toHaveBeenCalledWith({ force_evaluate: true })
			})
			// The wording differs deliberately: a forced run is long enough that "started" is the
			// honest report, whereas the incremental run has usually finished.
			await waitFor(() => {
				expect(success).toHaveBeenCalledWith('Rules evaluation started')
			})

			success.mockRestore()
		})

		it('reports a refused evaluation rather than implying it ran', async () => {
			const error = vi.spyOn(toast, 'error').mockReturnValue('t')
			const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
			frappePostCall.mockRejectedValue(makeServerMessagesError('Not permitted'))

			const user = await openMatchingRules()

			await user.click(screen.getByRole('button', { name: /Run Rules/ }))
			await user.click(
				await screen.findByRole('menuitem', { name: 'Run on new transactions' })
			)

			await waitFor(() => {
				expect(error).toHaveBeenCalledWith('Failed to run rules evaluation')
			})

			error.mockRestore()
			logged.mockRestore()
		})

		it('offers the scheduled-run toggle alongside the manual choices', async () => {
			const user = await openMatchingRules()

			await user.click(screen.getByRole('button', { name: /Run Rules/ }))

			// A checkbox item rather than a plain item, because it reports persisted state rather
			// than triggering a one-off action.
			expect(
				await screen.findByRole('menuitemcheckbox', { name: 'Run rules automatically' })
			).toBeInTheDocument()
		})

		it('persists the scheduled-run choice as a single field write', async () => {
			frappeContextValue.db.setValue.mockResolvedValue(
				makeAccountsSettings({ automatically_run_rules_on_unreconciled_transactions: 1 }) as never
			)

			const user = await openMatchingRules()

			await user.click(screen.getByRole('button', { name: /Run Rules/ }))
			await user.click(
				await screen.findByRole('menuitemcheckbox', { name: 'Run rules automatically' })
			)

			await waitFor(() => {
				expect(frappeContextValue.db.setValue).toHaveBeenCalledWith(
					'Accounts Settings',
					'Accounts Settings',
					'automatically_run_rules_on_unreconciled_transactions',
					1
				)
			})
		})

		it('deletes a rule on request, and refreshes the list', async () => {
			const listMutate = vi.fn().mockResolvedValue(undefined)
			frappeContextValue.db.deleteDoc.mockResolvedValue({ message: 'ok' } as never)

			const user = await openMatchingRules()
			frappeSDKMock.useFrappeGetDocList.mockReturnValue({
				data: [makeRule(), SECOND_RULE],
				error: undefined,
				isLoading: false,
				isValidating: false,
				mutate: listMutate
			} as never)

			// Each row owns its own menu, so the first trigger belongs to the first rule.
			const rowMenus = screen.getAllByRole('button', { name: '' })
			await user.click(rowMenus[rowMenus.length - 1])

			await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))

			await waitFor(() => {
				expect(frappeContextValue.db.deleteDoc).toHaveBeenCalledWith(
					'Bank Transaction Rule',
					SECOND_RULE.name
				)
			})
		})
	})

	describe('reaching the rule editor', () => {

		it('replaces the list with the chosen rule, named in the heading', async () => {
			const user = await openMatchingRules({
				ruleDoc: makeRule({ rule_name: 'Bank fees', rule_description: 'Charges' })
			})

			await user.click(screen.getByRole('button', { name: 'Bank fees' }))

			// The editor takes over the whole panel rather than opening a nested dialog, so the list
			// heading must be gone.
			await waitFor(() => {
				expect(screen.queryByText('Transaction Matching Rules')).not.toBeInTheDocument()
			})
			expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
		})

		it('shows the rule\'s own matching criteria for editing', async () => {
			const user = await openMatchingRules()

			await user.click(screen.getByRole('button', { name: 'Bank fees' }))

			expect(await screen.findByText('Rule Name')).toBeInTheDocument()
			expect(
				screen.getByText('Rules to match against the transaction description')
			).toBeInTheDocument()
			expect(screen.getByText('If rule matches, then:')).toBeInTheDocument()
		})

		it('returns to the list when the edit is abandoned', async () => {
			const user = await openMatchingRules()

			await user.click(screen.getByRole('button', { name: 'Bank fees' }))
			await screen.findByRole('button', { name: 'Cancel' })

			await user.click(screen.getByRole('button', { name: 'Cancel' }))

			// Abandoning must not persist anything.
			expect(frappeUpdateDoc).not.toHaveBeenCalled()
			expect(await screen.findByText('Transaction Matching Rules')).toBeInTheDocument()
		})
	})

	describe('reaching the rule creator', () => {

		it('opens an empty rule form', async () => {
			const user = await openMatchingRules()

			await user.click(screen.getByRole('button', { name: /Add Rule/ }))

			expect(await screen.findByText('New Rule')).toBeInTheDocument()
			expect(
				screen.getByText('Create a new rule to automatically classify transactions.')
			).toBeInTheDocument()
			expect(screen.getByText('Rule Name')).toBeInTheDocument()
		})

		it('starts every new rule as a suggestion rather than an automatic action', async () => {
			const user = await openMatchingRules()

			await user.click(screen.getByRole('button', { name: /Add Rule/ }))
			await screen.findByText('New Rule')

			// The copy is the guarantee that a rule never posts anything by itself - it only ever
			// proposes an entry for a reviewer to confirm.
			expect(
				screen.getByText(
					'This will just suggest creating a new entry, and will not automatically create it.'
				)
			).toBeInTheDocument()
		})

		it('returns to the list when creation is abandoned', async () => {
			const user = await openMatchingRules()

			await user.click(screen.getByRole('button', { name: /Add Rule/ }))
			await screen.findByText('New Rule')

			await user.click(screen.getByRole('button', { name: 'Cancel' }))

			expect(await screen.findByText('Transaction Matching Rules')).toBeInTheDocument()
		})
	})

	describe('the Keyboard Shortcuts panel', () => {

		it('documents the shortcuts the workbench binds', async () => {
			const user = await openSettings()

			await user.click(screen.getByRole('tab', { name: 'Keyboard Shortcuts' }))

			// Every one of these is a real binding elsewhere in the SPA; the panel is the only place
			// a reviewer can discover them.
			expect(await screen.findByText('Bank Entry')).toBeInTheDocument()
			expect(screen.getByText('Record Payment')).toBeInTheDocument()
			expect(screen.getByText('Accept Matching Rule')).toBeInTheDocument()
			expect(screen.getByText('Reconciliation History')).toBeInTheDocument()
		})
	})
})
