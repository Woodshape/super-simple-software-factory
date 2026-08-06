import { describe, expect, test } from 'bun:test'
import type { AgentActivity, NestedAgent, TraceAgent } from './types'
import { activityPosition, agentDuration, buildAgentHierarchy, lifecycleGeometry, mergeActivities, nestedRowsForConfiguredParents, normalizeActivities, normalizeAgentDetail, normalizeAgents } from './agents'

function activity(cursor: number): AgentActivity {
  return { cursor, telemetry_id: `t${cursor}`, activity_id: null, agent_id: 'sub_msh502p4_1_af8882dc', turn: 1, tool_call_id: null, tool: 'read', args_json: '{}', result_snippet: null, ok: 1, started_at: null, ended_at: null, duration_ms: null }
}

function child(id: string, parent: string | null, display: number): NestedAgent {
  return { agent_id: id, source: 'nested', subagent_id: id, adw_id: 'da18dd31', phase_id: parent, parent_agent_id: parent, name: `#${display}`, task: 'task', status: 'success', created_at: `2025-01-01T00:00:0${display}Z`, started_at: '2025-01-01T00:00:02Z', ended_at: '2025-01-01T00:00:04Z', duration_ms: 2000, model: 'openai-codex/gpt-5.6-luna', thinking: 'low', turn_count: 1, tool_count: 1, display_id: display, parent_agent: 'scout', parent_tool_call_id: null, parent_event_id: null, session_path: null, removed_at: null }
}

const configured = normalizeAgents([{ agent_id: 'da18dd31_02_scout', source: 'configured', adw_id: 'da18dd31', phase_id: 'da18dd31_02_scout', name: 'scout', agent: 'scout', phase_seq: 2, status: 'success' }])[0]!

describe('unified agent helpers', () => {
  test('normalizes and deduplicates activity pages', () => {
    expect(normalizeActivities([{ cursor: 2, ok: false, args: { path: 'x' } }], 'child')[0]).toMatchObject({
      cursor: 2, agent_id: 'child', ok: 0, args_json: '{"path":"x"}',
    })
    expect(mergeActivities([activity(1), activity(2)], [activity(2), activity(3)]).map(a => a.cursor)).toEqual([1, 2, 3])
  })
  test('ignores stale end timestamps for running continuations', () => expect(agentDuration('2025-01-01T00:00:00Z', '2025-01-01T00:00:01Z', 1000, Date.parse('2025-01-01T00:00:02Z'), 'running')).toBe(2000))
  test('normalizes malformed rows and orders continuation turns', () => {
    expect(normalizeAgents(null)).toEqual([])
    const detail = normalizeAgentDetail({ source: 'nested', subagent_id: 'child', turns: [{ turn: 2 }, { turn: 1 }, 'bad'] })
    expect(detail.turns.map(turn => turn.turn)).toEqual([1, 2, 3])
  })
  test('keeps da18dd31 children hierarchically beneath scout', () => {
    const agents: TraceAgent[] = [configured, child('sub_msh502p4_1_af8882dc', configured.agent_id, 1), child('sub_msh502pb_2_bb3b893e', configured.agent_id, 2)]
    expect(buildAgentHierarchy(agents).map(row => [row.agent?.agent_id, row.depth])).toEqual([[configured.agent_id, 0], ['sub_msh502p4_1_af8882dc', 1], ['sub_msh502pb_2_bb3b893e', 1]])
  })
  test('falls back to a unique configured parent name and recursively orders children', () => {
    const parent = child('nested-parent', null, 3)
    const grandchild = child('nested-child', parent.agent_id, 4)
    expect(buildAgentHierarchy([configured, parent, grandchild]).map(row => [row.agent?.agent_id, row.depth])).toEqual([
      [configured.agent_id, 0], [parent.agent_id, 1], [grandchild.agent_id, 2],
    ])
  })
  test('keeps configured parent branches independent for per-parent disclosure', () => {
    const reviewer = normalizeAgents([{ agent_id: 'da18dd31_03_reviewer', source: 'configured', adw_id: 'da18dd31', phase_id: 'da18dd31_03_reviewer', name: 'reviewer', agent: 'reviewer', phase_seq: 3, status: 'success' }])[0]!
    const scoutChild = child('scout-child', configured.agent_id, 1)
    const scoutGrandchild = child('scout-grandchild', scoutChild.agent_id, 2)
    const reviewerChild = child('reviewer-child', reviewer.agent_id, 3)
    const hierarchy = buildAgentHierarchy([configured, scoutChild, scoutGrandchild, reviewer, reviewerChild])

    expect(nestedRowsForConfiguredParents(hierarchy, new Set([configured.agent_id])).map(row => row.agent.agent_id)).toEqual([
      'scout-child', 'scout-grandchild',
    ])
    expect(nestedRowsForConfiguredParents(hierarchy, new Set([reviewer.agent_id])).map(row => row.agent.agent_id)).toEqual([
      'reviewer-child',
    ])
    expect(hierarchy).toHaveLength(5)
  })
  test('keeps unresolved child trees indented instead of flattening or dropping them', () => {
    const orphan = child('orphan', null, 3)
    orphan.parent_agent = null
    const descendant = child('descendant', orphan.agent_id, 4)
    const rows = buildAgentHierarchy([configured, orphan, descendant])
    expect(rows.at(-3)).toMatchObject({ unresolved: true, label: 'unresolved parent' })
    expect(rows.at(-2)).toMatchObject({ agent: { agent_id: 'orphan' }, depth: 1, unresolved: true })
    expect(rows.at(-1)).toMatchObject({ agent: { agent_id: 'descendant' }, depth: 2, unresolved: true })
  })
  test('uses one shared axis for overlapping child lifecycles and activity marks', () => {
    const first = child('a', configured.agent_id, 1)
    const second = child('b', configured.agent_id, 2)
    second.started_at = '2025-01-01T00:00:03Z'
    second.ended_at = '2025-01-01T00:00:05Z'
    const origin = Date.parse('2025-01-01T00:00:00Z')
    expect(lifecycleGeometry(first, origin, 10_000, Date.now())).toEqual({ left: 20, width: 20 })
    expect(lifecycleGeometry(second, origin, 10_000, Date.now())).toEqual({ left: 30, width: 20 })
    expect(activityPosition({ ...activity(1), started_at: '2025-01-01T00:00:04Z' }, origin, 10_000)).toBe(40)
  })
})
