# Handoff Reference

The envelope schema, the two-channel output contract, and the session directory layout — how context transfers in code, not in conversation.

## Two output channels, exactly

An agent may produce output in two ways and no others:

1. **Reference files** written into `context_handoff/` — plans, notes, artifacts for the agents that follow.
2. **A final valid-JSON response** — the envelope, its direct response and nothing else.

Code does the rest: parse the response against the output type the call declared, persist it as `envelope.json`, and inject it into the next agent's user prompt.

## Envelope schema

Every output type extends `EnvelopeBase`:

```python
class EnvelopeBase(BaseModel):
    status: Literal["success", "fail"]  # the only required field
    summary: str = ""                   # one sentence: what happened
    artifacts: list[str] = []           # paths written, usually inside context_handoff/
    notes_for_next_agent: str = ""      # what the next agent must know
```

`status` is load-bearing: an envelope that parses but reports `status="fail"` raises, failing the phase. An agent declaring its own failure is not a successful phase. The base contract remains closed to `success | fail`; only `BuildOutput` has the narrower, explicitly validated extension `success | fail | blocked`.

The starter types in `adw_modules/data_types.py`:

```python
class GenericOutput(EnvelopeBase):
    """Fallback for an agent with no sharper contract yet."""

class PlanOutput(EnvelopeBase):
    commit_message: str = ""            # imperative git subject for the PLAN FILE itself

class BlockerEvidence(BaseModel):
    source: str                          # non-empty, non-secret evidence reference
    observation: str                     # non-empty fact established by that source

class ExternalBlocker(BaseModel):
    category: Literal["approval", "access", "decision",
                      "external_dependency", "external_input"]
    owner: str                           # concrete external owner, non-empty
    required_action: str                 # what that owner/system must do, non-empty
    resume_when: str                     # objectively testable condition, non-empty
    evidence: list[BlockerEvidence]      # at least one; never secrets/credentials

class BuildOutput(EnvelopeBase):
    status: Literal["success", "fail", "blocked"]
    changed_files: list[str] = []
    commit_message: str = ""            # consumed by the git commit phase
    external_blocker: ExternalBlocker | None = None

class ScoutOutput(EnvelopeBase):
    findings: list[ScoutFinding] = []   # ScoutFinding: {file: str, note: str}

class ReviewOutput(EnvelopeBase):
    approved: bool = False              # the verdict; status is only "did the review run"
    findings: list[ReviewFinding] = []  # ReviewFinding: {requirement, met: bool, evidence}
    blocking: list[str] = []            # what must change before approval

class DocumentOutput(EnvelopeBase):
    document_path: str = ""             # the write-up's home in the repo
    documented_files: list[str] = []
    commit_message: str = ""
```

`BuildOutput` enforces both directions: `blocked` requires one complete `ExternalBlocker`, while `success` and `fail` reject one. Whitespace-only details/evidence, empty evidence, unknown categories, and extra blocker fields are invalid. Evidence must reference safe repository facts, commands, or non-secret external responses; credentials and secrets are forbidden. Existing success/fail reports that omit `external_blocker` remain valid.

Blocked is reserved for a prerequisite demonstrably controlled by an external owner or system and unavailable through the agent's permitted tools. The builder must first inspect the repository/handoff/relevant commands, exhaust safe partial work (or explain why none is possible), and provide a concrete action, objective resume condition, and evidence. Red tests, code/review defects, missing local research, assumptions, effort, uncertainty, or context pressure are never external blockers; they remain work or failure.

`commit_message` defaults to empty, so a git phase consuming it always needs a fallback — see `cookbooks/create_adw.md`.

**Each `commit_message` describes its own agent's work product, never the next one's**: `PlanOutput`'s covers the spec file, `BuildOutput`'s the code, `DocumentOutput`'s the write-up. A chain that commits once can use whichever fits; a chain that commits per step (`adw_simple_sdlc.py`) needs all three, and reusing one agent's sentence for another's diff is how a commit log starts lying.

There is no test output type: running the suite is a `kind="code"` phase, and its `QualityResult` reaches the next agent through `quality.as_envelope`.

Two of these are adapters rather than agent reports — code shaped as an envelope so an agent can be handed a deterministic result through the same door: `VerifyOutput` (a lint/test block's result) and `ChangesOutput` (a captured `git diff`, from `changes.as_envelope`). The consuming agent cannot tell the difference, which is the point.

The envelope is a **manifest of claims**. Gates verify those claims after the fact — declared artifacts exist and are non-empty, declared changes appear in the diff, declared tests actually pass. See `cookbooks/update_modules.md`.

## The typed-output rule

**Every agent call passes a concrete output type**, and the agent's final JSON is parsed against exactly that type. No untyped handoffs.

```python
plan = ph.call(AgentCall(output_type=PlanOutput, prompt=prompt,
                         gates=[gates.artifacts_exist]))
```

The user prompt asks for the shape; the type enforces it. They always travel as a pair, which is what lets one agent serve many calls — same system prompt, different user prompt + output type per call site. Output types live in code, never in `sssf.config.yaml`.

**Parse failure is not a restart.** If the response doesn't parse or doesn't validate, the harness re-prompts the **same session** with a correction naming the required fields — bounded by `JSON_FIX_ATTEMPTS` in `agents.py` (2). Gate violations use the identical mechanism, bounded instead by the phase's `retries`. A cold restart would throw away the context that produced the near-miss. A schema-valid blocked `BuildOutput` parses on attempt 1 like success and consumes no JSON retry; inconsistent or incomplete blocker fields remain ordinary validation failures.

Blocked builders still pass every claim gate and permission check. The validated envelope, agent map/context, usage, `handoff` (including `status` and `external_blocker`), and `agent_end` are persisted before `PhaseHandle` raises the dedicated traceback-free `BlockedRun(SystemExit)` control signal. The phase closes as `success`, the session closes once as `blocked`, and the process exits `2` without an `error` event. Central interruption means later test, review, commit, acceptance, and lifecycle phases never open; call sites remain uniformly bound to `BuildOutput`.

In v1 there is no separate continue call to make: `agent_pi.run()` passes `--session-id`, which pi treats as create-or-continue, so running an agent and continuing it are the same call with the same id. Before parsing, the harness also tolerates a fenced `json` code block or prose wrapped around the object — but the prompt still asks for bare JSON, and every failed attempt is persisted as an invalid envelope row.

## Injecting the previous envelope

`prompts.py` renders the agent's `user.md`, substituting:

| Placeholder | Value |
|---|---|
| `{{prompt}}` | the engineer's ask (or the ADW's per-call prompt) |
| `{{previous_envelope}}` | the upstream envelope JSON, from `AgentCall(previous=...)` |
| `{{context_handoff_dir}}` | absolute path to this session's `context_handoff/` |

A `user.md` declares one h3 per incoming datum, then the task, then the output contract:

````markdown
# Scout Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Find what `prompt` asks about. Write findings into `context_handoff_dir`, then emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `ScoutOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence on what you found>",
  "findings": [
    { "file": "src/server.ts", "note": "<why this file matters>" }
  ],
  "artifacts": ["<context_handoff_dir>/scout_findings.md"]
}
```
````

The `## Report` section shows the exact JSON shape of the declared output type — that is the agent's output contract, and it lives in `user.md` because the shape belongs to the *use*, not the identity. The matching `system.md` stays static: Purpose + Instructions only.

## Durable spec lifecycle

A planner writes two byte-identical copies of one plan: the tracked `specs/<adw_id>_<slug>.md` is authoritative, and `context_handoff/plan.md` is its live mirror while that session exists. Both begin with exactly one canonical frontmatter mapping and no other metadata:

```yaml
---
status: planned
---
```

The closed v1 enum is `planned` (a valid plan exists), `in_progress` (implementation explicitly started, including failed or interrupted attempts), and `complete` (declared acceptance evidence passed or an engineer accepted equivalent evidence). The only legal edges are `planned -> in_progress -> complete`; direct skips, repeats, backward moves, and writes from `complete` are errors. Missing, duplicate, malformed, non-scalar, extra, or unknown metadata is also an error—there is no inferred `unknown` state.

Creation is planner-owned and remains `planned` in plan-only workflows such as `adw_plan` and `adw_scout_plan`. Plan/build ADWs transition the authoritative and live copies together in visible `kind="code"`, `owner="specs"` phases immediately before building, and only explicit green acceptance branches write `complete`. A standalone build has no `PlanOutput` to resolve safely, so an engineer uses `just specs transition <status> <authoritative-path> [mirror-path ...]` with explicit paths; code never guesses from an `adw_id`.

Spec lifecycle is independent of `EnvelopeBase.status`, phase/session status (including `blocked`), `run.finish()`, Git commits, and reviewer `approved`. Those report operational outcomes or one acceptance input; none silently rewrites the durable delivery verdict. The spec enum remains only `planned | in_progress | complete`; blocked introduces no spec status and can never imply completion.

## Session directory layout

```
adws/adw_data/sessions/{adw_id}/
├── agent_map.json          agent name → coding-agent session_id + model
├── context_handoff/        the ONE place agents write files for the agents that follow
└── {agent_name}/
    ├── prompts/            exact prompts sent (system.md + user.md), saved before execution
    ├── pi_sessions/        pi's own session state for this agent
    ├── raw_output.jsonl    full JSONL stream from the coding agent, appended live
    └── envelope.json       the final valid-JSON response — captured, validated, persisted by code
```

`session.ensure(cfg, adw_id)` mints or joins the id and creates these dirs. One `context_handoff/` per session, shared by every agent — the single location for cross-agent files.

## agent_map.json and resuming

```json
{
  "planner": {"session_id": "sssf-a1b2c3d4-planner-9f2e",
              "model": "google/gemini-3.6-flash", "coding_agent": "pi"},
  "builder": {"session_id": "sssf-a1b2c3d4-builder-71ac",
              "model": "google/gemini-3.6-flash", "coding_agent": "pi"}
}
```

This map is the key that lets a later ADW rejoin each agent's **existing context window**. Run `adw_build.py --adw-id a1b2c3d4` after `adw_plan.py` and the builder resumes its own session rather than starting cold. Resuming a blocked `adw_id` does the same: the blocked envelope/events remain historical evidence and the matching agent/model reuses its session id, but the new `Run` starts with no active in-memory blocker and may later finish successfully.

The map records the model each session was created with. If config drift changes an agent's model, that agent starts a **fresh** session and the map is updated — never a bad resume. `agent_sessions` in `sssf.db` is the queryable mirror of this file.

**Files are the raw record; the db is the queryable mirror.** Losing `sssf.db` loses nothing that can't be rebuilt from `raw_output.jsonl`, `envelope.json`, and `agent_map.json`.
