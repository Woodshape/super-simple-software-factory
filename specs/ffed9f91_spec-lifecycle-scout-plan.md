---
status: complete
---

# Plan: durable spec lifecycle and scout-then-plan workflow

## Objective

Deliver two related factory improvements:

1. Make every durable `specs/*.md` plan carry an explicit, validated delivery lifecycle that an engineer can inspect with `just specs`, without deriving implementation state from an agent envelope, phase, session, Git commit, or filename.
2. Add a thin, frequently used `request -> scout -> planner` workflow, exposed as `just scout-plan`, that passes `ScoutOutput` to `PlanOutput` and stops after producing the plan.

The tracked `specs/*.md` file is the authoritative durable record. A session's `context_handoff/plan.md` is its live mirror while that session exists. Both copies must be byte-identical when the planner creates them, and ADW-owned transitions must update both together.

## Fixed v1 lifecycle contract

Use exactly this enum, with no aliases:

- `planned`: a valid plan exists, but implementation has not started.
- `in_progress`: implementation has been explicitly started; this includes failed or interrupted attempts and work awaiting verification.
- `complete`: the implementation passed the workflow's declared acceptance evidence, or an engineer explicitly accepted equivalent external evidence.

The only ordinary transitions are:

```text
new spec -> planned -> in_progress -> complete
```

Rules:

- Creation at `planned` is not an inferred transition; it is the planner's required output contract.
- `planned -> in_progress` happens immediately before the first builder call, not when a plan-only workflow succeeds.
- `in_progress -> complete` happens only in an explicit acceptance branch after its evidence is green. It is never driven by `EnvelopeBase.status`, phase/session status, `run.finish()`, a commit's existence, or an `adw_id` match.
- Direct `planned -> complete`, backward transitions, same-state/idempotent writes, and writes from `complete` are errors. Reopening/abandoning work is out of scope for v1.
- A failed/interrupted implementation remains `in_progress`; a successful `adw_plan`, `adw_scout_plan`, or unverified `adw_plan_build` must not become `complete`.
- Missing, malformed, duplicate, non-scalar, or unknown metadata is an error reported as such; `unknown` is not added to the enum and is never silently mapped to `planned` or `in_progress`.

Every durable spec starts with exactly one frontmatter mapping containing only `status`, for example:

```yaml
---
status: planned
---
```

Do not add `adw_id`, dates, owner, schema version, evidence, or other metadata. The filename and Git history already carry the information v1 needs.

## Implementation plan

### 1. Add one deterministic spec metadata module and one discoverability interface

**Source and stamped files:**

- `.claude/skills/sssf/templates/adws/adw_modules/specs.py` (new)
- `adws/adw_modules/specs.py` (new, byte-for-byte stamped copy)
- `.claude/skills/sssf/templates/adws/adw_modules/gates.py`
- `adws/adw_modules/gates.py`
- `.claude/skills/sssf/templates/justfile`
- `justfile`

Implement `adw_modules/specs.py` as the single deep module for parsing, locating, listing, and writing lifecycle state. Give it a small callable interface usable by gates and ADWs, plus a `__main__` CLI used by the justfile. It may use PyYAML, already present in every ADW's script dependencies; if the module is directly executable, give its CLI a PEP 723 dependency header so `just specs` works in a clean stamped repository.

Parser/validator behavior:

1. Require the first line to be `---` and a later standalone `---` to close the initial block. Do not scan for frontmatter later in the Markdown.
2. Parse the block deterministically with PyYAML's composed node tree rather than `safe_load`'s last-key-wins mapping. Require one mapping node with exactly one scalar key named `status`, exactly once, and one scalar string value in `planned`, `in_progress`, or `complete`. Reject aliases, duplicate keys, lists/maps as values, empty blocks, extra keys, and unknown values.
3. Preserve the Markdown after the closing delimiter byte-for-byte when changing status. Write a canonical three-line frontmatter block, use a sibling temporary file plus `os.replace`, and pre-validate all target/mirror files before writing. If a mirrored write fails, restore every already-written file from its captured original bytes before raising.
4. Resolve planner artifacts against `run.repo_root`; require exactly one artifact equal to `run.context_handoff_dir / "plan.md"` and exactly one direct Markdown child of `<repo_root>/specs/` whose name begins with `<adw_id>_`. Reject missing, duplicate, outside-repo, nested, or ambiguous spec artifacts rather than choosing one.
5. Treat the tracked `specs/` path as authoritative. At creation, require it and `context_handoff/plan.md` to have `planned` status and identical bytes. ADW transitions use the resolved pair as one mirrored operation. The CLI can transition an explicit durable path and optional explicit mirror paths; it must never guess a spec from a session id.
6. Expose only the legal next-state operation. The caller supplies the target; the module parses the current state and rejects any edge outside `planned -> in_progress -> complete`.

Add a `gates.plan_spec_valid` gate in `gates.py`. It must report separate checks for the expected two artifacts, safe/unique path resolution, valid `planned` frontmatter on both, and byte equality. Keep the existing generic existence/non-empty gates; this new gate validates the planner-specific contract and returns ordinary `GateReport` violations so the same planner session can correct bad output.

Add a recipe to both justfiles, near the workflow/observation recipes:

```just
# list durable specs, or make an explicit legal transition: just specs [transition STATUS PATH ...]
specs *ARGS:
    uv run adws/adw_modules/specs.py "$@"
```

The CLI contract is:

- no arguments (the normal `just specs`) lists direct `specs/*.md` in stable path order as `<status>\t<path>`;
- `transition <target-status> <authoritative-path> [mirror-path ...]` performs exactly one legal edge after validating all supplied copies;
- listing continues across invalid files, prints `ERROR\t<path>\t<reason>` for each invalid file, and exits nonzero if any error occurred. It never emits a guessed lifecycle value.

This command is also the engineer-owned transition path for a standalone build workflow that has no `PlanOutput` in memory. The engineer explicitly runs `just specs transition in_progress specs/<file>.md` before such a build and `... complete ...` only after checking the spec's acceptance evidence. No workflow may infer the target by looking for matching `adw_id` filenames.

### 2. Make the planner own creation and make existing plan/build workflows own explicit transitions

**Planner prompt source/stamped pair:**

- `.claude/skills/sssf/templates/prompt_engineering/planner/user.md`
- `adws/adw_data/prompt_engineering/planner/user.md`

Update the planner task to require canonical `status: planned` frontmatter as the first bytes of `context_handoff/plan.md`, then preserve it by using the existing one-call `cp` into the unique `specs/` path. State that both files must be identical and that plan-only success leaves them `planned`. Do not change `PlanOutput`; its existing two `artifacts` paths are sufficient.

Add `gates.plan_spec_valid` after `artifacts_exist` and `files_non_empty` at every source and stamped `PlanOutput` call site:

- `.claude/skills/sssf/templates/adws/adw_plan.py` and `adws/adw_plan.py`
- `.claude/skills/sssf/templates/adws/adw_plan_build.py` and `adws/adw_plan_build.py`
- `.claude/skills/sssf/templates/adws/adw_plan_build_test.py` and `adws/adw_plan_build_test.py`
- `.claude/skills/sssf/templates/adws/adw_plan_build_test_quality.py` and `adws/adw_plan_build_test_quality.py`
- `.claude/skills/sssf/templates/adws/adw_simple_sdlc.py` and `adws/adw_simple_sdlc.py`
- the new `adw_scout_plan.py` pair from step 4

Use visible `kind="code"`, `owner="specs"` phases that call the shared module; do not bury writes in an agent phase:

- In `adw_plan_build.py`, `adw_plan_build_test.py`, and `adw_plan_build_test_quality.py`, add `spec_start` after planning and immediately before `build`; transition both plan artifacts from `planned` to `in_progress` and log the durable path and resulting status.
- In `adw_simple_sdlc.py`, keep `commit_plan` first, then add the same `spec_start` before `build`, so a failed build leaves the already-recorded spec visibly `in_progress`.
- In `adw_plan_build_test.py`, add `spec_complete` only inside the existing `test.passed` branch and before its final commit. The green test predicate is the explicit acceptance evidence; a merely successful phase/session is not consulted.
- In `adw_plan_build_test_quality.py`, add `spec_complete` only inside the existing `verified` branch after every configured quality/test check passes and before commit.
- In `adw_simple_sdlc.py`, add `spec_complete` only inside the existing `verified` branch (`test.passed and review.approved`) and before `commit_build`. Later documentation failure must not undo an already accepted implementation.
- Do not add `spec_complete` to `adw_plan_build.py`: its builder/diff gate and successful commit do not verify the plan's acceptance criteria, so it intentionally ends `in_progress` until an engineer explicitly accepts evidence.
- Do not add transitions to plan-only workflows. Build-only workflows have no unambiguous `PlanOutput`; document use of the explicit CLI instead of guessing by session id.

The acceptance predicates and lifecycle writes may be adjacent, but lifecycle state must not be computed by querying persisted phase/session/envelope status. This keeps a run's operational outcome independent from the durable implementation verdict.

### 3. Migrate existing specs only after verifying their actual evidence

**Files:**

- `specs/b34b429b_observability-ui-hardening.md`
- `specs/ee96e7f3_delete-archived-sessions.md`
- `specs/ffed9f91_spec-lifecycle-scout-plan.md` (this plan; initially already valid)
- `adws/adw_data/sessions/ffed9f91/context_handoff/plan.md` (live mirror of this plan)

Do not assign status from commit/session names alone. Perform and record the following bootstrap checks before adding frontmatter to the two legacy files:

1. **Observability hardening candidate for `complete`:**
   - Confirm `git show --stat --oneline 2f24b8b` contains the spec and the implementation/test/docs files named by it; this correlation is necessary but not sufficient.
   - From `.claude/skills/sssf/apps/visualizer`, run `bun install --frozen-lockfile`, `bun test`, `bun run typecheck`, `bun run lint`, and `bun run build`, judging each by exit status.
   - Re-run the original acceptance smoke evidence against a disposable database: active/archived list and restore behavior, bounded list timeline with lossless detail paging, loopback-only 4600/4601 startup, occupied-port failures, API-health-before-UI startup, and cleanup after `SIGINT`, `SIGTERM`, and either child exiting. Confirm source/stamped justfile behavior remains correct.
   - Only if all required evidence passes, prepend `status: complete`. If any evidence fails, do not guess another state or make the validator green cosmetically; fix/accept the outstanding work before migration.
2. **Archived-session deletion candidate for `planned`:**
   - Confirm `git show --name-only --format= d558086 c4c866c` names only `specs/ee96e7f3_delete-archived-sessions.md`.
   - Confirm the current visualizer has no `deleteArchivedSession`, client delete call/action, or DELETE route and that the deletion acceptance tests described in the spec do not exist.
   - Only after that negative implementation evidence is checked, prepend `status: planned`. Do not implement deletion as part of this work.

The migration is a one-time bootstrap exception because the files predate the parser. Once frontmatter exists, all later writes must go through `adw_modules/specs.py`. A test must pin the two migrated values (`b34... == complete`, `ee... == planned`) and validate every direct `specs/*.md` file.

This plan and its handoff copy begin `planned` as required. Once the new writer exists and implementation actually starts, use it to move both explicit paths together to `in_progress`; move them to `complete` only after every acceptance item in this plan passes. Do not edit their state independently while the live mirror exists.

### 4. Add the thin scout-then-plan workflow and recipe

**New source/stamped workflow:**

- `.claude/skills/sssf/templates/adws/adw_scout_plan.py`
- `adws/adw_scout_plan.py`

Model it directly on `adw_scout.py`, `adw_plan.py`, and the existing `previous=` chaining pattern:

- Declare `REQUIRED_AGENTS = ["scout", "planner"]`; validate before creating phases.
- Open `request` first with owner `run.engineer`.
- In `scout`, call the existing scout with `output_type=ScoutOutput`, the engineer prompt, and `gates.artifacts_exist`; retain the result as `found`.
- In `plan`, call the existing planner with `output_type=PlanOutput`, the same prompt, `previous=found`, and `gates.artifacts_exist`, `gates.files_non_empty`, and `gates.plan_spec_valid`.
- End with `run.finish()` after `request`, `scout`, and `plan`. There is no builder, test/quality, review, documenter, Git, lifecycle transition, or commit phase. A green run means recon and planned artifacts were produced; the spec remains `planned`.
- Use the same argparse/config/`--adw-id` interface as other starter scripts and meaningful phase descriptions. Do not add a new agent, prompt pair, config entry, data/output type, or low-level chaining abstraction.

Add this recipe immediately between `scout` and `plan` in both justfiles:

```just
# scout then plan, without implementing: just scout-plan "..."
scout-plan *ARGS:
    uv run adws/adw_scout_plan.py --config {{config}} "$@"
```

Do not add it to `demo`; the demo intentionally remains two cheap read-only calls, while the planner writes a durable spec.

### 5. Preserve the single installer path and update catalog/routing documentation

**Installer behavior and docs:**

- `.claude/skills/sssf/scripts/install.py`
- `README.md`
- `.claude/skills/sssf/SKILL.md`
- `.claude/skills/sssf/cookbooks/sssf_overview.md`
- `.claude/skills/sssf/cookbooks/how_to_prompt_for_the_eng.md`
- `.claude/skills/sssf/cookbooks/run_adw.md`
- `.claude/skills/sssf/cookbooks/create_adw.md`
- `.claude/skills/sssf/cookbooks/install.md`
- `.claude/skills/sssf/references/handoff.md`

Do not change the installer algorithm or add another copy list. The existing recursive `templates/adws -> adws` stamp automatically includes `adw_scout_plan.py` and `adw_modules/specs.py`; the existing justfile and prompt-template stamps cover their other source files. A normal rerun installs a destination file that is absent and skips an existing one; `--force` refreshes existing stamped copies and retains its existing warning that user-owned config/prompts/justfile are overwritten. Update the install script's stale descriptive agent count from four to five while touching its documentation only.

Documentation changes:

- Change the starter workflow count from twelve to thirteen in every README/install/layout occurrence and add `adw_scout_plan | engineer -> scout -> planner | repository-informed plan, no implementation` to the workflow table.
- Add `adw_scout_plan.py` to the stamped layout and startup menu in `SKILL.md`/`sssf_overview.md`.
- In `how_to_prompt_for_the_eng.md`, route “needs repository recon before a plan, but no code” to this single chain rather than two separate runs.
- In `run_adw.md`, show `just scout-plan "..."`, its exact three phases, and explicitly state that green operational status means its artifacts exist—not that the planned implementation is complete. Keep the `adw_id` for a later build handoff.
- In `create_adw.md`, correct “starter six” to the five actual agents and document this existing scout-to-planner shape, typed outputs, `previous=found`, and gates; emphasize that it requires no new roster entry.
- In `install.md`, explain the thirteenth workflow and the absent-file/skip/`--force` behavior for newly added templates.
- In `references/handoff.md`, define the frontmatter enum, tracked-authority/live-mirror rule, transition owners, and the difference between spec lifecycle and `EnvelopeBase.status`, phase/session status, or reviewer `approved`.
- In README/overview/skill hard rules, advertise `just specs`, state that malformed legacy files are errors, and explain that code phases/explicit engineer action—not run status—write transitions.

Keep source and stamped copies synchronized in this repository. The source templates remain the installer authority; the top-level `adws/`, prompt, and `justfile` copies are this repository's installed example, not a second installer mechanism.

### 6. Add source-side lifecycle, workflow, parity, and installer tests

**Tests:**

- `.claude/skills/sssf/tests/test_specs.py` (new)
- `.claude/skills/sssf/tests/test_scout_plan.py` (new)
- `.claude/skills/sssf/tests/test_install.py` (new)

Use the repository's existing `unittest` style and subprocess exit statuses.

`test_specs.py` must cover:

- all three canonical values parse;
- missing/not-first/unclosed frontmatter, duplicate `status`, non-mapping blocks, non-scalar values, extra keys, aliases, and unknown values raise precise metadata errors;
- listing is path-sorted, prints valid entries and every error, and exits nonzero without assigning an enum to invalid files;
- only `planned -> in_progress` and `in_progress -> complete` succeed; same-state, direct skip, backward, and terminal writes fail;
- transitions preserve the Markdown body, update explicit mirrors identically, and roll back already-written copies on a simulated mirror write failure;
- planner artifact resolution rejects zero/multiple specs, wrong handoff names, nested/outside paths, wrong `adw_id`, non-identical copies, and any creation status other than `planned`;
- `gates.plan_spec_valid` reports useful failed checks and passes a canonical two-copy fixture;
- every direct repository `specs/*.md` parses, with `b34...` pinned to `complete` and `ee...` pinned to `planned` after evidence-backed migration.

`test_scout_plan.py` must use AST or similarly structural assertions to verify the source template has exactly `REQUIRED_AGENTS == ["scout", "planner"]`, phase order `request`, `scout`, `plan`, first output `ScoutOutput`, second output `PlanOutput`, `previous=found`, the required gates, and no builder/output, quality, review, document, Git, lifecycle-transition, or commit phase. Also assert byte parity for:

- new source/stamped `adw_scout_plan.py`;
- new source/stamped `adw_modules/specs.py`;
- modified source/stamped `gates.py`, planner prompt, justfile, and all modified plan-containing ADWs.

Parse both justfiles with `just --list`; assert `scout-plan` and `specs` are visible. Use `just --dry-run scout-plan "request"` to assert the command routes to `adws/adw_scout_plan.py` with `--config`, and dry-run `specs` to assert it routes only to the shared status CLI.

`test_install.py` must run the one existing installer in a temporary target and assert:

1. a clean install stamps `adws/adw_scout_plan.py`, `adws/adw_modules/specs.py`, the planner prompt, and recipes;
2. changing an installed new file then rerunning without `--force` preserves it;
3. deleting that destination then rerunning without `--force` restores it from the template (new absent files are installed even when other files are skipped);
4. changing it again then running with `--force` restores exact template bytes;
5. the stamped justfile parses and the new source/stamped files are byte-identical after force.

Run the complete static suite with:

```bash
uv run --with pyyaml python -m unittest discover -s .claude/skills/sssf/tests -p 'test_*.py'
just --list
just --dry-run scout-plan "map auth before planning"
just specs
```

Judge every command by exit status.

### 7. Perform one live end-to-end verification

Use a disposable Git repository installed from this skill, not this repository's working tree. Commit the installed baseline, provide the normal live roster credentials through the environment, then run:

```bash
just scout-plan "Inspect this disposable repository and plan a harmless documentation-only change; do not implement it."
```

Capture the printed `adw_id` and verify:

- the process exits zero;
- SQLite phase rows for that id are exactly `request`, `scout`, `plan`, in that order, all successful;
- the scout artifact exists and the saved planner prompt contains the serialized `ScoutOutput` as `previous_envelope`;
- `PlanOutput.artifacts` names exactly the non-empty handoff plan and one durable spec;
- both plan files begin with `status: planned` and are byte-identical;
- `just specs` reports the durable file as `planned`;
- after the baseline commit, Git shows only the newly planned durable spec as a repository work product (runtime session/database files remain ignored), with no application implementation or commit created by the workflow.

This live run is required acceptance evidence, not a unit test that should make ordinary CI depend on model credentials.

## Acceptance criteria

- Every direct durable spec has valid first-block frontmatter with exactly one status from `planned`, `in_progress`, `complete`; malformed or legacy files are shown as `ERROR` and cause `just specs` to exit nonzero.
- `just specs` gives a deterministic, path-sorted lifecycle inventory, and its explicit transition command enforces only `planned -> in_progress -> complete` without guessing paths or states.
- Planner-created handoff/durable copies start `planned`, are byte-identical, and are rejected by a deterministic gate if the contract is wrong.
- Standard plan/build workflows visibly set `in_progress` before builder work; only the explicit green acceptance branches named above set `complete`. Plan-only and scout-plan runs remain `planned`, and unverified plan-build remains `in_progress` even if its session succeeds.
- The observability hardening spec is marked `complete` only after its original automated and smoke acceptance evidence passes; the archived-session deletion spec is marked `planned` only after its plan-only/no-implementation evidence is verified.
- `just scout-plan` runs exactly engineer request, scout, and planner; planner receives `previous=found`; there is no builder, test, review, documenter, lifecycle transition, Git, or commit phase.
- Source templates and this repository's stamped copies are byte-identical for every paired file changed by this work. A normal installer rerun adds missing new files without overwriting existing files, while `--force` refreshes them through the existing single installer path.
- Workflow catalog/routing/install/handoff documentation consistently reports thirteen workflows, advertises `just scout-plan` and `just specs`, and never equates operational run success with implementation completion.
- The new unit/static/parity/installer tests and justfile parse/dry-run checks pass, and the disposable live scout-plan verification produces a planned spec with no implementation changes.

## Explicit non-goals

- No lifecycle database table, visualizer feature, session-to-spec inference, Git-history inference, or filename-encoded status.
- No `unknown`, `abandoned`, `blocked`, `superseded`, or reopen transition in the enum; invalid metadata remains an error outside the enum.
- No extra frontmatter fields, new `PlanOutput` field, new output type, new agent, new prompt pair, or config entry.
- No second installer/copy path and no change to the installer's skip/force algorithm.
- No builder, tests, reviewer, documenter, commit, or application-code mutation in `adw_scout_plan`.
- No implementation of the archived-session deletion plan and no unrelated visualizer or ADW refactor.
