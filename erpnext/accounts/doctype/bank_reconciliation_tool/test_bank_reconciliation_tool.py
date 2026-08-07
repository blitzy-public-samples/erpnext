# Copyright (c) 2020, Frappe Technologies Pvt. Ltd. and Contributors
# See license.txt


import json
from unittest.mock import patch

import frappe
from frappe import qb
from frappe.permissions import add_user_permission, remove_user_permission
from frappe.utils import add_days, add_to_date, getdate, today

from erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool import (
	auto_reconcile_vouchers,
	clear_clearing_date,
	create_bulk_payment_entry_and_reconcile,
	filter_permitted_vouchers,
	get_account_balance,
	get_auto_reconcile_message,
	get_bank_transactions,
	get_linked_payments,
	get_older_unreconciled_transactions,
	reconcile_vouchers,
	search_for_transfer_transaction,
	update_clearance_date,
	validate_reconciliation_voucher_type,
)
from erpnext.accounts.doctype.bank_transaction.bank_transaction import unreconcile_transaction
from erpnext.accounts.doctype.payment_entry.test_payment_entry import create_payment_entry
from erpnext.accounts.doctype.sales_invoice.test_sales_invoice import create_sales_invoice
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

	# --- The reconcile endpoint's request contract ---

	def test_reconcile_vouchers_refuses_a_malformed_voucher_payload(self):
		"""
		Every shape of malformed payload used to reach a different layer and surface as a raw HTTP 500:
		a non-JSON string as `JSONDecodeError`, a JSON object as `TypeError` when it was iterated, and
		a voucher missing its two identifying keys as `KeyError` once they were indexed. All three are
		the same class of mistake and all three now answer as validation errors.
		"""
		bank_transaction = self.make_bank_transaction(date=today())

		for payload in (
			"{not json",
			json.dumps({"payment_doctype": "Payment Entry"}),
			json.dumps([{"amount": 100}]),
			json.dumps(["Payment Entry"]),
			json.dumps([{"payment_doctype": "Payment Entry", "payment_name": ""}]),
		):
			with self.subTest(payload=payload):
				self.assertRaises(
					frappe.ValidationError,
					reconcile_vouchers,
					bank_transaction_name=bank_transaction.name,
					vouchers=payload,
				)

		# Nothing was written for any of them.
		bank_transaction.reload()
		self.assertEqual(bank_transaction.payment_entries, [])
		self.assertEqual(bank_transaction.status, "Unreconciled")

	def test_reconcile_vouchers_refuses_an_empty_selection(self):
		"""
		An empty selection is the one malformed payload that used to SUCCEED: it answered HTTP 200
		having reconciled nothing, so a caller whose selection had been dropped on the way was told the
		posting had gone through.
		"""
		bank_transaction = self.make_bank_transaction(date=today())

		self.assertRaises(
			frappe.ValidationError,
			reconcile_vouchers,
			bank_transaction_name=bank_transaction.name,
			vouchers=json.dumps([]),
		)

	def test_reconcile_vouchers_refuses_an_unknown_transaction(self):
		# `frappe.get_doc` would raise this itself, but only after the payload had been parsed; naming
		# the missing transaction explicitly is what makes the answer a 404 rather than an accident.
		self.assertRaises(
			frappe.DoesNotExistError,
			reconcile_vouchers,
			bank_transaction_name="ACC-BTN-does-not-exist",
			vouchers=json.dumps(
				[{"payment_doctype": "Payment Entry", "payment_name": "ACC-PAY-does-not-exist"}]
			),
		)

	def test_reconcile_vouchers_refuses_a_transaction_changed_underneath_it(self):
		"""
		The stale-state rejection that replaces a database deadlock.

		Two sessions posting against the same transaction used to interleave their writes and dead-lock,
		and the loser received HTTP 508 `QueryDeadlockError`. `reconcile_vouchers` now takes the
		transaction's row lock first, then compares the locked row's `modified` with the one its own
		snapshot loaded - so a transaction that moved on since the caller read it is refused instead of
		half-merged over.

		The staleness is injected by rewinding the loaded document's `modified`, not by writing to the row.
		A same-connection write is visible to BOTH reads - the locking one and the snapshot one - so it
		cannot reproduce the divergence a genuinely concurrent session creates. The race itself is
		exercised against a running site; this test owns the decision the check makes once the two values
		differ, and that no part of the reconciliation is applied when it refuses.
		"""
		bank_transaction = self.make_bank_transaction(date=today())
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

		vouchers = json.dumps(
			[{"payment_doctype": "Payment Entry", "payment_name": payment.name, "amount": 100}]
		)

		real_get_doc = frappe.get_doc

		def get_doc_with_a_stale_timestamp(*args, **kwargs):
			doc = real_get_doc(*args, **kwargs)
			if doc.doctype == "Bank Transaction":
				doc.modified = add_to_date(doc.modified, days=-1)
			return doc

		with patch.object(frappe, "get_doc", side_effect=get_doc_with_a_stale_timestamp):
			self.assertRaises(
				frappe.ValidationError,
				reconcile_vouchers,
				bank_transaction_name=bank_transaction.name,
				vouchers=vouchers,
			)

		bank_transaction.reload()
		self.assertEqual(bank_transaction.payment_entries, [])
		self.assertEqual(bank_transaction.unallocated_amount, 100)
		self.assertIsNone(frappe.db.get_value("Payment Entry", payment.name, "clearance_date"))

	def test_reconcile_vouchers_posts_when_the_request_is_well_formed(self):
		# The four refusals above are only meaningful if the ordinary path still posts.
		bank_transaction = self.make_bank_transaction(date=today())
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

		reconcile_vouchers(
			bank_transaction.name,
			json.dumps([{"payment_doctype": "Payment Entry", "payment_name": payment.name, "amount": 100}]),
		)

		bank_transaction.reload()
		self.assertEqual(bank_transaction.status, "Reconciled")
		self.assertEqual(bank_transaction.unallocated_amount, 0)
		self.assertEqual(len(bank_transaction.payment_entries), 1)
		self.assertEqual(bank_transaction.payment_entries[0].payment_entry, payment.name)

	# --- The clearance-date endpoints' outcome contract ---

	def _submitted_payment(self, reference_no: str, amount: float = 100.0):
		payment = create_payment_entry(
			company=self.company,
			posting_date=today(),
			payment_type="Receive",
			party_type="Customer",
			party=self.customer,
			paid_from=self.debit_to,
			paid_to=self.bank,
			paid_amount=amount,
		).save()
		payment.reference_no = reference_no
		payment.reference_date = today()
		return payment.save().submit()

	def test_update_clearance_date_sets_and_clears_a_real_voucher(self):
		# Both refusals below are only meaningful if the ordinary path still writes.
		payment = self._submitted_payment("clearance-happy")

		update_clearance_date("Payment Entry", payment.name, self.bank, today())
		self.assertEqual(
			frappe.db.get_value("Payment Entry", payment.name, "clearance_date"), getdate(today())
		)

		clear_clearing_date("Payment Entry", payment.name)
		self.assertIsNone(frappe.db.get_value("Payment Entry", payment.name, "clearance_date"))

	def test_update_clearance_date_refuses_a_voucher_type_it_does_not_deal_in(self):
		"""
		`payment_document` was handed straight to `frappe.db.set_value`, so a name that is not a DocType
		answered HTTP 500 with a bare "DocType X not found", and any DocType on the site carrying a
		`clearance_date` was writable through a bank-reconciliation endpoint. The permitted set is the
		`bank_reconciliation_doctypes` hook the surface itself is built from.
		"""
		for voucher_type in ("Bogus DocType", "User", "Bank Transaction"):
			with self.subTest(voucher_type=voucher_type):
				self.assertRaises(
					frappe.ValidationError,
					update_clearance_date,
					payment_document=voucher_type,
					payment_entry="whatever",
					account=self.bank,
					clearance_date=today(),
				)
				self.assertRaises(
					frappe.ValidationError,
					clear_clearing_date,
					voucher_type=voucher_type,
					voucher_name="whatever",
				)

		# Every type the surface does deal in is accepted by the check itself.
		for voucher_type in ("Payment Entry", "Journal Entry", "Sales Invoice", "Purchase Invoice"):
			with self.subTest(voucher_type=voucher_type):
				validate_reconciliation_voucher_type(voucher_type)

	def test_update_clearance_date_refuses_a_target_that_does_not_exist(self):
		# `frappe.db.set_value` on a missing name updates zero rows and reports nothing, so the request
		# answered HTTP 200 having done nothing at all.
		self.assertRaises(
			frappe.DoesNotExistError,
			update_clearance_date,
			payment_document="Payment Entry",
			payment_entry="ACC-PAY-does-not-exist",
			account=self.bank,
			clearance_date=today(),
		)

	def test_update_clearance_date_refuses_a_sales_invoice_with_no_payment_on_the_account(self):
		# The Sales Invoice branch identifies its target by parent + account rather than by name, so a
		# filter matching nothing wrote nothing while still answering HTTP 200.
		invoice = create_sales_invoice(
			company=self.company, customer=self.customer, debit_to=self.debit_to, qty=1, rate=100
		)
		# An ordinary (non-POS) invoice carries no `payments` rows at all, which is exactly the state that
		# used to be answered with a silent success.
		self.assertEqual(invoice.get("payments"), [])

		self.assertRaises(
			frappe.ValidationError,
			update_clearance_date,
			payment_document="Sales Invoice",
			payment_entry=invoice.name,
			account=self.bank,
			clearance_date=today(),
		)

	def test_clear_clearing_date_refuses_a_caller_who_may_not_write(self):
		# The silent `if has_permission(...)` form answered HTTP 200 to a caller who was not allowed to
		# write, so a refusal was indistinguishable from a success.
		payment = self._submitted_payment("clearance-denied")
		update_clearance_date("Payment Entry", payment.name, self.bank, today())

		self._as_user(self._make_user(roles=[]))

		self.assertRaises(frappe.PermissionError, clear_clearing_date, "Payment Entry", payment.name)

		frappe.set_user("Administrator")
		self.assertEqual(
			frappe.db.get_value("Payment Entry", payment.name, "clearance_date"), getdate(today())
		)

	def test_the_state_changing_endpoints_accept_post_only(self):
		"""
		Each of these WRITES, and each used to answer a bare GET with HTTP 200. The read-only rollback
		Frappe applies after a GET kept the changes from persisting, so nothing broke - but the caller
		was told an action had been taken when none had, and a crawler or link prefetch could ask for
		one. The registry Frappe's HTTP layer consults is asserted directly, because that layer - not the
		function body - is what refuses the wrong verb. "QUERY" is not added here: Frappe appends it only
		alongside "GET", so its absence is itself part of the assertion.
		"""
		for endpoint in (
			auto_reconcile_vouchers,
			update_clearance_date,
			clear_clearing_date,
			unreconcile_transaction,
			reconcile_vouchers,
		):
			with self.subTest(endpoint=endpoint.__name__):
				self.assertIn(endpoint, frappe.whitelisted)
				self.assertEqual(frappe.allowed_http_methods_for_whitelisted_func[endpoint], ("POST",))

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

	# --- Inputs the read endpoints used to take on trust ---

	def test_get_bank_transactions_refuses_a_date_that_is_not_a_date(self):
		"""
		Both boundaries went into the filter list untouched, and the database DISCARDED a comparison it
		could not read rather than failing it. So a request with a corrupt boundary answered HTTP 200
		with every transaction on the account - the widest possible answer - while the caller believed
		they were looking at the window they asked for.
		"""
		self.make_bank_transaction(date=today())

		for bad_date in ("not-a-date", "2026-13-45", "31/02/2026"):
			with self.subTest(bad_date=bad_date):
				self.assertRaises(
					frappe.ValidationError, get_bank_transactions, self.bank_account, from_date=bad_date
				)
				self.assertRaises(
					frappe.ValidationError, get_bank_transactions, self.bank_account, to_date=bad_date
				)

		# The window itself must still be applied, and an absent boundary must still mean "no bound"
		# rather than `getdate`'s today - which is what makes the two calls below differ.
		self.assertEqual(len(get_bank_transactions(self.bank_account, to_date=today())), 1)
		self.assertEqual(len(get_bank_transactions(self.bank_account, from_date=add_days(today(), 1))), 0)
		self.assertEqual(len(get_bank_transactions(self.bank_account)), 1)

	def test_get_account_balance_derives_the_company_from_the_account(self):
		"""
		`company` reached the report queries that scope the balance, so naming a company other than the
		account's returned a plausible - and wrong - balance for that account rather than an error. The
		company is a property of the account, so it is derived here and a disagreeing client value is
		refused instead of silently preferring either one.
		"""
		balance = get_account_balance(self.bank_account, today(), self.company)

		# A caller whose company has not resolved yet sends an empty one. That used to be passed straight
		# into the report filters, scoping the balance to no company at all; now it is derived, so this
		# call must agree with the one above - which is what proves the value is derived rather than
		# merely echoed back.
		self.assertEqual(get_account_balance(self.bank_account, today(), ""), balance)

		for wrong_company in ("_Test Company 2", "A Company That Does Not Exist"):
			with self.subTest(company=wrong_company):
				self.assertRaises(
					frappe.ValidationError, get_account_balance, self.bank_account, today(), wrong_company
				)

	def test_get_account_balance_refuses_an_unknown_bank_account(self):
		# `has_permission` passes for a name that does not exist, so an unknown account used to fall
		# through with no GL account at all and report a confident 0.0.
		self.assertRaises(
			frappe.DoesNotExistError, get_account_balance, "No Such Bank Account", today(), self.company
		)

	def test_search_for_transfer_transaction_refuses_an_unknown_transaction(self):
		# The five fields were unpacked straight out of `get_value`, and unpacking its None for a missing
		# name raised a bare TypeError HTTP 500 that named neither the transaction nor the problem.
		self.assertRaises(frappe.DoesNotExistError, search_for_transfer_transaction, "ACC-BTN-no-such")

		# A real transaction with no mirror is a legitimate empty answer, not an error.
		self.assertIsNone(search_for_transfer_transaction(self.make_bank_transaction(date=today()).name))

	# --- The bulk Payment Entry creator ---

	def _transaction_to_pay(self, reference_number: str, deposit: float = 0.0, withdrawal: float = 0.0):
		"""
		A submitted Bank Transaction carrying a reference number, as an imported statement row does. The
		creator copies that reference onto the Payment Entry, and Payment Entry requires one whenever a
		bank account is involved - so a transaction with neither a reference nor a description cannot be
		paid, which is a property of Payment Entry rather than of this endpoint.
		"""
		return (
			frappe.get_doc(
				{
					"doctype": "Bank Transaction",
					"date": today(),
					"deposit": deposit,
					"withdrawal": withdrawal,
					"bank_account": self.bank_account,
					"reference_number": reference_number,
					"currency": "INR",
				}
			)
			.save()
			.submit()
		)

	def test_create_bulk_payment_entry_and_reconcile_posts_submitted_entries(self):
		"""
		`company` was read off the transaction record but never selected from the database, so it was
		always None and EVERY call failed validation with "Value missing for Payment Entry: Company" -
		the endpoint could not be used at all. Both directions are exercised because the deposit and
		withdrawal branches build different Payment Entries.
		"""
		deposit = self._transaction_to_pay("bulk-deposit", deposit=331)
		withdrawal = self._transaction_to_pay("bulk-withdrawal", withdrawal=222)

		created = create_bulk_payment_entry_and_reconcile(
			bank_transaction_names=[deposit.name, withdrawal.name],
			party_type="Customer",
			party=self.customer,
			account=self.debit_to,
		)

		self.assertEqual(len(created), 2)
		for entry, source, expected_type in (
			(created[0], deposit, "Receive"),
			(created[1], withdrawal, "Pay"),
		):
			payment = entry["payment_entry"]
			self.assertEqual(payment.company, self.company)
			self.assertEqual(payment.payment_type, expected_type)
			self.assertEqual(payment.docstatus, 1)

			transaction = entry["transaction"]
			self.assertEqual(transaction.name, source.name)
			self.assertEqual(transaction.status, "Reconciled")
			self.assertEqual(transaction.unallocated_amount, 0.0)
			self.assertEqual(transaction.payment_entries[0].payment_entry, payment.name)

	def test_create_bulk_payment_entry_and_reconcile_refuses_an_unknown_transaction(self):
		# An unknown name read as None and then broke on an attribute access, so the caller got an
		# AttributeError HTTP 500 rather than being told which transaction could not be found.
		self.assertRaises(
			frappe.DoesNotExistError,
			create_bulk_payment_entry_and_reconcile,
			bank_transaction_names=["ACC-BTN-no-such"],
			party_type="Customer",
			party=self.customer,
			account=self.debit_to,
		)

	def test_create_bulk_payment_entry_and_reconcile_refuses_a_reconciled_transaction(self):
		"""
		The Payment Entry is sized from `unallocated_amount`, so a transaction that is already fully
		reconciled produced a zero-amount entry and was refused several layers down with "Paid Amount is
		mandatory" - a message that says nothing about the real reason. A stale selection has to read the
		same however it is submitted.
		"""
		transaction = self._transaction_to_pay("bulk-already-reconciled", deposit=331)
		create_bulk_payment_entry_and_reconcile(
			bank_transaction_names=[transaction.name],
			party_type="Customer",
			party=self.customer,
			account=self.debit_to,
		)
		transaction.reload()
		self.assertEqual(transaction.status, "Reconciled")

		with self.assertRaises(frappe.ValidationError) as refusal:
			create_bulk_payment_entry_and_reconcile(
				bank_transaction_names=[transaction.name],
				party_type="Customer",
				party=self.customer,
				account=self.debit_to,
			)
		self.assertIn("already fully reconciled", str(refusal.exception))

		# The refusal must leave the first reconciliation exactly as it was, with no second voucher.
		transaction.reload()
		self.assertEqual(transaction.status, "Reconciled")
		self.assertEqual(len(transaction.payment_entries), 1)

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
