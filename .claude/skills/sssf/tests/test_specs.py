from __future__ import annotations

import importlib.util
import io
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SKILL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[4]
MODULE_PATH = SKILL_ROOT / "templates" / "adws" / "adw_modules" / "specs.py"
GATES_PATH = SKILL_ROOT / "templates" / "adws" / "adw_modules" / "gates.py"


def load_modules():
    package_name = "spec_test_adw_modules"
    package = types.ModuleType(package_name)
    package.__path__ = []
    sys.modules[package_name] = package

    spec = importlib.util.spec_from_file_location(f"{package_name}.specs", MODULE_PATH)
    assert spec and spec.loader
    specs_module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = specs_module
    spec.loader.exec_module(specs_module)
    package.specs = specs_module

    data_types = types.ModuleType(f"{package_name}.data_types")

    class GateReport:
        def __init__(self):
            self.checks = []

        def check(self, item, ok, note=""):
            self.checks.append(SimpleNamespace(item=item, ok=ok, note=note))
            return self

        @property
        def passed(self):
            return all(check.ok for check in self.checks)

        @property
        def violations(self):
            return [f"{check.item}: {check.note}" for check in self.checks if not check.ok]

    data_types.EnvelopeBase = object
    data_types.GateReport = GateReport
    sys.modules[data_types.__name__] = data_types

    gate_spec = importlib.util.spec_from_file_location(f"{package_name}.gates", GATES_PATH)
    assert gate_spec and gate_spec.loader
    gates_module = importlib.util.module_from_spec(gate_spec)
    sys.modules[gate_spec.name] = gates_module
    gate_spec.loader.exec_module(gates_module)
    return specs_module, gates_module


specs, gates = load_modules()


def document(status="planned", body=b"\n# Plan\n"):
    return f"---\nstatus: {status}\n---\n".encode() + body


class SpecMetadataTests(unittest.TestCase):
    def test_all_canonical_values_parse(self):
        for status in specs.VALID_STATUSES:
            with self.subTest(status=status):
                parsed = specs.parse_bytes(document(status))
                self.assertEqual(status, parsed.status)
                self.assertEqual(b"\n# Plan\n", parsed.body)

    def test_malformed_metadata_is_rejected_precisely(self):
        cases = {
            "missing": (b"# Plan\n", "first line"),
            "not first": (b"note\n---\nstatus: planned\n---\n", "first line"),
            "unclosed": (b"---\nstatus: planned\n", "no closing"),
            "empty": (b"---\n---\n", "mapping is empty"),
            "duplicate": (b"---\nstatus: planned\nstatus: complete\n---\n", "duplicate status"),
            "non-mapping": (b"---\n- planned\n---\n", "must be a mapping"),
            "non-scalar": (b"---\nstatus: [planned]\n---\n", "scalar string"),
            "extra": (b"---\nstatus: planned\nowner: me\n---\n", "keys other than status"),
            "alias": (b"---\nstatus: &state planned\nother: *state\n---\n", "aliases are not allowed"),
            "unknown": (b"---\nstatus: unknown\n---\n", "unknown status"),
        }
        for name, (data, message) in cases.items():
            with self.subTest(name=name), self.assertRaisesRegex(specs.SpecMetadataError, message):
                specs.parse_bytes(data, name)

    def test_listing_is_sorted_reports_every_error_and_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "specs").mkdir()
            (root / "specs" / "z.md").write_bytes(document("complete"))
            (root / "specs" / "a.md").write_text("legacy\n")
            (root / "specs" / "m.md").write_bytes(document("planned"))
            output = io.StringIO()
            with redirect_stdout(output):
                code = specs.list_specs(root)
            lines = output.getvalue().splitlines()
            self.assertEqual(1, code)
            self.assertTrue(lines[0].startswith("ERROR\tspecs/a.md\t"))
            self.assertEqual("planned\tspecs/m.md", lines[1])
            self.assertEqual("complete\tspecs/z.md", lines[2])
            self.assertNotIn("unknown\t", output.getvalue())


class SpecTransitionTests(unittest.TestCase):
    def test_only_forward_single_step_transitions_succeed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.md"
            path.write_bytes(document("planned"))
            self.assertEqual("in_progress", specs.transition([path], "in_progress"))
            self.assertEqual("complete", specs.transition([path], "complete"))
            self.assertEqual("complete", specs.parse(path).status)

        illegal = [
            ("planned", "planned"), ("planned", "complete"),
            ("in_progress", "planned"), ("in_progress", "in_progress"),
            ("complete", "planned"), ("complete", "in_progress"),
            ("complete", "complete"),
        ]
        for current, target in illegal:
            with self.subTest(current=current, target=target), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "plan.md"
                path.write_bytes(document(current))
                with self.assertRaisesRegex(specs.SpecMetadataError, "illegal spec transition"):
                    specs.transition([path], target)

    def test_transition_preserves_body_and_updates_explicit_mirror(self):
        with tempfile.TemporaryDirectory() as directory:
            authoritative = Path(directory) / "spec.md"
            mirror = Path(directory) / "plan.md"
            original = b"---\r\nstatus: planned\r\n---\r\n# Body\r\n\xff"
            authoritative.write_bytes(original)
            mirror.write_bytes(original)
            specs.transition([authoritative, mirror], "in_progress")
            expected = b"---\nstatus: in_progress\n---\n# Body\r\n\xff"
            self.assertEqual(expected, authoritative.read_bytes())
            self.assertEqual(expected, mirror.read_bytes())

    def test_mirror_write_failure_rolls_back_already_written_files(self):
        with tempfile.TemporaryDirectory() as directory:
            authoritative = Path(directory) / "spec.md"
            mirror = Path(directory) / "plan.md"
            original = document("planned", b"body\n")
            authoritative.write_bytes(original)
            mirror.write_bytes(original)
            real_write = specs._atomic_write
            failed = False

            def fail_once(path, data):
                nonlocal failed
                if Path(path) == mirror.resolve() and not failed:
                    failed = True
                    raise OSError("simulated mirror failure")
                return real_write(path, data)

            with mock.patch.object(specs, "_atomic_write", side_effect=fail_once):
                with self.assertRaisesRegex(specs.SpecMetadataError, "simulated mirror failure"):
                    specs.transition([authoritative, mirror], "in_progress")
            self.assertEqual(original, authoritative.read_bytes())
            self.assertEqual(original, mirror.read_bytes())


class PlannerArtifactTests(unittest.TestCase):
    def fixture(self, directory: str, status="planned"):
        root = Path(directory).resolve()
        handoff = root / "adws" / "adw_data" / "sessions" / "abcd1234" / "context_handoff"
        durable = root / "specs" / "abcd1234_feature.md"
        handoff.mkdir(parents=True)
        durable.parent.mkdir()
        data = document(status)
        (handoff / "plan.md").write_bytes(data)
        durable.write_bytes(data)
        run = SimpleNamespace(repo_root=root, context_handoff_dir=handoff, adw_id="abcd1234")
        envelope = SimpleNamespace(artifacts=[
            str((handoff / "plan.md").relative_to(root)),
            str(durable.relative_to(root)),
        ])
        return run, envelope, durable, handoff / "plan.md"

    def test_canonical_pair_resolves_and_gate_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            run, envelope, durable, mirror = self.fixture(directory)
            resolved = specs.validate_plan_artifacts(envelope, run)
            self.assertEqual((durable, mirror), resolved.paths)
            self.assertTrue(gates.plan_spec_valid(envelope, run).passed)

    def test_resolution_rejects_unsafe_or_ambiguous_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            run, envelope, durable, mirror = self.fixture(directory)
            outside = Path(directory).parent / "outside-plan.md"
            cases = {
                "zero": [],
                "multiple specs": [str(mirror), str(durable), str(durable.with_name("abcd1234_other.md"))],
                "wrong handoff": [str(mirror.with_name("other.md")), str(durable)],
                "nested spec": [str(mirror), str(durable.parent / "nested" / durable.name)],
                "outside": [str(mirror), str(outside)],
                "wrong id": [str(mirror), str(durable.with_name("wrong_feature.md"))],
            }
            for name, artifacts in cases.items():
                with self.subTest(name=name):
                    bad = SimpleNamespace(artifacts=artifacts)
                    with self.assertRaises(specs.SpecMetadataError):
                        specs.resolve_plan_artifacts(bad, run)

    def test_creation_rejects_nonidentical_or_nonplanned_copies(self):
        with tempfile.TemporaryDirectory() as directory:
            run, envelope, durable, mirror = self.fixture(directory)
            mirror.write_bytes(document("planned", b"different\n"))
            with self.assertRaisesRegex(specs.SpecMetadataError, "not byte-identical"):
                specs.validate_plan_artifacts(envelope, run)
            report = gates.plan_spec_valid(envelope, run)
            self.assertFalse(report.passed)
            self.assertTrue(any("identical" in violation for violation in report.violations))

        for status in ("in_progress", "complete"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                run, envelope, _, _ = self.fixture(directory, status)
                with self.assertRaisesRegex(specs.SpecMetadataError, "must have status planned"):
                    specs.validate_plan_artifacts(envelope, run)
                report = gates.plan_spec_valid(envelope, run)
                self.assertFalse(report.passed)
                self.assertTrue(any("expected planned" in violation for violation in report.violations))

    def test_all_repository_specs_parse_with_evidence_backed_migrations(self):
        statuses = {
            path.name: specs.parse(path).status
            for path in sorted((REPO_ROOT / "specs").glob("*.md"))
        }
        self.assertEqual("complete", statuses["b34b429b_observability-ui-hardening.md"])
        self.assertEqual("planned", statuses["ee96e7f3_delete-archived-sessions.md"])
        self.assertIn(statuses["ffed9f91_spec-lifecycle-scout-plan.md"], specs.VALID_STATUSES)


if __name__ == "__main__":
    unittest.main()
