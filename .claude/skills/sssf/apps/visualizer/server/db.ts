/**
 * SQLite reader over a target repo's sssf.db.
 *
 * The read connection is opened readonly and every query on it is a SELECT —
 * the writers are the tracers of running ADW processes, and WAL lets us read
 * straight through their inserts.
 *
 * Human-triggered mutations use a separate connection opened lazily:
 * archive/restore updates review state, while permanent deletion is guarded by
 * that state and removes both the queryable mirror and the selected raw record.
 */
import { Database } from "bun:sqlite";
import { existsSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  AgentActivitiesPage,
  AgentActivity,
  AgentDetail,
  AgentSession,
  AgentStartPayload,
  AgentTurn,
  ConfiguredAgent,
  CardTimelineMarker,
  Envelope,
  Event,
  EventsPage,
  GateResult,
  Phase,
  Session,
  SessionDetail,
  SessionSummary,
  SessionUsage,
  NestedAgent,
  TraceAgent,
} from "../shared/types.ts";

const DEFAULT_DB_RELATIVE = "adws/adw_data/sssf.db";
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

export type DeleteArchivedSessionResult =
  | "deleted"
  | "not_found"
  | "not_archived"
  | "unsupported_archive_state";

/** Maximum payload-free event markers embedded in one session-list card. */
export const CARD_TIMELINE_MARKER_LIMIT = 120;
interface StoredSubagent {
  subagent_id: string;
  adw_id: string;
  phase_id: string | null;
  parent_agent: string | null;
  display_id: number | null;
  parent_tool_call_id: string | null;
  parent_event_id: string | null;
  task: string | null;
  model: string | null;
  thinking: string | null;
  session_path: string | null;
  status: NestedAgent["status"];
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  removed_at: string | null;
  turn_count: number;
  tool_count: number;
}

const CARD_TIMELINE_TYPES = [
  "agent_start",
  "tool_call",
  "handoff",
  "agent_end",
  "error",
  "gate_fail",
] as const;

/**
 * Resolve the db path: --db arg wins, then SSSF_DB, then <cwd>/adws/adw_data/sssf.db.
 * The db lives in the TARGET repo, so cwd is the repo the visualizer is pointed at.
 */
export function resolveDbPath(argv: string[] = Bun.argv): string {
  const flagIndex = argv.indexOf("--db");
  const inline = argv.find((a) => a.startsWith("--db="));
  const raw =
    (flagIndex !== -1 ? argv[flagIndex + 1] : undefined) ??
    inline?.slice("--db=".length) ??
    process.env.SSSF_DB ??
    DEFAULT_DB_RELATIVE;

  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

export class SssfDb {
  readonly path: string;
  /**
   * Where the ADW session dirs live: `{data_dir}/sessions/{adw_id}/{agent}/`.
   * The db sits in the same data_dir (config's `observability.db` defaults to
   * `adws/adw_data/sssf.db`), so deriving it as a sibling of the db file keeps
   * working when the whole data_dir is relocated.
   */
  readonly sessionsDir: string;
  readonly journalMode: string;
  private readonly db: Database;
  /** Opened on the first human-triggered mutation and kept until close. */
  private writer: Database | null = null;
  /** Cache for optionalColumn(), keyed "table.column". Only ever false → true. */
  private readonly columnCache = new Map<string, boolean>();
  private readonly tableCache = new Map<string, boolean>();

  constructor(path: string) {
    if (!existsSync(path)) {
      throw new Error(
        `sssf.db not found at ${path}\n` +
          `Point the visualizer at a target repo: --db <path> or SSSF_DB=<path>, ` +
          `or run it from a repo root containing ${DEFAULT_DB_RELATIVE}`,
      );
    }
    this.path = path;
    this.sessionsDir = resolve(dirname(path), "sessions");
    this.db = new Database(path, { readonly: true });

    // WAL is set by the tracer when it creates the db; a readonly connection
    // cannot change it, so we assert rather than set, and always take the
    // busy_timeout so a concurrent writer never turns into a failed request.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    const mode = this.db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get();
    this.journalMode = mode?.journal_mode ?? "unknown";
    if (this.journalMode.toLowerCase() !== "wal") {
      console.warn(
        `[db] journal_mode is "${this.journalMode}", expected "wal" — ` +
          `live reads during agent writes may block`,
      );
    }

  }

  /**
   * A SELECT fragment for a column the tracer adds by migration.
   *
   * We open readonly and cannot run those ALTERs ourselves, so selecting one
   * blindly would throw "no such column" on every request against a db an older
   * tracer wrote. Instead we probe and substitute NULL, which reads downstream
   * as "this db predates the column" — the same thing the UI shows for a row
   * the migration didn't backfill.
   *
   * The probe re-runs while the column is missing, because the tracer's ALTER
   * can land while we're serving: a startup-only check would keep returning
   * NULL for the rest of the process even after the data arrived. Once seen,
   * a column never goes away, so it latches.
   */
  private hasColumn(table: string, column: string): boolean {
    const key = `${table}.${column}`;
    if (!this.columnCache.get(key)) {
      const cols = this.db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all();
      this.columnCache.set(key, cols.some((c) => c.name === column));
    }
    return this.columnCache.get(key) ?? false;
  }

  private optionalColumn(table: string, column: string): string {
    return this.hasColumn(table, column) ? column : `NULL AS ${column}`;
  }

  private hasTable(table: string): boolean {
    if (!this.tableCache.get(table)) {
      const row = this.db
        .query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(table);
      this.tableCache.set(table, Boolean(row));
    }
    return this.tableCache.get(table) ?? false;
  }

  close(): void {
    this.writer?.close();
    this.db.close();
  }

  /** Lazily open the connection reserved for explicit human mutations. */
  private writable(): Database {
    if (!this.writer) {
      this.writer = new Database(this.path);
      this.writer.exec("PRAGMA busy_timeout=5000;");
    }
    return this.writer;
  }

  /**
   * Archive or restore a session.
   *
   * busy_timeout matters: a run may be mid-insert on the same WAL db, and a
   * click should wait its turn rather than fail. Returns false when the id
   * does not exist, so the route can 404 instead of silently succeeding.
   */
  setArchived(adwId: string, archived: boolean): boolean {
    if (!this.hasColumn("sessions", "archived")) {
      throw new Error("this db predates the archived column — run any ADW once to migrate it");
    }
    const result = this.writable()
      .query("UPDATE sessions SET archived = ? WHERE adw_id = ?")
      .run(archived ? 1 : 0, adwId);
    return result.changes > 0;
  }

  /**
   * Permanently remove an archived session's database projections and raw tree.
   *
   * The archive check and fixed, exact-id cascade share an immediate
   * transaction. An existing raw path is first renamed to a same-parent
   * tombstone; any failure before commit restores it, while successful commit
   * is followed by recursive tombstone cleanup.
   */
  deleteArchivedSession(adwId: string): DeleteArchivedSessionResult {
    const target = resolve(this.sessionsDir, adwId);
    if (
      !SAFE_SESSION_ID.test(adwId) ||
      adwId === "." ||
      adwId === ".." ||
      dirname(target) !== this.sessionsDir
    ) {
      throw new Error("invalid adw_id");
    }

    const writer = this.writable();
    let stagedPath: string | null = null;
    const remove = writer.transaction((): DeleteArchivedSessionResult => {
      const exists = writer
        .query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM sessions WHERE adw_id = ?",
        )
        .get(adwId);
      if (!exists) return "not_found";

      const archivedColumn = writer
        .query<{ name: string }, []>("PRAGMA table_info(sessions)")
        .all()
        .some((column) => column.name === "archived");
      if (!archivedColumn) return "unsupported_archive_state";

      const row = writer
        .query<{ archived: unknown }, [string]>(
          "SELECT archived FROM sessions WHERE adw_id = ?",
        )
        .get(adwId);
      if (!row || row.archived !== 1) return "not_archived";

      if (existsSync(target)) {
        const tombstone = resolve(
          this.sessionsDir,
          `.sssf-delete-${adwId}-${randomUUID()}`,
        );
        renameSync(target, tombstone);
        stagedPath = tombstone;
      }

      const tables = [
        "subagent_activities",
        "subagent_turns",
        "subagents",
        "events",
        "envelopes",
        "gate_results",
        "processes",
        "agent_sessions",
        "phases",
        "sessions",
      ] as const;
      for (const table of tables) {
        if (table === "sessions" || this.hasTable(table)) {
          writer.query(`DELETE FROM ${table} WHERE adw_id = ?`).run(adwId);
        }
      }
      return "deleted";
    });

    let result: DeleteArchivedSessionResult;
    try {
      result = remove.immediate();
    } catch (error) {
      if (stagedPath) {
        try {
          renameSync(stagedPath, target);
        } catch (restoreError) {
          throw new Error(
            `session deletion failed and raw data could not be restored: ${(restoreError as Error).message}`,
            { cause: restoreError },
          );
        }
      }
      throw error;
    }

    if (result === "deleted" && stagedPath) {
      rmSync(stagedPath, { recursive: true, force: true });
    }
    return result;
  }

  /** Sessions, most recent first, with all bounded card projections embedded. */
  sessions(limit = 200, archived = false): SessionSummary[] {
    const hasArchived = this.hasColumn("sessions", "archived");
    // A legacy db has no archived collection, but its active rows still work.
    if (archived && !hasArchived) return [];

    const rows = this.db
      .query<Session, [number, number]>(
        `SELECT adw_id, ${this.optionalColumn("sessions", "adw_name")}, request,
                status, engineer, started_at, ended_at,
                total_tokens, total_cost,
                ${this.optionalColumn("sessions", "archived")}
           FROM sessions
          WHERE COALESCE(${hasArchived ? "archived" : "0"}, 0) = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(archived ? 1 : 0, clamp(limit, 1, MAX_LIMIT));

    if (rows.length === 0) return [];

    // Embed each session's phases so the L1 progress dots cost no extra request.
    const ids = rows.map((row) => row.adw_id);
    const placeholders = ids.map(() => "?").join(", ");
    const phaseRows = this.db
      .query<Phase, string[]>(
        `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                attempt, retries, error, started_at, ended_at
           FROM phases WHERE adw_id IN (${placeholders}) ORDER BY seq, rowid`,
      )
      .all(...ids);

    const byAdw = new Map<string, Phase[]>();
    for (const phase of phaseRows) {
      const list = byAdw.get(phase.adw_id);
      if (list) list.push(phase);
      else byAdw.set(phase.adw_id, [phase]);
    }

    // Agents and compact timeline markers come along too: the browser performs
    // no per-card requests, regardless of how many sessions the list contains.
    const agentsByAdw = this.agentsFor(ids);
    const timelineByAdw = this.cardTimelines(ids);

    const summaries: SessionSummary[] = [];
    for (const session of rows) {
      const phases = byAdw.get(session.adw_id) ?? [];
      const projected = timelineByAdw.get(session.adw_id) ?? { markers: [], count: 0 };
      summaries.push(
        Object.assign(session, {
          phases,
          phase_count: phases.length,
          agents: agentsByAdw.get(session.adw_id) ?? [],
          timeline: projected.markers,
          timeline_marker_count: projected.count,
          timeline_truncated: projected.count > projected.markers.length,
        }),
      );
    }
    return summaries;
  }

  /**
   * One batched SQL projection for every card in a list response.
   *
   * Window ranks let SQLite return at most CARD_TIMELINE_MARKER_LIMIT rows per
   * session even for huge traces. The deterministic buckets retain the first
   * and newest eligible activity and spread the remaining markers over time.
   */
  private cardTimelines(
    adwIds: string[],
  ): Map<string, { markers: CardTimelineMarker[]; count: number }> {
    const byAdw = new Map<string, { markers: CardTimelineMarker[]; count: number }>();
    if (adwIds.length === 0) return byAdw;

    const ids = adwIds.map(() => "?").join(", ");
    const types = CARD_TIMELINE_TYPES.map(() => "?").join(", ");
    const cap = CARD_TIMELINE_MARKER_LIMIT;
    const rows = this.db
      .query<CardTimelineMarker & { marker_count: number }, string[]>(
        `WITH ranked AS (
           SELECT rowid, event_id, adw_id, phase_id, type, name, started_at,
                  COUNT(*) OVER (PARTITION BY adw_id) AS marker_count,
                  ROW_NUMBER() OVER (
                    PARTITION BY adw_id ORDER BY started_at, rowid
                  ) AS marker_rank
             FROM events
            WHERE adw_id IN (${ids}) AND type IN (${types})
         )
         SELECT rowid, event_id, adw_id, phase_id, type, name, started_at,
                marker_count
           FROM ranked
          WHERE marker_count <= ${cap}
             OR marker_rank = 1
             OR CAST((marker_rank - 1) * (${cap} - 1) / (marker_count - 1) AS INTEGER)
                > CAST((marker_rank - 2) * (${cap} - 1) / (marker_count - 1) AS INTEGER)
          ORDER BY adw_id, started_at, rowid`,
      )
      .all(...adwIds, ...CARD_TIMELINE_TYPES);

    for (const row of rows) {
      let projection = byAdw.get(row.adw_id);
      if (!projection) {
        projection = { markers: [], count: row.marker_count };
        byAdw.set(row.adw_id, projection);
      }
      const { marker_count: _markerCount, ...marker } = row;
      projection.markers.push(marker);
    }
    return byAdw;
  }

  session(adwId: string): Session | null {
    return (
      this.db
        .query<Session, [string]>(
          `SELECT adw_id, ${this.optionalColumn("sessions", "adw_name")}, request,
                  status, engineer, started_at, ended_at,
                  total_tokens, total_cost,
                  ${this.optionalColumn("sessions", "archived")}
             FROM sessions WHERE adw_id = ?`,
        )
        .get(adwId) ?? null
    );
  }

  phases(adwId: string): Phase[] {
    return this.db
      .query<Phase, [string]>(
        `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                attempt, retries, error, started_at, ended_at
           FROM phases WHERE adw_id = ? ORDER BY seq, rowid`,
      )
      .all(adwId);
  }

  agentSessions(adwId: string): AgentSession[] {
    return this.agentsFor([adwId]).get(adwId) ?? [];
  }

  /**
   * Agents per session, for a set of ids at once: the agent_sessions rows plus
   * anything that has started but not finished.
   *
   * agents.py writes the agent_sessions row only after the envelope persists, so
   * a running agent has no row there — precisely the case the live view exists
   * for. Its model, color and session_id are already on the agent_start event,
   * so a lane is labelled and colored from the moment the agent spawns.
   */
  private agentsFor(adwIds: string[]): Map<string, AgentSession[]> {
    const byAdw = new Map<string, AgentSession[]>();
    if (adwIds.length === 0) return byAdw;
    const placeholders = adwIds.map(() => "?").join(", ");

    const append = (adwId: string, agent: AgentSession) => {
      const list = byAdw.get(adwId);
      if (list) list.push(agent);
      else byAdw.set(adwId, [agent]);
    };

    const color = this.optionalColumn("agent_sessions", "color");
    const ctxUsed = this.optionalColumn("agent_sessions", "context_tokens");
    const ctxWindow = this.optionalColumn("agent_sessions", "context_window");

    const completed = this.db
      .query<AgentSession, string[]>(
        `SELECT adw_id, agent, coding_agent, model, session_id, ${color},
                ${ctxUsed}, ${ctxWindow}, created_at, last_used_at
           FROM agent_sessions WHERE adw_id IN (${placeholders})
          ORDER BY created_at, agent`,
      )
      .all(...adwIds);
    for (const row of completed) append(row.adw_id, row);

    const started = this.db
      .query<
        {
          adw_id: string;
          agent: string | null;
          payload_json: string | null;
          started_at: string | null;
        },
        string[]
      >(
        `SELECT e.adw_id, p.owner AS agent, e.payload_json, e.started_at
           FROM events e JOIN phases p ON p.phase_id = e.phase_id
          WHERE e.adw_id IN (${placeholders}) AND e.type = 'agent_start'
          ORDER BY e.rowid`,
      )
      .all(...adwIds);

    for (const row of started) {
      if (!row.agent) continue;
      // A finished row is authoritative; only fill genuine gaps.
      if (byAdw.get(row.adw_id)?.some((a) => a.agent === row.agent)) continue;
      let payload: AgentStartPayload = {};
      try {
        payload = JSON.parse(row.payload_json ?? "{}") as AgentStartPayload;
      } catch {
        // A malformed payload just means no label — never a failed request.
      }
      append(row.adw_id, {
        adw_id: row.adw_id,
        agent: row.agent,
        coding_agent: null,
        model: payload.model ?? null,
        session_id: payload.session_id ?? null,
        color: payload.color ?? null,
        // Occupancy is only known once the agent's turn closes.
        context_tokens: null,
        context_window: null,
        created_at: row.started_at,
        last_used_at: row.started_at,
      });
    }
    return byAdw;
  }

  /** Unified configured-phase and nested-child roster used only by the trace. */
  traceAgents(adwId: string): TraceAgent[] {
    const phases = this.phases(adwId);
    const sessions = this.agentSessions(adwId);
    const configured: ConfiguredAgent[] = [];

    for (const phase of phases) {
      if (phase.kind !== "agent") continue;
      const info = sessions.find((row) => row.agent === phase.owner);
      const events = this.db.query<Event, [string, string]>(
        `SELECT rowid,event_id,adw_id,phase_id,parent_id,type,name,payload_json,tokens,started_at,ended_at
           FROM events WHERE adw_id=? AND phase_id=? ORDER BY rowid`,
      ).all(adwId, phase.phase_id);
      const start = events.find((event) => event.type === "agent_start");
      let payload: AgentStartPayload = {};
      try { payload = JSON.parse(start?.payload_json ?? "{}") as AgentStartPayload; } catch { /* optional metadata */ }
      const toolCount = events.filter((event) => event.type === "tool_call").length;
      const startedAt = phase.started_at ?? start?.started_at ?? null;
      const endedAt = phase.status === "running" ? null : phase.ended_at;
      configured.push({
        agent_id: phase.phase_id,
        source: "configured",
        adw_id: adwId,
        phase_id: phase.phase_id,
        parent_agent_id: null,
        name: phase.owner ?? phase.name ?? "agent",
        task: phase.description,
        status: phase.status,
        created_at: info?.created_at ?? startedAt,
        started_at: startedAt,
        ended_at: endedAt,
        duration_ms: durationMs(startedAt, endedAt),
        model: info?.model ?? payload.model ?? null,
        thinking: payload.thinking ?? null,
        turn_count: events.filter((event) => event.type === "agent_start").length,
        tool_count: toolCount,
        agent: phase.owner ?? phase.name ?? "agent",
        coding_agent: info?.coding_agent ?? payload.coding_agent ?? null,
        session_id: info?.session_id ?? payload.session_id ?? null,
        color: info?.color ?? payload.color ?? null,
        context_tokens: info?.context_tokens ?? null,
        context_window: info?.context_window ?? null,
        last_used_at: info?.last_used_at ?? endedAt,
        phase_name: phase.name,
        phase_seq: phase.seq,
        phase_status: phase.status,
        phase_attempt: phase.attempt,
        phase_retries: phase.retries,
      });
    }

    const children = this.storedSubagents(adwId).map((row): NestedAgent => ({
      agent_id: row.subagent_id,
      source: "nested",
      adw_id: row.adw_id,
      phase_id: row.phase_id,
      parent_agent_id: configured.some((agent) => agent.agent_id === row.phase_id)
        ? row.phase_id
        : configured.filter((agent) => agent.agent === row.parent_agent).length === 1
          ? configured.find((agent) => agent.agent === row.parent_agent)!.agent_id
          : null,
      name: `#${row.display_id ?? "?"} · ${row.subagent_id}`,
      task: row.task,
      status: row.status,
      created_at: row.created_at,
      started_at: row.started_at,
      // A continuation can be running while the conversation still carries the prior end.
      ended_at: row.status === "running" ? null : row.ended_at,
      duration_ms: row.status === "running" ? null : row.duration_ms,
      model: row.model,
      thinking: row.thinking,
      turn_count: row.turn_count,
      tool_count: row.tool_count,
      subagent_id: row.subagent_id,
      display_id: row.display_id,
      parent_agent: row.parent_agent,
      parent_tool_call_id: row.parent_tool_call_id,
      parent_event_id: row.parent_event_id,
      session_path: row.session_path,
      removed_at: row.removed_at,
    }));

    const childrenByParent = new Map<string | null, NestedAgent[]>();
    for (const child of children) {
      const list = childrenByParent.get(child.parent_agent_id) ?? [];
      list.push(child);
      childrenByParent.set(child.parent_agent_id, list);
    }
    const roster: TraceAgent[] = [];
    for (const agent of configured) roster.push(agent, ...(childrenByParent.get(agent.agent_id) ?? []));
    roster.push(...(childrenByParent.get(null) ?? []));
    return roster;
  }

  /** Session + phases + unified agents in one shot — L2 needs all three to draw lanes. */
  sessionDetail(adwId: string): SessionDetail | null {
    const session = this.session(adwId);
    if (!session) return null;

    return {
      session,
      usage: this.usage(adwId),
      phases: this.phases(adwId),
      agents: this.traceAgents(adwId),
    };
  }

  /**
   * Raw tokens read and written, beside the billed headline.
   *
   * Derived from the `agent_end` payloads rather than stored, so every run
   * already in the db gets the split without a migration or a re-run.
   *
   * `total_tokens` is a SPEND number: every turn re-sends the whole
   * conversation, so an 86k conversation over 49 turns bills millions. These
   * two say what actually moved — material read for the first time, and
   * material generated. The gap between them and the headline is cached
   * re-reads, which is usually most of it.
   */
  usage(adwId: string): SessionUsage {
    const rows = this.db
      .query<{ payload_json: string | null }, [string]>(
        "SELECT payload_json FROM events WHERE adw_id = ? AND type = 'agent_end'",
      )
      .all(adwId);

    let read = 0;
    let written = 0;
    for (const row of rows) {
      if (!row.payload_json) continue;
      try {
        const u = (JSON.parse(row.payload_json) as { usage?: Record<string, number> }).usage;
        if (!u) continue;
        // RAW reads only: material entering the context for the first time,
        // billed either as uncached input or as a cache write. Cache reads are
        // the same tokens served again on later turns — counting them here
        // would rebuild the very inflation this split exists to expose.
        read += (u.input_tokens ?? 0) + (u.cache_write_tokens ?? 0);
        written += u.output_tokens ?? 0;
      } catch {
        /* a payload written by an older tracer simply contributes nothing */
      }
    }
    return { read, written };
  }

  /**
   * The polling query. Rowid cursor, insertion order, bounded page — the same
   * mechanism serves the live tail and lazy-paged history.
   */
  events(adwId: string, after = 0, limit = DEFAULT_LIMIT): EventsPage {
    const cappedLimit = clamp(limit, 1, MAX_LIMIT);
    const events = this.db
      .query<Event, [string, number, number]>(
        `SELECT rowid, event_id, adw_id, phase_id, parent_id, type, name,
                payload_json, tokens, started_at, ended_at
           FROM events
          WHERE adw_id = ? AND rowid > ?
          ORDER BY rowid
          LIMIT ?`,
      )
      .all(adwId, Math.max(0, after), cappedLimit);

    return {
      events,
      cursor: events.length > 0 ? events[events.length - 1]!.rowid : Math.max(0, after),
      has_more: events.length === cappedLimit,
    };
  }

  /** Storage adapter for nested telemetry; it never escapes as a second API model. */
  private storedSubagents(adwId: string): StoredSubagent[] {
    if (!this.hasTable("subagents") || !this.hasTable("subagent_turns")) return [];
    return this.db.query<StoredSubagent, [string]>(
      `SELECT s.subagent_id,s.adw_id,s.phase_id,s.parent_agent,s.display_id,
              s.parent_tool_call_id,s.parent_event_id,s.task,
              (SELECT t.model FROM subagent_turns t
                WHERE t.adw_id=s.adw_id AND t.subagent_id=s.subagent_id
                ORDER BY t.turn DESC LIMIT 1) AS model,
              (SELECT t.thinking FROM subagent_turns t
                WHERE t.adw_id=s.adw_id AND t.subagent_id=s.subagent_id
                ORDER BY t.turn DESC LIMIT 1) AS thinking,
              s.session_path,s.status,s.created_at,s.started_at,s.ended_at,s.duration_ms,
              s.removed_at,
              (SELECT COUNT(*) FROM subagent_turns t
                WHERE t.adw_id=s.adw_id AND t.subagent_id=s.subagent_id) AS turn_count,
              (SELECT COALESCE(SUM(t.tool_count),0) FROM subagent_turns t
                WHERE t.adw_id=s.adw_id AND t.subagent_id=s.subagent_id) AS tool_count
         FROM subagents s WHERE s.adw_id=? ORDER BY s.created_at,s.rowid`,
    ).all(adwId);
  }

  agent(adwId: string, agentId: string): AgentDetail | null {
    const summary = this.traceAgents(adwId).find((row) => row.agent_id === agentId);
    if (!summary) return null;
    if (summary.source === "configured") return { ...summary, turns: [] };
    const turns = this.db.query<AgentTurn, [string, string]>(
      `SELECT turn_id,subagent_id AS agent_id,turn,parent_tool_call_id,parent_event_id,prompt,model,
              thinking,pid,status,started_at,ended_at,duration_ms,result,error,tool_count,
              raw_output_path,session_path
         FROM subagent_turns WHERE adw_id=? AND subagent_id=? ORDER BY turn`,
    ).all(adwId, agentId);
    return { ...summary, turns };
  }

  agentActivities(
    adwId: string,
    agentId: string,
    after = 0,
    limit = DEFAULT_LIMIT,
  ): AgentActivitiesPage | null {
    const summary = this.traceAgents(adwId).find((row) => row.agent_id === agentId);
    if (!summary) return null;
    const cappedLimit = clamp(limit, 1, MAX_LIMIT);
    if (summary.source === "nested") {
      if (!this.hasTable("subagent_activities")) {
        return { activities: [], cursor: Math.max(0, after), has_more: false };
      }
      const activities = this.db.query<AgentActivity, [string, string, number, number]>(
        `SELECT id AS cursor,telemetry_id,activity_id,subagent_id AS agent_id,turn,
                tool_call_id,tool,args_json,result_snippet,ok,started_at,ended_at,duration_ms
           FROM subagent_activities WHERE adw_id=? AND subagent_id=? AND id>?
          ORDER BY id LIMIT ?`,
      ).all(adwId, agentId, Math.max(0, after), cappedLimit);
      return {
        activities,
        cursor: activities.at(-1)?.cursor ?? Math.max(0, after),
        has_more: activities.length === cappedLimit,
      };
    }

    const events = this.db.query<Event, [string, string, number, number]>(
      `SELECT rowid,event_id,adw_id,phase_id,parent_id,type,name,payload_json,tokens,started_at,ended_at
         FROM events WHERE adw_id=? AND phase_id=? AND type='tool_call' AND rowid>?
        ORDER BY rowid LIMIT ?`,
    ).all(adwId, summary.phase_id, Math.max(0, after), cappedLimit);
    const activities = events.map((event): AgentActivity => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(event.payload_json ?? "{}") as Record<string, unknown>; } catch { /* raw legacy call */ }
      const args = payload.args;
      return {
        cursor: event.rowid,
        telemetry_id: event.event_id,
        activity_id: event.event_id,
        agent_id: summary.agent_id,
        turn: null,
        tool_call_id: typeof payload.tool_call_id === "string" ? payload.tool_call_id : null,
        tool: typeof payload.tool === "string" ? payload.tool : event.name,
        args_json: args === undefined ? null : JSON.stringify(args),
        result_snippet: typeof payload.result_snippet === "string" ? payload.result_snippet : null,
        ok: typeof payload.ok === "boolean" ? Number(payload.ok) : null,
        started_at: event.started_at,
        ended_at: event.ended_at,
        duration_ms: typeof payload.duration_ms === "number" ? payload.duration_ms : durationMs(event.started_at, event.ended_at),
      };
    });
    return {
      activities,
      cursor: activities.at(-1)?.cursor ?? Math.max(0, after),
      has_more: activities.length === cappedLimit,
    };
  }

  envelopes(adwId: string): Envelope[] {
    return this.db
      .query<Envelope, [string]>(
        `SELECT envelope_id, adw_id, phase_id, agent, output_type, payload_json,
                valid, attempt, created_at
           FROM envelopes WHERE adw_id = ? ORDER BY created_at, rowid`,
      )
      .all(adwId);
  }

  gates(adwId: string): GateResult[] {
    const checks = this.optionalColumn("gate_results", "checks_json");
    return this.db
      .query<GateResult, [string]>(
        `SELECT id, adw_id, phase_id, attempt, gate, passed, violations_json,
                ${checks}, created_at
           FROM gate_results WHERE adw_id = ? ORDER BY id`,
      )
      .all(adwId);
  }

  sessionCount(): number {
    const row = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions")
      .get();
    return row?.n ?? 0;
  }
}

function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  const start = Date.parse(startedAt ?? "");
  const end = Date.parse(endedAt ?? "");
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
