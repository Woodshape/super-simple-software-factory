<script setup lang="ts">
import { computed } from 'vue'
import type { SubagentActivity, SubagentDetail, SubagentSummary } from '../lib/types'
import { fmtDate, fmtDuration } from '../lib/format'
import { modelIcon, modelName } from '../lib/models'
import { subagentDuration } from '../lib/subagents'

const props = defineProps<{
  children: SubagentSummary[]
  selectedId: string | null
  detail: SubagentDetail | null
  activities: SubagentActivity[]
  nowMs: number
}>()
const emit = defineEmits<{ select: [id: string] }>()
const selected = computed(() => props.detail ?? props.children.find((c) => c.subagent_id === props.selectedId) ?? null)
function args(raw: string | null): string {
  if (!raw) return '{}'
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}
</script>

<template>
  <section v-if="children.length" class="subagents">
    <header>
      <div><strong>Nested subagents</strong> <span class="dim">{{ children.length }} conversations · {{ children.filter((c) => c.status === 'running').length }} live</span></div>
    </header>
    <div class="layout">
      <nav class="roster" aria-label="Nested subagents">
        <button v-for="child in children" :key="child.subagent_id" :class="{ active: child.subagent_id === selectedId }" @click="emit('select', child.subagent_id)">
          <span class="identity"><span :class="['dot', child.status]" />#{{ child.display_id }} · {{ child.subagent_id }}</span>
          <span class="task">{{ child.task }}</span>
          <span class="meta">{{ child.status }} · {{ child.turn_count }} turn{{ child.turn_count === 1 ? '' : 's' }} · {{ child.tool_count }} tools</span>
        </button>
      </nav>

      <div v-if="selected" class="detail">
        <div class="facts">
          <span><b>Status</b> {{ selected.status }}</span>
          <span><b>Duration</b> {{ fmtDuration(subagentDuration(selected.started_at, selected.ended_at, selected.duration_ms, nowMs)) }}</span>
          <span><b>Parent</b> {{ selected.parent_agent }} · {{ selected.phase_id }}</span>
          <span><b>Parent link</b> {{ selected.parent_event_id ?? selected.parent_tool_call_id ?? 'phase command' }}</span>
          <span><b>Created</b> {{ fmtDate(selected.created_at) }}</span>
          <span><b>Started</b> {{ fmtDate(selected.started_at) }}</span>
          <span><b>Ended</b> {{ selected.ended_at ? fmtDate(selected.ended_at) : 'still running' }}</span>
          <span class="wide"><b>Session</b> <code>{{ selected.session_path }}</code></span>
        </div>
        <div v-if="detail" class="turns">
          <article v-for="turn in detail.turns" :key="turn.turn_id" class="turn">
            <div class="turn-head">
              <strong>Turn {{ turn.turn }}</strong>
              <span :class="['status', turn.status]">{{ turn.status }}</span>
              <span v-if="turn.model" class="model"><img v-if="modelIcon(turn.model)" :src="modelIcon(turn.model)!" alt="" />{{ modelName(turn.model) }}</span>
              <span>{{ turn.thinking }} thinking</span><span>{{ turn.tool_count }} tools</span>
              <span>{{ fmtDuration(subagentDuration(turn.started_at, turn.ended_at, turn.duration_ms, nowMs)) }}</span>
            </div>
            <div class="label">Prompt</div><pre>{{ turn.prompt }}</pre>
            <template v-if="turn.error"><div class="label error">Error</div><pre>{{ turn.error }}</pre></template>
            <div class="label">Result</div><pre>{{ turn.result || (turn.status === 'running' ? 'running…' : 'no result recorded') }}</pre>
          </article>
        </div>
        <div v-if="activities.length" class="activity">
          <h3>Child tool activity</h3>
          <details v-for="tool in activities" :key="tool.cursor">
            <summary><span :class="tool.ok ? 'ok' : 'bad'">{{ tool.ok ? '✓' : '✗' }}</span> {{ tool.tool }} <span class="dim">turn {{ tool.turn }} · {{ fmtDuration(tool.duration_ms ?? Number.NaN) }}</span></summary>
            <div class="label">Arguments</div><pre>{{ args(tool.args_json) }}</pre>
            <div class="label">Result</div><pre>{{ tool.result_snippet || 'no result' }}</pre>
          </details>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.subagents { margin: 20px 28px; border: 1px solid var(--border-soft); border-radius: 16px; background: var(--surface); overflow: hidden; }
header { padding: 14px 18px; border-bottom: 1px solid var(--border-soft); font-size: 17px; }
.layout { display: grid; grid-template-columns: minmax(250px, 30%) 1fr; min-height: 180px; }
.roster { border-right: 1px solid var(--border-soft); display: flex; flex-direction: column; }
.roster button { text-align: left; border: 0; border-bottom: 1px solid var(--border-soft); padding: 12px 14px; background: transparent; color: var(--text); cursor: pointer; display: grid; gap: 4px; }
.roster button.active { background: rgba(108, 182, 255, .1); box-shadow: inset 3px 0 var(--blue); }
.identity { font-family: var(--mono); font-size: 14px; overflow-wrap: anywhere; }.task { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.meta { color: var(--dim); font-size: 14px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--dim); }.dot.running { background: var(--blue); animation: pulse 1.2s infinite; }.dot.success { background: var(--green); }.dot.error,.dot.cancelled,.dot.killed,.dot.interrupted { background: var(--red); }
.detail { padding: 16px; min-width: 0; }.facts { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px 18px; color: var(--dim); }.facts b { color: var(--text); margin-right: 6px; }.wide { grid-column: 1/-1; overflow-wrap: anywhere; }
.turn { margin-top: 16px; border: 1px solid var(--border-soft); border-radius: 10px; padding: 12px; }.turn-head { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; color: var(--dim); }.turn-head strong { color: var(--text); }.model { display: inline-flex; gap: 5px; align-items: center; }.model img { width: 16px; height: 16px; }.status.running { color: var(--blue); }.status.success,.ok { color: var(--green); }.status.error,.status.cancelled,.status.killed,.status.interrupted,.bad,.error { color: var(--red); }
.label { margin-top: 10px; color: var(--dim); text-transform: uppercase; font-size: 12px; letter-spacing: .08em; }pre { margin: 4px 0 0; padding: 10px; max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--panel-2); border-radius: 6px; font-family: var(--mono); }.activity h3 { margin-top: 18px; }.activity details { border-top: 1px solid var(--border-soft); padding: 10px 0; }.activity summary { cursor: pointer; }
@media (max-width: 850px) { .layout { grid-template-columns: 1fr; }.roster { border-right: 0; border-bottom: 1px solid var(--border-soft); }.facts { grid-template-columns: 1fr; } }
</style>
