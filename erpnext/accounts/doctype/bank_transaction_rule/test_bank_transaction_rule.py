# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# See license.txt

from unittest.mock import patch

import frappe
from frappe import qb
from frappe.exceptions import ValidationError
from frappe.permissions import add_user_permission, remove_user_permission

from erpnext.accounts.doctype.bank_transaction_rule.bank_transaction_rule import (
	_run_rule_evaluation,
	get_permitted_companies_for_rule_evaluation,
	run_rule_evaluation,
)
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

	def _make_user(self, roles: list[str], companies: list[str] | None = None) -> str:
		"""
		A throwaway enabled user with exactly the roles given, and optionally restricted to a set of
		companies by User Permission.

		The session is restored through `addCleanup` rather than at the end of the test body so an
		assertion failure cannot leak an impersonated session into the next test.
		"""
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": f"bank-rule-{frappe.generate_hash(length=10)}@example.com",
				"first_name": "Bank Rule",
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

		self.assertEqual(transaction.docstatus, 1)
		self.assertEqual(transaction.status, "Unreconciled")
		self.assertEqual(transaction.company, self.company)
		self.assertEqual(transaction.is_rule_evaluated, 0)

		# The whitelisted run_rule_evaluation() only checks permission and then enqueues a
		# background job, so it would stamp nothing inside a synchronous test. The private entry
		# point it enqueues is the one a test can assert the stamping on.
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
		token = f"btr-priority-{frappe.generate_hash(length=8)}"
		# The insertion order is deliberately INVERTED against priority: the higher priority number
		# is inserted FIRST. The evaluator orders rules by "priority asc" and breaks on the first
		# match, so only a genuinely priority-ordered evaluation can stamp the second-inserted rule.
		# Inserting the lower number first - or leaving priority to before_insert, which back-fills
		# it in insertion order - would make the assertion below hold under plain creation ordering
		# too, and prove nothing.
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

	# --- run_rule_evaluation: the whitelisted endpoint ---

	def test_run_rule_evaluation_defers_the_job_until_after_commit(self):
		"""
		The endpoint's own queueing contract, asserted at the endpoint rather than around it.

		A statement import calls this while its own transaction is still open, and the worker runs on
		a separate database connection. Enqueueing immediately would therefore start a pass that
		cannot see the Bank Transactions the import just inserted, and those rows would be left
		unstamped with no second attempt - the pass marks nothing, so nothing is retried.
		"""
		self._rule("enqueue_contract", [{"check": "Contains", "value": "irrelevant"}], priority=31).insert()

		with patch.object(frappe, "enqueue") as enqueue:
			run_rule_evaluation()

		enqueue.assert_called_once()
		kwargs = enqueue.call_args.kwargs
		self.assertIs(kwargs["enqueue_after_commit"], True)
		# The endpoint is reachable from the rules UI and from every statement import, so identical
		# full-table rescans must collapse into one queued pass instead of fanning out.
		self.assertIs(kwargs["deduplicate"], True)
		self.assertTrue(kwargs["job_id"])
		self.assertIs(kwargs["method"], _run_rule_evaluation)
		self.assertIs(kwargs["force_evaluate"], False)
		# Administrator carries no Company User Permission, so the pass stays site-wide.
		self.assertIsNone(kwargs["companies"])

	def test_run_rule_evaluation_job_ids_separate_the_two_modes(self):
		# A forced rescan must not be deduplicated away by an ordinary pass already sitting in the
		# queue: the two cover different row sets, so they need different identities.
		self._rule("enqueue_modes", [{"check": "Contains", "value": "irrelevant"}], priority=32).insert()

		with patch.object(frappe, "enqueue") as enqueue:
			run_rule_evaluation()
			run_rule_evaluation(force_evaluate=True)

		self.assertEqual(enqueue.call_count, 2)
		plain_job_id = enqueue.call_args_list[0].kwargs["job_id"]
		forced_job_id = enqueue.call_args_list[1].kwargs["job_id"]
		self.assertNotEqual(plain_job_id, forced_job_id)
		self.assertIs(enqueue.call_args_list[1].kwargs["force_evaluate"], True)

	def test_run_rule_evaluation_coerces_a_string_force_flag(self):
		# `frappe.whitelist` hands query/form arguments over as strings, so a request asking for a
		# forced rescan arrives as "true" and must not be read as the truthy string "false".
		self._rule("enqueue_coerce", [{"check": "Contains", "value": "irrelevant"}], priority=33).insert()

		with patch.object(frappe, "enqueue") as enqueue:
			run_rule_evaluation(force_evaluate="false")
			run_rule_evaluation(force_evaluate="true")

		self.assertIs(enqueue.call_args_list[0].kwargs["force_evaluate"], False)
		self.assertIs(enqueue.call_args_list[1].kwargs["force_evaluate"], True)

	def test_run_rule_evaluation_requires_write_permission(self):
		"""
		The endpoint enqueues a job that WRITES `matched_transaction_rule` and `is_rule_evaluated`,
		so a user who may only read Bank Transactions must not be able to trigger it.
		"""
		self._rule("enqueue_authz", [{"check": "Contains", "value": "irrelevant"}], priority=34).insert()
		# Deliberately no accounting roles: every user carries the implicit "All" role, which grants
		# no write on Bank Transaction, so this models the least-privileged authenticated caller.
		self._as_user(self._make_user(roles=[]))

		self.assertFalse(frappe.has_permission("Bank Transaction", ptype="write"))
		with patch.object(frappe, "enqueue") as enqueue:
			with self.assertRaises(frappe.PermissionError):
				run_rule_evaluation()

		# The refusal has to happen before anything is queued, not after.
		enqueue.assert_not_called()

	def test_run_rule_evaluation_is_allowed_for_a_writer(self):
		self._rule("enqueue_allowed", [{"check": "Contains", "value": "irrelevant"}], priority=35).insert()
		self._as_user(self._make_user(roles=["Accounts User", "Accounts Manager"]))

		self.assertTrue(frappe.has_permission("Bank Transaction", ptype="write"))
		with patch.object(frappe, "enqueue") as enqueue:
			run_rule_evaluation()

		enqueue.assert_called_once()

	def test_run_rule_evaluation_scopes_the_pass_to_permitted_companies(self):
		"""
		The queued pass runs unscoped inside the worker, so the caller's company restriction has to be
		resolved while the session is still the caller's and carried into the job explicitly.
		"""
		self._rule("enqueue_scope", [{"check": "Contains", "value": "irrelevant"}], priority=36).insert()
		# An unrestricted caller is deliberately NOT narrowed to an explicit company list: naming every
		# company would silently exclude any Bank Transaction whose company is unset.
		self.assertIsNone(get_permitted_companies_for_rule_evaluation())

		self._as_user(self._make_user(roles=["Accounts User", "Accounts Manager"], companies=[self.company]))

		self.assertEqual(get_permitted_companies_for_rule_evaluation(), [self.company])
		with patch.object(frappe, "enqueue") as enqueue:
			run_rule_evaluation()

		self.assertEqual(enqueue.call_args.kwargs["companies"], [self.company])

	def test_run_rule_evaluation_leaves_other_companies_unstamped(self):
		"""
		The company scope is enforced by the evaluator and not merely reported by the endpoint: a
		transaction outside the scope must come back unevaluated.
		"""
		token = f"btr-scope-{frappe.generate_hash(length=8)}"
		self._rule("scope_rule", [{"check": "Contains", "value": token}], priority=37).insert()

		transaction = frappe.get_doc(
			{
				"doctype": "Bank Transaction",
				"date": "2026-01-15",
				"description": f"NEFT CR REF {token} settled",
				"deposit": 300,
				"currency": frappe.get_cached_value("Account", self.bank, "account_currency"),
				"bank_account": self.bank_account,
			}
		).insert()
		transaction.submit()
		self.assertEqual(transaction.company, self.company)

		# A scope that excludes this transaction's company must leave it untouched...
		_run_rule_evaluation(companies=["_Test Company 2"])
		untouched = frappe.db.get_value(
			"Bank Transaction",
			transaction.name,
			["matched_transaction_rule", "is_rule_evaluated"],
			as_dict=True,
		)
		self.assertIsNone(untouched.matched_transaction_rule)
		self.assertEqual(untouched.is_rule_evaluated, 0)

		# ...while a scope that includes it stamps it, which is what makes the check above non-vacuous.
		_run_rule_evaluation(companies=[self.company])
		stamped = frappe.db.get_value(
			"Bank Transaction",
			transaction.name,
			["matched_transaction_rule", "is_rule_evaluated"],
			as_dict=True,
		)
		self.assertIsNotNone(stamped.matched_transaction_rule)
		self.assertEqual(stamped.is_rule_evaluated, 1)

	# --- _run_rule_evaluation: a contended row must not take the whole pass down ---

	def _submitted_transaction_for_rule(self, token: str, deposit: float = 250.0):
		"""A submitted, unreconciled, not-yet-evaluated transaction this token's rule will match."""
		transaction = frappe.get_doc(
			{
				"doctype": "Bank Transaction",
				"date": "2026-01-15",
				"description": f"NEFT CR REF {token} settled",
				"deposit": deposit,
				"currency": frappe.get_cached_value("Account", self.bank, "account_currency"),
				"bank_account": self.bank_account,
			}
		).insert()
		transaction.submit()

		self.assertEqual(transaction.status, "Unreconciled")
		self.assertEqual(transaction.is_rule_evaluated, 0)
		return transaction

	@staticmethod
	def _stamp_of(name: str) -> dict:
		return frappe.db.get_value(
			"Bank Transaction", name, ["matched_transaction_rule", "is_rule_evaluated"], as_dict=True
		)

	def test_run_rule_evaluation_survives_a_row_locked_by_a_concurrent_reconciliation(self):
		"""
		This pass shares `tabBank Transaction` with the foreground reconcile path, which takes an
		exclusive row lock before posting. When the two meet on the same row the engine refuses this
		write - MariaDB with error 1020, PostgreSQL with a serialisation failure, both mapped onto
		`QueryDeadlockError` - and a single contended row used to abort the ENTIRE pass: the job went to
		the failed registry and every transaction after it went unevaluated, with nothing in the UI to
		say so.

		The lock is simulated rather than raced, because a race cannot be relied on to land on a chosen
		row inside a synchronous test - and what has to be specified is the HANDLING, not the timing.

		Two things are asserted, and the second is what makes the first meaningful: the pass completes
		AND it keeps stamping the rows it can reach. The contended row is left with
		`is_rule_evaluated = 0`, which is exactly the filter this pass selects on, so the next pass
		re-picks it - the degradation is a deferral, not a loss.
		"""
		token = f"btr-deadlock-{frappe.generate_hash(length=8)}"
		self._rule("deadlock", [{"check": "Contains", "value": token}], priority=12).insert()

		contended = self._submitted_transaction_for_rule(token, deposit=250)
		survivor = self._submitted_transaction_for_rule(token, deposit=260)

		real_set_value = frappe.db.set_value

		def refuse_the_contended_row(doctype, name, *args, **kwargs):
			if doctype == "Bank Transaction" and name == contended.name:
				raise frappe.QueryDeadlockError(
					"Record has changed since last read in table 'tabBank Transaction'"
				)
			return real_set_value(doctype, name, *args, **kwargs)

		with patch("frappe.db.set_value", side_effect=refuse_the_contended_row):
			# No exception escapes: before this fix the call itself raised.
			_run_rule_evaluation()

		blocked = self._stamp_of(contended.name)
		self.assertEqual(blocked.is_rule_evaluated, 0)
		self.assertIsNone(blocked.matched_transaction_rule)

		# The pass carried on past the refusal, which is the whole point.
		stamped = self._stamp_of(survivor.name)
		self.assertEqual(stamped.is_rule_evaluated, 1)
		self.assertIsNotNone(stamped.matched_transaction_rule)

		# And the deferred row is picked up by the next pass, once the contention is gone.
		_run_rule_evaluation()
		recovered = self._stamp_of(contended.name)
		self.assertEqual(recovered.is_rule_evaluated, 1)
		self.assertIsNotNone(recovered.matched_transaction_rule)

	def test_run_rule_evaluation_completes_when_every_row_is_locked(self):
		# The degenerate case: a burst of reconciliations can contend on every row the pass selected.
		# It must still finish rather than raise, and must write nothing.
		token = f"btr-alllocked-{frappe.generate_hash(length=8)}"
		self._rule("alllocked", [{"check": "Contains", "value": token}], priority=13).insert()
		transaction = self._submitted_transaction_for_rule(token, deposit=270)

		with patch(
			"frappe.db.set_value",
			side_effect=frappe.QueryDeadlockError("Record has changed since last read"),
		):
			_run_rule_evaluation()

		blocked = self._stamp_of(transaction.name)
		self.assertEqual(blocked.is_rule_evaluated, 0)
		self.assertIsNone(blocked.matched_transaction_rule)
