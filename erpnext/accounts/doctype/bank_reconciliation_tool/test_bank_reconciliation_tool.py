# Copyright (c) 2020, Frappe Technologies Pvt. Ltd. and Contributors
# See license.txt


import frappe
from frappe import qb
from frappe.permissions import add_user_permission, remove_user_permission
from frappe.utils import add_days, getdate, today

from erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool import (
	auto_reconcile_vouchers,
	filter_permitted_vouchers,
	get_auto_reconcile_message,
	get_bank_transactions,
	get_linked_payments,
	get_older_unreconciled_transactions,
)
from erpnext.accounts.doctype.payment_entry.test_payment_entry import create_payment_entry
from erpnext.accounts.test.accounts_mixin import AccountsTestMixin
from erpnext.tests.utils import ERPNextTestSuite


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

	# --- Authorisation of the reconciliation endpoints ---

	def _make_user(self, roles: list[str], companies: list[str] | None = None) -> str:
		"""
		A throwaway enabled user with exactly the roles given, optionally restricted to a set of
		companies by User Permission. Both the User Permission and the impersonated session are
		unwound through `addCleanup`, so an assertion failure cannot leak either.
		"""
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": f"bank-rec-{frappe.generate_hash(length=10)}@example.com",
				"first_name": "Bank Rec",
				"last_name": "Tester",
				"send_welcome_email": 0,
				"roles": [{"role": role} for role in roles],
			}
		).insert(ignore_permissions=True)

		for company in companies or []:
			add_user_permission("Company", company, user.name)
			self.addCleanup(remove_user_permission, "Company", company, user.name)

		return user.name

	def _as_user(self, user: str) -> None:
		self.addCleanup(frappe.set_user, "Administrator")
		frappe.set_user(user)

	def test_get_linked_payments_refuses_an_unreadable_transaction(self):
		"""
		`bank_transaction_name` arrives straight from the client, so the endpoint has to authorise it
		rather than trust it: without the check, any authenticated user could name any transaction and
		receive that company's candidate vouchers, amounts and party names.
		"""
		bank_transaction = self.make_bank_transaction(date=today())
		# Deliberately no accounting roles: every user carries the implicit "All" role, which grants
		# no read on Bank Transaction, so this is the least-privileged authenticated caller.
		self._as_user(self._make_user(roles=[]))

		self.assertFalse(frappe.has_permission("Bank Transaction", ptype="read"))
		with self.assertRaises(frappe.PermissionError):
			get_linked_payments(bank_transaction.name, ["payment_entry"])

	def test_get_linked_payments_refuses_another_companys_transaction(self):
		"""
		Role permissions alone are not enough - a user who may read Bank Transactions in general must
		still be refused one belonging to a company they are restricted out of. That distinction is
		exactly what `doc=` adds to the permission check.
		"""
		bank_transaction = self.make_bank_transaction(date=today())
		self.assertEqual(bank_transaction.company, self.company)

		self._as_user(
			self._make_user(roles=["Accounts User", "Accounts Manager"], companies=["_Test Company 2"])
		)

		# The role grants the DocType permission; the User Permission is what withholds this document.
		self.assertTrue(frappe.has_permission("Bank Transaction", ptype="read"))
		with self.assertRaises(frappe.PermissionError):
			get_linked_payments(bank_transaction.name, ["payment_entry"])

	def test_get_linked_payments_allows_the_owning_company(self):
		# The refusals above are only meaningful if the permitted case still succeeds.
		bank_transaction = self.make_bank_transaction(date=today())
		self._as_user(self._make_user(roles=["Accounts User", "Accounts Manager"], companies=[self.company]))

		# No assertion on the candidate list itself: this test owns the authorisation outcome, and an
		# empty candidate list is a legitimate answer for a transaction with no matching voucher.
		self.assertIsInstance(get_linked_payments(bank_transaction.name, ["payment_entry"]), list)

	def test_filter_permitted_vouchers_drops_unreadable_candidates(self):
		"""
		`check_matching` builds its candidates with `frappe.qb`, which applies neither DocType
		permissions nor User Permissions, so the result set has to be re-asserted afterwards.
		"""
		payment = create_payment_entry(
			company=self.company,
			posting_date=today(),
			payment_type="Receive",
			party_type="Customer",
			party=self.customer,
			paid_from=self.debit_to,
			paid_to=self.bank,
			paid_amount=100,
		).save()
		payment.reference_no = "perm-check"
		payment = payment.save().submit()

		readable = {"doctype": "Payment Entry", "name": payment.name, "paid_amount": 100}
		# A name no permission query can return stands in for any candidate outside the caller's scope.
		unreadable = {
			"doctype": "Payment Entry",
			"name": f"PE-does-not-exist-{frappe.generate_hash(length=8)}",
			"paid_amount": 100,
		}

		self.assertEqual(filter_permitted_vouchers([readable, unreadable]), [readable])
		# An empty candidate list is returned untouched and costs no query.
		self.assertEqual(filter_permitted_vouchers([]), [])

	def test_filter_permitted_vouchers_drops_every_candidate_of_an_unreadable_doctype(self):
		payment = create_payment_entry(
			company=self.company,
			posting_date=today(),
			payment_type="Receive",
			party_type="Customer",
			party=self.customer,
			paid_from=self.debit_to,
			paid_to=self.bank,
			paid_amount=100,
		).save()
		payment = payment.save().submit()
		candidate = {"doctype": "Payment Entry", "name": payment.name, "paid_amount": 100}

		self.assertEqual(filter_permitted_vouchers([candidate]), [candidate])

		self._as_user(self._make_user(roles=[]))
		self.assertFalse(frappe.has_permission("Payment Entry", ptype="read"))
		self.assertEqual(filter_permitted_vouchers([candidate]), [])

	def test_older_unreconciled_transactions_is_permission_aware(self):
		"""
		The backlog count is a per-tenant figure. Counting through `frappe.db.count`, which applies no
		permission conditions, both discloses that another company has a backlog and - when the count
		is non-zero while the permitted list is empty - indexes an empty result.
		"""
		self.make_bank_transaction(date=add_days(today(), -5))

		as_administrator = get_older_unreconciled_transactions(self.bank_account, today())
		self.assertEqual(as_administrator["count"], 1)
		self.assertEqual(as_administrator["oldest_date"], getdate(add_days(today(), -5)))

		self._as_user(
			self._make_user(roles=["Accounts User", "Accounts Manager"], companies=["_Test Company 2"])
		)

		restricted = get_older_unreconciled_transactions(self.bank_account, today())
		self.assertEqual(restricted["count"], 0)
		self.assertIsNone(restricted["oldest_date"])

	def test_older_unreconciled_transactions_reports_the_earliest_date(self):
		self.make_bank_transaction(date=add_days(today(), -2))
		self.make_bank_transaction(date=add_days(today(), -9))

		result = get_older_unreconciled_transactions(self.bank_account, today())
		self.assertEqual(result["count"], 2)
		self.assertEqual(result["oldest_date"], getdate(add_days(today(), -9)))

		# Nothing precedes the window, so neither half of the answer is fabricated.
		empty = get_older_unreconciled_transactions(self.bank_account, add_days(today(), -30))
		self.assertEqual(empty["count"], 0)
		self.assertIsNone(empty["oldest_date"])
