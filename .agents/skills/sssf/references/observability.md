# Observability Reference

The event schema, SQLite tables, and polling contract — the configured-agent path is **agents → sqlite → web ui**; nested Pi children use **extension telemetry JSONL → tracer → sqlite → web ui**.

## Two stores, one truth

**Files are the raw record** (`raw_output.jsonl` streams, `envelope.json`, `agent_map.json`); **SQLite (`sssf.db`) is the queryable mirror** the UI reads. `tracer.py` writes both. Losing the db loses nothing that can't be rebuilt from files. Permanent deletion is the intentional exception: it removes both representations for one archived run, so that run can no longer be rebuilt from its removed raw directory.

Location comes from `observability.db` in `sssf.config.yaml`, default `adws/adw_data/sssf.db` — inside the **target** repo, gitignored.

## Event schema

`tracer.py` emits these types, every one logged against its `adw_id` **and** `phase_id`:

| Type | Emitted when |
|---|---|
| `phase_start` | a `run.phase(...)` block is entered |
| `agent_start` | a coding agent is spawned or resumed for `ph.call(...)` |
| `tool_call` | a tool (`read`, `bash`, `edit`, `write`) returns — **one event per real call**, named `bash: ls -la src`, payload `{tool, tool_call_id, args, result_snippet, ok, duration_ms, agent}` |
| `handoff` | an envelope crosses from one agent to the next |
| `gate_pass` | a gate found no failed checks — payload carries `attempt`, `checks` (the evidence), and an empty `violations` |
| `gate_fail` | a gate found at least one failed check — payload carries `attempt`, `checks`, and `violations` |
| `log` | an explicit `ph.log(...)` from the ADW script |
| `agent_end` | the agent's run completes; envelope parsed or not — payload carries `cost`, `usage` (the per-component breakdown), `context_tokens`, `context_window` |
| `phase_end` | the block exits; carries the resolved status |
| `error` | a raise inside a phase block |

`parent_id` nests spans, so an agent phase expands into its tool-call spans in the UI.

**Spend is itemised per phase.** `agent_end.usage` carries tokens *and* dollars for each component pi reports — `input`, `output`, `cache_read`, `cache_write` — summed across every send the phase made, so a phase that retried on a bad envelope or a failed gate shows what all its attempts cost, not just the last one. The four components sum to `total_tokens`, and their costs sum to `total_cost`; the visualizer's Cost panel renders them as a table you can add up by eye.

`reasoning_tokens` is the thinking share and is **inside** `output_tokens`, not a fifth component — measured across every session on disk, reasoning never exceeds output and the four components always reconcile to the total. It bills at the output rate, so the panel nests it under output rather than adding it. Runs predating the breakdown have no `usage` key at all; the lump `cost` and the event's own `tokens` still stand, and the UI says so rather than rendering zeroes.

**Context is occupancy, not spend.** `events.tokens` and `sessions.total_tokens` bill every turn, so they only grow — an agent that burned 100k tokens may be sitting in a 15k window. `context_tokens` is how full the window actually was when the agent stopped, which is what the visualizer's per-lane Context bar measures against `context_window`.

It is computed the way pi computes it for its own footer and its auto-compaction trigger (`calculateContextTokens` in the coding agent's `core/compaction/compaction.ts`): take the last *valid* assistant turn — skipping `aborted` and `error` turns — and read `usage.totalTokens`, falling back to `input + output + cacheRead + cacheWrite`. Cache reads count; cached prompt is still prompt. `context_window` is the same `contextWindow` pi reads from `~/.pi/agent/models.json`, so `context_tokens / context_window` is the number pi would show. Both are NULL on rows written before the columns existed, and the lane draws no bar rather than a misleading empty one.

Two caveats worth knowing. Pi adds an *estimate* for any messages trailing the last assistant usage; in a batch (`-p`) run the session ends on that message, so the two agree. And if auto-compaction fires as the very last act of a run, the recorded number is the pre-compaction size — pi itself reports `null` in that window rather than guessing.

**Gates record evidence, not just a verdict.** A gate returns one `{item, ok, note}` check per thing it looked at, and `violations` are derived from the failed ones. Both land in `gate_results` (`checks_json` + `violations_json`) and in the `gate_pass`/`gate_fail` payload, so a green gate can answer *what did you verify* — `{"item": "…/plan.md", "ok": true, "note": "exists, 454B"}` — rather than only *did it pass*. Rows written before this existed have `checks_json` NULL; treat that as "no evidence recorded", not "nothing checked".

The gate event payload carries `attempt` too, so the `gate_results` table and the event stream are equivalent sources — a live consumer can group gate results per correction round from events alone, without a second query.

**A `tool_call` is the one event that spans time**, so it fills both `started_at` and `ended_at` on the row — the tool's real start and return. Every other type is a point in time: `started_at` is when it was recorded and `ended_at` stays NULL. Lay tool calls out on a time axis from those columns, never by parsing `payload_json` (`duration_ms` is in the payload too, as pi's own number, but it is a convenience, not the source for layout).

**Streaming is solved by construction.** `agent_pi.py` tails pi's JSONL stdout line by line and the tracer inserts each event into `sssf.db` **while the agent is still working** — never batched at phase end (verified in the first smoke run: tool calls visible mid-run). Everything downstream is a poll → render.

## Tables

```sql
sessions (
  adw_id        TEXT PRIMARY KEY,
  adw_name      TEXT,              -- ADW script(s) joined into the run
  request       TEXT,              -- the engineer's ask
  status        TEXT,              -- running | success | fail
  engineer      TEXT,
  started_at    TEXT, ended_at TEXT,
  total_tokens  INTEGER, total_cost REAL,
  archived      INTEGER DEFAULT 0  -- review state; 1 hides it from Active
);

phases (
  phase_id      TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  seq           INTEGER,
  name TEXT, kind TEXT, owner TEXT, description TEXT,
  status        TEXT DEFAULT 'fail',   -- success must be earned
  attempt       INTEGER DEFAULT 0, retries INTEGER DEFAULT 0,
  error         TEXT,
  started_at    TEXT, ended_at TEXT
);

events (
  event_id      TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,   -- every event logs against adw + phase
  parent_id     TEXT,                     -- span nesting
  type          TEXT,   -- phase_start | phase_end | agent_start | agent_end | tool_call
                        -- | handoff | gate_pass | gate_fail | log | error
  name          TEXT,
  payload_json  TEXT,
  tokens        INTEGER,
  started_at    TEXT, ended_at TEXT   -- ended_at set only on events that span time
);

envelopes (
  envelope_id   TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  agent         TEXT,
  output_type   TEXT,              -- name of the data_types model it parsed against
  payload_json  TEXT,
  valid         INTEGER,
  attempt       INTEGER,
  created_at    TEXT
);

gate_results (
  id            INTEGER PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  attempt       INTEGER,
  gate          TEXT,
  passed        INTEGER,
  violations_json TEXT,             -- derived: the failed checks, as "item: note"
  checks_json   TEXT,               -- [{item, ok, note}] — everything the gate looked at
  created_at    TEXT
);

processes (                        -- adw_id → pid, so a stuck run can be stopped
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  kind          TEXT,               -- 'adw' | configured 'agent' | nested 'subagent'
  name          TEXT,               -- agent name, or {subagent_id}:{turn} for a nested process
  pid           INTEGER,
  command       TEXT,               -- what the pid WAS; pids get recycled, so verify before killing
  started_at    TEXT, ended_at TEXT -- ended_at NULL = believed alive
);

agent_sessions (                   -- the queryable mirror of agent_map.json
  adw_id        TEXT REFERENCES sessions,
  agent         TEXT,
  coding_agent  TEXT, model TEXT, color TEXT,   -- color: the config's lane swatch
  session_id    TEXT,
  context_tokens INTEGER,           -- window occupancy after the agent's last turn
  context_window INTEGER,           -- the model's ceiling, from the pi registry
  created_at    TEXT, last_used_at TEXT,
  PRIMARY KEY (adw_id, agent)
);

subagents (                        -- one stable nested conversation
  subagent_id TEXT PRIMARY KEY,
  adw_id TEXT REFERENCES sessions, phase_id TEXT REFERENCES phases,
  parent_agent TEXT, display_id INTEGER,
  parent_tool_call_id TEXT, parent_event_id TEXT,
  task TEXT, session_path TEXT, status TEXT,
  created_at TEXT, started_at TEXT, ended_at TEXT, duration_ms INTEGER,
  removed_at TEXT
);

subagent_turns (                   -- initial task plus every continuation
  turn_id TEXT PRIMARY KEY, subagent_id TEXT REFERENCES subagents,
  adw_id TEXT, phase_id TEXT, turn INTEGER,
  parent_tool_call_id TEXT, parent_event_id TEXT,
  prompt TEXT, model TEXT, thinking TEXT, pid INTEGER,
  status TEXT, started_at TEXT, ended_at TEXT, duration_ms INTEGER,
  result TEXT, error TEXT, tool_count INTEGER,
  raw_output_path TEXT, session_path TEXT,
  start_telemetry_id TEXT UNIQUE, finish_telemetry_id TEXT UNIQUE,
  UNIQUE(subagent_id, turn)
);

subagent_activities (              -- cursor-paged completed child tools
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telemetry_id TEXT UNIQUE, activity_id TEXT,
  subagent_id TEXT REFERENCES subagents, adw_id TEXT, turn INTEGER,
  tool_call_id TEXT, tool TEXT, args_json TEXT, result_snippet TEXT, ok INTEGER,
  started_at TEXT, ended_at TEXT, duration_ms INTEGER
);
```

**A hung agent emits nothing**, which is exactly when you need its pid: no events, no tokens, no output to read. `processes` is the only table that can answer "what is this run running, and how do I stop it" — `just procs <adw_id>` lists what is live, `just kill <adw_id>` stops children before the parent, and both verify the recorded `command` still matches the pid before signalling it. SIGTERM and SIGINT are turned into `SystemExit` in `session.ensure`, so a catchable termination lands the session on `fail`. A harder termination can prevent Python from unwinding; when that ADW is later resumed, the next session finalization reconciles every leftover `running` phase to `fail` with an end time before publishing the terminal session status. The persisted invariant is therefore: a terminal session never contains a phase that still claims to be running.

### Nested Pi subagents

Nested children are intentionally not configured agents or phases. Three additive tables retain their separate identities:

- `subagents`: one stable conversation id, local display number, configured parent agent/phase, parent Pi tool-call/event links, target-repo session path, lifecycle status, and removal metadata.
- `subagent_turns`: the initial task and every continuation, preserving each prompt, model/thinking, PID, timestamps/duration, complete result/error, and tool count. Continuations reuse the same child session file and append a turn.
- `subagent_activities`: cursor-ordered normalized child tool completions with arguments, result snippets, success, and timing. `telemetry_id` uniqueness makes final drains/retries idempotent.

With harness trace context, files live at `sessions/{adw_id}/{parent_agent}/subagents/{subagent_id}/`: `session.jsonl`, `turn-N/raw_output.jsonl`, and `turn-N/result.txt`. The shared `telemetry.jsonl` is tailed while the configured parent runs; only Python's tracer writes SQLite. Nested PIDs use `processes.kind = 'subagent'`. Session finalization changes any leftover live child/turn to `interrupted` and closes its process row. Without trace context the extension remains standalone and keeps its normal `~/.pi` session location without emitting SSSF telemetry.

The visualizer projects configured phase agents and nested conversations as one hierarchy. `SessionDetail.agents` contains configured nodes followed by children linked through `parent_agent_id`; session-list cards deliberately keep their configured-only `AgentSession` projection. The local read API exposes both sources through one vocabulary:

- `GET /api/sessions/:adw_id/agents/:agent_id` — configured identity or all ordered nested turns and results;
- `GET /api/sessions/:adw_id/agents/:agent_id/activity?after=<id>&limit=<n>` — cursor-paged normalized tools.

Lookups are ADW-scoped. Databases predating the optional nested storage tables still return configured trace agents. The trace renders children beneath their spawning configured phase on the shared time axis and opens the same agent-detail interaction for either source. The API and UI remain loopback-only; this adds no remote transport, authentication, or CORS policy.

**Derived, never stored:** phase durations (`ended_at − started_at`), session phase-progress (query `phases` by `adw_id`), lane layout (`kind` + `owner`).

Phase status invariants: `queued` only for manifest-declared phases not yet entered (dashed in the UI); `running` on enter; only a clean exit writes `success` — agent phases additionally need the envelope parsed and gates green; everything else resolves to `fail`.

## WAL pragmas

Open **every** connection — writer and reader — with:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
```

WAL allows readers during writes. Writers are the tracers of running ADW processes; concurrent writers are fine given one small transaction per event plus `busy_timeout`. Normal visualizer observation stays on a readonly connection. Two explicit human actions lazily open a separate writer: Archive/Restore (`POST /api/sessions/:adw_id/archive`) sets `sessions.archived`, and confirmed permanent Delete removes an archived run. Archive state is review triage — it says a human has looked at the run — and no tracer writes or reads it.

## Visualizer lifecycle and exposure

`just obs` is the supported launcher. It installs the visualizer dependencies, checks that the fixed ports are free, starts the API on `127.0.0.1:4600`, waits for `/api/health`, and only then starts Vite on `127.0.0.1:4601`. Neither listener is exposed beyond IPv4 loopback. A collision on either port fails startup instead of choosing another port; stopping the recipe or losing either child terminates and reaps both children. The health response identifies its target workspace using only the repository basename; it never exposes the selected database's absolute path.

The stamped recipe passes the target repository's absolute db path to this lifecycle supervisor. That path remains server-side. `install.py` still stamps the template justfile only when absent unless `--force` is used.

## Polling contract

**The UI never receives pushes.** No ingest endpoint and no WebSocket.

The sessions screen has one polling owner and a constant request count. It requests the active and archived collections with `GET /api/sessions?archived=0|1` at a modest cadence. Each response embeds phases, agents, and at most 120 compact card markers per session. Those markers contain identity, attribution, type/name, and time only: no payloads or token data. High-volume histories are deterministically sampled across the full run while retaining their first and newest eligible activity, and the response says when the marker count was truncated. Cards never fetch event histories themselves.

Archive state is explicit, reversible review state. `POST /api/sessions/:adw_id/archive` with `{"archived":true}` moves a run out of Active; `false` restores it. Archived runs remain available through the normal detail endpoint and can be inspected before restoration. Databases predating the optional column still expose their rows as active.

Delete is separate and irreversible. `DELETE /api/sessions/:adw_id` succeeds only when the server re-reads `sessions.archived` as exactly `1` inside the deletion transaction; the UI tab is never authorization. Safe IDs return `200` after cleanup, unknown IDs return `404`, active or legacy-without-archive-state rows return `409`, and unsafe path segments return `400`. A successful transaction deletes exact-`adw_id` rows from the seven core projections (`sessions`, `phases`, `events`, `envelopes`, `gate_results`, `processes`, and `agent_sessions`) and, when present, the three nested-agent projections (`subagents`, `subagent_turns`, and `subagent_activities`). It stages and recursively removes `{dirname(sssf.db)}/sessions/{adw_id}`; an already-missing directory is harmless. Staging uses an exact same-parent path and is restored if SQL or commit fails, so traversal, prefix deletion, and partial pre-commit cleanup are refused.

The selected-session trace is the lossless stream. It polls one bounded rowid-cursor page at a time:

```sql
SELECT ... FROM events WHERE adw_id = ? AND rowid > ? ORDER BY rowid LIMIT 500;
```

Keep the highest `rowid` returned as the next cursor. Backlog pages are loaded sequentially without overlapping requests. A running trace continues polling; once session metadata changes out of `running`, the client drains the final event pages and stops. A completed history therefore eventually contains every event exactly once without polling forever. Only the card projection is sampled.
