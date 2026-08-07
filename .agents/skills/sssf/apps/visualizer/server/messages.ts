import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type {
  AgentDetail,
  AgentMessage,
  AgentMessageRole,
  AgentMessagesPage,
} from "../shared/types.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function safeSegment(value: unknown): value is string {
  return typeof value === "string" && SAFE_SEGMENT.test(value) && value !== "." && value !== "..";
}

function within(base: string, target: string): boolean {
  return target === base || target.startsWith(base + sep);
}

type SafePath = { state: "safe"; path: string } | { state: "missing" | "unsafe" };

/** Check both the constructed spelling and every resolved symlink target. */
function safeExisting(base: string, candidate: string, kind: "file" | "directory"): SafePath {
  const lexicalBase = resolve(base);
  const lexicalCandidate = resolve(candidate);
  if (!within(lexicalBase, lexicalCandidate)) return { state: "unsafe" };
  if (!existsSync(lexicalCandidate)) return { state: "missing" };
  try {
    const realBase = realpathSync(lexicalBase);
    const realCandidate = realpathSync(lexicalCandidate);
    if (!within(realBase, realCandidate)) return { state: "unsafe" };
    const stat = statSync(realCandidate);
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) return { state: "unsafe" };
    return { state: "safe", path: realCandidate };
  } catch {
    return { state: "unsafe" };
  }
}

function scopedRoot(sessionsDir: string, adwId: string): SafePath {
  if (!safeSegment(adwId)) return { state: "unsafe" };
  const sessions = safeExisting(resolve(sessionsDir), resolve(sessionsDir), "directory");
  if (sessions.state !== "safe") return sessions;
  const candidate = resolve(sessionsDir, adwId);
  const root = safeExisting(sessions.path, candidate, "directory");
  if (root.state !== "safe") return root;
  // Reject an adw directory symlink that resolves outside the concrete sessions tree.
  return within(sessions.path, root.path) ? root : { state: "unsafe" };
}

interface SourceFile {
  path: string;
  turn?: number;
}

interface SourceResult {
  available: boolean;
  files: SourceFile[];
  compact: boolean;
}

function configuredSource(root: string, agent: Extract<AgentDetail, { source: "configured" }>): SourceResult {
  if (!safeSegment(agent.agent)) return { available: false, files: [], compact: false };
  const agentDir = resolve(root, agent.agent);
  const raw = safeExisting(root, resolve(agentDir, "raw_output.jsonl"), "file");
  if (raw.state === "unsafe") return { available: false, files: [], compact: false };
  if (raw.state === "safe") return { available: true, files: [{ path: raw.path }], compact: false };

  const sessions = safeExisting(root, resolve(agentDir, "pi_sessions"), "directory");
  if (sessions.state !== "safe") return { available: false, files: [], compact: true };
  let candidates: string[];
  try {
    candidates = readdirSync(sessions.path)
      .filter((name) => safeSegment(name) && name.endsWith(".jsonl"))
      .map((name) => resolve(sessions.path, name));
  } catch {
    return { available: false, files: [], compact: true };
  }

  const safeCandidates: string[] = [];
  for (const candidate of candidates) {
    const checked = safeExisting(sessions.path, candidate, "file");
    if (checked.state === "unsafe") return { available: false, files: [], compact: true };
    if (checked.state === "safe") safeCandidates.push(checked.path);
  }
  const matching = agent.session_id
    ? safeCandidates.filter((path) => sessionId(path) === agent.session_id)
    : safeCandidates.length === 1 ? safeCandidates : [];
  return matching.length === 1
    ? { available: true, files: [{ path: matching[0]! }], compact: true }
    : { available: false, files: [], compact: true };
}

function nestedSource(root: string, agent: Extract<AgentDetail, { source: "nested" }>): SourceResult {
  if (!safeSegment(agent.parent_agent) || !safeSegment(agent.subagent_id)) {
    return { available: false, files: [], compact: false };
  }
  const child = resolve(root, agent.parent_agent, "subagents", agent.subagent_id);
  const turns = agent.turns
    .filter((turn) => Number.isSafeInteger(turn.turn) && turn.turn >= 0)
    .toSorted((a, b) => a.turn - b.turn);
  const rawFiles: SourceFile[] = [];
  for (const turn of turns) {
    const segment = String(turn.turn);
    if (!safeSegment(segment)) return { available: false, files: [], compact: false };
    const raw = safeExisting(root, resolve(child, `turn-${segment}`, "raw_output.jsonl"), "file");
    if (raw.state === "unsafe") return { available: false, files: [], compact: false };
    if (raw.state === "safe") rawFiles.push({ path: raw.path, turn: turn.turn });
  }
  // Raw wins for the whole conversation. Never fill missing turns from session.jsonl.
  if (rawFiles.length) return { available: true, files: rawFiles, compact: false };

  const fallback = safeExisting(root, resolve(child, "session.jsonl"), "file");
  return fallback.state === "safe"
    ? { available: true, files: [{ path: fallback.path }], compact: true }
    : { available: false, files: [], compact: true };
}

function sessionId(path: string): string | null {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      return value.type === "session" && typeof value.id === "string" ? value.id : null;
    }
  } catch {
    // A malformed candidate cannot be identified as the selected session.
  }
  return null;
}

function timestampOf(record: Record<string, unknown>, message: Record<string, unknown>): string | undefined {
  const value = message.timestamp ?? record.timestamp;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    try { return new Date(value).toISOString(); } catch { /* invalid provider timestamp */ }
  }
  return undefined;
}

function inConfiguredPhase(timestamp: string | undefined, agent: AgentDetail): boolean {
  if (agent.source !== "configured") return true;
  const start = Date.parse(agent.started_at ?? "");
  const end = Date.parse(agent.ended_at ?? "");
  if (!Number.isFinite(start) && !Number.isFinite(end)) return true;
  const time = Date.parse(timestamp ?? "");
  if (!Number.isFinite(time)) return false;
  return (!Number.isFinite(start) || time >= start) && (!Number.isFinite(end) || time <= end);
}

interface PendingMessage extends Omit<AgentMessage, "cursor" | "id"> {}

function visibleBlocks(record: Record<string, unknown>, turn: number | undefined): PendingMessage[] {
  const message = record.message;
  if (message === null || typeof message !== "object") return [];
  const row = message as Record<string, unknown>;
  const role = row.role;
  if (role !== "user" && role !== "assistant") return [];
  if (!Array.isArray(row.content)) return [];
  const timestamp = timestampOf(record, row);
  const result: PendingMessage[] = [];
  for (const value of row.content) {
    if (value === null || typeof value !== "object") continue;
    const block = value as Record<string, unknown>;
    let visibleRole: AgentMessageRole | null = null;
    let text: unknown;
    if (role === "user" && block.type === "text") {
      visibleRole = "user";
      text = block.text;
    } else if (role === "assistant" && block.type === "thinking") {
      visibleRole = "thinking";
      text = block.thinking;
    } else if (role === "assistant" && block.type === "text") {
      visibleRole = "assistant";
      text = block.text;
    }
    if (visibleRole === null || typeof text !== "string") continue;
    result.push({
      role: visibleRole,
      text,
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(turn === undefined ? {} : { turn }),
    });
  }
  return result;
}

function parseFile(file: SourceFile, compact: boolean, agent: AgentDetail): PendingMessage[] {
  let text: string;
  try { text = readFileSync(file.path, "utf8"); } catch { return []; }
  const messages: PendingMessage[] = [];
  // Splitting also tolerates a live final fragment: every malformed line is isolated.
  for (const line of text.split("\n")) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object") continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (compact ? record.type !== "message" : record.type !== "message_end") continue;
    const message = record.message;
    if (message === null || typeof message !== "object") continue;
    const timestamp = timestampOf(record, message as Record<string, unknown>);
    if (!inConfiguredPhase(timestamp, agent)) continue;
    messages.push(...visibleBlocks(record, file.turn));
  }
  return messages;
}

/**
 * Load a cursor page from safe Pi files selected solely from an already ADW-scoped detail.
 * Paths stored in SQLite are deliberately ignored.
 */
export function loadAgentMessages(
  sessionsDir: string,
  agent: AgentDetail,
  after = 0,
  limit = 200,
): AgentMessagesPage {
  const empty = (available = false): AgentMessagesPage => ({
    messages: [], cursor: after, has_more: false, available,
  });
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) return empty();
  const root = scopedRoot(sessionsDir, agent.adw_id);
  if (root.state !== "safe") return empty();
  const source = agent.source === "configured"
    ? configuredSource(root.path, agent)
    : nestedSource(root.path, agent);
  if (!source.available) return empty();

  const pending = source.files.flatMap((file) => parseFile(file, source.compact, agent));
  const all = pending.map((message, index): AgentMessage => Object.assign(message, {
    cursor: index + 1,
    id: `message-${index + 1}`,
  }));
  const messages = all.slice(after, after + limit);
  return {
    messages,
    cursor: messages.at(-1)?.cursor ?? after,
    has_more: after + messages.length < all.length,
    available: true,
  };
}
