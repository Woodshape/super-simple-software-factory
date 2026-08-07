<script setup lang="ts">
import type { AgentActivity, AgentDetail, Envelope, EventRow, GateResult, Phase, TraceAgent } from '../lib/types'
import { computed, ref, watch } from 'vue'
import { fmtDate, fmtDuration, ts } from '../lib/format'
import { modelIcon, modelName } from '../lib/models'
import { agentDuration } from '../lib/agents'
import StatusChip from './StatusChip.vue'
import StatChip from './StatChip.vue'
import ConfiguredAgentDetail from './ConfiguredAgentDetail.vue'
import ToolCallRow from './ToolCallRow.vue'
import AgentMessageFlow from './AgentMessageFlow.vue'

const props = defineProps<{
  agent: TraceAgent | null
  phase: Phase | null
  detail: AgentDetail | null
  activities: AgentActivity[]
  events: EventRow[]
  envelopes: Envelope[]
  gates: GateResult[]
  nowMs: number
}>()
defineEmits<{ close: [] }>()
const nested = computed(() => props.agent?.source === 'nested' ? props.agent : null)
const configured = computed(() => props.phase && props.agent?.source !== 'nested' ? props.phase : null)
const turns = computed(() => props.detail?.source === 'nested' ? props.detail.turns : [])
const messageCapable = computed(() => nested.value !== null || configured.value?.kind === 'agent')
const messageAgentId = computed(() => messageCapable.value ? (props.agent?.agent_id ?? configured.value?.phase_id ?? null) : null)
const messageAdwId = computed(() => messageCapable.value ? (props.agent?.adw_id ?? configured.value?.adw_id ?? null) : null)
const messageKey = computed(() => `${messageAdwId.value ?? ''}:${messageAgentId.value ?? ''}`)
const mode = ref<'messages' | 'actions'>('messages')
watch(messageKey, () => { mode.value = 'messages' }, { flush: 'sync' })
const configuredDuration = computed(() => {
  const phase = configured.value
  const start = ts(phase?.started_at)
  if (!phase || !Number.isFinite(start)) return Number.NaN
  const end = phase.status === 'running' ? props.nowMs : ts(phase.ended_at)
  return Number.isFinite(end) ? end - start : Number.NaN
})
</script>

<template>
  <section v-if="configured || nested" class="detail agent-detail">
    <header class="head">
      <div v-if="configured" class="identity">
        <strong>{{ configured.name }}</strong>
        <code>{{ configured.phase_id }}</code>
      </div>
      <div v-else-if="nested" class="identity">
        <strong>{{ nested.name }}</strong>
        <code>{{ nested.subagent_id }}</code>
      </div>

      <StatusChip v-if="configured" :status="configured.status ?? 'queued'" />
      <StatusChip v-else-if="nested" :status="nested.status ?? 'error'" />
      <StatChip v-if="configured && Number.isFinite(configuredDuration)" kind="runtime" :value="configuredDuration" />
      <span v-else-if="nested">{{ fmtDuration(agentDuration(nested.started_at, nested.ended_at, nested.duration_ms, nowMs, nested.status)) }}</span>

      <div v-if="configured" class="tags">
        <span>owner <b>{{ configured.owner ?? '—' }}</b></span>
        <span>kind <b>{{ configured.kind ?? '—' }}</b></span>
        <span>attempt <b>{{ configured.attempt ?? 0 }}/{{ configured.retries ?? 0 }}</b></span>
      </div>
      <div v-else-if="nested" class="tags">
        <span>parent <b>{{ nested.parent_agent ?? 'unresolved' }}</b></span>
        <span>phase <b>{{ nested.parent_agent_id ?? nested.phase_id ?? '—' }}</b></span>
      </div>
      <div v-if="messageCapable" class="view-toggle" role="group" aria-label="Agent detail view">
        <button :class="{ active: mode === 'messages' }" :aria-pressed="mode === 'messages'" @click="mode = 'messages'">Messages</button>
        <button :class="{ active: mode === 'actions' }" :aria-pressed="mode === 'actions'" @click="mode = 'actions'">Actions</button>
      </div>
      <button class="close" title="close" @click="$emit('close')">✕</button>
    </header>

    <AgentMessageFlow
      v-if="mode === 'messages' && messageAdwId && messageAgentId"
      :key="`${messageAdwId}:${messageAgentId}`"
      :adw-id="messageAdwId"
      :agent-id="messageAgentId"
      :running="agent?.status === 'running' || configured?.status === 'running'"
    />

    <ConfiguredAgentDetail
      v-else-if="configured && (!messageCapable || mode === 'actions')"
      :phase="configured"
      :events="events"
      :envelopes="envelopes"
      :gates="gates"
    />

    <template v-else-if="mode === 'actions' && nested">
      <div class="facts">
        <div><b>Task</b><p>{{ nested.task ?? 'no task recorded' }}</p></div>
        <div><b>Model / thinking</b><p class="model"><img v-if="modelIcon(nested.model)" :src="modelIcon(nested.model)!" alt="" />{{ modelName(nested.model) }} · {{ nested.thinking ?? 'default' }}</p></div>
        <div><b>Lifecycle</b><p>{{ fmtDate(nested.started_at) }} → {{ nested.status === 'running' ? 'running' : fmtDate(nested.ended_at) }}</p></div>
        <div><b>Parent link</b><p><code>{{ nested.parent_event_id ?? nested.parent_tool_call_id ?? 'phase command' }}</code></p></div>
        <div class="wide"><b>Session</b><p><code>{{ nested.session_path ?? 'not recorded' }}</code></p></div>
      </div>
      <div class="grid">
        <div>
          <h3>Turns ({{ turns.length }})</h3>
          <article v-for="turn in turns" :key="turn.turn_id" class="turn">
            <header><strong>Turn {{ turn.turn }}</strong><StatusChip :status="turn.status ?? 'error'" /><span>{{ turn.model ? modelName(turn.model) : '' }} · {{ turn.thinking ?? 'default' }} thinking · {{ turn.tool_count ?? 0 }} tools · {{ fmtDuration(agentDuration(turn.started_at, turn.ended_at, turn.duration_ms, nowMs, turn.status)) }}</span></header>
            <h4>Prompt</h4><pre>{{ turn.prompt ?? 'no prompt recorded' }}</pre>
            <template v-if="turn.error"><h4 class="bad">Error</h4><pre>{{ turn.error }}</pre></template>
            <h4>Result</h4><pre>{{ turn.result ?? (turn.status === 'running' ? 'running…' : 'no result recorded') }}</pre>
          </article>
        </div>
        <div>
          <h3>Tools ({{ activities.length }})</h3>
          <ToolCallRow
            v-for="tool in activities"
            :key="tool.cursor"
            :time="tool.started_at"
            :tool="tool.tool"
            :ok="tool.ok"
            :duration-ms="tool.duration_ms"
            :args-json="tool.args_json"
            :result="tool.result_snippet"
            :turn="tool.turn"
          />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.detail { margin: 0 28px 28px; border: 1px solid var(--border-soft); border-radius: 16px; background: var(--surface); overflow: hidden; }
.head { display:flex; align-items:center; gap:16px; padding:14px 18px; background:var(--panel-2); border-bottom:1px solid var(--border); flex-wrap:wrap; }
.identity { display:grid; gap:2px; }.identity strong { font-size:20px; }.identity code { color:var(--dim); }.tags { margin-left:auto; display:flex; gap:10px; }.tags span { border:1px solid var(--border-soft); border-radius:999px; padding:2px 10px; color:var(--dim); }.tags b { color:var(--text); }
.view-toggle { display:flex; border:1px solid var(--border); border-radius:8px; overflow:hidden; }.view-toggle button { padding:4px 12px; border:0; border-right:1px solid var(--border); background:none; color:var(--dim); cursor:pointer; }.view-toggle button:last-child { border-right:0; }.view-toggle button.active { background:var(--panel-3); color:var(--text); font-weight:700; }.close { background:none; border:1px solid var(--border); border-radius:6px; color:var(--dim); cursor:pointer; padding:3px 10px; }.facts { padding:16px 18px; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 24px; border-bottom:1px solid var(--border-soft); }.facts b,h3,h4 { color:var(--dim); }.facts p { margin:4px 0; white-space:pre-wrap; overflow-wrap:anywhere; }.wide { grid-column:1/-1; }.model { display:flex; align-items:center; gap:7px; }.model img { width:17px; height:17px; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; padding:16px 18px 20px; }.grid h3 { border-bottom:1px solid var(--border-soft); padding-bottom:8px; }.turn { border:1px solid var(--border-soft); border-radius:10px; padding:12px; margin-bottom:12px; }.turn header { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }.turn h4 { margin:12px 0 4px; font-size:12px; text-transform:uppercase; letter-spacing:.08em; }.turn pre { margin:0; padding:10px; max-height:38vh; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--panel-2); border-radius:6px; }.bad { color:var(--red); }
@media(max-width:1000px){.grid,.facts{grid-template-columns:1fr}.wide{grid-column:auto}.tags{margin-left:0}}
</style>
