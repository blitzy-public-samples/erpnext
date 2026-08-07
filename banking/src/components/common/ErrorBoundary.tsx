import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * A render-error containment boundary.
 *
 * React tears the WHOLE tree down when a render throws and nothing catches it: the reviewer loses the
 * entire workbench - and, with it, any unsaved selection - to a blank page, and the only way back is a
 * reload. That is the correct default for a framework, but it is the wrong outcome for a surface that
 * renders records it did not write, because one malformed record then costs the reviewer everything.
 *
 * This is deliberately a class component. An error boundary is the one thing React exposes only through
 * the class API - there is no hook equivalent to `componentDidCatch` - so the codebase's function-component
 * convention cannot be followed here and the exception is confined to this file.
 *
 * The boundary reports and contains; it never repairs. A caller that knows how to degrade gracefully
 * should still guard its own data, and use this as the backstop for the case it did not foresee.
 */

interface ErrorBoundaryProps {
	/** The subtree to protect. */
	children: ReactNode
	/**
	 * What replaces `children` once they have thrown. Passing a function hands the caller the error, so
	 * it can name the record that failed without this boundary having to know anything about its shape.
	 */
	fallback: ReactNode | ((error: Error) => ReactNode)
	/**
	 * Names this subtree in the console entry, so "the action log went blank" can be traced to the
	 * subtree that threw without needing a source map.
	 */
	label?: string
	/**
	 * Rendering `children` is retried whenever this changes by identity. Callers pass whatever identifies
	 * the data being rendered: corrected data deserves a fresh attempt, and without this a subtree that
	 * threw once would stay in its fallback for the life of the mount even after the cause was gone.
	 */
	resetKey?: unknown
	/** Notified after the error is caught, for a caller that wants to record or count the failure. */
	onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
	error: Error | null
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {

	state: ErrorBoundaryState = { error: null }

	static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
		// A thrown non-Error - a string, or an object without a message - is normalised here so every
		// consumer of `fallback` can rely on reading `.message`.
		return { error: error instanceof Error ? error : new Error(String(error)) }
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		// The console entry is the only durable trace of a contained failure: the reviewer sees a tidy
		// fallback and would otherwise have nothing to report. Keep the component stack - it is what
		// identifies which record broke.
		console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}]`, error, info.componentStack)
		this.props.onError?.(error, info)
	}

	componentDidUpdate(previous: ErrorBoundaryProps) {
		if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
			this.setState({ error: null })
		}
	}

	render() {
		const { error } = this.state

		if (error !== null) {
			const { fallback } = this.props
			return typeof fallback === 'function' ? fallback(error) : fallback
		}

		return this.props.children
	}
}

export default ErrorBoundary
