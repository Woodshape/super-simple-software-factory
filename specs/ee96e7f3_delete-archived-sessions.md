---
status: complete
---

# Plan: permanently delete archived visualizer sessions

## Objective

Add an explicit, irreversible delete action to the visualizer's Archived collection. The backend must independently enforce that only rows with `sessions.archived = 1` can be deleted, remove every SQLite row owned by the selected `adw_id`, and recursively remove the database-sibling `sessions/{adw_id}` directory (normally `adws/adw_data/sessions/{id}`). Archive/restore, session inspection, and polling must continue to work.

## Current-state findings

- `.claude/skills/sssf/apps/visualizer/src/components/SessionsList.vue` polls active and archived lists, and `SessionCard.vue` switches its single Archive button to Restore for archived cards. There is no destructive action or pending-action state.
- `server/index.ts` already validates path-segment IDs for archive and prompt-file routes. The existing `GET /api/sessions/:adw_id` occupies the route that should also handle DELETE, so it must become a method map rather than adding a duplicate route key.
- `SssfDb` derives `sessionsDir` from the selected database's parent and lazily opens a writable connection for archive changes.
- The schema has seven session-owned tables: `sessions`, `phases`, `events`, `envelopes`, `gate_results`, `processes`, and `agent_sessions`. Their references have no `ON DELETE CASCADE`, foreign-key enforcement is not enabled, and additive migrations cannot retrofit cascade clauses into existing databases. Deletion therefore needs an explicit, transactional application-level cascade for compatibility with already-created databases.
- The visualizer's comments and docs still characterize it as read-only or as having only the archive write; those descriptions become inaccurate once deletion is supported.

## Implementation plan

### 1. Add a guarded transactional deletion operation

**File:** `.claude/skills/sssf/apps/visualizer/server/db.ts`

1. Add `SssfDb.deleteArchivedSession(adwId)` with a small explicit outcome contract such as `deleted`, `not_found`, and `not_archived`. Reuse the existing lazy writable connection and busy timeout, updating names/comments that currently say it exists only for archive writes.
2. Validate/resolve the raw-data target as exactly a child of `sessionsDir`, even though the HTTP layer also validates IDs. Never permit a direct method call to resolve outside the sessions root.
3. In a write transaction, re-read the session and its `archived` value. Return not-found if the parent row does not exist, and refuse deletion unless the stored value is exactly archived. A legacy database with no `archived` column must also be refused rather than treated as deletable. Do not trust the UI's current tab or a stale pre-transaction read.
4. Explicitly delete rows for only that `adw_id` in dependency-safe order: `events`, `envelopes`, and `gate_results` before `phases`; also delete `processes` and `agent_sessions`; then delete the `sessions` parent. Keep the archive check and all SQL deletes in one transaction so a statement failure rolls back the complete cascade. Do not rely on changing `tracer.py` to add foreign-key cascades, since that would not fix existing databases.
5. Coordinate the raw directory with the SQL transaction using a same-parent tombstone/staging rename: treat a missing `{sessionsDir}/{adwId}` as already clean, rename an existing directory before committing the SQL deletion, restore its original name if staging or SQL/commit fails, and recursively remove the staged path after commit. This prevents the requested path from remaining visible after a successful delete and gives pre-commit failures a compensating filesystem rollback. Do not report success until post-commit cleanup has been attempted.
6. Preserve isolation: no query or filesystem operation may affect another session, including similarly prefixed IDs.

### 2. Expose an archived-only DELETE endpoint

**File:** `.claude/skills/sssf/apps/visualizer/server/index.ts`

1. Refactor `/api/sessions/:adw_id` from its current catch-all handler into a Bun method map that preserves the existing GET detail behavior and adds `DELETE` on the same path.
2. Validate the decoded ID with the existing safe-segment rule before calling the database operation. Map outcomes to stable responses: 200 JSON acknowledgement for deletion, 404 for an unknown session, 409 with a clear "archive before deleting"/unsupported-legacy message when the row is not archived, and 400 for an unsafe ID. Unexpected SQLite or filesystem failures should continue through `safely` as 500 responses.
3. Update the server header and route comments so they describe both human-triggered mutations—archive/restore and permanent archived-session deletion—without implying there is still only one write.

### 3. Add the confirmed destructive action to Archived cards

**Files:**
- `.claude/skills/sssf/apps/visualizer/src/lib/api.ts`
- `.claude/skills/sssf/apps/visualizer/src/components/SessionsList.vue`
- `.claude/skills/sssf/apps/visualizer/src/components/SessionCard.vue`

1. Add a `deleteSession(adwId)` API wrapper that sends an encoded `DELETE /api/sessions/:adw_id`. Parse the API error payload when possible so a backend refusal is understandable instead of exposing only a status number.
2. Keep active cards unchanged with only Archive. On archived cards, render Restore and a visually destructive Delete button in an action group. Emit a dedicated delete event; do not overload the archive/restore event. Both buttons must prevent the surrounding card link from navigating, remain keyboard-accessible, include explicit titles/ARIA labels, and support a disabled/busy state.
3. In `SessionsList`, accept deletion only for a session currently present in the archived collection. Before calling the API, show an explicit browser confirmation naming the session and warning that both trace/database records and files are permanently removed.
4. Track the session whose mutation is pending and disable repeat Restore/Delete actions for it. On success, remove it immediately from `archivedSessions` and trigger the existing non-overlapping refresh so tab counts and server state reconcile. On refusal/failure, retain or refetch the card and display the error through `actionError`.
5. Keep the action scoped to individual cards in the Archived tab; do not add deletion to active cards, the detail view, or a bulk-delete flow.

### 4. Update documentation and stale read-only descriptions

**Files:**
- `.claude/skills/sssf/references/observability.md`
- `README.md`
- `.claude/skills/sssf/apps/visualizer/package.json`
- `.claude/skills/sssf/apps/visualizer/shared/types.ts`
- comments in the backend files changed above

1. Document the DELETE endpoint, the server-side archived-only invariant, response behavior, all seven deleted table projections, and recursive removal of `{dirname(sssf.db)}/sessions/{adw_id}`. Clearly distinguish reversible Archive/Restore from irreversible Delete.
2. Replace claims that the visualizer is wholly read-only or has exactly one write with the narrower truth: normal observation is readonly/polled, while archive state and confirmed deletion are human-triggered mutations.
3. Preserve the files-as-raw-record/database-as-queryable-mirror explanation, but state that permanent deletion intentionally removes both representations for the selected archived run. Adjust the package description and shared-types header accordingly.

### 5. Add regression coverage and verify end to end

**File:** `.claude/skills/sssf/apps/visualizer/server/db.test.ts`

1. Expand the temporary WAL fixture to define all seven production tables and create sibling `sessions/` directory trees. Seed at least two sessions so every test can prove session isolation.
2. Test successful deletion of an archived session with rows in every dependent table and nested files. Assert that all seven tables contain no rows for that ID, its exact directory is absent, and the control session's rows/files remain unchanged.
3. Test that an unarchived session is refused with no database or filesystem changes. Also cover an unknown ID, a missing raw-data directory, and a legacy database without the optional `archived` column so none can bypass the archived-only rule.
4. Exercise rollback by forcing a dependent SQL delete to fail (for example with a temporary trigger) after earlier child deletes/staging have begun. Assert that every row remains and the original session directory is restored, proving there is no partial cascade on pre-commit failure.
5. From `.claude/skills/sssf/apps/visualizer`, run:
   - `bun test`
   - `bun run typecheck`
   - `bun run lint`
   - `bun run build`
6. Smoke-test against a disposable target database and session tree: an active DELETE returns 409 and changes nothing; after archive, the UI confirmation/DELETE removes the archived card, every SQLite projection, and the exact session directory; repeating DELETE returns 404. Also verify archive, restore, card navigation, detail loading, and periodic polling still behave normally.

## Acceptance criteria

- Delete appears only on archived session cards and requires an explicit irreversible-action confirmation.
- The backend refuses unarchived, legacy-without-archive-state, unknown, and unsafe IDs without deleting rows or files; direct API calls cannot bypass the invariant.
- Successful deletion removes the session plus its rows from `phases`, `events`, `envelopes`, `gate_results`, `processes`, and `agent_sessions`, while leaving every other session untouched.
- Successful deletion recursively removes `{dirname(sssf.db)}/sessions/{adw_id}`; a missing directory is harmless, and path traversal cannot escape the sessions root.
- SQL cleanup is transactional, and failures before commit restore both database state and the original raw-data path.
- Archive/restore, archived browsing, detail navigation, and polling remain functional, and all visualizer test/typecheck/lint/build commands pass.
