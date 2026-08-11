from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

SKILL_ROOT = Path(__file__).resolve().parents[1]
INSTALLER = SKILL_ROOT / "scripts" / "install.py"
TEMPLATE_WORKFLOW = SKILL_ROOT / "templates" / "adws" / "adw_scout_plan.py"
TEMPLATE_SPECS = SKILL_ROOT / "templates" / "adws" / "adw_modules" / "specs.py"
TEMPLATE_PLANNER = SKILL_ROOT / "templates" / "prompt_engineering" / "planner" / "user.md"
TEMPLATE_MAINTENANCE_CONFIG = SKILL_ROOT / "templates" / "sssf.maintenance.config.yaml"
TEMPLATE_SCOUT_PROMPT = SKILL_ROOT / "templates" / "prompt_engineering" / "scout" / "system.md"
BLOCKED_TEMPLATE_FILES = {
    "adws/adw_modules/data_types.py": "adws/adw_modules/data_types.py",
    "adws/adw_modules/agents.py": "adws/adw_modules/agents.py",
    "adws/adw_modules/runner.py": "adws/adw_modules/runner.py",
    "adws/adw_modules/tracer.py": "adws/adw_modules/tracer.py",
    "adws/adw_modules/console.py": "adws/adw_modules/console.py",
    "adws/adw_build_review.py": "adws/adw_build_review.py",
    "prompt_engineering/builder/user.md": "adws/adw_data/prompt_engineering/builder/user.md",
    "adws/tests/test_blocked.py": "adws/tests/test_blocked.py",
}


class ScoutPlanInstallTests(unittest.TestCase):
    def run_installer(self, target: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["uv", "run", str(INSTALLER), *args],
            cwd=target,
            text=True,
            capture_output=True,
            check=True,
        )

    def test_install_skip_restore_and_force_use_the_template(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            installed = target / "adws" / "adw_scout_plan.py"
            installed_specs = target / "adws" / "adw_modules" / "specs.py"
            installed_planner = target / "adws" / "adw_data" / "prompt_engineering" / "planner" / "user.md"
            installed_maintenance_config = (
                target / "adws" / "adw_sssf_config" / "sssf.maintenance.config.yaml"
            )
            installed_config = target / "adws" / "adw_sssf_config" / "sssf.config.yaml"
            installed_scout_prompt = (
                target / "adws" / "adw_data" / "prompt_engineering" / "scout" / "system.md"
            )

            self.run_installer(target)
            self.assertEqual(TEMPLATE_WORKFLOW.read_bytes(), installed.read_bytes())
            self.assertEqual(TEMPLATE_SPECS.read_bytes(), installed_specs.read_bytes())
            self.assertEqual(TEMPLATE_PLANNER.read_bytes(), installed_planner.read_bytes())
            self.assertEqual(
                TEMPLATE_MAINTENANCE_CONFIG.read_bytes(),
                installed_maintenance_config.read_bytes(),
            )
            self.assertEqual(TEMPLATE_SCOUT_PROMPT.read_bytes(), installed_scout_prompt.read_bytes())
            config = yaml.safe_load(installed_config.read_text())
            scout = next(agent for agent in config["agents"] if agent["name"] == "scout")
            self.assertEqual("medium", scout["thinking"])
            self.assertNotIn("subagent_continue", scout["tools"])
            scout_contract = installed_scout_prompt.read_text()
            self.assertIn("at most four subagents", scout_contract)
            self.assertIn("Never continue a subagent to recover truncated text", scout_contract)
            self.assertIn("32 KiB", scout_contract)
            for source, destination in BLOCKED_TEMPLATE_FILES.items():
                self.assertEqual(
                    (SKILL_ROOT / "templates" / source).read_bytes(),
                    (target / destination).read_bytes(),
                )
            installed_justfile = (target / "justfile").read_text()
            self.assertIn("scout-plan", installed_justfile)
            self.assertIn("build *ARGS", installed_justfile)
            self.assertIn("build-review *ARGS", installed_justfile)
            self.assertIn("specs *ARGS", installed_justfile)
            self.assertIn(".agents/skills/sssf/apps/visualizer", installed_justfile)

            installed.write_text("local customization\n")
            installed_data_types = target / "adws" / "adw_modules" / "data_types.py"
            installed_data_types.write_text("local blocked customization\n")
            self.run_installer(target)
            self.assertEqual("local customization\n", installed.read_text())
            self.assertEqual("local blocked customization\n", installed_data_types.read_text())

            installed.unlink()
            self.run_installer(target)
            self.assertEqual(TEMPLATE_WORKFLOW.read_bytes(), installed.read_bytes())

            installed.write_text("another customization\n")
            installed_specs.write_text("changed specs module\n")
            installed_maintenance_config.write_text("changed maintenance roster\n")
            self.run_installer(target, "--force")
            self.assertEqual(TEMPLATE_WORKFLOW.read_bytes(), installed.read_bytes())
            self.assertEqual(TEMPLATE_SPECS.read_bytes(), installed_specs.read_bytes())
            self.assertEqual(TEMPLATE_PLANNER.read_bytes(), installed_planner.read_bytes())
            self.assertEqual(
                TEMPLATE_MAINTENANCE_CONFIG.read_bytes(),
                installed_maintenance_config.read_bytes(),
            )
            for source, destination in BLOCKED_TEMPLATE_FILES.items():
                self.assertEqual(
                    (SKILL_ROOT / "templates" / source).read_bytes(),
                    (target / destination).read_bytes(),
                )

            listed = subprocess.run(
                ["just", "--justfile", str(target / "justfile"), "--list"],
                cwd=target,
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertIn("scout-plan", listed.stdout)
            self.assertIn("specs", listed.stdout)


if __name__ == "__main__":
    unittest.main()
