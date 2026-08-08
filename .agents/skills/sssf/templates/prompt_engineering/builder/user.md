# Build Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Implement the work described in `prompt`, guided by `previous_envelope` if present, then emit your `Report` JSON.

Use `status: "blocked"` only for a prerequisite demonstrably controlled by an external owner or system. Before reporting blocked, you MUST:

1. inspect the repository, handoff, and relevant documents or commands;
2. exhaust safe, unblocked partial work, or explain concretely why no such work is possible;
3. prove that the remaining prerequisite is controlled externally and must not or cannot be created with your available tools;
4. name the required action and an objectively verifiable resume condition; and
5. cite at least one concrete, non-secret evidence source and the fact observed there.

Never include secrets or credentials in blocker evidence. Do not use blocked for failing tests, implementation or review defects, missing local research, assumptions, effort, uncertainty, time/context pressure, or a difficult task. Continue working on those cases, or report `status: "fail"` when execution genuinely fails. A valid external blocker is reported as typed JSON with `status: "blocked"`, never as free-text/invalid JSON and never disguised as `status: "fail"`.

## Report

Respond with ONLY valid JSON matching `BuildOutput` — no prose before or after.

Normal delivery (success or fail always has `external_blocker: null`):

```json
{
  "status": "success",
  "summary": "<one sentence describing what you built>",
  "changed_files": ["src/server.ts"],
  "artifacts": [],
  "commit_message": "<imperative one-line git subject for the code you changed — this is what the commit of your work will say>",
  "notes_for_next_agent": "<how to verify this work>",
  "external_blocker": null
}
```

Externally blocked delivery:

```json
{
  "status": "blocked",
  "summary": "Delivery is waiting for the data owner to approve read access.",
  "changed_files": ["src/query.ts"],
  "artifacts": [],
  "commit_message": "Prepare approved metrics query",
  "notes_for_next_agent": "Resume after the recorded approval is visible, then run the target smoke test.",
  "external_blocker": {
    "category": "approval",
    "owner": "Metrics data owner",
    "required_action": "Approve read access for the named service role",
    "resume_when": "The access-control response records approval for that role",
    "evidence": [
      {
        "source": "docs/access-request.md#current-status",
        "observation": "The request is recorded as pending data-owner approval"
      }
    ]
  }
}
```
