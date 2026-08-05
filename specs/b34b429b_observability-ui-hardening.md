# Plan: harden and scale the observability UI

## Objective

Make the SSSF visualizer a loopback-only, fixed-port development service with one lifecycle owner; replace session-card event fan-out with a bounded server-side timeline projection while keeping the selected-session trace lossless and live; and make archived runs discoverable, viewable, and restorable. Keep the tracer/ADW schema unchanged and preserve the existing `install.py` behavior that stamps the template justfile into target repositories.

## Current-state findings

- `.claude/skills/sssf/apps/visualizer/server/index.ts` supplies a port but no hostname to `Bun.serve`, only closes the database on `SIGINT`, and reports `localhost`; it can therefore listen beyond IPv4 loopback and does not handle the supervisor's normal `SIGTERM` cleanup path.
- `.claude/skills/sssf/apps/visualizer/vite.config.ts` fixes the nominal UI port but does not set `host` or `strictPort`; Vite may expose a non-loopback listener when invoked differently and will silently try a later port on collision.
- `.claude/skills/sssf/templates/justfile` backgrounds the API in a subshell and then runs Vite in the foreground. It neither waits for `/api/health` nor owns/reaps both processes, so startup races, orphaned API processes, and silent Vite port changes are possible.
- `SessionsList.vue` refreshes every 500 ms, while every `SessionCard.vue` independently downloads its complete event history and then polls a live run every 500 ms. The list is therefore one summary request plus one event stream per card, and old high-volume runs load unbounded event payloads just to draw small dots.
- The database already has the `sessions.archived` review flag and a write endpoint can set it, but `SssfDb.sessions()` hard-filters archived rows and the client has no archived view or restore control. `session()` also omits the optional archived column from detail rows.
- The selected trace legitimately needs complete events for drill-down, but it currently keeps polling even after a historical session is complete and drains any number of event pages inside one interval callback.

## Implementation plan

### 1. Define a bounded session-list contract and explicit archive filter

**Files:**
- `.claude/skills/sssf/apps/visualizer/shared/types.ts`
- `.claude/skills/sssf/apps/visualizer/src/lib/types.ts`
- `.claude/skills/sssf/apps/visualizer/server/db.ts`
- `.claude/skills/sssf/apps/visualizer/server/index.ts`

1. Add a compact card-timeline type containing only what a card renders (row/event identity, session/phase attribution, event type/name, and timestamp; no payload JSON, token data, end time, envelopes, or gates). Add a bounded, chronologically ordered timeline array to `SessionSummary`; include an original marker count or truncation flag so the contract does not imply that a sampled overview is a lossless event history.
2. Change the sessions query interface to accept an explicit active/archived selection rather than always applying `archived = 0`. Preserve compatibility with databases that predate the optional column: active mode still returns those rows, archived mode returns none, and archive writes retain their existing migration error. Ensure both list rows and `session(adwId)` select the optional `archived` value.
3. Populate card timeline markers in one batched database operation for the set of sessions already selected by the list query. Restrict it to the event types the card currently colors, enforce a named per-session cap, and use deterministic chronological sampling/bucketing that retains the beginning and newest activity instead of merely returning an arbitrary SQL limit. Keep the final markers ordered oldest-to-newest. The result must be bounded independent of a run's tool-call count and must not perform one network request per session; the selected-session `/events` endpoint remains the lossless source.
4. Extend `GET /api/sessions` with a documented, validated archive query (for example `archived=0|1`) and pass it through to the database module. Reject invalid values with a 400 rather than silently showing the wrong collection. Keep the existing list limit clamp.
5. Do not alter `templates/adws/adw_modules/tracer.py`, table definitions, migrations, event semantics, or indexes: this work is a read projection over the existing schema.

### 2. Make the visualizer processes fixed-port, loopback-only, and lifecycle-managed

**Files:**
- `.claude/skills/sssf/apps/visualizer/server/index.ts`
- `.claude/skills/sssf/apps/visualizer/server/dev.ts` (new lifecycle supervisor)
- `.claude/skills/sssf/apps/visualizer/vite.config.ts`
- `.claude/skills/sssf/apps/visualizer/package.json`
- `.claude/skills/sssf/templates/justfile`

1. Bind `Bun.serve` explicitly to `127.0.0.1` (with port reuse disabled/defaulted off) and update startup text to advertise `http://127.0.0.1:4600`. Add one idempotent shutdown routine that stops the Bun listener and closes both database connections on `SIGINT` and `SIGTERM`, avoiding double-close races.
2. Configure Vite with `host: "127.0.0.1"`, fixed port `4601`, and `strictPort: true`; point its proxy at `http://127.0.0.1:4600`. Thus standalone Vite and the managed recipe have the same exposure and collision behavior.
3. Add a small Bun supervisor as the single deep module behind `dev:all`:
   - use fixed API/UI ports 4600/4601 and reject a successful TCP connection to either before launch with a clear collision message;
   - spawn the API directly (no shell/background subshell), force its database path and API port, and wait for a successful `GET http://127.0.0.1:4600/api/health` with a finite deadline while also watching for early child exit;
   - only after API readiness, spawn the installed Vite executable directly with loopback/fixed/strict-port arguments (the config remains the second line of defense);
   - race both child exits; normal exit or failure of either child terminates and awaits the sibling, then propagates the initiating exit status;
   - handle `SIGINT` and `SIGTERM` with the same idempotent terminate-and-wait cleanup so no API, Vite, or wrapper process survives. Avoid shell process trees by spawning Bun entry points directly.
4. Replace the unsafe `dev:all` package script with the supervisor entry point. Keep `dev` and `server` useful for standalone development, now protected by the fixed host/port configuration.
5. Change only the stamped `.claude/skills/sssf/templates/justfile` `obs` recipe: run `bun install`, then invoke the supervisor with the absolute `{{justfile_directory()}}/{{db}}` path. Do not edit the repository's top-level example `justfile`; target repositories receive this behavior through `install.py`'s existing verbatim `copy2` stamp. Do not add a parallel install path or duplicate the lifecycle shell logic in the template.

### 3. Remove card-owned event polling and add archived browsing/restore

**Files:**
- `.claude/skills/sssf/apps/visualizer/src/lib/api.ts`
- `.claude/skills/sssf/apps/visualizer/src/components/SessionsList.vue`
- `.claude/skills/sssf/apps/visualizer/src/components/SessionCard.vue`
- `.claude/skills/sssf/apps/visualizer/src/components/SessionTrace.vue`
- `.claude/skills/sssf/apps/visualizer/src/style.css` only if shared tab/action styles are warranted

1. Let `fetchSessions` request active or archived rows explicitly and decode the new timeline fields defensively for older/development servers.
2. Make `SessionsList` the sole owner of list polling. Use one non-overlapping refresh at a modest live cadence, pass each summary's compact timeline to its card, and keep the existing current-time updates needed for running durations. There must be no per-card fetch, interval, cursor, or full event array.
3. Add visible Active and Archived controls with clear counts/empty states. Switching views fetches the selected collection. Active cards offer Archive; archived cards offer Restore and remain normal links to the existing detail route so archived runs can be inspected before restoration. On a successful write remove/move the card optimistically and refresh the relevant collection; on failure restore/refetch state and surface an error rather than losing the card silently. Keep both actions keyboard-visible and give them mode-specific labels/tooltips instead of using the same hidden “×”.
4. Refactor `SessionCard` to derive its per-agent dot rows from the bounded summary markers plus embedded phases/agents. Preserve agent attribution, event colors, chronological placement over the session's full start/end range, latest-live highlighting, fixed card geometry, and historical card timelines. When markers were aggregated/truncated, expose that fact in accessible text/title rather than suggesting every event is shown.
5. Keep `SessionTrace` lossless but bound each event request/page and its work per turn. Load additional history pages sequentially/immediately without overlapping polls, continue cursor polling only while the session is running or a backlog remains, perform a final metadata/event drain when status changes out of running, and then stop the interval for completed/history views. Continue refreshing envelopes/gates only when their triggering events arrive. The resulting detail and phase drill-down must eventually contain every event exactly once and still update live; only the list-card projection is sampled.

### 4. Document the operating and polling contracts

**Files:**
- `.claude/skills/sssf/references/observability.md`
- `.claude/skills/sssf/cookbooks/run_adw.md`
- `.claude/skills/sssf/cookbooks/install.md` if its stamped-recipe description needs the new guarantees

1. Document that `just obs` exposes API/UI only on `127.0.0.1:4600/4601`, both ports are fixed, collisions fail startup, API health is checked before Vite starts, and stopping or losing either process tears down both.
2. Update the polling section to distinguish the single bounded session-list snapshot (including sampled compact card markers) from the rowid-cursor, bounded-page, lossless selected-session event stream. Record archive filtering and the archive/restore write semantics.
3. Replace the unmanaged two-tmux-process suggestion in `run_adw.md` with `just obs` as the supported lifecycle-managed path. Keep headless SQLite recipes as the alternative and do not introduce authentication/remote-host guidance, which is out of scope.
4. Keep installation documentation accurate that the template justfile is stamped only when absent unless `--force`; no `install.py` behavior change is required.

### 5. Add focused regression coverage and run smoke checks

**Files:**
- `.claude/skills/sssf/apps/visualizer/server/db.test.ts` (new; or split a pure timeline sampler test if the implementation extracts one)
- `.claude/skills/sssf/apps/visualizer/package.json`
- `.claude/skills/sssf/apps/visualizer/bun.lock` only if Bun legitimately updates it

1. Add Bun tests using a temporary WAL SQLite fixture with the minimal visualizer tables. Cover:
   - active versus archived list filtering, legacy-no-archived behavior, archive then restore, and `archived` present in detail;
   - a high-event-count session returns at most the configured compact marker cap, in chronological order, with first/newest activity represented and no full payload fields;
   - multiple sessions are attributed correctly by the batched projection;
   - the existing detail event cursor still pages without gaps/duplicates and reports `has_more`/cursor correctly.
2. Add a `test` package script and run from `.claude/skills/sssf/apps/visualizer` after installing locked dependencies:
   - `bun test`
   - `bun run typecheck`
   - `bun run lint`
   - `bun run build`
3. Perform API/UI smoke checks against a temporary fixture database:
   - health and both UIs answer only through `127.0.0.1` on 4600/4601;
   - active and archived list calls return the right rows, detail opens an archived row, and POST archive/restore moves it both directions;
   - a live fixture/run adds card markers through the one list poll and adds every detail event through cursor pages; a completed detail stops polling after its final drain.
4. Exercise lifecycle failure paths, not only happy startup: occupy 4600 and then 4601 separately and confirm `just obs` exits nonzero without selecting another port or leaving its other child; start normally, terminate the recipe with `SIGINT` and `SIGTERM`, and verify neither API nor Vite PID/listener remains. Also stop one child directly and verify the supervisor reaps the other.
5. Validate template preservation in a temporary target directory by running `.claude/skills/sssf/scripts/install.py` (and `--force` for overwrite behavior), comparing the stamped `justfile` byte-for-byte with `.claude/skills/sssf/templates/justfile`, and parsing/listing the stamped recipe with `just`. Do not modify any real target repository during this check.

## Acceptance criteria

- API and Vite listen only on IPv4 loopback at 4600 and 4601; either occupied port causes a clear nonzero startup failure with no fallback port.
- `just obs` does not start Vite before API health succeeds and leaves no child or listener after normal child exit, startup failure, `SIGINT`, or `SIGTERM`.
- The sessions screen makes a constant number of requests per refresh rather than 1+N, and each card receives a compact bounded timeline rather than a complete event history.
- The selected live trace remains current and the historical/detail trace remains lossless, with bounded pages, no duplicate events, and no perpetual polling after completion.
- Archived sessions have a visible browse mode, can be opened normally, and can be restored to the active list; old databases continue to read safely.
- No tracer/ADW schema, authentication, remote-hosting support, or waterfall/detail redesign is introduced.
- Bun tests, visualizer typecheck, lint, build, lifecycle/port smoke checks, and install-template copy verification all pass.
