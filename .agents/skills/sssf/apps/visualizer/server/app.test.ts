import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApiRoutes } from "./app.ts";
import { SssfDb } from "./db.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture(nested = true, withArchived = true) {
  const dir = mkdtempSync(join(tmpdir(), "sssf-routes-"));
  dirs.push(dir);
  const path = join(dir, "kios-mvp", "adws", "adw_data", "sssf.db");
  mkdirSync(dirname(path), { recursive: true });
  const setup = new Database(path);
  setup.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE sessions (adw_id TEXT PRIMARY KEY, adw_name TEXT, request TEXT, status TEXT,
      engineer TEXT, started_at TEXT, ended_at TEXT, total_tokens INTEGER, total_cost REAL${withArchived ? ", archived INTEGER" : ""});
    CREATE TABLE phases (phase_id TEXT PRIMARY KEY, adw_id TEXT, seq INTEGER, name TEXT, kind TEXT,
      owner TEXT, description TEXT, status TEXT, attempt INTEGER, retries INTEGER, error TEXT,
      started_at TEXT, ended_at TEXT);
    CREATE TABLE events (event_id TEXT PRIMARY KEY, adw_id TEXT, phase_id TEXT, parent_id TEXT,
      type TEXT, name TEXT, payload_json TEXT, tokens INTEGER, started_at TEXT, ended_at TEXT);
    CREATE TABLE agent_sessions (adw_id TEXT, agent TEXT, coding_agent TEXT, model TEXT, session_id TEXT,
      color TEXT, context_tokens INTEGER, context_window INTEGER, created_at TEXT, last_used_at TEXT);
    INSERT INTO sessions (adw_id,status,started_at${withArchived ? ",archived" : ""}) VALUES
      ('run','running','2025-01-01'${withArchived ? ",0" : ""}),
      ('other','success','2025-01-01'${withArchived ? ",0" : ""});
    INSERT INTO phases (phase_id,adw_id,seq,name,kind,owner,description,status,attempt,retries,started_at)
      VALUES ('phase','run',1,'plan','agent','planner','plan it','running',1,0,'2025-01-01');
    INSERT INTO events (event_id,adw_id,phase_id,type,name,payload_json,started_at) VALUES
      ('configured-start','run','phase','agent_start','planner','{"model":"model","thinking":"high"}','2025-01-01'),
      ('configured-tool-1','run','phase','tool_call','read','{"tool":"read","ok":true}','2025-01-01'),
      ('configured-tool-2','run','phase','tool_call','bash','{"tool":"bash","ok":false}','2025-01-01');
  `);
  if (nested) setup.exec(`
    CREATE TABLE subagents (subagent_id TEXT PRIMARY KEY, adw_id TEXT, phase_id TEXT, parent_agent TEXT,
      display_id INTEGER, parent_tool_call_id TEXT, parent_event_id TEXT, task TEXT, session_path TEXT,
      status TEXT, created_at TEXT, started_at TEXT, ended_at TEXT, duration_ms INTEGER, removed_at TEXT);
    CREATE TABLE subagent_turns (turn_id TEXT PRIMARY KEY, subagent_id TEXT, adw_id TEXT, phase_id TEXT,
      turn INTEGER, parent_tool_call_id TEXT, parent_event_id TEXT, prompt TEXT, model TEXT, thinking TEXT,
      pid INTEGER, status TEXT, started_at TEXT, ended_at TEXT, duration_ms INTEGER, result TEXT, error TEXT,
      tool_count INTEGER, raw_output_path TEXT, session_path TEXT);
    CREATE TABLE subagent_activities (id INTEGER PRIMARY KEY AUTOINCREMENT, telemetry_id TEXT, activity_id TEXT,
      subagent_id TEXT, adw_id TEXT, turn INTEGER, tool_call_id TEXT, tool TEXT, args_json TEXT,
      result_snippet TEXT, ok INTEGER, started_at TEXT, ended_at TEXT, duration_ms INTEGER);
    INSERT INTO subagents VALUES ('child','run','phase','planner',1,'call','event','task','session','running','2025-01-01','2025-01-01',NULL,NULL,NULL);
    INSERT INTO subagent_turns VALUES ('child:1','child','run','phase',1,'call','event','task','model','high',123,'running','2025-01-01',NULL,NULL,NULL,NULL,0,'raw','session');
    INSERT INTO subagent_activities (telemetry_id,activity_id,subagent_id,adw_id,turn,tool,ok)
      VALUES ('one','one','child','run',1,'read',1),('two','two','child','run',1,'bash',1);
  `);
  const sessionsDir = join(dirname(path), "sessions", "run");
  const raw = (role: string, content: unknown[], timestamp: string) => JSON.stringify({
    type: "message_end",
    fixture_path: dir,
    thinkingSignature: "http-secret-signature",
    message: { role, content, timestamp },
  });
  const toolStart = (prefix: string, tool: string, args: unknown) => JSON.stringify({
    type: "tool_execution_start", toolCallId: `${prefix}-${tool}`, toolName: tool, args,
    timestamp: "2025-01-01T00:00:03Z", fixture_path: dir,
  });
  const toolEnd = (prefix: string, tool: string, args: unknown, result: string) => JSON.stringify({
    type: "tool_execution_end", toolCallId: `${prefix}-${tool}`, toolName: tool, args, isError: false,
    timestamp: "2025-01-01T00:00:04Z", fixture_path: dir,
    result: { content: [{ type: "text", text: result }], details: "provider-secret-details" },
  });
  const toolFlow = (prefix: string, label: string) => {
    const args = {
      bash: { command: `${label} printf full-command` },
      read: { path: `/intentional/${label}/input.txt` },
      write: { path: `/intentional/${label}/output.txt`, content: `${label}\nfull content` },
    } as const;
    return {
      calls: ["bash", "read", "write"].map((tool) => ({
        type: "toolCall", id: `${prefix}-${tool}`, name: tool, arguments: args[tool as keyof typeof args],
      })),
      events: [
        ...(["bash", "read", "write"] as const).map((tool) => toolStart(prefix, tool, args[tool])),
        ...(["bash", "read", "write"] as const).map((tool) => toolEnd(prefix, tool, args[tool], `${label} ${tool}\nfull result`)),
      ],
    };
  };
  const configuredTools = toolFlow("configured", "configured");
  mkdirSync(join(sessionsDir, "planner"), { recursive: true });
  writeFileSync(join(sessionsDir, "planner", "raw_output.jsonl"), [
    raw("user", [{ type: "text", text: "configured user" }], "2025-01-01T00:00:01Z"),
    raw("assistant", [
      { type: "thinking", thinking: "configured thinking", thinkingSignature: "block-signature" },
      ...configuredTools.calls,
      { type: "text", text: "configured answer" },
    ], "2025-01-01T00:00:02Z"),
    ...configuredTools.events,
  ].join("\n") + "\n");
  if (nested) {
    const nestedTools = toolFlow("nested", "nested");
    mkdirSync(join(sessionsDir, "planner", "subagents", "child", "turn-1"), { recursive: true });
    writeFileSync(join(sessionsDir, "planner", "subagents", "child", "turn-1", "raw_output.jsonl"), [
      raw("user", [{ type: "text", text: "nested user" }], "2025-01-01T00:00:01Z"),
      raw("assistant", [...nestedTools.calls, { type: "text", text: "nested answer" }], "2025-01-01T00:00:02Z"),
      ...nestedTools.events,
    ].join("\n") + "\n");
  }
  const db = new SssfDb(path);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: createApiRoutes(db) });
  const request = (route: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${server.port}${route}`, init);
  const get = (route: string) => request(route);
  return { dir, path, setup, db, server, get, request };
}

async function close(f: ReturnType<typeof fixture>) {
  await f.server.stop(true);
  f.db.close();
  f.setup.close();
}

describe("health HTTP contract", () => {
  test("returns only the target repository basename as its workspace identity", async () => {
    const f = fixture();
    try {
      const response = await f.get("/api/health");
      expect(response.status).toBe(200);
      const text = await response.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(body).toEqual({
        ok: true,
        workspace: "kios-mvp",
        journal_mode: "wal",
        sessions: 2,
      });
      expect(Object.hasOwn(body, "db")).toBe(false);
      expect(text).not.toContain(f.path);
      expect(text).not.toContain(f.dir);
    } finally { await close(f); }
  });
});

describe("session deletion HTTP contract", () => {
  test("preserves GET and maps active, success, repeated, and unsafe deletion", async () => {
    const f = fixture();
    try {
      expect((await f.get("/api/sessions/run")).status).toBe(200);

      const active = await f.request("/api/sessions/run", { method: "DELETE" });
      expect(active.status).toBe(409);
      expect(await active.json()).toMatchObject({ error: "archive this session before deleting it" });

      const archive = await f.request("/api/sessions/run/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      expect(archive.status).toBe(200);

      const deleted = await f.request("/api/sessions/run", { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ adw_id: "run", deleted: true });
      expect(f.setup.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events WHERE adw_id='run'").get()?.count).toBe(0);
      expect((await f.request("/api/sessions/run", { method: "DELETE" })).status).toBe(404);
      expect((await f.request("/api/sessions/bad%20id", { method: "DELETE" })).status).toBe(400);
    } finally { await close(f); }
  });

  test("returns a distinct conflict when archive state is unavailable", async () => {
    const f = fixture(false, false);
    try {
      const response = await f.request("/api/sessions/run", { method: "DELETE" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("no archive state") });
      expect(f.setup.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions WHERE adw_id='run'").get()?.count).toBe(1);
    } finally { await close(f); }
  });
});

describe("unified agent HTTP contracts", () => {
  test("serves scoped roster/detail/cursor pages and live terminal updates", async () => {
    const f = fixture();
    try {
      const roster = await f.get("/api/sessions/run");
      expect(roster.status).toBe(200);
      expect((await roster.json()) as { agents: unknown[] }).toMatchObject({ agents: [
        { agent_id: "phase", source: "configured" },
        { agent_id: "child", source: "nested", parent_agent_id: "phase" },
      ] });
      const configured = await f.get("/api/sessions/run/agents/phase");
      expect(configured.status).toBe(200);
      expect(await configured.json()).toMatchObject({ source: "configured", phase_id: "phase", turns: [] });
      const configuredPage = await f.get("/api/sessions/run/agents/phase/activity?after=0&limit=1");
      const configuredFirst = await configuredPage.json() as { cursor: number; has_more: boolean; activities: unknown[] };
      expect(configuredFirst).toMatchObject({ has_more: true, activities: [{ agent_id: "phase", tool: "read", ok: 1 }] });
      const configuredSecond = await f.get(`/api/sessions/run/agents/phase/activity?after=${configuredFirst.cursor}&limit=1`);
      expect(await configuredSecond.json()).toMatchObject({ activities: [{ tool: "bash", ok: 0 }] });

      const detail = await f.get("/api/sessions/run/agents/child");
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ subagent_id: "child", turns: [{ status: "running" }] });
      const first = await f.get("/api/sessions/run/agents/child/activity?after=0&limit=1");
      const firstPage = await first.json() as { cursor: number; has_more: boolean; activities: unknown[] };
      expect(firstPage).toMatchObject({ has_more: true });
      expect(firstPage.activities).toHaveLength(1);
      const second = await f.get(`/api/sessions/run/agents/child/activity?after=${firstPage.cursor}&limit=1`);
      expect((await second.json()) as { activities: unknown[] }).toMatchObject({ activities: [{ tool: "bash" }] });

      f.setup.query("UPDATE subagents SET status='success', ended_at='2025-01-02' WHERE subagent_id='child'").run();
      f.setup.query("UPDATE subagent_turns SET status='success', result='full result' WHERE turn_id='child:1'").run();
      const terminal = await f.get("/api/sessions/run/agents/child");
      expect(await terminal.json()).toMatchObject({ status: "success", turns: [{ result: "full result" }] });
    } finally { await close(f); }
  });

  test("serves complete, safe tool history over stable cursor pages for configured and nested agents", async () => {
    const f = fixture();
    type Message = { cursor: number; id: string; role: string; [key: string]: unknown };
    type Page = { messages: Message[]; cursor: number; has_more: boolean; available: boolean };
    const allPages = async (agentId: string, limit: number) => {
      const messages: Message[] = [];
      let cursor = 0;
      let serialized = "";
      let hasMore = true;
      do {
        // Cursor pages are intentionally sequential: each request depends on the previous cursor.
        // eslint-disable-next-line no-await-in-loop
        const response = await f.get(`/api/sessions/run/agents/${agentId}/messages?after=${cursor}&limit=${limit}`);
        expect(response.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const text = await response.text();
        serialized += text;
        const page = JSON.parse(text) as Page;
        expect(page.available).toBe(true);
        messages.push(...page.messages);
        cursor = page.cursor;
        hasMore = page.has_more;
      } while (hasMore);
      return { messages, serialized };
    };
    try {
      const configured = await allPages("phase", 2);
      expect(configured.messages.map((message) => message.role)).toEqual([
        "user", "thinking", "tool_call", "tool_call", "tool_call", "assistant",
        "tool_result", "tool_result", "tool_result",
      ]);
      expect(configured.messages.map((message) => message.cursor)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(configured.messages.filter((message) => message.role === "tool_call"))
        .toMatchObject([
          { tool: "bash", tool_call_id: "configured-bash", arguments_json: "{\"command\":\"configured printf full-command\"}" },
          { tool: "read", tool_call_id: "configured-read", arguments_json: "{\"path\":\"/intentional/configured/input.txt\"}" },
          { tool: "write", tool_call_id: "configured-write" },
        ]);
      expect(configured.messages.filter((message) => message.role === "tool_result"))
        .toMatchObject([
          { tool_call_id: "configured-bash", result: "configured bash\nfull result", is_error: false },
          { tool_call_id: "configured-read", result: "configured read\nfull result", is_error: false },
          { tool_call_id: "configured-write", result: "configured write\nfull result", is_error: false },
        ]);

      const nested = await allPages("child", 3);
      expect(nested.messages.map((message) => message.role)).toEqual([
        "user", "tool_call", "tool_call", "tool_call", "assistant",
        "tool_result", "tool_result", "tool_result",
      ]);
      expect(nested.messages.every((message) => message.cursor > 0 && message.turn === 1)).toBe(true);
      expect(new Set(nested.messages.map((message) => message.cursor)).size).toBe(nested.messages.length);
      expect(nested.serialized).toContain("nested printf full-command");
      expect(nested.serialized).toContain("/intentional/nested/input.txt");
      for (const serialized of [configured.serialized, nested.serialized]) {
        expect(serialized).not.toContain(f.dir);
        expect(serialized).not.toContain("signature");
        expect(serialized).not.toContain("provider-secret-details");
      }
    } finally { await close(f); }
  });

  test("returns unavailable for a known legacy agent with no Pi files", async () => {
    const f = fixture(false);
    try {
      rmSync(join(dirname(f.path), "sessions", "run", "planner", "raw_output.jsonl"));
      const response = await f.get("/api/sessions/run/agents/phase/messages");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ messages: [], cursor: 0, has_more: false, available: false });
    } finally { await close(f); }
  });

  test("validates paths and cursors and rejects ADW mismatches", async () => {
    const f = fixture();
    try {
      expect((await f.get("/api/sessions/run/agents/bad%20id")).status).toBe(400);
      expect((await f.get("/api/sessions/run/agents/child/activity?after=nope")).status).toBe(400);
      expect((await f.get("/api/sessions/run/agents/child/activity?after=-1")).status).toBe(400);
      expect((await f.get("/api/sessions/run/agents/child/activity?limit=1001")).status).toBe(400);
      expect((await f.get("/api/sessions/run/agents/child/activity?after=999999999999999999999")).status).toBe(400);
      expect((await f.get("/api/sessions/run/agents/bad%20id/messages")).status).toBe(400);
      expect((await f.get("/api/sessions/run/agents/child/messages?after=-1")).status).toBe(400);
      expect((await f.get("/api/sessions/run/agents/child/messages?limit=0")).status).toBe(400);
      expect((await f.get("/api/sessions/run/agents/child/messages?limit=1001")).status).toBe(400);
      expect((await f.get("/api/sessions/other/agents/child/messages")).status).toBe(404);
      expect((await f.get("/api/sessions/other/agents/child")).status).toBe(404);
      expect((await f.get("/api/sessions/missing")).status).toBe(404);
    } finally { await close(f); }
  });

  test("keeps configured agents in a legacy database", async () => {
    const f = fixture(false);
    try {
      const response = await f.get("/api/sessions/run");
      expect(response.status).toBe(200);
      expect((await response.json()) as { agents: unknown[] }).toMatchObject({ agents: [{ agent_id: "phase", source: "configured" }] });
    } finally { await close(f); }
  });
});
