# Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
# See license.txt

import frappe
from frappe import qb
from frappe.permissions import add_user_permission, remove_user_permission
from frappe.utils import getdate

from erpnext.accounts.doctype.account.test_account import create_account
from erpnext.accounts.doctype.bank_account.bank_account import (
	_set_closing_balance_as_per_statement,
	set_closing_balance_as_per_statement,
)
from erpnext.tests.utils import ERPNextTestSuite


class TestBankAccount(ERPNextTestSuite):
	pass


class TestSetClosingBalanceAsPerStatement(ERPNextTestSuite):
	"""
	`set_closing_balance_as_per_statement` is whitelisted, so `bank_account` arrives straight from
	the client. Its update branch has always been guarded by `save()` on an existing row, but the
	create branch was not: `insert()` runs its create permission check *before* validation
	populates the read-only `company` fetch-from field, so the check saw a blank company and a User
	Permission on Company had nothing to restrict. Any authenticated user holding the Bank Account
	Balance role could therefore write a statement balance against another company's bank account.
	"""

	def setUp(self):
		self.company = "_Test Company"
		bank_dt = qb.DocType("Bank")
		qb.from_(bank_dt).delete().where(bank_dt.name == "Closing Balance Test Bank").run()

		bank = frappe.get_doc({"doctype": "Bank", "bank_name": "Closing Balance Test Bank"}).save()

		# A GL account of this suite's own rather than a shared one: `Bank Account` enforces one bank
		# account per GL account, so borrowing a stock account couples this suite to whatever else on
		# the site happens to have claimed it first.
		gl_account = create_account(
			account_name="Closing Balance Test GL",
			account_type="Bank",
			parent_account="Bank Accounts - _TC",
			company=self.company,
		)

		self.bank_account = (
			frappe.get_doc(
				{
					"doctype": "Bank Account",
					"account_name": "Closing Balance Test Account",
					"bank": bank.name,
					"is_company_account": True,
					"account": gl_account,
					"company": self.company,
				}
			)
			.insert()
			.name
		)
		# A date far enough out that no fixture or earlier test owns a row for it, so "no row exists"
		# is a property of this test rather than of the order the suite happens to run in.
		self.date = "2029-11-30"

	def _make_user(self, roles: list[str], companies: list[str] | None = None) -> str:
		"""
		A throwaway enabled user with exactly the roles given, optionally restricted to a set of
		companies by User Permission. Both the User Permission and the impersonated session are
		unwound through `addCleanup`, so an assertion failure cannot leak either.
		"""
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": f"bank-account-{frappe.generate_hash(length=10)}@example.com",
				"first_name": "Bank Account",
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

	def _balance_rows(self) -> list[dict]:
		return frappe.get_all(
			"Bank Account Balance",
			filters={"bank_account": self.bank_account},
			fields=["name", "date", "balance", "company"],
			order_by="date asc",
			ignore_permissions=True,
		)

	def test_refuses_a_bank_account_belonging_to_another_company(self):
		"""
		The defect this closes: a role check alone passes here, because Accounts Manager grants Bank
		Account Balance outright. Only a document-scoped check sees the User Permission that withholds
		this particular bank account.
		"""
		self._as_user(
			self._make_user(roles=["Accounts User", "Accounts Manager"], companies=["_Test Company 2"])
		)

		# The role grants the DocType permission outright - the User Permission is the whole difference.
		self.assertTrue(frappe.has_permission("Bank Account Balance", ptype="create"))

		with self.assertRaises(frappe.PermissionError):
			set_closing_balance_as_per_statement(self.bank_account, self.date, 4321.0)

		# A refusal that still wrote a row would be no refusal at all.
		self.assertEqual(self._balance_rows(), [])

	def test_creates_the_row_for_the_owning_company(self):
		# The refusal above is only meaningful if the permitted case still succeeds.
		self._as_user(self._make_user(roles=["Accounts User", "Accounts Manager"], companies=[self.company]))

		set_closing_balance_as_per_statement(self.bank_account, self.date, 4321.0)

		rows = self._balance_rows()
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0].balance, 4321.0)
		self.assertEqual(str(rows[0].date), self.date)
		# Populated by the endpoint rather than left to validation, which is what makes the create
		# permission check above able to see it.
		self.assertEqual(rows[0].company, self.company)

	def test_updates_an_existing_row_rather_than_adding_a_second(self):
		"""
		The two branches have to stay interchangeable from the caller's point of view: one balance per
		bank account per date, whichever branch handled the request.
		"""
		self._as_user(self._make_user(roles=["Accounts User", "Accounts Manager"], companies=[self.company]))

		set_closing_balance_as_per_statement(self.bank_account, self.date, 100.0)
		set_closing_balance_as_per_statement(self.bank_account, self.date, 250.0)

		rows = self._balance_rows()
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0].balance, 250.0)

	def test_refuses_to_update_another_companys_existing_row(self):
		"""
		The update branch was already guarded by `save()`; asserting it keeps the guard means a later
		change cannot quietly close the create branch while opening this one.
		"""
		_set_closing_balance_as_per_statement(self.bank_account, self.date, 100.0)

		self._as_user(
			self._make_user(roles=["Accounts User", "Accounts Manager"], companies=["_Test Company 2"])
		)
		with self.assertRaises(frappe.PermissionError):
			set_closing_balance_as_per_statement(self.bank_account, self.date, 999.0)

		rows = self._balance_rows()
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0].balance, 100.0)

	def test_refuses_an_unknown_bank_account(self):
		"""
		`has_permission` passes for a name that does not exist, so without an explicit existence check
		an unknown Bank Account would go on to create an orphan balance row.
		"""
		self._as_user(self._make_user(roles=["Accounts User", "Accounts Manager"], companies=[self.company]))

		with self.assertRaises(frappe.DoesNotExistError):
			set_closing_balance_as_per_statement("No Such Bank Account - NSBA", self.date, 1.0)

		self.assertFalse(
			frappe.get_all(
				"Bank Account Balance",
				filters={"bank_account": "No Such Bank Account - NSBA"},
				ignore_permissions=True,
			)
		)

	def test_refuses_an_unknown_bank_account_even_for_a_privileged_caller(self):
		"""
		Why the existence check has to be explicit rather than left to the permission call. For a
		System user `has_permission` returns True for a name that does not exist at all, so this is the
		one caller for whom an unknown Bank Account would otherwise reach the write and leave an orphan
		balance row behind. Every other caller is answered 404 by the framework's own document load.
		"""
		self.assertTrue(
			frappe.has_permission("Bank Account", "read", "No Such Bank Account - NSBA", throw=True)
		)

		with self.assertRaises(frappe.DoesNotExistError):
			set_closing_balance_as_per_statement("No Such Bank Account - NSBA", self.date, 1.0)

		self.assertFalse(
			frappe.get_all(
				"Bank Account Balance",
				filters={"bank_account": "No Such Bank Account - NSBA"},
				ignore_permissions=True,
			)
		)

	def test_refuses_a_bank_account_that_is_not_a_name(self):
		"""
		A hostile type has to be refused as a validation error rather than reaching the permission call
		and surfacing as an unhandled server error - the same defect class as the reconciliation
		endpoints' parameter guards.

		Two layers can answer, and the test accepts either: the whitelisted signature's own
		`bank_account: str` annotation, which the framework enforces for a request arriving over HTTP,
		and the explicit guard in the endpoint, which is what covers a direct in-process call where no
		annotation validation runs. What matters is that both answer 417 and neither reaches the write.
		"""
		self._as_user(self._make_user(roles=["Accounts User", "Accounts Manager"], companies=[self.company]))

		for hostile in ({"name": "x"}, ["x"], 7, None, True):
			with (
				self.subTest(bank_account=hostile),
				self.assertRaises((frappe.ValidationError, frappe.exceptions.FrappeTypeError)) as refusal,
			):
				set_closing_balance_as_per_statement(hostile, self.date, 1.0)

			self.assertEqual(refusal.exception.http_status_code, 417)
			self.assertNotIsInstance(refusal.exception, frappe.PermissionError)

		self.assertEqual(self._balance_rows(), [])

	def test_refuses_a_date_it_cannot_read(self):
		"""
		An unreadable date used to reach the database verbatim and come back as an HTTP 500
		OperationalError naming the database, table and column. Every shape here has to be a 417
		instead, and none of them may write a row.

		The two values worth singling out: a 15-digit numeric string, which makes `getdate` raise an
		uncaught OverflowError where a 9-digit one is refused cleanly, and a blank string, which makes
		`getdate` answer TODAY - so accepting it would silently record a balance against today rather
		than refusing the request.
		"""
		self._as_user(self._make_user(roles=["Accounts User", "Accounts Manager"], companies=[self.company]))

		for bad in ("not-a-date", "2026-13-45", "999999999", "999999999999999", "1e400", "", "   "):
			with self.subTest(date=bad), self.assertRaises(frappe.ValidationError) as refusal:
				set_closing_balance_as_per_statement(self.bank_account, bad, 1.0)
			self.assertEqual(refusal.exception.http_status_code, 417)

		self.assertEqual(self._balance_rows(), [])

	def test_accepts_both_normalised_date_shapes(self):
		"""A date object and its string spelling have to land on one and the same row."""
		self._as_user(self._make_user(roles=["Accounts User", "Accounts Manager"], companies=[self.company]))

		set_closing_balance_as_per_statement(self.bank_account, self.date, 10.0)
		set_closing_balance_as_per_statement(self.bank_account, getdate(self.date), 20.0)

		rows = self._balance_rows()
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0].balance, 20.0)

	def test_the_importers_internal_path_does_not_require_bank_account_permission(self):
		"""
		The reason the check lives in the whitelisted wrapper and not in the shared body. `Bank
		Statement Import Log` is granted to System Manager only, and that role holds no Bank Account
		permission row at all - so a System Manager running a statement import must still be able to
		write the statement's closing balance, and would be refused outright by a check placed in the
		shared body.
		"""
		self._as_user(self._make_user(roles=["System Manager"]))

		# Precisely the asymmetry that forces the split: no Bank Account permission, but the balance
		# row itself is granted.
		self.assertFalse(frappe.has_permission("Bank Account", ptype="read", doc=self.bank_account))
		self.assertTrue(frappe.has_permission("Bank Account Balance", ptype="create"))

		with self.assertRaises(frappe.PermissionError):
			set_closing_balance_as_per_statement(self.bank_account, self.date, 500.0)

		# The path the importer actually uses stays open.
		_set_closing_balance_as_per_statement(self.bank_account, self.date, 500.0)

		rows = self._balance_rows()
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0].balance, 500.0)
		self.assertEqual(rows[0].company, self.company)
