/**
 * Behavioural specification for the two membership helpers.
 *
 * These are small, but `in_list` sits on permission and doctype-filter paths where the wrong answer is not
 * a cosmetic bug: returning `true` for an absent value would widen what a reviewer is offered.
 *
 * Two behaviours are surprising on first reading, and each is pinned below under a QUIRK label:
 *
 *   1. `in_list` answers `false` for `undefined` rather than throwing or coercing, so an optional field
 *      that was never set fails CLOSED.
 *   2. `isEmpty` counts OWN ENUMERABLE keys, so an object carrying only inherited or symbol-keyed
 *      properties still reads as empty.
 */

import { describe, expect, it } from 'vitest'

import { in_list, isEmpty } from './checks'

describe('in_list', () => {

	it('finds a value that is present', () => {
		expect(in_list(['Payment Entry', 'Journal Entry'], 'Journal Entry')).toBe(true)
	})

	it('rejects a value that is absent', () => {
		expect(in_list(['Payment Entry', 'Journal Entry'], 'Sales Invoice')).toBe(false)
	})

	it('QUIRK - answers false for an unset value rather than throwing', () => {
		// Callers pass optional document fields straight in. Failing CLOSED is the safe direction: a
		// missing value must never be treated as a match, because these lists gate what a reviewer is
		// allowed to see and act on.
		expect(in_list(['Payment Entry'], undefined)).toBe(false)
	})

	it('rejects everything when the list is empty', () => {
		expect(in_list([], 'Payment Entry')).toBe(false)
	})

	it('matches exactly, including case', () => {
		// Doctype names are canonical, so a case-insensitive match would accept an identifier the
		// server would then reject.
		expect(in_list(['Payment Entry'], 'payment entry')).toBe(false)
	})

	it('does not match on a partial value', () => {
		expect(in_list(['Payment Entry'], 'Payment')).toBe(false)
	})

	it('treats the empty string as a value like any other', () => {
		expect(in_list([''], '')).toBe(true)
		expect(in_list(['Payment Entry'], '')).toBe(false)
	})
})

describe('isEmpty', () => {

	it('calls an object with no properties empty', () => {
		expect(isEmpty({})).toBe(true)
	})

	it('calls an object with a property non-empty', () => {
		expect(isEmpty({ party: 'ACME Traders' })).toBe(false)
	})

	it('counts a property holding undefined, because the KEY exists', () => {
		// The distinction matters where callers build a filter object and then check whether they
		// actually added anything to it.
		expect(isEmpty({ party: undefined })).toBe(false)
	})

	it('calls an empty array empty', () => {
		expect(isEmpty([])).toBe(true)
	})

	it('calls a populated array non-empty', () => {
		expect(isEmpty(['Payment Entry'])).toBe(false)
	})

	it('QUIRK - ignores inherited properties', () => {
		// Only OWN enumerable keys count, so an object created from a prototype that carries defaults
		// still reads as empty - which is what makes it safe to use on plain filter literals only.
		const withPrototype = Object.create({ inherited: 'value' })

		expect(isEmpty(withPrototype)).toBe(true)
	})

	it('QUIRK - ignores symbol-keyed properties', () => {
		expect(isEmpty({ [Symbol('tag')]: 'value' })).toBe(true)
	})
})
