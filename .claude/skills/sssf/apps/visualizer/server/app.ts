import { join, resolve, sep } from "node:path";
import type { AgentPrompts, ApiError, HealthResponse } from "../shared/types.ts";
import type { SssfDb } from "./db.ts";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function notFound(message: string): Response {
  return json({ error: message } satisfies ApiError, 404);
}

function safely(handler: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req);
    } catch (error) {
      console.error(`[sssf] ${req.method} ${new URL(req.url).pathname}:`, error);
      return json({ error: (error as Error).message } satisfies ApiError, 500);
    }
  };
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
function safe(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== "." && value !== "..";
}
function param(req: Request, key: string): string {
  return decodeURIComponent((req as Request & { params: Record<string, string> }).params[key] ?? "");
}
function queryInt(req: Request, key: string, fallback: number): number | null {
  const raw = new URL(req.url).searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}
function validIds(req: Request): { adwId: string; childId: string } | null {
  const adwId = param(req, "adw_id");
  const childId = param(req, "subagent_id");
  return safe(adwId) && safe(childId) ? { adwId, childId } : null;
}

/** API-only route factory: importing it never binds a port. */
export function createApiRoutes(db: SssfDb) {
  return {
    "/api/health": safely(() => json({
      ok: true, db: db.path, journal_mode: db.journalMode, sessions: db.sessionCount(),
    } satisfies HealthResponse)),
    "/api/sessions": safely((req) => {
      const archived = new URL(req.url).searchParams.get("archived") ?? "0";
      const limit = queryInt(req, "limit", 200);
      if ((archived !== "0" && archived !== "1") || limit === null) {
        return json({ error: "invalid archived or limit query" } satisfies ApiError, 400);
      }
      return json(db.sessions(limit, archived === "1"));
    }),
    "/api/sessions/:adw_id": safely((req) => {
      const id = param(req, "adw_id");
      if (!safe(id)) return json({ error: "invalid adw_id" } satisfies ApiError, 400);
      const detail = db.sessionDetail(id);
      return detail ? json(detail) : notFound(`no session ${id}`);
    }),
    "/api/sessions/:adw_id/archive": {
      POST: safely(async (req) => {
        const id = param(req, "adw_id");
        if (!safe(id)) return json({ error: "invalid adw_id" } satisfies ApiError, 400);
        const body = (await req.json().catch(() => ({}))) as { archived?: unknown };
        if (body.archived !== undefined && typeof body.archived !== "boolean") {
          return json({ error: "archived must be a boolean" } satisfies ApiError, 400);
        }
        const archived = body.archived ?? true;
        return db.setArchived(id, archived) ? json({ adw_id: id, archived }) : notFound(`no session ${id}`);
      }),
    },
    "/api/sessions/:adw_id/events": safely((req) => {
      const after = queryInt(req, "after", 0);
      const limit = queryInt(req, "limit", 500);
      if (after === null || limit === null) return json({ error: "invalid cursor query" } satisfies ApiError, 400);
      return json(db.events(param(req, "adw_id"), after, limit));
    }),
    "/api/sessions/:adw_id/envelopes": safely((req) => json(db.envelopes(param(req, "adw_id")))),
    "/api/sessions/:adw_id/gates": safely((req) => json(db.gates(param(req, "adw_id")))),
    "/api/sessions/:adw_id/subagents": safely((req) => {
      const adwId = param(req, "adw_id");
      if (!safe(adwId)) return json({ error: "invalid adw_id" } satisfies ApiError, 400);
      if (!db.session(adwId)) return notFound(`no session ${adwId}`);
      return json(db.subagents(adwId));
    }),
    "/api/sessions/:adw_id/subagents/:subagent_id": safely((req) => {
      const ids = validIds(req);
      if (!ids) return json({ error: "invalid adw_id or subagent_id" } satisfies ApiError, 400);
      const child = db.subagent(ids.adwId, ids.childId);
      return child ? json(child) : notFound(`no subagent ${ids.childId} in session ${ids.adwId}`);
    }),
    "/api/sessions/:adw_id/subagents/:subagent_id/activity": safely((req) => {
      const ids = validIds(req);
      const after = queryInt(req, "after", 0);
      const limit = queryInt(req, "limit", 500);
      if (!ids || after === null || limit === null) return json({ error: "invalid path or cursor query" } satisfies ApiError, 400);
      const page = db.subagentActivities(ids.adwId, ids.childId, after, limit);
      return page ? json(page) : notFound(`no subagent ${ids.childId} in session ${ids.adwId}`);
    }),
    "/api/sessions/:adw_id/agents/:agent/prompts": safely(async (req) => {
      const adwId = param(req, "adw_id");
      const agent = param(req, "agent");
      if (!safe(adwId) || !safe(agent)) return json({ error: "invalid adw_id or agent" } satisfies ApiError, 400);
      if (!db.session(adwId)) return notFound(`no session ${adwId}`);
      const dir = resolve(db.sessionsDir, adwId, agent, "prompts");
      if (dir !== db.sessionsDir && !dir.startsWith(db.sessionsDir + sep)) return json({ error: "invalid path" } satisfies ApiError, 400);
      const read = async (name: string): Promise<string | null> => {
        const file = Bun.file(join(dir, `${name}.md`));
        return (await file.exists()) ? await file.text() : null;
      };
      return json({ system: await read("system"), user: await read("user") } satisfies AgentPrompts);
    }),
  };
}
