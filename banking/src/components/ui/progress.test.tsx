/**
 * Behavioural specification for the shared `Progress` bar.
 *
 * Two bars in this application report real, knowable figures - how much of a reconciliation period is
 * done, and how far a statement import has got - and both were announcing themselves as indeterminate.
 * The cause was in this file: `value` was destructured out of the props and then never handed to the
 * Radix root, so the primitive was told nothing and every bar rendered `data-state="indeterminate"` with
 * no `aria-valuenow`, while the visual indicator was positioned from the same value the primitive never
 * saw. A bar that draws 75% and says "loading" is worse than one that draws nothing.
 *
 * Three behaviours are pinned below:
 *   1. a numeric value makes the bar determinate, and reaches both the primitive and the indicator;
 *   2. the bar carries an accessible name - from `aria-label`, or from a plain-text `label` - because a
 *      progress bar announcing a bare number says nothing about what is progressing;
 *   3. the spoken value prefers the caller's own wording ("3 / 4 reconciled") over a bare percentage,
 *      since that is what a sighted reviewer reads beside it.
 *
 * Indeterminate remains available: passing no value is how a caller says it genuinely does not know.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { Progress } from './progress'

const bar = () => screen.getByRole('progressbar')

const indicator = (container: HTMLElement): HTMLElement => {
	const node = container.querySelector<HTMLElement>('[data-slot="progress-indicator"]')

	if (!node) {
		throw new Error('The progress indicator did not render')
	}

	return node
}

describe('Progress', () => {

	describe('a known figure', () => {

		it('reaches the primitive, so the bar is determinate rather than loading forever', () => {
			render(<Progress value={75} max={100} label="Progress" />)

			expect(bar()).toHaveAttribute('data-state', 'loading')
			expect(bar()).toHaveAttribute('aria-valuenow', '75')
			expect(bar()).toHaveAttribute('aria-valuemin', '0')
			expect(bar()).toHaveAttribute('aria-valuemax', '100')
		})

		it('reaches the indicator as well, so what is drawn matches what is announced', () => {
			const { container } = render(<Progress value={75} max={100} label="Progress" />)

			expect(indicator(container).style.transform).toBe('translateX(-25%)')
		})

		it('reports completion as complete', () => {
			render(<Progress value={100} max={100} label="Progress" />)

			expect(bar()).toHaveAttribute('data-state', 'complete')
			expect(bar()).toHaveAttribute('aria-valuenow', '100')
		})

		it('treats zero as a figure, not as an absent one', () => {
			// The distinction the original defect blurred: nothing done yet is not the same as not knowing.
			render(<Progress value={0} max={100} label="Progress" />)

			expect(bar()).toHaveAttribute('data-state', 'loading')
			expect(bar()).toHaveAttribute('aria-valuenow', '0')
		})
	})

	describe('no figure at all', () => {

		it('stays indeterminate, which is how a caller says it does not know', () => {
			render(<Progress label="Progress" />)

			expect(bar()).toHaveAttribute('data-state', 'indeterminate')
			expect(bar()).not.toHaveAttribute('aria-valuenow')
		})

		it('draws an empty bar rather than a broken transform', () => {
			const { container } = render(<Progress label="Progress" />)

			expect(indicator(container).style.transform).toBe('translateX(-100%)')
		})
	})

	describe('the accessible name', () => {

		it('takes a plain-text label, so the common case needs nothing extra', () => {
			render(<Progress value={40} max={100} label="Import progress" />)

			expect(bar()).toHaveAccessibleName('Import progress')
		})

		it('prefers an explicit aria-label, for a label that is more specific on screen than in speech', () => {
			render(<Progress value={40} max={100} label="Progress" aria-label="Reconciliation progress" />)

			expect(bar()).toHaveAccessibleName('Reconciliation progress')
		})

		it('leaves the name unset for a label carrying markup, which cannot be flattened safely', () => {
			// Such a caller must pass `aria-label` itself; inventing a name from a React tree would be a
			// guess, and a wrong name is worse than a missing one.
			render(<Progress value={40} max={100} label={<strong>Progress</strong>} />)

			expect(bar()).not.toHaveAttribute('aria-label')
		})
	})

	describe('the spoken value', () => {

		it('uses the caller\'s own wording where there is some', () => {
			render(<Progress value={75} max={100} label="Progress" hint hintText="3 / 4 reconciled" />)

			expect(bar()).toHaveAttribute('aria-valuetext', '3 / 4 reconciled')
			// And the same wording is what the reviewer reads beside the bar.
			expect(screen.getByText('3 / 4 reconciled')).toBeInTheDocument()
		})

		it('falls back to a rounded percentage', () => {
			render(<Progress value={62.5} max={100} label="Progress" />)

			expect(bar()).toHaveAttribute('aria-valuetext', '63%')
		})

		it('computes that percentage against the caller\'s own maximum', () => {
			render(<Progress value={20} max={40} label="Progress" />)

			expect(bar()).toHaveAttribute('aria-valuetext', '50%')
		})
	})

	describe('presentation', () => {

		it('renders the label and the hint together above the bar', () => {
			render(<Progress value={30} max={100} label="Progress" hint />)

			expect(screen.getByText('Progress')).toBeInTheDocument()
			expect(screen.getByText('30%')).toBeInTheDocument()
		})

		it('renders neither when the caller asks for neither', () => {
			render(<Progress value={30} max={100} aria-label="Progress" />)

			expect(screen.queryByText('30%')).not.toBeInTheDocument()
			expect(bar()).toHaveAccessibleName('Progress')
		})

		it('carries the size it was given, so callers keep control of the visual weight', () => {
			render(<Progress value={30} max={100} size="lg" aria-label="Progress" />)

			expect(bar()).toHaveAttribute('data-size', 'lg')
		})
	})
})
