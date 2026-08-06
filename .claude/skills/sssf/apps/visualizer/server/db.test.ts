import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_TIMELINE_MARKER_LIMIT, SssfDb } from "./db.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(withArchived = true): { path: string; setup: Database } {
  const dir = mkdtempSync(join(tmpdir(), "sssf-visualizer-"));
  tempDirs.push(dir);
  const path = join(dir, "sssf.db");
  const setup = new Database(path);
  setup.exec("PRAGMA journal_mode=WAL");
  setup.exec(`
    CREATE TABLE sessions (
      adw_id TEXT PRIMARY KEY, adw_name TEXT, request TEXT, status TEXT,
      engineer TEXT, started_at TEXT, ended_at TEXT, total_tokens INTEGER,
      total_cost REAL${withArchived ? ", archived INTEGER DEFAULT 0" : ""}
    );
    CREATE TABLE phases (
      phase_id TEXT PRIMARY KEY, adw_id TEXT, seq INTEGER, name TEXT, kind TEXT,
      owner TEXT, description TEXT, status TEXT, attempt INTEGER, retries INTEGER,
      error TEXT, started_at TEXT, ended_at TEXT
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, adw_id TEXT, phase_id TEXT, parent_id TEXT,
      type TEXT, name TEXT, payload_json TEXT, tokens INTEGER,
      started_at TEXT, ended_at TEXT
    );
    CREATE TABLE agent_sessions (
      adw_id TEXT, agent TEXT, coding_agent TEXT, model TEXT, session_id TEXT,
      color TEXT, context_tokens INTEGER, context_window INTEGER,
      created_at TEXT, last_used_at TEXT, PRIMARY KEY (adw_id, agent)
    );
  `);
  return { path, setup };
}

function insertSession(setup: Database, id: string, archived?: number): void {
  const columns = archived === undefined
    ? "adw_id, adw_name, status, started_at"
    : "adw_id, adw_name, status, started_at, archived";
  const values = archived === undefined ? "?, ?, ?, ?" : "?, ?, ?, ?, ?";
  setup
    .query(`INSERT INTO sessions (${columns}) VALUES (${values})`)
    .run(id, "adw_test", "success", `2024-01-01T00:00:0${id.length}Z`, ...(archived === undefined ? [] : [archived]));
}

function insertPhase(setup: Database, id: string, adwId: string, owner: string): void {
  setup
    .query(
      `INSERT INTO phases
       (phase_id, adw_id, seq, name, kind, owner, status, started_at)
       VALUES (?, ?, 1, 'build', 'agent', ?, 'success', '2024-01-01T00:00:00Z')`,
    )
    .run(id, adwId, owner);
}

function insertEvent(
  setup: Database,
  eventId: string,
  adwId: string,
  phaseId: string,
  index: number,
  type = "tool_call",
): void {
  setup
    .query(
      `INSERT INTO events
       (event_id, adw_id, phase_id, type, name, payload_json, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      adwId,
      phaseId,
      type,
      `event-${index}`,
      JSON.stringify({ deliberately: "not part of card responses", index }),
      new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
    );
}

describe("session archive projection", () => {
  test("filters active and archived rows and supports restore", () => {
    const { path, setup } = fixture();
    insertSession(setup, "active", 0);
    insertSession(setup, "past", 1);
    setup.close();

    const db = new SssfDb(path);
    expect(db.sessions(20, false).map((row) => row.adw_id)).toEqual(["active"]);
    expect(db.sessions(20, true).map((row) => row.adw_id)).toEqual(["past"]);
    expect(db.session("past")?.archived).toBe(1);

    expect(db.setArchived("active", true)).toBe(true);
    expect(db.sessions(20, true).map((row) => row.adw_id).toSorted()).toEqual(["active", "past"]);
    expect(db.setArchived("active", false)).toBe(true);
    expect(db.sessions(20, false).map((row) => row.adw_id)).toEqual(["active"]);
    db.close();
  });

  test("keeps legacy databases readable", () => {
    const { path, setup } = fixture(false);
    insertSession(setup, "legacy");
    setup.close();

    const db = new SssfDb(path);
    expect(db.sessions(20, false).map((row) => row.adw_id)).toEqual(["legacy"]);
    expect(db.sessions(20, true)).toEqual([]);
    expect(db.session("legacy")?.archived).toBeNull();
    expect(() => db.setArchived("legacy", true)).toThrow("predates the archived column");
    db.close();
  });
});

describe("bounded card timelines", () => {
  test("samples high-volume sessions and attributes a batch correctly", () => {
    const { path, setup } = fixture();
    insertSession(setup, "many", 0);
    insertSession(setup, "other", 0);
    insertPhase(setup, "phase-many", "many", "builder");
    insertPhase(setup, "phase-other", "other", "reviewer");
    for (let index = 0; index < 300; index += 1) {
      insertEvent(setup, `many-${index}`, "many", "phase-many", index);
    }
    for (let index = 0; index < 3; index += 1) {
      insertEvent(setup, `other-${index}`, "other", "phase-other", index);
    }
    insertEvent(setup, "ignored-log", "many", "phase-many", 301, "log");
    setup.close();

    const db = new SssfDb(path);
    const rows = db.sessions(20, false);
    const many = rows.find((row) => row.adw_id === "many");
    const other = rows.find((row) => row.adw_id === "other");
    expect(many).toBeDefined();
    expect(other).toBeDefined();
    expect(many?.timeline).toHaveLength(CARD_TIMELINE_MARKER_LIMIT);
    expect(many?.timeline_marker_count).toBe(300);
    expect(many?.timeline_truncated).toBe(true);
    expect(many?.timeline[0]?.event_id).toBe("many-0");
    expect(many?.timeline.at(-1)?.event_id).toBe("many-299");
    expect(
      many?.timeline.every((marker, index, all) =>
        index === 0 || (all[index - 1]?.started_at ?? "") <= (marker.started_at ?? ""),
      ),
    ).toBe(true);
    expect(Object.hasOwn(many?.timeline[0] ?? {}, "payload_json")).toBe(false);
    expect(many?.timeline.every((marker) => marker.adw_id === "many")).toBe(true);
    expect(other?.timeline.map((marker) => marker.event_id)).toEqual([
      "other-0",
      "other-1",
      "other-2",
    ]);
    db.close();
  });
});

describe("nested subagent projection", () => {
  test("keeps children scoped and pages their activity without changing configured agents", () => {
    const { path, setup } = fixture();
    insertSession(setup, "nested", 0);
    insertSession(setup, "other", 0);
    insertPhase(setup, "phase-nested", "nested", "planner");
    setup.exec(`
      CREATE TABLE subagents (
        subagent_id TEXT PRIMARY KEY, adw_id TEXT, phase_id TEXT, parent_agent TEXT,
        display_id INTEGER, parent_tool_call_id TEXT, parent_event_id TEXT, task TEXT,
        session_path TEXT, status TEXT, created_at TEXT, started_at TEXT, ended_at TEXT,
        duration_ms INTEGER, removed_at TEXT
      );
      CREATE TABLE subagent_turns (
        turn_id TEXT PRIMARY KEY, subagent_id TEXT, adw_id TEXT, phase_id TEXT, turn INTEGER,
        parent_tool_call_id TEXT, parent_event_id TEXT, prompt TEXT, model TEXT, thinking TEXT,
        pid INTEGER, status TEXT, started_at TEXT, ended_at TEXT, duration_ms INTEGER,
        result TEXT, error TEXT, tool_count INTEGER, raw_output_path TEXT, session_path TEXT
      );
      CREATE TABLE subagent_activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT, telemetry_id TEXT, activity_id TEXT,
        subagent_id TEXT, adw_id TEXT, turn INTEGER, tool_call_id TEXT, tool TEXT,
        args_json TEXT, result_snippet TEXT, ok INTEGER, started_at TEXT, ended_at TEXT,
        duration_ms INTEGER
      );
      INSERT INTO subagents VALUES
        ('child','nested','phase-nested','planner',1,'parent-call','parent-event','continue',
         '/target/session.jsonl','success','2024-01-01','2024-01-01','2024-01-02',10,NULL),
        ('wrong','other',NULL,'planner',1,NULL,NULL,'other',NULL,'success','2024',NULL,NULL,0,NULL);
      INSERT INTO subagent_turns VALUES
        ('child:1','child','nested','phase-nested',1,'parent-call','parent-event','start','m1','high',1,
         'success','2024',NULL,5,'first result',NULL,1,NULL,'/target/session.jsonl'),
        ('child:2','child','nested','phase-nested',2,NULL,NULL,'continue','m2','medium',2,
         'success','2024',NULL,5,'second result',NULL,2,NULL,'/target/session.jsonl');
      INSERT INTO subagent_activities
        (telemetry_id,activity_id,subagent_id,adw_id,turn,tool_call_id,tool,args_json,ok)
        VALUES ('a','a','child','nested',1,'a','read','{}',1),
               ('b','b','child','nested',2,'b','bash','{}',1),
               ('c','c','child','nested',2,'c','grep','{}',0);
    `);
    setup.close();

    const db = new SssfDb(path);
    expect(db.subagents("nested")).toHaveLength(1);
    expect(db.subagents("nested")[0]).toMatchObject({ model: "m2", turn_count: 2, tool_count: 3 });
    expect(db.subagent("nested", "child")?.turns.map((turn) => turn.result)).toEqual([
      "first result", "second result",
    ]);
    expect(db.subagent("other", "child")).toBeNull();
    const first = db.subagentActivities("nested", "child", 0, 2)!;
    const second = db.subagentActivities("nested", "child", first.cursor, 2)!;
    expect([...first.activities, ...second.activities].map((row) => row.tool)).toEqual(["read", "bash", "grep"]);
    expect(db.agentSessions("nested")).toEqual([]);
    db.close();
  });

  test("returns an empty roster for legacy databases", () => {
    const { path, setup } = fixture();
    insertSession(setup, "legacy", 0);
    setup.close();
    const db = new SssfDb(path);
    expect(db.subagents("legacy")).toEqual([]);
    expect(db.subagent("legacy", "missing")).toBeNull();
    db.close();
  });
});

describe("event cursor", () => {
  test("pages without gaps or duplicates", () => {
    const { path, setup } = fixture();
    insertSession(setup, "cursor", 0);
    insertPhase(setup, "phase-cursor", "cursor", "builder");
    for (let index = 0; index < 7; index += 1) {
      insertEvent(setup, `cursor-${index}`, "cursor", "phase-cursor", index);
    }
    setup.close();

    const db = new SssfDb(path);
    const first = db.events("cursor", 0, 3);
    const second = db.events("cursor", first.cursor, 3);
    const third = db.events("cursor", second.cursor, 3);
    expect(first.has_more).toBe(true);
    expect(second.has_more).toBe(true);
    expect(third.has_more).toBe(false);
    expect([...first.events, ...second.events, ...third.events].map((event) => event.event_id)).toEqual([
      "cursor-0",
      "cursor-1",
      "cursor-2",
      "cursor-3",
      "cursor-4",
      "cursor-5",
      "cursor-6",
    ]);
    expect(new Set([...first.events, ...second.events, ...third.events].map((event) => event.rowid)).size).toBe(7);
    db.close();
  });
});
