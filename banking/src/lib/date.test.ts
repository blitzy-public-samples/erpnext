/**
 * Behavioural specification for `src/lib/date.ts` - the module that resolves the reconciliation date
 * range and renders every date the workbench and the statement importer display.
 *
 * The date range is not cosmetic here: it is interpolated into the SWR cache keys and passed to
 * `get_bank_transactions`, so the boundaries this module computes decide which transactions a reviewer
 * is shown at all. A range that is off by a day hides real work.
 *
 * Four behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. `getUserDateFormat` reads `boot.user.defaults.date_format` WITHOUT optional chaining on the
 *      final property, so an absent value is a `TypeError` rather than a fallback to the site default.
 *   2. `'Date Range'` - the period a reviewer selects to type their own dates - resolves to THIS MONTH
 *      and is labelled "This Month", because the caller replaces the boundaries afterwards.
 *   3. Every period carries its own display `format`, so the same range renders differently depending on
 *      which period produced it.
 *   4. `AVAILABLE_TIME_PERIODS` deliberately OMITS `'Date Range'` even though the type admits it, so the
 *      picker cannot offer it as an ordinary choice.
 *
 * Every range test supplies an explicit `baseDate`, so no assertion depends on the day the suite runs.
 * The two functions that genuinely read the clock are covered separately and asserted on shape rather
 * than on a fixed instant.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	AVAILABLE_TIME_PERIODS,
	formatDate,
	getDatesForTimePeriod,
	getTimeago,
	getUserDateFormat,
	toDate,
	today
} from '@/lib/date'
import type { TimePeriod } from '@/lib/date'

/** A Wednesday in the middle of a month, quarter and year, so no boundary is ambiguous. */
const BASE_DATE = '2026-08-05'

const bootUser = (): Record<string, unknown> =>
	(globalThis as unknown as { frappe: { boot: { user: { defaults: Record<string, unknown> } } } })
		.frappe.boot.user.defaults

const sysdefaults = (): Record<string, unknown> =>
	(globalThis as unknown as { frappe: { boot: { sysdefaults: Record<string, unknown> } } })
		.frappe.boot.sysdefaults

describe('getUserDateFormat', () => {

	it("upper-cases the signed-in user's own format, which is how the site stores it", () => {
		// Frappe persists `dd-mm-yyyy`; dayjs needs `DD-MM-YYYY`.
		expect(getUserDateFormat()).toBe('DD-MM-YYYY')
	})

	describe('when the user has set a different format from the site', () => {
		let displaced: unknown

		beforeEach(() => {
			displaced = bootUser().date_format
			bootUser().date_format = 'mm/dd/yyyy'
		})

		afterEach(() => {
			bootUser().date_format = displaced
		})

		it("prefers the user's over the site's", () => {
			expect(getUserDateFormat()).toBe('MM/DD/YYYY')
		})
	})

	describe('QUIRK - when the user profile carries no format at all', () => {
		let displacedUser: unknown

		beforeEach(() => {
			displacedUser = bootUser().date_format
			delete bootUser().date_format
		})

		afterEach(() => {
			bootUser().date_format = displacedUser
		})

		it('throws rather than falling back to the site default', () => {
			// The fallback is written `user?.defaults?.date_format.toUpperCase() || sysdefaults...`, and
			// the final property access is unguarded - so the `||` is never reached. Pinned because the
			// site default IS present here, making this a fallback that cannot fire.
			expect(sysdefaults().date_format).toBe('dd-mm-yyyy')
			expect(() => getUserDateFormat()).toThrow(TypeError)
		})
	})
})

describe('AVAILABLE_TIME_PERIODS', () => {

	it('offers the eight fixed periods, opening on This Month', () => {
		expect(AVAILABLE_TIME_PERIODS).toEqual([
			'This Month',
			'This Week',
			'This Quarter',
			'This Year',
			'Last Week',
			'Last Month',
			'Last Quarter',
			'Last Year'
		])
	})

	it('QUIRK - omits Date Range, which the type nonetheless admits', () => {
		// A reviewer reaches a custom range by editing the boundaries, not by picking the period, so
		// offering it in the list would be a dead choice.
		expect(AVAILABLE_TIME_PERIODS).not.toContain('Date Range')
	})

	it('resolves every offered period to a usable range', () => {
		// Guards against a period being listed that the resolver has no branch for, which would silently
		// produce the empty fallback range and show the reviewer nothing.
		for (const period of AVAILABLE_TIME_PERIODS) {
			const range = getDatesForTimePeriod(period, undefined, BASE_DATE)

			expect(range.fromDate, period).not.toBe('')
			expect(range.toDate, period).not.toBe('')
			expect(new Date(range.fromDate) <= new Date(range.toDate), period).toBe(true)
		}
	})
})

describe('getDatesForTimePeriod', () => {

	it('bounds This Month by the calendar month of the base date', () => {
		expect(getDatesForTimePeriod('This Month', undefined, BASE_DATE)).toMatchObject({
			fromDate: '2026-08-01',
			toDate: '2026-08-31',
			translatedLabel: 'This Month'
		})
	})

	it('bounds This Week Sunday to Saturday, which is what dayjs treats as a week', () => {
		expect(getDatesForTimePeriod('This Week', undefined, BASE_DATE)).toMatchObject({
			fromDate: '2026-08-02',
			toDate: '2026-08-08',
			translatedLabel: 'This Week'
		})
	})

	it('bounds This Quarter by the containing calendar quarter', () => {
		expect(getDatesForTimePeriod('This Quarter', undefined, BASE_DATE)).toMatchObject({
			fromDate: '2026-07-01',
			toDate: '2026-09-30',
			translatedLabel: 'This Quarter'
		})
	})

	it('bounds This Year by the calendar year', () => {
		expect(getDatesForTimePeriod('This Year', undefined, BASE_DATE)).toMatchObject({
			fromDate: '2026-01-01',
			toDate: '2026-12-31',
			translatedLabel: 'This Year'
		})
	})

	it('bounds each trailing period by the whole PREVIOUS period, never by a rolling window', () => {
		// A reviewer closing a period needs its exact boundaries, so "Last Month" must be the whole of
		// July rather than the last thirty days.
		expect(getDatesForTimePeriod('Last Week', undefined, BASE_DATE)).toMatchObject({
			fromDate: '2026-07-26',
			toDate: '2026-08-01'
		})
		expect(getDatesForTimePeriod('Last Month', undefined, BASE_DATE)).toMatchObject({
			fromDate: '2026-07-01',
			toDate: '2026-07-31'
		})
		expect(getDatesForTimePeriod('Last Quarter', undefined, BASE_DATE)).toMatchObject({
			fromDate: '2026-04-01',
			toDate: '2026-06-30'
		})
		expect(getDatesForTimePeriod('Last Year', undefined, BASE_DATE)).toMatchObject({
			fromDate: '2025-01-01',
			toDate: '2025-12-31'
		})
	})

	it('carries a coarser display format for the periods measured in months', () => {
		// QUIRK 3: the range and the way it is rendered travel together, so a quarter reads "Jul 2026"
		// while a week reads "2nd Aug '26".
		expect(getDatesForTimePeriod('This Week', undefined, BASE_DATE).format).toBe("Do MMM 'YY")
		expect(getDatesForTimePeriod('This Month', undefined, BASE_DATE).format).toBe("Do MMM 'YY")
		expect(getDatesForTimePeriod('Last Week', undefined, BASE_DATE).format).toBe("Do MMM 'YY")
		expect(getDatesForTimePeriod('Last Month', undefined, BASE_DATE).format).toBe("Do MMM 'YY")
		expect(getDatesForTimePeriod('This Quarter', undefined, BASE_DATE).format).toBe('MMM YYYY')
		expect(getDatesForTimePeriod('This Year', undefined, BASE_DATE).format).toBe('MMM YYYY')
		expect(getDatesForTimePeriod('Last Quarter', undefined, BASE_DATE).format).toBe('MMM YYYY')
		expect(getDatesForTimePeriod('Last Year', undefined, BASE_DATE).format).toBe('MMM YYYY')
	})

	it('QUIRK - resolves Date Range to This Month, label included', () => {
		// The caller overwrites the boundaries with the reviewer's own, so this branch only has to supply
		// something valid to start from - and it shares the This Month branch outright.
		const custom = getDatesForTimePeriod('Date Range', undefined, BASE_DATE)

		expect(custom).toMatchObject({
			fromDate: '2026-08-01',
			toDate: '2026-08-31',
			translatedLabel: 'This Month'
		})
		expect(custom).toEqual(getDatesForTimePeriod('This Month', undefined, BASE_DATE))
	})

	it('returns an empty range, labelled Date Range, for a period it does not recognise', () => {
		// Reachable from persisted state: the selected period is stored in localStorage, so a value
		// written by an older build arrives here.
		expect(getDatesForTimePeriod('Since Inception' as TimePeriod, undefined, BASE_DATE)).toEqual({
			fromDate: '',
			toDate: '',
			format: 'Do MMM YY',
			translatedLabel: 'Date Range'
		})
	})

	it('emits the boundaries in a requested format instead of the wire format', () => {
		expect(getDatesForTimePeriod('This Month', 'DD/MM/YYYY', BASE_DATE)).toMatchObject({
			fromDate: '01/08/2026',
			toDate: '31/08/2026'
		})
	})

	it('falls back to today when no base date is supplied', () => {
		// The workbench calls it this way on first paint. Asserted on shape and on the invariant rather
		// than on an instant, so it cannot rot.
		const range = getDatesForTimePeriod('This Month')

		expect(range.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(range.toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(range.fromDate.endsWith('-01')).toBe(true)
		expect(new Date(range.fromDate) <= new Date(range.toDate)).toBe(true)
	})

	it('crosses a year boundary correctly for the trailing periods', () => {
		// January is where an off-by-one in the subtraction would show up.
		expect(getDatesForTimePeriod('Last Month', undefined, '2026-01-15')).toMatchObject({
			fromDate: '2025-12-01',
			toDate: '2025-12-31'
		})
		expect(getDatesForTimePeriod('Last Quarter', undefined, '2026-01-15')).toMatchObject({
			fromDate: '2025-10-01',
			toDate: '2025-12-31'
		})
	})
})

describe('formatDate', () => {

	it("renders a date in the user's own format when none is given", () => {
		expect(formatDate('2026-08-05')).toBe('05-08-2026')
	})

	it('renders in an explicitly requested format', () => {
		expect(formatDate('2026-08-05', 'YYYY-MM-DD')).toBe('2026-08-05')
		expect(formatDate('2026-08-05', "Do MMM 'YY")).toBe("5th Aug '26")
	})

	it('accepts a Date as readily as a string', () => {
		expect(formatDate(new Date(2026, 7, 5), 'YYYY-MM-DD')).toBe('2026-08-05')
	})

	it('renders an absent date as the empty string rather than as "Invalid Date"', () => {
		// Every nullable date column on the workbench relies on this, so a missing clearance date leaves
		// a blank cell instead of printing an error into the table.
		expect(formatDate(undefined)).toBe('')
		expect(formatDate('')).toBe('')
	})
})

describe('toDate', () => {

	it('parses a wire-format date into a Date', () => {
		const parsed = toDate('2026-08-05')

		expect(parsed).toBeInstanceOf(Date)
		expect(parsed.getFullYear()).toBe(2026)
		expect(parsed.getMonth()).toBe(7)
		expect(parsed.getDate()).toBe(5)
	})

	it('parses under an explicitly supplied format', () => {
		const parsed = toDate('05-08-2026', 'DD-MM-YYYY')

		expect(parsed.getFullYear()).toBe(2026)
		expect(parsed.getMonth()).toBe(7)
		expect(parsed.getDate()).toBe(5)
	})

	it('round-trips with formatDate', () => {
		expect(formatDate(toDate('2026-08-05'), 'YYYY-MM-DD')).toBe('2026-08-05')
	})
})

describe('today', () => {

	it('answers in the wire format the endpoints expect', () => {
		expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
	})
})

describe('getTimeago', () => {

	it('describes a past instant in relative words', () => {
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 19)
			.replace('T', ' ')

		expect(getTimeago(twoHoursAgo)).toMatch(/ago$/)
	})

	it('describes an absent instant as the empty string', () => {
		expect(getTimeago()).toBe('')
		expect(getTimeago('')).toBe('')
	})

	describe('when the site declares no timezones', () => {
		let displaced: unknown

		beforeEach(() => {
			const boot = (globalThis as unknown as { frappe: { boot: Record<string, unknown> } }).frappe.boot
			displaced = boot.time_zone
			delete boot.time_zone
		})

		afterEach(() => {
			;(globalThis as unknown as { frappe: { boot: Record<string, unknown> } }).frappe.boot.time_zone =
				displaced
		})

		it('still answers, reading the timestamp as a local one', () => {
			// Both timezones must be present for the conversion branch to run, so this exercises the
			// fallback that keeps the action log rendering on a site that has not set them.
			const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
				.toISOString()
				.slice(0, 19)
				.replace('T', ' ')

			expect(getTimeago(twoHoursAgo)).toMatch(/ago$/)
		})
	})
})
