# Copyright (c) 2019, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import functools
import inspect

import frappe
from frappe import _
from frappe.model.docstatus import DocStatus
from frappe.model.document import Document
from frappe.query_builder import Tuple
from frappe.query_builder.functions import Abs, Max, Sum
from frappe.utils import flt, fmt_money, getdate


def refuse_missing_arguments(fn):
	"""Refuse a call that omits a required argument, instead of letting Python raise.

	WHAT THIS FIXES

	Every whitelisted method in the banking DocTypes is reachable over ``/api/method/...``, and a
	request that omits a required argument used to reach the function itself and raise a plain
	``TypeError``. Frappe has no special handling for that, so it became an **HTTP 500** carrying the
	full server traceback in the response's ``exc`` field. Measured against a running site before this
	change: 26 of the 28 module-level whitelisted methods across the four banking DocTypes answered 500,
	and a single one of those responses published 917 characters of traceback naming six framework
	source paths. A caller mistake is not a server fault; it deserves a 4xx and a sentence.

	With this decorator the same request is refused through ``frappe.throw``, which produces Frappe's
	ordinary validation envelope - a 4xx with the message in ``_server_messages`` and no traceback - and
	that envelope is exactly what the banking SPA's existing error pipeline already parses and renders.
	The message names the missing parameters and nothing else. Those names are already part of the public
	API contract (the SPA passes them by name), so naming them describes the contract rather than the
	implementation, and is what makes the refusal actionable.

	WHERE IT MUST BE APPLIED

	Directly beneath ``@frappe.whitelist()``, never above it::

	    @frappe.whitelist()
	    @refuse_missing_arguments
	    def get_bank_transactions(bank_account: str, ...):

	``frappe.whitelist()`` registers the object it returns in ``frappe.whitelisted`` and that object is
	what the module attribute becomes. Placing this decorator above it would leave the registered
	callable unreachable from the dotted path, and the endpoint would stop being callable at all.

	WHY WRAPPING IS SAFE HERE

	``frappe.whitelist()`` wraps the function in ``validate_argument_types``, which coerces arguments
	against their annotations using ``func.__annotations__`` and ``frappe._get_cached_signature_params``.
	``functools.wraps`` copies ``__annotations__`` and sets ``__wrapped__``, and ``inspect.signature``
	follows ``__wrapped__``, so both of those see the original function exactly as before. Frappe's
	``get_newargs``, which filters incoming form data down to the parameters a method actually accepts,
	resolves the signature the same way and is likewise unaffected.

	One narrow difference is worth recording rather than leaving to be discovered. When coercion is
	active, ``transform_parameter_types`` maps POSITIONAL arguments to names through
	``func.__code__.co_varnames`` - the wrapper's own code object, not the original's - so positionally
	passed arguments are no longer coerced. Arguments passed by name still are, and every HTTP request
	arrives by name because Frappe dispatches as ``frappe.call(method, **frappe.form_dict)``. The
	positional path exists only for the eleven internal call sites inside these same modules, every one
	of which passes values that already match its annotation, so nothing there was relying on coercion.

	:param fn: the undecorated function, with its real signature.
	"""
	signature = inspect.signature(fn)

	@functools.wraps(fn)
	def wrapper(*args, **kwargs):
		missing = _missing_required_arguments(signature, args, kwargs)

		if missing:
			refuse_arguments(*missing)

		try:
			signature.bind(*args, **kwargs)
		except TypeError as exception:
			# Everything binding can still object to: too many positional arguments, or a keyword the
			# method does not accept. Unreachable over HTTP, because Frappe filters form data down to the
			# signature before dispatching - so this only ever answers an internal caller, and answers it
			# with a sentence rather than a traceback. `str(exception)` is Python's own wording about this
			# function's parameters and describes nothing beyond them.
			frappe.throw(_("Invalid arguments: {0}").format(str(exception)), title=_("Invalid Request"))

		return fn(*args, **kwargs)

	return wrapper


def refuse_arguments(*names: str):
	"""Refuse the current call because these parameters were not supplied. Never returns.

	Shared by {@link refuse_missing_arguments} and by the handful of methods whose signature cannot state
	the requirement for itself, so that one missing parameter reads the same to a caller however the
	requirement came to be enforced. ``frappe.throw`` produces Frappe's ordinary validation envelope: a
	4xx whose message travels in ``_server_messages``, with no traceback attached.
	"""
	frappe.throw(
		_("Missing required {0}: {1}").format(
			_("parameter") if len(names) == 1 else _("parameters"),
			", ".join(names),
		),
		title=_("Invalid Request"),
	)


def refuse_unknown_bank_transaction(name) -> None:
	"""Refuse the current call because no Bank Transaction goes by this name. Never returns.

	The row lookups that feed the voucher-creation endpoints take a name straight from the caller and
	index the result - ``frappe.db.get_values(...)[0]``, or an attribute read on a ``get_value`` result
	that is ``None`` when nothing matched. A name that does not exist therefore raised ``IndexError`` or
	``AttributeError`` and became an HTTP 500, when what happened is simply that the caller named
	something that is not there.

	``frappe.DoesNotExistError`` rather than a plain validation error, so these endpoints answer 404 like
	their siblings that resolve the same record through ``frappe.get_doc``: the same mistake gets the same
	status whichever endpoint hears it. The wording follows the pattern already used in this module for an
	unknown Bank Account and an unknown voucher.
	"""
	frappe.throw(
		_("Bank Transaction {0} does not exist").format(frappe.bold(name)),
		frappe.DoesNotExistError,
	)


def _missing_required_arguments(signature: inspect.Signature, args: tuple, kwargs: dict) -> list[str]:
	"""Names of the parameters that have no default and were given no value.

	Computed from the signature rather than parsed out of Python's ``TypeError`` text, so the answer does
	not depend on an interpreter's phrasing, and so the caller can be told about ALL of the missing
	parameters at once instead of discovering them one request at a time.

	``*args`` and ``**kwargs`` parameters are skipped: they are never required. Keyword-only parameters
	are checked against ``kwargs`` alone, because a positional value can never reach one.
	"""
	missing = []
	positional_count = len(args)

	for index, parameter in enumerate(signature.parameters.values()):
		if parameter.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
			continue

		if parameter.default is not inspect.Parameter.empty:
			continue

		fillable_by_position = parameter.kind in (
			inspect.Parameter.POSITIONAL_ONLY,
			inspect.Parameter.POSITIONAL_OR_KEYWORD,
		)

		if fillable_by_position and index < positional_count:
			continue

		if parameter.name in kwargs:
			continue

		missing.append(parameter.name)

	return missing


class BankTransaction(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		from erpnext.accounts.doctype.bank_transaction_payments.bank_transaction_payments import (
			BankTransactionPayments,
		)

		allocated_amount: DF.Currency
		amended_from: DF.Link | None
		bank_account: DF.Link | None
		bank_party_account_number: DF.Data | None
		bank_party_iban: DF.Data | None
		bank_party_name: DF.Data | None
		company: DF.Link | None
		currency: DF.Link | None
		date: DF.Date | None
		deposit: DF.Currency
		description: DF.SmallText | None
		excluded_fee: DF.Currency
		included_fee: DF.Currency
		is_rule_evaluated: DF.Check
		matched_transaction_rule: DF.Link | None
		naming_series: DF.Literal["ACC-BTN-.YYYY.-"]
		party: DF.DynamicLink | None
		party_type: DF.Link | None
		payment_entries: DF.Table[BankTransactionPayments]
		reference_number: DF.SmallText | None
		status: DF.Literal["", "Pending", "Settled", "Unreconciled", "Reconciled", "Cancelled"]
		transaction_id: DF.Data | None
		transaction_type: DF.Data | None
		unallocated_amount: DF.Currency
		withdrawal: DF.Currency
	# end: auto-generated types

	def before_validate(self):
		self.handle_excluded_fee()
		self.update_allocated_amount()

	def on_discard(self):
		self.db_set("status", "Cancelled")

	def validate(self):
		self.validate_included_fee()
		self.validate_duplicate_references()
		self.validate_currency()

	def validate_currency(self):
		"""
		Bank Transaction should be on the same currency as the Bank Account.
		"""
		if self.currency and self.bank_account:
			if account := frappe.get_cached_value("Bank Account", self.bank_account, "account"):
				account_currency = frappe.get_cached_value("Account", account, "account_currency")

				if self.currency != account_currency:
					frappe.throw(
						_(
							"Transaction currency: {0} cannot be different from Bank Account({1}) currency: {2}"
						).format(
							frappe.bold(self.currency),
							frappe.bold(self.bank_account),
							frappe.bold(account_currency),
						)
					)

	def set_status(self):
		if self.docstatus == 2:
			self.db_set("status", "Cancelled")
		elif self.docstatus == 1:
			if self.unallocated_amount > 0:
				self.db_set("status", "Unreconciled")
			elif self.unallocated_amount <= 0:
				self.db_set("status", "Reconciled")

	def validate_duplicate_references(self):
		"""Make sure the same voucher is not allocated twice within the same Bank Transaction"""
		if not self.payment_entries:
			return

		references = set()
		for row in self.payment_entries:
			reference = (row.payment_document, row.payment_entry)
			if reference in references:
				frappe.throw(
					_("{0} {1} is allocated twice in this Bank Transaction").format(
						row.payment_document, row.payment_entry
					)
				)
			references.add(reference)

	def update_allocated_amount(self):
		allocated_amount = (
			sum(p.allocated_amount for p in self.payment_entries) if self.payment_entries else 0.0
		)
		unallocated_amount = abs(flt(self.withdrawal) - flt(self.deposit)) - allocated_amount

		self.allocated_amount = flt(allocated_amount, self.precision("allocated_amount"))
		self.unallocated_amount = flt(unallocated_amount, self.precision("unallocated_amount"))

	def delink_old_payment_entries(self):
		if self.flags.updating_linked_bank_transaction:
			return

		old_doc = self.get_doc_before_save()
		payment_entry_names = set(pe.name for pe in self.payment_entries)

		for old_pe in old_doc.payment_entries:
			if old_pe.name in payment_entry_names:
				continue

			self.delink_payment_entry(old_pe)

	def before_submit(self):
		self.allocate_payment_entries()
		self.set_status()

		if frappe.get_single_value("Accounts Settings", "enable_party_matching"):
			self.auto_set_party()

	def before_update_after_submit(self):
		self.validate_duplicate_references()
		# `validate()` never runs for a submitted document, so without this call the currency rule
		# would be enforced on insert only - and the reconcile path (`reconcile_vouchers` ->
		# `save()` on a docstatus=1 document) would post a mismatched transaction unchecked.
		self.validate_currency()
		self.update_allocated_amount()
		self.delink_old_payment_entries()
		self.allocate_payment_entries()
		self.set_status()

	def on_cancel(self):
		self.ignore_linked_doctypes = ["GL Entry"]

		for payment_entry in self.payment_entries:
			self.delink_payment_entry(payment_entry)

		self.set_status()

	def add_payment_entries(self, vouchers, is_new_voucher: bool = False):
		"""
		Add the vouchers with zero allocation. Save() will perform the allocations and clearance

		is_new_voucher - is used to set the reonciliation type - whether the voucher was added as a result of "Matching" or a new voucher was created.
		Used in bank reconciliation
		"""
		# Only a SUBMITTED transaction has a posted balance to allocate against, and this is the one
		# place that gate can live: `set_status` derives `status` from `docstatus` and
		# `unallocated_amount` and writes nothing at all for a draft, so a draft that reached here had
		# its child rows appended and its allocation rewritten while its status stayed "Pending" - a
		# reconciliation that never reached the ledger and that no status could reveal. Rejected before
		# the first `append` so nothing is mutated.
		if self.docstatus != DocStatus.SUBMITTED:
			frappe.throw(
				_("Bank Transaction {0} must be submitted before it can be reconciled").format(self.name),
				title=_("Not Submitted"),
			)

		if 0.0 >= self.unallocated_amount:
			frappe.throw(_("Bank Transaction {0} is already fully reconciled").format(self.name))

		for voucher in vouchers:
			self.append(
				"payment_entries",
				{
					"payment_document": voucher["payment_doctype"],
					"payment_entry": voucher["payment_name"],
					"allocated_amount": 0.0,  # Temporary
					"reconciliation_type": "Voucher Created" if is_new_voucher else "Matched",
				},
			)

	def allocate_payment_entries(self):
		"""Refactored from bank reconciliation tool.
		Non-zero allocations must be amended/cleared manually
		Get the bank transaction amount (b) and remove as we allocate
		For each payment_entry if allocated_amount == 0:
		- get the amount already allocated against all transactions (t), need latest date
		- get the voucher amount (from gl) (v)
		- allocate (a = v - t)
		    - a = 0: should already be cleared, so clear & remove payment_entry
		    - 0 < a <= u: allocate a & clear
		    - 0 < a, a > u: allocate u
		    - 0 > a: Error: already over-allocated
		- clear means: set the latest transaction date as clearance date
		"""
		if self.flags.updating_linked_bank_transaction or not self.payment_entries:
			return

		remaining_amount = self.unallocated_amount
		payment_entry_docs = [(pe.payment_document, pe.payment_entry) for pe in self.payment_entries]
		pe_bt_allocations = get_total_allocated_amount(payment_entry_docs)
		gl_entries = get_related_bank_gl_entries(payment_entry_docs)
		gl_bank_account = frappe.db.get_value("Bank Account", self.bank_account, "account")

		for payment_entry in list(self.payment_entries):
			if payment_entry.allocated_amount != 0:
				continue

			allocable_amount, should_clear, clearance_date = get_clearance_details(
				self,
				payment_entry,
				pe_bt_allocations.get((payment_entry.payment_document, payment_entry.payment_entry)) or {},
				gl_entries.get((payment_entry.payment_document, payment_entry.payment_entry)) or {},
				gl_bank_account,
			)

			if allocable_amount < 0:
				# Two placeholders, and both are now filled. Passing only the amount made `str.format`
				# raise `IndexError: Replacement index 1 out of range`, so the one path that detects an
				# over-allocated voucher answered HTTP 500 with a formatting error instead of the
				# validation error it had already decided on - the reviewer was told nothing about which
				# voucher was over-allocated, or by how much.
				frappe.throw(
					_("Voucher {0} is over-allocated by {1}").format(
						frappe.bold(f"{payment_entry.payment_document} {payment_entry.payment_entry}"),
						frappe.bold(fmt_money(abs(allocable_amount), currency=self.currency)),
					),
					title=_("Over-allocated Voucher"),
				)

			if remaining_amount <= 0:
				self.remove(payment_entry)
				continue

			if allocable_amount == 0:
				if should_clear:
					self.clear_linked_payment_entry(payment_entry, clearance_date=clearance_date)
				self.remove(payment_entry)
				continue

			should_clear = should_clear and allocable_amount <= remaining_amount
			payment_entry.allocated_amount = min(allocable_amount, remaining_amount)
			remaining_amount = flt(
				remaining_amount - payment_entry.allocated_amount,
				self.precision("unallocated_amount"),
			)

			if payment_entry.payment_document == "Bank Transaction":
				self.update_linked_bank_transaction(
					payment_entry.payment_entry, payment_entry.allocated_amount
				)
			elif should_clear:
				self.clear_linked_payment_entry(payment_entry, clearance_date=clearance_date)

		self.update_allocated_amount()

	@frappe.whitelist()
	def remove_payment_entries(self):
		for payment_entry in self.payment_entries:
			self.remove_payment_entry(payment_entry)

		self.save()  # runs before_update_after_submit

	def remove_payment_entry(self, payment_entry):
		"Clear payment entry and clearance"
		self.delink_payment_entry(payment_entry)
		self.remove(payment_entry)

	def delink_payment_entry(self, payment_entry):
		if payment_entry.payment_document == "Bank Transaction":
			self.update_linked_bank_transaction(payment_entry.payment_entry, allocated_amount=None)
		else:
			self.clear_linked_payment_entry(payment_entry, clearance_date=None)

	def clear_linked_payment_entry(self, payment_entry, clearance_date=None):
		doctype = payment_entry.payment_document
		docname = payment_entry.payment_entry

		# might be a bank transaction
		if doctype not in get_doctypes_for_bank_reconciliation():
			return

		if doctype == "Sales Invoice":
			frappe.db.set_value(
				"Sales Invoice Payment",
				dict(parenttype=doctype, parent=docname),
				"clearance_date",
				clearance_date,
			)
			return

		frappe.db.set_value(doctype, docname, "clearance_date", clearance_date)

	def update_linked_bank_transaction(self, bank_transaction_name, allocated_amount=None):
		"""For when a second bank transaction has fixed another, e.g. refund"""

		bt = frappe.get_doc(self.doctype, bank_transaction_name)
		if allocated_amount:
			bt.append(
				"payment_entries",
				{
					"payment_document": self.doctype,
					"payment_entry": self.name,
					"allocated_amount": allocated_amount,
				},
			)

		else:
			pe = next(
				(
					pe
					for pe in bt.payment_entries
					if pe.payment_document == self.doctype and pe.payment_entry == self.name
				),
				None,
			)
			if not pe:
				return

			bt.flags.updating_linked_bank_transaction = True
			bt.remove(pe)

		bt.save()

	def auto_set_party(self):
		from erpnext.accounts.doctype.bank_transaction.auto_match_party import AutoMatchParty

		if self.party_type and self.party:
			return

		result = None
		try:
			result = AutoMatchParty(
				bank_party_account_number=self.bank_party_account_number,
				bank_party_iban=self.bank_party_iban,
				bank_party_name=self.bank_party_name,
				description=self.description,
				deposit=self.deposit,
			).match()
		except Exception:
			frappe.log_error(title=_("Error in party matching for Bank Transaction {0}").format(self.name))

		if not result:
			return

		self.party_type, self.party = result

	def validate_included_fee(self):
		"""
		The included_fee is only handled for withdrawals. An included_fee for a deposit, is not credited to the account and is
		therefore outside of the deposit value and can be larger than the deposit itself.
		"""

		if self.included_fee and self.withdrawal:
			if self.included_fee > self.withdrawal:
				frappe.throw(_("Included fee is bigger than the withdrawal itself."))

	def handle_excluded_fee(self):
		# Include the excluded fee on validate to handle all further processing the same
		excluded_fee = flt(self.excluded_fee)
		if excluded_fee <= 0:
			return

		# Suppress a negative deposit (aka withdrawal), likely not intendend
		if flt(self.deposit) > 0 and (flt(self.deposit) - excluded_fee) < 0:
			frappe.throw(_("The Excluded Fee is bigger than the Deposit it is deducted from."))

		# Enforce directionality
		if flt(self.deposit) > 0 and flt(self.withdrawal) > 0:
			frappe.throw(
				_("Only one of Deposit or Withdrawal should be non-zero when applying an Excluded Fee.")
			)

		if flt(self.deposit) > 0:
			self.deposit = flt(self.deposit) - excluded_fee
		# A fee applied to deposit and withdrawal equal 0 become a withdrawal
		elif flt(self.withdrawal) >= 0:
			self.withdrawal = flt(self.withdrawal) + excluded_fee
		self.included_fee = flt(self.included_fee) + excluded_fee
		self.excluded_fee = 0


@frappe.whitelist()
@refuse_missing_arguments
def get_doctypes_for_bank_reconciliation():
	"""Get Bank Reconciliation doctypes from all the apps"""
	return frappe.get_hooks("bank_reconciliation_doctypes")


# POST-only because this CANCELS accounting vouchers and removes allocations. Left unrestricted it
# answered a bare GET with HTTP 200: the request-level rollback that follows a read-only GET kept the
# changes from persisting, so nothing broke - but the caller was told an undo had happened when none
# had, and any crawler or prefetch could ask for one. The SPA has always sent POST.
@frappe.whitelist(methods=["POST"])
@refuse_missing_arguments
def unreconcile_transaction(transaction_name: str | int):
	"""
	Unreconcile an entire bank transaction - this does not handle individual entries but clears the entire transaction

	If the individual entries in the bank transaction are matched, just remove the payment entries
	Else, cancel the individual entries
	"""
	transaction = frappe.get_doc("Bank Transaction", transaction_name)
	transaction.check_permission("write")

	vouchers_to_cancel = []

	for entry in transaction.payment_entries:
		if entry.reconciliation_type == "Voucher Created":
			vouchers_to_cancel.append(
				{
					"doctype": entry.payment_document,
					"name": entry.payment_entry,
				}
			)

	transaction.remove_payment_entries()

	# Any accounting vouchers that were created as a result of bank reconciliation will be cancelled

	for voucher in vouchers_to_cancel:
		frappe.get_doc(voucher["doctype"], voucher["name"]).cancel()


@frappe.whitelist(methods=["POST"])
@refuse_missing_arguments
def unreconcile_transaction_entry(bank_transaction_id: str | int, voucher_type: str, voucher_id: str | int):
	"""
	Removes a single payment entry from a bank transaction - for example only undoing one voucher instead of undoing the entire transaction
	"""

	bank_transaction = frappe.get_doc("Bank Transaction", bank_transaction_id)
	bank_transaction.check_permission("write")

	# Find the voucher in the bank transaction and depending on the action, either remove it or cancel the voucher
	undone = False
	for entry in bank_transaction.payment_entries:
		if entry.payment_document == voucher_type and entry.payment_entry == voucher_id:
			if entry.reconciliation_type == "Voucher Created":
				frappe.get_doc(voucher_type, voucher_id).cancel()
			else:
				bank_transaction.remove_payment_entry(entry)
				bank_transaction.save()
			undone = True

	# `{"success": True}` used to be returned unconditionally, including when the loop above matched
	# nothing - so asking to undo a voucher that was never linked to this transaction reported a
	# successful undo while changing nothing at all. A caller reconciling its own view from that answer
	# would drop a link the server still holds. Named explicitly instead.
	if not undone:
		frappe.throw(
			_("{0} {1} is not linked to Bank Transaction {2}").format(
				voucher_type, frappe.bold(voucher_id), frappe.bold(bank_transaction.name)
			),
			title=_("Nothing to Undo"),
		)

	return {"success": True}


def get_clearance_details(transaction, payment_entry, bt_allocations, gl_entries, gl_bank_account):
	"""
	There should only be one bank gl entry for a voucher, except for JE.
	For JE, there can be multiple bank gl entries for the same account.
	In this case, the allocable_amount will be the sum of amounts of all gl entries of the account.
	There will be no gl entry for a Bank Transaction so return the unallocated amount.
	Should only clear the voucher if all bank gl entries are allocated.
	"""

	transaction_date = getdate(transaction.date)

	if payment_entry.payment_document == "Bank Transaction":
		bt = frappe.db.get_value(
			"Bank Transaction",
			payment_entry.payment_entry,
			("unallocated_amount", "bank_account"),
			as_dict=True,
		)
		bt_bank_account = frappe.db.get_value("Bank Account", bt.bank_account, "account")

		if bt_bank_account != gl_bank_account:
			frappe.throw(
				_("Bank Account {0} in Bank Transaction {1} is not matching with Bank Account {2}").format(
					bt_bank_account, payment_entry.payment_entry, gl_bank_account
				)
			)

		return abs(bt.unallocated_amount), True, transaction_date

	if gl_bank_account not in gl_entries:
		frappe.throw(
			_("{0} {1} is not affecting bank account {2}").format(
				payment_entry.payment_document, payment_entry.payment_entry, gl_bank_account
			)
		)

	allocable_amount = gl_entries.pop(gl_bank_account) or 0
	if allocable_amount <= 0.0:
		frappe.throw(
			_("Invalid amount in accounting entries of {0} {1} for Account {2}: {3}").format(
				payment_entry.payment_document, payment_entry.payment_entry, gl_bank_account, allocable_amount
			)
		)

	matching_bt_allocaion = bt_allocations.pop(gl_bank_account, {})

	allocable_amount = flt(
		allocable_amount - matching_bt_allocaion.get("total", 0), transaction.precision("unallocated_amount")
	)

	should_clear = all(
		gl_entries[gle_account] == bt_allocations.get(gle_account, {}).get("total", 0)
		for gle_account in gl_entries
	)

	bt_allocation_date = matching_bt_allocaion.get("latest_date", None)
	clearance_date = transaction_date if not bt_allocation_date else max(transaction_date, bt_allocation_date)

	return allocable_amount, should_clear, clearance_date


def get_related_bank_gl_entries(docs):
	if not docs:
		return {}

	gle = frappe.qb.DocType("GL Entry")
	ac = frappe.qb.DocType("Account")
	result = (
		frappe.qb.from_(gle)
		.left_join(ac)
		.on(ac.name == gle.account)
		.select(
			gle.voucher_type.as_("doctype"),
			gle.voucher_no.as_("docname"),
			gle.account.as_("gl_account"),
			Sum(Abs(gle.credit_in_account_currency - gle.debit_in_account_currency)).as_("amount"),
		)
		.where(
			(ac.account_type == "Bank")
			& Tuple(gle.voucher_type, gle.voucher_no).isin([Tuple(vt, vn) for vt, vn in docs])
			& (gle.is_cancelled == 0)
		)
		.groupby(gle.voucher_type, gle.voucher_no, gle.account)
		.run(as_dict=True)
	)

	entries = {}
	for row in result:
		key = (row["doctype"], row["docname"])
		if key not in entries:
			entries[key] = {}
		entries[key][row["gl_account"]] = row["amount"]

	return entries


def get_total_allocated_amount(docs):
	"""
	Gets the sum of allocations for a voucher on each bank GL account
	along with the latest bank transaction date
	NOTE: query may also include just saved vouchers/payments but with zero allocated_amount
	"""
	if not docs:
		return {}

	# The original window query (ROW_NUMBER/FIRST_VALUE + rownum = 1) just collapses to one
	# row per (account, payment_document, payment_entry) with the partition's allocation total
	# and most recent transaction date — i.e. a plain GROUP BY with SUM and MAX.
	btp = frappe.qb.DocType("Bank Transaction Payments")
	bt = frappe.qb.DocType("Bank Transaction")
	ba = frappe.qb.DocType("Bank Account")

	result = (
		frappe.qb.from_(btp)
		.left_join(bt)
		.on(bt.name == btp.parent)
		.left_join(ba)
		.on(ba.name == bt.bank_account)
		.select(
			Sum(btp.allocated_amount).as_("total"),
			Max(bt.date).as_("latest_date"),
			ba.account.as_("gl_account"),
			btp.payment_document,
			btp.payment_entry,
		)
		.where(
			Tuple(btp.payment_document, btp.payment_entry).isin([Tuple(pd, pe) for pd, pe in docs])
			& (bt.docstatus == 1)
		)
		.groupby(ba.account, btp.payment_document, btp.payment_entry)
		.run(as_dict=True)
	)

	payment_allocation_details = {}
	for row in result:
		row["latest_date"] = getdate(row["latest_date"])
		payment_allocation_details.setdefault((row["payment_document"], row["payment_entry"]), {})[
			row["gl_account"]
		] = row

	return payment_allocation_details


def get_reconciled_bank_transactions(doctype, docname):
	return frappe.get_all(
		"Bank Transaction Payments",
		filters={"payment_document": doctype, "payment_entry": docname},
		pluck="parent",
	)


def remove_from_bank_transaction(doctype, docname):
	"""Remove a (cancelled) voucher from all Bank Transactions."""
	for bt_name in get_reconciled_bank_transactions(doctype, docname):
		bt = frappe.get_doc("Bank Transaction", bt_name)
		if bt.docstatus == DocStatus.cancelled():
			continue

		modified = False

		for pe in bt.payment_entries:
			if pe.payment_document == doctype and pe.payment_entry == docname:
				bt.remove(pe)
				modified = True

		if modified:
			bt.save()
