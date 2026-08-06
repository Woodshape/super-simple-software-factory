---
status: in_progress
---

# Implement permanent deletion for archived visualizer sessions

## Objective

Add a confirmed, irreversible Delete action to archived session cards. The server must enforce the archived-only invariant independently of the client, transactionally remove every database projection owned by the selected `adw_id`, and recursively remove the sibling raw session directory without allowing path traversal or partial pre-commit cleanup. Existing GET detail, archive/restore, polling, and nested-agent observability behavior must remain intact.

## Current repository findings

- API routes are defined by `createApiRoutes` in `.claude/skills/sssf/apps/visualizer/server/app.ts`; `server/index.ts` only binds the route map and static host. The existing `/api/sessions/:adw_id` handler therefore needs to become a GET/DELETE method map in `app.ts`, not in `index.ts` as the source spec anticipated.
- `SssfDb` has a readonly query connection and a lazy writable connection currently described as archive-only. It derives `sessionsDir` as `{dirname(sssf.db)}/sessions` and already probes optional legacy columns/tables.
- The source spec predates nested-agent persistence and names seven tables. The current tracer schema has ten session-owned tables: the seven core tables (`sessions`, `phases`, `events`, `envelopes`, `gate_results`, `processes`, `agent_sessions`) plus `subagents`, `subagent_turns`, and `subagent_activities`. To satisfy “every SQLite row owned by the selected `adw_id`,” deletion must include all ten when present while still tolerating legacy databases without the optional nested tables.
- `SessionsList.vue` owns both list polls and optimistic archive/restore movement. `SessionCard.vue` is an anchor with one Archive/Restore button that already suppresses card navigation. There is no pending-action state or component test harness.
- Baseline checks pass from `.claude/skills/sssf/apps/visualizer`: `bun test` (20 tests), `bun run typecheck`, `bun run lint` (one existing warning in `src/lib/models.ts`), and `bun run build`.

## Implementation plan

### 1. Add a guarded database/filesystem deletion operation

**File:** `.claude/skills/sssf/apps/visualizer/server/db.ts`

1. Replace archive-only writer comments with a description of the two explicit human mutations, and factor lazy writer initialization so archive and delete share the same writable SQLite connection and `busy_timeout`/WAL-compatible settings.
2. Add an exported deletion result contract that distinguishes at least `deleted`, `not_found`, `not_archived`, and legacy/unsupported archive state. This lets the route return stable status codes without parsing exceptions.
3. Add `SssfDb.deleteArchivedSession(adwId)` and validate its filesystem target even for direct method calls: resolve `{sessionsDir}/{adwId}` and require its parent to be exactly `sessionsDir`. Reject nested paths, `.`/`..`, or any value that can escape the session root; do not rely only on HTTP validation.
4. Run the existence/archive check and SQL cleanup in one immediate write transaction so another writer cannot change archive state between the check and deletion. Re-read the row in that transaction, return `not_found` without touching files for an unknown ID, refuse an active row, and refuse a legacy row when the `archived` column is absent rather than treating missing state as permission to delete.
5. Before SQL commit, atomically rename an existing raw target to a unique tombstone in the same `sessionsDir` parent. Treat a missing raw directory as already clean. Track whether staging occurred so any staging or SQL/commit failure rolls the SQLite transaction back and renames the tombstone to its exact original path; surface a clear error if compensation itself fails.
6. Delete by exact `adw_id` in dependency-safe order using a fixed allowlist of current schema tables: `subagent_activities`, `subagent_turns`, `subagents`, `events`, `envelopes`, `gate_results`, `processes`, `agent_sessions`, `phases`, then `sessions`. Use the existing table probes for optional/legacy tables, keep all statements in the same transaction, and never use prefix matching or depend on disabled SQLite foreign-key cascades.
7. After commit, recursively remove the staged path and report `deleted` only after cleanup has been attempted successfully. If post-commit removal fails, throw so the request is not reported as a complete success; the original public session path must remain absent. Do not change `tracer.py` or attempt a cascade migration, since existing databases would not gain retroactive foreign-key behavior.

### 2. Expose `DELETE /api/sessions/:adw_id`

**Files:**
- `.claude/skills/sssf/apps/visualizer/server/app.ts`
- `.claude/skills/sssf/apps/visualizer/server/app.test.ts`

1. Convert the current `/api/sessions/:adw_id` entry to a Bun method map. Preserve its GET validation/detail/404 behavior verbatim and add DELETE beside it.
2. Decode and validate `adw_id` with the existing safe-segment rule before invoking the database method. Return:
   - `200` with a small JSON acknowledgement such as `{ adw_id, deleted: true }` for success;
   - `400` for an unsafe ID;
   - `404` for an unknown session;
   - `409` with an actionable “archive before deleting” message for an active row and a distinct archive-state/legacy message when the database cannot prove the row is archived.
   Unexpected SQLite, staging, compensation, or cleanup failures should continue through `safely` as `500` JSON errors.
3. Extend route tests to prove GET still works after the method-map refactor and that DELETE maps success, active refusal, unknown/repeated deletion, legacy refusal, and unsafe IDs to the intended statuses and error payloads. Update the route fixture with any tables/raw directories needed by the real deletion path rather than mocking away the database behavior.

### 3. Add the client API and confirmed archived-card action

**Files:**
- `.claude/skills/sssf/apps/visualizer/src/lib/api.ts`
- `.claude/skills/sssf/apps/visualizer/src/components/SessionsList.vue`
- `.claude/skills/sssf/apps/visualizer/src/components/SessionCard.vue`
- `.claude/skills/sssf/apps/visualizer/shared/types.ts`

1. Add a typed deletion acknowledgement if useful to the shared API contracts, and implement `deleteSession(adwId)` using encoded `DELETE /api/sessions/:adw_id`. On failure, parse `{ error }` when available and fall back to method/URL/status so backend refusals are understandable in `actionError`.
2. Change `SessionCard` to expose separate archive/restore and delete events. Keep active cards unchanged with only Archive; archived cards get Restore plus a visually destructive Delete button in a compact action group.
3. Give both buttons native `disabled` behavior and a pending/busy label/state for the selected action. Their click handlers must prevent default and stop propagation so mouse and keyboard activation never opens the surrounding card. Retain explicit title and ARIA labels and style Delete distinctly without making Restore appear destructive.
4. In `SessionsList`, track pending action by `adw_id` (a map/set rather than a single unscoped boolean) and pass the matching state to each card. Prevent duplicate mutations for the same session and disable both Restore/Delete controls on that card while one is in flight; adapt the existing archive/restore path to clear pending state in `finally` without losing its rollback and refresh behavior.
5. Add a dedicated delete handler that first verifies the ID is still in `archivedSessions`, then calls `window.confirm` with the session ID/name and an explicit warning that trace/database records and files will be permanently removed. Do not send a request when confirmation is declined.
6. After a successful response, remove only that ID from `archivedSessions` immediately and invoke the existing non-overlapping `tick()` refresh so counts and server state reconcile. On refusal/failure, retain the card, show `delete failed — …` through `actionError`, and refresh to recover from stale polling state. Do not add delete to active cards, detail pages, or a bulk action.

### 4. Cover transactional deletion and isolation

**File:** `.claude/skills/sssf/apps/visualizer/server/db.test.ts`

1. Expand or add a full temporary WAL fixture containing all ten current production tables, including the nested-agent tables, and create sibling `sessions/{adw_id}` trees with nested files. Seed an archived target and at least one control session with rows in every table.
2. Test successful deletion: every table has zero target rows, the exact raw directory is recursively gone, and every control row/file remains unchanged. Include similarly prefixed IDs to guard against prefix-based deletion.
3. Test refusal/no-op cases independently: active session, unknown session (including any orphan directory), legacy database without `sessions.archived`, and an unsafe direct-method path. Assert both database and filesystem state remain untouched.
4. Test an archived session whose raw directory is already missing; it should still delete all database rows successfully.
5. Force a later child-table DELETE to fail with a temporary trigger after earlier statements and filesystem staging have occurred. Assert the transaction restores all target rows, the tombstone is gone, and the original session tree is restored, proving there is no partial pre-commit cascade.
6. Ensure existing archive/restore, card timeline, nested-agent, event cursor, and API tests continue to pass; do not weaken legacy-read compatibility to make deletion tests easier.

### 5. Update documentation and stale read-only descriptions

**Files:**
- `.claude/skills/sssf/references/observability.md`
- `README.md`
- `.claude/skills/sssf/apps/visualizer/package.json`
- comments in `.claude/skills/sssf/apps/visualizer/server/db.ts`
- header/API comments in `.claude/skills/sssf/apps/visualizer/shared/types.ts`

1. Replace claims that the visualizer is wholly read-only or has exactly one write. State that normal observation remains readonly and polling-based, while archive/restore and confirmed permanent deletion are explicit human-triggered mutations on the separate writer connection.
2. Document `DELETE /api/sessions/:adw_id`, the backend archived-only invariant, 200/400/404/409 behavior, path validation, missing-directory behavior, and recursive removal of `{dirname(sssf.db)}/sessions/{adw_id}`.
3. List all ten current session-owned projections removed by deletion, distinguishing the seven core tables from the three optional nested-agent tables so the documentation remains correct for current and legacy databases.
4. Preserve the “files are raw record / SQLite is queryable mirror” model but add the deliberate exception: permanent deletion intentionally removes both representations for the selected archived run, so that run is no longer rebuildable from its removed raw directory.
5. Update the package description and README directory summary/visualizer paragraph to describe a local observability UI with archive and guarded delete controls, while retaining loopback-only exposure and no-push transport claims.

## Verification

From `.claude/skills/sssf/apps/visualizer`, run and require successful exit status from:

```bash
bun test
bun run typecheck
bun run lint
bun run build
```

Then smoke-test only against a disposable copied database and `sessions/` tree:

1. Confirm an active DELETE returns 409 and leaves every row/file intact.
2. Archive the session, open Archived, decline confirmation once (no change), then confirm deletion; verify the card/count updates, all ten target projections are gone, and only the exact target directory was removed.
3. Repeat DELETE and confirm 404.
4. Verify Restore on another archived run, active Archive, card/detail navigation, nested-agent detail/activity, and periodic active/archived polling still work.

## Acceptance criteria

- Delete is rendered only for archived cards and always requires explicit irreversible-action confirmation.
- Client state cannot bypass the server: unsafe, unknown, active, and legacy-without-archive-state requests delete neither rows nor files.
- A successful deletion removes the exact session from every present current projection, including nested-agent telemetry, and recursively removes only its raw session directory.
- SQL cleanup is atomic; a pre-commit failure restores both all rows and the original filesystem path. A missing raw path is harmless.
- GET detail, archive/restore, polling, nested observability, and session isolation remain functional, and all visualizer verification commands pass.
