import { describe, expect, test } from 'bun:test'
import {
  emptyAgentMessageState,
  mergeAgentMessagePage,
  mergeAgentMessages,
  normalizeAgentMessagesPage,
} from './messages'
import type { AgentMessage } from './types'

const message = (cursor: number, role: AgentMessage['role'], text: string): AgentMessage => ({
  cursor, id: `message-${cursor}`, role, text,
})

describe('agent message client paging', () => {
  test('keeps source cursor order and deduplicates overlapping pages', () => {
    const merged = mergeAgentMessages(
      [message(1, 'user', 'one'), message(2, 'thinking', 'two')],
      [message(2, 'thinking', 'duplicate'), message(3, 'assistant', 'three')],
    )
    expect(merged.map((entry) => [entry.cursor, entry.text])).toEqual([
      [1, 'one'], [2, 'two'], [3, 'three'],
    ])
  })

  test('preserves complete multiline and very long strings', () => {
    const text = `first\n${'x'.repeat(30_000)}\nlast`
    const page = normalizeAgentMessagesPage({
      messages: [{ cursor: 1, id: 'full', role: 'assistant', text }],
      cursor: 1, has_more: false, available: true,
    })
    expect(page.messages[0]?.text).toBe(text)
    expect(page.messages[0]?.text.endsWith('\nlast')).toBe(true)
  })

  test('defensively ignores malformed pages and fields without changing roles', () => {
    expect(normalizeAgentMessagesPage(null, 7)).toEqual({
      messages: [], cursor: 7, has_more: false, available: false,
    })
    const page = normalizeAgentMessagesPage({
      messages: [
        { cursor: 2, role: 'thinking', text: 'real reasoning', turn: 0 },
        { cursor: -1, role: 'user', text: 'bad cursor' },
        { cursor: 3, role: 'tool', text: 'bad role' },
        { cursor: 4, role: 'assistant', text: 12 },
        { cursor: 1, role: 'user', text: 'first', timestamp: 10 },
      ],
      cursor: 'wrong', has_more: 'yes', available: 1,
    })
    expect(page).toMatchObject({ cursor: 2, has_more: false, available: false })
    expect(page.messages.map((entry) => [entry.cursor, entry.role, entry.text])).toEqual([
      [1, 'user', 'first'], [2, 'thinking', 'real reasoning'],
    ])
  })

  test('resets instead of mixing when the selected agent key changes', () => {
    const first = mergeAgentMessagePage(emptyAgentMessageState('run:first'), 'run:first', {
      messages: [message(1, 'user', 'old')], cursor: 1, available: true,
    })
    const second = mergeAgentMessagePage(first, 'run:second', {
      messages: [message(1, 'assistant', 'new')], cursor: 1, available: true,
    })
    expect(second.key).toBe('run:second')
    expect(second.messages.map((entry) => entry.text)).toEqual(['new'])
  })
})
