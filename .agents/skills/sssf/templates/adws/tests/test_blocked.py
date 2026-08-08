# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""Regression coverage for first-class externally blocked delivery."""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

try:
    import pydantic  # noqa: F401
    import rich  # noqa: F401
    HAVE_RUNTIME_DEPS = True
except ImportError:
    HAVE_RUNTIME_DEPS = False


if not HAVE_RUNTIME_DEPS:
    class DependencyBootstrapTests(unittest.TestCase):
        def test_blocked_suite_with_declared_dependencies(self):
            subprocess.run(["uv", "run", str(Path(__file__).resolve())], check=True)

else:
    MODULE_ROOT = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(MODULE_ROOT))

    from rich.console import Console as RichConsole

    import adw_build_review
    import adw_plan_build_test
    from adw_modules import agent_pi, agents, permissions
    from adw_modules.data_types import (
        AgentCall,
        BuildOutput,
        ExternalBlocker,
        GenericOutput,
        PhaseParams,
        PiResult,
        PlanOutput,
        ReviewOutput,
        SSSFConfig,
        UsageBreakdown,
    )
    from adw_modules.runner import BlockedRun, Run
    from adw_modules.tracer import Tracer

    def blocker() -> ExternalBlocker:
        return ExternalBlocker(
            category="approval",
            owner="Data owner",
            required_action="Approve read access",
            resume_when="The access response records approved",
            evidence=[{"source": "docs/request.md", "observation": "Status is pending"}],
        )

    def blocked_payload(**overrides):
        payload = {
            "status": "blocked",
            "summary": "Waiting for approval",
            "changed_files": [],
            "artifacts": [],
            "commit_message": "Prepare blocked integration",
            "notes_for_next_agent": "Resume after approval",
            "external_blocker": blocker().model_dump(),
        }
        payload.update(overrides)
        return payload

    def prompt_root() -> Path:
        installed = MODULE_ROOT / "adw_data" / "prompt_engineering" / "builder"
        if installed.exists():
            return installed
        return MODULE_ROOT.parent / "prompt_engineering" / "builder"

    def config(root: Path) -> SSSFConfig:
        prompts = prompt_root()
        return SSSFConfig.model_validate({
            "defaults": {
                "data_dir": str(root / "runtime"),
                "protected_files": [],
            },
            "observability": {"db": str(root / "sssf.db")},
            "agents": [{
                "name": "builder",
                "model": "provider/model",
                "purpose": "build",
                "prompt_engineering": {
                    "system": str(prompts / "system.md"),
                    "user": str(prompts / "user.md"),
                },
                "writes": None,
            }],
        })

    @contextlib.contextmanager
    def cwd(path: Path):
        old = Path.cwd()
        os.chdir(path)
        try:
            yield
        finally:
            os.chdir(old)

    def git_init(path: Path) -> None:
        subprocess.run(["git", "init", "-q"], cwd=path, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
        (path / "README.md").write_text("fixture\n")
        subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
        subprocess.run(["git", "commit", "-qm", "fixture"], cwd=path, check=True)

    def make_run(root: Path, adw_id: str = "blocked-test"):
        cfg = config(root)
        tracer = Tracer(cfg.observability.db, root / "events.jsonl")
        tracer.session_start(adw_id, "tester")
        run = Run(cfg, adw_id, tracer, "tester")
        output = io.StringIO()
        run.console._out = RichConsole(file=output, highlight=False, soft_wrap=True, color_system=None)
        return run, output

    class BuildOutputSchemaTests(unittest.TestCase):
        def test_old_success_and_fail_still_parse(self):
            for status in ("success", "fail"):
                report = BuildOutput(status=status, summary="legacy")
                self.assertEqual(status, report.status)
                self.assertIsNone(report.external_blocker)
                self.assertFalse(report.blocked)

        def test_complete_blocker_is_typed_and_other_envelopes_cannot_block(self):
            report = BuildOutput.model_validate(blocked_payload())
            self.assertTrue(report.blocked)
            self.assertIsInstance(report.external_blocker, ExternalBlocker)
            with self.assertRaises(pydantic.ValidationError):
                GenericOutput(status="blocked")

        def test_invalid_blocker_combinations_are_rejected(self):
            invalid = [
                {"status": "blocked"},
                blocked_payload(external_blocker={
                    key: value for key, value in blocker().model_dump().items() if key != "owner"
                }),
                blocked_payload(external_blocker={**blocker().model_dump(), "owner": "  "}),
                blocked_payload(external_blocker={**blocker().model_dump(), "required_action": ""}),
                blocked_payload(external_blocker={**blocker().model_dump(), "resume_when": "\t"}),
                blocked_payload(external_blocker={**blocker().model_dump(), "evidence": []}),
                blocked_payload(external_blocker={**blocker().model_dump(), "unexpected": True}),
                blocked_payload(external_blocker={**blocker().model_dump(), "evidence": [{"source": " ", "observation": "x"}]}),
                blocked_payload(external_blocker={**blocker().model_dump(), "evidence": [{"source": "command: check", "observation": " "}]}),
                blocked_payload(external_blocker={**blocker().model_dump(), "evidence": [{"source": "command: check"}]}),
                blocked_payload(external_blocker={**blocker().model_dump(), "evidence": [{
                    "source": "command: check", "observation": "pending", "unexpected": True,
                }]}),
                blocked_payload(external_blocker={**blocker().model_dump(), "category": "internal_error"}),
                {"status": "success", "external_blocker": blocker().model_dump()},
                {"status": "fail", "external_blocker": blocker().model_dump()},
            ]
            for payload in invalid:
                with self.subTest(payload=payload), self.assertRaises(pydantic.ValidationError):
                    BuildOutput.model_validate(payload)

    class BlockedRuntimeTests(unittest.TestCase):
        def test_agent_phase_runs_once_persists_handoff_and_finishes_blocked(self):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                git_init(root)
                spec = root / "specs" / "blocked.md"
                spec.parent.mkdir()
                spec.write_bytes(b"---\nstatus: in_progress\n---\n\n# Delivery\n")
                spec_before = spec.read_bytes()
                with cwd(root):
                    run, console = make_run(root)
                    sends = []
                    gate_calls = []
                    permission_calls = []

                    def fake_pi(request, **callbacks):
                        sends.append(request)
                        return PiResult(
                            text=json.dumps(blocked_payload()),
                            session_id=request.session_id,
                            tokens=5,
                            cost=0.01,
                            usage=UsageBreakdown(total_tokens=5, total_cost=0.01),
                            context_tokens=12,
                            context_window=100,
                        )

                    def gate(envelope, _run):
                        gate_calls.append(envelope.status)
                        return []

                    def enforce(*args):
                        permission_calls.append(True)
                        return []

                    with patch.object(agent_pi, "run", side_effect=fake_pi), \
                         patch.object(permissions, "snapshot", return_value={}), \
                         patch.object(permissions, "enforce", side_effect=enforce):
                        with self.assertRaises(BlockedRun) as signal:
                            with run.phase(PhaseParams(
                                name="build", kind="agent", owner="builder",
                                description="Implement the requested delivery",
                            )) as phase:
                                phase.call(AgentCall(
                                    output_type=BuildOutput, prompt="build",
                                    gates=[gate],
                                ))

                    self.assertEqual(2, signal.exception.code)
                    self.assertEqual(2, run.finish())  # already finalized; no second banner/write
                    self.assertEqual(1, len(sends))
                    self.assertEqual(["blocked"], gate_calls)
                    self.assertEqual([True], permission_calls)
                    self.assertEqual("success", run.phases[-1].status)
                    self.assertEqual("blocked", run.tracer.conn.execute(
                        "SELECT status FROM sessions WHERE adw_id=?", (run.adw_id,)).fetchone()[0])
                    envelope = run.tracer.conn.execute(
                        "SELECT valid,attempt,payload_json FROM envelopes").fetchone()
                    self.assertEqual((1, 1), envelope[:2])
                    self.assertEqual("blocked", json.loads(envelope[2])["status"])
                    events = run.tracer.conn.execute(
                        "SELECT type,payload_json FROM events WHERE adw_id=? ORDER BY rowid",
                        (run.adw_id,),
                    ).fetchall()
                    event_types = [row[0] for row in events]
                    self.assertIn("agent_start", event_types)
                    self.assertIn("agent_end", event_types)
                    self.assertIn("phase_end", event_types)
                    self.assertNotIn("error", event_types)
                    handoff = next(json.loads(payload) for kind, payload in events if kind == "handoff")
                    self.assertEqual("blocked", handoff["status"])
                    self.assertEqual("Data owner", handoff["external_blocker"]["owner"])
                    self.assertEqual(1, console.getvalue().count("ADW blocked"))
                    self.assertIn("status", console.getvalue())
                    self.assertNotIn("retry", console.getvalue().lower())
                    self.assertNotIn("invalid envelope", console.getvalue().lower())
                    self.assertNotIn("Traceback", console.getvalue())
                    self.assertEqual(0, run.tracer.conn.execute(
                        "SELECT COUNT(*) FROM processes WHERE ended_at IS NULL").fetchone()[0])
                    self.assertEqual(0, run.tracer.conn.execute(
                        "SELECT COUNT(*) FROM phases WHERE status='running'").fetchone()[0])
                    self.assertIsNotNone(run.agent_map["builder"]["session_id"])
                    self.assertEqual((5, 0.01), run.tracer.conn.execute(
                        "SELECT total_tokens,total_cost FROM sessions WHERE adw_id=?",
                        (run.adw_id,),
                    ).fetchone())
                    self.assertEqual(spec_before, spec.read_bytes())

        def test_blocker_does_not_hide_gate_or_permission_failures(self):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                git_init(root)
                with cwd(root):
                    run, _ = make_run(root, "gate-fail")
                    result = PiResult(text=json.dumps(blocked_payload()))
                    with patch.object(agent_pi, "run", return_value=result), \
                         patch.object(permissions, "snapshot", return_value={}):
                        with self.assertRaises(agents.GateFailure):
                            with run.phase(PhaseParams(
                                name="build", kind="agent", owner="builder",
                                description="Reject an inaccurate changed-file claim",
                            )) as phase:
                                phase.call(AgentCall(
                                    output_type=BuildOutput, prompt="build",
                                    gates=[lambda envelope, active: ["wrong changed_files"]],
                                ))
                    self.assertEqual("fail", run.phases[-1].status)
                    self.assertEqual("fail", run.tracer.conn.execute(
                        "SELECT status FROM sessions WHERE adw_id='gate-fail'").fetchone()[0])

                    resumed, _ = make_run(root, "permission-fail")
                    with patch.object(agent_pi, "run", return_value=result), \
                         patch.object(permissions, "snapshot", return_value={}), \
                         patch.object(permissions, "enforce",
                                      side_effect=permissions.PermissionBreach("forbidden write")):
                        with self.assertRaises(permissions.PermissionBreach):
                            with resumed.phase(PhaseParams(
                                name="build", kind="agent", owner="builder",
                                description="Enforce the configured write boundary",
                            )) as phase:
                                phase.call(AgentCall(output_type=BuildOutput, prompt="build"))
                    self.assertEqual("fail", resumed.phases[-1].status)

        def test_resume_clears_terminal_state_reuses_agent_session_and_can_succeed(self):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                git_init(root)
                with cwd(root):
                    first, _ = make_run(root, "resume")
                    blocked_result = PiResult(text=json.dumps(blocked_payload()))
                    with patch.object(agent_pi, "run", return_value=blocked_result), \
                         patch.object(permissions, "snapshot", return_value={}), \
                         patch.object(permissions, "enforce", return_value=[]):
                        with self.assertRaises(BlockedRun):
                            with first.phase(PhaseParams(
                                name="build", kind="agent", owner="builder",
                                description="Record the external prerequisite",
                            )) as phase:
                                phase.call(AgentCall(output_type=BuildOutput, prompt="build"))
                    old_session = first.agent_map["builder"]["session_id"]
                    old_envelopes = first.tracer.conn.execute(
                        "SELECT COUNT(*) FROM envelopes").fetchone()[0]

                    first.tracer.session_start("resume", "tester")
                    self.assertEqual(("running", None), first.tracer.conn.execute(
                        "SELECT status,ended_at FROM sessions WHERE adw_id='resume'").fetchone())
                    second = Run(first.cfg, "resume", first.tracer, "tester")
                    self.assertIsNone(second.external_blocker)
                    used_sessions = []

                    def success_pi(request, **callbacks):
                        used_sessions.append(request.session_id)
                        return PiResult(text=json.dumps({
                            "status": "success", "summary": "delivered",
                            "changed_files": [], "artifacts": [],
                            "commit_message": "Complete delivery",
                            "notes_for_next_agent": "verify",
                            "external_blocker": None,
                        }))

                    with patch.object(agent_pi, "run", side_effect=success_pi), \
                         patch.object(permissions, "snapshot", return_value={}), \
                         patch.object(permissions, "enforce", return_value=[]):
                        with second.phase(PhaseParams(
                            name="build_again", kind="agent", owner="builder",
                            description="Resume delivery after approval",
                        )) as phase:
                            report = phase.call(AgentCall(output_type=BuildOutput, prompt="resume"))
                    self.assertEqual("success", report.status)
                    self.assertEqual(0, second.finish())
                    self.assertEqual([old_session], used_sessions)
                    self.assertEqual(2, second.phases[-1].seq)
                    self.assertEqual("success", second.tracer.conn.execute(
                        "SELECT status FROM sessions WHERE adw_id='resume'").fetchone()[0])
                    self.assertEqual(old_envelopes + 1, second.tracer.conn.execute(
                        "SELECT COUNT(*) FROM envelopes").fetchone()[0])
                    statuses = [json.loads(row[0])["status"] for row in second.tracer.conn.execute(
                        "SELECT payload_json FROM envelopes ORDER BY rowid")]
                    self.assertEqual(["blocked", "success"], statuses)

        def test_success_fail_and_not_accepted_exit_codes_are_unchanged(self):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                git_init(root)
                with cwd(root):
                    success, _ = make_run(root, "success")
                    with success.phase(PhaseParams(
                        name="code", kind="code", owner="test",
                        description="Complete a deterministic operation",
                    )):
                        pass
                    self.assertEqual(0, success.finish())

                    rejected, _ = make_run(root, "rejected")
                    with rejected.phase(PhaseParams(
                        name="review", kind="code", owner="test",
                        description="Record a negative acceptance decision",
                    )):
                        pass
                    self.assertEqual(1, rejected.finish(accepted=False, reason="not approved"))
                    self.assertEqual(1, rejected.tracer.conn.execute(
                        "SELECT COUNT(*) FROM events WHERE type='error' AND name='not_accepted'").fetchone()[0])

                    agent_failed, _ = make_run(root, "agent-fail")
                    failed_result = PiResult(text=json.dumps({
                        "status": "fail", "summary": "delivery failed",
                        "changed_files": [], "artifacts": [],
                        "commit_message": "", "notes_for_next_agent": "inspect failure",
                        "external_blocker": None,
                    }))
                    with patch.object(agent_pi, "run", return_value=failed_result), \
                         patch.object(permissions, "snapshot", return_value={}), \
                         patch.object(permissions, "enforce", return_value=[]):
                        with self.assertRaises(RuntimeError):
                            with agent_failed.phase(PhaseParams(
                                name="build", kind="agent", owner="builder",
                                description="Preserve the builder failure path",
                            )) as phase:
                                phase.call(AgentCall(output_type=BuildOutput, prompt="build"))
                    self.assertEqual("fail", agent_failed.tracer.conn.execute(
                        "SELECT status FROM sessions WHERE adw_id='agent-fail'").fetchone()[0])

                    failed, _ = make_run(root, "exception")
                    with self.assertRaises(RuntimeError):
                        with failed.phase(PhaseParams(
                            name="code", kind="code", owner="test",
                            description="Expose an execution exception",
                        )):
                            raise RuntimeError("boom")
                    self.assertEqual("fail", failed.tracer.conn.execute(
                        "SELECT status FROM sessions WHERE adw_id='exception'").fetchone()[0])

    class BuildReviewWorkflowTests(unittest.TestCase):
        def fake_run(self, outputs):
            calls = []
            blocker_value = blocker()

            class Handle:
                def __init__(self, name):
                    self.name = name

                def log(self, **payload):
                    return None

                def call(self, call):
                    calls.append(self.name)
                    value = outputs[self.name]
                    if value == "blocked":
                        raise BlockedRun(blocker_value)
                    return value

            class FakeRun:
                engineer = "tester"

                @contextlib.contextmanager
                def phase(self, params):
                    yield Handle(params.name)

                def finish(self, accepted=True, reason=""):
                    return 0 if accepted else 1

            return FakeRun(), calls

        def run_workflow(self, outputs, prompt="prompt"):
            fake, calls = self.fake_run(outputs)
            with patch.object(adw_build_review.agents, "load_config", return_value=object()), \
                 patch.object(adw_build_review.agents, "validate"), \
                 patch.object(adw_build_review.session, "ensure", return_value=fake):
                code = adw_build_review.main(prompt)
            return code, calls

        def test_initial_blocked_skips_reviewer(self):
            code, calls = self.run_workflow({"build": "blocked"})
            self.assertEqual(2, code)
            self.assertEqual(["build"], calls)

        def test_blocked_build_review_preserves_planned_and_in_progress_specs(self):
            for status in ("planned", "in_progress"):
                with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                    spec = Path(directory) / f"{status}.md"
                    spec.write_bytes(
                        f"---\nstatus: {status}\n---\n\n# Existing delivery\n".encode()
                    )
                    before = spec.read_bytes()
                    code, calls = self.run_workflow({"build": "blocked"}, str(spec))
                    self.assertEqual(2, code)
                    self.assertEqual(["build"], calls)
                    self.assertEqual(before, spec.read_bytes())

        def test_blocked_revision_stops_before_second_review(self):
            build = BuildOutput(status="success")
            rejection = ReviewOutput(status="success", approved=False,
                                     blocking=["approval missing"])
            code, calls = self.run_workflow({
                "build": build,
                "review_1": rejection,
                "revise_1": "blocked",
            })
            self.assertEqual(2, code)
            self.assertEqual(["build", "review_1", "revise_1"], calls)

        def test_review_success_and_bounded_rejection_keep_exit_codes(self):
            build = BuildOutput(status="success")
            approved = ReviewOutput(status="success", approved=True)
            code, calls = self.run_workflow({"build": build, "review_1": approved})
            self.assertEqual(0, code)
            self.assertEqual(["build", "review_1"], calls)

            rejected = ReviewOutput(status="success", approved=False,
                                    blocking=["still missing"])
            outputs = {"build": build}
            for index in range(1, 4):
                outputs[f"review_{index}"] = rejected
                if index < 3:
                    outputs[f"revise_{index}"] = build
            code, calls = self.run_workflow(outputs)
            self.assertEqual(1, code)
            self.assertEqual("review_3", calls[-1])

        def test_spec_leading_workflow_never_opens_spec_complete_after_blocked_build(self):
            calls = []
            transitions = []
            blocker_value = blocker()

            class Handle:
                def __init__(self, name):
                    self.name = name

                def log(self, **payload):
                    return None

                def call(self, call):
                    if self.name == "plan":
                        return PlanOutput(status="success", artifacts=["specs/plan.md"])
                    if self.name == "build":
                        raise BlockedRun(blocker_value)
                    raise AssertionError(f"unexpected agent phase: {self.name}")

            class FakeRun:
                engineer = "tester"

                @contextlib.contextmanager
                def phase(self, params):
                    calls.append(params.name)
                    yield Handle(params.name)

            def transition(_plan, _run, status):
                transitions.append(status)
                return SimpleNamespace(authoritative=Path("specs/plan.md"))

            with patch.object(adw_plan_build_test.agents, "load_config", return_value=object()), \
                 patch.object(adw_plan_build_test.agents, "validate"), \
                 patch.object(adw_plan_build_test.session, "ensure", return_value=FakeRun()), \
                 patch.object(adw_plan_build_test.specs, "transition_plan", side_effect=transition):
                with self.assertRaises(BlockedRun) as signal:
                    adw_plan_build_test.main("specs/plan.md")

            self.assertEqual(2, signal.exception.code)
            self.assertEqual(["request", "plan", "spec_start", "build"], calls)
            self.assertEqual(["in_progress"], transitions)
            self.assertNotIn("spec_complete", calls)


if __name__ == "__main__":
    unittest.main()
