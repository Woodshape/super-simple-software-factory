---
status: complete
---

# Plan: unify configured and nested agents in the visualizer

## Goal and constraints

Replace the visualizer-only split between configured agents and the standalone “Nested subagents” inspector with one agent projection and one selection/detail interaction. The trace must keep configured phase lanes visually and behaviorally intact, but insert each child conversation as an indented agent row directly beneath the configured agent/phase that spawned it. All rows use the same time axis and all agent selections open the same detail-panel location and URL interaction.

The SQLite producer schema remains a valid persistence implementation: `agent_sessions`/`phases`/`events` still hold configured-agent telemetry, while `subagents`, `subagent_turns`, and `subagent_activities` retain child identity, continuation history, and raw observability. Do not edit the extension, Python ingestor/tracer, raw session files, or telemetry protocol unless implementation proves a field is genuinely unavailable; the current data for `da18dd31` already contains every field required by this feature. This is a read-projection and presentation unification, not a persistence migration or flattening of children into peer lanes.

## 1. Define one visualizer agent contract

Files:

- `.claude/skills/sssf/apps/visualizer/shared/types.ts`
- `.claude/skills/sssf/apps/visualizer/src/lib/types.ts`

Changes:

1. Replace the public `Subagent*` read contracts with a discriminated unified agent model. Define a common agent base containing an opaque per-session `agent_id`, `source: "configured" | "nested"`, `adw_id`, `phase_id`, `parent_agent_id`, display name/identity, task, lifecycle status/timestamps, model/thinking, turn/tool counts, and common session metadata. Use source-specific variants for:
   - configured fields already used by the trace (`agent`, `coding_agent`, `session_id`, color, context occupancy, phase/attempt metadata); and
   - nested fields (`subagent_id`, local display number, parent configured-agent name, parent tool/event links, session path, removal time).
2. Use one status union that accepts existing configured states (`queued`, `running`, `success`, `fail`) and child terminal states (`error`, `cancelled`, `killed`, `interrupted`) without erasing their persisted meaning.
3. Rename child turns and activities at the read seam to `AgentTurn`, `AgentActivity`, `AgentDetail`, and `AgentActivitiesPage`. Every activity must carry `agent_id`, turn attribution where available, tool identity, args/result, success, timing, and a source-local monotonic cursor.
4. Make `SessionDetail.agents` the unified trace roster. Keep `SessionSummary.agents` as the existing configured-only `AgentSession[]` used by session cards; this deliberately prevents nested children from becoming top-level card peers and avoids changing `SessionCard.vue` behavior.
5. Document identifier semantics in the types: configured trace nodes use their phase id (so a repeated configured agent can still be selected unambiguously), nested nodes use their stable `subagent_id`, and `parent_agent_id` points from a child to the spawning configured phase node. Keep the source discriminator so callers never infer origin from id syntax.

## 2. Build the unified server projection and routes

Files:

- `.claude/skills/sssf/apps/visualizer/server/db.ts`
- `.claude/skills/sssf/apps/visualizer/server/app.ts`
- `.claude/skills/sssf/apps/visualizer/server/db.test.ts`
- `.claude/skills/sssf/apps/visualizer/server/app.test.ts`

Changes:

1. Preserve `agentsFor`/`agentSessions` as the configured-only projection used by session-list cards. Add a trace-agent projection for `sessionDetail` that:
   - emits one configured agent node per agent phase, ordered by phase sequence;
   - merges `agent_sessions` with live `agent_start` payload metadata exactly as today, including model, thinking, color, coding agent, session id, and context values;
   - appends nested nodes from `subagents`/latest `subagent_turns`, linked by `parent_agent_id = phase_id`, in stable creation/display order; and
   - returns configured nodes normally when optional nested tables are absent.
2. Keep the nested-table queries as private storage adapters rather than a second public domain model. Continue scoping every lookup by `adw_id`; preserve full ordered continuation turns and the latest task/model/thinking summary; never join children into configured `agent_sessions` or phase/event accounting.
3. Add generic readers `agent(adwId, agentId)` and `agentActivities(adwId, agentId, after, limit)`. Dispatch by the unified node’s source:
   - configured detail retains the configured summary/phase identity, and configured tool activity is normalized from that phase’s `tool_call` events;
   - nested detail adds all `subagent_turns`, and activity is normalized from `subagent_activities` without losing telemetry ids, turn numbers, arguments, results, failures, or timing.
   Both activity implementations must obey the existing bounded cursor contract.
4. Replace the child-specific read routes used by the app with:
   - `GET /api/sessions/:adw_id/agents/:agent_id`
   - `GET /api/sessions/:adw_id/agents/:agent_id/activity?after=<cursor>&limit=<n>`
   Keep the existing configured prompt route (`.../agents/:agent/prompts`) unchanged. Validate safe path segments, ADW scope, nonnegative integer cursors, and bounded limits; return 404 for a valid but mismatched/unknown agent. Remove the old `/subagents` routes once the client and tests no longer use them, so the server exposes one read vocabulary.
5. Ensure a running continuation is projected as live even if the persisted conversation row still contains the previous turn’s `ended_at`: status governs whether the UI uses `now`, while ordered turn rows preserve all prior terminal timestamps/results.

## 3. Centralize client normalization, hierarchy, and polling helpers

Files:

- `.claude/skills/sssf/apps/visualizer/src/lib/api.ts`
- new `.claude/skills/sssf/apps/visualizer/src/lib/agents.ts`
- new `.claude/skills/sssf/apps/visualizer/src/lib/agents.test.ts`
- remove `.claude/skills/sssf/apps/visualizer/src/lib/subagents.ts`
- remove `.claude/skills/sssf/apps/visualizer/src/lib/subagents.test.ts`

Changes:

1. Replace `fetchSubagents`, `fetchSubagent`, and `fetchSubagentActivity` with generic detail/activity clients. `fetchSession` must normalize the unified roster while retaining the configured-only session-card response contract.
2. Move malformed/legacy normalization, status-aware live duration calculation, continuation ordering, and cursor deduplication into `lib/agents.ts`. Preserve inspectable fallbacks for malformed rows instead of crashing the trace.
3. Add a pure hierarchy builder that groups configured nodes by their existing lane/phase order and recursively places children immediately below `parent_agent_id`. If legacy data lacks an exact phase link, fall back to a unique configured node with the recorded parent-agent name; if no parent can be resolved, keep the row visibly indented beneath an explicit unresolved-parent group rather than promoting it to a top-level peer.
4. Add pure shared-axis geometry helpers for nested lifecycle blocks and activity marks. Geometry must use the trace’s global origin/span, include child timestamps/activity in range calculation, ignore stale `ended_at` while status is running, and use a visible minimum width without shifting unrelated rows.
5. Maintain one polling owner in `SessionTrace`: session detail supplies the changing roster, existing event paging supplies configured activity, and a keyed cursor/activity cache fetches one bounded generic activity page for each nested node. Drain backlogs immediately, keep polling while the session or any child is running, perform the final drain for completed sessions, and reuse cached child activity for both chart marks and detail so selecting a child does not create another poller. Preserve caches/selection across roster object replacement and across continuation turns.

## 4. Render children in the top chart and use one detail interaction

Files:

- `.claude/skills/sssf/apps/visualizer/src/components/SessionTrace.vue`
- rename/refactor `.claude/skills/sssf/apps/visualizer/src/components/PhaseDetail.vue` to `.claude/skills/sssf/apps/visualizer/src/components/AgentDetail.vue`
- remove `.claude/skills/sssf/apps/visualizer/src/components/SubagentInspector.vue`
- `.claude/skills/sssf/apps/visualizer/src/components/StatusChip.vue`
- `.claude/skills/sssf/apps/visualizer/src/lib/router.ts`
- `.claude/skills/sssf/apps/visualizer/src/App.vue`
- `.claude/skills/sssf/apps/visualizer/src/style.css` only for genuinely shared detail/tool styles

Changes:

1. Keep engineer, code, and configured-agent lane rendering, configured phase blocks, colors, context bars, queued blocks, costs, gates, envelopes, prompts, and event behavior unchanged. Derive those lanes from `source === "configured"` nodes.
2. After each configured agent lane, render its child nodes as indented rows with a branch/parent cue. Each child gets:
   - a stable identity label (`#display_id` plus stable id), model and status;
   - one lifecycle block on the exact same axis as the parent phase, using child start/end/live time and task text; and
   - success/failure tool marks from that child’s activity cache, tagged by turn where useful.
   Sort siblings by creation/display order. A continuation remains one child row and expands its history in detail; it must not create a new top-level row.
3. Remove the nested-count badge if it is redundant with visible rows and completely remove the always-present `SubagentInspector` mount. Do not auto-select the first child; the trace is initially unselected just as it is for configured phases.
4. Generalize the hash route’s second segment from `phaseId` to `agentId`/detail target. Clicking either a configured phase block or a nested lifecycle block toggles the same selected-agent route, updates the same breadcrumb, and opens/closes the same detail-panel position.
5. Refactor the current phase detail into `AgentDetail.vue` with one shell/header/close interaction and source-specific sections:
   - configured agents retain all current phase detail sections and prompt loading behavior;
   - nested agents show stable identity and parent link, task, model/thinking, session identity/path, lifecycle timing, every ordered turn with prompt/result/error/status/duration, and normalized tool activity with safe JSON highlighting.
   Reuse/extract the current tool-call row presentation rather than maintaining a second raw `<pre>` implementation. Long prompts/results/arguments must remain wrapped or scrollable.
6. Extend `StatusChip` so all child terminal statuses use the failure icon/color while retaining their exact labels; running children use the existing live treatment.

## 5. Focused regression and acceptance coverage

1. In `server/db.test.ts`, build a synthetic fixture named `da18dd31` mirroring the local acceptance run: configured phase `da18dd31_02_scout`, configured agent `scout`, children `sub_msh502p4_1_af8882dc` and `sub_msh502pb_2_bb3b893e`, and 9/6 child activities respectively. Assert the unified roster contains scout as the configured parent followed hierarchically by exactly those two nested agents, with source-specific metadata, parent ids, independent lifecycle times, and no children added to the configured-only card projection.
2. Add DB tests for generic configured and nested detail/activity paging, ADW mismatch, optional-table legacy behavior, current live rows, a live continuation with a stale prior end time, ordered multi-turn results, and cancelled/interrupted states. Existing producer smoke coverage in `server/subagent_observability.test.ts` remains unchanged.
3. Update `server/app.test.ts` to exercise both generic agent sources through the new URLs, query validation and 404 scoping, cursor paging, and a database update from running to terminal to prove live reads are not cached.
4. In `src/lib/agents.test.ts`, cover normalization, recursive parent ordering, unresolved-parent indentation, no flattening, shared-axis geometry for overlapping siblings, activity merge/deduplication, live duration, and continuation ordering. Use the two-child `da18dd31` identifiers/timestamps so the helper test is an executable rendering fixture without depending on the ignored local `adws/` database.
5. Manually run the app against `adws/adw_data/sssf.db` and open `#/da18dd31`. Verify two rows appear directly beneath scout on its axis; the first shows 9 marks and the second 6; each opens the unified detail with its distinct task, `openai-codex/gpt-5.6-luna`/`low` metadata, turn result, and tools; scout still opens its unchanged configured detail; and there is no standalone “Nested subagents” section.

## 6. Keep documentation aligned without changing persistence

Files:

- `.claude/skills/sssf/references/observability.md`
- `README.md`

Update the visualizer/read-API wording to distinguish the deliberately separate storage tables from the unified agent read model. Document the generic agent detail/activity routes, hierarchy semantics, and unchanged configured card projection. Remove claims that the UI exposes a separate nested inspector. Retain all raw-file, telemetry, process, loopback-only, no-auth, and no-CORS statements.

## Verification

From `.claude/skills/sssf/apps/visualizer/`, judge every command by exit status:

1. Focused tests while iterating:
   - `bun test server/db.test.ts server/app.test.ts src/lib/agents.test.ts`
   - `bun test server/subagent_observability.test.ts`
2. Full gates:
   - `bun test`
   - `bun run typecheck`
   - `bun run lint`
   - `bun run build`
3. Historical acceptance fixture:
   - start `bun run dev:all` with `SSSF_DB` pointing at the repository’s `adws/adw_data/sssf.db`;
   - inspect `#/da18dd31` and the generic agent routes for scout and both known child ids;
   - reload after completion and confirm identical hierarchy/details from persisted data.
4. Live behavior:
   - use the mutable route-test fixture (and, when practical, a real traced run) to observe a child appearing under its parent, activity marks arriving without selection, detail updating while running, terminal final drain, and a continuation updating the same row while retaining turn 1.

Do not commit or rewrite the ignored `adws/adw_data/sssf.db` or session `da18dd31`; it is a local acceptance fixture only. Do not modify the telemetry producer or raw persistence merely to rename the visualizer projection.
