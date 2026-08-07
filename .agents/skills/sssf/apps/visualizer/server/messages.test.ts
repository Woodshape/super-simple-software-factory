import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentDetail, AgentMessage, ConfiguredAgent, NestedAgent } from '../shared/types.ts'
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

const end = (role: 'user' | 'assistant', content: unknown[], timestamp: string | number = 1000) => JSON.stringify({
  type: 'message_end', message: { role, content, timestamp },
})
const startTool = (toolCallId: string | undefined, toolName: string, args: unknown, timestamp: string | number = 1000) => JSON.stringify({
  type: 'tool_execution_start', toolCallId, toolName, args, timestamp,
})
const endTool = (
  toolCallId: string | undefined,
  toolName: string,
  args: unknown,
  texts: string[],
  isError = false,
  timestamp: string | number = 1000,
) => JSON.stringify({
  type: 'tool_execution_end', toolCallId, toolName, args, isError, timestamp,
  result: { content: texts.map((text) => ({ type: 'text', text })), details: 'provider-details-secret' },
  fixture_path: '/internal/fixture-secret',
})

function writeLines(path: string, lines: string[]) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`)
}

type TextEntry = Extract<AgentMessage, { role: 'user' | 'thinking' | 'assistant' }>
function textEntries(messages: AgentMessage[]): TextEntry[] {
  return messages.filter((message): message is TextEntry =>
    message.role === 'user' || message.role === 'thinking' || message.role === 'assistant')
}

describe('Pi message stream normalization', () => {
  test('emits full text plus bash/read/write calls and separately ordered results exactly once', () => {
    const f = root()
    const path = join(f.run, 'planner', 'raw_output.jsonl')
    const long = `line one\n${'x'.repeat(25_000)}\nlast byte`
    const bashArgs = { command: `printf '${long}'`, env: { nested: ['a', { b: true }] } }
    writeLines(path, [
      JSON.stringify({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'duplicate' }] } }),
      end('user', [{ type: 'text', text: 'request' }]),
      end('assistant', [
        { type: 'thinking', thinking: 'reason\nexact', thinkingSignature: 'secret-signature', encrypted_content: 'cipher' },
        { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: bashArgs },
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '/wanted/full/path' } },
        { type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: '/wanted/out', content: '' } },
        { type: 'text', text: 'answer\nexact' },
      ]),
      startTool('bash-1', 'bash', bashArgs),
      startTool('read-1', 'read', { path: '/wanted/full/path' }),
      startTool('write-1', 'write', { path: '/wanted/out', content: '' }),
      JSON.stringify({ type: 'tool_execution_update', toolCallId: 'read-1', result: 'stream fragment' }),
      endTool('read-1', 'read', { path: '/wanted/full/path' }, ['first\n', 'second']),
      endTool('bash-1', 'bash', bashArgs, [long], true),
      endTool('write-1', 'write', { path: '/wanted/out', content: '' }, []),
      JSON.stringify({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'duplicate' }] } }),
    ])

    const page = loadAgentMessages(f.sessions, configured(), 0, 20)
    expect(page.messages.map((message) => message.role)).toEqual([
      'user', 'thinking', 'tool_call', 'tool_call', 'tool_call', 'assistant',
      'tool_result', 'tool_result', 'tool_result',
    ])
    expect(page.messages.filter((message) => message.role === 'tool_call').map((message) => message.tool))
      .toEqual(['bash', 'read', 'write'])
    const calls = page.messages.filter((message) => message.role === 'tool_call')
    expect(calls[0]?.arguments_json).toBe(JSON.stringify(bashArgs))
    expect(calls[1]?.arguments_json).toBe(JSON.stringify({ path: '/wanted/full/path' }))
    const results = page.messages.filter((message) => message.role === 'tool_result')
    expect(results.map((message) => [message.tool_call_id, message.result, message.is_error])).toEqual([
      ['read-1', 'first\nsecond', false], ['bash-1', long, true], ['write-1', '', false],
    ])
    const serialized = JSON.stringify(page)
    expect(serialized).not.toContain('secret-signature')
    expect(serialized).not.toContain('cipher')
    expect(serialized).not.toContain('provider-details-secret')
    expect(serialized).not.toContain('/internal/fixture-secret')
    expect(serialized).toContain('/wanted/full/path')
  })

  test('keeps cursors append-only when a result and a completed live tail arrive later', () => {
    const f = root()
    const path = join(f.run, 'planner', 'raw_output.jsonl')
    writeLines(path, [
      end('user', [{ type: 'text', text: 'one' }]),
      end('assistant', [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'echo ok' } }]),
    ])
    const first = loadAgentMessages(f.sessions, configured(), 0, 2)
    expect(first.messages.map((message) => [message.cursor, message.role])).toEqual([[1, 'user'], [2, 'tool_call']])

    const completedResult = endTool('call', 'bash', { command: 'echo ok' }, ['ok\n'])
    const split = Math.floor(completedResult.length / 2)
    appendFileSync(path, completedResult.slice(0, split))
    const incomplete = loadAgentMessages(f.sessions, configured(), first.cursor, 2)
    expect(incomplete.messages).toEqual([])
    appendFileSync(path, `${completedResult.slice(split)}\n`)
    const result = loadAgentMessages(f.sessions, configured(), first.cursor, 2)
    expect(result.messages).toMatchObject([{ cursor: 3, role: 'tool_result', tool_call_id: 'call', result: 'ok\n' }])
    expect(loadAgentMessages(f.sessions, configured(), 0, 2).messages).toEqual(first.messages)
  })

  test('pages more than a limit, isolates malformed records, and never advances over the live fragment', () => {
    const f = root()
    const blocks = Array.from({ length: 7 }, (_, index) => ({ type: 'text', text: String(index + 1) }))
    writeLines(join(f.run, 'planner', 'raw_output.jsonl'), [
      '{broken complete line', end('assistant', blocks), '{"type":"message_end","message":',
    ])
    const pages = []
    let after = 0
    do {
      const page = loadAgentMessages(f.sessions, configured(), after, 3)
      pages.push(page)
      after = page.cursor
    } while (pages.at(-1)?.has_more)
    expect(pages.flatMap((page) => textEntries(page.messages).map((message) => message.text)))
      .toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(pages.map((page) => page.cursor)).toEqual([3, 6, 7])
  })

  test('combines subagent raw turns numerically and never mixes the compact fallback', () => {
    const f = root()
    const child = join(f.run, 'planner', 'subagents', 'child')
    writeLines(join(child, 'turn-10', 'raw_output.jsonl'), [end('assistant', [{ type: 'text', text: 'ten' }])])
    writeLines(join(child, 'turn-2', 'raw_output.jsonl'), [end('user', [{ type: 'text', text: 'two' }])])
    writeLines(join(child, 'session.jsonl'), [JSON.stringify({
      type: 'message', id: 'fallback', timestamp: '2025-01-01',
      message: { role: 'assistant', content: [{ type: 'text', text: 'must not duplicate' }] },
    })])
    const page = loadAgentMessages(f.sessions, nested([10, 2]), 0, 10)
    expect(textEntries(page.messages).map((message) => [message.turn, message.text])).toEqual([[2, 'two'], [10, 'ten']])
  })

  test('uses compact assistant calls and toolResult records in source order', () => {
    const f = root()
    const piSessions = join(f.run, 'planner', 'pi_sessions')
    writeLines(join(piSessions, 'persistent.jsonl'), [
      JSON.stringify({ type: 'session', id: 'pi-id' }),
      JSON.stringify({ type: 'message', timestamp: '2025-01-01T00:00:01Z', message: {
        role: 'assistant', content: [
          { type: 'text', text: 'before' },
          { type: 'toolCall', id: 'compact-call', name: 'read', arguments: { path: '/full/path' } },
        ],
      } }),
      JSON.stringify({ type: 'message', timestamp: '2025-01-01T00:00:02Z', message: {
        role: 'toolResult', toolCallId: 'compact-call', toolName: 'read', isError: false,
        content: [{ type: 'text', text: 'full\n' }, { type: 'text', text: 'result' }],
      } }),
    ])
    expect(loadAgentMessages(f.sessions, configured(), 0, 10).messages).toMatchObject([
      { role: 'assistant', text: 'before' },
      { role: 'tool_call', tool: 'read', tool_call_id: 'compact-call', arguments_json: '{"path":"/full/path"}' },
      { role: 'tool_result', tool: 'read', tool_call_id: 'compact-call', result: 'full\nresult', is_error: false },
    ])
  })

  test('links compact calls and results without provider IDs to one stable synthetic call', () => {
    const f = root()
    const piSessions = join(f.run, 'planner', 'pi_sessions')
    writeLines(join(piSessions, 'persistent.jsonl'), [
      JSON.stringify({ type: 'session', id: 'pi-id' }),
      JSON.stringify({ type: 'message', timestamp: '2025-01-01T00:00:01Z', message: {
        role: 'assistant', content: [
          { type: 'toolCall', name: 'read', arguments: { path: '/anonymous/path' } },
        ],
      } }),
      JSON.stringify({ type: 'message', timestamp: '2025-01-01T00:00:02Z', message: {
        role: 'toolResult', toolName: 'read', isError: false,
        content: [{ type: 'text', text: 'anonymous result' }],
      } }),
    ])
    const first = loadAgentMessages(f.sessions, configured(), 0, 10)
    const second = loadAgentMessages(f.sessions, configured(), 0, 10)
    expect(first.messages).toHaveLength(2)
    expect(first.messages.map((message) => message.role)).toEqual(['tool_call', 'tool_result'])
    const call = first.messages[0]
    const result = first.messages[1]
    expect(call?.role).toBe('tool_call')
    expect(result?.role).toBe('tool_result')
    if (call?.role !== 'tool_call' || result?.role !== 'tool_result') throw new Error('unexpected entries')
    expect(call.tool_call_id).toStartWith('synthetic-')
    expect(result.tool_call_id).toBe(call.tool_call_id)
    expect(result.result).toBe('anonymous result')
    expect(second.messages).toEqual(first.messages)
  })

  test('filters a reused configured session as linked call/result units and rejects undated orphans', () => {
    const f = root()
    const path = join(f.run, 'planner', 'raw_output.jsonl')
    const phaseOne = '2025-01-01T00:00:01Z'
    const phaseTwo = '2025-01-02T00:00:01Z'
    writeLines(path, [
      end('user', [{ type: 'text', text: 'phase one' }], phaseOne),
      end('assistant', [{ type: 'toolCall', id: 'one', name: 'bash', arguments: { command: 'one' } }], phaseOne),
      endTool('one', 'bash', { command: 'one' }, ['one result'], false, phaseTwo),
      end('user', [{ type: 'text', text: 'phase two' }], phaseTwo),
      end('assistant', [{ type: 'toolCall', id: 'two', name: 'read', arguments: { path: 'two' } }], phaseTwo),
      endTool('two', 'read', { path: 'two' }, ['two result'], false, phaseOne),
      JSON.stringify({ type: 'tool_execution_end', toolName: 'write', result: { content: [{ type: 'text', text: 'orphan' }] } }),
    ])
    const one = configured({ started_at: '2025-01-01T00:00:00Z', ended_at: '2025-01-01T23:59:59Z' })
    const two = configured({ started_at: '2025-01-02T00:00:00Z', ended_at: '2025-01-02T23:59:59Z' })
    expect(loadAgentMessages(f.sessions, one, 0, 20).messages.map((message) => message.role === 'tool_result' ? message.result : message.role === 'tool_call' ? message.tool : message.text))
      .toEqual(['phase one', 'bash', 'one result'])
    expect(loadAgentMessages(f.sessions, two, 0, 20).messages.map((message) => message.role === 'tool_result' ? message.result : message.role === 'tool_call' ? message.tool : message.text))
      .toEqual(['phase two', 'read', 'two result'])
  })

  test('assigns stable synthetic IDs and folds anonymous announcement/start/end by FIFO metadata', () => {
    const f = root()
    const path = join(f.run, 'planner', 'raw_output.jsonl')
    writeLines(path, [
      end('assistant', [
        { type: 'toolCall', name: 'read', arguments: { path: 'a' } },
        { type: 'toolCall', name: 'read', arguments: { path: 'b' } },
      ]),
      startTool(undefined, 'read', { path: 'a' }),
      startTool(undefined, 'read', { path: 'b' }),
      endTool(undefined, 'read', { path: 'b' }, ['B']),
      endTool(undefined, 'read', { path: 'a' }, ['A']),
    ])
    const first = loadAgentMessages(f.sessions, configured(), 0, 20)
    const second = loadAgentMessages(f.sessions, configured(), 0, 20)
    const calls = first.messages.filter((message) => message.role === 'tool_call')
    const results = first.messages.filter((message) => message.role === 'tool_result')
    expect(calls).toHaveLength(2)
    expect(results).toHaveLength(2)
    expect(results.map((message) => message.tool_call_id)).toEqual([calls[1]?.tool_call_id, calls[0]?.tool_call_id])
    expect(second.messages).toEqual(first.messages)
    expect(JSON.stringify(first)).not.toContain(f.dir)
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
