import type {
  SubagentActivity,
  SubagentDetail,
  SubagentStatus,
  SubagentSummary,
  SubagentTurn,
} from './types'
import { ts } from './format'

const STATUSES = new Set<SubagentStatus>([
  'running', 'success', 'error', 'cancelled', 'killed', 'interrupted',
])

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeStatus(value: unknown): SubagentStatus | null {
  return typeof value === 'string' && STATUSES.has(value as SubagentStatus)
    ? (value as SubagentStatus)
    : null
}

/** Legacy/malformed payloads remain selectable instead of crashing the trace. */
export function normalizeSubagents(value: unknown): SubagentSummary[] {
  if (!Array.isArray(value)) return []
  return value.map((raw, index) => {
    const row = object(raw)
    return {
      subagent_id: nullableString(row.subagent_id) ?? `unknown-${index + 1}`,
      adw_id: nullableString(row.adw_id) ?? '',
      phase_id: nullableString(row.phase_id),
      parent_agent: nullableString(row.parent_agent),
      display_id: nullableNumber(row.display_id),
      parent_tool_call_id: nullableString(row.parent_tool_call_id),
      parent_event_id: nullableString(row.parent_event_id),
      task: nullableString(row.task) ?? (Object.keys(row).length ? JSON.stringify(row) : String(raw)),
      model: nullableString(row.model),
      thinking: nullableString(row.thinking),
      session_path: nullableString(row.session_path),
      status: normalizeStatus(row.status),
      created_at: nullableString(row.created_at),
      started_at: nullableString(row.started_at),
      ended_at: nullableString(row.ended_at),
      duration_ms: nullableNumber(row.duration_ms),
      removed_at: nullableString(row.removed_at),
      turn_count: nullableNumber(row.turn_count) ?? 0,
      tool_count: nullableNumber(row.tool_count) ?? 0,
    }
  })
}

function normalizeTurn(value: unknown, childId: string, index: number): SubagentTurn {
  const row = object(value)
  const turn = nullableNumber(row.turn) ?? index + 1
  return {
    turn_id: nullableString(row.turn_id) ?? `${childId}:${turn}`,
    subagent_id: nullableString(row.subagent_id) ?? childId,
    turn,
    parent_tool_call_id: nullableString(row.parent_tool_call_id),
    parent_event_id: nullableString(row.parent_event_id),
    prompt: nullableString(row.prompt) ?? (Object.keys(row).length ? JSON.stringify(row) : String(value)),
    model: nullableString(row.model), thinking: nullableString(row.thinking),
    pid: nullableNumber(row.pid), status: normalizeStatus(row.status),
    started_at: nullableString(row.started_at), ended_at: nullableString(row.ended_at),
    duration_ms: nullableNumber(row.duration_ms), result: nullableString(row.result),
    error: nullableString(row.error), tool_count: nullableNumber(row.tool_count),
    raw_output_path: nullableString(row.raw_output_path), session_path: nullableString(row.session_path),
  }
}

export function normalizeSubagentDetail(value: unknown): SubagentDetail {
  const row = object(value)
  const summary = normalizeSubagents([row])[0]!
  const turns = Array.isArray(row.turns)
    ? row.turns.map((turn, index) => normalizeTurn(turn, summary.subagent_id, index))
        .toSorted((a, b) => a.turn - b.turn)
    : []
  return { ...summary, turns }
}

export function isSubagentRunning(status: SubagentStatus | null): boolean {
  return status === 'running'
}

export function subagentDuration(
  startedAt: string | null,
  endedAt: string | null,
  storedMs: number | null,
  nowMs: number,
): number {
  if (storedMs !== null && endedAt) return storedMs
  const start = ts(startedAt)
  const end = endedAt ? ts(endedAt) : nowMs
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : NaN
}

/** Merge cursor pages without duplicating an activity after a retry. */
export function mergeActivities(
  existing: SubagentActivity[],
  incoming: SubagentActivity[],
): SubagentActivity[] {
  const byCursor = new Map(existing.map((activity) => [activity.cursor, activity]))
  for (const activity of incoming) byCursor.set(activity.cursor, activity)
  return [...byCursor.values()].toSorted((a, b) => a.cursor - b.cursor)
}
