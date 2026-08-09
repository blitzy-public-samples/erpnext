# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import sbool

from erpnext.accounts.doctype.bank_transaction.bank_transaction import (
	BankTransaction,
	refuse_missing_arguments,
)

PLAIN_NUMBER_PATTERN = re.compile(r"^-?\d+(\.\d+)?$")
# Tokens accepted by safe-expr-eval on the frontend (must stay in sync).
ALLOWED_FORMULA_TOKEN = re.compile(r"\s+|transaction_amount|\d+(?:\.\d+)?|[+\-*/%^()]")
PYTHON_ONLY_OPERATORS = ("**", "//")


def _is_expr_eval_formula(formula: str) -> bool:
	position = 0
	while position < len(formula):
		match = ALLOWED_FORMULA_TOKEN.match(formula, position)
		if not match:
			return False
		position = match.end()

	return formula.count("(") == formula.count(")")


def validate_amount_formula(formula: str) -> None:
	if not formula:
		return

	stripped = formula.strip()
	if PLAIN_NUMBER_PATTERN.match(stripped):
		return

	if any(operator in stripped for operator in PYTHON_ONLY_OPERATORS):
		frappe.throw(_("Invalid debit/credit formula: {0}").format(formula))

	if not _is_expr_eval_formula(stripped):
		frappe.throw(_("Invalid debit/credit formula: {0}").format(formula))

	# expr-eval uses ^ for exponentiation; translate for a smoke-test evaluation only.
	python_formula = stripped.replace("^", "**")

	try:
		result = frappe.safe_eval(python_formula, eval_globals=None, eval_locals={"transaction_amount": 1})
	except Exception:
		frappe.throw(_("Invalid debit/credit formula: {0}").format(formula))

	if not isinstance(result, (int | float)):
		frappe.throw(_("Invalid debit/credit formula: {0}").format(formula))


class BankTransactionRule(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		from erpnext.accounts.doctype.bank_transaction_rule_accounts.bank_transaction_rule_accounts import (
			BankTransactionRuleAccounts,
		)
		from erpnext.accounts.doctype.bank_transaction_rule_description_conditions.bank_transaction_rule_description_conditions import (
			BankTransactionRuleDescriptionConditions,
		)

		account: DF.Link | None
		accounts: DF.Table[BankTransactionRuleAccounts]
		bank_entry_type: DF.Literal["Single Account", "Multiple Accounts"]
		classify_as: DF.Literal["Bank Entry", "Payment Entry", "Transfer"]
		company: DF.Link
		description_rules: DF.Table[BankTransactionRuleDescriptionConditions]
		max_amount: DF.Currency
		min_amount: DF.Currency
		party: DF.DynamicLink | None
		party_type: DF.Link | None
		priority: DF.Int
		rule_description: DF.SmallText | None
		rule_name: DF.Data
		transaction_type: DF.Literal["Any", "Withdrawal", "Deposit"]
	# end: auto-generated types

	def before_insert(self):
		"""Assign the next priority number for the new rule"""
		if not self.priority:
			# Get the highest priority for rules in the same company
			highest_priority = frappe.db.get_value(
				"Bank Transaction Rule",
				filters={"company": self.company},
				fieldname="priority",
				order_by="priority DESC",
			)

			# Set priority to 1 if no rules exist, otherwise increment by 1
			self.priority = (highest_priority or 0) + 1

	def validate(self):
		if self.min_amount and self.max_amount:
			if self.min_amount > self.max_amount:
				frappe.throw(_("Min amount cannot be greater than max amount."))

		if self.classify_as == "Payment Entry":
			if not self.party_type:
				frappe.throw(_("Party type is required to create a payment entry."))

			if not self.party:
				frappe.throw(_("Party is required to create a payment entry."))

			if not self.account:
				frappe.throw(_("Party account is required to create a payment entry."))

		if self.classify_as == "Bank Entry":
			if not self.bank_entry_type or self.bank_entry_type == "Single Account":
				if not self.account:
					frappe.throw(_("Please add an account for the Bank Entry rule."))
			elif self.bank_entry_type == "Multiple Accounts":
				if not self.accounts:
					frappe.throw(_("Please configure accounts for the Bank Entry rule."))

				# Last row should not have any debit or credit set, since it will be computed via formula
				for index, account in enumerate(self.accounts):
					if index == len(self.accounts) - 1:
						if account.debit or account.credit:
							frappe.throw(
								_("The last account row must not have any debit or credit amounts set.")
							)
					else:
						if account.debit:
							validate_amount_formula(account.debit)
						if account.credit:
							validate_amount_formula(account.credit)

		# Validate regex
		for rule in self.description_rules:
			if rule.check == "Regex":
				try:
					re.compile(rule.value)
				except re.error:
					frappe.throw(_("Invalid regex pattern."))

		if self.bank_entry_type == "Single Account":
			account_company = frappe.get_cached_value("Account", self.account, "company")
			if account_company != self.company:
				frappe.throw(_("Account company does not match with the rule company."))

		if self.bank_entry_type == "Multiple Accounts":
			for account in self.accounts:
				account_company = frappe.get_cached_value("Account", account.account, "company")
				if account_company != self.company:
					frappe.throw(_("Account company does not match with the rule company."))

	def on_trash(self):
		"""
		Delete the matched rule from the bank transaction
		"""
		try:
			frappe.db.set_value(
				"Bank Transaction", {"matched_transaction_rule": self.name}, "matched_transaction_rule", None
			)
		except Exception:
			pass

	def after_delete(self):
		"""
		Rearrange the priorities of the rules
		"""
		rules = frappe.get_all(
			"Bank Transaction Rule",
			filters={"company": self.company, "name": ["!=", self.name]},
			order_by="priority asc",
		)
		for i, rule in enumerate(rules):
			frappe.db.set_value("Bank Transaction Rule", rule.name, "priority", i + 1)

	def evaluate_rule(self, transaction: BankTransaction) -> bool:
		"""
		Helper function to evaluate the rule for a given transaction
		"""
		if self.company != transaction.company:
			return False

		# Transaction type rule
		if self.transaction_type == "Withdrawal":
			if transaction.withdrawal == 0.0:
				return False

		if self.transaction_type == "Deposit":
			if transaction.deposit == 0.0:
				return False

		# Checking transaction amount limits
		transaction_amount = transaction.withdrawal or transaction.deposit

		if self.min_amount and transaction_amount < self.min_amount:
			return False

		if self.max_amount and transaction_amount > self.max_amount:
			return False

		# Checking description rules
		for rule_desc_rule in self.description_rules:
			desc = (transaction.description or "").lower()
			value = (rule_desc_rule.value or "").lower()

			if rule_desc_rule.check == "Contains":
				if value in desc:
					return True

			if rule_desc_rule.check == "Starts With":
				if desc.startswith(value):
					return True

			if rule_desc_rule.check == "Ends With":
				if desc.endswith(value):
					return True

			if rule_desc_rule.check == "Regex":
				if re.search(value, desc):
					return True

		return False


def scheduler_run_rule_evaluation():
	automatically_run_rules_on_unreconciled_transactions = frappe.db.get_single_value(
		"Accounts Settings", "automatically_run_rules_on_unreconciled_transactions"
	)

	if automatically_run_rules_on_unreconciled_transactions:
		_run_rule_evaluation(force_evaluate=False)


def get_permitted_companies_for_rule_evaluation() -> list[str] | None:
	"""
	The companies the session user is restricted to, or `None` when the user is not restricted.

	Only a Company User Permission narrows the scope, so `None` is returned for an unrestricted user
	rather than "every company on the site": an explicit list would silently exclude any Bank
	Transaction whose `company` is unset, which an unscoped pass has always covered.

	`frappe.get_list` is what resolves the restricted case, because it applies the permission query -
	unlike `frappe.get_all`, which sets `ignore_permissions`.
	"""
	from frappe.permissions import get_user_permissions

	if not get_user_permissions(frappe.session.user).get("Company"):
		return None

	return frappe.get_list("Company", pluck="name", limit_page_length=0, order_by="name asc")


@frappe.whitelist(methods=["POST"])
@refuse_missing_arguments
def run_rule_evaluation(force_evaluate: bool = False):
	# The job this enqueues WRITES `matched_transaction_rule` and `is_rule_evaluated` on Bank
	# Transactions, so read permission is not the right gate - a read-only user must not be able to
	# trigger a write, and `force_evaluate` re-stamps rows that were already evaluated.
	frappe.has_permission("Bank Transaction", ptype="write", throw=True)

	# The evaluator itself runs unscoped as the job's user, so the caller's company restriction is
	# resolved here, while the session is still the caller's, and carried into the job explicitly.
	companies = get_permitted_companies_for_rule_evaluation()
	if companies is not None and not companies:
		# Restricted, but to nothing readable: there is nothing for the pass to scan.
		return

	# `frappe.whitelist` hands query/form arguments over as strings, so a request asking for a forced
	# rescan arrives as "true" - which is truthy either way, but so is "false". `sbool` maps both, and
	# returns anything it cannot map unchanged rather than raising, so a malformed argument degrades to
	# the ordinary pass instead of a server error.
	force_evaluate = bool(sbool(force_evaluate)) if isinstance(force_evaluate, str) else bool(force_evaluate)

	# Deduplicated because the endpoint is reachable from the UI and from every statement import: an
	# unbounded fan-out of identical full-table rescans is a denial-of-service surface, and a single
	# queued pass already covers every transaction a later request would have covered.
	# `enqueue_after_commit` is what makes the pass see the rows that triggered it: a statement import
	# calls this before its own transaction commits, so a job started immediately would query the
	# database from another connection and find none of the freshly inserted Bank Transactions.
	# `create_job_id` namespaces the id by site, so the id below only has to distinguish the two modes.
	frappe.enqueue(
		method=_run_rule_evaluation,
		job_id=f"bank-transaction-rule-evaluation-force-{int(bool(force_evaluate))}",
		deduplicate=True,
		enqueue_after_commit=True,
		force_evaluate=force_evaluate,
		companies=companies,
	)


def _run_rule_evaluation(force_evaluate=False, companies: list[str] | None = None):
	"""
	Run the rule evaluation for all bank transactions

	If force evaluate is set to True, then transactions that were previously evaluated will be evaluated again.

	`companies`, when given, restricts the pass to those companies. The whitelisted entry point
	resolves it from the caller's permitted companies so a scoped user cannot trigger writes outside
	their own scope; the scheduler passes nothing and evaluates site-wide, as it always has.
	"""
	rules = frappe.get_all("Bank Transaction Rule", fields=["name"], order_by="priority asc")

	if not rules:
		return

	filters = {"status": "Unreconciled", "docstatus": 1}

	if not force_evaluate:
		filters["is_rule_evaluated"] = 0

	if companies:
		filters["company"] = ("in", companies)

	unreconciled_transactions = frappe.get_all(
		"Bank Transaction",
		filters=filters,
		fields=[
			"name",
			"bank_account",
			"company",
			"date",
			"withdrawal",
			"deposit",
			"description",
			"reference_number",
		],
	)

	if not unreconciled_transactions:
		return

	rule_docs = []

	for rule in rules:
		rule_doc = frappe.get_doc("Bank Transaction Rule", rule.name)
		rule_docs.append(rule_doc)

	# Run evaluation for each transaction
	contended = []

	for transaction in unreconciled_transactions:
		matched_rule = None

		for rule in rule_docs:
			if rule.evaluate_rule(transaction):
				matched_rule = rule
				break

		try:
			frappe.db.set_value(
				"Bank Transaction",
				transaction.name,
				{
					"is_rule_evaluated": 1,
					"matched_transaction_rule": matched_rule.name if matched_rule else None,
				},
			)
		except frappe.QueryDeadlockError:
			# This pass shares `tabBank Transaction` with the foreground reconcile path, which takes an
			# exclusive row lock before posting. When the two meet on the same row the engine refuses
			# this write - MariaDB with error 1020, PostgreSQL with a serialisation failure, both mapped
			# onto `QueryDeadlockError` - and, left alone, that single contended row aborted the ENTIRE
			# pass: the job went to the failed registry and every transaction after this one went
			# unevaluated, with nothing in the UI to say so.
			#
			# Degrading per row instead is correct rather than merely tolerant, because of WHAT this
			# write is: advisory match metadata, never financial state. `is_rule_evaluated` therefore
			# stays 0 for the contended row, which is precisely the filter this pass selects on, so the
			# next scheduled pass re-picks it and the suggestion arrives a cycle later. Nothing is lost
			# and nothing is half-written.
			#
			# The row that beat us is one being reconciled right now, so a suggested match for it is
			# about to be moot anyway - which is why a retry loop here would be effort spent on the one
			# row least likely to need the answer. The foreground path maps the same exception to a
			# "Refresh Required" refusal; this is the same decision taken from the other side.
			contended.append(transaction.name)
			continue

	if contended:
		# Logged once per pass rather than once per row: a burst of reconciliations can contend on many
		# rows at once, and a log line each would bury the fact that the pass itself completed.
		frappe.logger("bank_transaction_rule").info(
			f"Rule evaluation skipped {len(contended)} transaction(s) locked by a concurrent"
			f" reconciliation; they stay unevaluated for the next pass: {', '.join(contended[:20])}"
		)
