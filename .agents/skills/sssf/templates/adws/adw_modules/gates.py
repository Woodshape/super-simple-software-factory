"""Validation gates: verify the envelope's CLAIMS, never guesses.

A gate is `gate(envelope, run) -> GateReport` — one check per item it looked at.
Violations are derived from the failed checks and sent back to the SAME agent
session as a correction. Every check is recorded either way, so a green gate
says WHAT it verified instead of only that it passed.

Gates check what is mechanically checkable; plan quality is a reviewer's job.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from . import specs
from .data_types import EnvelopeBase, GateReport

TAIL_CHARS = 1000        # command output kept as evidence on a failure


def _size(path: Path) -> str:
    n = path.stat().st_size
    return f"{n}B" if n < 1024 else f"{n / 1024:.1f}KB"


def artifacts_exist(envelope: EnvelopeBase, run) -> GateReport:
    report = GateReport()
    for a in envelope.artifacts:
        p = Path(a)
        report.check(a, p.exists(),
                     f"exists, {_size(p)}" if p.exists() else "declared artifact does not exist")
    return report


def files_non_empty(envelope: EnvelopeBase, run) -> GateReport:
    report = GateReport()
    for a in envelope.artifacts:
        p = Path(a)
        if not (p.exists() and p.is_file()):
            continue                       # existence is artifacts_exist's job
        empty = p.stat().st_size == 0
        report.check(a, not empty, "declared artifact is empty" if empty else _size(p))
    return report


def plan_spec_valid(envelope: EnvelopeBase, run) -> GateReport:
    """Verify the planner's two planned, safe, byte-identical spec artifacts."""
    report = GateReport()
    artifact_count_ok = len(envelope.artifacts) == 2
    report.check("plan artifacts", artifact_count_ok,
                 "exactly 2 artifacts declared" if artifact_count_ok
                 else f"expected exactly 2 artifacts, found {len(envelope.artifacts)}")

    try:
        artifacts = specs.resolve_plan_artifacts(envelope, run)
        report.check("plan artifact paths", True,
                     "one handoff plan and one direct adw-prefixed durable spec")
    except (specs.SpecMetadataError, OSError) as error:
        report.check("plan artifact paths", False, str(error))
        return report

    contents: dict[Path, bytes] = {}
    for label, path in (("durable spec metadata", artifacts.authoritative),
                        ("handoff plan metadata", artifacts.mirror)):
        try:
            contents[path] = path.read_bytes()
            document = specs.parse_bytes(contents[path], str(path))
            report.check(label, document.status == "planned",
                         "status is planned" if document.status == "planned"
                         else f"planner-created artifact has status {document.status}, expected planned")
        except (OSError, specs.SpecMetadataError) as error:
            report.check(label, False, str(error))

    both_read = len(contents) == 2
    identical = both_read and contents[artifacts.authoritative] == contents[artifacts.mirror]
    report.check("plan copies identical", identical,
                 "byte-identical" if identical else
                 "could not read both plan copies" if not both_read else
                 "durable spec and handoff plan differ")
    return report


def json_parses(envelope: EnvelopeBase, run) -> GateReport:
    report = GateReport()
    for a in envelope.artifacts:
        p = Path(a)
        if p.suffix != ".json" or not p.exists():
            continue
        try:
            parsed = json.loads(p.read_text())
            report.check(a, True, f"parses, {type(parsed).__name__}")
        except json.JSONDecodeError as e:
            report.check(a, False, f"declared JSON artifact does not parse: {e}")
    return report


def diff_matches_claims(envelope: EnvelopeBase, run) -> GateReport:
    """Every claimed path must exist or be a tracked deletion in the Git diff."""
    report = GateReport()
    diff = subprocess.run(
        ["git", "diff", "--name-only", "HEAD", "--"],
        capture_output=True, text=True, check=False,
    )
    changed = ({Path(path).as_posix() for path in diff.stdout.splitlines()}
               if diff.returncode == 0 else set())
    for f in getattr(envelope, "changed_files", []):
        p = Path(f)
        deleted = not p.exists() and p.as_posix() in changed
        report.check(
            f,
            p.exists() or deleted,
            f"exists, {_size(p)}" if p.exists()
            else "changed, tracked file deleted" if deleted
            else "claimed changed file does not exist",
        )
    return report


def verdict_consistent(envelope: EnvelopeBase, run) -> GateReport:
    """A review's verdict must agree with the findings it just wrote down.

    Nothing here judges the code — that is the reviewer's job. This checks the
    envelope against itself: an approval that ships blocking items, or a
    rejection that names no problem, is a claim the harness can refute without
    reading a line of the diff.
    """
    report = GateReport()
    approved = bool(getattr(envelope, "approved", False))
    blocking = list(getattr(envelope, "blocking", []))
    unmet = [f.requirement for f in getattr(envelope, "findings", []) if not f.met]

    report.check("approved vs blocking", not (approved and blocking),
                 "no blocking items" if not blocking
                 else f"{len(blocking)} blocking item(s) while approved=true"
                 if approved else f"{len(blocking)} blocking item(s), not approved")
    report.check("approved vs findings", not (approved and unmet),
                 "every requirement met" if not unmet
                 else f"{len(unmet)} unmet requirement(s) while approved=true"
                 if approved else f"{len(unmet)} unmet requirement(s), not approved")
    report.check("rejection names a problem", approved or bool(blocking or unmet),
                 "verdict is supported" if approved or blocking or unmet
                 else "approved=false but no blocking item or unmet requirement was given")
    return report


def tests_pass(command: str):
    """Gate factory: the given shell command must exit 0."""
    def gate(envelope: EnvelopeBase, run) -> GateReport:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, check=False)
        ok = result.returncode == 0
        note = f"exit {result.returncode}"
        if not ok:
            note += "\n" + (result.stdout + result.stderr)[-TAIL_CHARS:]
        return GateReport().check(command, ok, note)
    gate.__name__ = f"tests_pass({command})"
    return gate
