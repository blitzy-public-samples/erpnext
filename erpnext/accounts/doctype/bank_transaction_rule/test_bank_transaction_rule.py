# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# See license.txt

import frappe
from frappe import qb
from frappe.exceptions import ValidationError

from erpnext.accounts.doctype.bank_transaction_rule.bank_transaction_rule import _run_rule_evaluation
from erpnext.accounts.test.accounts_mixin import AccountsTestMixin
from erpnext.tests.utils import ERPNextTestSuite


class TestBankTransactionRule(ERPNextTestSuite, AccountsTestMixin):
	def setUp(self):
		self.company = "_Test Company"
		self.customer = "_Test Customer"
		self.bank = "HDFC - _TC"
		self.debit_to = "Debtors - _TC"
		self.cash = "Cash - _TC"
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

	def _unique_rule_name(self, prefix: str) -> str:
		return f"{prefix}-{frappe.generate_hash(length=8)}"

	def _make_transaction(self, company=None, withdrawal=0, deposit=0, description=None):
		doc = frappe.new_doc("Bank Transaction")
		doc.company = company or self.company
		doc.withdrawal = withdrawal
		doc.deposit = deposit
		doc.description = description
		return doc

	def _make_rule_doc(self, rule_name, description_rules, **fields):
		data = {
			"doctype": "Bank Transaction Rule",
			"rule_name": rule_name,
			"company": self.company,
			"classify_as": "Bank Entry",
			"transaction_type": "Any",
			"account": self.bank,
			"description_rules": description_rules,
			**fields,
		}
		return frappe.get_doc(data)

	def _rule(self, prefix: str, description_rules, **fields):
		return self._make_rule_doc(self._unique_rule_name(prefix), description_rules, **fields)

	# --- evaluate_rule ---

	def test_evaluate_rule_company_mismatch(self):
		doc = self._rule("co", [{"check": "Contains", "value": "foo"}])
		tx = self._make_transaction(company="Nonexistent Company XYZ", deposit=1, description="foo")
		self.assertFalse(doc.evaluate_rule(tx))

	def test_evaluate_rule_withdrawal_type(self):
		doc = self._rule("wd", [{"check": "Contains", "value": "pay"}], transaction_type="Withdrawal")
		self.assertFalse(
			doc.evaluate_rule(self._make_transaction(withdrawal=0, deposit=100, description="payment"))
		)
		self.assertTrue(
			doc.evaluate_rule(self._make_transaction(withdrawal=50, deposit=0, description="payment"))
		)

	def test_evaluate_rule_deposit_type(self):
		doc = self._rule("dep", [{"check": "Contains", "value": "inc"}], transaction_type="Deposit")
		self.assertFalse(
			doc.evaluate_rule(self._make_transaction(withdrawal=50, deposit=0, description="income"))
		)
		self.assertTrue(
			doc.evaluate_rule(self._make_transaction(withdrawal=0, deposit=50, description="income"))
		)

	def test_evaluate_rule_min_max_amount(self):
		doc = self._rule("amt", [{"check": "Contains", "value": "x"}], min_amount=10, max_amount=100)
		self.assertFalse(doc.evaluate_rule(self._make_transaction(deposit=5, description="x")))
		self.assertTrue(doc.evaluate_rule(self._make_transaction(deposit=10, description="x")))
		self.assertTrue(doc.evaluate_rule(self._make_transaction(deposit=50, description="x")))
		self.assertTrue(doc.evaluate_rule(self._make_transaction(deposit=100, description="x")))
		self.assertFalse(doc.evaluate_rule(self._make_transaction(deposit=101, description="x")))
		doc_w = self._rule("amt_wd", [{"check": "Contains", "value": "x"}], min_amount=10, max_amount=100)
		self.assertTrue(doc_w.evaluate_rule(self._make_transaction(withdrawal=10, description="x")))

	def test_evaluate_rule_description_contains(self):
		doc = self._rule("ct", [{"check": "Contains", "value": "amazon"}])
		self.assertTrue(
			doc.evaluate_rule(self._make_transaction(deposit=1, description="AMAZON marketplace"))
		)
		self.assertFalse(doc.evaluate_rule(self._make_transaction(deposit=1, description="other vendor")))

	def test_evaluate_rule_description_starts_with(self):
		doc = self._rule("sw", [{"check": "Starts With", "value": "wire"}])
		self.assertTrue(doc.evaluate_rule(self._make_transaction(deposit=1, description="WIRE transfer in")))
		self.assertFalse(doc.evaluate_rule(self._make_transaction(deposit=1, description="in wire")))

	def test_evaluate_rule_description_ends_with(self):
		doc = self._rule("ew", [{"check": "Ends With", "value": "fee"}])
		self.assertTrue(doc.evaluate_rule(self._make_transaction(deposit=1, description="Bank monthly FEE")))
		self.assertFalse(doc.evaluate_rule(self._make_transaction(deposit=1, description="fee reversed")))

	def test_evaluate_rule_description_regex(self):
		doc = self._rule("rx", [{"check": "Regex", "value": r"inv-\d+"}])
		self.assertTrue(doc.evaluate_rule(self._make_transaction(deposit=1, description="INV-12345 payment")))
		self.assertFalse(doc.evaluate_rule(self._make_transaction(deposit=1, description="invoice abc")))

	def test_evaluate_rule_composite_fails_on_description(self):
		doc = self._rule(
			"cmp",
			[{"check": "Contains", "value": "target"}],
			transaction_type="Deposit",
			min_amount=10,
			max_amount=100,
		)
		self.assertFalse(doc.evaluate_rule(self._make_transaction(deposit=50, description="other merchant")))

	def test_evaluate_rule_empty_description_rules_returns_false(self):
		doc = frappe.get_doc(
			{
				"doctype": "Bank Transaction Rule",
				"rule_name": "tmp-empty",
				"company": self.company,
				"classify_as": "Bank Entry",
				"transaction_type": "Any",
				"account": self.bank,
				"description_rules": [],
			}
		)
		self.assertFalse(doc.evaluate_rule(self._make_transaction(deposit=10, description="anything")))

	# --- validate ---

	def test_validate_min_amount_greater_than_max(self):
		doc = self._rule("minmax", [{"check": "Contains", "value": "x"}], min_amount=200, max_amount=100)
		with self.assertRaises(ValidationError):
			doc.insert()

	def test_validate_payment_entry_requires_party_type(self):
		doc = self._rule(
			"pe_pt",
			[{"check": "Contains", "value": "x"}],
			classify_as="Payment Entry",
			party=self.customer,
			account=self.debit_to,
		)
		with self.assertRaises(ValidationError):
			doc.insert()

	def test_validate_payment_entry_requires_party(self):
		doc = self._rule(
			"pe_p",
			[{"check": "Contains", "value": "x"}],
			classify_as="Payment Entry",
			party_type="Customer",
			account=self.debit_to,
		)
		with self.assertRaises(ValidationError):
			doc.insert()

	def test_validate_payment_entry_requires_account(self):
		doc = self._rule(
			"pe_a",
			[{"check": "Contains", "value": "x"}],
			classify_as="Payment Entry",
			party_type="Customer",
			party=self.customer,
		)
		doc.account = None
		with self.assertRaises(ValidationError):
			doc.insert()

	def test_validate_bank_entry_single_requires_account(self):
		doc = self._rule(
			"be_acc",
			[{"check": "Contains", "value": "x"}],
			bank_entry_type="Single Account",
		)
		doc.account = None
		with self.assertRaises(ValidationError):
			doc.insert()

	def test_validate_bank_entry_multiple_requires_accounts(self):
		doc = self._rule(
			"be_ma",
			[{"check": "Contains", "value": "x"}],
			classify_as="Bank Entry",
			bank_entry_type="Multiple Accounts",
			accounts=[],
		)
		with self.assertRaises(ValidationError):
			doc.insert()

	def test_validate_bank_entry_multiple_last_row_must_not_have_debit_or_credit(self):
		doc = self._rule(
			"be_last",
			[{"check": "Contains", "value": "x"}],
			classify_as="Bank Entry",
			bank_entry_type="Multiple Accounts",
			accounts=[
				{"account": self.bank, "debit": "", "credit": ""},
				{"account": self.cash, "debit": "10", "credit": ""},
			],
		)
		with self.assertRaises(ValidationError):
			doc.insert()

	def test_validate_invalid_regex(self):
		doc = self._rule("bad_rx", [{"check": "Regex", "value": "["}])
		with self.assertRaises(ValidationError):
			doc.insert()

	def _multiple_accounts_rule(self, prefix: str, accounts, **fields):
		return self._rule(
			prefix,
			[{"check": "Contains", "value": "x"}],
			classify_as="Bank Entry",
			bank_entry_type="Multiple Accounts",
			accounts=accounts,
			**fields,
		)

	def test_validate_bank_entry_multiple_valid_amount_formulas(self):
		doc = self._multiple_accounts_rule(
			"be_formula",
			accounts=[
				{"account": self.bank, "debit": "200", "credit": ""},
				{"account": self.cash, "debit": "", "credit": "transaction_amount * 0.25"},
				{"account": self.cash, "debit": "", "credit": ""},
			],
		)
		doc.insert()
		self.assertTrue(doc.name)

	def test_validate_bank_entry_multiple_invalid_amount_formulas(self):
		malicious_formulas = [
			"__import__('os')",
			"eval('1+1')",
			"open('/etc/passwd')",
			"transaction_amount ** 2",
			"transaction_amount // 2",
		]
		for formula in malicious_formulas:
			with self.subTest(formula=formula):
				doc = self._multiple_accounts_rule(
					"be_bad_formula",
					accounts=[
						{"account": self.bank, "debit": formula, "credit": ""},
						{"account": self.cash, "debit": "", "credit": ""},
					],
				)
				with self.assertRaises(ValidationError):
					doc.insert()

	# --- _run_rule_evaluation ---

	def test_run_rule_evaluation_stamps_matched_rule(self):
		"""A submitted, unreconciled transaction is stamped with the rule that matches it.

		This and the priority test below are the only backend coverage of the rule engine
		stamping a suggested match onto an unreconciled bank transaction, which is what the
		reconciliation workbench renders as its suggestion.
		"""
		# The token is regenerated on every run and appears in both the rule condition and the
		# description. The evaluator loads every rule on the site, with no company filter, so
		# this is what keeps the transaction matchable by this test's rule alone.
		token = f"btr-match-{frappe.generate_hash(length=8)}"
		rule = self._rule("auto_match", [{"check": "Contains", "value": token}], priority=11)
		rule.insert()

		transaction = frappe.get_doc(
			{
				"doctype": "Bank Transaction",
				"date": "2026-01-15",
				"description": f"NEFT CR REF {token} settled",
				# set_status() derives the status from unallocated_amount, so a zero-amount
				# transaction would submit as "Reconciled" and be filtered out. evaluate_rule
				# also reads this as the transaction amount.
				"deposit": 250,
				# insert() back-fills an unset currency from the session defaults, which need not
				# be the bank account's currency - validate_currency then rejects the save. It is
				# resolved through exactly the lookup that validator uses, the bank GL account's
				# own account_currency, so the two can never disagree.
				"currency": frappe.get_cached_value("Account", self.bank, "account_currency"),
				# company is omitted on purpose: it is read-only and fetched from bank_account,
				# and that fetch is what makes the company check in evaluate_rule succeed.
				"bank_account": self.bank_account,
			}
		).insert()
		# status defaults to "Pending"; only before_submit -> set_status promotes it to
		# "Unreconciled", so the document has to be submitted and not merely inserted.
		transaction.submit()

		# Assert the filters the evaluator selects on, so a green run below cannot be vacuous.
		self.assertEqual(transaction.docstatus, 1)
		self.assertEqual(transaction.status, "Unreconciled")
		self.assertEqual(transaction.company, self.company)
		self.assertEqual(transaction.is_rule_evaluated, 0)

		# The whitelisted run_rule_evaluation() only checks a permission and then enqueues a
		# background job, so the private synchronous entry point is the one a test can assert on.
		_run_rule_evaluation()

		# The evaluator writes through frappe.db.set_value and never updates the in-memory
		# document, so both fields have to be re-read from the database.
		evaluated = frappe.db.get_value(
			"Bank Transaction",
			transaction.name,
			["matched_transaction_rule", "is_rule_evaluated"],
			as_dict=True,
		)
		self.assertEqual(evaluated.matched_transaction_rule, rule.name)
		# is_rule_evaluated is a Check (smallint) column - compare against 1, not True.
		self.assertEqual(evaluated.is_rule_evaluated, 1)

	def test_run_rule_evaluation_lower_priority_number_wins(self):
		"""Of two matching rules, the one with the lower priority number is the one stamped."""
		token = f"btr-priority-{frappe.generate_hash(length=8)}"
		# Both rules match the same transaction and the insertion order is deliberately INVERTED
		# against priority: the higher priority number is inserted FIRST. The evaluator orders
		# rules by "priority asc" and breaks on the first match, so only a genuinely
		# priority-ordered evaluation can stamp the second-inserted rule. Inserting the lower
		# number first - or leaving priority to before_insert, which back-fills it in insertion
		# order - would make the assertion below hold under plain creation ordering too, and
		# prove nothing. Do not "tidy" the inversion away.
		runner_up = self._rule("prio_high", [{"check": "Contains", "value": token}], priority=91)
		runner_up.insert()
		winner = self._rule("prio_low", [{"check": "Contains", "value": token}], priority=21)
		winner.insert()
		self.assertLess(winner.priority, runner_up.priority)

		transaction = frappe.get_doc(
			{
				"doctype": "Bank Transaction",
				"date": "2026-01-15",
				"description": f"ACH DR REF {token} debit",
				"withdrawal": 175,
				"currency": frappe.get_cached_value("Account", self.bank, "account_currency"),
				"bank_account": self.bank_account,
			}
		).insert()
		transaction.submit()

		# Guard this fixture's eligibility too: the evaluator only looks at submitted,
		# "Unreconciled", not-yet-evaluated transactions.
		self.assertEqual(transaction.docstatus, 1)
		self.assertEqual(transaction.status, "Unreconciled")
		self.assertEqual(transaction.is_rule_evaluated, 0)
		# Both rules match on their own, so only the priority order can decide which is stamped.
		self.assertTrue(runner_up.evaluate_rule(transaction))
		self.assertTrue(winner.evaluate_rule(transaction))

		_run_rule_evaluation()

		evaluated = frappe.db.get_value(
			"Bank Transaction",
			transaction.name,
			["matched_transaction_rule", "is_rule_evaluated"],
			as_dict=True,
		)
		self.assertEqual(evaluated.matched_transaction_rule, winner.name)
		self.assertNotEqual(evaluated.matched_transaction_rule, runner_up.name)
		self.assertEqual(evaluated.is_rule_evaluated, 1)
