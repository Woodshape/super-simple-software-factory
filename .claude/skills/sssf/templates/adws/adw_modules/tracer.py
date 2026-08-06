"""Tracer: every event lands in JSONL and SQLite AS IT HAPPENS.

Files are the raw record; sssf.db is the queryable mirror the UI polls.
No push transport — the flow is always: agents -> sqlite -> web ui.
WAL mode so the UI can read while ADW processes write.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .data_types import AgentConfig, EventRecord, GateReport, Phase
from .utils import ensure_dir, new_id, now_iso

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  adw_id        TEXT PRIMARY KEY,
  adw_name      TEXT,                -- ADW script(s) run, e.g. "adw_plan + adw_build_test"
  request       TEXT,
  status        TEXT,
  engineer      TEXT,
  started_at    TEXT, ended_at TEXT,
  total_tokens  INTEGER DEFAULT 0, total_cost REAL DEFAULT 0,
  archived      INTEGER DEFAULT 0   -- review triage, set by the UI; never by a run
);
CREATE TABLE IF NOT EXISTS phases (
  phase_id      TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  seq           INTEGER,
  name TEXT, kind TEXT, owner TEXT, description TEXT,
  status        TEXT DEFAULT 'fail',
  attempt       INTEGER DEFAULT 0, retries INTEGER DEFAULT 0,
  error         TEXT,
  started_at    TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id      TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  parent_id     TEXT,
  type          TEXT,
  name          TEXT,
  payload_json  TEXT,
  tokens        INTEGER,
  started_at    TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id   TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  agent         TEXT,
  output_type   TEXT,
  payload_json  TEXT,
  valid         INTEGER,
  attempt       INTEGER,
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS gate_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  attempt       INTEGER,
  gate          TEXT,
  passed        INTEGER,
  violations_json TEXT,
  checks_json   TEXT,               -- [{item, ok, note}] — WHAT the gate verified
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS processes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  kind          TEXT,                -- 'adw' | configured 'agent' | nested 'subagent'
  name          TEXT,                -- '' for the adw, the agent name for a child
  pid           INTEGER,
  command       TEXT,                -- what the pid was, so a recycled pid is not killed by mistake
  started_at    TEXT, ended_at TEXT  -- ended_at NULL = believed alive
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  adw_id        TEXT REFERENCES sessions,
  agent         TEXT,
  coding_agent  TEXT, model TEXT, color TEXT,
  session_id    TEXT,
  context_tokens INTEGER,           -- window occupancy after the agent's last turn
  context_window INTEGER,           -- the model's ceiling; 0/NULL = unknown
  created_at    TEXT, last_used_at TEXT,
  PRIMARY KEY (adw_id, agent)
);
CREATE TABLE IF NOT EXISTS subagents (
  subagent_id TEXT PRIMARY KEY,
  adw_id TEXT REFERENCES sessions, phase_id TEXT REFERENCES phases,
  parent_agent TEXT, display_id INTEGER, parent_tool_call_id TEXT, parent_event_id TEXT,
  task TEXT, session_path TEXT, status TEXT,
  created_at TEXT, started_at TEXT, ended_at TEXT, duration_ms INTEGER,
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_subagents_adw ON subagents(adw_id, created_at);
CREATE TABLE IF NOT EXISTS subagent_turns (
  turn_id TEXT PRIMARY KEY, subagent_id TEXT REFERENCES subagents,
  adw_id TEXT, phase_id TEXT, turn INTEGER,
  parent_tool_call_id TEXT, parent_event_id TEXT,
  prompt TEXT, model TEXT, thinking TEXT, pid INTEGER,
  status TEXT, started_at TEXT, ended_at TEXT, duration_ms INTEGER,
  result TEXT, error TEXT, tool_count INTEGER DEFAULT 0,
  raw_output_path TEXT, session_path TEXT,
  start_telemetry_id TEXT UNIQUE, finish_telemetry_id TEXT UNIQUE,
  UNIQUE(subagent_id, turn)
);
CREATE INDEX IF NOT EXISTS idx_subagent_turns_child ON subagent_turns(subagent_id, turn);
CREATE TABLE IF NOT EXISTS subagent_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telemetry_id TEXT UNIQUE, activity_id TEXT,
  subagent_id TEXT REFERENCES subagents, adw_id TEXT, turn INTEGER,
  tool_call_id TEXT, tool TEXT, args_json TEXT, result_snippet TEXT, ok INTEGER,
  started_at TEXT, ended_at TEXT, duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_subagent_activity_child ON subagent_activities(adw_id, subagent_id, id);
"""

# Columns added after a schema shipped. CREATE TABLE IF NOT EXISTS never
# revisits an existing table, so additive changes need an explicit ALTER.
MIGRATIONS = [("agent_sessions", "color", "TEXT"),
              ("gate_results", "checks_json", "TEXT"),
              ("sessions", "adw_name", "TEXT"),
              ("agent_sessions", "context_tokens", "INTEGER"),
              ("agent_sessions", "context_window", "INTEGER"),
              ("sessions", "archived", "INTEGER DEFAULT 0")]


class Tracer:
    def __init__(self, db_path: str | Path, events_jsonl: str | Path):
        ensure_dir(Path(db_path).parent)
        self.db_path = str(db_path)
        self.events_jsonl = Path(events_jsonl)
        ensure_dir(self.events_jsonl.parent)
        self.conn = sqlite3.connect(self.db_path, isolation_level=None)
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA synchronous=NORMAL;")
        self.conn.execute("PRAGMA busy_timeout=5000;")
        self.conn.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """Additive column migrations, so a db from an older SSSF still opens."""
        for table, column, decl in MIGRATIONS:
            columns = {row[1] for row in self.conn.execute(f"PRAGMA table_info({table})")}
            if column not in columns:
                self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")

    # ── events ──────────────────────────────────────────────────────────────
    def event(self, record: EventRecord) -> str:
        event_id = f"evt_{new_id(12)}"
        ts = now_iso()
        line = {"event_id": event_id, "ts": ts, **record.model_dump()}
        with self.events_jsonl.open("a") as f:
            f.write(json.dumps(line) + "\n")
        self.conn.execute(
            "INSERT INTO events (event_id, adw_id, phase_id, parent_id, type, name,"
            " payload_json, tokens, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (event_id, record.adw_id, record.phase_id, record.parent_id, record.type,
             record.name, json.dumps(record.payload), record.tokens,
             record.started_at or ts, record.ended_at),
        )
        return event_id

    # ── sessions ────────────────────────────────────────────────────────────
    def session_start(self, adw_id: str, engineer: str, adw_name: str | None = None) -> None:
        self.conn.execute(
            "INSERT INTO sessions (adw_id, status, engineer, started_at) VALUES (?,?,?,?) "
            "ON CONFLICT(adw_id) DO UPDATE SET status='running'",
            (adw_id, "running", engineer, now_iso()),
        )
        if not adw_name:
            return
        # A joined session chains ADWs — record each distinct one, in run order.
        row = self.conn.execute("SELECT adw_name FROM sessions WHERE adw_id=?",
                                (adw_id,)).fetchone()
        names = row[0].split(" + ") if row and row[0] else []
        if adw_name not in names:
            names.append(adw_name)
            self.conn.execute("UPDATE sessions SET adw_name=? WHERE adw_id=?",
                              (" + ".join(names), adw_id))

    def session_request(self, adw_id: str, request: str) -> None:
        self.conn.execute("UPDATE sessions SET request=? WHERE adw_id=?",
                          (request[:500], adw_id))

    def session_finish(self, adw_id: str, ok: bool) -> None:
        ended = now_iso()
        self.conn.execute(
            "UPDATE sessions SET status=?, ended_at=? WHERE adw_id=?",
            ("success" if ok else "fail", ended, adw_id),
        )
        # A parent can be terminated before its extension's close callback. Do
        # not leave historical nested runs falsely live in that case.
        self.conn.execute(
            "UPDATE subagent_turns SET status='interrupted', ended_at=? "
            "WHERE adw_id=? AND status='running'", (ended, adw_id))
        self.conn.execute(
            "UPDATE subagents SET status='interrupted', ended_at=? "
            "WHERE adw_id=? AND status='running'", (ended, adw_id))
        self.processes_end_all(adw_id)   # nothing of this run is alive any more

    def session_add_usage(self, adw_id: str, tokens: int, cost: float) -> None:
        self.conn.execute(
            "UPDATE sessions SET total_tokens=total_tokens+?, total_cost=total_cost+? WHERE adw_id=?",
            (tokens, cost, adw_id),
        )

    # ── processes (adw_id → pid, so a hung run can be found and killed) ─────
    def process_start(self, adw_id: str, kind: str, name: str, pid: int,
                      command: str) -> None:
        """Record a live process for this run.

        A coding agent that hangs produces no events at all, which is exactly
        when you need its pid — and `ps` cannot tell you which adw_id it
        belongs to. Writing it here makes the trace the answer to "what is this
        run running, and how do I stop it".
        """
        self.conn.execute(
            "INSERT INTO processes (adw_id, kind, name, pid, command, started_at)"
            " VALUES (?,?,?,?,?,?)",
            (adw_id, kind, name, pid, command[:500], now_iso()),
        )

    def process_end(self, adw_id: str, pid: int) -> None:
        """Mark the newest live row for this pid as finished."""
        self.conn.execute(
            "UPDATE processes SET ended_at=? WHERE id = ("
            "  SELECT id FROM processes WHERE adw_id=? AND pid=? AND ended_at IS NULL"
            "  ORDER BY id DESC LIMIT 1)",
            (now_iso(), adw_id, pid),
        )

    def processes_end_all(self, adw_id: str) -> None:
        """Close out every live row for a run — called when the session ends."""
        self.conn.execute(
            "UPDATE processes SET ended_at=? WHERE adw_id=? AND ended_at IS NULL",
            (now_iso(), adw_id),
        )

    # ── phases ──────────────────────────────────────────────────────────────
    def max_phase_seq(self, adw_id: str) -> int:
        """Highest seq already recorded for this session; 0 when it is new.

        A joined run continues the sequence instead of restarting at 1 — which
        would collide with the first run's phases on both `seq` (breaking
        ordering) and `phase_id` (silently overwriting a row through the
        phase_upsert conflict clause).
        """
        row = self.conn.execute("SELECT MAX(seq) FROM phases WHERE adw_id = ?",
                                (adw_id,)).fetchone()
        return row[0] if row and row[0] is not None else 0

    def phase_upsert(self, phase: Phase) -> None:
        p = phase.params
        self.conn.execute(
            "INSERT INTO phases (phase_id, adw_id, seq, name, kind, owner, description,"
            " status, attempt, retries, error, started_at, ended_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(phase_id) DO UPDATE SET status=excluded.status,"
            " attempt=excluded.attempt, error=excluded.error, ended_at=excluded.ended_at",
            (phase.phase_id, phase.adw_id, phase.seq, p.name, p.kind, p.owner,
             p.description, phase.status, phase.attempt, p.retries, phase.error,
             phase.started_at, phase.ended_at),
        )

    # ── nested subagents ────────────────────────────────────────────────────
    def ingest_subagent(self, record: dict) -> None:
        """Idempotently mirror one validated extension telemetry record."""
        kind = record.get("kind")
        child = str(record.get("subagent_id") or "")
        if not child:
            return
        adw_id = str(record.get("adw_id") or "")
        phase_id = str(record.get("phase_id") or "")
        call_id = record.get("parent_tool_call_id")
        parent_event = self._subagent_parent_event(adw_id, call_id)
        ts = str(record.get("ts") or now_iso())

        if kind == "subagent.created":
            self.conn.execute(
                "INSERT INTO subagents (subagent_id,adw_id,phase_id,parent_agent,display_id,"
                "parent_tool_call_id,parent_event_id,task,session_path,status,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,'running',?) ON CONFLICT(subagent_id) DO NOTHING",
                (child, adw_id, phase_id, record.get("parent_agent"), record.get("display_id"),
                 call_id, parent_event, record.get("task"), record.get("session_path"), ts))
            return

        if kind == "turn.started":
            turn = int(record.get("turn") or 1)
            turn_id = f"{child}:{turn}"
            started = str(record.get("started_at") or ts)
            self.conn.execute(
                "INSERT INTO subagent_turns (turn_id,subagent_id,adw_id,phase_id,turn,"
                "parent_tool_call_id,parent_event_id,prompt,model,thinking,pid,status,started_at,"
                "raw_output_path,session_path,start_telemetry_id) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?) "
                "ON CONFLICT(subagent_id,turn) DO NOTHING",
                (turn_id, child, adw_id, phase_id, turn, call_id, parent_event,
                 record.get("prompt"), record.get("model"), record.get("thinking"),
                 record.get("pid"), started, record.get("raw_output_path"),
                 record.get("session_path"), record.get("telemetry_id")))
            self.conn.execute(
                "UPDATE subagents SET status='running',started_at=COALESCE(started_at,?),"
                "task=?,parent_tool_call_id=COALESCE(parent_tool_call_id,?),"
                "parent_event_id=COALESCE(parent_event_id,?) WHERE subagent_id=?",
                (started, record.get("prompt"), call_id, parent_event, child))
            pid = record.get("pid")
            exists = self.conn.execute(
                "SELECT 1 FROM processes WHERE adw_id=? AND kind='subagent' AND name=? AND pid=?",
                (adw_id, turn_id, pid)).fetchone()
            if pid and not exists:
                self.process_start(adw_id, "subagent", turn_id, int(pid),
                                   f"pi nested {child} turn {turn}")
            return

        if kind == "activity.completed":
            args = record.get("args") if isinstance(record.get("args"), dict) else {}
            inserted = self.conn.execute(
                "INSERT OR IGNORE INTO subagent_activities "
                "(telemetry_id,activity_id,subagent_id,adw_id,turn,tool_call_id,tool,args_json,"
                "result_snippet,ok,started_at,ended_at,duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (record.get("telemetry_id"), record.get("activity_id"), child, adw_id,
                 record.get("turn"), record.get("tool_call_id"), record.get("tool"),
                 json.dumps(args), record.get("result_snippet"), int(bool(record.get("ok"))),
                 record.get("started_at"), record.get("ended_at"), record.get("duration_ms")))
            if inserted.rowcount:
                self.conn.execute(
                    "UPDATE subagent_turns SET tool_count=COALESCE(tool_count,0)+1 "
                    "WHERE subagent_id=? AND turn=?",
                    (child, record.get("turn")))
            return

        if kind == "turn.finished":
            turn = int(record.get("turn") or 1)
            ended = str(record.get("ended_at") or ts)
            # finish_telemetry_id makes duplicate final drains harmless.
            self.conn.execute(
                "UPDATE subagent_turns SET status=?,ended_at=?,duration_ms=?,result=?,error=?,"
                "tool_count=?,finish_telemetry_id=? WHERE subagent_id=? AND turn=? "
                "AND finish_telemetry_id IS NULL",
                (record.get("status") or "error", ended, record.get("duration_ms"),
                 record.get("result"), record.get("error"), record.get("tool_count") or 0,
                 record.get("telemetry_id"), child, turn))
            self.conn.execute(
                "UPDATE subagents SET status=?,ended_at=?,duration_ms=("
                "SELECT SUM(COALESCE(duration_ms,0)) FROM subagent_turns WHERE subagent_id=?) "
                "WHERE subagent_id=?",
                (record.get("status") or "error", ended, child, child))
            if record.get("pid"):
                self.process_end(adw_id, int(record["pid"]))
            return

        if kind == "subagent.removed":
            self.conn.execute("UPDATE subagents SET removed_at=? WHERE subagent_id=? AND adw_id=?",
                              (record.get("removed_at") or ts, child, adw_id))

    def link_subagent_parent(self, adw_id: str, tool_call_id: str, event_id: str) -> None:
        """Resolve parent links whether telemetry or the parent tool event arrived first."""
        if not tool_call_id:
            return
        self.conn.execute(
            "UPDATE subagents SET parent_event_id=? WHERE adw_id=? AND parent_tool_call_id=?",
            (event_id, adw_id, tool_call_id))
        self.conn.execute(
            "UPDATE subagent_turns SET parent_event_id=? WHERE adw_id=? AND parent_tool_call_id=?",
            (event_id, adw_id, tool_call_id))

    def _subagent_parent_event(self, adw_id: str, tool_call_id) -> str | None:
        if not tool_call_id:
            return None
        row = self.conn.execute(
            "SELECT event_id FROM events WHERE adw_id=? "
            "AND json_extract(payload_json,'$.tool_call_id')=? ORDER BY rowid DESC LIMIT 1",
            (adw_id, tool_call_id)).fetchone()
        return row[0] if row else None

    # ── envelopes / gates / agent sessions ──────────────────────────────────
    def envelope_row(self, phase: Phase, agent: str, output_type: str,
                     payload_json: str, valid: bool, attempt: int) -> None:
        self.conn.execute(
            "INSERT INTO envelopes (envelope_id, adw_id, phase_id, agent, output_type,"
            " payload_json, valid, attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (f"env_{new_id(12)}", phase.adw_id, phase.phase_id, agent, output_type,
             payload_json, int(valid), attempt, now_iso()),
        )

    def gate_row(self, phase: Phase, gate: str, report: GateReport, attempt: int) -> None:
        """The report carries both the verdict and the evidence behind it."""
        self.conn.execute(
            "INSERT INTO gate_results (adw_id, phase_id, attempt, gate, passed,"
            " violations_json, checks_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (phase.adw_id, phase.phase_id, attempt, gate, int(report.passed),
             json.dumps(report.violations),
             json.dumps([c.model_dump() for c in report.checks]), now_iso()),
        )

    def agent_session_row(self, adw_id: str, agent: AgentConfig, session_id: str,
                          context_tokens: int = 0, context_window: int = 0) -> None:
        """The agent's config row is the source of truth for its label and color.

        Context is carried here rather than derived from events because the lane
        wants one number per agent — the latest — and a session that runs the
        same agent twice overwrites it, exactly like model and session_id.
        """
        ts = now_iso()
        self.conn.execute(
            "INSERT INTO agent_sessions (adw_id, agent, coding_agent, model, color,"
            " session_id, context_tokens, context_window, created_at, last_used_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(adw_id, agent) DO UPDATE SET model=excluded.model,"
            " color=excluded.color, session_id=excluded.session_id,"
            " context_tokens=excluded.context_tokens,"
            " context_window=excluded.context_window,"
            " last_used_at=excluded.last_used_at",
            (adw_id, agent.name, agent.coding_agent, agent.model, agent.color,
             session_id, context_tokens, context_window, ts, ts),
        )
