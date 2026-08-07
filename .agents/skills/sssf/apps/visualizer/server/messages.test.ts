import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentDetail, ConfiguredAgent, NestedAgent } from '../shared/types.ts'
import { loadAgentMessages } from './messages.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'sssf-messages-'))
  dirs.push(dir)
  const sessions = join(dir, 'sessions')
  mkdirSync(join(sessions, 'run'), { recursive: true })
  return { dir, sessions, run: join(sessions, 'run') }
}

function configured(overrides: Partial<ConfiguredAgent> = {}): AgentDetail {
  return {
    agent_id: 'phase', source: 'configured', adw_id: 'run', phase_id: 'phase', parent_agent_id: null,
    name: 'planner', agent: 'planner', task: null, status: 'success', created_at: null,
    started_at: null, ended_at: null, duration_ms: null, model: null, thinking: null,
    turn_count: 1, tool_count: 0, coding_agent: null, session_id: 'pi-id', color: null,
    context_tokens: null, context_window: null, last_used_at: null, phase_name: 'plan',
    phase_seq: 1, phase_status: 'success', phase_attempt: 1, phase_retries: 0,
    ...overrides, turns: [],
  }
}

function nested(turns = [1], overrides: Partial<NestedAgent> = {}): AgentDetail {
  return {
    agent_id: 'child', source: 'nested', adw_id: 'run', phase_id: 'phase', parent_agent_id: 'phase',
    name: 'child', subagent_id: 'child', display_id: 1, parent_agent: 'planner', task: 'task',
    status: 'success', created_at: null, started_at: null, ended_at: null, duration_ms: null,
    model: null, thinking: null, turn_count: turns.length, tool_count: 0,
    parent_tool_call_id: null, parent_event_id: null, session_path: '/do/not/read', removed_at: null,
    ...overrides,
    turns: turns.map((turn) => ({
      turn_id: `child:${turn}`, agent_id: 'child', turn, parent_tool_call_id: null,
      parent_event_id: null, prompt: null, model: null, thinking: null, pid: null,
      status: 'success', started_at: null, ended_at: null, duration_ms: null, result: null,
      error: null, tool_count: 0, raw_output_path: '/escape/raw.jsonl', session_path: '/escape/session.jsonl',
    })),
  }
}

const end = (role: 'user' | 'assistant', content: unknown[], timestamp = 1000) => JSON.stringify({
  type: 'message_end', message: { role, content, timestamp },
})

function write(path: string, lines: string[]) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`)
}

describe('Pi message stream normalization', () => {
  test('uses final snapshots once and preserves block order, full text, and no provider metadata', () => {
    const f = root()
    const path = join(f.run, 'planner', 'raw_output.jsonl')
    const long = `line one\n${'x'.repeat(25_000)}\nlast byte`
    write(path, [
      JSON.stringify({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'duplicate' }] } }),
      JSON.stringify({ type: 'message_update', delta: 'duplicate' }),
      end('user', [{ type: 'text', text: long }, { type: 'image', data: '/fixture/private.png' }]),
      end('assistant', [
        { type: 'thinking', thinking: 'reason\nexact', thinkingSignature: 'secret-signature', encrypted_content: 'cipher' },
        { type: 'toolCall', name: 'read', arguments: { path: '/fixture/private.png' } },
        { type: 'text', text: 'answer\nexact' },
      ]),
      JSON.stringify({ type: 'tool_execution_end', result: { content: [{ type: 'text', text: 'tool secret' }] } }),
      JSON.stringify({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'duplicate' }] } }),
    ])

    const page = loadAgentMessages(f.sessions, configured(), 0, 10)
    expect(page.available).toBe(true)
    expect(page.messages.map((message) => message.role)).toEqual(['user', 'thinking', 'assistant'])
    expect(page.messages[0]?.text).toBe(long)
    expect(page.messages[1]?.text).toBe('reason\nexact')
    expect(page.messages[2]?.text).toBe('answer\nexact')
    const serialized = JSON.stringify(page)
    expect(serialized).not.toContain('secret-signature')
    expect(serialized).not.toContain('cipher')
    expect(serialized).not.toContain('/fixture/private.png')
    expect(serialized).not.toContain('tool secret')
  })

  test('tolerates malformed lines/live tails and pages normalized entries without gaps', () => {
    const f = root()
    write(join(f.run, 'planner', 'raw_output.jsonl'), [
      end('user', [{ type: 'text', text: 'one' }]),
      '{broken complete line',
      end('assistant', [{ type: 'thinking', thinking: 'two' }, { type: 'text', text: 'three' }]),
      '{"type":"message_end","message":',
    ])
    const first = loadAgentMessages(f.sessions, configured(), 0, 2)
    const second = loadAgentMessages(f.sessions, configured(), first.cursor, 2)
    expect(first).toMatchObject({ cursor: 2, has_more: true })
    expect(second).toMatchObject({ cursor: 3, has_more: false })
    expect([...first.messages, ...second.messages].map((message) => message.text)).toEqual(['one', 'two', 'three'])
  })

  test('combines subagent raw turns numerically and never mixes the compact fallback', () => {
    const f = root()
    const child = join(f.run, 'planner', 'subagents', 'child')
    write(join(child, 'turn-10', 'raw_output.jsonl'), [end('assistant', [{ type: 'text', text: 'ten' }])])
    write(join(child, 'turn-2', 'raw_output.jsonl'), [end('user', [{ type: 'text', text: 'two' }])])
    write(join(child, 'session.jsonl'), [JSON.stringify({
      type: 'message', id: 'fallback', timestamp: '2025-01-01',
      message: { role: 'assistant', content: [{ type: 'text', text: 'must not duplicate' }] },
    })])
    const page = loadAgentMessages(f.sessions, nested([10, 2]), 0, 10)
    expect(page.messages.map((message) => [message.turn, message.text])).toEqual([[2, 'two'], [10, 'ten']])
  })

  test('uses compact session fallback and filters configured owner reuse by phase times', () => {
    const f = root()
    const piSessions = join(f.run, 'planner', 'pi_sessions')
    write(join(piSessions, 'persistent.jsonl'), [
      JSON.stringify({ type: 'session', id: 'pi-id' }),
      JSON.stringify({ type: 'message', timestamp: '2025-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'phase one' }] } }),
      JSON.stringify({ type: 'message', timestamp: '2025-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason' }, { type: 'text', text: 'answer' }] } }),
      JSON.stringify({ type: 'message', timestamp: '2025-01-02T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'phase two' }] } }),
    ])
    const agent = configured({ started_at: '2025-01-01T00:00:00Z', ended_at: '2025-01-01T23:59:59Z' })
    expect(loadAgentMessages(f.sessions, agent, 0, 10).messages.map((message) => message.text))
      .toEqual(['phase one', 'reason', 'answer'])
  })

  test('returns unavailable for missing files, unsafe segments, and symlink escapes', () => {
    const f = root()
    expect(loadAgentMessages(f.sessions, configured(), 0, 10).available).toBe(false)
    expect(loadAgentMessages(f.sessions, configured({ agent: '../outside' }), 0, 10).available).toBe(false)

    const outside = join(f.dir, 'outside.jsonl')
    writeFileSync(outside, `${end('user', [{ type: 'text', text: 'escaped' }])}\n`)
    mkdirSync(join(f.run, 'planner'), { recursive: true })
    symlinkSync(outside, join(f.run, 'planner', 'raw_output.jsonl'))
    expect(loadAgentMessages(f.sessions, configured(), 0, 10)).toMatchObject({ available: false, messages: [] })
  })
})
