# Copyright (c) 2018, Frappe Technologies Pvt. Ltd. and Contributors
# See license.txt

import json

import frappe
from frappe import utils
from frappe.model.docstatus import DocStatus

from erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool import (
	get_linked_payments,
	reconcile_vouchers,
)
from erpnext.accounts.doctype.bank_transaction.bank_transaction import (
	refuse_missing_arguments,
	unreconcile_transaction_entry,
)
from erpnext.accounts.doctype.mode_of_payment.test_mode_of_payment import (
	set_default_account_for_mode_of_payment,
)
from erpnext.accounts.doctype.payment_entry.test_payment_entry import get_payment_entry
from erpnext.accounts.doctype.pos_profile.test_pos_profile import make_pos_profile
from erpnext.accounts.doctype.purchase_invoice.test_purchase_invoice import make_purchase_invoice
from erpnext.accounts.doctype.sales_invoice.test_sales_invoice import create_sales_invoice
from erpnext.tests.utils import ERPNextTestSuite, if_lending_app_installed


class TestBankTransaction(ERPNextTestSuite):
	def setUp(self):
		make_pos_profile()

		# generate and use a uniq hash identifier for 'Bank Account' and it's linked GL 'Account' to avoid validation error
		uniq_identifier = frappe.generate_hash(length=10)
		gl_account = create_gl_account("_Test Bank " + uniq_identifier)
		bank_account = create_bank_account(
			gl_account=gl_account, bank_account_name="Checking Account " + uniq_identifier
		)

		add_transactions(bank_account=bank_account)
		add_vouchers(gl_account=gl_account)

	# This test checks if ERPNext is able to provide a linked payment for a bank transaction based on the amount of the bank transaction.
	def test_linked_payments(self):
		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="Re 95282925234 FE/000002917 AT171513000281183046 Conrad Electronic"),
		)
		linked_payments = get_linked_payments(
			bank_transaction.name,
			["payment_entry", "exact_match"],
			from_date=bank_transaction.date,
			to_date=utils.today(),
		)
		self.assertEqual(linked_payments[0]["party"], "Conrad Electronic")

	# This test validates a simple reconciliation leading to the clearance of the bank transaction and the payment
	def test_reconcile(self):
		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000003025 OPSKATTUZWXXX AT776000000098709849 Herr G"),
		)
		payment = frappe.get_doc("Payment Entry", dict(party="Mr G", paid_amount=1700))
		vouchers = json.dumps(
			[
				{
					"payment_doctype": "Payment Entry",
					"payment_name": payment.name,
					"amount": bank_transaction.unallocated_amount,
				}
			]
		)
		reconcile_vouchers(bank_transaction.name, vouchers)

		unallocated_amount = frappe.db.get_value(
			"Bank Transaction", bank_transaction.name, "unallocated_amount"
		)
		self.assertEqual(unallocated_amount, 0)

		clearance_date = frappe.db.get_value("Payment Entry", payment.name, "clearance_date")
		self.assertIsNot(clearance_date, None)

		bank_transaction.reload()
		bank_transaction.cancel()

		clearance_date = frappe.db.get_value("Payment Entry", payment.name, "clearance_date")
		self.assertFalse(clearance_date)

	def test_cancel_voucher(self):
		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000003025 OPSKATTUZWXXX AT776000000098709849 Herr G"),
		)
		payment = frappe.get_doc("Payment Entry", dict(party="Mr G", paid_amount=1700))
		vouchers = json.dumps(
			[
				{
					"payment_doctype": "Payment Entry",
					"payment_name": payment.name,
					"amount": bank_transaction.unallocated_amount,
				}
			]
		)
		reconcile_vouchers(bank_transaction.name, vouchers)
		payment.reload()
		payment.cancel()
		bank_transaction.reload()
		self.assertEqual(bank_transaction.docstatus, DocStatus.submitted())
		self.assertEqual(bank_transaction.unallocated_amount, 1700)
		self.assertEqual(bank_transaction.payment_entries, [])

	# Amending a reconciled payment entry must not carry over its clearance date
	def test_clearance_date_cleared_on_amend(self):
		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000003025 OPSKATTUZWXXX AT776000000098709849 Herr G"),
		)
		payment = frappe.get_doc("Payment Entry", dict(party="Mr G", paid_amount=1700))
		vouchers = json.dumps(
			[
				{
					"payment_doctype": "Payment Entry",
					"payment_name": payment.name,
					"amount": bank_transaction.unallocated_amount,
				}
			]
		)
		reconcile_vouchers(bank_transaction.name, vouchers)

		self.assertTrue(frappe.db.get_value("Payment Entry", payment.name, "clearance_date"))

		payment.reload()
		payment.cancel()

		amended = frappe.copy_doc(payment)
		amended.amended_from = payment.name
		amended.docstatus = 0
		amended.insert()

		self.assertFalse(amended.clearance_date)

	# Check if ERPNext can correctly filter a linked payments based on the debit/credit amount
	def test_debit_credit_output(self):
		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="Auszahlung Karte MC/000002916 AUTOMAT 698769 K002 27.10. 14:07"),
		)
		linked_payments = get_linked_payments(
			bank_transaction.name,
			["payment_entry", "exact_match"],
			from_date=bank_transaction.date,
			to_date=utils.today(),
		)
		self.assertTrue(linked_payments[0]["paid_amount"])

	# Check error if already reconciled
	def test_already_reconciled(self):
		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000002918 OPSKATTUZWXXX AT776000000098709837 Herr G"),
		)
		payment = frappe.get_doc("Payment Entry", dict(party="Mr G", paid_amount=1200))
		vouchers = json.dumps(
			[
				{
					"payment_doctype": "Payment Entry",
					"payment_name": payment.name,
					"amount": bank_transaction.unallocated_amount,
				}
			]
		)
		reconcile_vouchers(bank_transaction.name, vouchers)

		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000002918 OPSKATTUZWXXX AT776000000098709837 Herr G"),
		)
		payment = frappe.get_doc("Payment Entry", dict(party="Mr G", paid_amount=1200))
		vouchers = json.dumps(
			[
				{
					"payment_doctype": "Payment Entry",
					"payment_name": payment.name,
					"amount": bank_transaction.unallocated_amount,
				}
			]
		)
		self.assertRaises(
			frappe.ValidationError,
			reconcile_vouchers,
			bank_transaction_name=bank_transaction.name,
			vouchers=vouchers,
		)

	def test_reconcile_refuses_a_currency_mismatch(self):
		"""
		The currency rule has to hold on the reconcile path, not only on insert.

		`validate()` - and with it `validate_currency()` - is never run for a submitted document, so
		before this guard `reconcile_vouchers` could post a transaction whose currency differs from its
		Bank Account's, which is exactly the mismatch the reconciliation UI raises an advisory about.
		"""
		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000003025 OPSKATTUZWXXX AT776000000098709849 Herr G"),
		)
		account_currency = frappe.get_cached_value(
			"Account",
			frappe.get_cached_value("Bank Account", bank_transaction.bank_account, "account"),
			"account_currency",
		)
		self.assertEqual(bank_transaction.currency, account_currency)

		# Planted with `db_set` on purpose: the mismatch has to exist on an ALREADY SUBMITTED document,
		# which is the state the insert-time validator cannot reach and legacy rows can genuinely be in.
		bank_transaction.db_set("currency", "USD", update_modified=False)
		self.assertNotEqual(
			frappe.db.get_value("Bank Transaction", bank_transaction.name, "currency"), account_currency
		)

		payment = frappe.get_doc("Payment Entry", dict(party="Mr G", paid_amount=1700))
		vouchers = json.dumps(
			[
				{
					"payment_doctype": "Payment Entry",
					"payment_name": payment.name,
					"amount": bank_transaction.unallocated_amount,
				}
			]
		)
		self.assertRaises(
			frappe.ValidationError,
			reconcile_vouchers,
			bank_transaction_name=bank_transaction.name,
			vouchers=vouchers,
		)

		# Nothing the refused `save()` would have written exists: no allocation row was persisted and
		# the voucher was left unclaimed. (`status` is deliberately not asserted here - `set_status()`
		# writes it through `db_set` BEFORE `save()` is reached, and that write is undone by the
		# request-level rollback `frappe.throw` triggers, not by this call returning.)
		bank_transaction.reload()
		self.assertEqual(bank_transaction.payment_entries, [])
		self.assertIsNone(
			frappe.db.get_value(
				"Bank Transaction Payments",
				{"parent": bank_transaction.name, "payment_entry": payment.name},
				"name",
			)
		)

	def test_reconcile_allows_a_matching_currency(self):
		# The refusal above is only meaningful if the matching-currency path still posts.
		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000003025 OPSKATTUZWXXX AT776000000098709849 Herr G"),
		)
		payment = frappe.get_doc("Payment Entry", dict(party="Mr G", paid_amount=1700))
		vouchers = json.dumps(
			[
				{
					"payment_doctype": "Payment Entry",
					"payment_name": payment.name,
					"amount": bank_transaction.unallocated_amount,
				}
			]
		)
		reconcile_vouchers(bank_transaction.name, vouchers)

		bank_transaction.reload()
		self.assertEqual(bank_transaction.status, "Reconciled")
		self.assertEqual(bank_transaction.unallocated_amount, 0)

	def test_reconcile_refuses_a_draft_transaction(self):
		"""
		Only a submitted transaction may be reconciled.

		`set_status` derives `status` from `docstatus` and writes nothing at all for a draft, so before
		this guard a draft accepted the whole reconciliation - child row, allocation, cleared voucher -
		while still reporting "Pending". Nothing downstream could then tell that the money had been
		claimed against a transaction the ledger had never seen.
		"""
		submitted = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000003025 OPSKATTUZWXXX AT776000000098709849 Herr G"),
		)
		draft = frappe.get_doc(
			{
				"doctype": "Bank Transaction",
				"description": "draft transaction that must not be reconcilable",
				"date": submitted.date,
				"deposit": 1700,
				"currency": submitted.currency,
				"bank_account": submitted.bank_account,
			}
		).insert()
		self.assertTrue(draft.docstatus.is_draft())

		payment = frappe.get_doc("Payment Entry", dict(party="Mr G", paid_amount=1700))
		vouchers = json.dumps(
			[
				{
					"payment_doctype": "Payment Entry",
					"payment_name": payment.name,
					"amount": draft.unallocated_amount,
				}
			]
		)
		self.assertRaises(
			frappe.ValidationError,
			reconcile_vouchers,
			bank_transaction_name=draft.name,
			vouchers=vouchers,
		)

		# Refused before the first `append`, so none of the three things a reconciliation writes exist.
		draft.reload()
		self.assertEqual(draft.payment_entries, [])
		self.assertEqual(draft.allocated_amount, 0)
		self.assertEqual(draft.unallocated_amount, 1700)
		self.assertEqual(draft.status, "Pending")
		self.assertIsNone(frappe.db.get_value("Payment Entry", payment.name, "clearance_date"))

	def test_over_allocated_voucher_is_reported_as_a_validation_error(self):
		"""
		The over-allocation refusal has to reach the caller as the validation error it is.

		Its message carries two placeholders but was given one argument, so `str.format` raised
		`IndexError: Replacement index 1 out of range` from inside the refusal itself: the request
		answered HTTP 500 with a formatting bug, and the reviewer learned neither which voucher was
		over-allocated nor by how much. The rollback was always correct - only the answer was not.
		"""
		first = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000002918 OPSKATTUZWXXX AT776000000098709837 Herr G"),
		)
		payment = frappe.get_doc("Payment Entry", dict(party="Mr G", paid_amount=1200))
		reconcile_vouchers(
			first.name,
			json.dumps(
				[
					{
						"payment_doctype": "Payment Entry",
						"payment_name": payment.name,
						"amount": first.unallocated_amount,
					}
				]
			),
		)

		# Drift the persisted allocation past the voucher's own amount. This is the state that makes
		# `get_clearance_details` return a negative allocable amount for the next transaction, and it is
		# reachable in real data whenever a voucher is amended after it was allocated.
		allocation = frappe.db.get_value("Bank Transaction Payments", {"parent": first.name}, "name")
		frappe.db.set_value(
			"Bank Transaction Payments", allocation, "allocated_amount", 1201, update_modified=False
		)

		second = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000003025 OPSKATTUZWXXX AT776000000098709849 Herr G"),
		)
		before = frappe.db.get_value(
			"Bank Transaction", second.name, ["status", "allocated_amount", "unallocated_amount"]
		)

		with self.assertRaises(frappe.ValidationError) as refusal:
			reconcile_vouchers(
				second.name,
				json.dumps(
					[
						{
							"payment_doctype": "Payment Entry",
							"payment_name": payment.name,
							"amount": second.unallocated_amount,
						}
					]
				),
			)

		# The refusal names the voucher and the amount, which is what the failed `format` call could not.
		message = frappe.utils.strip_html(str(refusal.exception))
		self.assertIn("over-allocated", message)
		self.assertIn(payment.name, message)

		# And the transaction it refused is byte-identical to how it started.
		self.assertEqual(
			frappe.db.get_value(
				"Bank Transaction", second.name, ["status", "allocated_amount", "unallocated_amount"]
			),
			before,
		)
		self.assertIsNone(
			frappe.db.get_value(
				"Bank Transaction Payments",
				{"parent": second.name, "payment_entry": payment.name},
				"name",
			)
		)

	def test_unreconcile_entry_undoes_a_linked_voucher(self):
		# The refusal below is only meaningful if the ordinary undo still works.
		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000003025 OPSKATTUZWXXX AT776000000098709849 Herr G"),
		)
		payment = frappe.get_doc("Payment Entry", dict(party="Mr G", paid_amount=1700))
		reconcile_vouchers(
			bank_transaction.name,
			json.dumps(
				[
					{
						"payment_doctype": "Payment Entry",
						"payment_name": payment.name,
						"amount": bank_transaction.unallocated_amount,
					}
				]
			),
		)
		bank_transaction.reload()
		self.assertEqual(len(bank_transaction.payment_entries), 1)

		self.assertEqual(
			unreconcile_transaction_entry(bank_transaction.name, "Payment Entry", payment.name),
			{"success": True},
		)

		bank_transaction.reload()
		self.assertEqual(bank_transaction.payment_entries, [])
		self.assertEqual(bank_transaction.unallocated_amount, 1700)

	def test_unreconcile_entry_refuses_a_voucher_that_is_not_linked(self):
		"""
		`{"success": True}` was returned unconditionally, even when the loop matched nothing.

		So asking to undo a voucher that had never been linked to this transaction reported a successful
		undo while changing nothing - and a caller reconciling its own view from that answer would drop a
		link the server still holds.
		"""
		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="1512567 BG/000003025 OPSKATTUZWXXX AT776000000098709849 Herr G"),
		)
		unlinked = frappe.get_doc("Payment Entry", dict(party="Mr G", paid_amount=1200))
		self.assertEqual(bank_transaction.payment_entries, [])

		before = frappe.db.get_value(
			"Bank Transaction", bank_transaction.name, ["status", "allocated_amount", "unallocated_amount"]
		)

		with self.assertRaises(frappe.ValidationError) as refusal:
			unreconcile_transaction_entry(bank_transaction.name, "Payment Entry", unlinked.name)

		self.assertIn(unlinked.name, frappe.utils.strip_html(str(refusal.exception)))

		# Refused without touching either side.
		self.assertEqual(
			frappe.db.get_value(
				"Bank Transaction",
				bank_transaction.name,
				["status", "allocated_amount", "unallocated_amount"],
			),
			before,
		)
		self.assertEqual(frappe.db.get_value("Payment Entry", unlinked.name, "docstatus"), 1)

	# Raise an error if debitor transaction vs debitor payment
	def test_clear_sales_invoice(self):
		bank_transaction = frappe.get_doc(
			"Bank Transaction",
			dict(description="I2015000011 VD/000002514 ATWWXXX AT4701345000003510057 Bio"),
		)
		payment = frappe.get_doc("Sales Invoice", dict(customer="Fayva", status=["=", "Paid"]))
		vouchers = json.dumps(
			[
				{
					"payment_doctype": "Sales Invoice",
					"payment_name": payment.name,
					"amount": bank_transaction.unallocated_amount,
				}
			]
		)
		reconcile_vouchers(bank_transaction.name, vouchers=vouchers)

		self.assertEqual(
			frappe.db.get_value("Bank Transaction", bank_transaction.name, "unallocated_amount"), 0
		)
		self.assertIsNot(
			frappe.db.get_value("Sales Invoice Payment", dict(parent=payment.name), "clearance_date"), None
		)

	@if_lending_app_installed
	def test_matching_loan_repayment(self):
		from lending.loan_management.doctype.loan.test_loan import create_loan_accounts

		create_loan_accounts()
		bank_account = frappe.get_doc(
			{
				"doctype": "Bank Account",
				"account_name": "Payment Account",
				"bank": "Citi Bank",
				"account": "Payment Account - _TC",
			}
		).insert(ignore_if_duplicate=True)

		bank_transaction = frappe.get_doc(
			{
				"doctype": "Bank Transaction",
				"description": "Loan Repayment - OPSKATTUZWXXX AT776000000098709837 Herr G",
				"date": "2018-10-27",
				"deposit": 500,
				"currency": "INR",
				"bank_account": bank_account.name,
			}
		).submit()

		repayment_entry = create_loan_and_repayment()

		linked_payments = get_linked_payments(bank_transaction.name, ["loan_repayment", "exact_match"])
		self.assertEqual(linked_payments[0]["name"], repayment_entry.name)

	def test_missing_argument_is_refused_rather_than_raised(self):
		"""
		Every whitelisted banking method is reachable over `/api/method/...`, and a request that omits a
		required argument used to reach the function and raise a plain `TypeError`. Frappe has no special
		handling for that, so it became an HTTP 500 carrying the server traceback. Measured against a
		running site before the guard: 26 of the 28 module-level whitelisted methods across the four
		banking DocTypes answered 500 that way.

		`ValidationError` is what `frappe.throw` raises, and it is what turns the same request into an
		ordinary 4xx whose message travels in `_server_messages` with no traceback attached.
		"""

		@refuse_missing_arguments
		def needs_two(first, second=None):
			return first, second

		self.assertRaises(frappe.ValidationError, needs_two)

	def test_the_refusal_names_every_missing_argument_at_once(self):
		# Named from the signature rather than parsed out of Python's TypeError text, so the caller learns
		# about all of them in one answer instead of one request at a time.
		@refuse_missing_arguments
		def needs_three(alpha, beta, gamma=None):
			return alpha, beta, gamma

		frappe.clear_messages()
		self.assertRaises(frappe.ValidationError, needs_three)

		messages = " ".join(str(entry.get("message", "")) for entry in frappe.get_message_log())
		self.assertIn("alpha", messages)
		self.assertIn("beta", messages)
		# `gamma` has a default, so it was never required and must not be reported as missing.
		self.assertNotIn("gamma", messages)

	def test_a_supplied_argument_is_not_reported_missing(self):
		# By keyword and by position, because HTTP dispatch supplies keywords while the internal callers in
		# these modules supply positions, and both must satisfy the guard.
		@refuse_missing_arguments
		def needs_two(first, second):
			return first, second

		self.assertEqual(needs_two(1, 2), (1, 2))
		self.assertEqual(needs_two(first=1, second=2), (1, 2))
		self.assertEqual(needs_two(1, second=2), (1, 2))

	def test_none_counts_as_supplied(self):
		# The guard answers "was a value given", not "is the value useful". A method that wants to reject
		# `None` specifically has to say so itself - which is what `get_linked_payments` does for
		# `document_types`, because every path in it treats that parameter as required.
		@refuse_missing_arguments
		def needs_one(first):
			return first

		self.assertIsNone(needs_one(None))

	def test_the_guard_keeps_the_signature_frappe_dispatches_against(self):
		"""
		`frappe.whitelist()` wraps a method in `validate_argument_types`, and Frappe's `get_newargs`
		filters incoming form data down to the parameters a method accepts. Both resolve the signature
		through `inspect`, which follows `functools.wraps`' `__wrapped__`. If the guard did not preserve
		that, every decorated endpoint would either stop coercing its arguments or stop accepting them.
		"""
		import inspect

		def documented(first: str, second: int = 3) -> str:
			return f"{first}{second}"

		guarded = refuse_missing_arguments(documented)

		self.assertEqual(inspect.signature(guarded), inspect.signature(documented))
		self.assertEqual(guarded.__annotations__, documented.__annotations__)
		self.assertEqual(guarded.__name__, documented.__name__)
		self.assertIs(guarded.__wrapped__, documented)

	def test_an_unexpected_keyword_is_refused_rather_than_raised(self):
		# Unreachable over HTTP, because Frappe filters form data to the signature before dispatching, so
		# this only ever answers an internal caller - and answers it with a sentence, not a traceback.
		@refuse_missing_arguments
		def needs_one(first):
			return first

		self.assertRaises(frappe.ValidationError, needs_one, 1, unexpected=2)

	def test_too_many_positional_arguments_are_refused_rather_than_raised(self):
		@refuse_missing_arguments
		def needs_one(first):
			return first

		self.assertRaises(frappe.ValidationError, needs_one, 1, 2, 3)


def create_bank_account(
	bank_name="Citi Bank", gl_account="_Test Bank - _TC", bank_account_name="Checking Account"
):
	try:
		frappe.get_doc(
			{
				"doctype": "Bank",
				"bank_name": bank_name,
			}
		).insert(ignore_if_duplicate=True)
	except frappe.DuplicateEntryError:
		pass

	try:
		bank_account = frappe.get_doc(
			{
				"doctype": "Bank Account",
				"account_name": bank_account_name,
				"bank": bank_name,
				"account": gl_account,
			}
		).insert(ignore_if_duplicate=True)
	except frappe.DuplicateEntryError:
		pass

	return bank_account.name


def create_gl_account(gl_account_name="_Test Bank - _TC"):
	gl_account = frappe.get_doc(
		{
			"doctype": "Account",
			"company": "_Test Company",
			"parent_account": "Current Assets - _TC",
			"account_type": "Bank",
			"is_group": 0,
			"account_name": gl_account_name,
		}
	).insert()
	return gl_account.name


def add_transactions(bank_account="_Test Bank - _TC"):
	doc = frappe.get_doc(
		{
			"doctype": "Bank Transaction",
			"description": "1512567 BG/000002918 OPSKATTUZWXXX AT776000000098709837 Herr G",
			"date": "2018-10-23",
			"deposit": 1200,
			"currency": "INR",
			"bank_account": bank_account,
		}
	).insert()
	doc.submit()

	doc = frappe.get_doc(
		{
			"doctype": "Bank Transaction",
			"description": "1512567 BG/000003025 OPSKATTUZWXXX AT776000000098709849 Herr G",
			"date": "2018-10-23",
			"deposit": 1700,
			"currency": "INR",
			"bank_account": bank_account,
		}
	).insert()
	doc.submit()

	doc = frappe.get_doc(
		{
			"doctype": "Bank Transaction",
			"description": "Re 95282925234 FE/000002917 AT171513000281183046 Conrad Electronic",
			"date": "2018-10-26",
			"withdrawal": 690,
			"currency": "INR",
			"bank_account": bank_account,
		}
	).insert()
	doc.submit()

	doc = frappe.get_doc(
		{
			"doctype": "Bank Transaction",
			"description": "Auszahlung Karte MC/000002916 AUTOMAT 698769 K002 27.10. 14:07",
			"date": "2018-10-27",
			"deposit": 3900,
			"currency": "INR",
			"bank_account": bank_account,
		}
	).insert()
	doc.submit()

	doc = frappe.get_doc(
		{
			"doctype": "Bank Transaction",
			"description": "I2015000011 VD/000002514 ATWWXXX AT4701345000003510057 Bio",
			"date": "2018-10-27",
			"withdrawal": 109080,
			"currency": "INR",
			"bank_account": bank_account,
		}
	).insert()
	doc.submit()


def add_vouchers(gl_account="_Test Bank - _TC"):
	try:
		frappe.get_doc(
			{
				"doctype": "Supplier",
				"supplier_group": "All Supplier Groups",
				"supplier_type": "Company",
				"supplier_name": "Conrad Electronic",
			}
		).insert(ignore_if_duplicate=True)

	except frappe.DuplicateEntryError:
		pass

	pi = make_purchase_invoice(supplier="Conrad Electronic", qty=1, rate=690)

	pe = get_payment_entry("Purchase Invoice", pi.name, bank_account=gl_account)
	pe.reference_no = "Conrad Oct 18"
	pe.reference_date = "2018-10-24"
	pe.insert()
	pe.submit()

	try:
		frappe.get_doc(
			{
				"doctype": "Supplier",
				"supplier_group": "All Supplier Groups",
				"supplier_type": "Company",
				"supplier_name": "Mr G",
			}
		).insert(ignore_if_duplicate=True)
	except frappe.DuplicateEntryError:
		pass

	pi = make_purchase_invoice(supplier="Mr G", qty=1, rate=1200)
	pe = get_payment_entry("Purchase Invoice", pi.name, bank_account=gl_account)
	pe.reference_no = "Herr G Oct 18"
	pe.reference_date = "2018-10-24"
	pe.insert()
	pe.submit()

	pi = make_purchase_invoice(supplier="Mr G", qty=1, rate=1700)
	pe = get_payment_entry("Purchase Invoice", pi.name, bank_account=gl_account)
	pe.reference_no = "Herr G Nov 18"
	pe.reference_date = "2018-11-01"
	pe.insert()
	pe.submit()

	try:
		frappe.get_doc(
			{
				"doctype": "Supplier",
				"supplier_group": "All Supplier Groups",
				"supplier_type": "Company",
				"supplier_name": "Poore Simon's",
			}
		).insert(ignore_if_duplicate=True)
	except frappe.DuplicateEntryError:
		pass

	try:
		frappe.get_doc(
			{
				"doctype": "Customer",
				"customer_group": "Individual",
				"customer_type": "Company",
				"customer_name": "Poore Simon's",
			}
		).insert(ignore_if_duplicate=True)
	except frappe.DuplicateEntryError:
		pass

	pi = make_purchase_invoice(supplier="Poore Simon's", qty=1, rate=3900, is_paid=1, do_not_save=1)
	pi.cash_bank_account = gl_account
	pi.insert()
	pi.submit()
	pe = get_payment_entry("Purchase Invoice", pi.name, bank_account=gl_account)
	pe.reference_no = "Poore Simon's Oct 18"
	pe.reference_date = "2018-10-28"
	pe.paid_amount = 690
	pe.received_amount = 690
	pe.insert()
	pe.submit()

	si = create_sales_invoice(customer="Poore Simon's", qty=1, rate=3900)
	pe = get_payment_entry("Sales Invoice", si.name, bank_account=gl_account)
	pe.reference_no = "Poore Simon's Oct 18"
	pe.reference_date = "2018-10-28"
	pe.insert()
	pe.submit()

	try:
		frappe.get_doc(
			{
				"doctype": "Customer",
				"customer_group": "Individual",
				"customer_type": "Company",
				"customer_name": "Fayva",
			}
		).insert(ignore_if_duplicate=True)
	except frappe.DuplicateEntryError:
		pass

	mode_of_payment = frappe.get_doc({"doctype": "Mode of Payment", "name": "Wire Transfer"})

	set_default_account_for_mode_of_payment(mode_of_payment, "_Test Company", gl_account)

	si = create_sales_invoice(customer="Fayva", qty=1, rate=109080, do_not_save=1)
	si.is_pos = 1
	si.append("payments", {"mode_of_payment": "Wire Transfer", "amount": 109080})
	si.insert()
	si.submit()


@if_lending_app_installed
def create_loan_and_repayment():
	from lending.loan_management.doctype.loan.test_loan import (
		create_loan,
		create_loan_product,
		create_repayment_entry,
		make_loan_disbursement_entry,
	)
	from lending.loan_management.doctype.process_loan_interest_accrual.process_loan_interest_accrual import (
		process_loan_interest_accrual_for_term_loans,
	)

	from erpnext.setup.doctype.employee.test_employee import make_employee

	create_loan_product(
		"Personal Loan",
		"Personal Loan",
		500000,
		8.4,
		is_term_loan=1,
		mode_of_payment="Cash",
		disbursement_account="Disbursement Account - _TC",
		payment_account="Payment Account - _TC",
		loan_account="Loan Account - _TC",
		interest_income_account="Interest Income Account - _TC",
		penalty_income_account="Penalty Income Account - _TC",
	)

	applicant = make_employee("test_bank_reco@loan.com", company="_Test Company")
	loan = create_loan(applicant, "Personal Loan", 5000, "Repay Over Number of Periods", 20)
	loan = frappe.get_doc(
		{
			"doctype": "Loan",
			"applicant_type": "Employee",
			"company": "_Test Company",
			"applicant": applicant,
			"loan_product": "Personal Loan",
			"loan_amount": 5000,
			"repayment_method": "Repay Fixed Amount per Period",
			"monthly_repayment_amount": 500,
			"repayment_start_date": "2018-09-27",
			"is_term_loan": 1,
			"posting_date": "2018-09-27",
		}
	).insert()

	make_loan_disbursement_entry(loan.name, loan.loan_amount, disbursement_date="2018-09-27")
	process_loan_interest_accrual_for_term_loans(posting_date="2018-10-27")

	repayment_entry = create_repayment_entry(
		loan.name,
		applicant,
		"2018-10-27",
		500,
	)
	repayment_entry.submit()
	return repayment_entry
