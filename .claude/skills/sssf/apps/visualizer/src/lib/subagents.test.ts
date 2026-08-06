import { describe, expect, test } from 'bun:test'
import type { SubagentActivity } from './types'
import {
  mergeActivities,
  normalizeSubagentDetail,
  normalizeSubagents,
  subagentDuration,
} from './subagents'

function activity(cursor: number): SubagentActivity {
  return {
    cursor,
    telemetry_id: `t${cursor}`,
    activity_id: null,
    subagent_id: 'child',
    turn: 1,
    tool_call_id: null,
    tool: 'read',
    args_json: '{}',
    result_snippet: null,
    ok: 1,
    started_at: null,
    ended_at: null,
    duration_ms: null,
  }
}

describe('nested subagent polling helpers', () => {
  test('deduplicates overlapping cursor pages in insertion order', () => {
    expect(mergeActivities([activity(1), activity(2)], [activity(2), activity(3)]).map((a) => a.cursor)).toEqual([1, 2, 3])
  })

  test('computes live duration but keeps persisted final duration', () => {
    expect(subagentDuration('2025-01-01T00:00:00Z', null, null, Date.parse('2025-01-01T00:00:02Z'))).toBe(2000)
    expect(subagentDuration('2025-01-01T00:00:00Z', '2025-01-01T00:00:01Z', 1234, Date.now())).toBe(1234)
  })

  test('normalizes malformed legacy summaries into inspectable rows', () => {
    expect(normalizeSubagents(null)).toEqual([])
    const rows = normalizeSubagents([{ status: 'future-status', unexpected: 'raw' }, 'broken'])
    expect(rows[0]).toMatchObject({ subagent_id: 'unknown-1', status: null })
    expect(rows[0]?.task).toContain('unexpected')
    expect(rows[1]).toMatchObject({ subagent_id: 'unknown-2', task: 'broken' })
  })

  test('retains and orders continuation turns while supplying legacy defaults', () => {
    const detail = normalizeSubagentDetail({
      subagent_id: 'child', adw_id: 'run',
      turns: [{ turn: 2, prompt: 'continue' }, { turn: 1, result: 'first' }, 'malformed'],
    })
    expect(detail.turns.map((turn) => turn.turn)).toEqual([1, 2, 3])
    expect(detail.turns[2]).toMatchObject({ turn_id: 'child:3', prompt: 'malformed' })
  })
})
