import type {
  AgentActivity,
  AgentDetail,
  AgentStatus,
  AgentTurn,
  ConfiguredAgent,
  NestedAgent,
  TraceAgent,
} from './types'
import { ts } from './format'

const STATUSES = new Set<AgentStatus>([
  'queued', 'running', 'success', 'fail', 'error', 'cancelled', 'killed', 'interrupted',
])

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
const string = (value: unknown): string | null => typeof value === 'string' ? value : null
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
function status(value: unknown): AgentStatus | null {
  return typeof value === 'string' && STATUSES.has(value as AgentStatus) ? value as AgentStatus : null
}

/** Legacy and malformed rows remain visible and selectable instead of breaking the trace. */
export function normalizeAgents(value: unknown): TraceAgent[] {
  if (!Array.isArray(value)) return []
  return value.map((raw, index) => {
    const row = object(raw)
    const source = row.source === 'nested' ? 'nested' : 'configured'
    const agentId = string(row.agent_id)
      ?? (source === 'nested' ? string(row.subagent_id) : string(row.phase_id))
      ?? `unknown-${index + 1}`
    const common = {
      ...row,
      agent_id: agentId,
      source,
      adw_id: string(row.adw_id) ?? '',
      phase_id: string(row.phase_id),
      parent_agent_id: string(row.parent_agent_id),
      name: string(row.name) ?? string(row.agent) ?? agentId,
      task: string(row.task),
      status: status(row.status),
      created_at: string(row.created_at),
      started_at: string(row.started_at),
      ended_at: row.status === 'running' ? null : string(row.ended_at),
      duration_ms: row.status === 'running' ? null : number(row.duration_ms),
      model: string(row.model), thinking: string(row.thinking),
      turn_count: number(row.turn_count) ?? 0,
      tool_count: number(row.tool_count) ?? 0,
    }
    if (source === 'nested') {
      return {
        ...common,
        source: 'nested',
        subagent_id: string(row.subagent_id) ?? agentId,
        display_id: number(row.display_id), parent_agent: string(row.parent_agent),
        parent_tool_call_id: string(row.parent_tool_call_id), parent_event_id: string(row.parent_event_id),
        session_path: string(row.session_path), removed_at: string(row.removed_at),
      } as NestedAgent
    }
    return {
      ...common,
      source: 'configured', phase_id: string(row.phase_id) ?? agentId, parent_agent_id: null,
      agent: string(row.agent) ?? string(row.name) ?? agentId,
      coding_agent: string(row.coding_agent), session_id: string(row.session_id), color: string(row.color),
      context_tokens: number(row.context_tokens), context_window: number(row.context_window),
      last_used_at: string(row.last_used_at), phase_name: string(row.phase_name),
      phase_seq: number(row.phase_seq), phase_status: status(row.phase_status) as ConfiguredAgent['phase_status'],
      phase_attempt: number(row.phase_attempt), phase_retries: number(row.phase_retries),
    } as ConfiguredAgent
  })
}

function normalizeTurn(value: unknown, agentId: string, index: number): AgentTurn {
  const row = object(value)
  const turn = number(row.turn) ?? index + 1
  return {
    turn_id: string(row.turn_id) ?? `${agentId}:${turn}`, agent_id: string(row.agent_id) ?? string(row.subagent_id) ?? agentId,
    turn, parent_tool_call_id: string(row.parent_tool_call_id), parent_event_id: string(row.parent_event_id),
    prompt: string(row.prompt) ?? (Object.keys(row).length ? JSON.stringify(row) : String(value)),
    model: string(row.model), thinking: string(row.thinking), pid: number(row.pid), status: status(row.status),
    started_at: string(row.started_at), ended_at: string(row.ended_at), duration_ms: number(row.duration_ms),
    result: string(row.result), error: string(row.error), tool_count: number(row.tool_count),
    raw_output_path: string(row.raw_output_path), session_path: string(row.session_path),
  }
}

export function normalizeAgentDetail(value: unknown): AgentDetail {
  const row = object(value)
  const agent = normalizeAgents([row])[0]!
  const turns = Array.isArray(row.turns)
    ? row.turns.map((turn, index) => normalizeTurn(turn, agent.agent_id, index)).toSorted((a, b) => a.turn - b.turn)
    : []
  return { ...agent, turns } as AgentDetail
}

export function agentDuration(
  startedAt: string | null,
  endedAt: string | null,
  storedMs: number | null,
  nowMs: number,
  currentStatus?: AgentStatus | null,
): number {
  const running = currentStatus === 'running'
  if (!running && storedMs !== null && endedAt) return storedMs
  const start = ts(startedAt)
  const end = running || !endedAt ? nowMs : ts(endedAt)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : Number.NaN
}

/** Keep malformed/legacy activity rows inspectable while preserving cursor paging. */
export function normalizeActivities(value: unknown, fallbackAgentId = ''): AgentActivity[] {
  if (!Array.isArray(value)) return []
  return value.map((raw, index) => {
    const row = object(raw)
    const cursor = number(row.cursor) ?? index + 1
    return {
      cursor,
      telemetry_id: string(row.telemetry_id) ?? `unknown-${cursor}`,
      activity_id: string(row.activity_id),
      agent_id: string(row.agent_id) ?? string(row.subagent_id) ?? fallbackAgentId,
      turn: number(row.turn),
      tool_call_id: string(row.tool_call_id),
      tool: string(row.tool),
      args_json: string(row.args_json) ?? (row.args === undefined ? null : JSON.stringify(row.args)),
      result_snippet: string(row.result_snippet),
      ok: number(row.ok) ?? (typeof row.ok === 'boolean' ? Number(row.ok) : null),
      started_at: string(row.started_at),
      ended_at: string(row.ended_at),
      duration_ms: number(row.duration_ms),
    }
  }).toSorted((a, b) => a.cursor - b.cursor)
}

export function mergeActivities(existing: AgentActivity[], incoming: AgentActivity[]): AgentActivity[] {
  const byCursor = new Map(existing.map((activity) => [activity.cursor, activity]))
  for (const activity of incoming) byCursor.set(activity.cursor, activity)
  return [...byCursor.values()].toSorted((a, b) => a.cursor - b.cursor)
}

export interface AgentHierarchyRow {
  agent: TraceAgent | null
  depth: number
  unresolved: boolean
  label?: string
}

export interface NestedAgentHierarchyRow {
  agent: NestedAgent
  depth: number
}

/** Return the intact nested branch belonging to one or more configured nodes. */
export function nestedRowsForConfiguredParents(
  hierarchy: AgentHierarchyRow[],
  parentAgentIds: ReadonlySet<string>,
): NestedAgentHierarchyRow[] {
  const rows: NestedAgentHierarchyRow[] = []
  let belongsToParent = false
  for (const row of hierarchy) {
    if (!row.agent) { belongsToParent = false; continue }
    if (row.agent.source === 'configured') {
      belongsToParent = parentAgentIds.has(row.agent.agent_id)
    } else if (belongsToParent && !row.unresolved) {
      rows.push({ agent: row.agent, depth: row.depth })
    }
  }
  return rows
}

/** Configured nodes stay top-level; children recursively follow their spawning node. */
export function buildAgentHierarchy(agents: TraceAgent[]): AgentHierarchyRow[] {
  const configured = agents.filter((agent): agent is ConfiguredAgent => agent.source === 'configured')
    .toSorted((a, b) => (a.phase_seq ?? 0) - (b.phase_seq ?? 0))
  const nested = agents.filter((agent): agent is NestedAgent => agent.source === 'nested')
    .toSorted((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || (a.display_id ?? 0) - (b.display_id ?? 0))
  const knownIds = new Set(agents.map((agent) => agent.agent_id))
  const byParent = new Map<string, NestedAgent[]>()
  const unresolvedRoots: NestedAgent[] = []

  for (const child of nested) {
    let parent = child.parent_agent_id
    if (!parent && child.parent_agent) {
      const matches = configured.filter((agent) => agent.agent === child.parent_agent)
      if (matches.length === 1) parent = matches[0]!.agent_id
    }
    if (!parent || !knownIds.has(parent)) unresolvedRoots.push(child)
    else byParent.set(parent, [...(byParent.get(parent) ?? []), child])
  }

  const rows: AgentHierarchyRow[] = []
  const visited = new Set<string>()
  const append = (agent: TraceAgent, depth: number, unresolved: boolean) => {
    if (visited.has(agent.agent_id)) return
    visited.add(agent.agent_id)
    rows.push({ agent, depth, unresolved })
    for (const child of byParent.get(agent.agent_id) ?? []) append(child, depth + 1, unresolved)
  }
  for (const agent of configured) append(agent, 0, false)

  const remaining = nested.filter((agent) => !visited.has(agent.agent_id))
  if (remaining.length) {
    rows.push({ agent: null, depth: 0, unresolved: true, label: 'unresolved parent' })
    for (const root of unresolvedRoots) append(root, 1, true)
    // Corrupt cycles have no root. Keep them visible once instead of dropping them.
    for (const child of remaining) append(child, 1, true)
  }
  return rows
}

export interface AxisGeometry { left: number; width: number }
export function lifecycleGeometry(
  agent: TraceAgent,
  originMs: number,
  spanMs: number,
  nowMs: number,
  minWidth = 0.8,
): AxisGeometry | null {
  const start = ts(agent.started_at ?? agent.created_at)
  if (!Number.isFinite(start)) return null
  let end = agent.status === 'running' ? nowMs : ts(agent.ended_at)
  if (!Number.isFinite(end)) end = start
  const left = Math.max(0, Math.min(100, ((start - originMs) / Math.max(spanMs, 1)) * 100))
  return { left, width: Math.min(100 - left, Math.max(minWidth, ((Math.max(start, end) - start) / Math.max(spanMs, 1)) * 100)) }
}

export function activityPosition(activity: AgentActivity, originMs: number, spanMs: number): number | null {
  const time = ts(activity.started_at)
  if (!Number.isFinite(time)) return null
  return Math.max(0, Math.min(100, ((time - originMs) / Math.max(spanMs, 1)) * 100))
}
