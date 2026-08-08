# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# See license.txt

from unittest.mock import patch

import frappe
from frappe import qb
from frappe.utils import getdate

from erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log import (
	BankStatementImportLog,
	build_table_transactions,
	detect_column_mapping,
	detect_header_row,
	extract_pdf_tables,
	get_float_amount,
	get_statement_details,
	guess_column_mapping_by_content,
	reextract_pdf_table,
	set_header_index,
	set_pdf_table_header,
	update_column_mapping,
	update_pdf_tables,
)
from erpnext.accounts.test.accounts_mixin import AccountsTestMixin
from erpnext.tests.utils import ERPNextTestSuite


class TestBankStatementImportLog(ERPNextTestSuite, AccountsTestMixin):
	def setUp(self):
		self.company = "_Test Company"
		self.customer = "_Test Customer"
		self.bank = "HDFC - _TC"
		bank_dt = qb.DocType("Bank")
		qb.from_(bank_dt).delete().where(bank_dt.name == "HDFC").run()
		self.create_bank_account()

	def create_bank_account(self):
		bank = frappe.get_doc(
			{
				"doctype": "Bank",
				"bank_name": "HDFC",
			}
		).save()

		self.bank_account = (
			frappe.get_doc(
				{
					"doctype": "Bank Account",
					"account_name": "HDFC _current_",
					"bank": bank.name,
					"is_company_account": True,
					"account": self.bank,
					"company": self.company,
				}
			)
			.insert()
			.name
		)

	def _create_bank_statement_import_log(self, test_data: list[list[str]]):
		doc = frappe.get_doc(
			{
				"doctype": "Bank Statement Import Log",
				"bank_account": self.bank_account,
			}
		)

		doc.set_file_properties(test_data)
		return doc

	def get_column_map(self, doc: BankStatementImportLog):
		column_map: dict[str, int] = {}
		for column in doc.column_mapping:
			column_map[column.maps_to] = column.index
		return column_map

	def _check_output(self, doc: BankStatementImportLog, expected_output: dict):
		fields_to_check = [
			"number_of_transactions",
			"detected_date_format",
			"detected_amount_format",
			"detected_header_index",
			"detected_transaction_starting_index",
			"detected_transaction_ending_index",
			"closing_balance",
			"total_debits",
			"total_credits",
			"total_debit_transactions",
			"total_credit_transactions",
			"start_date",
			"end_date",
		]
		for field in fields_to_check:
			self.assertEqual(getattr(doc, field), expected_output[field])

		column_map = self.get_column_map(doc)

		for field, column_index in expected_output["column_mapping"].items():
			self.assertEqual(column_map[field], column_index)

	def test_sample_statement_import_log(self):
		test_data = [
			[test_hdfc_sample_statement_data, test_hdfc_expected_output],
			[test_icici_sample_statement_data, test_icici_expected_output],
			[test_axis_sample_statement_data, test_axis_expected_output],
			[test_amount_with_currency_data, test_amount_with_currency_expected_output],
		]
		for data, expected_output in test_data:
			doc = self._create_bank_statement_import_log(data)
			self._check_output(doc, expected_output)

	def test_amount_parser(self):
		# Parse numeric strings after removing all characters except digits, decimal point, and minus sign
		self.assertEqual(get_float_amount("100.27"), 100.27)
		self.assertEqual(get_float_amount("100.20 INR"), 100.20)
		self.assertEqual(get_float_amount("1,000.20 INR"), 1000.20)
		self.assertEqual(get_float_amount("-1,000.34 INR"), -1000.34)
		self.assertEqual(get_float_amount("100.00 CR"), 100.00)
		self.assertEqual(get_float_amount("100.00 DR"), 100.00)

		# Numbers should be returned as floats
		self.assertEqual(get_float_amount(100), 100.00)

		# Random strings and characters should not throw a ValueError but return None
		self.assertIsNone(get_float_amount("ABCD"))
		self.assertIsNone(get_float_amount("****"))

	# ------------------------------------------------------------------ #
	# PDF statement import
	# ------------------------------------------------------------------ #

	@staticmethod
	def _make_pdf(html: str) -> bytes:
		import pdfkit

		return pdfkit.from_string(html, False)

	@staticmethod
	def _encrypt(pdf_bytes: bytes, password: str) -> bytes:
		import io

		from pypdf import PdfReader, PdfWriter

		reader = PdfReader(io.BytesIO(pdf_bytes))
		writer = PdfWriter()
		for page in reader.pages:
			writer.add_page(page)
		writer.encrypt(password)
		buffer = io.BytesIO()
		writer.write(buffer)
		return buffer.getvalue()

	@staticmethod
	def _auto_map(table: dict) -> dict:
		"""Mimic prepare_pdf_tables' best-effort mapping for a single extracted table."""
		header_index, score = detect_header_row(table["rows"])
		if score >= 2:
			table["header_index"] = header_index
			table["column_mapping"] = detect_column_mapping(table["rows"][header_index])
		else:
			table["header_index"] = None
			table["column_mapping"] = guess_column_mapping_by_content(table["rows"])
		table["included"] = True
		return table

	def test_pdf_multi_page_kept_separate_and_unioned(self):
		"""Tables on separate pages must NOT be merged; transactions are the union."""
		html = """
		<html><body>
		<table border="1"><tr><th>Date</th><th>Narration</th><th>Withdrawal</th><th>Deposit</th><th>Balance</th></tr>
		<tr><td>01/04/2024</td><td>UPI PAYMENT</td><td>500.00</td><td></td><td>9500.00</td></tr>
		<tr><td>03/04/2024</td><td>SALARY</td><td></td><td>20000.00</td><td>29500.00</td></tr></table>
		<div style="page-break-before: always"></div>
		<table border="1"><tr><th>Date</th><th>Narration</th><th>Withdrawal</th><th>Deposit</th><th>Balance</th></tr>
		<tr><td>05/04/2024</td><td>ATM WDL</td><td>2000.00</td><td></td><td>27500.00</td></tr></table>
		</body></html>
		"""
		tables = extract_pdf_tables(self._make_pdf(html))

		# Two separate tables, one per page
		self.assertEqual(len(tables), 2)
		self.assertEqual(sorted(t["page"] for t in tables), [1, 2])
		for table in tables:
			self.assertIn("bbox", table)
			self.assertEqual(len(table["bbox"]), 4)

		union = []
		for table in tables:
			final, _df, _af = build_table_transactions(self._auto_map(table))
			union.extend(final)

		self.assertEqual(len(union), 3)
		self.assertEqual(sorted(t["date"] for t in union), ["2024-04-01", "2024-04-03", "2024-04-05"])

	def test_pdf_junk_table_excluded(self):
		"""A non-transactions table (ad/summary) should yield zero transactions."""
		ad_table = self._auto_map({"rows": [["Open a new account!", "Call 1800-XYZ"]]})
		final, _df, _af = build_table_transactions(ad_table)
		self.assertEqual(final, [])

	def test_headerless_content_mapping(self):
		"""Without a header row, columns are guessed from their contents."""
		rows = [
			["01/04/2024", "UPI PAYMENT", "500.00"],
			["03/04/2024", "SALARY CREDIT", "20000.00"],
		]
		mapping = {
			c["maps_to"]: c["index"]
			for c in guess_column_mapping_by_content(rows)
			if c["maps_to"] != "Do not import"
		}
		self.assertEqual(mapping.get("Date"), 0)
		self.assertEqual(mapping.get("Description"), 1)
		self.assertEqual(mapping.get("Amount"), 2)

	def test_pdf_password_protected(self):
		"""Encrypted PDFs error without a password and succeed with the right one."""
		html = """
		<html><body><table border="1">
		<tr><th>Date</th><th>Narration</th><th>Amount</th></tr>
		<tr><td>01/04/2024</td><td>UPI PAYMENT</td><td>500.00</td></tr></table></body></html>
		"""
		encrypted = self._encrypt(self._make_pdf(html), "secret123")

		# No / wrong password -> recognizable error
		self.assertRaises(frappe.ValidationError, extract_pdf_tables, encrypted)
		self.assertRaises(frappe.ValidationError, extract_pdf_tables, encrypted, "wrong")

		# Correct password -> extracts
		tables = extract_pdf_tables(encrypted, "secret123")
		self.assertTrue(tables)

	def test_pdf_no_tables_detected(self):
		"""A PDF with no detectable tables raises a clear error (e.g. scanned PDFs)."""
		html = "<html><body><p>Just some prose with no tabular data at all.</p></body></html>"
		self.assertRaises(frappe.ValidationError, extract_pdf_tables, self._make_pdf(html))

	def _create_pdf_import_log(self, html: str) -> BankStatementImportLog:
		pdf_bytes = self._make_pdf(html)
		file_doc = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": f"test-statement-{frappe.generate_hash(length=8)}.pdf",
				"is_private": 1,
				"content": pdf_bytes,
			}
		).insert(ignore_permissions=True)

		doc = frappe.get_doc(
			{
				"doctype": "Bank Statement Import Log",
				"name": f"test-pdf-{frappe.generate_hash(length=8)}",
				"bank_account": self.bank_account,
				"file": file_doc.file_url,
			}
		)
		return doc.insert()

	def test_pdf_full_lifecycle(self):
		"""End-to-end doc lifecycle: insert -> rasterize -> preview -> edit -> import."""
		html = """
		<html><body>
		<table border="1"><tr><th>Date</th><th>Narration</th><th>Withdrawal</th><th>Deposit</th><th>Balance</th></tr>
		<tr><td>01/04/2024</td><td>UPI PAYMENT</td><td>500.00</td><td></td><td>9500.00</td></tr>
		<tr><td>03/04/2024</td><td>SALARY</td><td></td><td>20000.00</td><td>29500.00</td></tr></table>
		<div style="page-break-before: always"></div>
		<table border="1"><tr><th>Date</th><th>Narration</th><th>Withdrawal</th><th>Deposit</th><th>Balance</th></tr>
		<tr><td>05/04/2024</td><td>ATM WDL</td><td>2000.00</td><td></td><td>27500.00</td></tr></table>
		</body></html>
		"""
		doc = self._create_pdf_import_log(html)

		# before_insert populated the per-table JSON, page images and the union summary
		tables = doc.get_pdf_tables()
		self.assertEqual(len(tables), 2)
		for table in tables:
			self.assertTrue(table.get("page_image"))
			self.assertIn("bbox", table)
			# Page-image File must be attached to the final docname, not the client's temp id
			attached_to = frappe.db.get_value("File", {"file_url": table["page_image"]}, "attached_to_name")
			self.assertEqual(attached_to, doc.name)
		self.assertEqual(doc.number_of_transactions, 3)
		self.assertEqual(doc.total_debit_transactions, 2)
		self.assertEqual(doc.total_credit_transactions, 1)

		# get_statement_details returns the union and the per-table data for the editor
		details = get_statement_details(doc.name)
		self.assertEqual(len(details["final_transactions"]), 3)
		self.assertEqual(details["raw_data"], [])
		self.assertEqual(len(details["pdf_tables"]), 2)

		# Excluding the second table (page 2) drops its single transaction
		tables[1]["included"] = False
		update_pdf_tables(doc.name, tables)
		doc.reload()
		self.assertEqual(doc.number_of_transactions, 2)

		# Re-include and import; transactions are created for the union
		tables[1]["included"] = True
		update_pdf_tables(doc.name, tables)
		doc.reload()
		doc.insert_transactions()
		doc.reload()
		self.assertEqual(doc.status, "Completed")

		created = frappe.get_all(
			"Bank Transaction", filters={"bank_account": self.bank_account, "docstatus": 1}
		)
		self.assertEqual(len(created), 3)

	def test_pdf_reextract_table_from_bbox(self):
		"""Re-extracting a table from an adjusted bbox updates its rows and stores the bbox."""
		html = """
		<html><body>
		<table border="1"><tr><th>Date</th><th>Narration</th><th>Amount</th></tr>
		<tr><td>01/04/2024</td><td>UPI PAYMENT</td><td>500.00</td></tr>
		<tr><td>03/04/2024</td><td>SALARY</td><td>20000.00</td></tr></table>
		</body></html>
		"""
		doc = self._create_pdf_import_log(html)
		table = doc.get_pdf_tables()[0]
		bbox = table["bbox"]

		details = reextract_pdf_table(doc.name, table["page"], table["table_index"], bbox)
		updated = details["pdf_tables"][0]

		# Same region -> same rows; bbox is persisted
		self.assertTrue(updated["rows"])
		self.assertEqual(updated["bbox"], [round(float(v), 2) for v in bbox])
		self.assertEqual(updated["rows"], table["rows"])

	def test_pdf_reextract_changed_bbox_updates_rows_and_transactions(self):
		"""Shrinking a table's bbox must drop rows and update the transaction count end-to-end."""
		html = """
		<html><body>
		<table border="1"><tr><th>Date</th><th>Narration</th><th>Amount</th></tr>
		<tr><td>01/04/2024</td><td>UPI PAYMENT</td><td>500.00</td></tr>
		<tr><td>03/04/2024</td><td>SALARY</td><td>20000.00</td></tr>
		<tr><td>05/04/2024</td><td>ATM WDL</td><td>2000.00</td></tr>
		<tr><td>07/04/2024</td><td>INTEREST</td><td>12.50</td></tr></table>
		</body></html>
		"""
		doc = self._create_pdf_import_log(html)
		original = doc.get_pdf_tables()[0]
		original_rows = len(original["rows"])
		original_txns = doc.number_of_transactions

		# Shrink the box to roughly the top half (simulating a user drag).
		x0, top, x1, bottom = original["bbox"]
		shrunk = [x0, top, x1, top + (bottom - top) * 0.5]

		details = reextract_pdf_table(doc.name, original["page"], original["table_index"], shrunk)
		updated = details["pdf_tables"][0]
		doc.reload()

		self.assertLess(len(updated["rows"]), original_rows)
		self.assertLess(doc.number_of_transactions, original_txns)
		self.assertEqual(len(details["final_transactions"]), doc.number_of_transactions)

	def test_pdf_set_table_header(self):
		"""User can clear a table's header (no header row) or set a specific header row."""
		html = """
		<html><body>
		<table border="1"><tr><th>Date</th><th>Narration</th><th>Amount</th></tr>
		<tr><td>01/04/2024</td><td>UPI PAYMENT</td><td>500.00</td></tr>
		<tr><td>03/04/2024</td><td>SALARY</td><td>20000.00</td></tr></table>
		</body></html>
		"""
		doc = self._create_pdf_import_log(html)
		table = doc.get_pdf_tables()[0]
		self.assertEqual(table["header_index"], 0)
		original = {
			c["maps_to"]: c["index"] for c in table["column_mapping"] if c["maps_to"] != "Do not import"
		}

		# Clear the header (-1): header is removed but the mapping is preserved (not re-guessed).
		details = set_pdf_table_header(doc.name, table["page"], table["table_index"], -1)
		updated = details["pdf_tables"][0]
		self.assertIsNone(updated["header_index"])
		preserved = {
			c["maps_to"]: c["index"] for c in updated["column_mapping"] if c["maps_to"] != "Do not import"
		}
		self.assertEqual(preserved, original)

		# Set row 0 back as the header: it resolves meaningfully, so mapping is re-derived.
		details = set_pdf_table_header(doc.name, table["page"], table["table_index"], 0)
		updated = details["pdf_tables"][0]
		self.assertEqual(updated["header_index"], 0)
		mapped = {
			c["maps_to"]: c["index"] for c in updated["column_mapping"] if c["maps_to"] != "Do not import"
		}
		self.assertEqual(mapped.get("Date"), 0)
		self.assertEqual(mapped.get("Description"), 1)

	def test_pdf_table_edits_refuse_coordinates_that_match_no_table(self):
		"""
		Both PDF table editors located their target with a `for ... if ... break` loop and did nothing at
		all when nothing matched - answering HTTP 200 to a caller whose page or table index was stale, so
		it believed an edit had been saved. `reextract_pdf_table` was worse: it re-extracted the page
		BEFORE looking, so an out-of-range page failed inside the extractor as an IndexError HTTP 500.
		"""
		html = """
		<html><body>
		<table border="1"><tr><th>Date</th><th>Narration</th><th>Amount</th></tr>
		<tr><td>01/04/2024</td><td>UPI PAYMENT</td><td>500.00</td></tr></table>
		</body></html>
		"""
		doc = self._create_pdf_import_log(html)
		table = doc.get_pdf_tables()[0]
		before = doc.get_pdf_tables()

		self.assertRaises(
			frappe.ValidationError,
			set_pdf_table_header,
			statement_import_id=doc.name,
			page=table["page"],
			table_index=table["table_index"] + 99,
			header_index=0,
		)
		self.assertRaises(
			frappe.ValidationError,
			reextract_pdf_table,
			statement_import_id=doc.name,
			page=table["page"] + 99,
			table_index=table["table_index"],
			bbox=table["bbox"],
		)

		doc.reload()
		self.assertEqual(doc.get_pdf_tables(), before)

	def test_pdf_reextract_refuses_a_region_that_is_not_four_numbers(self):
		# The four numbers went straight to the extractor: a short list raised an IndexError and a
		# non-numeric entry a ValueError, both as HTTP 500 rather than as a rejected request.
		html = """
		<html><body>
		<table border="1"><tr><th>Date</th><th>Narration</th><th>Amount</th></tr>
		<tr><td>01/04/2024</td><td>UPI PAYMENT</td><td>500.00</td></tr></table>
		</body></html>
		"""
		doc = self._create_pdf_import_log(html)
		table = doc.get_pdf_tables()[0]

		for bbox in ([0, 0], [0, 0, 10, 10, 10], "not a box", ["a", "b", "c", "d"], [None, 0, 10, 10]):
			with self.subTest(bbox=bbox):
				self.assertRaises(
					frappe.ValidationError,
					reextract_pdf_table,
					statement_import_id=doc.name,
					page=table["page"],
					table_index=table["table_index"],
					bbox=bbox,
				)

	# ------------------------------------------------------------------ #
	# CSV/XLSX column mapping + header overrides
	# ------------------------------------------------------------------ #

	def _create_csv_import_log(self, csv_text: str) -> BankStatementImportLog:
		file_doc = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": f"test-statement-{frappe.generate_hash(length=8)}.csv",
				"is_private": 1,
				"content": csv_text,
			}
		).insert(ignore_permissions=True)

		doc = frappe.get_doc(
			{
				"doctype": "Bank Statement Import Log",
				"bank_account": self.bank_account,
				"file": file_doc.file_url,
			}
		)
		return doc.insert()

	def test_csv_update_column_mapping(self):
		"""Overriding the column mapping recomputes the transaction count."""
		csv_text = "Date,Narration,Amount\n01/04/2024,UPI PAYMENT,500.00\n03/04/2024,SALARY,20000.00\n"
		doc = self._create_csv_import_log(csv_text)
		self.assertEqual(doc.number_of_transactions, 2)

		# Drop the amount column -> no amount -> no transactions detected.
		mapping = [
			{"index": c.index, "maps_to": "Do not import" if c.maps_to == "Amount" else c.maps_to}
			for c in doc.column_mapping
		]
		details = update_column_mapping(doc.name, mapping)
		doc.reload()
		self.assertEqual(doc.number_of_transactions, 0)
		self.assertEqual(len(details["final_transactions"]), 0)

	def test_csv_set_header_index_preserves_mapping(self):
		"""Clearing the header keeps the user's mapping; it is not re-guessed."""
		csv_text = "Date,Narration,Amount\n01/04/2024,UPI PAYMENT,500.00\n03/04/2024,SALARY,20000.00\n"
		doc = self._create_csv_import_log(csv_text)
		self.assertEqual(doc.detected_header_index, 0)

		# Manually map the Narration column (1) as Reference.
		mapping = [
			{
				"index": c.index,
				"maps_to": "Reference" if c.index == 1 else c.maps_to,
				"header_text": c.header_text,
			}
			for c in doc.column_mapping
		]
		update_column_mapping(doc.name, mapping)
		doc.reload()

		# Clear the header row: the manual mapping must be preserved (column 1 stays Reference,
		# not re-guessed to Description). The label row fails date parsing, so 2 transactions remain.
		set_header_index(doc.name, -1)
		doc.reload()
		self.assertEqual(doc.detected_header_index, -1)
		self.assertEqual(doc.number_of_transactions, 2)
		current = {c.index: c.maps_to for c in doc.column_mapping}
		self.assertEqual(current.get(1), "Reference")

		# Restore row 0 as the header (resolves meaningfully -> re-derived from labels).
		set_header_index(doc.name, 0)
		doc.reload()
		self.assertEqual(doc.detected_header_index, 0)
		restored = {c.maps_to: c.index for c in doc.column_mapping if c.maps_to != "Do not import"}
		self.assertEqual(restored.get("Description"), 1)

	def test_insert_transactions_queues_rule_evaluation_last(self):
		"""
		The import/evaluator ordering, asserted end to end on a real committed-shape import.

		The rule evaluator runs in a worker on its own database connection, so it may only be queued
		once the rows it has to stamp and this log's own `Completed` status are part of the
		transaction being committed. Queueing it from the middle of the loop - as the code did
		before - starts a pass that can see neither, and the imported rows are silently left with
		`is_rule_evaluated = 0` and no matched rule.
		"""
		csv_text = "Date,Narration,Amount\n01/04/2024,UPI PAYMENT,-500.00\n03/04/2024,SALARY,20000.00\n"
		doc = self._create_csv_import_log(csv_text)
		self.assertEqual(doc.number_of_transactions, 2)
		self.assertEqual(doc.status, "Not Started")

		observed = {}

		def record_state_at_queue_time(*args, **kwargs):
			# Read straight from the database rather than from `doc`, so this observes what the
			# about-to-be-committed transaction actually holds at the moment of queueing.
			observed["status"] = frappe.db.get_value("Bank Statement Import Log", doc.name, "status")
			observed["transactions"] = frappe.db.count(
				"Bank Transaction", {"bank_account": self.bank_account, "docstatus": 1}
			)

		with patch(
			"erpnext.accounts.doctype.bank_transaction_rule.bank_transaction_rule.run_rule_evaluation",
			side_effect=record_state_at_queue_time,
		) as run_rule_evaluation:
			doc.insert_transactions()

		run_rule_evaluation.assert_called_once()
		# Both halves of the ordering: the log had already reached "Completed"...
		self.assertEqual(observed["status"], "Completed")
		# ...and every imported transaction was already submitted and visible.
		self.assertEqual(observed["transactions"], 2)

		doc.reload()
		self.assertEqual(doc.status, "Completed")

	def test_insert_transactions_is_idempotent_once_completed(self):
		# The client can retry an import whose response was lost, so a second call on a log that
		# already reached "Completed" must create nothing further and must not re-queue the evaluator.
		csv_text = "Date,Narration,Amount\n05/04/2024,ACH CREDIT,750.00\n"
		doc = self._create_csv_import_log(csv_text)

		with patch(
			"erpnext.accounts.doctype.bank_transaction_rule.bank_transaction_rule.run_rule_evaluation"
		):
			doc.insert_transactions()

		doc.reload()
		self.assertEqual(doc.status, "Completed")
		created = frappe.db.count("Bank Transaction", {"bank_account": self.bank_account, "docstatus": 1})

		with patch(
			"erpnext.accounts.doctype.bank_transaction_rule.bank_transaction_rule.run_rule_evaluation"
		) as run_rule_evaluation:
			doc.insert_transactions()

		run_rule_evaluation.assert_not_called()
		self.assertEqual(
			frappe.db.count("Bank Transaction", {"bank_account": self.bank_account, "docstatus": 1}),
			created,
		)

	# ------------------------------------------------------------------ #
	# Empty / malformed statements must fail, not "complete"
	# ------------------------------------------------------------------ #

	def test_insert_transactions_refuses_a_statement_with_no_transactions(self):
		"""
		A header-only or malformed statement parses to zero transaction rows, so the insert loop simply
		did not run: the request answered HTTP 200 and stamped the log "Completed" having created no Bank
		Transaction at all, telling the reviewer an import had succeeded when nothing had been imported.

		Every assertion below is one half of that: the refusal itself, and the state it must leave behind
		so the log is still importable once the file or the mapping is corrected.
		"""
		cases = {
			"header only": "Date,Narration,Amount\n",
			"malformed": "this,is,not,a,statement\nfoo,bar,baz\n",
			"blank rows": "\n\n\n",
		}

		for label, csv_text in cases.items():
			with self.subTest(statement=label):
				before = frappe.db.count(
					"Bank Transaction", {"bank_account": self.bank_account, "docstatus": 1}
				)
				doc = self._create_csv_import_log(csv_text)
				self.assertEqual(doc.number_of_transactions, 0)

				with patch(
					"erpnext.accounts.doctype.bank_transaction_rule.bank_transaction_rule.run_rule_evaluation"
				) as run_rule_evaluation:
					with self.assertRaises(frappe.ValidationError) as refusal:
						doc.insert_transactions()

				self.assertIn("No transactions could be read", str(refusal.exception))
				# The evaluator is queued only by a successful import.
				run_rule_evaluation.assert_not_called()

				# Not "Completed" - otherwise the importer list would badge this log green, and a retry
				# after fixing the mapping would be refused as already imported.
				doc.reload()
				self.assertEqual(doc.status, "Not Started")
				# And no transaction was created, which is what "no client-side transaction creation"
				# ultimately has to mean on the server too.
				self.assertEqual(
					frappe.db.count("Bank Transaction", {"bank_account": self.bank_account, "docstatus": 1}),
					before,
				)

	def test_a_statement_with_no_dated_rows_gets_no_date_range(self):
		# `getdate(None)` returns TODAY, so a statement in which no row carried a readable date was
		# stamped with the upload day as both its start and its end - a range the file never contained,
		# which the preview and the importer list then both displayed as fact.
		doc = self._create_csv_import_log("Date,Narration,Amount\n")

		self.assertEqual(doc.number_of_transactions, 0)
		self.assertIsNone(doc.start_date)
		self.assertIsNone(doc.end_date)

		# A statement that DOES carry dates still gets its real range - the guard must not suppress that.
		dated = self._create_csv_import_log(
			"Date,Narration,Amount\n01/04/2024,UPI PAYMENT,-500.00\n03/04/2024,SALARY,20000.00\n"
		)
		self.assertEqual(dated.start_date, getdate("2024-04-01"))
		self.assertEqual(dated.end_date, getdate("2024-04-03"))

	def test_get_data_refuses_a_file_that_parses_to_no_rows(self):
		"""
		A file that yields no rows at all has nothing to detect a header or a mapping from, and
		`detect_header_row` answers index 0 for an empty list - so `set_file_properties` indexed past the
		end of it and raised a bare IndexError HTTP 500.

		An empty XLSX workbook is used because it is the reachable form: the framework's own File
		validation refuses a genuinely zero-byte upload before any of this code runs.
		"""
		import io

		from frappe.utils.xlsxutils import read_xlsx_file_from_attached_file
		from openpyxl import Workbook

		buffer = io.BytesIO()
		Workbook().save(buffer)
		workbook = buffer.getvalue()

		# The premise of the test, asserted rather than assumed.
		self.assertEqual(read_xlsx_file_from_attached_file(fcontent=workbook), [])

		file_doc = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": f"test-empty-{frappe.generate_hash(length=8)}.xlsx",
				"is_private": 1,
				"content": workbook,
			}
		).insert(ignore_permissions=True)

		with self.assertRaises(frappe.ValidationError) as refusal:
			frappe.get_doc(
				{
					"doctype": "Bank Statement Import Log",
					"bank_account": self.bank_account,
					"file": file_doc.file_url,
				}
			).insert()

		self.assertIn("No rows could be read", str(refusal.exception))

	# ------------------------------------------------------------------ #
	# Unreadable files: a parser failure is a refusal, never a server error
	# ------------------------------------------------------------------ #

	def _import_log_for_bytes(self, file_name: str, content: bytes | str):
		"""An import log over an arbitrary attachment, inserted so `before_insert` does the parsing."""
		file_doc = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": file_name,
				"is_private": 1,
				"content": content,
			}
		).insert(ignore_permissions=True)

		return frappe.get_doc(
			{
				"doctype": "Bank Statement Import Log",
				"bank_account": self.bank_account,
				"file": file_doc.file_url,
			}
		)

	def test_import_refuses_a_file_whose_contents_do_not_match_its_extension(self):
		"""
		Every reader this module reaches is third-party code being handed a file the uploader chose, and
		each raised its own internal failure straight out to the HTTP layer: `zipfile.BadZipFile` for a
		malformed .xlsx, `OSError("File contains no valid workbook part")` for one shaped like an archive
		but not a workbook, and `pypdf.errors.PdfReadError` for a corrupt PDF. All answered HTTP 500,
		naming an exception class the reviewer can do nothing with.

		Each is now a validation error whose message says what to do about it, and - asserted here
		explicitly - names no internal exception class, module path or file path.
		"""
		import io
		import zipfile

		# A ZIP that opens as an archive but is not a workbook, which is the second failure above.
		archive_buffer = io.BytesIO()
		with zipfile.ZipFile(archive_buffer, "w") as archive:
			archive.writestr("not-a-workbook.txt", "nothing to see here")

		cases = [
			("malformed .xlsx", "broken.xlsx", b"this is definitely not a workbook"),
			("archive that is not a workbook", "archive.xlsx", archive_buffer.getvalue()),
			("malformed .xls", "broken.xls", b"not an excel 97 stream"),
		]

		for label, file_name, content in cases:
			with self.subTest(case=label):
				with self.assertRaises(frappe.ValidationError) as refusal:
					self._import_log_for_bytes(file_name, content).insert()

				message = str(refusal.exception)
				for leak in (
					"BadZipFile",
					"OSError",
					"Traceback",
					"site-packages",
					"openpyxl",
					"xlrd",
					"/apps/",
				):
					self.assertNotIn(leak, message, f"{label} disclosed {leak}")

	def test_pdf_parser_failures_are_refusals_rather_than_server_errors(self):
		"""
		The PDF half of the same finding, exercised by making the PARSER fail rather than by uploading a
		corrupt file: the framework's own File validation reads a PDF on insert and refuses a corrupt one
		before any of this module's code runs, so a real broken file cannot reach the parser through an
		upload at all. What CAN reach it is a file that opens as a PDF and then fails during extraction
		or rasterisation, which is what these two stand in for - `pypdf` and `pdfplumber` are third-party
		code and their failures used to escape as HTTP 500 naming their own exception classes.
		"""
		html = """
		<html><body>
		<table border="1"><tr><th>Date</th><th>Narration</th><th>Withdrawal</th><th>Deposit</th><th>Balance</th></tr>
		<tr><td>01/04/2024</td><td>UPI PAYMENT</td><td>500.00</td><td></td><td>9500.00</td></tr>
		<tr><td>03/04/2024</td><td>SALARY</td><td></td><td>20000.00</td><td>29500.00</td></tr></table>
		</body></html>
		"""

		from pypdf.errors import PdfReadError

		module = "erpnext.accounts.doctype.bank_statement_import_log.bank_statement_import_log"

		with patch(f"{module}.extract_pdf_tables", side_effect=PdfReadError("EOF marker not found")):
			with self.assertRaises(frappe.ValidationError) as refusal:
				self._import_log_for_bytes("extract-fails.pdf", self._make_pdf(html)).insert()
		self.assertIn("This PDF could not be read", str(refusal.exception))
		self.assertNotIn("PdfReadError", str(refusal.exception))
		self.assertNotIn("EOF marker", str(refusal.exception))

		with patch(f"{module}.render_pdf_pages", side_effect=OSError("cannot identify image file")):
			with self.assertRaises(frappe.ValidationError) as refusal:
				self._import_log_for_bytes("render-fails.pdf", self._make_pdf(html)).insert()
		self.assertIn("could not be rendered", str(refusal.exception))
		self.assertNotIn("OSError", str(refusal.exception))

		# Unpatched, the very same PDF still parses - so the two refusals above are about the failure,
		# not about the file.
		doc = self._import_log_for_bytes("works.pdf", self._make_pdf(html)).insert()
		self.assertTrue(doc.get_pdf_tables())

	def test_import_refuses_an_attachment_whose_bytes_are_gone(self):
		"""
		A File row can outlive the bytes it points at - the row is what this code resolves, and the read
		then raised `OSError("File does not exist")` as HTTP 500. The row is left in place here and only
		its content removed, which is exactly that situation.
		"""
		import os

		csv_text = "Date,Narration,Amount\n01/04/2024,UPI PAYMENT,500.00\n"
		file_doc = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": f"test-vanishing-{frappe.generate_hash(length=8)}.csv",
				"is_private": 1,
				"content": csv_text,
			}
		).insert(ignore_permissions=True)

		os.remove(file_doc.get_full_path())

		with self.assertRaises(frappe.ValidationError) as refusal:
			frappe.get_doc(
				{
					"doctype": "Bank Statement Import Log",
					"bank_account": self.bank_account,
					"file": file_doc.file_url,
				}
			).insert()

		self.assertIn("could not be read", str(refusal.exception))
		self.assertNotIn("OSError", str(refusal.exception))

	def test_import_still_accepts_a_well_formed_statement(self):
		# Every refusal above is only meaningful if an ordinary statement still parses.
		doc = self._create_csv_import_log(
			"Date,Narration,Amount\n01/04/2024,UPI PAYMENT,500.00\n03/04/2024,SALARY,20000.00\n"
		)

		self.assertEqual(doc.number_of_transactions, 2)
		self.assertEqual(doc.status, "Not Started")

	def test_import_keeps_its_own_refusals_intact(self):
		"""
		The wrapper catches broadly, so it has to be proved NOT to swallow this module's own guards.
		Every Frappe exception carries `http_status_code`, which is what the wrapper re-raises on, so
		each of these keeps its exact wording rather than being flattened into "could not be read".
		"""
		with self.assertRaises(frappe.ValidationError) as wrong_type:
			self._import_log_for_bytes("statement.txt", "Date,Narration,Amount\n").insert()
		self.assertIn("Import template should be of type", str(wrong_type.exception))

		html = "<html><body><p>Just some prose with no tabular data at all.</p></body></html>"
		with self.assertRaises(frappe.ValidationError) as no_tables:
			self._import_log_for_bytes("prose.pdf", self._make_pdf(html)).insert()
		self.assertIn("Could not detect any tables", str(no_tables.exception))

	def test_update_column_mapping_refuses_a_malformed_mapping(self):
		"""
		`column_mapping` arrived straight from the client and its shape was taken on trust, so a list
		that was not a list of objects, an object with no `index`, or one whose `index` was not a whole
		number escaped as `TypeError` or `KeyError: 'index'` - HTTP 500.
		"""
		csv_text = "Date,Narration,Amount\n01/04/2024,UPI PAYMENT,500.00\n"
		doc = self._create_csv_import_log(csv_text)
		before = [(c.index, c.maps_to) for c in doc.column_mapping]
		self.assertTrue(before)

		for label, mapping in (
			("object with no index", [{"bogus": 1}]),
			("index that is not a number", [{"index": "one"}]),
			("index that is a boolean", [{"index": True}]),
			("index that is a float", [{"index": 1.5}]),
			("a bare string instead of an object", ["Date"]),
			# Sent as a JSON STRING, which is the shape that reaches the guard: the endpoint's own
			# `list | str` annotation refuses a bare object with a clean 417 before the body runs, but a
			# string is accepted and parsed, so an object spelled as JSON arrives here as a dict.
			("an object spelled as JSON", '{"index": 0}'),
		):
			with self.subTest(case=label):
				with self.assertRaises(frappe.ValidationError) as refusal:
					update_column_mapping(doc.name, mapping)
				self.assertNotIn("KeyError", str(refusal.exception))
				self.assertNotIn("TypeError", str(refusal.exception))

		# Refused before the child table was cleared, so the existing mapping is intact.
		doc.reload()
		self.assertEqual([(c.index, c.maps_to) for c in doc.column_mapping], before)

		# And a well-formed mapping is still applied.
		mapping = [{"index": c.index, "maps_to": c.maps_to} for c in doc.column_mapping]
		update_column_mapping(doc.name, mapping)
		doc.reload()
		self.assertEqual([(c.index, c.maps_to) for c in doc.column_mapping], before)


test_hdfc_sample_statement_data = [
	["HDFC BANK Ltd.  Page No .: 1  Statement of accounts", "", "", "", "", "", ""],
	["", "", "", "", "Account Branch :SOBO", "", ""],
	["Test Company", "", "", "", "Address :Some Address", "", ""],
	["********", "", "", "", "", "", ""],
	["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
	["********", "*********", "************", "********", "*********", "**********", "**********"],
	["08/08/25", "CRAFTSMAN", "0000252193", "08/08/25", "", 10.0, 574318.9],
	["08/08/25", "ACH C- PID", "00000020", "08/08/25", "", 100.0, 573918.9],
	["09/08/25", "UPI-APPLE SERVICES-BILLDESKPG", "0000101169070023", "09/08/25", 5000.0, "", 568918.9],
	["09/08/25", "UPI-APPLE SERVICES-BILLDESKPG", "0000101174017987", "09/08/25", 10000.0, "", 558518.9],
	["10/08/25", "UPI-ENTERPRIS-9082053531", "0000109578171801", "10/08/25", 300.0, "", 558218.9],
	["11/08/25", "HDFC BANK SPL INT DIV 2025-26", "00920", "11/08/25", "", 35.0, 558253.9],
	["", "", "", "", "", "", ""],
	["********", "****************", "************", "********", "************", "*********", "*********"],
	["*********", "", "", "", "", "", ""],
	["---  End Of Statement ---", "", "", "", "", "", ""],
]
test_hdfc_expected_output = {
	"number_of_transactions": 6,
	"detected_date_format": "%d/%m/%y",
	"detected_amount_format": "Separate columns for withdrawal and deposit",
	"detected_header_index": 4,
	"detected_transaction_starting_index": 6,
	"detected_transaction_ending_index": 11,
	"closing_balance": 558253.9,
	"total_debits": 15300,
	"total_credits": 145,
	"total_debit_transactions": 3,
	"total_credit_transactions": 3,
	"start_date": getdate("2025-08-08"),
	"end_date": getdate("2025-08-11"),
	"column_mapping": {
		"Date": 0,
		"Description": 1,
		"Reference": 2,
		"Withdrawal": 4,
		"Deposit": 5,
		"Balance": 6,
	},
}

test_icici_sample_statement_data = [
	["DETAILED STATEMENT", "", "", "", "", "", "", "", ""],
	[" ", "", "", "", "", "", "", "", ""],
	[" ", "", "", "", "", "", "", "", ""],
	[" ", "", "", "", "", "", "", "", ""],
	[" ", "", "", "", "", "", "", "", ""],
	["Transactions List -Test Company", "", "", "", "", "", "", "", ""],
	[
		"No.",
		"Transaction ID",
		"Value Date",
		"Txn Posted Date",
		"ChequeNo.",
		"Description",
		"Cr/Dr",
		"Transaction Amount(INR)",
		"Available Balance(INR)",
	],
	[1.0, "S00000001", "15/04/2024", "15/04/2024 02:05:31 PM ", "-", "Mob alrt", "DR", 29.5, 261454.89],
	[2.0, "S00000002", "19/04/2024", "19/04/2024 04:08:02 PM ", "-", "GIB/0020", "DR", 12600.0, 248854.89],
	[3.0, "S00000003", "10/05/2024", "10/05/2024 03:32:02 PM ", "-", "Test Co", "CR", 3000000.0, 3248854.89],
	[4.0, "S00000004", "10/05/2024", "10/05/2024 03:40:50 PM ", "-", "TRF TO", "DR", 3000000.0, 248854.89],
	[5.0, "S00000005", "20/05/2024", "20/05/2024 03:52:17 PM ", "-", "BIL/MAKE", "DR", 68811.0, 180043.89],
	[6.0, "S00000006", "20/05/2024", "20/05/2024 03:55:27 PM ", "-", "BIL/MAKE", "DR", 40126.0, 139917.89],
	[7.0, "S00000007", "31/05/2024", "31/05/2024 03:42:34 PM ", "-", "NEFT-FRAPPE", "CR", 32400.0, 172317.89],
	[8.0, "S00000008", "24/06/2024", "24/06/2024 04:09:25 PM ", "-", "GIB/STAX", "DR", 2500.0, 169817.89],
	[
		9.0,
		"S00000009",
		"24/06/2024",
		"24/06/2024 04:15:37 PM ",
		"-",
		"BIL/ONL/00085",
		"DR",
		2150.0,
		167667.89,
	],
	[
		10.0,
		"S00000010",
		"05/07/2024",
		"05/07/2024 05:50:10 PM ",
		"-",
		"NEFT-N18724",
		"CR",
		75600.0,
		243267.89,
	],
	[11.0, "S00000011", "30/07/2024", "30/07/2024 12:18:01 PM ", "-", "Mob al", "DR", 29.5, 243238.39],
	[12.0, "S00000012", "01/08/2024", "01/08/2024 12:45:49 PM ", "-", "NEFT-N214", "CR", 117720.0, 360958.39],
]
test_icici_expected_output = {
	"number_of_transactions": 12,
	"detected_date_format": "%d/%m/%Y",
	"detected_amount_format": 'Transaction type column has "CR"/"DR" values',
	"detected_header_index": 6,
	"detected_transaction_starting_index": 7,
	"detected_transaction_ending_index": 18,
	"closing_balance": 360958.39,
	"total_debits": 3126246.0,
	"total_credits": 3225720.0,
	"total_debit_transactions": 8,
	"total_credit_transactions": 4,
	"start_date": getdate("2024-04-15"),
	"end_date": getdate("2024-08-01"),
	"column_mapping": {
		"Date": 2,
		"Description": 5,
		"Reference": 1,
		"Debit/Credit": 6,
		"Amount": 7,
		"Balance": 8,
	},
}

test_axis_sample_statement_data = [
	["Name :- XXXXXXXX", None, None, None, None, None, None, None, None, None, None],
	["Joint Holder :-- ", None, None, None, None, None, None, None, None, None, None],
	[None, None, None, None, None, None, None, None, None, None, None],
	[None, None, None, None, None, None, None, None, None, None, None],
	[
		"Statement",
		None,
		None,
		None,
		None,
		None,
		None,
		None,
		None,
		None,
		None,
	],
	[None, None, None, None, None, None, None, None, None, None, None],
	[
		"S.NO",
		"Transaction Date (dd/mm/yyyy)",
		"Value Date (dd/mm/yyyy)",
		"Particulars",
		"Amount(INR)",
		"Debit/Credit",
		"Balance(INR)",
		"Cheque Number",
		"Branch Name(SOL)",
		None,
		None,
	],
	["1", "", "", "OPENING BAL", "", "", "3,25,867.05", "", "NAG MH", None, None],
	["2", "05/04/2026", "05/04/2026", "NEFT", "59,000.00", "CR", "3,84,867.05", "", "NAG", None, None],
	[
		"3",
		"05/04/2026",
		"05/04/2026",
		"XXXInt.Coll",
		"1,13,969.00",
		"DR",
		"2,70,898.05",
		"",
		"NAG",
		None,
		None,
	],
	["4", "", "", "TOTAL DR/CR", "1,13,969.00/59,000.00", "", "", "", "NAG", None, None],
	["5", "", "", "CLOSING BAL", "", "", "2,70,898.05", "", "NAG", None, None],
]
test_axis_expected_output = {
	"number_of_transactions": 2,
	"detected_date_format": "%d/%m/%Y",
	"detected_amount_format": 'Transaction type column has "CR"/"DR" values',
	"detected_header_index": 6,
	"detected_transaction_starting_index": 8,
	"detected_transaction_ending_index": 9,
	"closing_balance": 270898.05,
	"total_debits": 113969.00,
	"total_credits": 59000.00,
	"total_debit_transactions": 1,
	"total_credit_transactions": 1,
	"start_date": getdate("2026-04-05"),
	"end_date": getdate("2026-04-05"),
	"column_mapping": {
		"Date": 1,
		"Description": 3,
		"Reference": 7,
		"Debit/Credit": 5,
		"Amount": 4,
		"Balance": 6,
	},
}

test_amount_with_currency_data = [
	["Statement"],
	["Opening Balance:  INR 1,11,71,360.24"],
	[
		"S. No.",
		"Transaction Date",
		"Transaction ID",
		"Transaction Serial Number",
		"Cheque Number",
		"Transaction Particulars",
		"Remarks",
		"Debit Amount",
		"Credit Amount",
	],
	[2, "01/04/2026", "S68420508", "1", "", "INB/NEFT/AXODH091982", "GP2026", "INR 25,236.00", ""],
	[3, "01/04/2026", "S68517082", "1", "", "INB/RTGS/UTIBR620", "GP202", "INR 5,52,386.00", ""],
	[4, "01/04/2026", "S68543043", "1", "", "INB/RTGS/UTIBR62", "7072L", "INR 3,55,791.00", ""],
	[None, None, None, None, None, None, None, None, None],
	["Closing Balance: INR -5,89,376.74", None, None, None, None, None, None, None, None],
]
test_amount_with_currency_expected_output = {
	"number_of_transactions": 3,
	"detected_date_format": "%d/%m/%Y",
	"detected_amount_format": "Separate columns for withdrawal and deposit",
	"detected_header_index": 2,
	"detected_transaction_starting_index": 3,
	"detected_transaction_ending_index": 5,
	"closing_balance": None,
	"total_debits": 933413.00,
	"total_credits": 0,
	"total_debit_transactions": 3,
	"total_credit_transactions": 0,
	"start_date": getdate("2026-04-01"),
	"end_date": getdate("2026-04-01"),
	"column_mapping": {
		"Date": 1,
		"Description": 5,
		"Reference": 2,
		"Withdrawal": 7,
		"Deposit": 8,
	},
}
