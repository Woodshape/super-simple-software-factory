import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChildEventTracker,
  TelemetryWriter,
  appendRaw,
  childPaths,
  createSubagentId,
  writeResult,
} from "../../../templates/harness_engineering/subagent_observability.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("nested extension telemetry", () => {
  test("persists two interleaved children, lifecycle, cancellation, and continuation", () => {
    const root = mkdtempSync(join(tmpdir(), "sssf-child-"));
    dirs.push(root);
    const context = {
      version: 1 as const,
      adw_id: "run",
      phase_id: "phase",
      parent_agent: "planner",
      root: join(root, "sessions", "run", "planner", "subagents"),
      telemetry_path: join(root, "sessions", "run", "planner", "subagents", "telemetry.jsonl"),
    };
    const firstId = createSubagentId(1, 1000);
    const secondId = createSubagentId(2, 1000);
    expect(firstId).not.toBe(secondId);
    const first = childPaths(context, firstId);
    const second = childPaths(context, secondId);
    expect(first.sessionFile.startsWith(root)).toBe(true);
    expect(first.sessionFile).not.toContain(".pi");
    expect(first.sessionFile).not.toBe(second.sessionFile);

    const writer = new TelemetryWriter(context);
    writer.emit("subagent.created", firstId, { display_id: 1, session_path: first.sessionFile });
    writer.emit("subagent.created", secondId, { display_id: 2, session_path: second.sessionFile });
    writer.emit("turn.started", firstId, { turn: 1, prompt: "one" });
    writer.emit("turn.started", secondId, { turn: 1, prompt: "two" });
    appendRaw(first.turnRaw(1), '{"type":"first"}');
    appendRaw(second.turnRaw(1), '{"type":"second"}');

    const firstTracker = new ChildEventTracker();
    const secondTracker = new ChildEventTracker();
    firstTracker.observe({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "README.md" } });
    secondTracker.observe({ type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: { command: "pwd" } });
    const secondCompleted = secondTracker.observe({ type: "tool_execution_end", toolCallId: "call-2", result: { content: [{ type: "text", text: "cwd" }] }, isError: false });
    const firstCompleted = firstTracker.observe({ type: "tool_execution_end", toolCallId: "call-1", result: { content: [{ type: "text", text: "done" }] }, isError: false });
    expect(firstCompleted).toMatchObject({ activity_id: "call-1", tool: "read", ok: true, result_snippet: "done" });
    expect(secondCompleted).toMatchObject({ activity_id: "call-2", tool: "bash", ok: true, result_snippet: "cwd" });
    writer.emit("activity.completed", secondId, { turn: 1, ...secondCompleted });
    writer.emit("activity.completed", firstId, { turn: 1, ...firstCompleted });
    writer.emit("turn.finished", firstId, { turn: 1, status: "success", result: "full first" });
    writer.emit("turn.started", firstId, { turn: 2, prompt: "continue", session_path: first.sessionFile });
    writer.emit("turn.finished", firstId, { turn: 2, status: "success", result: "full continuation" });
    writer.emit("subagent.removed", secondId, { removed_at: "2025-01-01T00:00:00Z" });
    writer.emit("turn.finished", secondId, { turn: 1, status: "cancelled", result: "partial" });
    writeResult(first.turnResult(2), "full continuation");

    expect(readFileSync(first.turnRaw(1), "utf8")).toContain('"type":"first"');
    expect(readFileSync(second.turnRaw(1), "utf8")).toContain('"type":"second"');
    expect(readFileSync(first.turnResult(2), "utf8")).toBe("full continuation");
    const records = readFileSync(context.telemetry_path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.every((record) => record.protocol === "sssf.subagents.v1")).toBe(true);
    expect(records.filter((record) => record.subagent_id === firstId && record.kind === "turn.started").map((record) => record.turn)).toEqual([1, 2]);
    expect(records.find((record) => record.subagent_id === secondId && record.kind === "turn.finished")).toMatchObject({ status: "cancelled" });
  });
});
