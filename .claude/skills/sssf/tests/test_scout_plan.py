from __future__ import annotations

import ast
import subprocess
import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[4]
WORKFLOW = SKILL_ROOT / "templates" / "adws" / "adw_scout_plan.py"
JUSTFILES = [SKILL_ROOT / "templates" / "justfile", REPO_ROOT / "justfile"]
PARITY_PAIRS = [
    (SKILL_ROOT / "templates" / "adws" / "adw_scout_plan.py", REPO_ROOT / "adws" / "adw_scout_plan.py"),
    (SKILL_ROOT / "templates" / "adws" / "adw_modules" / "specs.py", REPO_ROOT / "adws" / "adw_modules" / "specs.py"),
    (SKILL_ROOT / "templates" / "adws" / "adw_modules" / "gates.py", REPO_ROOT / "adws" / "adw_modules" / "gates.py"),
    (SKILL_ROOT / "templates" / "prompt_engineering" / "planner" / "user.md", REPO_ROOT / "adws" / "adw_data" / "prompt_engineering" / "planner" / "user.md"),
    (SKILL_ROOT / "templates" / "justfile", REPO_ROOT / "justfile"),
    *[
        (SKILL_ROOT / "templates" / "adws" / name, REPO_ROOT / "adws" / name)
        for name in (
            "adw_plan.py", "adw_plan_build.py", "adw_plan_build_test.py",
            "adw_plan_build_test_quality.py", "adw_simple_sdlc.py",
        )
    ],
]


def keyword(call: ast.Call, name: str) -> ast.expr | None:
    return next((item.value for item in call.keywords if item.arg == name), None)


def dotted_name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{dotted_name(node.value)}.{node.attr}"
    return ""


class ScoutPlanWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = WORKFLOW.read_text()
        cls.tree = ast.parse(cls.source)
        cls.main = next(
            node for node in cls.tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "main"
        )

    def test_declares_only_scout_and_planner(self):
        assignment = next(
            node for node in self.tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "REQUIRED_AGENTS"
                    for target in node.targets)
        )
        self.assertEqual(["scout", "planner"], ast.literal_eval(assignment.value))

    def test_phase_order_and_typed_handoff(self):
        phase_blocks = [node for node in self.main.body if isinstance(node, ast.With)]
        phase_names = []
        agent_calls = []

        for block in phase_blocks:
            context_call = block.items[0].context_expr
            self.assertIsInstance(context_call, ast.Call)
            params = context_call.args[0]
            self.assertIsInstance(params, ast.Call)
            phase_names.append(ast.literal_eval(keyword(params, "name")))
            agent_calls.extend(
                node for node in ast.walk(block)
                if isinstance(node, ast.Call) and dotted_name(node.func) == "ph.call"
            )

        self.assertEqual(["request", "scout", "plan"], phase_names)
        self.assertEqual(2, len(agent_calls))

        scout_call, plan_call = [call.args[0] for call in agent_calls]
        self.assertEqual("ScoutOutput", dotted_name(keyword(scout_call, "output_type")))
        self.assertIsNone(keyword(scout_call, "previous"))
        self.assertEqual(
            ["gates.artifacts_exist"],
            [dotted_name(gate) for gate in keyword(scout_call, "gates").elts],
        )

        self.assertEqual("PlanOutput", dotted_name(keyword(plan_call, "output_type")))
        self.assertEqual("found", dotted_name(keyword(plan_call, "previous")))
        self.assertEqual(
            ["gates.artifacts_exist", "gates.files_non_empty", "gates.plan_spec_valid"],
            [dotted_name(gate) for gate in keyword(plan_call, "gates").elts],
        )

    def test_has_no_implementation_or_delivery_phases(self):
        forbidden_names = {
            "build", "builder", "test", "quality", "review", "reviewer",
            "document", "documenter", "commit", "git", "lifecycle", "spec_start",
        }
        names = {node.id for node in ast.walk(self.tree) if isinstance(node, ast.Name)}
        attributes = {node.attr for node in ast.walk(self.tree) if isinstance(node, ast.Attribute)}
        self.assertTrue(forbidden_names.isdisjoint(names | attributes))

        finish_calls = [
            node for node in ast.walk(self.main)
            if isinstance(node, ast.Call) and dotted_name(node.func) == "run.finish"
        ]
        self.assertEqual(1, len(finish_calls))

    def test_source_and_stamped_files_are_byte_identical(self):
        for source, stamped in PARITY_PAIRS:
            with self.subTest(source=source, stamped=stamped):
                self.assertEqual(source.read_bytes(), stamped.read_bytes())

    def test_both_justfiles_list_and_dry_run_workflow_and_specs(self):
        for justfile in JUSTFILES:
            with self.subTest(justfile=justfile):
                listed = subprocess.run(
                    ["just", "--justfile", str(justfile), "--list"],
                    cwd=REPO_ROOT,
                    text=True,
                    capture_output=True,
                    check=True,
                )
                self.assertIn("scout-plan", listed.stdout)
                self.assertIn("specs", listed.stdout)

                dry_run = subprocess.run(
                    ["just", "--justfile", str(justfile), "--dry-run",
                     "scout-plan", "map auth before planning"],
                    cwd=REPO_ROOT,
                    text=True,
                    capture_output=True,
                    check=True,
                )
                command = dry_run.stdout + dry_run.stderr
                self.assertIn("adws/adw_scout_plan.py", command)
                self.assertIn("--config", command)

                specs_dry_run = subprocess.run(
                    ["just", "--justfile", str(justfile), "--dry-run", "specs"],
                    cwd=REPO_ROOT,
                    text=True,
                    capture_output=True,
                    check=True,
                )
                specs_command = specs_dry_run.stdout + specs_dry_run.stderr
                self.assertIn("adws/adw_modules/specs.py", specs_command)
                self.assertNotIn("adw_scout_plan.py", specs_command)


if __name__ == "__main__":
    unittest.main()
