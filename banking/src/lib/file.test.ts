/**
 * Behavioural specification for `src/lib/file.ts` - the helpers the statement importer uses to describe
 * an uploaded bank statement before anything is sent to the server.
 *
 * The importer accepts CSV, XLSX, XLS and PDF, and it decides which parsing surface to show from the
 * extension alone, so `getFileExtension` sits directly in front of that choice. `formatBytes` renders
 * the size the reviewer reads back to confirm the right file was attached.
 *
 * Three behaviours are surprising on first reading and each is pinned below under a QUIRK label:
 *   1. `getFileExtension` strips a query string first, so a file named from a URL still resolves - and a
 *      name with no dot at all returns the WHOLE name rather than an empty string.
 *   2. `formatBytes` special-cases zero, because `Math.log(0)` is `-Infinity` and would otherwise index
 *      the unit table out of bounds.
 *   3. `getFileType` maps only the extensions the importer and the attachment views can render, and
 *      every other extension - including a genuine spreadsheet variant like `ods` - collapses to the
 *      generic `'file'`.
 */

import { describe, expect, it } from 'vitest'

import {
	audioExt,
	excelExt,
	formatBytes,
	getFileExtension,
	getFileType,
	imageExt,
	pptExt,
	videoExt,
	wordExt
} from '@/lib/file'

describe('getFileExtension', () => {

	it('reads the extension off a plain filename, lower-cased', () => {
		// The importer compares against lower-case literals, so an upper-case name from a bank's export
		// must not defeat the match.
		expect(getFileExtension('statement.csv')).toBe('csv')
		expect(getFileExtension('STATEMENT.CSV')).toBe('csv')
		expect(getFileExtension('Statement.XlsX')).toBe('xlsx')
	})

	it('reads the LAST extension when the name carries several dots', () => {
		expect(getFileExtension('bank.statement.aug.2026.pdf')).toBe('pdf')
	})

	it('QUIRK - discards a query string before looking for the extension', () => {
		// Frappe file URLs carry a cache-busting query, and the attachment views pass the URL straight in.
		expect(getFileExtension('/files/statement.csv?v=1785894728915')).toBe('csv')
		expect(getFileExtension('statement.pdf?download=1&foo=bar')).toBe('pdf')
	})

	it('QUIRK - returns the whole name when there is no extension to find', () => {
		// `split('.').pop()` on a dotless string yields the string itself, so the caller receives
		// something that looks like an extension but is not one.
		expect(getFileExtension('statement')).toBe('statement')
		expect(getFileExtension('')).toBe('')
	})

	it('returns the empty string for a name that ends in a dot', () => {
		expect(getFileExtension('statement.')).toBe('')
	})

	it('survives an absent name, because the dropzone can report one', () => {
		expect(getFileExtension(undefined as unknown as string)).toBe('')
	})
})

describe('formatBytes', () => {

	it('QUIRK - names zero explicitly rather than computing it', () => {
		// `Math.log(0)` is `-Infinity`, which would index the unit table out of bounds, so zero is
		// answered before the arithmetic. An empty upload is a real case: the dropzone reported one.
		expect(formatBytes(0)).toBe('0 Bytes')
	})

	it('reports a small file in bytes', () => {
		expect(formatBytes(65)).toBe('65 Bytes')
		expect(formatBytes(1023)).toBe('1023 Bytes')
	})

	it('steps up a unit at each power of 1024, not of 1000', () => {
		expect(formatBytes(1024)).toBe('1 KB')
		expect(formatBytes(1024 * 1024)).toBe('1 MB')
		expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB')
		expect(formatBytes(1024 ** 4)).toBe('1 TB')
	})

	it('rounds to two decimals by default, and drops trailing zeros', () => {
		// `parseFloat` is applied after `toFixed`, so a whole number reads "1 KB" rather than "1.00 KB".
		expect(formatBytes(1536)).toBe('1.5 KB')
		expect(formatBytes(1234567)).toBe('1.18 MB')
	})

	it('honours a requested number of decimals', () => {
		expect(formatBytes(1234567, 0)).toBe('1 MB')
		expect(formatBytes(1234567, 3)).toBe('1.177 MB')
	})
})

describe('getFileType', () => {

	it('names the four types the statement importer can actually parse', () => {
		// These are the extensions the dropzone accepts, so each must resolve to a real type rather than
		// to the generic fallback.
		expect(getFileType('pdf')).toBe('pdf')
		expect(getFileType('csv')).toBe('file')
		expect(getFileType('xls')).toBe('excel')
		expect(getFileType('xlsx')).toBe('excel')
	})

	it('maps every tabulated extension onto its family', () => {
		const expected: Record<string, string> = {
			doc: 'word', docx: 'word',
			xls: 'excel', xlsx: 'excel',
			ppt: 'powerpoint', pptx: 'powerpoint',
			mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio',
			mp4: 'video', mkv: 'video', webm: 'video', avi: 'video', mov: 'video',
			jpeg: 'image', jpg: 'image', png: 'image',
			pdf: 'pdf'
		}

		for (const [extension, family] of Object.entries(expected)) {
			expect(getFileType(extension), extension).toBe(family)
		}
	})

	it('QUIRK - collapses anything untabulated to the generic type', () => {
		// `ods` is a genuine spreadsheet and `csv` a genuine one too, yet neither is tabulated - so the
		// icon a reviewer sees for them is the plain file icon.
		expect(getFileType('ods')).toBe('file')
		expect(getFileType('csv')).toBe('file')
		expect(getFileType('txt')).toBe('file')
		expect(getFileType('')).toBe('file')
	})

	it('is case-SENSITIVE, which is why callers lower-case first', () => {
		// `getFileExtension` already lower-cases, so the pairing is safe - but the mapping alone is not.
		expect(getFileType('PDF')).toBe('file')
		expect(getFileType(getFileExtension('STATEMENT.PDF'))).toBe('pdf')
	})
})

describe('the exported extension groups', () => {

	it('lists the extensions each family covers', () => {
		expect(imageExt).toEqual(['jpeg', 'jpg', 'png'])
		expect(excelExt).toEqual(['csv', 'xls', 'xlsx'])
		expect(pptExt).toEqual(['ppt', 'pptx'])
		expect(wordExt).toEqual(['doc', 'docx'])
		expect(videoExt).toEqual(['mp4', 'mkv', 'webm', 'avi', 'mov'])
		expect(audioExt).toEqual(['mp3', 'wav', 'ogg', 'flac'])
	})

	it('QUIRK - groups csv with the spreadsheets even though getFileType does not', () => {
		// The two are consulted for different purposes - the group for accepting an upload, the mapping
		// for choosing an icon - and they disagree about csv. Pinned so the disagreement is deliberate.
		expect(excelExt).toContain('csv')
		expect(getFileType('csv')).not.toBe('excel')
	})
})
