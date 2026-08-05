/**
 * Behavioural specification for multi-file upload progress.
 *
 * A reviewer attaching several documents to a payment gets ONE progress bar, not one per file, so this
 * hook's job is to turn N independent per-file callbacks into a single trustworthy number. The bar is the
 * only signal that a slow upload is still alive, so a number that stalls, jumps backwards, or reaches 100%
 * early is worse than no bar at all.
 *
 * Four behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. Progress is the MEAN of the per-file fractions, so one finished file out of four reports 25% - not
 *      "one of four done".
 *   2. It ignores an out-of-range file index rather than growing the array, because a stray callback from
 *      a superseded upload would otherwise dilute the average of the current one.
 *   3. It ignores a zero or negative file count, leaving the previous state untouched, so an empty
 *      submission cannot blank a bar that is legitimately mid-flight.
 *   4. Updates arriving before `startTracking` are dropped, because there is no denominator to average
 *      over yet.
 */

import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { useMultiFileUploadProgress } from './useMultiFileUploadProgress'

describe('useMultiFileUploadProgress', () => {

	it('starts at nothing', () => {
		const { result } = renderHook(() => useMultiFileUploadProgress())

		expect(result.current.uploadProgress).toBe(0)
	})

	it('reports nothing once tracking begins but before any bytes move', () => {
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.startTracking(3)
		})

		expect(result.current.uploadProgress).toBe(0)
	})

	it('QUIRK - averages the per-file fractions rather than counting finished files', () => {
		// One finished file of four is 25%, and that is the honest reading: the remaining three have
		// moved no bytes. Counting completions instead would sit at 0% until the first file finished.
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.startTracking(4)
		})
		act(() => {
			result.current.updateFileProgress(0, 1)
		})

		expect(result.current.uploadProgress).toBe(0.25)
	})

	it('blends partial progress across several files', () => {
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.startTracking(2)
		})
		act(() => {
			result.current.updateFileProgress(0, 0.5)
		})

		expect(result.current.uploadProgress).toBe(0.25)

		act(() => {
			result.current.updateFileProgress(1, 0.25)
		})

		// (0.5 + 0.25) / 2
		expect(result.current.uploadProgress).toBe(0.375)
	})

	it('reaches completion only when every file has finished', () => {
		// Reporting 100% early is the specific failure this guards against: the reviewer would close the
		// dialog believing the attachments had landed.
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.startTracking(3)
		})
		act(() => {
			result.current.updateFileProgress(0, 1)
			result.current.updateFileProgress(1, 1)
		})

		expect(result.current.uploadProgress).toBeCloseTo(2 / 3)

		act(() => {
			result.current.updateFileProgress(2, 1)
		})

		expect(result.current.uploadProgress).toBe(1)
	})

	it('takes the latest figure for a file rather than accumulating it', () => {
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.startTracking(1)
		})
		act(() => {
			result.current.updateFileProgress(0, 0.3)
		})
		act(() => {
			result.current.updateFileProgress(0, 0.9)
		})

		// Replaced, not summed - otherwise repeated callbacks would overshoot 100%.
		expect(result.current.uploadProgress).toBe(0.9)
	})

	it('QUIRK - ignores an index outside the tracked set', () => {
		// A late callback from a SUPERSEDED upload would otherwise be averaged into the current one,
		// dragging a healthy bar backwards for no visible reason.
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.startTracking(2)
		})
		act(() => {
			result.current.updateFileProgress(0, 1)
		})

		expect(result.current.uploadProgress).toBe(0.5)

		act(() => {
			result.current.updateFileProgress(5, 1)
			result.current.updateFileProgress(-1, 1)
		})

		expect(result.current.uploadProgress).toBe(0.5)
	})

	it('QUIRK - drops updates that arrive before tracking started', () => {
		// There is no denominator yet, so averaging is undefined - and reporting anything would be a
		// figure invented from nothing.
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.updateFileProgress(0, 1)
		})

		expect(result.current.uploadProgress).toBe(0)
	})

	it('QUIRK - ignores a zero file count, leaving any live progress alone', () => {
		// An empty submission must not blank a bar that is legitimately mid-flight.
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.startTracking(2)
		})
		act(() => {
			result.current.updateFileProgress(0, 1)
		})

		expect(result.current.uploadProgress).toBe(0.5)

		act(() => {
			result.current.startTracking(0)
		})

		expect(result.current.uploadProgress).toBe(0.5)
	})

	it('ignores a negative file count too', () => {
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.startTracking(-3)
		})
		act(() => {
			result.current.updateFileProgress(0, 1)
		})

		// Nothing was tracked, so nothing can be reported.
		expect(result.current.uploadProgress).toBe(0)
	})

	it('starts a fresh upload from zero rather than from the previous one', () => {
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.startTracking(1)
		})
		act(() => {
			result.current.updateFileProgress(0, 1)
		})

		expect(result.current.uploadProgress).toBe(1)

		act(() => {
			result.current.startTracking(2)
		})

		expect(result.current.uploadProgress).toBe(0)
	})

	it('clears everything on reset, so a dismissed dialog leaves no stale bar', () => {
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.startTracking(2)
		})
		act(() => {
			result.current.updateFileProgress(0, 1)
		})

		expect(result.current.uploadProgress).toBe(0.5)

		act(() => {
			result.current.resetProgress()
		})

		expect(result.current.uploadProgress).toBe(0)
	})

	it('drops updates after a reset, because the tracked set is gone', () => {
		const { result } = renderHook(() => useMultiFileUploadProgress())

		act(() => {
			result.current.startTracking(2)
		})
		act(() => {
			result.current.resetProgress()
		})
		act(() => {
			result.current.updateFileProgress(0, 1)
		})

		expect(result.current.uploadProgress).toBe(0)
	})
})
