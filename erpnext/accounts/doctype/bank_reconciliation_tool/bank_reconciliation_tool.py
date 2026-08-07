# Copyright (c) 2020, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import json
from datetime import date

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.query_builder.custom import ConstantColumn
from frappe.query_builder.functions import Max, Sum
from frappe.utils import cint, create_batch, flt, getdate

from erpnext import get_default_cost_center
from erpnext.accounts.doctype.bank_transaction.bank_transaction import get_total_allocated_amount
from erpnext.accounts.party import get_party_account
from erpnext.accounts.report.bank_reconciliation_statement.bank_reconciliation_statement import (
	get_amounts_not_reflected_in_system,
	get_entries,
)
from erpnext.accounts.utils import get_account_currency, get_balance_on
from erpnext.setup.utils import get_exchange_rate


class BankReconciliationTool(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		account_currency: DF.Link | None
		account_opening_balance: DF.Currency
		bank_account: DF.Link | None
		bank_statement_closing_balance: DF.Currency
		bank_statement_from_date: DF.Date | None
		bank_statement_to_date: DF.Date | None
		company: DF.Link | None
		filter_by_reference_date: DF.Check
		from_reference_date: DF.Date | None
		to_reference_date: DF.Date | None
	# end: auto-generated types

	pass


@frappe.whitelist()
def get_bank_transactions(
	bank_account: str,
	from_date: str | date | None = None,
	to_date: str | date | None = None,
	all_transactions: bool = False,
):
	# returns bank transactions for a bank account
	filters = []
	filters.append(["bank_account", "=", bank_account])
	filters.append(["docstatus", "=", 1])
	if not all_transactions:
		filters.append(["unallocated_amount", ">", 0.0])
	# `getdate` normalises the boundaries and rejects anything that is not a date. Passed through raw,
	# a value like "not-a-date" or an impossible "2026-13-45" reached the database, which discarded the
	# comparison instead of failing it - so the request answered HTTP 200 with EVERY transaction on the
	# account, silently ignoring the window the caller asked for. Only truthy values are normalised, so
	# an omitted or blank boundary still means "no bound" rather than `getdate`'s today.
	if to_date:
		filters.append(["date", "<=", getdate(to_date)])
	if from_date:
		filters.append(["date", ">=", getdate(from_date)])
	transactions = frappe.get_list(
		"Bank Transaction",
		fields=[
			"date",
			"deposit",
			"withdrawal",
			"currency",
			"description",
			"transaction_type",
			"name",
			"bank_account",
			"company",
			"allocated_amount",
			"unallocated_amount",
			"reference_number",
			"party_type",
			"party",
			"status",
			"matched_transaction_rule",
		],
		filters=filters,
		order_by="date",
	)
	return transactions


@frappe.whitelist()
def get_account_balance(bank_account: str, till_date: str | date, company: str):
	# returns account balance till the specified date
	frappe.has_permission("Bank Account", "read", bank_account, throw=True)
	account = frappe.db.get_value("Bank Account", bank_account, "account")

	if not account:
		# `has_permission` above passes for a name that does not exist, so an unknown Bank Account used
		# to fall through with `account = None` and return a confident 0.0 - a balance the caller had no
		# way to tell apart from a genuinely empty account.
		frappe.throw(
			_("Bank Account {0} does not exist").format(frappe.bold(bank_account)),
			frappe.DoesNotExistError,
			title=_("Not Found"),
		)

	# The company is a property of the account, never of the request. `company` reaches
	# `get_entries`/`get_amounts_not_reflected_in_system`, which scope their voucher queries by it, so a
	# caller who named a DIFFERENT company (or one that does not exist at all) was answered with a
	# plausible but wrong balance for this account rather than an error. Derive it from the account -
	# the same `Bank Account` -> `Account` -> `company` route the voucher creators in this module use -
	# and refuse a client value that disagrees instead of quietly preferring either one.
	account_company = frappe.get_cached_value("Account", account, "company")

	if company and company != account_company:
		frappe.throw(
			_("Bank Account {0} belongs to {1}, not {2}").format(
				frappe.bold(bank_account), frappe.bold(account_company), frappe.bold(company)
			),
			title=_("Company Mismatch"),
		)

	filters = frappe._dict(
		{
			"account": account,
			"report_date": till_date,
			"include_pos_transactions": 1,
			"company": account_company,
		}
	)
	data = get_entries(filters)

	balance_as_per_system = get_balance_on(filters["account"], filters["report_date"])

	total_debit, total_credit = 0.0, 0.0
	for d in data:
		total_debit += flt(d.debit)
		total_credit += flt(d.credit)

	amounts_not_reflected_in_system = get_amounts_not_reflected_in_system(filters)

	return flt(balance_as_per_system) - flt(total_debit) + flt(total_credit) + amounts_not_reflected_in_system


@frappe.whitelist(methods=["POST"])
def update_bank_transaction(
	bank_transaction_name: str, reference_number: str, party_type: str | None = None, party: str | None = None
):
	# updates bank transaction based on the new parameters provided by the user from Vouchers
	bank_transaction = frappe.get_doc("Bank Transaction", bank_transaction_name)
	bank_transaction.reference_number = reference_number
	bank_transaction.party_type = party_type
	bank_transaction.party = party
	bank_transaction.save()
	return frappe.db.get_all(
		"Bank Transaction",
		filters={"name": bank_transaction_name},
		fields=[
			"date",
			"deposit",
			"withdrawal",
			"currency",
			"description",
			"name",
			"bank_account",
			"company",
			"unallocated_amount",
			"reference_number",
			"party_type",
			"party",
		],
	)[0]


@frappe.whitelist(methods=["POST"])
def create_journal_entry_bts(
	bank_transaction_name: str,
	reference_number: str | None = None,
	reference_date: str | None = None,
	posting_date: str | date | None = None,
	entry_type: str | None = None,
	second_account: str | None = None,
	mode_of_payment: str | None = None,
	party_type: str | None = None,
	party: str | None = None,
	allow_edit: bool | None = None,
):
	# Create a new journal entry based on the bank transaction
	bank_transaction = frappe.db.get_values(
		"Bank Transaction",
		bank_transaction_name,
		fieldname=["name", "deposit", "withdrawal", "bank_account", "currency"],
		as_dict=True,
	)[0]
	company_account = frappe.get_value("Bank Account", bank_transaction.bank_account, "account")
	account_type = frappe.db.get_value("Account", second_account, "account_type")
	if account_type in ["Receivable", "Payable"]:
		if not (party_type and party):
			frappe.throw(
				_("Party Type and Party is required for Receivable / Payable account {0}").format(
					second_account
				)
			)

	company = frappe.get_value("Account", company_account, "company")
	company_default_currency = frappe.get_cached_value("Company", company, "default_currency")
	company_account_currency = frappe.get_cached_value("Account", company_account, "account_currency")
	second_account_currency = frappe.get_cached_value("Account", second_account, "account_currency")

	# determine if multi-currency Journal or not
	is_multi_currency = (
		True
		if company_default_currency != company_account_currency
		or company_default_currency != second_account_currency
		or company_default_currency != bank_transaction.currency
		else False
	)

	accounts = []
	second_account_dict = {
		"account": second_account,
		"account_currency": second_account_currency,
		"credit_in_account_currency": bank_transaction.deposit,
		"debit_in_account_currency": bank_transaction.withdrawal,
		"party_type": party_type,
		"party": party,
		"cost_center": get_default_cost_center(company),
	}

	company_account_dict = {
		"account": company_account,
		"account_currency": company_account_currency,
		"bank_account": bank_transaction.bank_account,
		"credit_in_account_currency": bank_transaction.withdrawal,
		"debit_in_account_currency": bank_transaction.deposit,
		"cost_center": get_default_cost_center(company),
	}

	# convert transaction amount to company currency
	if is_multi_currency:
		exc_rate = get_exchange_rate(bank_transaction.currency, company_default_currency, posting_date)
		withdrawal_in_company_currency = flt(exc_rate * abs(bank_transaction.withdrawal))
		deposit_in_company_currency = flt(exc_rate * abs(bank_transaction.deposit))
	else:
		withdrawal_in_company_currency = bank_transaction.withdrawal
		deposit_in_company_currency = bank_transaction.deposit

	# if second account is of foreign currency, convert and set debit and credit fields.
	if second_account_currency != company_default_currency:
		exc_rate = get_exchange_rate(second_account_currency, company_default_currency, posting_date)
		second_account_dict.update(
			{
				"exchange_rate": exc_rate,
				"credit": deposit_in_company_currency,
				"debit": withdrawal_in_company_currency,
				"credit_in_account_currency": flt(deposit_in_company_currency / exc_rate) or 0,
				"debit_in_account_currency": flt(withdrawal_in_company_currency / exc_rate) or 0,
			}
		)
	else:
		second_account_dict.update(
			{
				"exchange_rate": 1,
				"credit": deposit_in_company_currency,
				"debit": withdrawal_in_company_currency,
				"credit_in_account_currency": deposit_in_company_currency,
				"debit_in_account_currency": withdrawal_in_company_currency,
			}
		)

	# if company account is of foreign currency, convert and set debit and credit fields.
	if company_account_currency != company_default_currency:
		exc_rate = get_exchange_rate(company_account_currency, company_default_currency, posting_date)
		company_account_dict.update(
			{
				"exchange_rate": exc_rate,
				"credit": withdrawal_in_company_currency,
				"debit": deposit_in_company_currency,
			}
		)
	else:
		company_account_dict.update(
			{
				"exchange_rate": 1,
				"credit": withdrawal_in_company_currency,
				"debit": deposit_in_company_currency,
				"credit_in_account_currency": withdrawal_in_company_currency,
				"debit_in_account_currency": deposit_in_company_currency,
			}
		)

	accounts.append(second_account_dict)
	accounts.append(company_account_dict)

	journal_entry_dict = {
		"voucher_type": entry_type,
		"company": company,
		"posting_date": posting_date,
		"cheque_date": reference_date,
		"cheque_no": reference_number,
		"mode_of_payment": mode_of_payment,
	}
	if is_multi_currency:
		journal_entry_dict.update({"multi_currency": True})

	journal_entry = frappe.new_doc("Journal Entry")
	journal_entry.update(journal_entry_dict)
	journal_entry.set("accounts", accounts)

	if allow_edit:
		return journal_entry

	journal_entry.insert()
	journal_entry.submit()

	if bank_transaction.deposit > 0.0:
		paid_amount = bank_transaction.deposit
	else:
		paid_amount = bank_transaction.withdrawal

	vouchers = json.dumps(
		[
			{
				"payment_doctype": "Journal Entry",
				"payment_name": journal_entry.name,
				"amount": paid_amount,
			}
		]
	)

	return reconcile_vouchers(bank_transaction_name, vouchers, is_new_voucher=True)


@frappe.whitelist(methods=["POST"])
def create_payment_entry_bts(
	bank_transaction_name: str,
	reference_number: str | None = None,
	reference_date: str | None = None,
	party_type: str | None = None,
	party: str | None = None,
	posting_date: str | None = None,
	mode_of_payment: str | None = None,
	project: str | None = None,
	cost_center: str | None = None,
	allow_edit: bool | None = None,
	company_bank_account: str | None = None,
):
	# Create a new payment entry based on the bank transaction
	bank_transaction = frappe.db.get_values(
		"Bank Transaction",
		bank_transaction_name,
		fieldname=["name", "unallocated_amount", "deposit", "bank_account", "currency"],
		as_dict=True,
	)[0]

	payment_type = "Receive" if bank_transaction.deposit > 0.0 else "Pay"

	bank_account = frappe.get_cached_value("Bank Account", bank_transaction.bank_account, "account")
	company = frappe.get_cached_value("Account", bank_account, "company")
	party_account = get_party_account(party_type, party, company)

	bank_currency = bank_transaction.currency
	party_currency = frappe.get_cached_value("Account", party_account, "account_currency")

	exc_rate = get_exchange_rate(bank_currency, party_currency, posting_date)

	amt_in_bank_acc_currency = bank_transaction.unallocated_amount
	amount_in_party_currency = bank_transaction.unallocated_amount * exc_rate

	pe = frappe.new_doc("Payment Entry")
	pe.payment_type = payment_type
	pe.company = company
	pe.reference_no = reference_number
	pe.reference_date = reference_date
	pe.party_type = party_type
	pe.party = party
	pe.posting_date = posting_date
	pe.paid_from = party_account if payment_type == "Receive" else bank_account
	pe.paid_to = party_account if payment_type == "Pay" else bank_account
	pe.paid_from_account_currency = party_currency if payment_type == "Receive" else bank_currency
	pe.paid_to_account_currency = party_currency if payment_type == "Pay" else bank_currency
	pe.paid_amount = amount_in_party_currency if payment_type == "Receive" else amt_in_bank_acc_currency
	pe.received_amount = amount_in_party_currency if payment_type == "Pay" else amt_in_bank_acc_currency
	pe.mode_of_payment = mode_of_payment
	pe.project = project
	pe.cost_center = cost_center

	if company_bank_account:
		pe.bank_account = company_bank_account

	pe.validate()

	if allow_edit:
		return pe

	pe.insert()
	pe.submit()

	vouchers = json.dumps(
		[
			{
				"payment_doctype": "Payment Entry",
				"payment_name": pe.name,
				"amount": amt_in_bank_acc_currency,
			}
		]
	)
	return reconcile_vouchers(bank_transaction_name, vouchers, is_new_voucher=True)


# APIs for new bank reconciliation tool (/banking)


@frappe.whitelist(methods=["GET"])
def get_older_unreconciled_transactions(bank_account: str, from_date: str):
	"""
	Get number of unreconciled transactions before a given date for a bank account
	"""
	filters = {
		"bank_account": bank_account,
		"date": ["<", from_date],
		"docstatus": 1,
		"unallocated_amount": [">", 0.0],
	}

	# One permission-aware query answers both halves. `frappe.db.count` applies no permission
	# conditions, so counting through it would report rows the caller cannot see - which both leaks
	# the existence of another tenant's backlog and, when the count is non-zero but the permitted
	# list is empty, indexes an empty result. `frappe.get_list` applies the permission query,
	# `frappe.get_all` deliberately does not.
	older_transactions = frappe.get_list(
		"Bank Transaction",
		filters=filters,
		fields=["date"],
		order_by="date asc",
		limit_page_length=0,
	)

	if not older_transactions:
		return {"count": 0, "oldest_date": None}

	return {"count": len(older_transactions), "oldest_date": older_transactions[0].date}


def validate_reconciliation_voucher_type(payment_document: str) -> None:
	"""
	Confirm `payment_document` names a DocType the bank-reconciliation surface actually deals in.

	The value arrives from the client and used to be handed straight to `frappe.db.set_value`, so a
	name that is not a DocType at all answered HTTP 500 with a bare "DocType X not found", and any
	DocType on the site carrying a `clearance_date` was writable through this endpoint. The permitted
	set is the hook the reconciliation surface itself is built from, so it stays in step with the
	voucher types on offer instead of duplicating a list.
	"""
	permitted = set(frappe.get_hooks("bank_reconciliation_doctypes") or [])

	if payment_document not in permitted:
		frappe.throw(
			_("{0} is not a voucher type that can be reconciled against a bank transaction").format(
				frappe.bold(payment_document)
			),
			title=_("Invalid Voucher Type"),
		)


@frappe.whitelist(methods=["POST"])
def update_clearance_date(
	payment_document: str, payment_entry: str, account: str, clearance_date: str | None
):
	"""
	Update the clearance date of a voucher
	"""

	if not clearance_date:
		clearance_date = None

	# Check for permissions
	frappe.has_permission("Bank Clearance", ptype="write", throw=True)

	validate_reconciliation_voucher_type(payment_document)

	if payment_document == "Sales Invoice":
		# A Sales Invoice carries its clearance date on the payment row, not on itself, so the target is
		# identified by parent + account rather than by name - and a filter that matches nothing writes
		# nothing while still answering HTTP 200. Resolved first so "no such row" is said out loud.
		payment_row = frappe.db.get_value(
			"Sales Invoice Payment",
			{"parent": payment_entry, "account": account, "amount": [">", 0]},
			"name",
		)
		if not payment_row:
			frappe.throw(
				_("Sales Invoice {0} has no payment against account {1} to clear").format(
					frappe.bold(payment_entry), frappe.bold(account)
				),
				title=_("Nothing to Clear"),
			)

		frappe.db.set_value("Sales Invoice Payment", payment_row, "clearance_date", clearance_date)

	else:
		# `frappe.db.set_value` on a name that does not exist updates zero rows and reports nothing, so
		# the request answered HTTP 200 having done nothing. Existence is asserted instead.
		if not frappe.db.exists(payment_document, payment_entry):
			frappe.throw(
				_("{0} {1} does not exist").format(payment_document, frappe.bold(payment_entry)),
				frappe.DoesNotExistError,
				title=_("Not Found"),
			)

		frappe.db.set_value(payment_document, payment_entry, "clearance_date", clearance_date)


@frappe.whitelist(methods=["POST"])
def clear_clearing_date(voucher_type: str, voucher_name: str):
	"""
	Clear the clearing date of a voucher
	"""
	validate_reconciliation_voucher_type(voucher_type)

	# using db_set to trigger notification
	payment_entry = frappe.get_doc(voucher_type, voucher_name)

	# `check_permission` rather than `if has_permission`: the silent form returned HTTP 200 to a caller
	# who was not allowed to write, so a refusal was indistinguishable from a success.
	payment_entry.check_permission("write")
	payment_entry.db_set("clearance_date", None)


@frappe.whitelist(methods=["POST"])
def create_bulk_internal_transfer(bank_transaction_names: list[str | int], bank_account: str):
	"""
	Create an internal transfer for multiple bank transactions
	"""
	output = []

	for bank_transaction_name in bank_transaction_names:
		bank_transaction = frappe.db.get_value(
			"Bank Transaction",
			bank_transaction_name,
			["name", "withdrawal", "bank_account", "date", "reference_number", "description"],
			as_dict=True,
		)

		transaction_account = frappe.get_cached_value(
			"Bank Account", bank_transaction.bank_account, "account"
		)

		is_withdrawal = bank_transaction.withdrawal > 0.0

		if is_withdrawal:
			paid_from = transaction_account
			paid_to = bank_account
		else:
			paid_from = bank_account
			paid_to = transaction_account

		reference_no = (bank_transaction.reference_number or bank_transaction.description or "")[:140]

		final_transaction = create_internal_transfer(
			bank_transaction_name=bank_transaction.name,
			posting_date=bank_transaction.date,
			reference_date=bank_transaction.date,
			reference_no=reference_no,
			paid_from=paid_from,
			paid_to=paid_to,
		)

		output.append(final_transaction)

	return output


@frappe.whitelist(methods=["POST"])
def create_internal_transfer(
	bank_transaction_name: str | int,
	posting_date: str | date,
	reference_date: str | date,
	reference_no: str,
	paid_from: str,
	paid_to: str,
	custom_remarks: bool = False,
	remarks: str | None = None,
	mirror_transaction_name: str | int | None = None,
	dimensions: dict | None = None,
):
	"""
	Create an internal transfer payment entry
	"""

	bank_transaction = frappe.get_doc("Bank Transaction", bank_transaction_name)
	bank_transaction.check_permission("write")

	bank_account = frappe.get_cached_value("Bank Account", bank_transaction.bank_account, "account")
	company = frappe.get_cached_value("Account", bank_account, "company")

	is_withdrawal = bank_transaction.withdrawal > 0.0

	pe = frappe.new_doc("Payment Entry")

	pe.company = company
	pe.payment_type = "Internal Transfer"
	pe.posting_date = posting_date
	pe.reference_date = reference_date
	pe.reference_no = reference_no
	pe.custom_remarks = custom_remarks
	pe.paid_amount = bank_transaction.unallocated_amount
	pe.received_amount = bank_transaction.unallocated_amount

	# TODO: Support multi-currency transactions
	pe.target_exchange_rate = 1.0

	if custom_remarks:
		pe.remarks = remarks

	if dimensions:
		pe.update(dimensions)

	if is_withdrawal:
		pe.paid_to = paid_to
		pe.paid_from = bank_account
	else:
		pe.paid_from = paid_from
		pe.paid_to = bank_account

	pe.insert()
	pe.submit()

	vouchers = json.dumps(
		[
			{
				"payment_doctype": "Payment Entry",
				"payment_name": pe.name,
				"amount": bank_transaction.unallocated_amount,
			}
		]
	)

	transaction_id = reconcile_vouchers(bank_transaction_name, vouchers, is_new_voucher=True)

	if mirror_transaction_name:
		# Reconcile the mirror transaction
		reconcile_vouchers(mirror_transaction_name, vouchers, is_new_voucher=False)

	return {
		"transaction": transaction_id,
		"payment_entry": pe,
	}


@frappe.whitelist(methods=["POST"])
def create_bulk_bank_entry_and_reconcile(bank_transactions: list[str | int], account: str):
	"""
	Create bank entries for all transactions and reconcile them
	"""

	output = []

	for bank_transaction in bank_transactions:
		transactions_details = frappe.db.get_value(
			"Bank Transaction",
			bank_transaction,
			[
				"name",
				"deposit",
				"withdrawal",
				"bank_account",
				"currency",
				"unallocated_amount",
				"date",
				"reference_number",
				"description",
			],
			as_dict=True,
		)

		is_credit_card = frappe.get_cached_value(
			"Bank Account", transactions_details.bank_account, "is_credit_card"
		)

		# Check Number will be limited to 140 characters
		cheque_no = (transactions_details.reference_number or transactions_details.description or "")[:140]

		is_withdrawal = transactions_details.withdrawal > 0.0

		entries = []

		gl_account = frappe.get_cached_value("Bank Account", transactions_details.bank_account, "account")

		if is_withdrawal:
			entries.append(
				{
					"account": gl_account,
					"bank_account": transactions_details.bank_account,
					"credit_in_account_currency": transactions_details.unallocated_amount,
					"credit": transactions_details.unallocated_amount,
					"debit_in_account_currency": 0,
					"debit": 0,
				}
			)

			entries.append(
				{
					"account": account,
					"credit": 0,
					"debit": transactions_details.unallocated_amount,
				}
			)
		else:
			entries.append(
				{
					"account": gl_account,
					"bank_account": transactions_details.bank_account,
					"debit_in_account_currency": transactions_details.unallocated_amount,
					"debit": transactions_details.unallocated_amount,
					"credit_in_account_currency": 0,
					"credit": 0,
				}
			)

			entries.append(
				{
					"account": account,
					"debit": 0,
					"credit": transactions_details.unallocated_amount,
				}
			)

		final_transaction = create_bank_entry_and_reconcile(
			bank_transaction_name=bank_transaction,
			cheque_date=transactions_details.date,
			posting_date=transactions_details.date,
			cheque_no=cheque_no,
			user_remark=transactions_details.description,
			entries=entries,
			voucher_type=("Credit Card Entry" if is_credit_card else "Bank Entry"),
		)

		output.append(final_transaction)

	return output


@frappe.whitelist(methods=["POST"])
def create_bank_entry_and_reconcile(
	bank_transaction_name: str | int,
	cheque_date: str | date,
	posting_date: str | date,
	cheque_no: str,
	entries: list,
	user_remark: str | None = None,
	voucher_type: str = "Bank Entry",
	dimensions: dict | None = None,
):
	"""
	Create a bank entry and reconcile it with the bank transaction
	"""
	# Create a new journal entry based on the bank transaction
	bank_transaction = frappe.db.get_values(
		"Bank Transaction",
		bank_transaction_name,
		fieldname=["name", "deposit", "withdrawal", "bank_account", "currency", "unallocated_amount"],
		as_dict=True,
	)[0]

	bank_account = frappe.get_cached_value("Bank Account", bank_transaction.bank_account, "account")
	company = frappe.get_cached_value("Account", bank_account, "company")

	default_cost_center = get_default_cost_center(company)

	bank_entry = frappe.get_doc(
		{
			"doctype": "Journal Entry",
			"voucher_type": voucher_type,
			"company": company,
			"cheque_date": cheque_date,
			"posting_date": posting_date,
			"cheque_no": cheque_no,
			"user_remark": user_remark,
		}
	)

	if not dimensions:
		dimensions = {}

	for entry in entries:
		# Check if this account is a Income or Expense Account
		# If it is, and no cost center is added, select the company default cost center
		cost_center = entry.get("cost_center")

		if not cost_center:
			report_type = frappe.get_cached_value("Account", entry["account"], "report_type")
			if report_type == "Profit and Loss":
				# Cost center is required
				cost_center = default_cost_center

		bank_entry.append(
			"accounts",
			{
				"account": entry["account"],
				# TODO: Multi currency support
				"debit_in_account_currency": entry.get("debit"),
				"credit_in_account_currency": entry.get("credit"),
				"debit": entry.get("debit"),
				"credit": entry.get("credit"),
				"party_type": entry.get("party_type") if entry.get("party") else None,
				"party": entry.get("party"),
				"user_remark": entry.get("user_remark"),
				**entry,
				"cost_center": cost_center,
			},
		)

	bank_entry.insert()
	bank_entry.submit()

	if bank_transaction.deposit > 0.0:
		paid_amount = bank_transaction.deposit
	else:
		paid_amount = bank_transaction.withdrawal

	transaction = reconcile_vouchers(
		bank_transaction_name,
		json.dumps(
			[
				{
					"payment_doctype": "Journal Entry",
					"payment_name": bank_entry.name,
					"amount": paid_amount,
				}
			]
		),
		is_new_voucher=True,
	)

	return {
		"transaction": transaction,
		"journal_entry": bank_entry,
	}


@frappe.whitelist(methods=["POST"])
def create_bulk_payment_entry_and_reconcile(
	bank_transaction_names: list[str | int],
	party_type: str,
	party: str | int,
	account: str,
	mode_of_payment: str | None = None,
):
	"""
	Create a payment entry and reconcile it with the bank transaction
	"""
	output = []

	for bank_transaction_name in bank_transaction_names:
		bank_transaction = frappe.db.get_value(
			"Bank Transaction",
			bank_transaction_name,
			[
				"name",
				"deposit",
				"withdrawal",
				"bank_account",
				# `company` was read off this record below but never selected here, so it was always
				# None and EVERY bulk Payment Entry failed validation with "Value missing for Payment
				# Entry: Company" - the whole endpoint was unusable.
				"company",
				"currency",
				"unallocated_amount",
				"date",
				"reference_number",
				"description",
			],
			as_dict=True,
		)

		if not bank_transaction:
			# An unknown name returned None here and broke on the attribute access below with an
			# AttributeError HTTP 500 instead of saying which transaction could not be found.
			frappe.throw(
				_("Bank Transaction {0} does not exist").format(frappe.bold(bank_transaction_name)),
				frappe.DoesNotExistError,
				title=_("Not Found"),
			)

		if flt(bank_transaction.unallocated_amount) <= 0.0:
			# The Payment Entry below is sized from `unallocated_amount`, so a transaction that is
			# already fully reconciled produced a zero-amount entry and was refused several layers
			# down with "Paid Amount is mandatory" - which says nothing about the real reason. Refuse it
			# here in the same words `BankTransaction.add_payment_entries` uses, so a stale selection
			# reads the same however it is submitted.
			frappe.throw(
				_("Bank Transaction {0} is already fully reconciled").format(
					frappe.bold(bank_transaction.name)
				),
				title=_("Already Reconciled"),
			)

		transaction_account = frappe.get_cached_value(
			"Bank Account", bank_transaction.bank_account, "account"
		)

		# `Bank Transaction.company` is a read-only field fetched from the bank account, so it can be
		# blank on a record written without one. Fall back to resolving it through the account, which is
		# the route `create_bank_entry_and_reconcile` and `create_payment_entry_bts` already take.
		company = bank_transaction.company or frappe.get_cached_value(
			"Account", transaction_account, "company"
		)

		is_withdrawal = bank_transaction.withdrawal > 0.0

		if is_withdrawal:
			paid_from = transaction_account
			paid_to = account
		else:
			paid_from = account
			paid_to = transaction_account

		payment_entry_doc = frappe.get_doc(
			{
				"doctype": "Payment Entry",
				"payment_type": "Pay" if is_withdrawal else "Receive",
				"bank_account": bank_transaction.bank_account,
				"company": company,
				"mode_of_payment": mode_of_payment,
				"party_type": party_type,
				"party": party,
				"paid_from": paid_from,
				"paid_to": paid_to,
				"paid_amount": bank_transaction.unallocated_amount,
				"base_paid_amount": bank_transaction.unallocated_amount,
				"received_amount": bank_transaction.unallocated_amount,
				"base_received_amount": bank_transaction.unallocated_amount,
				"target_exchange_rate": 1,
				"source_exchange_rate": 1,
				"reference_date": bank_transaction.date,
				"posting_date": bank_transaction.date,
				"reference_no": (bank_transaction.reference_number or bank_transaction.description or "")[
					:140
				],
			}
		)

		payment_entry_doc.insert()
		payment_entry_doc.submit()

		final_transaction = reconcile_vouchers(
			bank_transaction_name,
			json.dumps(
				[
					{
						"payment_doctype": "Payment Entry",
						"payment_name": payment_entry_doc.name,
						"amount": payment_entry_doc.paid_amount,
					}
				]
			),
			is_new_voucher=True,
		)

		output.append(
			{
				"transaction": final_transaction,
				"payment_entry": payment_entry_doc,
			}
		)

	return output


@frappe.whitelist(methods=["POST"])
def create_payment_entry_and_reconcile(bank_transaction_name: str | int, payment_entry_doc: dict):
	"""
	Create a payment entry and reconcile it with the bank transaction
	"""
	payment_entry = frappe.get_doc(
		{
			**payment_entry_doc,
			"doctype": "Payment Entry",
		}
	)
	payment_entry.insert()
	payment_entry.submit()
	transaction = reconcile_vouchers(
		bank_transaction_name,
		json.dumps(
			[
				{
					"payment_doctype": "Payment Entry",
					"payment_name": payment_entry.name,
					"amount": payment_entry.paid_amount,
				}
			]
		),
		is_new_voucher=True,
	)

	return {
		"transaction": transaction,
		"payment_entry": payment_entry,
	}


@frappe.whitelist(methods=["GET"])
def search_for_transfer_transaction(transaction_id: str | int):
	"""
	When users try to create a transfer, we could help them by searching for the mirror transaction.

	So for a withdrawal of 1000, we could search for a deposit of 1000 on the same date.

	If the mirror transaction is found, we return the bank account and account details.
	"""
	transaction = frappe.db.get_value(
		"Bank Transaction",
		transaction_id,
		["company", "withdrawal", "deposit", "date", "bank_account"],
		as_dict=True,
	)

	if not transaction:
		# `get_value` returns None for a name that does not exist, and unpacking None into five variables
		# raised a bare TypeError HTTP 500 that named neither the transaction nor the problem.
		frappe.throw(
			_("Bank Transaction {0} does not exist").format(frappe.bold(transaction_id)),
			frappe.DoesNotExistError,
			title=_("Not Found"),
		)

	company = transaction.company
	withdrawal = transaction.withdrawal
	deposit = transaction.deposit
	date = transaction.date
	bank_account = transaction.bank_account

	days = frappe.db.get_single_value("Accounts Settings", "transfer_match_days")

	if not days:
		days = 3

	min_date = frappe.utils.add_days(date, -days)
	max_date = frappe.utils.add_days(date, days)
	mirror_tx = frappe.db.get_list(
		"Bank Transaction",
		filters={
			"company": company,
			"date": ["between", [min_date, max_date]],
			"withdrawal": deposit,
			"bank_account": ["!=", bank_account],
			"deposit": withdrawal,
			"docstatus": 1,
			"status": "Unreconciled",
		},
		fields=[
			"name",
			"bank_account",
			"reference_number",
			"date",
			"description",
			"withdrawal",
			"deposit",
			"currency",
		],
	)

	if len(mirror_tx) == 1:
		return {
			"name": mirror_tx[0].name,
			"reference_number": mirror_tx[0].reference_number,
			"description": mirror_tx[0].description,
			"currency": mirror_tx[0].currency,
			"withdrawal": mirror_tx[0].withdrawal,
			"deposit": mirror_tx[0].deposit,
			"date": mirror_tx[0].date,
			"bank_account": mirror_tx[0].bank_account,
			"account": frappe.get_cached_value("Bank Account", mirror_tx[0].bank_account, "account"),
		}

	return None


# POST-only because this POSTS reconciliations in bulk across a whole date range. It answered a bare
# GET with HTTP 200 and an "Auto Reconciliation" summary, which reads as though the pass had been
# applied. Both callers already send POST: the SPA through `useFrappePostCall`, and the Desk tool
# through `frappe.call`, which posts by default.
@frappe.whitelist(methods=["POST"])
def auto_reconcile_vouchers(
	bank_account: str,
	from_date: str | date | None = None,
	to_date: str | date | None = None,
	filter_by_reference_date: bool | None = None,
	from_reference_date: bool | None = None,
	to_reference_date: str | None = None,
):
	bank_transactions = get_bank_transactions(bank_account)

	if len(bank_transactions) > 10:
		for bank_transaction_batch in create_batch(bank_transactions, 1000):
			frappe.enqueue(
				method="erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.start_auto_reconcile",
				queue="long",
				bank_transactions=bank_transaction_batch,
				from_date=from_date,
				to_date=to_date,
				filter_by_reference_date=filter_by_reference_date,
				from_reference_date=from_reference_date,
				to_reference_date=to_reference_date,
			)
		frappe.msgprint(_("Auto Reconciliation has started in the background"))
	else:
		start_auto_reconcile(
			bank_transactions,
			from_date,
			to_date,
			filter_by_reference_date,
			from_reference_date,
			to_reference_date,
		)


def start_auto_reconcile(
	bank_transactions, from_date, to_date, filter_by_reference_date, from_reference_date, to_reference_date
):
	frappe.flags.auto_reconcile_vouchers = True

	reconciled, partially_reconciled = set(), set()
	for transaction in bank_transactions:
		linked_payments = get_linked_payments(
			transaction.name,
			["payment_entry", "journal_entry", "sales_invoice"],
			from_date,
			to_date,
			filter_by_reference_date,
			from_reference_date,
			to_reference_date,
		)

		if not linked_payments:
			continue

		vouchers = list(
			map(
				lambda entry: {
					"payment_doctype": entry.get("doctype"),
					"payment_name": entry.get("name"),
					"amount": entry.get("paid_amount"),
				},
				linked_payments,
			)
		)

		updated_transaction = reconcile_vouchers(transaction.name, json.dumps(vouchers))

		if updated_transaction.status == "Reconciled":
			reconciled.add(updated_transaction.name)
		elif flt(transaction.unallocated_amount) != flt(updated_transaction.unallocated_amount):
			# Partially reconciled (status = Unreconciled & unallocated amount changed)
			partially_reconciled.add(updated_transaction.name)

	alert_message, indicator = get_auto_reconcile_message(partially_reconciled, reconciled)
	frappe.msgprint(title=_("Auto Reconciliation"), msg=alert_message, indicator=indicator)

	frappe.flags.auto_reconcile_vouchers = False


def get_auto_reconcile_message(partially_reconciled, reconciled):
	"""Returns alert message and indicator for auto reconciliation depending on result state."""
	alert_message, indicator = "", "blue"
	if not partially_reconciled and not reconciled:
		alert_message = _("No matches occurred via auto reconciliation")
		return alert_message, indicator

	indicator = "green"
	if reconciled:
		alert_message += _("{0} Transaction(s) Reconciled").format(len(reconciled))
		alert_message += "<br>"

	if partially_reconciled:
		alert_message += _("{0} {1} Partially Reconciled").format(
			len(partially_reconciled),
			_("Transactions") if len(partially_reconciled) > 1 else _("Transaction"),
		)

	return alert_message, indicator


def parse_vouchers_to_reconcile(vouchers: str | list) -> list[dict]:
	"""
	Turn the client's `vouchers` argument into the list of dicts the reconcile path expects.

	Everything here used to be taken on trust, and each kind of malformed payload surfaced as a raw
	HTTP 500 from a different layer: a string that is not JSON as `JSONDecodeError`, a JSON object
	rather than an array as `TypeError` when it was iterated, and an array of dicts missing
	`payment_doctype`/`payment_name` as `KeyError` once `add_payment_entries` indexed them. An empty
	array was worse than any of those - it answered HTTP 200 having done nothing, so a caller whose
	selection had been lost was told the reconciliation had succeeded.
	"""
	try:
		vouchers = frappe.parse_json(vouchers)
	except (ValueError, TypeError):
		frappe.throw(_("Vouchers to reconcile could not be read."), title=_("Invalid Request"))

	if not isinstance(vouchers, list | tuple):
		frappe.throw(_("Vouchers to reconcile must be a list."), title=_("Invalid Request"))

	if not vouchers:
		frappe.throw(_("Select at least one voucher to reconcile."), title=_("Nothing to Reconcile"))

	for voucher in vouchers:
		if (
			not isinstance(voucher, dict)
			or not voucher.get("payment_doctype")
			or not voucher.get("payment_name")
		):
			frappe.throw(
				_("Each voucher to reconcile must name a {0} and a {1}.").format(
					frappe.bold("payment_doctype"), frappe.bold("payment_name")
				),
				title=_("Invalid Request"),
			)

	return list(vouchers)


def load_bank_transaction_for_reconciliation(bank_transaction_name: str | int) -> Document:
	"""
	Load a Bank Transaction under an exclusive row lock, with the two facts its guards depend on read
	*through* that lock.

	Two sessions posting against the same transaction used to interleave their child-row, voucher and
	GL writes and dead-lock in the database. The loser saw HTTP 508 `QueryDeadlockError` - a raw
	storage-engine failure rather than the stale-state rejection the situation actually calls for.
	Taking the transaction's own row lock first serialises them instead: the loser waits for the winner
	to commit and then meets an ordinary validation error.

	The locking read is also the only trustworthy source for `docstatus` and `unallocated_amount` here.
	The connection runs at REPEATABLE READ, and the request has already read from the database (session,
	permissions) by the time this is called, so its snapshot predates the winner's commit and
	`frappe.get_doc` would hand back the pre-race values - letting a second post walk straight past the
	"already fully reconciled" guard. A locking read always sees the latest committed row, so those two
	values are carried across onto the document.

	`modified` is compared for the case the amount guard cannot catch: a concurrent PARTIAL
	reconciliation leaves `unallocated_amount` above zero, and continuing from a snapshot taken before it
	would silently delink the winner's child row (`delink_old_payment_entries` removes any row absent
	from the in-memory list). The deadlock used to prevent that by accident; the rejection below prevents
	it on purpose.
	"""
	try:
		locked = frappe.db.get_value(
			"Bank Transaction",
			bank_transaction_name,
			["docstatus", "unallocated_amount", "modified"],
			as_dict=True,
			for_update=True,
		)
	except frappe.QueryDeadlockError:
		# MariaDB refuses a locking read with error 1020, "Record has changed since last read", when the
		# row moved on after this request's REPEATABLE READ snapshot was taken - which IS the concurrent
		# post. PostgreSQL raises its own serialisation failure for the same situation, and Frappe maps
		# both onto `QueryDeadlockError`. Left alone it reached the caller as HTTP 508 from deep inside
		# `save()`, naming a storage-engine conflict the reviewer can do nothing with. Caught here it is
		# still ahead of every write, so it is answered as the stale-state refusal it actually is - the
		# same refusal the `modified` comparison below makes on an engine that lets the read through.
		frappe.throw(
			_(
				"Bank Transaction {0} is being reconciled by someone else. Please refresh and try again."
			).format(frappe.bold(bank_transaction_name)),
			title=_("Refresh Required"),
		)

	if not locked:
		frappe.throw(
			_("Bank Transaction {0} does not exist").format(frappe.bold(bank_transaction_name)),
			frappe.DoesNotExistError,
			title=_("Not Found"),
		)

	transaction = frappe.get_doc("Bank Transaction", bank_transaction_name)
	transaction.docstatus = locked.docstatus
	transaction.unallocated_amount = flt(locked.unallocated_amount)

	if str(locked.modified) != str(transaction.modified):
		frappe.throw(
			_(
				"Bank Transaction {0} was changed while you were working on it. Please refresh and try again."
			).format(frappe.bold(transaction.name)),
			title=_("Refresh Required"),
		)

	return transaction


@frappe.whitelist(methods=["POST"])
def reconcile_vouchers(bank_transaction_name: str | int, vouchers: str | list, is_new_voucher: bool = False):
	# updated clear date of all the vouchers based on the bank transaction
	vouchers = parse_vouchers_to_reconcile(vouchers)
	transaction = load_bank_transaction_for_reconciliation(bank_transaction_name)
	transaction.add_payment_entries(vouchers, is_new_voucher)
	transaction.validate_duplicate_references()
	transaction.allocate_payment_entries()
	transaction.update_allocated_amount()
	transaction.set_status()
	transaction.save()

	return transaction


def filter_permitted_vouchers(vouchers: list[dict]) -> list[dict]:
	"""
	Keep only the candidates the session user is permitted to read.

	`check_matching` assembles its candidates with `frappe.qb`, which talks to the database directly
	and so applies neither DocType permissions nor User Permissions. Re-asserting every candidate
	through `frappe.get_list` restores both, because `get_list` runs the permission query - unlike
	`frappe.get_all`, which sets `ignore_permissions`.

	The re-assertion costs one permission-aware query per candidate DocType rather than one per row,
	which is what lets the matching queries themselves stay untouched.
	"""
	if not vouchers:
		return vouchers

	names_by_doctype: dict[str, set[str]] = {}
	for voucher in vouchers:
		doctype, name = voucher.get("doctype"), voucher.get("name")
		if doctype and name:
			names_by_doctype.setdefault(doctype, set()).add(name)

	permitted_by_doctype: dict[str, set[str]] = {}
	for doctype, names in names_by_doctype.items():
		if not frappe.has_permission(doctype, ptype="read"):
			permitted_by_doctype[doctype] = set()
			continue

		permitted_by_doctype[doctype] = set(
			frappe.get_list(
				doctype,
				filters={"name": ("in", sorted(names))},
				pluck="name",
				limit_page_length=0,
				order_by=None,
			)
		)

	return [
		voucher
		for voucher in vouchers
		if voucher.get("name") in permitted_by_doctype.get(voucher.get("doctype"), set())
	]


@frappe.whitelist()
def get_linked_payments(
	bank_transaction_name: str,
	document_types: str | list[str] | None = None,
	from_date: str | date | None = None,
	to_date: str | date | None = None,
	filter_by_reference_date: bool | None = None,
	from_reference_date: bool | None = None,
	to_reference_date: str | None = None,
):
	# get all matching payments for a bank transaction
	transaction = frappe.get_doc("Bank Transaction", bank_transaction_name)

	# The transaction name arrives straight from the client, so it is authorised rather than trusted.
	# Passing `doc=` makes the check honour User Permissions (company, bank account) and not only the
	# DocType role rows, which is what keeps one tenant's transaction out of another tenant's reach.
	frappe.has_permission("Bank Transaction", ptype="read", doc=transaction, throw=True)

	bank_account_values = frappe.db.get_values(
		"Bank Account", transaction.bank_account, ["account", "company"], as_dict=True
	)
	if not bank_account_values:
		frappe.throw(
			_("Bank Transaction {0} is not linked to a Bank Account").format(transaction.name),
			title=_("Invalid Bank Account"),
		)

	# The bank account supplies the GL account and company every candidate query is built from, so it
	# is authorised in its own right before those two values are used.
	frappe.has_permission("Bank Account", ptype="read", doc=transaction.bank_account, throw=True)

	bank_account = bank_account_values[0]
	(gl_account, company) = (bank_account.account, bank_account.company)
	matching = check_matching(
		gl_account,
		company,
		transaction,
		document_types,
		from_date,
		to_date,
		filter_by_reference_date,
		from_reference_date,
		to_reference_date,
	)
	return subtract_allocations(gl_account, filter_permitted_vouchers(matching))


def subtract_allocations(gl_account, vouchers):
	"Look up & subtract any existing Bank Transaction allocations"
	copied = []

	voucher_docs = [(voucher.get("doctype"), voucher.get("name")) for voucher in vouchers]
	voucher_allocated_amounts = get_total_allocated_amount(voucher_docs)

	for voucher in vouchers:
		if amount := get_allocated_amount(voucher_allocated_amounts, voucher, gl_account):
			voucher["paid_amount"] -= amount

		copied.append(voucher)
	return copied


def get_allocated_amount(voucher_allocated_amounts, voucher, gl_account):
	if not (voucher_details := voucher_allocated_amounts.get((voucher.get("doctype"), voucher.get("name")))):
		return

	if not (row := voucher_details.get(gl_account)):
		return

	return row.get("total")


def check_matching(
	bank_account,
	company,
	transaction,
	document_types=None,
	from_date=None,
	to_date=None,
	filter_by_reference_date=None,
	from_reference_date=None,
	to_reference_date=None,
):
	exact_match = True if "exact_match" in document_types else False

	common_filters = frappe._dict(
		{
			"amount": transaction.unallocated_amount,
			"payment_type": "Receive" if transaction.deposit > 0.0 else "Pay",
			"reference_no": transaction.reference_number,
			"party_type": transaction.party_type,
			"party": transaction.party,
			"bank_account": bank_account,
		}
	)

	queries = get_queries(
		bank_account,
		company,
		transaction,
		document_types,
		from_date,
		to_date,
		filter_by_reference_date,
		from_reference_date,
		to_reference_date,
		exact_match,
		common_filters,
	)

	matching_vouchers = []
	for query in queries:
		matching_vouchers.extend(query.run(as_dict=True))

	return sorted(matching_vouchers, key=lambda x: x["rank"], reverse=True) if matching_vouchers else []


def get_queries(
	bank_account,
	company,
	transaction,
	document_types=None,
	from_date=None,
	to_date=None,
	filter_by_reference_date=None,
	from_reference_date=None,
	to_reference_date=None,
	exact_match=None,
	common_filters=None,
):
	# get queries to get matching vouchers
	account_from_to = "paid_to" if transaction.deposit > 0.0 else "paid_from"
	queries = []

	# get matching queries from all the apps
	for method_name in frappe.get_hooks("get_matching_queries"):
		queries.extend(
			frappe.get_attr(method_name)(
				bank_account,
				company,
				transaction,
				document_types,
				exact_match,
				account_from_to,
				from_date,
				to_date,
				filter_by_reference_date,
				from_reference_date,
				to_reference_date,
				common_filters,
			)
			or []
		)

	return queries


def get_matching_queries(
	bank_account,
	company,
	transaction,
	document_types=None,
	exact_match=None,
	account_from_to=None,
	from_date=None,
	to_date=None,
	filter_by_reference_date=None,
	from_reference_date=None,
	to_reference_date=None,
	common_filters=None,
):
	queries = []
	currency = get_account_currency(bank_account)

	if "payment_entry" in document_types:
		query = get_pe_matching_query(
			exact_match,
			account_from_to,
			transaction,
			from_date,
			to_date,
			filter_by_reference_date,
			from_reference_date,
			to_reference_date,
			common_filters,
		)
		queries.append(query)

	if "journal_entry" in document_types:
		query = get_je_matching_query(
			exact_match,
			transaction,
			from_date,
			to_date,
			filter_by_reference_date,
			from_reference_date,
			to_reference_date,
			common_filters,
		)
		queries.append(query)

	if transaction.deposit > 0.0 and "sales_invoice" in document_types:
		query = get_si_matching_query(exact_match, currency, common_filters, transaction)
		queries.append(query)

	if transaction.withdrawal > 0.0:
		if "purchase_invoice" in document_types:
			query = get_pi_matching_query(exact_match, currency, common_filters)
			queries.append(query)

	if "bank_transaction" in document_types:
		query = get_bt_matching_query(exact_match, transaction)
		queries.append(query)

	return queries


def get_bt_matching_query(exact_match, transaction):
	# get matching bank transaction query
	# find bank transactions in the same bank account with opposite sign
	# same bank account must have same company and currency
	bt = frappe.qb.DocType("Bank Transaction")

	field = "deposit" if transaction.withdrawal > 0.0 else "withdrawal"
	amount_equality = getattr(bt, field) == transaction.unallocated_amount
	amount_rank = frappe.qb.terms.Case().when(amount_equality, 1).else_(0)
	amount_condition = amount_equality if exact_match else getattr(bt, field) > 0.0

	ref_rank = frappe.qb.terms.Case().when(bt.reference_number == transaction.reference_number, 1).else_(0)
	unallocated_rank = (
		frappe.qb.terms.Case().when(bt.unallocated_amount == transaction.unallocated_amount, 1).else_(0)
	)

	party_condition = (
		(bt.party_type == transaction.party_type) & (bt.party == transaction.party) & bt.party.isnotnull()
	)
	party_rank = frappe.qb.terms.Case().when(party_condition, 1).else_(0)

	query = (
		frappe.qb.from_(bt)
		.select(
			(ref_rank + amount_rank + party_rank + unallocated_rank + 1).as_("rank"),
			ConstantColumn("Bank Transaction").as_("doctype"),
			bt.name,
			bt.unallocated_amount.as_("paid_amount"),
			bt.reference_number.as_("reference_no"),
			bt.date.as_("reference_date"),
			bt.party,
			bt.party_type,
			bt.date.as_("posting_date"),
			bt.currency,
		)
		.where(bt.status != "Reconciled")
		.where(bt.name != transaction.name)
		.where(bt.bank_account == transaction.bank_account)
		.where(amount_condition)
		.where(bt.docstatus == 1)
	)
	return query


def get_pe_matching_query(
	exact_match,
	account_from_to,
	transaction,
	from_date,
	to_date,
	filter_by_reference_date,
	from_reference_date,
	to_reference_date,
	common_filters,
):
	# get matching payment entries query
	to_from = "to" if transaction.deposit > 0.0 else "from"
	currency_field = f"paid_{to_from}_account_currency"
	payment_type = "Receive" if transaction.deposit > 0.0 else "Pay"
	pe = frappe.qb.DocType("Payment Entry")

	ref_condition = pe.reference_no == transaction.reference_number
	ref_rank = frappe.qb.terms.Case().when(ref_condition, 1).else_(0)

	amount_equality = pe.paid_amount == transaction.unallocated_amount
	amount_rank = frappe.qb.terms.Case().when(amount_equality, 1).else_(0)
	amount_condition = amount_equality if exact_match else pe.paid_amount > 0.0

	party_condition = (
		(pe.party_type == transaction.party_type) & (pe.party == transaction.party) & pe.party.isnotnull()
	)
	party_rank = frappe.qb.terms.Case().when(party_condition, 1).else_(0)

	filter_by_date = pe.posting_date.between(from_date, to_date)
	if cint(filter_by_reference_date):
		filter_by_date = pe.reference_date.between(from_reference_date, to_reference_date)

	query = (
		frappe.qb.from_(pe)
		.select(
			(ref_rank + amount_rank + party_rank + 1).as_("rank"),
			ConstantColumn("Payment Entry").as_("doctype"),
			pe.name,
			pe.base_paid_amount_after_tax.as_("paid_amount"),
			pe.reference_no,
			pe.reference_date,
			pe.party,
			pe.party_type,
			pe.posting_date,
			getattr(pe, currency_field).as_("currency"),
		)
		.where(pe.docstatus == 1)
		.where(pe.payment_type.isin([payment_type, "Internal Transfer"]))
		.where(pe.clearance_date.isnull())
		.where(getattr(pe, account_from_to) == common_filters.bank_account)
		.where(amount_condition)
		.where(filter_by_date)
		.orderby(pe.reference_date if cint(filter_by_reference_date) else pe.posting_date)
	)

	if frappe.flags.auto_reconcile_vouchers is True:
		query = query.where(ref_condition)

	return query


def get_je_matching_query(
	exact_match,
	transaction,
	from_date,
	to_date,
	filter_by_reference_date,
	from_reference_date,
	to_reference_date,
	common_filters,
):
	# get matching journal entry query
	# We have mapping at the bank level
	# So one bank could have both types of bank accounts like asset and liability
	# So cr_or_dr should be judged only on basis of withdrawal and deposit and not account type
	cr_or_dr = "credit" if transaction.withdrawal > 0.0 else "debit"
	je = frappe.qb.DocType("Journal Entry")
	jea = frappe.qb.DocType("Journal Entry Account")

	amount_field = f"{cr_or_dr}_in_account_currency"

	filter_by_date = je.posting_date.between(from_date, to_date)
	if cint(filter_by_reference_date):
		filter_by_date = je.cheque_date.between(from_reference_date, to_reference_date)

	subquery = (
		frappe.qb.from_(jea)
		.join(je)
		.on(jea.parent == je.name)
		.select(
			Sum(getattr(jea, amount_field)).as_("paid_amount"),
			ConstantColumn("Journal Entry").as_("doctype"),
			je.name,
			# non-grouped columns are constant per grouped JE name (party_type/currency come from the
			# single bank-account line) -> Max() keeps the GROUP BY valid on postgres with the same value
			Max(je.cheque_no).as_("reference_no"),
			Max(je.cheque_date).as_("reference_date"),
			Max(je.pay_to_recd_from).as_("party"),
			Max(jea.party_type).as_("party_type"),
			Max(je.posting_date).as_("posting_date"),
			Max(jea.account_currency).as_("currency"),
		)
		.where(je.docstatus == 1)
		.where(je.voucher_type != "Opening Entry")
		.where(je.clearance_date.isnull())
		.where(jea.account == common_filters.bank_account)
		.where(filter_by_date)
		.groupby(je.name)
		.orderby(Max(je.cheque_date) if cint(filter_by_reference_date) else Max(je.posting_date))
	)

	if frappe.flags.auto_reconcile_vouchers is True:
		subquery = subquery.where(je.cheque_no == transaction.reference_number)

	ref_rank = frappe.qb.terms.Case().when(subquery.reference_no == transaction.reference_number, 1).else_(0)
	amount_equality = subquery.paid_amount == transaction.unallocated_amount
	amount_rank = frappe.qb.terms.Case().when(amount_equality, 1).else_(0)

	query = (
		frappe.qb.from_(subquery)
		.select(
			"*",
			(ref_rank + amount_rank + 1).as_("rank"),
		)
		.where(amount_equality if exact_match else subquery.paid_amount > 0.0)
	)

	return query


def get_si_matching_query(exact_match, currency, common_filters, transaction):
	# get matching sales invoice query
	si = frappe.qb.DocType("Sales Invoice")
	sip = frappe.qb.DocType("Sales Invoice Payment")

	ref_condition = sip.reference_no == transaction.reference_number
	ref_rank = frappe.qb.terms.Case().when(ref_condition, 1).else_(0)

	amount_equality = sip.amount == common_filters.amount
	amount_rank = frappe.qb.terms.Case().when(amount_equality, 1).else_(0)
	amount_condition = amount_equality if exact_match else sip.amount > 0.0

	party_condition = si.customer == common_filters.party
	party_rank = frappe.qb.terms.Case().when(party_condition, 1).else_(0)

	query = (
		frappe.qb.from_(sip)
		.join(si)
		.on(sip.parent == si.name)
		.select(
			(ref_rank + party_rank + amount_rank + 1).as_("rank"),
			ConstantColumn("Sales Invoice").as_("doctype"),
			si.name,
			sip.amount.as_("paid_amount"),
			sip.reference_no,
			ConstantColumn("").as_("reference_date"),
			si.customer.as_("party"),
			ConstantColumn("Customer").as_("party_type"),
			si.posting_date,
			si.currency,
		)
		.where(si.docstatus == 1)
		.where(sip.clearance_date.isnull())
		.where(sip.account == common_filters.bank_account)
		.where(amount_condition)
		.where(si.currency == currency)
	)

	if frappe.flags.auto_reconcile_vouchers is True:
		query = query.where(ref_condition)

	return query


def get_pi_matching_query(exact_match, currency, common_filters):
	# get matching purchase invoice query when they are also used as payment entries (is_paid)
	purchase_invoice = frappe.qb.DocType("Purchase Invoice")

	amount_equality = purchase_invoice.paid_amount == common_filters.amount
	amount_rank = frappe.qb.terms.Case().when(amount_equality, 1).else_(0)
	amount_condition = amount_equality if exact_match else purchase_invoice.paid_amount > 0.0

	party_condition = purchase_invoice.supplier == common_filters.party
	party_rank = frappe.qb.terms.Case().when(party_condition, 1).else_(0)

	query = (
		frappe.qb.from_(purchase_invoice)
		.select(
			(party_rank + amount_rank + 1).as_("rank"),
			ConstantColumn("Purchase Invoice").as_("doctype"),
			purchase_invoice.name,
			purchase_invoice.paid_amount,
			ConstantColumn("").as_("reference_no"),
			ConstantColumn("").as_("reference_date"),
			purchase_invoice.supplier.as_("party"),
			ConstantColumn("Supplier").as_("party_type"),
			purchase_invoice.posting_date,
			purchase_invoice.currency,
		)
		.where(purchase_invoice.docstatus == 1)
		.where(purchase_invoice.is_paid == 1)
		.where(purchase_invoice.clearance_date.isnull())
		.where(purchase_invoice.cash_bank_account == common_filters.bank_account)
		.where(amount_condition)
		.where(purchase_invoice.currency == currency)
	)

	return query
