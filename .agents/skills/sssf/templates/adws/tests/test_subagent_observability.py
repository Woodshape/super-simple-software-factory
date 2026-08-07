import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from adw_modules.data_types import EventRecord, SubagentTraceContext
from adw_modules.subagent_observability import TelemetryTail
from adw_modules.tracer import Tracer


def event(kind: str, telemetry_id: str, **fields):
    return {
        "protocol": "sssf.subagents.v1",
        "telemetry_id": telemetry_id,
        "kind": kind,
        "adw_id": "run",
        "phase_id": "phase",
        "parent_agent": "planner",
        "subagent_id": "sub_stable",
        "ts": "2025-01-01T00:00:00Z",
        **fields,
    }


def test_nested_turns_activity_and_reconciliation_are_durable(tmp_path):
    tracer = Tracer(tmp_path / "sssf.db", tmp_path / "events.jsonl")
    tracer.session_start("run", "engineer")
    tracer.ingest_subagent(event(
        "subagent.created", "created", display_id=1, task="inspect",
        session_path=str(tmp_path / "sessions/run/planner/subagents/sub_stable/session.jsonl"),
        parent_tool_call_id="parent-call",
    ))
    tracer.ingest_subagent(event(
        "turn.started", "start-1", turn=1, prompt="inspect", model="provider/model",
        thinking="high", pid=123, parent_tool_call_id="parent-call",
    ))
    # Telemetry first, parent event second.
    parent_event = tracer.event(EventRecord(
        adw_id="run", phase_id="phase", type="tool_call", name="subagent_create",
        payload={"tool_call_id": "parent-call"}))
    tracer.link_subagent_parent("run", "parent-call", parent_event)
    activity = event(
        "activity.completed", "tool-1", turn=1, activity_id="child-call",
        tool_call_id="child-call", tool="read", args={"path": "README.md"}, ok=True,
        result_snippet="contents", duration_ms=4,
    )
    tracer.ingest_subagent(activity)
    tracer.ingest_subagent(activity)  # final drains and retries are idempotent
    tracer.ingest_subagent(event(
        "turn.finished", "finish-1", turn=1, status="success", pid=123,
        result="complete untruncated result", tool_count=1, duration_ms=8,
    ))
    continuation_event = tracer.event(EventRecord(
        adw_id="run", phase_id="phase", type="tool_call", name="subagent_continue",
        payload={"tool_call_id": "continuation-call"}))
    tracer.ingest_subagent(event(
        "turn.started", "start-2", turn=2, prompt="continue", model="provider/model",
        thinking="medium", pid=124, parent_tool_call_id="continuation-call",
    ))

    assert tracer.conn.execute("SELECT COUNT(*) FROM subagent_activities").fetchone()[0] == 1
    assert tracer.conn.execute(
        "SELECT result FROM subagent_turns WHERE turn=1").fetchone()[0] == "complete untruncated result"
    assert tracer.conn.execute(
        "SELECT COUNT(*) FROM subagent_turns WHERE subagent_id='sub_stable'").fetchone()[0] == 2
    assert tracer.conn.execute(
        "SELECT parent_event_id FROM subagent_turns WHERE turn=1").fetchone()[0] == parent_event
    # The stable child summary is linked to its creation call forever; a
    # continuation owns its newer links only on its own turn row.
    assert tracer.conn.execute(
        "SELECT parent_tool_call_id,parent_event_id FROM subagents "
        "WHERE subagent_id='sub_stable'").fetchone() == ("parent-call", parent_event)
    assert tracer.conn.execute(
        "SELECT turn,parent_tool_call_id,parent_event_id FROM subagent_turns "
        "WHERE subagent_id='sub_stable' ORDER BY turn").fetchall() == [
            (1, "parent-call", parent_event),
            (2, "continuation-call", continuation_event),
        ]

    # Parent event first, telemetry second, with a separately cancelled child.
    second_parent = tracer.event(EventRecord(
        adw_id="run", phase_id="phase", type="tool_call", name="subagent_create",
        payload={"tool_call_id": "second-call"}))
    tracer.ingest_subagent(event(
        "subagent.created", "created-second", subagent_id="sub_second", display_id=2,
        task="cancel me", parent_tool_call_id="second-call", session_path="target/session.jsonl"))
    tracer.ingest_subagent(event(
        "turn.started", "start-second", subagent_id="sub_second", turn=1,
        prompt="cancel me", pid=125, parent_tool_call_id="second-call"))
    tracer.ingest_subagent(event(
        "turn.finished", "finish-second", subagent_id="sub_second", turn=1,
        status="cancelled", pid=125, result="partial"))
    assert tracer.conn.execute(
        "SELECT parent_event_id FROM subagents WHERE subagent_id='sub_second'").fetchone()[0] == second_parent
    assert tracer.conn.execute(
        "SELECT status FROM subagents WHERE subagent_id='sub_second'").fetchone()[0] == "cancelled"

    tracer.session_finish("run", ok=False)
    assert tracer.conn.execute(
        "SELECT status FROM subagent_turns WHERE turn=2").fetchone()[0] == "interrupted"
    assert tracer.conn.execute(
        "SELECT COUNT(*) FROM processes WHERE ended_at IS NULL").fetchone()[0] == 0


def test_session_finish_closes_stale_running_phases(tmp_path):
    tracer = Tracer(tmp_path / "sssf.db", tmp_path / "events.jsonl")
    tracer.session_start("run", "engineer")
    tracer.conn.executemany(
        "INSERT INTO phases "
        "(phase_id,adw_id,seq,name,kind,owner,status,started_at,ended_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        [
            ("stale", "run", 1, "plan", "agent", "planner", "running",
             "2025-01-01T00:00:00Z", None),
            ("complete", "run", 2, "request", "engineer", "engineer", "success",
             "2025-01-01T00:00:01Z", "2025-01-01T00:00:02Z"),
        ],
    )

    tracer.session_finish("run", ok=True)

    assert tracer.conn.execute(
        "SELECT status FROM sessions WHERE adw_id='run'").fetchone()[0] == "success"
    stale = tracer.conn.execute(
        "SELECT status,error,ended_at FROM phases WHERE phase_id='stale'").fetchone()
    assert stale[0:2] == ("fail", "session finalized before phase completed")
    assert stale[2] is not None
    assert tracer.conn.execute(
        "SELECT status,ended_at FROM phases WHERE phase_id='complete'").fetchone() == (
            "success", "2025-01-01T00:00:02Z")


def test_telemetry_tail_skips_history_retains_partial_lines_and_rejects_wrong_context(tmp_path):
    telemetry = tmp_path / "sessions/run/planner/subagents/telemetry.jsonl"
    telemetry.parent.mkdir(parents=True)
    telemetry.write_text(json.dumps(event("subagent.created", "historical")) + "\n")
    context = SubagentTraceContext(
        adw_id="run", phase_id="phase", parent_agent="planner",
        root=str(telemetry.parent), telemetry_path=str(telemetry))
    tail = TelemetryTail(context)
    assert list(tail.read()) == []  # a resumed parent does not replay old rows

    valid = json.dumps(event("turn.started", "live", turn=1))
    with telemetry.open("a") as stream:
        stream.write(valid[:20])
    assert list(tail.read()) == []
    with telemetry.open("a") as stream:
        stream.write(valid[20:] + "\n")
        stream.write(json.dumps(event("turn.started", "wrong", adw_id="other")) + "\n")
    records = list(tail.read())
    assert [record["telemetry_id"] for record in records] == ["live"]
