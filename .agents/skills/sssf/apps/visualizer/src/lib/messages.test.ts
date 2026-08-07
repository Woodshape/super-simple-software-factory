import { describe, expect, test } from 'bun:test'
import {
  emptyAgentMessageState,
  mergeAgentMessagePage,
  mergeAgentMessages,
  normalizeAgentMessagesPage,
} from './messages'
import type { AgentMessage } from './types'

type TextMessage = Extract<AgentMessage, { role: 'user' | 'thinking' | 'assistant' }>
const text = (
  cursor: number,
  role: TextMessage['role'],
  value: string,
): TextMessage => ({ cursor, id: `message-${cursor}`, role, text: value })
const call = (cursor: number, id: string, args = '{}'): AgentMessage => ({
  cursor, id: `message-${cursor}`, role: 'tool_call', tool: 'bash', tool_call_id: id, arguments_json: args,
})
const result = (cursor: number, id: string, value: string, isError = false): AgentMessage => ({
  cursor, id: `message-${cursor}`, role: 'tool_result', tool: 'bash', tool_call_id: id,
  result: value, is_error: isError,
})

describe('agent message client paging', () => {
  test('normalizes all five roles without changing long or multiline content', () => {
    const args = JSON.stringify({ command: `echo\n${'x'.repeat(30_000)}` })
    const output = `first\n${'y'.repeat(30_000)}\nlast`
    const page = normalizeAgentMessagesPage({
      messages: [
        { cursor: 1, role: 'user', text: 'ask' },
        { cursor: 2, role: 'thinking', text: 'reason' },
        { cursor: 3, role: 'assistant', text: 'answer' },
        { cursor: 4, role: 'tool_call', tool: 'bash', tool_call_id: 'call', arguments_json: args },
        { cursor: 5, role: 'tool_result', tool: 'bash', tool_call_id: 'call', result: output, is_error: true },
      ],
      cursor: 5, has_more: false, available: true,
    })
    expect(page.messages.map((entry) => entry.role)).toEqual([
      'user', 'thinking', 'assistant', 'tool_call', 'tool_result',
    ])
    expect(page.messages[3]).toMatchObject({ arguments_json: args })
    expect(page.messages[4]).toMatchObject({ result: output, is_error: true })
  })

  test('keeps immutable cursor order across overlaps and separately arriving results', () => {
    const merged = mergeAgentMessages(
      [text(1, 'user', 'one'), call(2, 'call')],
      [call(2, 'mutated', '{"bad":true}'), result(3, 'call', 'done'), text(4, 'assistant', 'three')],
    )
    expect(merged).toEqual([
      text(1, 'user', 'one'), call(2, 'call'), result(3, 'call', 'done'), text(4, 'assistant', 'three'),
    ])
  })

  test('rejects malformed union variants independently', () => {
    const page = normalizeAgentMessagesPage({
      messages: [
        { cursor: 1, role: 'user', text: 'valid' },
        { cursor: 2, role: 'tool_call', tool: 'read', tool_call_id: 'a' },
        { cursor: 2, role: 'tool_call', tool: 'read', arguments_json: '{}' },
        { cursor: 2, role: 'tool_call', tool_call_id: 'a', arguments_json: '{}' },
        { cursor: 2, role: 'tool_result', tool: 'read', tool_call_id: 'a', result: '', is_error: 'false' },
        { cursor: 2, role: 'tool_result', tool: 'read', tool_call_id: 'a', is_error: false },
        { cursor: 2, role: 'assistant', text: 12 },
        { cursor: 2, role: 'unknown', text: 'no' },
      ],
      cursor: 99, has_more: true, available: true,
    })
    expect(page).toMatchObject({ cursor: 1, has_more: true, available: true })
    expect(page.messages).toEqual([text(1, 'user', 'valid')])
    expect(normalizeAgentMessagesPage(null, 7)).toEqual({
      messages: [], cursor: 7, has_more: false, available: false,
    })
  })

  test('does not trust a claimed cursor jump or accept entries beyond a gap', () => {
    const first = normalizeAgentMessagesPage({
      messages: [text(1, 'user', 'one'), text(3, 'assistant', 'three')],
      cursor: 300, has_more: true, available: true,
    }, 0)
    expect(first.cursor).toBe(1)
    expect(first.messages.map((entry) => entry.cursor)).toEqual([1])

    const stalled = mergeAgentMessagePage(emptyAgentMessageState('run:agent'), 'run:agent', {
      messages: [text(3, 'assistant', 'three')], cursor: 3, has_more: true, available: true,
    })
    expect(stalled).toMatchObject({ cursor: 0, hasMore: true, messages: [] })
  })

  test('accepts sorted overlapping pages and advances only through contiguous new entries', () => {
    const first = mergeAgentMessagePage(emptyAgentMessageState('run:agent'), 'run:agent', {
      messages: [text(1, 'user', 'one'), call(2, 'call')], cursor: 2, has_more: true, available: true,
    })
    const second = mergeAgentMessagePage(first, 'run:agent', {
      messages: [result(4, 'call', 'done'), call(2, 'changed'), text(3, 'assistant', 'answer')],
      cursor: 4, has_more: false, available: true,
    })
    expect(second.cursor).toBe(4)
    expect(second.messages).toEqual([
      text(1, 'user', 'one'), call(2, 'call'), text(3, 'assistant', 'answer'), result(4, 'call', 'done'),
    ])
  })

  test('resets text and tool entries when the selected agent key changes', () => {
    const first = mergeAgentMessagePage(emptyAgentMessageState('run:first'), 'run:first', {
      messages: [text(1, 'user', 'old'), call(2, 'old-call'), result(3, 'old-call', 'old result')],
      cursor: 3, available: true,
    })
    const second = mergeAgentMessagePage(first, 'run:second', {
      messages: [text(1, 'assistant', 'new')], cursor: 1, available: true,
    })
    expect(second.key).toBe('run:second')
    expect(second.messages).toEqual([text(1, 'assistant', 'new')])
  })
})
