from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[4]
TEMPLATE_ADWS = SKILL_ROOT / "templates" / "adws"

PARITY_PAIRS = [
    (TEMPLATE_ADWS / "adw_modules" / name, REPO_ROOT / "adws" / "adw_modules" / name)
    for name in ("data_types.py", "agents.py", "runner.py", "tracer.py", "console.py")
] + [
    (TEMPLATE_ADWS / "adw_build_review.py", REPO_ROOT / "adws" / "adw_build_review.py"),
    (SKILL_ROOT / "templates" / "prompt_engineering" / "builder" / "user.md",
     REPO_ROOT / "adws" / "adw_data" / "prompt_engineering" / "builder" / "user.md"),
    (TEMPLATE_ADWS / "tests" / "test_blocked.py",
     REPO_ROOT / "adws" / "tests" / "test_blocked.py"),
]


class BlockedTemplateTests(unittest.TestCase):
    def test_template_runtime_model_runner_trace_and_workflow(self):
        subprocess.run(
            ["uv", "run", str(TEMPLATE_ADWS / "tests" / "test_blocked.py")],
            cwd=REPO_ROOT,
            check=True,
        )

    def test_changed_runtime_prompt_workflow_and_regression_are_byte_identical(self):
        for source, installed in PARITY_PAIRS:
            with self.subTest(source=source):
                self.assertEqual(source.read_bytes(), installed.read_bytes())

    def test_every_installed_and_template_builder_call_keeps_build_output_binding(self):
        for root in (REPO_ROOT / "adws", TEMPLATE_ADWS):
            callsites = []
            for path in root.glob("adw_*.py"):
                text = path.read_text()
                callsites.extend(
                    line for line in text.splitlines()
                    if "output_type=BuildOutput" in line
                )
            self.assertEqual(13, len(callsites), root)


if __name__ == "__main__":
    unittest.main()
