import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiRoutes } from "./app.ts";
import { SssfDb } from "./db.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture(nested = true) {
  const dir = mkdtempSync(join(tmpdir(), "sssf-routes-"));
  dirs.push(dir);
  const path = join(dir, "sssf.db");
  const setup = new Database(path);
  setup.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE sessions (adw_id TEXT PRIMARY KEY, adw_name TEXT, request TEXT, status TEXT,
      engineer TEXT, started_at TEXT, ended_at TEXT, total_tokens INTEGER, total_cost REAL, archived INTEGER);
    CREATE TABLE phases (phase_id TEXT PRIMARY KEY, adw_id TEXT, seq INTEGER, name TEXT, kind TEXT,
      owner TEXT, description TEXT, status TEXT, attempt INTEGER, retries INTEGER, error TEXT,
      started_at TEXT, ended_at TEXT);
    CREATE TABLE events (event_id TEXT PRIMARY KEY, adw_id TEXT, phase_id TEXT, parent_id TEXT,
      type TEXT, name TEXT, payload_json TEXT, tokens INTEGER, started_at TEXT, ended_at TEXT);
    CREATE TABLE agent_sessions (adw_id TEXT, agent TEXT, coding_agent TEXT, model TEXT, session_id TEXT,
      color TEXT, context_tokens INTEGER, context_window INTEGER, created_at TEXT, last_used_at TEXT);
    INSERT INTO sessions (adw_id,status,started_at,archived) VALUES ('run','running','2025-01-01',0),('other','success','2025-01-01',0);
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
  const db = new SssfDb(path);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: createApiRoutes(db) });
  const get = (route: string) => fetch(`http://127.0.0.1:${server.port}${route}`);
  return { setup, db, server, get };
}

async function close(f: ReturnType<typeof fixture>) {
  await f.server.stop(true);
  f.db.close();
  f.setup.close();
}

describe("nested subagent HTTP contracts", () => {
  test("serves scoped roster/detail/cursor pages and live terminal updates", async () => {
    const f = fixture();
    try {
      const roster = await f.get("/api/sessions/run/subagents");
      expect(roster.status).toBe(200);
      expect((await roster.json()) as unknown[]).toHaveLength(1);
      const detail = await f.get("/api/sessions/run/subagents/child");
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ subagent_id: "child", turns: [{ status: "running" }] });
      const first = await f.get("/api/sessions/run/subagents/child/activity?after=0&limit=1");
      const firstPage = await first.json() as { cursor: number; has_more: boolean; activities: unknown[] };
      expect(firstPage).toMatchObject({ has_more: true });
      expect(firstPage.activities).toHaveLength(1);
      const second = await f.get(`/api/sessions/run/subagents/child/activity?after=${firstPage.cursor}&limit=1`);
      expect((await second.json()) as { activities: unknown[] }).toMatchObject({ activities: [{ tool: "bash" }] });

      f.setup.query("UPDATE subagents SET status='success', ended_at='2025-01-02' WHERE subagent_id='child'").run();
      f.setup.query("UPDATE subagent_turns SET status='success', result='full result' WHERE turn_id='child:1'").run();
      const terminal = await f.get("/api/sessions/run/subagents/child");
      expect(await terminal.json()).toMatchObject({ status: "success", turns: [{ result: "full result" }] });
    } finally { await close(f); }
  });

  test("validates paths and cursors and rejects ADW mismatches", async () => {
    const f = fixture();
    try {
      expect((await f.get("/api/sessions/run/subagents/bad%20id")).status).toBe(400);
      expect((await f.get("/api/sessions/run/subagents/child/activity?after=nope")).status).toBe(400);
      expect((await f.get("/api/sessions/other/subagents/child")).status).toBe(404);
      expect((await f.get("/api/sessions/missing/subagents")).status).toBe(404);
    } finally { await close(f); }
  });

  test("returns an empty roster for a legacy database", async () => {
    const f = fixture(false);
    try {
      const response = await f.get("/api/sessions/run/subagents");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    } finally { await close(f); }
  });
});
