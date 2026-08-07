# Visualizer workspace header identity

## What changed

The visualizer now identifies the repository that owns the selected database in its persistent top header. For the canonical `<repo>/adws/adw_data/sssf.db` layout, the server derives the repository basename from the resolved database path; `/root/claude/kios-mvp/adws/adw_data/sssf.db` therefore produces `kios-mvp`. Only that basename is exposed to the browser, so the health response no longer serializes the absolute database path.

The header fetches `/api/health` once when the root component mounts and shows a dedicated `workspace` badge beside the SSSF brand and before session breadcrumbs. It shows `loading…` while the request is pending and `unavailable` on an empty or failed response. The badge gives the workspace name stronger color/weight, ellipsizes long names, and remains visible at narrow widths while lower-priority brand/breadcrumb content yields; the live indicator remains in place.

## Where it lives

- `.agents/skills/sssf/apps/visualizer/server/db.ts` adds `workspaceNameFromDbPath()` and stores its result as `SssfDb.workspace`.
- `.agents/skills/sssf/apps/visualizer/server/app.ts` returns `workspace` from `/api/health` and removes `db`; `.agents/skills/sssf/apps/visualizer/shared/types.ts` updates `HealthResponse` to the same privacy-safe contract.
- `.agents/skills/sssf/apps/visualizer/src/App.vue` loads and renders the workspace identity and contains the responsive header styles.
- `.agents/skills/sssf/apps/visualizer/server/db.test.ts` covers canonical-path derivation and normalization; `.agents/skills/sssf/apps/visualizer/server/app.test.ts` checks the health payload, absence of `db`, and non-disclosure of the fixture's absolute path.
- `.agents/skills/sssf/references/observability.md` records the public metadata boundary, and `specs/970f8f54_workspace-header-name.md` records the completed implementation and verification plan.

## Use and verification

From `.agents/skills/sssf/apps/visualizer`, run:

```sh
bun test
bun run typecheck
bun run lint
bun run build
```

For an API-level check, start the visualizer with its selected `--db`, request `/api/health`, and confirm the response contains the target repository basename in `workspace` (for example, `"workspace":"kios-mvp"`) alongside `ok`, `journal_mode`, and `sessions`, with no `db` field or absolute database/repository path. Open the sessions, session-detail, and agent-detail routes at wide and narrow widths to verify the same workspace badge remains prominent in the sticky header.
