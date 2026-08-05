# Plan: permanently delete archived visualizer sessions

## Objective

Add an explicit, irreversible delete action to the visualizer's Archived collection. Deletion must be impossible for active/unarchived rows, remove every SQLite row owned by the session in one transaction, and remove the session's raw-data directory beside the selected database (`{dirname(sssf.db)}/sessions/{adw_id}`, normally `adws/adw_data/sessions/{id}`). Preserve archive/restore and normal session inspection.

## Current-state findings

- `SessionsList.vue` already polls active and archived collections, and `SessionCard.vue` changes its Archive action to Restore in archived mode, but there is no destructive action.
- `server/index.ts` validates session IDs for archive and prompt-file routes; `SssfDb` derives `sessionsDir` from the target database's parent and lazily opens a writable connection only for archive changes.
- The seven-table schema stores session-owned rows in `sessions`, `phases`, `events`, `envelopes`, `gate_results`, `processes`, and `agent_sessions`. References do not declare `ON DELETE CASCADE`, SQLite foreign-key enforcement is not enabled, and existing target databases cannot gain cascade clauses through the additive column migrations. Therefore deletion must perform a compatibility-safe, application-level transactional cascade rather than merely deleting the parent row or rewriting the tracer schema.
- The visualizer and documentation still describe the service as read-only except for one archive write; those claims must be updated when permanent deletion is added.

## Implementation plan

### 1. Add one guarded backend deletion operation

**Files:**
- `.claude/skills/sssf/apps/visualizer/server/db.ts`
- `.claude/skills/sssf/apps/visualizer/server/index.ts`

1. Add a `SssfDb.deleteArchivedSession(adwId)` operation with a small explicit result contract (deleted, not found, or not archived). Reuse the lazy writer and its busy timeout.
2. Start a write transaction and re-read the target row inside it. Return not-found when no session exists and refuse the operation unless `archived = 1`; the archived predicate must be enforced in the persistence layer, not trusted from the current UI tab or a prior read.
3. Delete all rows for that `adw_id` in dependency-safe order: `events`, `envelopes`, and `gate_results` before `phases`, plus `processes` and `agent_sessions`, then the `sessions` parent. Keep these deletes and the archive check in one transaction so a SQL error rolls everything back and another session is never affected. Do not alter `templates/adws/adw_modules/tracer.py` or attempt a table-rebuild migration solely to add foreign-key cascade clauses; explicit deletion is required for already-created databases.
4. Include removal of the raw session directory in the same high-level operation. Resolve it only below `sessionsDir`, treating a missing directory as already cleaned. Use a staged rename/tombstone under that directory before committing the database transaction, restore the original name if the SQL transaction fails, and recursively remove the staged directory after commit. This keeps the requested path unavailable once deletion succeeds while providing a compensating rollback for failures before commit. Validate containment in depth even though the HTTP route also rejects unsafe IDs, and never follow an ID outside `sessionsDir`.
5. Add `DELETE /api/sessions/:adw_id`. Apply the existing plain-segment validation before invoking deletion; return 400 for an unsafe ID, 404 for an unknown session, 409 with a clear “archive before deleting” error for an active/unarchived session, and a 200 JSON acknowledgement for success. Let unexpected database/filesystem failures flow through `safely` as 500 responses. Update server/database comments that currently call archive the sole write.

### 2. Expose a confirmed archived-only delete action

**Files:**
- `.claude/skills/sssf/apps/visualizer/src/lib/api.ts`
- `.claude/skills/sssf/apps/visualizer/src/components/SessionsList.vue`
- `.claude/skills/sssf/apps/visualizer/src/components/SessionCard.vue`

1. Add a client `deleteSession(adwId)` wrapper that issues the encoded `DELETE` request and reports the API's error message/status on failure.
2. In `SessionCard`, keep Archive as the only action for active cards. For archived cards, render separate Restore and destructive Delete buttons in an action group. Both handlers must prevent the surrounding card link from navigating, have explicit titles/ARIA labels, preserve keyboard access, and visually distinguish Delete as irreversible. Emit a dedicated delete event rather than overloading archive/restore.
3. In `SessionsList`, handle deletion only while viewing Archived. Ask for explicit browser confirmation that names the session and says both trace/database data and files will be permanently removed. Track the pending session so repeated Delete/Restore clicks are disabled while the request runs.
4. On success, remove the row from `archivedSessions` immediately and trigger the existing non-overlapping refresh to reconcile counts. On rejection or failure, retain/refetch the card and surface the error through `actionError`; an API caller bypassing the UI must still be unable to delete an unarchived row.
5. Keep deletion off the detail view for this change: users inspect a run, return to Archived, and perform the deliberately scoped destructive action there. Do not add bulk deletion.

### 3. Document the new destructive boundary

**Files:**
- `.claude/skills/sssf/references/observability.md`
- `README.md`
- `.claude/skills/sssf/apps/visualizer/package.json`

1. Document the DELETE endpoint, archived-only invariant, status behavior, complete seven-table transactional cleanup, and removal of the database-sibling session directory. Clearly distinguish reversible Archive/Restore from irreversible Delete.
2. Explain that the visualizer normally reads/polls SQLite but now has two human-triggered mutation capabilities: archive state changes and permanent archived-session deletion. Remove stale “read-only”/“one write” claims from the reference, README, package description, and source comments.
3. Preserve the general files-as-raw-record/database-as-queryable-mirror model while noting that permanent deletion intentionally removes both representations for the selected archived session.

### 4. Add regression coverage and verify end to end

**Files:**
- `.claude/skills/sssf/apps/visualizer/server/db.test.ts`

1. Expand the temporary WAL fixture to include all seven schema tables and a sibling `sessions/` tree. Seed two sessions so tests can prove isolation.
2. Test successful deletion of an archived session containing rows in every dependent table and nested files: assert all seven table counts for that ID are zero, its directory is absent, and the other session's rows/files remain intact.
3. Test that an active session is rejected with no database or filesystem changes; also cover unknown IDs, a missing raw-data directory, and a legacy database without the optional archived column so none can bypass the archived-only invariant.
4. Exercise failure/rollback behavior where practical (for example, force a dependent SQL failure or filesystem staging failure) and assert no partial database cascade and no loss of the original session directory before commit.
5. From `.claude/skills/sssf/apps/visualizer`, run:
   - `bun test`
   - `bun run typecheck`
   - `bun run lint`
   - `bun run build`
6. Smoke-test against a temporary target database: active DELETE returns 409 and changes nothing; after archive, confirmation/DELETE removes the card, all SQLite rows, and the exact session directory; repeating DELETE returns 404; archive, restore, card navigation, polling, and deletion of a different archived session continue to work.

## Acceptance criteria

- Delete is visible only on archived cards and requires an explicit irreversible-action confirmation.
- The backend independently refuses every unarchived session, including direct API calls, without changing its rows or files.
- A successful delete removes the session row and all rows with its `adw_id` from phases, events, envelopes, gate results, processes, and agent sessions, without affecting other sessions.
- A successful delete removes `{dirname(sssf.db)}/sessions/{adw_id}` recursively; missing directories are harmless and unsafe IDs cannot escape the sessions root.
- SQL cleanup is transactional and normal failure paths do not leave a partially deleted session.
- Archive/restore, archived browsing, detail navigation, and list polling still work, and all automated checks pass.
