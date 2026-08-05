# Plan: end-to-end nested Pi subagent observability

## Source of truth and scope

Implement against `adws/adw_data/sessions/78e383f4/context_handoff/scout_findings.md`. The missing path is the nested Pi process created by `templates/harness_engineering/subagents.ts`; configured ADW agents, their phases, and their current `agent_sessions`/event views must retain their existing meaning.

Keep the existing local polling architecture: nested activity is persisted in the target repository, mirrored into `sssf.db`, exposed by bounded read endpoints, and polled by the Bun/Vue visualizer. Do not add remote listeners, auth, CORS, websockets, or an ingest server, and do not edit the repository's already-stamped `adws/` copy. All producer changes belong in distributable templates and can be smoke-tested by installing those templates into a temporary repository.

## Architectural contract

Use a separate nested-subagent model rather than pretending children are configured agents or ADW phases:

- A **subagent** is one stable conversation identity. It retains the first parent ADW id, configured parent agent, parent phase, Pi tool-call id/event id, a filesystem-safe stable id, the display number used by the extension, its target-repo session path, lifecycle state, and removal/cancellation metadata.
- A **turn** is the initial task or one `subagent_continue` prompt. It retains turn number, the parent tool-call/event link for that invocation, task/prompt, effective model and thinking level, PID, status, timestamps/duration, complete final assistant result, error, and tool count. Continuations append turns to the same subagent and reuse its Pi session file; they never overwrite earlier prompts/results.
- An **activity** is a normalized child tool call with a monotonic SQLite cursor, stable telemetry id, child/turn identity, tool label, arguments, result snippet, success, and start/end/duration. Keep this contract separate from the existing configured-agent `events` stream so `EventType`, phase attribution, `SessionDetail.agents`, card rows, and configured-agent lanes do not change semantics.
- Statuses must distinguish at least running, success, error, and cancelled/killed. Removing a widget must not delete historical records. If the parent/session exits with a child still marked running, reconcile that child/turn and its process row to a terminal interrupted state rather than leaving a false live record.
- The Pi extension must still work standalone. Without SSSF trace context it keeps the current `~/.pi/.../subagents` behavior and emits no SSSF telemetry. With trace context, all child session, raw-output, result, and telemetry files live below `adws/adw_data/sessions/{adw_id}/{parent_agent}/subagents/` in the target repo.

Use a file-backed producer seam rather than letting the extension open SQLite. The Python harness passes a versioned trace-context object in the parent Pi subprocess environment. The extension appends versioned, idempotent JSONL telemetry records and per-turn raw child stdout under the target session directory. `agent_pi.py` concurrently tails parent stdout and the telemetry file while the parent is live, forwarding both through the existing callback on the Python main thread; the tracer remains the only database writer. This preserves WAL ownership, works with the Node runtime used by Pi extensions, and provides a raw record from which nested rows can be rebuilt.

## Implementation steps

### 1. Define and emit the nested telemetry protocol

Files:

- `.claude/skills/sssf/templates/harness_engineering/subagents.ts`
- new `.claude/skills/sssf/templates/harness_engineering/subagent_observability.ts`

Changes:

1. Extract a small, dependency-light observability module that:
   - validates/parses the versioned SSSF context from the environment;
   - creates filesystem-safe stable subagent ids and deterministic target-repo paths;
   - atomically appends one JSON object per line to the shared telemetry file;
   - writes each child's persistent Pi session and each turn's `raw_output.jsonl`/result beneath the child directory;
   - folds Pi's `message_end`, `tool_execution_start`, and `tool_execution_end` stream into normalized completed tool-call records, using the same clipping and timing expectations as `agent_pi.ToolCallTracker`.
2. Expand `SubState` to retain stable identity, current turn identity, parent call linkage, cumulative lifecycle information, and cancellation/removal intent while preserving the current local numeric id and widgets.
3. In both the tool and slash-command creation paths, mint one stable child id, emit creation metadata, and use the target-repo session path when trace context is present. Tool calls record the `callId`; slash commands remain linked to the parent phase/agent even though no tool-call id exists.
4. In `spawnAgent`, emit a turn-start record immediately after spawn with effective model/thinking, prompt, turn number, session path, PID, and timestamp. Tee every complete child JSON line to the per-turn raw file before parsing it. Emit normalized tool activity as each child tool completes, so it can appear live rather than at child completion.
5. Finalize each process exactly once across `close`, `error`, `subagent_remove`, `subclear`, and parent session restart. Persist end status, timestamps/duration, full final assistant result (not the existing 8,000-character parent-message truncation), stderr/error, and tool count before sending the existing follow-up message. Keep the parent follow-up truncation and widget behavior as presentation concerns.
6. `subagent_continue` must append turn N+1 with its own prompt/model/thinking/parent call id while retaining prior turn records and reusing the same Pi session. Removal/clear kills live processes and emits cancellation/removal metadata but never removes files or history.

### 2. Propagate context and ingest telemetry live in the template harness

Files:

- `.claude/skills/sssf/templates/adws/adw_modules/data_types.py`
- `.claude/skills/sssf/templates/adws/adw_modules/agents.py`
- `.claude/skills/sssf/templates/adws/adw_modules/agent_pi.py`
- new `.claude/skills/sssf/templates/adws/adw_modules/subagent_observability.py`
- `.claude/skills/sssf/templates/adws/adw_modules/tracer.py`
- `.claude/skills/sssf/templates/adws/adw_modules/session.py` or `.claude/skills/sssf/templates/adws/adw_modules/runner.py` only for terminal-state reconciliation if that cannot remain inside `Tracer.session_finish`

Changes:

1. Add a concrete trace-context data type to `PiRequest` containing protocol version, `adw_id`, `phase_id`, configured parent agent, absolute child root, and telemetry path. Construct it in `agents.execute` from `run.session_dir`/`agent_dir`; serialize it into the subprocess environment in `agent_pi.run` without changing the operator environment or extension arguments.
2. Add a deep telemetry reader/ingestor module. It must retain partial trailing lines, begin at the correct offset for each parent Pi invocation (so retries/resumes do not replay old rows), validate required identity against the trusted parent context, and expose complete telemetry dictionaries through the existing `on_event` callback.
3. Refactor `agent_pi.run` so blocking parent stdout reads cannot starve telemetry. A stdout-reader thread/queue plus a small timed main-thread drain is acceptable; callback/tracer calls must remain on one thread because the SQLite connection is thread-bound. Drain final stdout and telemetry records before process exit and preserve all current configured-agent text, usage, error, raw-output, spawn, and exit behavior.
4. Extend `_event_forwarder` to dispatch the versioned nested envelope to the subagent ingestor while continuing to pass ordinary Pi events through the existing configured-agent `ToolCallTracker`. When a parent `subagent_create` or `subagent_continue` tool call is inserted, keep the returned `event_id` and resolve it onto matching nested rows by Pi `tool_call_id`; handle either arrival order.
5. Add `subagents`, `subagent_turns`, and `subagent_activities` tables plus indexes in `tracer.py`. Use idempotent telemetry ids/upserts so a retry or final drain cannot duplicate records. Store explicit ADW/phase/parent links, preserve each turn's prompt/result, and make activity `rowid` suitable for cursor polling. Update the `processes.kind` contract to include `subagent`, inserting the nested PID at turn start and closing it at turn end.
6. Add tracer methods behind one ingestion interface rather than scattering SQL through `agents.py`. On session finish/kill, terminalize any still-running nested turn/subagent and close its process row. Keep existing additive migration behavior and all configured-agent tables unchanged.

### 3. Add backward-compatible Bun server contracts

Files:

- `.claude/skills/sssf/apps/visualizer/shared/types.ts`
- `.claude/skills/sssf/apps/visualizer/server/db.ts`
- `.claude/skills/sssf/apps/visualizer/server/index.ts`
- new `.claude/skills/sssf/apps/visualizer/server/app.ts` (or an equivalently named route factory used by both `index.ts` and route tests)

Changes:

1. Add shared types for subagent status, summary, turn, detail, tool activity, and cursor page. Summary records should be bounded and omit full results/tool payloads; detail returns all ordered turns/results for one child; activity uses the same `after`/`limit`/`cursor`/`has_more` rules as configured events.
2. Add database readers:
   - `subagents(adwId)` returning all children in stable creation order with latest status/task/model/thinking, turn/tool counts, parent identity, and timestamps;
   - `subagent(adwId, subagentId)` returning the child plus every ordered continuation turn and result;
   - `subagentActivities(adwId, subagentId, after, limit)` returning normalized tool calls in insertion order.
3. Probe for optional tables just as optional columns are handled. A database produced by an older tracer must return an empty nested roster rather than fail, and existing session/agent queries must not join in or relabel nested children.
4. Expose and document:
   - `GET /api/sessions/:adw_id/subagents`
   - `GET /api/sessions/:adw_id/subagents/:subagent_id`
   - `GET /api/sessions/:adw_id/subagents/:subagent_id/activity?after=<rowid>&limit=<n>`
   Validate both path segments, scope every child lookup to its ADW, return 404 for unknown/mismatched children, clamp page sizes, and retain loopback/no-CORS behavior.
5. Extract the route map/handler factory from server startup so HTTP response shapes, validation, status codes, and cursor behavior can be tested without importing a module that immediately binds port 4600. `index.ts` should continue to own DB startup, static SPA serving, logging, and shutdown.

### 4. Render live and historical children without changing configured-agent views

Files:

- `.claude/skills/sssf/apps/visualizer/src/lib/types.ts`
- `.claude/skills/sssf/apps/visualizer/src/lib/api.ts`
- `.claude/skills/sssf/apps/visualizer/src/lib/events.ts`
- new `.claude/skills/sssf/apps/visualizer/src/lib/subagents.ts`
- `.claude/skills/sssf/apps/visualizer/src/components/SessionTrace.vue`
- `.claude/skills/sssf/apps/visualizer/src/components/PhaseDetail.vue`
- new `.claude/skills/sssf/apps/visualizer/src/components/SubagentInspector.vue`
- `.claude/skills/sssf/apps/visualizer/src/components/StatusChip.vue` if nested error/cancelled statuses need explicit icons/styles
- `.claude/skills/sssf/apps/visualizer/src/style.css` only for shared responsive styles that do not belong in the new scoped component

Changes:

1. Re-export the shared contracts and add client functions for roster, detail, and activity pages. Normalize absent fields/tables to empty arrays for compatibility, but surface genuine request failures.
2. Keep one polling owner in `SessionTrace`: fetch the bounded nested roster alongside session metadata, continue polling while the ADW or any child is running, and stop after a completed session's final roster/activity pages drain. Do not start one unconditional poller per child.
3. Add a discoverable nested section associated with the parent configured-agent phase. Show a child-count/live indicator on the parent phase and render a dedicated nested roster/turn timeline below the existing waterfall or inside its phase detail; do not insert children into `agents`, create fake phases, or alter configured lane/card attribution.
4. In `SubagentInspector`, make every child selectable and show:
   - stable identity plus local `#N`, configured parent agent/phase, and parent tool/event link;
   - current lifecycle/status, live or final duration, created/start/end times;
   - current task, effective model/provider icon, thinking level, session identity/path, turn count, and tool count;
   - an ordered turn list where continuations retain each prompt, model/thinking, status/duration, error, and full result;
   - a cursor-paged activity list with live updates for the selected running child. Reuse the existing safe JSON highlighting and tool-call presentation for arguments, result snippets, success/failure, and duration.
5. Compute live durations from timestamps and the trace's `nowMs`; do not persist UI-derived values. Preserve user expansion/selection across the 500 ms roster refresh and make long tasks/results/tool payloads scroll or wrap without changing the overall visualizer layout.
6. Leave `SessionCard.vue`, configured phase lanes, costs, prompts, envelopes, gates, and `SessionDetail.agents` behavior intact. Nested rows may add a badge to their parent phase, but must not become configured-agent rows or card timeline owners.

### 5. Add focused persistence, database, route, and UI-model tests

Files:

- new `.claude/skills/sssf/templates/harness_engineering/subagent_observability.test.ts` or an app-local Bun test importing the pure helper
- new `.claude/skills/sssf/templates/adws/tests/test_subagent_observability.py`
- `.claude/skills/sssf/apps/visualizer/server/db.test.ts`
- new `.claude/skills/sssf/apps/visualizer/server/app.test.ts`
- new `.claude/skills/sssf/apps/visualizer/src/lib/subagents.test.ts`

Coverage:

1. Feed synthetic interleaved events for two concurrent children through the TypeScript helper. Assert stable distinct ids, target-session paths (not `~/.pi`), raw stream persistence, normalized args/results/timing, exact lifecycle ordering, cancellation behavior, and a continuation that keeps the child id/session while creating turn 2.
2. Feed the resulting telemetry (including duplicate delivery and both parent-link arrival orders) through the Python ingestor/tracer against a temporary target data directory. Assert target-repo files, subagent/turn/activity rows, process start/end, full results, terminal reconciliation, idempotency, and explicit links to the configured parent phase and tool event.
3. Extend the Bun SQLite fixture with the new tables and two children/continuation/tool activity. Test roster/detail ordering and aggregation, bounded cursor paging without gaps/duplicates, ADW scoping, old databases with no nested tables, and that configured `agents`, phases, card timelines, and event pages remain unchanged.
4. Start the extracted route factory against a temporary fixture and assert the three HTTP contracts, 400 path/query validation, 404 child/ADW mismatches, legacy empty roster, and live-to-terminal response updates.
5. Test pure client grouping/duration/status/activity merge helpers so repeated polling does not duplicate tools, continuations remain ordered, and malformed/legacy payloads degrade to an inspectable raw state.

### 6. Document the distributable behavior

Files:

- `.claude/skills/sssf/references/observability.md`
- `.claude/skills/sssf/cookbooks/install.md`
- `.claude/skills/sssf/cookbooks/sssf_overview.md`
- `.claude/skills/sssf/cookbooks/update_modules.md`
- `README.md`

Changes:

- Replace the fixed table-count/schema claims with the new nested tables and describe stable parent/turn/activity identities, statuses, process rows, raw target-session layout, telemetry-to-tracer path, idempotency, and terminal reconciliation.
- Document the three read endpoints and their summary/detail/cursor polling responsibilities, including legacy-database behavior and the fact that configured-agent contracts are unchanged.
- Update stamped layout/install docs to show nested child session/raw/result files under the parent agent. Explain that existing installations need `install.py --force` (with the existing overwrite warning) to receive template updates.
- Update the top-level visualizer description to mention live/historical nested children and tool inspection. Retain the explicit loopback-only/no-remote-hosting scope.

## Verification

1. Run the Python/template-focused tests with the dependencies declared by the templates (for example `uv run --with pytest --with pydantic --with pyyaml --with python-dotenv --with rich pytest .claude/skills/sssf/templates/adws/tests`). Judge only the command exit status.
2. From `.claude/skills/sssf/apps/visualizer/`, run in order:
   - `bun test`
   - `bun run typecheck`
   - `bun run lint`
   - `bun run build`
3. Create a temporary git repository, run `.claude/skills/sssf/scripts/install.py` into it, and execute a real configured planner/scout prompt that creates two nested children concurrently, waits for both, then continues one child for a second turn. Do not copy the template changes into this repository's existing stamped `adws/` tree.
4. While that parent is live, query the temporary target's `sssf.db` and the three HTTP endpoints. Confirm both stable child ids appear under the correct configured parent/phase; PIDs/statuses and tool counts update live; child tools have arguments/results/timing; and continuation turn 2 preserves turn 1 and the Pi session identity.
5. After completion and after restarting the visualizer, confirm the same historical records, full per-turn results, durations, and activity remain available, no process/child is falsely running, and raw child files are under the temporary target's session directory.
6. Open the built UI against that database and inspect both children during and after the run. Confirm every required field is visible and that configured-agent cards, lanes, phase detail, prompts, costs, envelopes, gates, and archive behavior render as before. Also open an older database with no nested tables and confirm it remains usable with an empty nested section.
