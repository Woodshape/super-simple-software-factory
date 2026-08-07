---
status: complete
---

# Show the target workspace in the visualizer header

## Goal

Make each visualizer instance identify the repository behind its selected `--db` at a glance. For a resolved database path shaped like `<repo>/adws/adw_data/sssf.db`, the browser should receive and render only `<repo>`'s basename (for example, `kios-mvp`), never the absolute database or repository path.

## Implementation plan

1. **Derive target metadata once from the selected database path.**
   - In `.agents/skills/sssf/apps/visualizer/server/db.ts`, add a small exported path helper that starts from the resolved database file, ascends from `adw_data` through `adws` to the owning repository directory, and returns that directory's `basename`.
   - Expose the result as a readonly `workspace` property on `SssfDb`, initialized alongside `path`/`sessionsDir`, so every API route uses the same deterministic value and no UI code has to infer filesystem layout.
   - Keep the derivation purely path-based and return only the final directory name; do not add repository discovery subprocesses, workspace configuration, or any absolute-path field.

2. **Make the health endpoint a privacy-safe workspace contract.**
   - In `.agents/skills/sssf/apps/visualizer/shared/types.ts`, replace the `db` path on `HealthResponse` with a required `workspace: string` field.
   - In `.agents/skills/sssf/apps/visualizer/server/app.ts`, return `db.workspace` from `/api/health` and stop serializing `db.path`. Preserve the existing readiness fields (`ok`, `journal_mode`, and `sessions`) so `server/dev.ts` readiness behavior remains unchanged.
   - The server may continue using the absolute path internally to open SQLite and locate session files; it must not place that path in the browser-facing response.

3. **Load and display the workspace in the persistent top header.**
   - In `.agents/skills/sssf/apps/visualizer/src/App.vue`, use the existing `fetchHealth()` client once when the root component mounts, store the returned workspace name in reactive state, and provide explicit non-path loading/unavailable text if the request has not completed or fails.
   - Add a dedicated workspace badge/identity block beside the SSSF brand and before the session breadcrumbs. Include a small `workspace` label and render the basename as the visually dominant value so it remains clear on the sessions list, session trace, and agent detail routes.
   - Extend the component's scoped header styles to distinguish the workspace value with stronger weight/color/surface treatment, constrain unusually long basenames without exposing any hidden path, and keep the workspace visible when the header is narrow (the long product brand or lower-priority breadcrumb content may yield before the workspace indicator). Keep the existing live indicator and sticky-header behavior.

4. **Lock down derivation and non-disclosure with tests.**
   - In `.agents/skills/sssf/apps/visualizer/server/db.test.ts`, add focused coverage for the workspace helper using conventional nested database paths, including the requested `kios-mvp/adws/adw_data/sssf.db -> kios-mvp` example and independence from higher parent directories.
   - In `.agents/skills/sssf/apps/visualizer/server/app.test.ts`, shape the route fixture like a named target repository and assert `/api/health` returns that basename with the existing health fields. Assert the response has no `db` field and does not contain the fixture's absolute directory/database path.
   - Rely on the shared response type plus Vue typecheck/build to cover the client binding; do not add a browser test framework or new dependencies solely for this static root-header integration.

5. **Document the public metadata boundary.**
   - In `.agents/skills/sssf/references/observability.md`, update the visualizer lifecycle/health description to state that `/api/health` identifies the target using only the repository basename and does not expose the selected database's absolute path.

## Verification

Run from `.agents/skills/sssf/apps/visualizer`:

1. `bun test`
2. `bun run typecheck`
3. `bun run lint`
4. `bun run build`

Then start the visualizer against a fixture or real target, request `/api/health`, and confirm it contains `"workspace":"kios-mvp"` (or the selected target's basename) with no absolute path. Open the sessions, session-detail, and agent-detail routes at wide and narrow viewport widths and confirm the same workspace badge stays prominent in the sticky header without displacing the live indicator or breaking breadcrumbs.

## Non-goals

Do not add workspace switching, multiple-database aggregation, editable/custom labels, or any API/UI affordance that reveals an absolute repository or database path.
