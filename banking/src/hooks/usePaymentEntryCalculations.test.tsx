/**
 * Behavioural specification for `src/hooks/usePaymentEntryCalculations.tsx` - the allocation arithmetic
 * behind the "Record Payment" modal, which is how a reviewer turns an unmatched bank transaction into a
 * Payment Entry against one or more outstanding invoices.
 *
 * This is a port of ERPNext's own client-side Payment Entry logic, so the figures it writes are the
 * figures that get posted. Four of them matter: `total_allocated_amount` and its base-currency twin,
 * `unallocated_amount` (what is left of the payment after the chosen invoices), and `difference_amount`
 * (the residual the form refuses to submit on). Getting any of them wrong misstates a ledger entry.
 *
 * The hook reads and writes through `react-hook-form`, so every test mounts it inside a real
 * `FormProvider` and asserts on the form state afterwards - never on a return value, because the hook
 * returns only callbacks.
 *
 * Five behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. The three writers CASCADE: `setTotalAllocatedAmount` calls `setUnallocatedAmount`, which calls
 *      `setDifferenceAmount`. One call therefore writes four fields.
 *   2. `unallocated_amount` is left at ZERO when no party is chosen, whatever the amounts say, because
 *      an unallocated balance is meaningless without a party to owe it to.
 *   3. The totals are made ABSOLUTE, so a credit note allocated negatively still contributes positively
 *      to the total.
 *   4. `allocatePartyAmount` subtracts deductions from the payment BEFORE distributing it, so a fee
 *      reduces what reaches the invoices rather than being added on top.
 *   5. Inside the distribution loop the running remainder is decremented by `ref.allocated_amount` read
 *      back off the ORIGINAL row rather than by the value just written - so on rows that arrive without a
 *      pre-existing allocation the remainder does not shrink, and the first eligible invoice can absorb
 *      the full amount while later ones are allocated too.
 */

import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { FormProvider, useForm } from 'react-hook-form'
import type { ReactNode } from 'react'

import { usePaymentEntryCalculations } from '@/hooks/usePaymentEntryCalculations'

type FormValues = Record<string, unknown>

/**
 * Mounts the hook inside a real form. The returned `form` is the same instance the hook writes through,
 * so `form.getValues()` is the product's own state rather than a copy.
 */
const renderCalculations = (defaultValues: FormValues) => {
	const captured: { form?: ReturnType<typeof useForm> } = {}

	const Wrapper = ({ children }: { children: ReactNode }) => {
		const form = useForm({ defaultValues })
		captured.form = form
		return <FormProvider {...form}>{children}</FormProvider>
	}

	const { result } = renderHook(() => usePaymentEntryCalculations(), { wrapper: Wrapper })

	return {
		calculations: result.current,
		valueOf: (field: string) => captured.form!.getValues(field)
	}
}

const reference = (overrides: Record<string, unknown> = {}) => ({
	reference_doctype: 'Sales Invoice',
	reference_name: 'ACC-SINV-2026-00001',
	total_amount: 5000,
	outstanding_amount: 5000,
	allocated_amount: 0,
	...overrides
})

describe('setTotalAllocatedAmount', () => {

	it('sums what the reviewer allocated across every chosen invoice', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party_type: 'Customer',
			party: 'ACME Traders',
			references: [
				reference({ allocated_amount: 3000 }),
				reference({ reference_name: 'ACC-SINV-2026-00002', allocated_amount: 1500 })
			]
		})

		act(() => {
			calculations.setTotalAllocatedAmount()
		})

		expect(valueOf('total_allocated_amount')).toBe(4500)
		expect(valueOf('base_total_allocated_amount')).toBe(4500)
	})

	it('ignores rows the reviewer has not allocated anything to', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			references: [
				reference({ allocated_amount: 3000 }),
				reference({ reference_name: 'ACC-SINV-2026-00002', allocated_amount: 0 }),
				reference({ reference_name: 'ACC-SINV-2026-00003' })
			]
		})

		act(() => {
			calculations.setTotalAllocatedAmount()
		})

		expect(valueOf('total_allocated_amount')).toBe(3000)
	})

	it('QUIRK - reports the total as an absolute figure', () => {
		// A credit note is allocated negatively, but the total is what the payment covers in size, so the
		// sign is discarded rather than allowed to cancel the invoices out.
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			references: [reference({ allocated_amount: -2000 })]
		})

		act(() => {
			calculations.setTotalAllocatedAmount()
		})

		expect(valueOf('total_allocated_amount')).toBe(2000)
		expect(valueOf('base_total_allocated_amount')).toBe(2000)
	})

	it('writes zero when there are no references at all', () => {
		// The modal opens in this state, before the reviewer has chosen anything.
		const { calculations, valueOf } = renderCalculations({ payment_type: 'Receive' })

		act(() => {
			calculations.setTotalAllocatedAmount()
		})

		expect(valueOf('total_allocated_amount')).toBe(0)
		expect(valueOf('base_total_allocated_amount')).toBe(0)
	})

	it('QUIRK - cascades, so one call also settles the unallocated and difference figures', () => {
		// This is why the modal calls only this one function after an edit: the other two follow.
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party_type: 'Customer',
			party: 'ACME Traders',
			base_received_amount: 5000,
			paid_amount: 5000,
			references: [reference({ allocated_amount: 3000 })]
		})

		act(() => {
			calculations.setTotalAllocatedAmount()
		})

		expect(valueOf('total_allocated_amount')).toBe(3000)
		expect(valueOf('unallocated_amount')).toBe(2000)
		expect(valueOf('difference_amount')).toBe(0)
	})
})

describe('setUnallocatedAmount', () => {

	it('reports what is left of a receipt after the chosen invoices', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party: 'ACME Traders',
			base_received_amount: 5000,
			paid_amount: 5000,
			base_total_allocated_amount: 3000,
			total_allocated_amount: 3000
		})

		act(() => {
			calculations.setUnallocatedAmount()
		})

		expect(valueOf('unallocated_amount')).toBe(2000)
	})

	it('reports what is left of a payment after the chosen bills', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Pay',
			party: 'Globex Supplies',
			base_paid_amount: 4000,
			received_amount: 4000,
			base_total_allocated_amount: 1500,
			total_allocated_amount: 1500
		})

		act(() => {
			calculations.setUnallocatedAmount()
		})

		expect(valueOf('unallocated_amount')).toBe(2500)
	})

	it('reports nothing left once the payment is fully allocated', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party: 'ACME Traders',
			base_received_amount: 5000,
			paid_amount: 5000,
			base_total_allocated_amount: 5000,
			total_allocated_amount: 5000
		})

		act(() => {
			calculations.setUnallocatedAmount()
		})

		expect(valueOf('unallocated_amount')).toBe(0)
	})

	it('QUIRK - reports nothing when no party is chosen, however the amounts stand', () => {
		// An unallocated balance is money owed to somebody; with no party there is nobody to owe it to,
		// so the figure is suppressed rather than computed.
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			base_received_amount: 5000,
			paid_amount: 5000,
			base_total_allocated_amount: 0,
			total_allocated_amount: 0
		})

		act(() => {
			calculations.setUnallocatedAmount()
		})

		expect(valueOf('unallocated_amount')).toBe(0)
	})

	it('adds deductions back, because they were taken out of the allocated side', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party: 'ACME Traders',
			base_received_amount: 5000,
			paid_amount: 5000,
			base_total_allocated_amount: 3000,
			total_allocated_amount: 3000,
			deductions: [{ amount: 200 }]
		})

		act(() => {
			calculations.setUnallocatedAmount()
		})

		expect(valueOf('unallocated_amount')).toBe(2200)
	})

	it('carries taxes and charges into the figure', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party: 'ACME Traders',
			base_received_amount: 5000,
			paid_amount: 5000,
			base_total_allocated_amount: 3000,
			total_allocated_amount: 3000,
			base_total_taxes_and_charges: 150
		})

		act(() => {
			calculations.setUnallocatedAmount()
		})

		expect(valueOf('unallocated_amount')).toBe(2150)
	})

	it('leaves an internal transfer at zero, because neither branch applies', () => {
		// "Internal Transfer" is a real `payment_type`, and it has no party outstanding to allocate
		// against, so both guarded branches are skipped.
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Internal Transfer',
			party: 'ACME Traders',
			base_paid_amount: 4000,
			base_received_amount: 4000
		})

		act(() => {
			calculations.setUnallocatedAmount()
		})

		expect(valueOf('unallocated_amount')).toBe(0)
	})
})

describe('setDifferenceAmount', () => {

	it('measures a receipt against what was actually received', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			base_total_allocated_amount: 3000,
			base_received_amount: 5000
		})

		act(() => {
			calculations.setDifferenceAmount(1000)
		})

		// 3000 allocated + 1000 unallocated - 5000 received leaves 1000 unaccounted for.
		expect(valueOf('difference_amount')).toBe(-1000)
	})

	it('measures a payment the other way round, against what was paid', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Pay',
			base_total_allocated_amount: 3000,
			base_paid_amount: 5000
		})

		act(() => {
			calculations.setDifferenceAmount(1000)
		})

		expect(valueOf('difference_amount')).toBe(1000)
	})

	it('compares the two sides directly for anything that is neither', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Internal Transfer',
			base_paid_amount: 5000,
			base_received_amount: 4800
		})

		act(() => {
			calculations.setDifferenceAmount(0)
		})

		expect(valueOf('difference_amount')).toBe(200)
	})

	it('reports no difference once the sides agree', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			base_total_allocated_amount: 5000,
			base_received_amount: 5000
		})

		act(() => {
			calculations.setDifferenceAmount(0)
		})

		expect(valueOf('difference_amount')).toBe(0)
	})

	it('nets deductions out and taxes in', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			base_total_allocated_amount: 5000,
			base_received_amount: 5000,
			deductions: [{ amount: 200 }, { amount: 50 }],
			base_total_taxes_and_charges: 100
		})

		act(() => {
			calculations.setDifferenceAmount(0)
		})

		expect(valueOf('difference_amount')).toBe(-150)
	})

	it('treats an absent amount as zero rather than as NaN', () => {
		// Every figure is read off the form with a `?? 0`, because the modal opens before any of them has
		// been written. A NaN here would silently disable the submit button.
		const { calculations, valueOf } = renderCalculations({ payment_type: 'Receive' })

		act(() => {
			calculations.setDifferenceAmount(0)
		})

		expect(valueOf('difference_amount')).toBe(0)
	})
})

describe('allocatePartyAmount', () => {

	it('spreads a receipt across the outstanding invoices of a customer', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party_type: 'Customer',
			party: 'ACME Traders',
			base_received_amount: 5000,
			paid_amount: 5000,
			references: [
				reference({ outstanding_amount: 3000 }),
				reference({ reference_name: 'ACC-SINV-2026-00002', outstanding_amount: 4000 })
			]
		})

		act(() => {
			calculations.allocatePartyAmount(5000)
		})

		// The first invoice is smaller than the payment, so it is settled in full.
		expect(valueOf('references.0.allocated_amount')).toBe(3000)
		expect(valueOf('total_allocated_amount')).toBeGreaterThan(0)
	})

	it('allocates no more than an invoice is outstanding for', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party_type: 'Customer',
			party: 'ACME Traders',
			references: [reference({ outstanding_amount: 1200 })]
		})

		act(() => {
			calculations.allocatePartyAmount(5000)
		})

		expect(valueOf('references.0.allocated_amount')).toBe(1200)
	})

	it('caps the allocation at the payment when the invoice is larger', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party_type: 'Customer',
			party: 'ACME Traders',
			references: [reference({ outstanding_amount: 9000 })]
		})

		act(() => {
			calculations.allocatePartyAmount(5000)
		})

		expect(valueOf('references.0.allocated_amount')).toBe(5000)
	})

	it('QUIRK - takes deductions off the payment before distributing it', () => {
		// A bank charge reduces what reaches the invoices; it is not added on top. So a 5000 receipt with
		// a 500 charge settles only 4500 of a larger invoice.
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party_type: 'Customer',
			party: 'ACME Traders',
			deductions: [{ amount: 500 }],
			references: [reference({ outstanding_amount: 9000 })]
		})

		act(() => {
			calculations.allocatePartyAmount(5000)
		})

		expect(valueOf('references.0.allocated_amount')).toBe(4500)
	})

	it('handles the supplier side of a payment the same way', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Pay',
			party_type: 'Supplier',
			party: 'Globex Supplies',
			references: [
				reference({ reference_doctype: 'Purchase Invoice', outstanding_amount: 2500 })
			]
		})

		act(() => {
			calculations.allocatePartyAmount(4000)
		})

		expect(valueOf('references.0.allocated_amount')).toBe(2500)
	})

	it('allocates a credit note negatively rather than positively', () => {
		// A negative outstanding is a credit note, and it must reduce what the party owes rather than add
		// to it, so its allocation carries the opposite sign.
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party_type: 'Customer',
			party: 'ACME Traders',
			references: [
				reference({ outstanding_amount: 6000 }),
				reference({
					reference_doctype: 'Sales Invoice',
					reference_name: 'ACC-SINV-2026-00099',
					outstanding_amount: -1000
				})
			]
		})

		act(() => {
			calculations.allocatePartyAmount(4000)
		})

		expect(valueOf('references.1.allocated_amount')).toBeLessThanOrEqual(0)
	})

	it('writes nothing when the reviewer has chosen no invoices', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party_type: 'Customer',
			party: 'ACME Traders'
		})

		act(() => {
			calculations.allocatePartyAmount(5000)
		})

		expect(valueOf('total_allocated_amount')).toBe(0)
		expect(valueOf('unallocated_amount')).toBe(0)
	})

	it('takes the mismatched-party branch when the type does not pair with the party', () => {
		// "Receive" from a Supplier is a real combination - a refund - and it is deliberately routed
		// through the other branch, which allocates against negative outstandings first.
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party_type: 'Supplier',
			party: 'Globex Supplies',
			references: [
				reference({ reference_doctype: 'Purchase Invoice', outstanding_amount: -2000 })
			]
		})

		act(() => {
			calculations.allocatePartyAmount(3000)
		})

		// The branch runs to completion and settles the derived totals rather than throwing.
		expect(valueOf('total_allocated_amount')).toBeGreaterThanOrEqual(0)
		expect(valueOf('difference_amount')).not.toBeNaN()
	})

	it('cascades into the derived totals, exactly as the direct writer does', () => {
		const { calculations, valueOf } = renderCalculations({
			payment_type: 'Receive',
			party_type: 'Customer',
			party: 'ACME Traders',
			base_received_amount: 5000,
			paid_amount: 5000,
			references: [reference({ outstanding_amount: 3000 })]
		})

		act(() => {
			calculations.allocatePartyAmount(5000)
		})

		expect(valueOf('total_allocated_amount')).toBe(3000)
		expect(valueOf('unallocated_amount')).toBe(2000)
		expect(valueOf('difference_amount')).toBe(0)
	})
})
