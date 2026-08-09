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
	create_bulk_bank_entry_and_reconcile,
	create_bulk_internal_transfer,
	create_bulk_payment_entry_and_reconcile,
	create_journal_entry_bts,
	create_payment_entry_bts,
	filter_permitted_vouchers,
	get_account_balance,
	get_auto_reconcile_message,
	get_bank_transactions,
	get_linked_payments,
	get_older_unreconciled_transactions,
	parse_date_argument,
	reconcile_vouchers,
	search_for_transfer_transaction,
	update_clearance_date,
	validate_reconciliation_voucher_type,
	validate_vouchers_to_reconcile,
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

	# --- Date arguments: every unreadable value is a validation error, never a server error ---

	def test_parse_date_argument_refuses_a_number_too_large_for_the_platform(self):
		"""
		`getdate` is not total. It raises its own clean ValidationError for an unreadable string, but an
		uncaught `OverflowError("Python int too large to convert to C int")` for a number too large for a
		C int - so a 9-digit value was refused with HTTP 417 while a 15-digit one answered HTTP 500,
		disclosing `exc_type`, a traceback and on-disk repository and site-packages paths. The boundary
		is measured here directly, so the split between the two behaviours cannot come back.
		"""
		self.assertEqual(parse_date_argument("2026-08-03"), getdate("2026-08-03"))
		self.assertEqual(parse_date_argument(getdate(today())), getdate(today()))

		for overflowing in ("999999999999999", "99999999999999999999"):
			with self.subTest(value=overflowing):
				self.assertRaises(frappe.ValidationError, parse_date_argument, overflowing)

		# Still refused, and still as a validation error, for every other unreadable shape. The last four
		# matter because `getdate` does not RAISE on any of them: handed a non-date it answers None, and
		# handed a blank string it answers TODAY - so without the guards each would have become "no date"
		# or "now" inside a filter instead of a refusal.
		for unreadable in ("not-a-date", "2026-13-45", "999999999", "1e400", [], {}, 10**18, "", "   "):
			with self.subTest(value=unreadable):
				self.assertRaises(frappe.ValidationError, parse_date_argument, unreadable)

	def test_get_bank_transactions_refuses_an_overflowing_date(self):
		self.make_bank_transaction(date=today())

		for boundary in ("from_date", "to_date"):
			with self.subTest(boundary=boundary):
				self.assertRaises(
					frappe.ValidationError,
					get_bank_transactions,
					self.bank_account,
					**{boundary: "999999999999999"},
				)

		# The endpoint still answers the ordinary request, so the guard costs no behaviour.
		self.assertEqual(len(get_bank_transactions(self.bank_account, to_date=today())), 1)

	def test_get_account_balance_refuses_an_unreadable_till_date(self):
		"""
		`till_date` reached the report queries and `get_balance_on` raw, so an unreadable value surfaced
		from deep inside them and an overflowing one as an unhandled OverflowError - HTTP 500 from an
		endpoint that already answers every other bad argument as a validation error.
		"""
		for bad_date in ("not-a-date", "2026-13-45", "999999999999999"):
			with self.subTest(till_date=bad_date):
				self.assertRaises(
					frappe.ValidationError, get_account_balance, self.bank_account, bad_date, self.company
				)

		# A readable date still answers, so the balance path itself is untouched.
		self.assertIsNotNone(get_account_balance(self.bank_account, today(), self.company))

	def test_older_unreconciled_transactions_refuses_an_unreadable_boundary(self):
		# The boundary reached the database raw, and a comparison the engine could not read was DISCARDED
		# rather than failed - so a corrupt boundary answered a count taken over no window at all.
		self.make_bank_transaction(date=add_days(today(), -3))

		for bad_date in ("not-a-date", "999999999999999"):
			with self.subTest(from_date=bad_date):
				self.assertRaises(
					frappe.ValidationError, get_older_unreconciled_transactions, self.bank_account, bad_date
				)

		self.assertEqual(get_older_unreconciled_transactions(self.bank_account, today())["count"], 1)

	def test_update_clearance_date_refuses_a_clearance_date_that_is_not_a_date(self):
		"""
		The value went straight into `frappe.db.set_value`, so it was the DATABASE that refused it - and
		the engine's own message disclosed the database name, the table and the column.
		"""
		payment = self._submitted_payment("clearance-bad-date")

		for bad_date in ("not-a-date", "2026-13-45", "999999999999999"):
			with self.subTest(clearance_date=bad_date):
				self.assertRaises(
					frappe.ValidationError,
					update_clearance_date,
					payment_document="Payment Entry",
					payment_entry=payment.name,
					account=self.bank,
					clearance_date=bad_date,
				)

		# Nothing was written by any of them, and the ordinary path still writes.
		self.assertIsNone(frappe.db.get_value("Payment Entry", payment.name, "clearance_date"))
		update_clearance_date("Payment Entry", payment.name, self.bank, today())
		self.assertEqual(
			frappe.db.get_value("Payment Entry", payment.name, "clearance_date"), getdate(today())
		)

		# An empty clearance date still means "clear it" rather than "today".
		update_clearance_date("Payment Entry", payment.name, self.bank, None)
		self.assertIsNone(frappe.db.get_value("Payment Entry", payment.name, "clearance_date"))

	# --- Clearance date: authorization of the VOUCHER, not just a role on another DocType ---

	def test_update_clearance_date_refuses_a_voucher_outside_the_callers_scope(self):
		"""
		The only check was `has_permission("Bank Clearance", ptype="write")` - a ROLE check, and against
		a DIFFERENT DocType than the one being written. A role check says nothing about WHICH records a
		user may touch, and `frappe.db.set_value` never consults document permissions, so User
		Permissions were bypassed entirely: a caller restricted to one company could stamp a clearance
		date onto another company's Payment Entry, be answered HTTP 200, and be recorded as the author.
		"""
		payment = self._submitted_payment("clearance-cross-company")

		self._as_user(
			self._make_user(roles=["Accounts User", "Accounts Manager"], companies=["_Test Company 2"])
		)
		# The caller holds the role the endpoint used to check, which is what makes the refusal below a
		# statement about the DOCUMENT rather than about the role.
		self.assertTrue(frappe.has_permission("Bank Clearance", ptype="write"))

		self.assertRaises(
			frappe.PermissionError,
			update_clearance_date,
			payment_document="Payment Entry",
			payment_entry=payment.name,
			account=self.bank,
			clearance_date=today(),
		)

		frappe.set_user("Administrator")
		# Refused ahead of the write, so the voucher is byte-identical.
		self.assertIsNone(frappe.db.get_value("Payment Entry", payment.name, "clearance_date"))

	def test_update_clearance_date_still_writes_for_an_unrestricted_accounts_manager(self):
		# The refusal above is only meaningful if an ordinary, unrestricted accountant still succeeds.
		payment = self._submitted_payment("clearance-permitted")

		self._as_user(self._make_user(roles=["Accounts User", "Accounts Manager"]))
		update_clearance_date("Payment Entry", payment.name, self.bank, today())

		frappe.set_user("Administrator")
		self.assertEqual(
			frappe.db.get_value("Payment Entry", payment.name, "clearance_date"), getdate(today())
		)

	def test_update_clearance_date_refuses_a_sales_invoice_that_does_not_exist(self):
		# The Sales Invoice branch resolved its payment row first, so a missing invoice was reported as
		# "nothing to clear" - which describes a different situation than the one the caller is in.
		self.assertRaises(
			frappe.DoesNotExistError,
			update_clearance_date,
			payment_document="Sales Invoice",
			payment_entry="ACC-SINV-does-not-exist",
			account=self.bank,
			clearance_date=today(),
		)

	# --- Reconcile: the WRITE path authorises the vouchers the client named ---

	def test_reconcile_vouchers_refuses_a_voucher_the_caller_cannot_read(self):
		"""
		The candidate list the UI offers is permission-filtered, but nothing obliged a caller to choose
		from it: naming a voucher directly bypassed the filter completely. So a restricted user could
		allocate a bank transaction against a voucher they cannot even read, be answered HTTP 200, and
		leave a child row linking that document.

		The restriction used here is a Company User Permission, which is what makes the voucher
		unreadable to this caller while leaving the role intact.
		"""
		bank_transaction = self.make_bank_transaction(date=today())
		payment = self._submitted_payment("reconcile-unreadable")

		self._as_user(
			self._make_user(roles=["Accounts User", "Accounts Manager"], companies=["_Test Company 2"])
		)
		# The role is present and the document is unreadable - the two facts that together make this a
		# document-level refusal rather than a role-level one.
		self.assertTrue(frappe.has_permission("Payment Entry", ptype="read"))
		self.assertFalse(frappe.has_permission("Payment Entry", ptype="read", doc=payment.name))

		self.assertRaises(
			frappe.PermissionError,
			reconcile_vouchers,
			bank_transaction_name=bank_transaction.name,
			vouchers=json.dumps(
				[{"payment_doctype": "Payment Entry", "payment_name": payment.name, "amount": 100}]
			),
		)

		frappe.set_user("Administrator")
		# Refused before `add_payment_entries`, so NOTHING was appended, allocated or saved.
		bank_transaction.reload()
		self.assertEqual(bank_transaction.payment_entries, [])
		self.assertEqual(bank_transaction.status, "Unreconciled")
		self.assertEqual(bank_transaction.allocated_amount, 0)
		self.assertIsNone(frappe.db.get_value("Payment Entry", payment.name, "clearance_date"))

	def test_reconcile_vouchers_refuses_the_whole_request_when_one_voucher_is_unpermitted(self):
		"""
		A partially permitted selection must not post its permitted half: the reviewer asked for one
		reconciliation, and half of one is a different - and silently wrong - outcome.

		The restriction is a User Permission on Payment Entry itself, which is what makes ONE of two
		otherwise identical vouchers readable and the other not, so the refusal cannot be explained by
		the request being malformed or the other voucher being absent.
		"""
		bank_transaction = self.make_bank_transaction(date=today(), deposit=200)
		readable = self._submitted_payment("reconcile-mixed-readable")
		unreadable = self._submitted_payment("reconcile-mixed-unreadable")

		user = self._make_user(roles=["Accounts User", "Accounts Manager"])
		add_user_permission("Payment Entry", readable.name, user)
		self.addCleanup(remove_user_permission, "Payment Entry", readable.name, user)
		self._as_user(user)

		# Exactly one of the two is readable, which is what makes this a MIXED selection.
		self.assertTrue(frappe.has_permission("Payment Entry", ptype="read", doc=readable.name))
		self.assertFalse(frappe.has_permission("Payment Entry", ptype="read", doc=unreadable.name))

		self.assertRaises(
			frappe.PermissionError,
			reconcile_vouchers,
			bank_transaction_name=bank_transaction.name,
			vouchers=json.dumps(
				[
					{"payment_doctype": "Payment Entry", "payment_name": readable.name, "amount": 100},
					{"payment_doctype": "Payment Entry", "payment_name": unreadable.name, "amount": 100},
				]
			),
		)

		frappe.set_user("Administrator")
		# Not even the permitted half was posted.
		bank_transaction.reload()
		self.assertEqual(bank_transaction.payment_entries, [])
		self.assertEqual(bank_transaction.status, "Unreconciled")
		self.assertIsNone(frappe.db.get_value("Payment Entry", readable.name, "clearance_date"))

	def test_reconcile_vouchers_refuses_a_voucher_type_it_does_not_deal_in(self):
		# `payment_document` is a Link to DocType on the child table, so any DocType on the site could be
		# named. The permitted set is the same `bank_reconciliation_doctypes` hook the clearance-date
		# endpoints validate against, so the two can never drift apart.
		bank_transaction = self.make_bank_transaction(date=today())

		for voucher_type in ("Bogus DocType", "User", "Bank Transaction"):
			with self.subTest(voucher_type=voucher_type):
				self.assertRaises(
					frappe.ValidationError,
					reconcile_vouchers,
					bank_transaction_name=bank_transaction.name,
					vouchers=json.dumps(
						[{"payment_doctype": voucher_type, "payment_name": "whatever", "amount": 100}]
					),
				)

		bank_transaction.reload()
		self.assertEqual(bank_transaction.payment_entries, [])

	def test_reconcile_vouchers_refuses_a_voucher_that_does_not_exist(self):
		# Reported as "not found" rather than as a permission refusal, because the permission filter
		# cannot tell an absent record from an unreadable one and answering 403 would mis-describe it.
		bank_transaction = self.make_bank_transaction(date=today())

		self.assertRaises(
			frappe.DoesNotExistError,
			reconcile_vouchers,
			bank_transaction_name=bank_transaction.name,
			vouchers=json.dumps(
				[
					{
						"payment_doctype": "Payment Entry",
						"payment_name": "ACC-PAY-does-not-exist",
						"amount": 100,
					}
				]
			),
		)

	def test_reconcile_vouchers_refuses_a_hostile_identifier_type(self):
		"""
		Testing truthiness alone let a JSON object or array through as an identifier, and each then
		reached a different layer as an unhandled TypeError - `payment_name` as a dict became an
		unhashable member of the tuple `validate_duplicate_references` puts into a set. Both answered
		HTTP 500 from the very function whose purpose is to stop a malformed payload doing exactly that.

		All six shapes the finding measured are covered, so the four that used to crash and the two that
		were already refused are pinned to the same answer.
		"""
		bank_transaction = self.make_bank_transaction(date=today())

		for hostile in (
			{"payment_doctype": "Payment Entry", "payment_name": {"a": 1}, "amount": 1},
			{"payment_doctype": "Payment Entry", "payment_name": ["a"], "amount": 1},
			{"payment_doctype": {"a": 1}, "payment_name": "ACC-PAY-2026-00001", "amount": 1},
			{"payment_doctype": ["Payment Entry"], "payment_name": "ACC-PAY-2026-00001", "amount": 1},
			{"payment_doctype": "Payment Entry", "payment_name": 12345, "amount": 1},
			{"payment_doctype": "Payment Entry", "payment_name": True, "amount": 1},
		):
			with self.subTest(voucher=str(hostile)):
				self.assertRaises(
					frappe.ValidationError,
					reconcile_vouchers,
					bank_transaction_name=bank_transaction.name,
					vouchers=json.dumps([hostile]),
				)

		bank_transaction.reload()
		self.assertEqual(bank_transaction.payment_entries, [])
		self.assertEqual(bank_transaction.status, "Unreconciled")
		self.assertEqual(bank_transaction.unallocated_amount, 100)

	def test_voucher_creation_refuses_an_unknown_transaction(self):
		"""
		Each of these four endpoints resolved the caller's transaction name with a bare row lookup and then
		used the result without checking it - two indexed `frappe.db.get_values(...)[0]`, which raises
		`IndexError` on an empty list, and two attribute reads on a `frappe.db.get_value` result that is
		`None` when nothing matched, which raise `AttributeError`. Either way an unknown name became an
		HTTP 500 with a traceback, for what is only a caller naming something that is not there.

		`DoesNotExistError` is asserted rather than a generic validation error, because these endpoints must
		answer 404 like their siblings that resolve the same record through `frappe.get_doc`: the same
		mistake should get the same status whichever endpoint hears it.
		"""
		unknown = "ACC-BTN-does-not-exist"

		self.assertRaises(frappe.DoesNotExistError, create_journal_entry_bts, bank_transaction_name=unknown)
		self.assertRaises(frappe.DoesNotExistError, create_payment_entry_bts, bank_transaction_name=unknown)
		self.assertRaises(
			frappe.DoesNotExistError,
			create_bulk_internal_transfer,
			bank_transaction_names=[unknown],
			bank_account=self.bank_account,
		)
		self.assertRaises(
			frappe.DoesNotExistError,
			create_bulk_bank_entry_and_reconcile,
			bank_transactions=[unknown],
			account=self.bank,
		)

	def test_the_refusal_names_the_transaction_that_was_not_found(self):
		# In a BULK call the bad name may be one entry among many, so an answer that only says "not found"
		# leaves the caller to work out which one. Asserted on the message, not just the exception class.
		frappe.clear_messages()

		self.assertRaises(
			frappe.DoesNotExistError,
			create_bulk_internal_transfer,
			bank_transaction_names=["ACC-BTN-nope-77"],
			bank_account=self.bank_account,
		)

		messages = " ".join(str(entry.get("message", "")) for entry in frappe.get_message_log())
		self.assertIn("ACC-BTN-nope-77", messages)

	def test_get_linked_payments_refuses_an_absent_document_type_filter(self):
		"""
		`document_types` carries a default of `None`, but every path below it treats it as required: the
		candidate query set is assembled from membership tests against it, so `None` reached
		`check_matching` and raised `TypeError: argument of type 'NoneType' is not iterable`.

		It is refused rather than defaulted on purpose. Inventing a document-type set would return a
		DIFFERENT set of candidate vouchers than the caller asked for, and on a reconciliation screen a
		quietly wrong answer is worse than being told what was missing.
		"""
		bank_transaction = self.make_bank_transaction(date=today())

		self.assertRaises(
			frappe.ValidationError,
			get_linked_payments,
			bank_transaction_name=bank_transaction.name,
		)

		# The ordinary call still answers, so the refusal above is about the missing filter and nothing else.
		self.assertIsInstance(get_linked_payments(bank_transaction.name, ["payment_entry"]), list)

	def test_validate_vouchers_to_reconcile_accepts_a_permitted_voucher(self):
		# Every refusal above is only meaningful if the validator passes the ordinary case, so this
		# asserts the permitted path directly rather than only through the endpoint.
		payment = self._submitted_payment("validator-happy")

		validate_vouchers_to_reconcile(
			[{"payment_doctype": "Payment Entry", "payment_name": payment.name, "amount": 100}]
		)
