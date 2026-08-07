from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
INSTALLER = SKILL_ROOT / "scripts" / "install.py"
TEMPLATE_WORKFLOW = SKILL_ROOT / "templates" / "adws" / "adw_scout_plan.py"
TEMPLATE_SPECS = SKILL_ROOT / "templates" / "adws" / "adw_modules" / "specs.py"
TEMPLATE_PLANNER = SKILL_ROOT / "templates" / "prompt_engineering" / "planner" / "user.md"
TEMPLATE_MAINTENANCE_CONFIG = SKILL_ROOT / "templates" / "sssf.maintenance.config.yaml"


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

            self.run_installer(target)
            self.assertEqual(TEMPLATE_WORKFLOW.read_bytes(), installed.read_bytes())
            self.assertEqual(TEMPLATE_SPECS.read_bytes(), installed_specs.read_bytes())
            self.assertEqual(TEMPLATE_PLANNER.read_bytes(), installed_planner.read_bytes())
            self.assertEqual(
                TEMPLATE_MAINTENANCE_CONFIG.read_bytes(),
                installed_maintenance_config.read_bytes(),
            )
            installed_justfile = (target / "justfile").read_text()
            self.assertIn("scout-plan", installed_justfile)
            self.assertIn("build *ARGS", installed_justfile)
            self.assertIn("build-review *ARGS", installed_justfile)
            self.assertIn("specs *ARGS", installed_justfile)
            self.assertIn(".agents/skills/sssf/apps/visualizer", installed_justfile)

            installed.write_text("local customization\n")
            self.run_installer(target)
            self.assertEqual("local customization\n", installed.read_text())

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
