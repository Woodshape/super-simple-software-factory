import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from adw_modules import gates
from adw_modules.data_types import BuildOutput


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def test_diff_matches_claims_accepts_a_tracked_deletion_but_not_an_unknown_path(
        tmp_path, monkeypatch):
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.email", "test@example.com")
    git(tmp_path, "config", "user.name", "Test")
    deleted = tmp_path / "deleted.ts"
    deleted.write_text("export const legacy = true\n")
    git(tmp_path, "add", "deleted.ts")
    git(tmp_path, "commit", "-qm", "baseline")
    deleted.unlink()
    monkeypatch.chdir(tmp_path)

    deletion = gates.diff_matches_claims(
        BuildOutput(status="success", changed_files=["deleted.ts"]), None)
    unknown = gates.diff_matches_claims(
        BuildOutput(status="success", changed_files=["unknown.ts"]), None)

    assert deletion.passed
    assert deletion.checks[0].note == "changed, tracked file deleted"
    assert not unknown.passed
    assert unknown.violations == ["unknown.ts: claimed changed file does not exist"]
