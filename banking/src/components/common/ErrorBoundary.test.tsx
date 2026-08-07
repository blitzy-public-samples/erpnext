/**
 * Behavioural specification for the render-error containment boundary.
 *
 * React's default when a render throws and nothing catches it is to unmount the WHOLE tree - correct for
 * a framework, wrong for a surface that renders records it did not write, because one malformed record
 * then costs the reviewer their entire workbench and any unsaved selection with it. This boundary is what
 * turns that into a local, reportable failure.
 *
 * Every test here throws on purpose, so each one silences `console.error` for its own duration: React
 * reports a caught error itself, in addition to the boundary's own entry, and an unsilenced suite buries
 * its real output. Where the console entry IS the behaviour under test, it is asserted rather than
 * silenced-and-forgotten.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import ErrorBoundary from './ErrorBoundary'

/** Throws on render when told to, so a test can move a subtree in and out of failure. */
const Explode = ({ when = true, thrown }: { when?: boolean, thrown?: unknown }) => {
	if (when) {
		throw thrown ?? new Error('render failed')
	}
	return <p>Rendered fine</p>
}

/** Runs `body` with React's own error reporting silenced, and hands back the spy for assertions. */
const withSilencedConsole = async (
	body: (consoleError: ReturnType<typeof vi.spyOn>) => Promise<void> | void
) => {
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { })
	try {
		await body(consoleError)
	} finally {
		consoleError.mockRestore()
	}
}

describe('ErrorBoundary', () => {

	describe('when nothing throws', () => {

		it('is invisible - it renders its children and nothing of its own', () => {
			const { container } = render(
				<ErrorBoundary fallback={<p>Fallback</p>}>
					<Explode when={false} />
				</ErrorBoundary>
			)

			expect(screen.getByText('Rendered fine')).toBeInTheDocument()
			expect(screen.queryByText('Fallback')).not.toBeInTheDocument()
			expect(container.textContent).toBe('Rendered fine')
		})
	})

	describe('when a child throws', () => {

		it('renders the fallback in its place instead of unmounting the tree', async () => {
			await withSilencedConsole(() => {
				render(
					<div>
						<p>Sibling survives</p>
						<ErrorBoundary fallback={<p>Fallback</p>}>
							<Explode />
						</ErrorBoundary>
					</div>
				)

				expect(screen.getByText('Fallback')).toBeInTheDocument()
				// The whole point: everything outside the boundary is still on the page.
				expect(screen.getByText('Sibling survives')).toBeInTheDocument()
			})
		})

		it('hands the error to a function fallback, so a caller can name what failed', async () => {
			await withSilencedConsole(() => {
				render(
					<ErrorBoundary fallback={(error) => <p>Could not render: {error.message}</p>}>
						<Explode thrown={new Error('accounts is undefined')} />
					</ErrorBoundary>
				)

				expect(screen.getByText('Could not render: accounts is undefined')).toBeInTheDocument()
			})
		})

		it('normalises a thrown non-Error, so a fallback can always read a message', async () => {
			// `throw 'some string'` is legal JavaScript and does reach a boundary. A fallback that reads
			// `.message` off it would otherwise render "undefined" - or throw again.
			await withSilencedConsole(() => {
				render(
					<ErrorBoundary fallback={(error) => <p>Could not render: {error.message}</p>}>
						<Explode thrown='a bare string' />
					</ErrorBoundary>
				)

				expect(screen.getByText('Could not render: a bare string')).toBeInTheDocument()
			})
		})

		it('reports to the console under the label it was given', async () => {
			// A tidy fallback with no trace behind it is worse than the crash: nobody can diagnose it.
			await withSilencedConsole((consoleError) => {
				render(
					<ErrorBoundary label='Action log row' fallback={<p>Fallback</p>}>
						<Explode />
					</ErrorBoundary>
				)

				expect(
					consoleError.mock.calls.some((call: unknown[]) =>
						typeof call[0] === 'string' && call[0].includes('[ErrorBoundary: Action log row]')
					)
				).toBe(true)
			})
		})

		it('notifies onError with the error and the component stack', async () => {
			await withSilencedConsole(() => {
				const onError = vi.fn()

				render(
					<ErrorBoundary fallback={<p>Fallback</p>} onError={onError}>
						<Explode />
					</ErrorBoundary>
				)

				expect(onError).toHaveBeenCalledTimes(1)
				expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
				expect(onError.mock.calls[0][1]).toHaveProperty('componentStack')
			})
		})
	})

	describe('recovering', () => {

		/**
		 * A parent that can both fix the child AND change the boundary's reset key, so the two halves of
		 * recovery can be exercised independently.
		 */
		const Harness = ({ resetOnFix }: { resetOnFix: boolean }) => {
			const [broken, setBroken] = useState(true)

			return (
				<div>
					<button type='button' onClick={() => setBroken(false)}>Fix it</button>
					<ErrorBoundary
						fallback={<p>Fallback</p>}
						resetKey={resetOnFix ? broken : 'never changes'}>
						<Explode when={broken} />
					</ErrorBoundary>
				</div>
			)
		}

		const renderHarness = (resetOnFix: boolean): ReactNode => <Harness resetOnFix={resetOnFix} />

		it('tries again once the reset key changes', async () => {
			await withSilencedConsole(async () => {
				render(renderHarness(true))

				expect(screen.getByText('Fallback')).toBeInTheDocument()

				await userEvent.click(screen.getByRole('button', { name: 'Fix it' }))

				expect(screen.getByText('Rendered fine')).toBeInTheDocument()
				expect(screen.queryByText('Fallback')).not.toBeInTheDocument()
			})
		})

		it('stays in the fallback while the reset key is unchanged, even after the data is corrected', async () => {
			// Deliberate: without a signal that something is different, retrying would throw again on every
			// render and spin. The caller decides what "different" means.
			await withSilencedConsole(async () => {
				render(renderHarness(false))

				expect(screen.getByText('Fallback')).toBeInTheDocument()

				await userEvent.click(screen.getByRole('button', { name: 'Fix it' }))

				expect(screen.getByText('Fallback')).toBeInTheDocument()
				expect(screen.queryByText('Rendered fine')).not.toBeInTheDocument()
			})
		})
	})
})
