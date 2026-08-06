from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "templates"
    / "adws"
    / "adw_modules"
    / "permissions.py"
)


def load_permissions_module():
    package = types.ModuleType("adw_modules")
    package.__path__ = []
    data_types = types.ModuleType("adw_modules.data_types")
    data_types.AgentConfig = object
    data_types.SSSFConfig = object
    sys.modules["adw_modules"] = package
    sys.modules["adw_modules.data_types"] = data_types

    spec = importlib.util.spec_from_file_location("adw_modules.permissions", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


permissions = load_permissions_module()


class PermissionSnapshotTests(unittest.TestCase):
    def fixture(self, directory: str):
        repo = Path(directory)
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
        (repo / "tracked.txt").write_text("baseline\n")
        subprocess.run(["git", "add", "tracked.txt"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "baseline"], cwd=repo, check=True)

        untracked = repo / "installed-runtime.py"
        untracked.write_text("unchanged\n")
        run = SimpleNamespace(
            repo_root=repo,
            cfg=SimpleNamespace(
                defaults=SimpleNamespace(data_dir="adws/adw_data", protected_files=[])
            ),
        )
        agent = SimpleNamespace(name="scout", writes=[])
        return repo, untracked, run, agent

    @staticmethod
    def ignore_untracked(repo: Path):
        with (repo / ".git" / "info" / "exclude").open("a") as exclude:
            exclude.write("/installed-runtime.py\n")

    def test_ignore_rule_added_mid_run_does_not_look_like_agent_deleted_file(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, untracked, run, agent = self.fixture(directory)
            before = permissions.snapshot(run)
            self.ignore_untracked(repo)

            self.assertEqual([], permissions.enforce(run, None, agent, before))
            self.assertEqual("unchanged\n", untracked.read_text())

    def test_hidden_untracked_file_edit_is_still_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, untracked, run, agent = self.fixture(directory)
            before = permissions.snapshot(run)
            self.ignore_untracked(repo)
            untracked.write_text("changed\n")

            with self.assertRaises(permissions.PermissionBreach) as breach:
                permissions.enforce(run, None, agent, before)

            self.assertIn("left as-is (was already modified)", str(breach.exception))
            self.assertEqual("changed\n", untracked.read_text())

    def test_hidden_untracked_file_deletion_is_still_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, untracked, run, agent = self.fixture(directory)
            before = permissions.snapshot(run)
            self.ignore_untracked(repo)
            untracked.unlink()

            with self.assertRaises(permissions.PermissionBreach) as breach:
                permissions.enforce(run, None, agent, before)

            self.assertIn("REVERTED-BY-AGENT", str(breach.exception))


if __name__ == "__main__":
    unittest.main()
