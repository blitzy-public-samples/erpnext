# Copyright (c) 2020, Frappe Technologies Pvt. Ltd. and Contributors
# See license.txt


import json
from unittest.mock import patch

import frappe
from frappe import qb
from frappe.utils import add_days, today

from erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool import (
	MAX_LINKED_PAYMENTS,
	auto_reconcile_vouchers,
	get_account_balance,
	get_allowed_voucher_doctypes,
	get_auto_reconcile_message,
	get_bank_transactions,
	get_linked_payments,
	get_older_unreconciled_transactions,
	normalize_document_types,
	reconcile_vouchers,
	validate_vouchers_for_reconciliation,
)
from erpnext.accounts.doctype.payment_entry.test_payment_entry import create_payment_entry
from erpnext.accounts.test.accounts_mixin import AccountsTestMixin
from erpnext.tests.utils import ERPNextTestSuite

MODULE = "erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool"


class TestBankReconciliationTool(ERPNextTestSuite, AccountsTestMixin):
	def setUp(self):
		self.company = "_Test Company"
		self.customer = "_Test Customer"
		self.bank = "HDFC - _TC"
		self.debit_to = "Debtors - _TC"
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
					"account": self.bank,  # account from Chart of Accounts
					"company": self.company,
				}
			)
			.insert()
			.name
		)

	def test_auto_reconcile(self):
		# make payment
		from_date = add_days(today(), -1)
		to_date = today()
		payment = create_payment_entry(
			company=self.company,
			posting_date=from_date,
			payment_type="Receive",
			party_type="Customer",
			party=self.customer,
			paid_from=self.debit_to,
			paid_to=self.bank,
			paid_amount=100,
		).save()
		payment.reference_no = "123"
		payment = payment.save().submit()

		# make bank transaction
		bank_transaction = (
			frappe.get_doc(
				{
					"doctype": "Bank Transaction",
					"date": to_date,
					"deposit": 100,
					"bank_account": self.bank_account,
					"reference_number": "123",
					"currency": "INR",
				}
			)
			.save()
			.submit()
		)

		# assert API output pre reconciliation
		transactions = get_bank_transactions(self.bank_account, from_date, to_date)
		self.assertEqual(len(transactions), 1)
		self.assertEqual(transactions[0].name, bank_transaction.name)

		# auto reconcile
		auto_reconcile_vouchers(
			bank_account=self.bank_account,
			from_date=from_date,
			to_date=to_date,
			filter_by_reference_date=False,
		)

		# assert API output post reconciliation
		transactions = get_bank_transactions(self.bank_account, from_date, to_date)
		self.assertEqual(len(transactions), 0)

	def make_bank_transaction(self, date, deposit=100):
		return (
			frappe.get_doc(
				{
					"doctype": "Bank Transaction",
					"date": date,
					"deposit": deposit,
					"bank_account": self.bank_account,
					"currency": "INR",
				}
			)
			.save()
			.submit()
		)

	def test_get_bank_transactions_excludes_dates_after_to_date(self):
		self.make_bank_transaction(date=today())
		names = [t.name for t in get_bank_transactions(self.bank_account, to_date=add_days(today(), -1))]
		self.assertEqual(names, [])

	def test_auto_reconcile_message_for_no_matches(self):
		message, indicator = get_auto_reconcile_message([], [])
		self.assertEqual(indicator, "blue")
		self.assertIn("No matches", message)

	def test_auto_reconcile_message_counts_and_pluralizes(self):
		# reconciled count is reported and the indicator turns green
		message, indicator = get_auto_reconcile_message([], ["t1", "t2"])
		self.assertEqual(indicator, "green")
		self.assertIn("2 Transaction(s) Reconciled", message)

		# partially-reconciled label is singular for one, plural for many
		singular, _ = get_auto_reconcile_message(["p1"], [])
		self.assertIn("1 Transaction Partially Reconciled", singular)
		plural, _ = get_auto_reconcile_message(["p1", "p2"], [])
		self.assertIn("2 Transactions Partially Reconciled", plural)

	# ------------------------------------------------------------------ #
	# Posting: locking, authority ordering and voucher validation
	# ------------------------------------------------------------------ #

	def _matched_pair(self, amount=100, reference="ref-lock"):
		"""A submitted Payment Entry and a submitted Bank Transaction that it can settle."""
		payment = create_payment_entry(
			company=self.company,
			posting_date=add_days(today(), -1),
			payment_type="Receive",
			party_type="Customer",
			party=self.customer,
			paid_from=self.debit_to,
			paid_to=self.bank,
			paid_amount=amount,
		).save()
		payment.reference_no = reference
		payment = payment.save().submit()

		transaction = (
			frappe.get_doc(
				{
					"doctype": "Bank Transaction",
					"date": today(),
					"deposit": amount,
					"bank_account": self.bank_account,
					"reference_number": reference,
					"currency": "INR",
				}
			)
			.save()
			.submit()
		)
		return payment, transaction

	@staticmethod
	def _voucher_payload(payment, amount=100):
		return json.dumps(
			[{"payment_doctype": "Payment Entry", "payment_name": payment.name, "amount": amount}]
		)

	def test_reconcile_vouchers_loads_the_transaction_under_a_row_lock(self):
		"""
		CR-05. The posting operation must read the transaction row FOR UPDATE.

		The already-fully-reconciled guard tests `unallocated_amount` from the loaded snapshot and the
		allocation that follows spends it, so without a lock two concurrent posts both read the same
		non-zero amount, both pass the guard and both allocate against it. Committed cross-session
		concurrency cannot be expressed here - `semgrep/test-correctness.yml` bans `frappe.db.commit()`
		at ERROR severity - so what this pins is the lock itself, which is the whole mechanism.
		"""
		payment, transaction = self._matched_pair(reference="lock-1")
		real_get_doc = frappe.get_doc
		locked = []

		def recording_get_doc(*args, **kwargs):
			if args and args[0] == "Bank Transaction":
				locked.append(kwargs.get("for_update"))
			return real_get_doc(*args, **kwargs)

		with patch("frappe.get_doc", side_effect=recording_get_doc):
			reconcile_vouchers(transaction.name, self._voucher_payload(payment))

		# The FIRST Bank Transaction the endpoint loads is the one it is about to mutate.
		self.assertTrue(locked)
		self.assertTrue(locked[0])
		self.assertEqual(frappe.db.get_value("Bank Transaction", transaction.name, "status"), "Reconciled")

	def test_reconcile_vouchers_checks_write_authority_before_reading_the_row(self):
		"""
		CR-09. Authority is established before anything is read or mutated.

		`save()` does enforce permissions, but it runs last - by then the child rows are appended and
		`allocate_payment_entries` has already stamped clearance dates through `frappe.db.set_value`,
		which checks nothing of its own.
		"""
		payment, transaction = self._matched_pair(reference="order-1")
		real_get_doc = frappe.get_doc
		order = []

		def note_permission(doctype=None, ptype="read", doc=None, **kwargs):
			order.append(("permission", doctype, ptype))
			return True

		def note_get_doc(*args, **kwargs):
			if args and args[0] == "Bank Transaction":
				order.append(("load", "Bank Transaction"))
			return real_get_doc(*args, **kwargs)

		with (
			patch("frappe.has_permission", side_effect=note_permission),
			patch("frappe.get_doc", side_effect=note_get_doc),
		):
			reconcile_vouchers(transaction.name, self._voucher_payload(payment))

		self.assertEqual(order[0], ("permission", "Bank Transaction", "write"))
		self.assertEqual(order[1], ("load", "Bank Transaction"))
		# Each named voucher is authorised for WRITE too - reconciling stamps a clearance date on it.
		self.assertIn(("permission", "Payment Entry", "write"), order)

	def test_reconcile_vouchers_refuses_an_unreconcilable_document_type(self):
		"""An arbitrary doctype must never reach the clearance writer."""
		_payment, transaction = self._matched_pair(reference="type-1")
		before = frappe.db.get_value("Bank Transaction", transaction.name, "unallocated_amount")

		self.assertRaises(
			frappe.ValidationError,
			reconcile_vouchers,
			transaction.name,
			json.dumps([{"payment_doctype": "User", "payment_name": "Administrator", "amount": 100}]),
		)

		self.assertEqual(
			frappe.db.get_value("Bank Transaction", transaction.name, "unallocated_amount"), before
		)
		self.assertEqual(frappe.db.count("Bank Transaction Payments", {"parent": transaction.name}), 0)

	def test_reconcile_vouchers_refuses_a_voucher_that_does_not_exist(self):
		_payment, transaction = self._matched_pair(reference="missing-1")

		self.assertRaises(
			frappe.ValidationError,
			reconcile_vouchers,
			transaction.name,
			json.dumps(
				[{"payment_doctype": "Payment Entry", "payment_name": "PE-DOES-NOT-EXIST", "amount": 100}]
			),
		)

	def test_reconcile_vouchers_refuses_an_empty_or_unidentified_voucher_list(self):
		_payment, transaction = self._matched_pair(reference="empty-1")

		self.assertRaises(frappe.ValidationError, reconcile_vouchers, transaction.name, "[]")
		self.assertRaises(
			frappe.ValidationError,
			reconcile_vouchers,
			transaction.name,
			json.dumps([{"amount": 100}]),
		)

	def test_voucher_validation_refuses_a_voucher_from_another_company(self):
		"""
		CR-09's server-derived scope: a voucher booked to a different company cannot be allocated.

		Asserted against the validator directly so no second company has to be provisioned - the
		transaction stub carries exactly the field the guard compares.
		"""
		payment, _transaction = self._matched_pair(reference="company-1")
		foreign = frappe.new_doc("Bank Transaction")
		foreign.company = "_Test Company Not Real"

		self.assertRaises(
			frappe.ValidationError,
			validate_vouchers_for_reconciliation,
			foreign,
			[{"payment_doctype": "Payment Entry", "payment_name": payment.name}],
		)

	def test_allowed_voucher_doctypes_come_from_the_hook_plus_bank_transaction(self):
		"""
		The allow-list is hook-derived so installed apps extend it, and "Bank Transaction" is added
		on top because `allocate_payment_entries` has its own transaction-against-transaction branch
		that the hook never lists.
		"""
		allowed = get_allowed_voucher_doctypes()
		for doctype in frappe.get_hooks("bank_reconciliation_doctypes"):
			self.assertIn(doctype, allowed)
		self.assertIn("Bank Transaction", allowed)
		self.assertNotIn("User", allowed)

	# ------------------------------------------------------------------ #
	# Candidate lookup: authority, normalisation and bounds
	# ------------------------------------------------------------------ #

	def test_endpoint_http_methods_match_their_effects(self):
		"""
		A read is declared GET-only; the posting endpoint is POST-only. Frappe treats an undeclared
		whitelist as "any method", which is what let a state-changing call be reached by GET.
		"""
		self.assertEqual(
			set(frappe.allowed_http_methods_for_whitelisted_func[get_linked_payments]), {"GET", "QUERY"}
		)
		self.assertEqual(set(frappe.allowed_http_methods_for_whitelisted_func[reconcile_vouchers]), {"POST"})

	def test_get_linked_payments_requires_read_authority(self):
		_payment, transaction = self._matched_pair(reference="read-1")
		self.addCleanup(frappe.set_user, "Administrator")
		frappe.set_user("Guest")

		self.assertRaises(frappe.PermissionError, get_linked_payments, transaction.name, ["payment_entry"])

	def test_get_linked_payments_caps_the_candidate_list(self):
		"""An unbounded response would let this endpoint page a whole ledger out in one call."""
		_payment, transaction = self._matched_pair(reference="cap-1")
		oversized = [
			{"doctype": "Payment Entry", "name": f"PE-{index}", "paid_amount": 1, "rank": 1}
			for index in range(MAX_LINKED_PAYMENTS + 100)
		]
		captured = {}

		def capture(gl_account, vouchers):
			captured["count"] = len(vouchers)
			return vouchers

		with (
			patch(f"{MODULE}.check_matching", return_value=oversized),
			patch(f"{MODULE}.subtract_allocations", side_effect=capture),
		):
			result = get_linked_payments(transaction.name, ["payment_entry"])

		# The cap is applied BEFORE the allocation subtraction, so the bound really is a bound.
		self.assertEqual(captured["count"], MAX_LINKED_PAYMENTS)
		self.assertEqual(len(result), MAX_LINKED_PAYMENTS)

	def test_normalize_document_types_always_yields_a_list_of_tokens(self):
		"""
		The matching layer only asks `"payment_entry" in document_types`, so a bare string turns every
		one of those membership tests into a SUBSTRING test. Normalising means they are always list
		membership, whatever the caller sent.
		"""
		self.assertEqual(
			normalize_document_types('["payment_entry","journal_entry"]'),
			["payment_entry", "journal_entry"],
		)
		self.assertEqual(
			normalize_document_types(["payment_entry", 3, "exact_match"]), ["payment_entry", "exact_match"]
		)
		# A space-separated string is ONE token, not three, and no longer smuggles in "exact_match".
		self.assertEqual(normalize_document_types("payment_entry exact_match"), ["payment_entry exact_match"])
		self.assertNotIn("exact_match", normalize_document_types("payment_entry exact_match"))
		# Nothing that names a matching branch: an empty list, never an exception.
		for value in (None, "", "7", "null", '{"a":1}'):
			self.assertEqual(normalize_document_types(value), [])

	# ------------------------------------------------------------------ #
	# Balance and older-count paths: server-derived scope
	# ------------------------------------------------------------------ #

	def test_get_account_balance_uses_the_accounts_own_company(self):
		"""
		MJ-10. The permission check is scoped to the Bank Account, so the company must come from that
		account rather than from whatever the caller paired with it.
		"""
		captured = {}

		def capture_entries(filters):
			captured["filters"] = dict(filters)
			return []

		with (
			patch(f"{MODULE}.get_entries", side_effect=capture_entries),
			patch(f"{MODULE}.get_balance_on", return_value=0),
			patch(f"{MODULE}.get_amounts_not_reflected_in_system", return_value=0),
		):
			get_account_balance(self.bank_account, today(), company="_Test Company Not Real")

		self.assertEqual(captured["filters"]["company"], self.company)
		self.assertEqual(captured["filters"]["account"], self.bank)

	def test_get_older_unreconciled_transactions_requires_authority(self):
		"""Without this gate the count and oldest date are an oracle over another company's banking."""
		self.make_bank_transaction(date=add_days(today(), -10))
		self.addCleanup(frappe.set_user, "Administrator")
		frappe.set_user("Guest")

		self.assertRaises(
			frappe.PermissionError,
			get_older_unreconciled_transactions,
			self.bank_account,
			today(),
		)
