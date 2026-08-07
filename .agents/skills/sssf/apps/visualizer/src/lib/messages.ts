import type { AgentMessage, AgentMessagesPage } from './types'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function common(row: Record<string, unknown>, cursor: number) {
  return {
    cursor,
    id: typeof row.id === 'string' && row.id ? row.id : `message-${cursor}`,
    ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}),
    ...(safeInteger(row.turn) === null ? {} : { turn: safeInteger(row.turn)! }),
  }
}

function normalizeMessage(value: unknown): AgentMessage | null {
  const row = object(value)
  const cursor = safeInteger(row.cursor)
  if (cursor === null || cursor < 1 || typeof row.role !== 'string') return null
  const base = common(row, cursor)
  if (row.role === 'user' || row.role === 'thinking' || row.role === 'assistant') {
    return typeof row.text === 'string' ? { ...base, role: row.role, text: row.text } : null
  }
  if (row.role === 'tool_call') {
    return typeof row.tool === 'string' && typeof row.tool_call_id === 'string' &&
      typeof row.arguments_json === 'string'
      ? {
          ...base,
          role: 'tool_call',
          tool: row.tool,
          tool_call_id: row.tool_call_id,
          arguments_json: row.arguments_json,
        }
      : null
  }
  if (row.role === 'tool_result') {
    return typeof row.tool === 'string' && typeof row.tool_call_id === 'string' &&
      typeof row.result === 'string' && typeof row.is_error === 'boolean'
      ? {
          ...base,
          role: 'tool_result',
          tool: row.tool,
          tool_call_id: row.tool_call_id,
          result: row.result,
          is_error: row.is_error,
        }
      : null
  }
  return null
}

/** Accept only complete union variants and never advance across a missing cursor. */
export function normalizeAgentMessagesPage(value: unknown, after = 0): AgentMessagesPage {
  const page = object(value)
  const valid: AgentMessage[] = []
  if (Array.isArray(page.messages)) {
    for (const raw of page.messages) {
      const message = normalizeMessage(raw)
      if (message) valid.push(message)
    }
  }
  const deduped = mergeAgentMessages([], valid)
  const messages: AgentMessage[] = []
  let cursor = after
  for (const message of deduped) {
    if (message.cursor <= after) {
      messages.push(message)
      continue
    }
    if (message.cursor !== cursor + 1) break
    messages.push(message)
    cursor = message.cursor
  }
  return {
    messages,
    cursor,
    has_more: page.has_more === true,
    available: page.available === true,
  }
}

/** Merge cursor pages without mutating an entry already accepted at that cursor. */
export function mergeAgentMessages(
  existing: readonly AgentMessage[],
  incoming: readonly AgentMessage[],
): AgentMessage[] {
  const byCursor = new Map(existing.map((message) => [message.cursor, message]))
  for (const message of incoming) {
    if (!byCursor.has(message.cursor)) byCursor.set(message.cursor, message)
  }
  return [...byCursor.values()].toSorted((a, b) => a.cursor - b.cursor)
}

export interface AgentMessageState {
  key: string
  messages: AgentMessage[]
  cursor: number
  available: boolean | null
  hasMore: boolean
}

export function emptyAgentMessageState(key: string): AgentMessageState {
  return { key, messages: [], cursor: 0, available: null, hasMore: false }
}

/** A different agent key always starts a new flow instead of merging old content. */
export function mergeAgentMessagePage(
  state: AgentMessageState,
  key: string,
  value: unknown,
): AgentMessageState {
  const current = state.key === key ? state : emptyAgentMessageState(key)
  const page = normalizeAgentMessagesPage(value, current.cursor)
  return {
    key,
    messages: mergeAgentMessages(current.messages, page.messages),
    cursor: Math.max(current.cursor, page.cursor),
    available: page.available,
    hasMore: page.has_more,
  }
}
