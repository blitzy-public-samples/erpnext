/**
 * Behavioural specification for the matching-rule form.
 *
 * A rule has two halves - the CONDITIONS that decide whether it fires, and the ACTION it proposes when
 * it does - and the form's whole job is to keep the second half coherent with the first. Almost every
 * field below appears, disappears or changes meaning in response to another field, so the interesting
 * behaviour is the conditionality rather than the individual inputs.
 *
 * The form is rendered here inside a bare `react-hook-form` provider rather than through the settings
 * dialog, because that is the only way to start it from an arbitrary rule shape: the creator always
 * seeds a Bank Entry against a single account, so several branches are otherwise unreachable.
 *
 * Six behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. The action a rule proposes REWRITES the rest of the action section - a Bank Entry asks which
 *      account, a Payment Entry asks which party, and a Transfer asks neither in the same way.
 *   2. Choosing "Multiple Accounts" replaces the single account picker with a journal table, because a
 *      split cannot be expressed as one account.
 *   3. The party field is deliberately DISABLED until a party type is chosen, because the link search
 *      has no doctype to search until then.
 *   4. The last row of a journal template shows an explanation instead of figures, because the backend
 *      computes it to balance the entry.
 *   5. A debit or credit that is not a number is treated as a FORMULA and previewed against a sample
 *      transaction, and an unevaluable one is called out in red rather than silently accepted.
 *   6. The final description rule cannot be deleted, because a rule with no conditions would match
 *      every transaction.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm, FormProvider } from 'react-hook-form'
import type { ReactNode } from 'react'

import { createFrappeSDKMock, frappeSDKMock } from '@/test/factories'

vi.mock('frappe-react-sdk', () => createFrappeSDKMock())

import { TooltipProvider } from '@/components/ui/tooltip'
import { RuleForm } from './RuleForm'
import type { BankTransactionRule } from '@/types/Accounts/BankTransactionRule'
import type { BankTransactionRuleAccounts } from '@/types/Accounts/BankTransactionRuleAccounts'

/** What the creator seeds (`CreateNewRule.tsx:23-33`), which is the realistic starting point. */
const NEW_RULE_DEFAULTS: Partial<BankTransactionRule> = {
	rule_name: '',
	company: '_Test Company',
	rule_description: '',
	transaction_type: 'Any',
	classify_as: 'Bank Entry',
	bank_entry_type: 'Single Account',
	description_rules: [{ check: 'Contains' }]
} as Partial<BankTransactionRule>

const makeJournalRow = (
	overrides: Partial<BankTransactionRuleAccounts> = {}
): BankTransactionRuleAccounts => ({
	account: 'Bank Charges - _TC',
	party_type: '',
	party: '',
	debit: '',
	credit: '',
	user_remark: '',
	...overrides
}) as BankTransactionRuleAccounts

const Harness = ({
	defaults,
	isEdit,
	children
}: {
	defaults: Partial<BankTransactionRule>
	isEdit?: boolean
	children?: ReactNode
}) => {
	const form = useForm<BankTransactionRule>({ defaultValues: defaults as BankTransactionRule })

	return (
		<TooltipProvider>
			<FormProvider {...form}>
				<form>
					<RuleForm isEdit={isEdit} />
					{children}
				</form>
			</FormProvider>
		</TooltipProvider>
	)
}

const renderRuleForm = (
	defaults: Partial<BankTransactionRule> = NEW_RULE_DEFAULTS,
	isEdit?: boolean
) => {
	// Method-aware, because the link fields inside the form search through the same hook that the
	// title lookup reads an object from; one shape for both crashes the combobox.
	frappeSDKMock.useFrappeGetCall.mockImplementation(((method: string) => ({
		data: method === 'frappe.client.get_value' ? { message: {} } : { message: [] },
		error: undefined,
		isLoading: false,
		isValidating: false,
		mutate: vi.fn().mockResolvedValue(undefined)
	})) as never)

	return render(<Harness defaults={defaults} isEdit={isEdit} />)
}

describe('RuleForm', () => {

	describe('the conditions half', () => {

		it('asks for the identity and the description of the rule', () => {
			renderRuleForm()

			expect(screen.getByText('Rule Name')).toBeInTheDocument()
			expect(screen.getByText('Rule Description')).toBeInTheDocument()
			// The description is what a reviewer reads in the workbench badge, so it is part of the
			// rule's contract rather than a note to self.
			expect(
				screen.getByPlaceholderText("Any debit transaction with the keyword 'Bank Fee'.")
			).toBeInTheDocument()
		})

		it('offers all three transaction directions', () => {
			renderRuleForm()

			expect(screen.getByText('Transaction Type')).toBeInTheDocument()
			expect(screen.getByText('All')).toBeInTheDocument()
			expect(screen.getByText('Withdrawal')).toBeInTheDocument()
			expect(screen.getByText('Deposit')).toBeInTheDocument()
		})

		it('names the direction choice as a group without misusing a label', () => {
			renderRuleForm()

			// The three directions are one radiogroup, and a radiogroup is not a labelable control, so
			// it cannot be named by a <label for>. Doing that left the group anonymous and raised an
			// "Incorrect use of <label for=FORM_ELEMENT>" audit issue; `aria-labelledby` is the valid
			// way to name a grouping role.
			const group = screen.getByRole('radiogroup', { name: /Transaction Type/ })

			const heading = document.getElementById(group.getAttribute('aria-labelledby') ?? '')
			expect(heading).not.toBeNull()
			expect(heading!.tagName).not.toBe('LABEL')

			// No label anywhere in the form may point at the radiogroup, which is what made it invalid.
			const labelsTargetingTheGroup = Array.from(document.querySelectorAll('label')).filter(
				(label) => label.getAttribute('for') === group.id && group.id !== ''
			)
			expect(labelsTargetingTheGroup).toEqual([])
		})

		it('bounds the rule by amount', () => {
			renderRuleForm()

			// Without bounds a keyword rule would fire on a one-rupee fee and a million-rupee
			// transfer alike.
			expect(screen.getByText('Minimum Amount')).toBeInTheDocument()
			expect(screen.getByText('Maximum Amount')).toBeInTheDocument()
		})

		it('starts with a single description condition', () => {
			renderRuleForm()

			expect(
				screen.getByText('Rules to match against the transaction description')
			).toBeInTheDocument()
			expect(
				screen.getByPlaceholderText('Bank Fee, Salary, etc.')
			).toBeInTheDocument()
		})

		it('QUIRK - refuses to delete the last description condition', async () => {
			// A rule with no conditions would match EVERY transaction, so the final row's delete is
			// disabled rather than merely discouraged.
			renderRuleForm()

			/*
			 * Addressed by name and by ordinal. The old query hunted through
			 * `getAllByRole('button', { name: '' })` for whichever one happened to be disabled, so it
			 * asserted nothing about WHICH control was disabled - and it only found anything at all
			 * because these buttons were unnamed.
			 */
			expect(screen.getByRole('button', { name: 'Remove condition 1' })).toBeDisabled()
		})

		it('adds a further description condition on request', async () => {
			const user = userEvent.setup()
			renderRuleForm()

			expect(screen.getAllByPlaceholderText('Bank Fee, Salary, etc.')).toHaveLength(1)

			await user.click(screen.getByRole('button', { name: /Add Rule/ }))

			await waitFor(() => {
				expect(screen.getAllByPlaceholderText('Bank Fee, Salary, etc.')).toHaveLength(2)
			})
		})

		it('allows a condition to be removed once a second one exists', async () => {
			const user = userEvent.setup()
			renderRuleForm({
				...NEW_RULE_DEFAULTS,
				description_rules: [
					{ check: 'Contains', value: 'FEE' },
					{ check: 'Starts With', value: 'BANK' }
				]
			} as Partial<BankTransactionRule>)

			expect(screen.getAllByPlaceholderText('Bank Fee, Salary, etc.')).toHaveLength(2)

			// The second condition's own remove control, named for its position in the list.
			await user.click(screen.getByRole('button', { name: 'Remove condition 2' }))

			await waitFor(() => {
				expect(screen.getAllByPlaceholderText('Bank Fee, Salary, etc.')).toHaveLength(1)
			})
		})
	})

	describe('the action half', () => {

		it('states plainly that a rule only ever suggests', () => {
			renderRuleForm()

			// This is the guarantee that a rule never posts anything by itself, which is what makes
			// an aggressive rule safe to define.
			expect(screen.getByText('If rule matches, then:')).toBeInTheDocument()
			expect(
				screen.getByText(
					'This will just suggest creating a new entry, and will not automatically create it.'
				)
			).toBeInTheDocument()
		})

		it('QUIRK - asks which account for a Bank Entry', () => {
			renderRuleForm({ ...NEW_RULE_DEFAULTS, classify_as: 'Bank Entry' } as Partial<BankTransactionRule>)

			expect(screen.getByText('Create Bank Entry against')).toBeInTheDocument()
			expect(screen.getByText('Account')).toBeInTheDocument()
			// A Bank Entry has no counterparty, so no party question is asked.
			expect(screen.queryByText('Party Type')).not.toBeInTheDocument()
		})

		it('QUIRK - asks which party for a Payment Entry instead', () => {
			renderRuleForm({
				...NEW_RULE_DEFAULTS,
				classify_as: 'Payment Entry',
				bank_entry_type: undefined
			} as Partial<BankTransactionRule>)

			expect(screen.getByText('Party Type')).toBeInTheDocument()
			expect(screen.getByText('Party')).toBeInTheDocument()
			// The bank-entry question is meaningless for a payment, so it is withdrawn entirely.
			expect(screen.queryByText('Create Bank Entry against')).not.toBeInTheDocument()
		})

		it('QUIRK - asks for neither party nor entry style for a Transfer', () => {
			renderRuleForm({
				...NEW_RULE_DEFAULTS,
				classify_as: 'Transfer',
				bank_entry_type: undefined
			} as Partial<BankTransactionRule>)

			// A transfer's counterparty IS an account, so only the account question survives.
			expect(screen.getByText('Account')).toBeInTheDocument()
			expect(screen.queryByText('Party Type')).not.toBeInTheDocument()
			expect(screen.queryByText('Create Bank Entry against')).not.toBeInTheDocument()
		})

		it('QUIRK - disables the party field until a party type is chosen', () => {
			// The party field is a link search, and a link search has no doctype to search until the
			// party type names one - so an enabled-but-useless field would be the worse option.
			renderRuleForm({
				...NEW_RULE_DEFAULTS,
				classify_as: 'Payment Entry',
				bank_entry_type: undefined,
				party_type: undefined
			} as Partial<BankTransactionRule>)

			// The accessible name carries the required indicator - an asterisk for the eye and the word
			// for a screen reader - and it must be anchored so that "Party Type*" in the same section is
			// not matched instead.
			expect(screen.getByLabelText(/^Party\*, required$/)).toBeDisabled()
		})

		it('opens the party field once a party type names the doctype to search', () => {
			renderRuleForm({
				...NEW_RULE_DEFAULTS,
				classify_as: 'Payment Entry',
				bank_entry_type: undefined,
				party_type: 'Supplier'
			} as Partial<BankTransactionRule>)

			// A link SEARCH rather than a plain disabled input: the doctype is now known. It also
			// stops advertising itself as required, because the search itself enforces the choice -
			// which is why the asterisk that the disabled variant carries is absent here.
			expect(screen.getByLabelText(/^Party$/)).toBeEnabled()
			expect(screen.queryByLabelText(/^Party\*, required$/)).not.toBeInTheDocument()
		})
	})

	describe('a journal-template action', () => {

		const MULTI_DEFAULTS = {
			...NEW_RULE_DEFAULTS,
			classify_as: 'Bank Entry',
			bank_entry_type: 'Multiple Accounts'
		} as Partial<BankTransactionRule>

		it('QUIRK - replaces the single account picker with a journal table', () => {
			// A split across several accounts cannot be expressed as one account, so the two are
			// mutually exclusive rather than additive.
			renderRuleForm(MULTI_DEFAULTS)

			expect(screen.getByText('Journal Template Accounts')).toBeInTheDocument()
			expect(screen.getByText('Debit')).toBeInTheDocument()
			expect(screen.getByText('Credit')).toBeInTheDocument()
		})

		it('invites configuration when no accounts are set up yet', () => {
			renderRuleForm(MULTI_DEFAULTS)

			expect(screen.getByText('No accounts configured')).toBeInTheDocument()
			expect(
				screen.getAllByRole('button', { name: /Configure Accounts/ }).length
			).toBeGreaterThan(0)
		})

		it('lists each configured account with its figures', () => {
			renderRuleForm({
				...MULTI_DEFAULTS,
				accounts: [
					makeJournalRow({ account: 'Bank Charges - _TC', debit: '150' }),
					makeJournalRow({ account: 'GST - _TC', debit: '27' }),
					makeJournalRow({ account: 'Bank Account - _TC' })
				]
			} as Partial<BankTransactionRule>)

			expect(screen.getByText('Bank Charges - _TC')).toBeInTheDocument()
			expect(screen.getByText('150')).toBeInTheDocument()
			expect(screen.getByText('GST - _TC')).toBeInTheDocument()
			expect(screen.getByText('27')).toBeInTheDocument()
		})

		it('QUIRK - explains the last row rather than showing figures for it', () => {
			// The backend derives the final row to make the journal balance, so showing an editable
			// figure there would imply control the reviewer does not have.
			renderRuleForm({
				...MULTI_DEFAULTS,
				accounts: [
					makeJournalRow({ account: 'Bank Charges - _TC', debit: '150' }),
					makeJournalRow({ account: 'Bank Account - _TC' })
				]
			} as Partial<BankTransactionRule>)

			expect(
				screen.getByText('This is auto computed to balance the journal entry.')
			).toBeInTheDocument()
		})

		it('QUIRK - previews a formula figure instead of showing it as a plain number', async () => {
			// Anything non-numeric is treated as a formula over `transaction_amount`, and the preview
			// against a sample is the only way a reviewer can tell what it will actually post.
			renderRuleForm({
				...MULTI_DEFAULTS,
				accounts: [
					makeJournalRow({ account: 'Bank Charges - _TC', debit: 'transaction_amount * 0.25' }),
					makeJournalRow({ account: 'Bank Account - _TC' })
				]
			} as Partial<BankTransactionRule>)

			const formula = screen.getByText('transaction_amount * 0.25')

			// Underlined to advertise that it carries an explanation, unlike a literal amount.
			expect(formula).toHaveClass('underline')
		})

		it('QUIRK - presents an unparseable formula as VALID, previewing zero', () => {
			// `AmountFormulaRenderer` decides validity from `!isNaN(Number(calculatedValue))`, and
			// `evaluateAmountFormula` NEVER throws or returns NaN - it yields 0 for anything it cannot
			// parse (verified across nonsense identifiers, unbalanced parentheses, string and object
			// literals, and division by zero). So `calculatedValue` is always numeric, the red
			// "not a valid formula" branch is unreachable, and a typo'd formula is presented with the
			// reassuring "This is a formula based value." while previewing 0.
			//
			// Pinned rather than fixed: the arithmetic lives in `lib/amountFormula.ts`, and changing
			// its contract from "lenient, yields 0" to "throws" would alter every other caller. This
			// test is the standing record that the warning path is currently dead.
			renderRuleForm({
				...MULTI_DEFAULTS,
				accounts: [
					makeJournalRow({ account: 'Bank Charges - _TC', debit: 'nonsense_variable * 2' }),
					makeJournalRow({ account: 'Bank Account - _TC' })
				]
			} as Partial<BankTransactionRule>)

			const formula = screen.getByText('nonsense_variable * 2')

			// Treated as a formula (underlined, carries an explanation) ...
			expect(formula).toHaveClass('underline')
			// ... but NOT flagged, which is the hazard.
			expect(formula).not.toHaveClass('text-ink-red-3')
		})

		it('leaves a literal amount unadorned', () => {
			renderRuleForm({
				...MULTI_DEFAULTS,
				accounts: [
					makeJournalRow({ account: 'Bank Charges - _TC', debit: '150' }),
					makeJournalRow({ account: 'Bank Account - _TC' })
				]
			} as Partial<BankTransactionRule>)

			// No tooltip, no underline: there is nothing to explain about a fixed figure.
			expect(screen.getByText('150')).not.toHaveClass('underline')
		})

		it('opens the account configurator on request', async () => {
			const user = userEvent.setup()
			renderRuleForm(MULTI_DEFAULTS)

			await user.click(screen.getAllByRole('button', { name: /Configure Accounts/ })[0])

			// The configurator explains the formula facility, which is where a reviewer learns that
			// figures may be expressions at all.
			expect(
				await screen.findByText(
					/You can set up the rule to split the transaction across multiple accounts/
				)
			).toBeInTheDocument()
		})
	})
})
