import type { AgentMessage, AgentMessageRole, AgentMessagesPage } from './types'

const ROLES = new Set<AgentMessageRole>(['user', 'thinking', 'assistant'])

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Accept only the text-flow contract. Malformed provider/server fields are discarded. */
export function normalizeAgentMessagesPage(value: unknown, after = 0): AgentMessagesPage {
  const page = object(value)
  const messages: AgentMessage[] = []
  if (Array.isArray(page.messages)) {
    for (const raw of page.messages) {
      const row = object(raw)
      const cursor = safeInteger(row.cursor)
      if (
        cursor === null || cursor < 1 ||
        typeof row.text !== 'string' ||
        typeof row.role !== 'string' || !ROLES.has(row.role as AgentMessageRole)
      ) continue
      messages.push({
        cursor,
        id: typeof row.id === 'string' && row.id ? row.id : `message-${cursor}`,
        role: row.role as AgentMessageRole,
        text: row.text,
        ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}),
        ...(safeInteger(row.turn) === null ? {} : { turn: safeInteger(row.turn)! }),
      })
    }
  }
  const deduped = mergeAgentMessages([], messages)
  const last = deduped.at(-1)?.cursor ?? after
  const suppliedCursor = safeInteger(page.cursor)
  return {
    messages: deduped,
    cursor: suppliedCursor !== null && suppliedCursor >= last ? suppliedCursor : last,
    has_more: page.has_more === true,
    available: page.available === true,
  }
}

/** Merge cursor pages without changing complete text or the source's cursor order. */
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
}

export function emptyAgentMessageState(key: string): AgentMessageState {
  return { key, messages: [], cursor: 0, available: null }
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
  }
}
