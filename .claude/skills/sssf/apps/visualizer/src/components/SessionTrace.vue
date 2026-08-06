<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue'
import type {
  AgentActivity,
  AgentDetail,
  ConfiguredAgent,
  AgentStartPayload,
  Envelope,
  EventRow,
  GateResult,
  Phase,
  PhaseKind,
  Session,
  SessionUsage,
  NestedAgent,
  TraceAgent,
} from '../lib/types'
import { Bot, SquareTerminal, UserRound } from 'lucide-vue-next'
import {
  fetchEnvelopes,
  fetchEvents,
  fetchGates,
  fetchSession,
  fetchAgent,
  fetchAgentActivity,
} from '../lib/api'
import { axisTicks, fmtDate, payloadOk, ts } from '../lib/format'
import { modelIcon, modelName } from '../lib/models'
import { agentColor, hexAlpha, parseAgentStart } from '../lib/events'
import { navigate, agentCrumb } from '../lib/router'
import StatusChip from './StatusChip.vue'
import StatChip from './StatChip.vue'
import AgentDetailPanel from './AgentDetail.vue'
import { activityPosition, buildAgentHierarchy, lifecycleGeometry, mergeActivities, nestedRowsForConfiguredParents } from '../lib/agents'

const props = defineProps<{ adwId: string; agentId: string | null }>()

const session = ref<Session | null>(null)
const phases = ref<Phase[]>([])
const agents = ref<TraceAgent[]>([])
const usage = ref<SessionUsage>({ read: 0, written: 0 })
const events = ref<EventRow[]>([])
const envelopes = ref<Envelope[]>([])
const gates = ref<GateResult[]>([])
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())
const agentDetail = ref<AgentDetail | null>(null)
const activitiesByAgent = ref<Record<string, AgentActivity[]>>({})

let cursor = 0
const activityCursors: Record<string, number> = {}
let inflight = false
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined

const EVENT_PAGE_LIMIT = 500
const LIVE_POLL_MS = 500
const RETRY_MS = 1000
const SIDE_TABLE_TYPES = new Set(['gate_pass', 'gate_fail', 'handoff', 'agent_end', 'phase_end', 'error'])

function schedule(delay: number) {
  clearTimeout(timer)
  if (!disposed) timer = setTimeout(() => void tick(), delay)
}

async function tick() {
  if (inflight || disposed) return
  inflight = true
  let nextDelay: number | null = null
  try {
    const detail = await fetchSession(props.adwId)
    session.value = detail.session
    phases.value = detail.phases.toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    agents.value = detail.agents
    usage.value = detail.usage

    const childRoster = detail.agents.filter((agent): agent is NestedAgent => agent.source === 'nested')
    const pages = await Promise.all(childRoster.map(async (child) => {
      const after = activityCursors[child.agent_id] ?? 0
      const page = await fetchAgentActivity(props.adwId, child.agent_id, after)
      activityCursors[child.agent_id] = Math.max(after, page.cursor)
      activitiesByAgent.value = {
        ...activitiesByAgent.value,
        [child.agent_id]: mergeActivities(activitiesByAgent.value[child.agent_id] ?? [], page.activities),
      }
      return page
    }))
    const activityHasMore = pages.some((page) => page.has_more)
    const selected = detail.agents.find((agent) => agent.agent_id === props.agentId)
    if (selected?.source === 'nested') {
      const selectedDetail = await fetchAgent(props.adwId, selected.agent_id)
      if (props.agentId === selected.agent_id) agentDetail.value = selectedDetail
    } else agentDetail.value = null

    // Exactly one bounded page is handled per turn. A backlog schedules its
    // next cursor page immediately, while an exhausted live trace waits.
    const page = await fetchEvents(props.adwId, cursor, EVENT_PAGE_LIMIT)
    cursor = Math.max(cursor, page.cursor)
    const fresh = page.events
    if (fresh.length) events.value = [...events.value, ...fresh]

    // Envelopes and gates only gain rows around phase/agent boundaries — refetch
    // on those events instead of every poll.
    if (!loaded.value || fresh.some((e) => e.type !== null && SIDE_TABLE_TYPES.has(e.type))) {
      const [env, g] = await Promise.all([fetchEnvelopes(props.adwId), fetchGates(props.adwId)])
      envelopes.value = env
      gates.value = g
    }

    nowMs.value = Date.now()
    apiError.value = null
    loaded.value = true
    // A completed session drains every cursor page, then becomes entirely
    // static. A running session keeps one non-overlapping live poll alive.
    const childRunning = childRoster.some((child) => child.status === 'running')
    nextDelay = page.has_more || activityHasMore
      ? 0
      : detail.session.status === 'running' || childRunning
        ? LIVE_POLL_MS
        : null
  } catch (err) {
    apiError.value = err instanceof Error ? err.message : String(err)
    nextDelay = RETRY_MS
  } finally {
    inflight = false
    if (nextDelay !== null) schedule(nextDelay)
  }
}

onMounted(() => void tick())

onUnmounted(() => {
  disposed = true
  clearTimeout(timer)
  agentCrumb.value = null
})

const selectedAgent = computed(() => agents.value.find((agent) => agent.agent_id === props.agentId) ?? null)
const selectedPhase = computed(() => {
  const phaseId = selectedAgent.value?.source === 'configured'
    ? selectedAgent.value.phase_id
    : props.agentId
  return phases.value.find((phase) => phase.phase_id === phaseId) ?? null
})

watchEffect(() => {
  agentCrumb.value = selectedAgent.value?.name ?? selectedPhase.value?.name ?? null
})

// Completed traces stop polling, so a later click must still lazy-load its detail.
watch(
  () => [props.agentId, selectedAgent.value?.source] as const,
  async ([id, source]) => {
    if (!id || source !== 'nested') { agentDetail.value = null; return }
    try {
      const detail = await fetchAgent(props.adwId, id)
      if (props.agentId === id) agentDetail.value = detail
    } catch (error) {
      if (props.agentId === id) apiError.value = error instanceof Error ? error.message : String(error)
    }
  },
)

// ── Lanes ────────────────────────────────────────────────────────────────────

const ENGINEER_COLOR = '#e8b64a'
const CODE_COLOR = '#5ad2dd'

const KIND_ICONS = { engineer: UserRound, code: SquareTerminal, agent: Bot }

interface Lane {
  id: string
  label: string
  /** Model driving this lane's agent — rendered with its provider icon. */
  model: string | null
  /** Context-window occupancy, or null while unknown (running / old db). */
  context: LaneContext | null
  metaLines: string[]
  color: string
  kind: PhaseKind
  phases: Phase[]
}

interface LaneContext {
  used: number
  window: number
  /** 0–100, uncapped by the floor applied to the bar's width. */
  pct: number
}

/** Occupancy for an agent lane. Null unless BOTH numbers are real — a bar
 *  against an unknown ceiling would be decoration, not data. */
function laneContext(info: ConfiguredAgent | undefined): LaneContext | null {
  const used = info?.context_tokens ?? 0
  const window = info?.context_window ?? 0
  if (!used || !window) return null
  return { used, window, pct: Math.min(100, (used / window) * 100) }
}

/** Sub-1% occupancy is common and real; round it away and the bar reads empty. */
function contextLabel(ctx: LaneContext): string {
  return ctx.pct < 1 ? `${ctx.pct.toFixed(1)}%` : `${Math.round(ctx.pct)}%`
}

/** Keep a non-zero fill visible — the exact numbers ride in the label and title. */
function contextFill(ctx: LaneContext): string {
  return `${Math.max(ctx.pct, 2)}%`
}

const NUM = new Intl.NumberFormat('en-US')

// A live agent's model/thinking/color arrive on its agent_start event before
// any agent_sessions row exists; attribute each start to its phase's owner.
const ownerStart = computed<Record<string, AgentStartPayload>>(() => {
  const ownerByPhase = new Map<string, string | null>(
    phases.value.map((p) => [p.phase_id, p.owner]),
  )
  const meta: Record<string, AgentStartPayload> = {}
  for (const e of events.value) {
    if (e.type !== 'agent_start') continue
    const owner = (e.phase_id ? ownerByPhase.get(e.phase_id) : null) ?? e.name
    if (!owner || meta[owner]) continue
    const payload = parseAgentStart(e)
    if (payload) meta[owner] = payload
  }
  return meta
})

const lanes = computed<Lane[]>(() => {
  const ph = phases.value
  const agentOwners: string[] = []
  for (const p of ph) {
    if (p.kind === 'agent' && p.owner && !agentOwners.includes(p.owner)) agentOwners.push(p.owner)
  }
  const codePhases = ph.filter((p) => p.kind === 'code')
  const out: Lane[] = [
    {
      id: 'engineer',
      label: session.value?.engineer ?? 'engineer',
      model: null,
      context: null,
      metaLines: ['engineer'],
      color: ENGINEER_COLOR,
      kind: 'engineer' as const,
      phases: ph.filter((p) => p.kind === 'engineer'),
    },
  ]
  if (codePhases.length) {
    out.push({
      id: 'code',
      label: 'code',
      model: null,
      context: null,
      metaLines: ['workspace'],
      color: CODE_COLOR,
      kind: 'code' as const,
      phases: codePhases,
    })
  }
  for (const [i, owner] of agentOwners.entries()) {
    const info = agents.value.find((a): a is ConfiguredAgent => a.source === 'configured' && a.agent === owner)
    const start = ownerStart.value[owner]
    out.push({
      id: `agent:${owner}`,
      label: owner,
      // The model is the lane's whole story; thinking level lives in the
      // phase detail's agent config section.
      model: info?.model ?? start?.model ?? null,
      context: laneContext(info),
      metaLines: [],
      color: agentColor(info?.color, start?.color, i),
      kind: 'agent' as const,
      phases: ph.filter((p) => p.kind === 'agent' && p.owner === owner),
    })
  }
  return out
})

// ── Timeline geometry ────────────────────────────────────────────────────────

const range = computed(() => {
  let t0 = Infinity
  let t1 = -Infinity
  const s = session.value
  const sStart = ts(s?.started_at)
  const sEnd = ts(s?.ended_at)
  if (Number.isFinite(sStart)) t0 = Math.min(t0, sStart)
  if (Number.isFinite(sEnd)) t1 = Math.max(t1, sEnd)
  for (const p of phases.value) {
    const a = ts(p.started_at)
    const b = ts(p.ended_at)
    if (Number.isFinite(a)) {
      t0 = Math.min(t0, a)
      t1 = Math.max(t1, a)
    }
    if (Number.isFinite(b)) t1 = Math.max(t1, b)
  }
  for (const agent of agents.value) {
    if (agent.source !== 'nested') continue
    const a = ts(agent.started_at ?? agent.created_at)
    const b = agent.status === 'running' ? nowMs.value : ts(agent.ended_at)
    if (Number.isFinite(a)) { t0 = Math.min(t0, a); t1 = Math.max(t1, a) }
    if (Number.isFinite(b)) t1 = Math.max(t1, b)
    for (const activity of activitiesByAgent.value[agent.agent_id] ?? []) {
      const at = ts(activity.started_at)
      if (Number.isFinite(at)) { t0 = Math.min(t0, at); t1 = Math.max(t1, at) }
    }
  }
  if (s?.status === 'running') t1 = Math.max(t1, nowMs.value)
  if (!Number.isFinite(t0)) {
    t0 = nowMs.value
    t1 = t0 + 1000
  }
  if (t1 - t0 < 1000) t1 = t0 + 1000
  return { t0, t1, span: t1 - t0 }
})

// The engineer's request opens the run and owns the start of the timeline: it
// gets an exclusive leading zone, and every later phase maps into the rest —
// nothing can render on top of it.
const REQ_ZONE_PCT = 16

const requestPhase = computed(
  () => phases.value.find((p) => p.kind === 'engineer' && p.started_at) ?? null,
)

const zonePct = computed(() => (requestPhase.value ? REQ_ZONE_PCT : 0))

/**
 * Where the post-request timeline begins, in ms.
 *
 * The earliest non-engineer phase start, not the request phase's end: a later
 * ADW joining the session pushes the request row's ended_at forward, which
 * would otherwise throw every already-finished phase behind the origin.
 */
const originMs = computed(() => {
  const { t0 } = range.value
  const req = requestPhase.value
  if (!req) return t0
  let earliest = Infinity
  for (const p of phases.value) {
    if (p.kind === 'engineer') continue
    const s = ts(p.started_at)
    if (Number.isFinite(s)) earliest = Math.min(earliest, s)
  }
  if (Number.isFinite(earliest)) return Math.max(earliest, t0)
  const end = ts(req.ended_at ?? req.started_at)
  return Number.isFinite(end) ? Math.max(end, t0) : t0
})

const postSpan = computed(() => Math.max(range.value.t1 - originMs.value, 1000))

const ticks = computed(() => {
  const zone = zonePct.value
  return axisTicks(postSpan.value, 7).map((t) => ({
    pct: zone + (t.pct * (100 - zone)) / 100,
    label: t.label,
  }))
})

/**
 * Adjusted layout for every timed phase, in track-%.
 *
 * Phases are sequential by doctrine, and the render must say so: when a
 * near-zero phase (a git commit) is widened to a readable floor, every later
 * block shifts right by the same amount instead of being overlapped, and the
 * whole layout is normalized back into the track. Blocks may squeeze a hair;
 * they never stack.
 */
const MIN_BLOCK_PCT = 3.5

const blockLayout = computed<Record<string, { left: number; width: number }>>(() => {
  const zone = zonePct.value
  const avail = 100 - zone - 0.4 // hair of right margin
  const t0 = originMs.value
  const span = postSpan.value
  const reqId = requestPhase.value?.phase_id

  const timed = phases.value
    .filter((p) => p.phase_id !== reqId && Number.isFinite(ts(p.started_at)))
    .map((p) => {
      const start = ts(p.started_at)
      let end = ts(p.ended_at)
      if (!Number.isFinite(end)) end = p.status === 'running' ? nowMs.value : start
      return {
        id: p.phase_id,
        start,
        left: ((start - t0) / span) * avail,
        width: ((Math.max(end, start) - start) / span) * avail,
      }
    })
    .toSorted((a, b) => a.start - b.start)

  let shift = 0
  let prevEdge = 0
  const rows: { id: string; left: number; width: number }[] = []
  for (const b of timed) {
    let left = b.left + shift
    if (left < prevEdge) {
      shift += prevEdge - left
      left = prevEdge
    }
    const width = Math.max(b.width, MIN_BLOCK_PCT)
    shift += width - b.width
    prevEdge = left + width
    rows.push({ id: b.id, left, width })
  }

  const scale = avail / Math.max(prevEdge, avail)
  const out: Record<string, { left: number; width: number }> = {}
  for (const r of rows) out[r.id] = { left: zone + r.left * scale, width: r.width * scale }
  return out
})

function blockGeom(p: Phase): { left: string; width: string } | null {
  // The request block fills its reserved zone, nothing else ever enters it.
  if (p.phase_id === requestPhase.value?.phase_id && zonePct.value > 0) {
    return { left: '0.4%', width: `${zonePct.value - 0.8}%` }
  }
  const geom = blockLayout.value[p.phase_id]
  if (!geom) return null
  return { left: `${geom.left}%`, width: `${geom.width}%` }
}

function blockStyle(p: Phase, lane: Lane): Record<string, string> | undefined {
  const geom = blockGeom(p)
  if (!geom) return undefined
  return {
    left: geom.left,
    width: geom.width,
    background: `linear-gradient(180deg, ${hexAlpha(lane.color, 0.2)}, ${hexAlpha(lane.color, 0.05)})`,
    borderColor: p.status === 'fail' ? 'rgba(255, 111, 103, 0.8)' : hexAlpha(lane.color, 0.55),
    '--lane-glow': hexAlpha(lane.color, 0.28),
  }
}

function blockDurationMs(p: Phase): number {
  const start = ts(p.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = p.status === 'running' ? nowMs.value : ts(p.ended_at)
  if (!Number.isFinite(end)) return NaN
  return end - start
}

const STATUS_GLYPH: Record<string, string> = {
  success: '✓',
  fail: '✗',
  running: '●',
  queued: '○',
}

// Tool-call tick marks inside a phase block, positioned within the block's own span.
interface ToolTick {
  t: number
  ok: boolean
}

interface NestedLaneRow { agent: NestedAgent; depth: number }
const hierarchy = computed(() => buildAgentHierarchy(agents.value))
const collapsedChildLanes = ref<Set<string>>(new Set())

function childrenForLane(lane: Lane): NestedLaneRow[] {
  return nestedRowsForConfiguredParents(
    hierarchy.value,
    new Set(lane.phases.map((phase) => phase.phase_id)),
  )
}

function childrenExpanded(lane: Lane): boolean {
  return !collapsedChildLanes.value.has(lane.id)
}

function toggleChildren(lane: Lane) {
  const children = childrenForLane(lane)
  if (!children.length) return
  const collapsed = new Set(collapsedChildLanes.value)
  if (collapsed.has(lane.id)) {
    collapsed.delete(lane.id)
  } else {
    collapsed.add(lane.id)
    if (props.agentId && children.some((row) => row.agent.agent_id === props.agentId)) {
      agentDetail.value = null
      navigate(props.adwId)
    }
  }
  collapsedChildLanes.value = collapsed
}

const selectedChildHidden = computed(() => selectedAgent.value?.source === 'nested'
  && lanes.value.some((lane) => !childrenExpanded(lane)
    && childrenForLane(lane).some((row) => row.agent.agent_id === selectedAgent.value?.agent_id)))

const unresolvedChildren = computed<NestedLaneRow[]>(() => hierarchy.value
  .filter((row): row is typeof row & { agent: NestedAgent } => row.unresolved && row.agent?.source === 'nested')
  .map((row) => ({ agent: row.agent, depth: row.depth })))

function childGeom(child: NestedAgent): { left: string; width: string } | null {
  const raw = lifecycleGeometry(child, originMs.value, postSpan.value, nowMs.value, 1.2)
  if (!raw) return null
  const zone = zonePct.value
  const avail = 100 - zone
  return { left: `${zone + raw.left * avail / 100}%`, width: `${raw.width * avail / 100}%` }
}

function childMark(activity: AgentActivity): string | null {
  const raw = activityPosition(activity, originMs.value, postSpan.value)
  if (raw === null) return null
  return `${zonePct.value + raw * (100 - zonePct.value) / 100}%`
}

const toolTicks = computed(() => {
  const map: Record<string, ToolTick[]> = {}
  for (const e of events.value) {
    if (e.type !== 'tool_call' || !e.phase_id) continue
    map[e.phase_id] ??= []
    map[e.phase_id]?.push({ t: ts(e.started_at), ok: payloadOk(e.payload_json) })
  }
  return map
})

function ticksFor(p: Phase): { x: number; ok: boolean }[] {
  const start = ts(p.started_at)
  if (!Number.isFinite(start)) return []
  let end = ts(p.ended_at)
  if (!Number.isFinite(end)) end = p.status === 'running' ? nowMs.value : start
  const width = Math.max(end - start, 1)
  return (toolTicks.value[p.phase_id] ?? [])
    .filter((mark) => Number.isFinite(mark.t))
    .map((mark) => ({
      x: Math.min(Math.max(((mark.t - start) / width) * 100, 1), 99),
      ok: mark.ok,
    }))
}

const queuedByLane = computed(() => {
  const map: Record<string, Phase[]> = {}
  for (const lane of lanes.value) {
    map[lane.id] = lane.phases.filter((p) => !p.started_at)
  }
  return map
})

const sessionDurationMs = computed(() => {
  const s = session.value
  if (!s) return NaN
  const start = ts(s.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = s.status === 'running' ? nowMs.value : ts(s.ended_at)
  return (Number.isFinite(end) ? end : nowMs.value) - start
})

function selectPhase(p: Phase) {
  navigate(props.adwId, p.phase_id === props.agentId ? null : p.phase_id)
}

function selectAgent(id: string) {
  navigate(props.adwId, id === props.agentId ? null : id)
}
</script>

<template>
  <div class="trace">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <div v-if="session" class="run-strip">
      <span class="request" :title="session.request ?? ''">{{ session.request }}</span>
      <StatusChip :status="session.status ?? 'fail'" />
      <span class="dim">started {{ fmtDate(session.started_at) }}</span>
      <span class="run-stats">
        <StatChip kind="cost" :value="session.total_cost" />
        <StatChip kind="runtime" :value="sessionDurationMs" />
        <StatChip kind="tokens" :value="session.total_tokens" />
        <StatChip kind="read" :value="usage.read" />
        <StatChip kind="written" :value="usage.written" />
      </span>
    </div>

    <div v-if="phases.length" class="waterfall">
      <div class="row axis-row">
        <div class="label" />
        <div class="track">
          <span v-if="zonePct" class="zone-head" :style="{ width: `${zonePct}%` }">request</span>
          <span
            v-for="(t, i) in ticks"
            :key="i"
            class="axis-label"
            :style="{ left: `${t.pct}%` }"
            >{{ t.label }}</span
          >
        </div>
      </div>

      <template v-for="lane in lanes" :key="lane.id">
      <div class="row lane" :class="`kind-${lane.kind}`">
        <div class="label">
          <span class="lane-name" :style="{ color: lane.color }">
            <component :is="KIND_ICONS[lane.kind]" class="lane-icon" :size="22" :stroke-width="2" />
            {{ lane.label }}
          </span>
          <span v-if="lane.model" class="lane-meta lane-model" :title="lane.model">
            <img v-if="modelIcon(lane.model)" class="model-icon" :src="modelIcon(lane.model)!" alt="" />
            {{ modelName(lane.model) }}
          </span>
          <span
            v-if="lane.context"
            class="lane-ctx"
            :title="`${NUM.format(lane.context.used)} / ${NUM.format(lane.context.window)} tokens used · ${NUM.format(lane.context.window - lane.context.used)} remaining`"
          >
            <span class="ctx-head">
              <span class="ctx-label">Context</span>
              <span class="ctx-pct">{{ contextLabel(lane.context) }}</span>
            </span>
            <span class="ctx-bar">
              <span
                class="ctx-fill"
                :style="{
                  width: contextFill(lane.context),
                  background: `linear-gradient(90deg, ${hexAlpha(lane.color, 0.55)}, ${lane.color})`,
                  boxShadow: `0 0 10px ${hexAlpha(lane.color, 0.45)}`,
                }"
              />
            </span>
          </span>
          <button
            v-if="lane.kind === 'agent' && childrenForLane(lane).length"
            type="button"
            class="subagent-toggle"
            :aria-expanded="childrenExpanded(lane)"
            @click="toggleChildren(lane)"
          >
            {{ childrenExpanded(lane) ? 'Hide subagents' : 'Show subagents' }}
          </button>
          <span v-for="(line, i) in lane.metaLines" :key="i" class="lane-meta">{{ line }}</span>
        </div>
        <div class="track">
          <span v-if="zonePct" class="zone-divider" :style="{ left: `${zonePct}%` }" />
          <span v-for="(t, i) in ticks" :key="i" class="gridline" :style="{ left: `${t.pct}%` }" />
          <template v-for="p in lane.phases" :key="p.phase_id">
            <button
              v-if="blockGeom(p)"
              class="block"
              :class="[p.status, { selected: p.phase_id === agentId }]"
              :style="blockStyle(p, lane)"
              :title="`${p.name} — ${p.status}${p.description ? `\n${p.description}` : ''}`"
              @click="selectPhase(p)"
            >
              <span class="b-top">
                <span class="b-status" :class="p.status">{{
                  STATUS_GLYPH[p.status ?? ''] ?? '○'
                }}</span>
                <span class="b-name">{{ p.name }}</span>
                <StatChip
                  v-if="Number.isFinite(blockDurationMs(p))"
                  class="b-dur"
                  kind="runtime"
                  compact
                  :value="blockDurationMs(p)"
                />
              </span>
              <span class="b-desc">{{ p.description }}</span>
              <span
                v-for="(tick, i) in ticksFor(p)"
                :key="i"
                class="tool-tick"
                :class="{ err: !tick.ok }"
                :style="{ left: `${tick.x}%` }"
              />
            </button>
          </template>
          <button
            v-for="(p, i) in queuedByLane[lane.id]"
            :key="p.phase_id"
            class="block queued"
            :class="{ selected: p.phase_id === agentId }"
            :style="{ right: `${10 + i * 5}px`, width: '170px' }"
            :title="`${p.name} — queued`"
            @click="selectPhase(p)"
          >
            <span class="b-top">
              <span class="b-status queued">○</span>
              <span class="b-name">{{ p.name }}</span>
            </span>
            <span class="b-desc">queued</span>
          </button>
        </div>
      </div>
      <template v-if="childrenExpanded(lane)">
        <div v-for="childRow in childrenForLane(lane)" :key="childRow.agent.agent_id" class="row lane child-row">
          <div class="label child-label" :style="{ paddingLeft: `${42 + Math.max(0, childRow.depth - 1) * 18}px` }">
            <span class="branch">↳</span>
            <span class="lane-name">#{{ childRow.agent.display_id ?? '?' }} · {{ childRow.agent.subagent_id }}</span>
            <span class="lane-meta lane-model"><img v-if="modelIcon(childRow.agent.model)" class="model-icon" :src="modelIcon(childRow.agent.model)!" alt="" />{{ modelName(childRow.agent.model) }}</span>
            <span class="lane-meta">{{ childRow.agent.status }} · {{ childRow.agent.turn_count }} turn{{ childRow.agent.turn_count === 1 ? '' : 's' }} · {{ childRow.agent.tool_count }} tools</span>
          </div>
          <div class="track child-track">
            <span v-if="zonePct" class="zone-divider" :style="{ left: `${zonePct}%` }" />
            <span v-for="(t, i) in ticks" :key="i" class="gridline" :style="{ left: `${t.pct}%` }" />
            <button v-if="childGeom(childRow.agent)" class="block child-block" :class="[childRow.agent.status, { selected: childRow.agent.agent_id === agentId }]" :style="childGeom(childRow.agent)!" :title="childRow.agent.task ?? childRow.agent.name" @click="selectAgent(childRow.agent.agent_id)">
              <span class="b-top"><span class="b-status" :class="childRow.agent.status">{{ STATUS_GLYPH[childRow.agent.status ?? ''] ?? '✗' }}</span><span class="b-name">{{ childRow.agent.task ?? childRow.agent.name }}</span></span>
              <span class="b-desc">{{ childRow.agent.thinking ?? 'default' }} thinking</span>
            </button>
            <span v-for="tool in activitiesByAgent[childRow.agent.agent_id] ?? []" :key="tool.cursor" class="child-tool-tick" :class="{ err: tool.ok === 0 }" :style="{ left: childMark(tool) ?? '-10px' }" :title="`${tool.tool ?? 'tool'} · turn ${tool.turn ?? '—'}`" />
          </div>
        </div>
      </template>
      </template>
      <div v-if="unresolvedChildren.length" class="row lane unresolved-row">
        <div class="label"><span class="lane-name">Unresolved parent</span><span class="lane-meta">legacy nested agents</span></div>
        <div class="track"><span v-for="(t, i) in ticks" :key="i" class="gridline" :style="{ left: `${t.pct}%` }" /></div>
      </div>
      <div v-for="childRow in unresolvedChildren" :key="childRow.agent.agent_id" class="row lane child-row">
        <div class="label child-label" :style="{ paddingLeft: `${42 + Math.max(0, childRow.depth - 1) * 18}px` }"><span class="branch">↳</span><span class="lane-name">#{{ childRow.agent.display_id ?? '?' }} · {{ childRow.agent.subagent_id }}</span><span class="lane-meta">{{ childRow.agent.parent_agent ?? 'unknown parent' }} · {{ childRow.agent.status }}</span></div>
        <div class="track child-track">
          <span v-for="(t, i) in ticks" :key="i" class="gridline" :style="{ left: `${t.pct}%` }" />
          <button v-if="childGeom(childRow.agent)" class="block child-block" :class="[childRow.agent.status, { selected: childRow.agent.agent_id === agentId }]" :style="childGeom(childRow.agent)!" :title="childRow.agent.task ?? childRow.agent.name" @click="selectAgent(childRow.agent.agent_id)"><span class="b-top"><span class="b-name">{{ childRow.agent.task ?? childRow.agent.name }}</span></span></button>
          <span v-for="tool in activitiesByAgent[childRow.agent.agent_id] ?? []" :key="tool.cursor" class="child-tool-tick" :class="{ err: tool.ok === 0 }" :style="{ left: childMark(tool) ?? '-10px' }" />
        </div>
      </div>
    </div>
    <div v-else-if="loaded" class="empty-state">no phases recorded for this session</div>
    <div v-else-if="!apiError" class="empty-state">loading trace…</div>

    <AgentDetailPanel
      v-if="(selectedPhase || selectedAgent) && !selectedChildHidden"
      :agent="selectedAgent"
      :phase="selectedPhase"
      :detail="agentDetail"
      :activities="selectedAgent ? (activitiesByAgent[selectedAgent.agent_id] ?? []) : []"
      :events="events"
      :envelopes="envelopes"
      :gates="gates"
      :now-ms="nowMs"
      @close="navigate(props.adwId)"
    />
  </div>
</template>

<style scoped>
.trace {
  padding: 0 0 40px;
}

.run-strip {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--border-soft);
  flex-wrap: wrap;
}

.run-strip .request {
  font-size: 17px;
  color: var(--text);
  max-width: 52ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-stats {
  display: inline-flex;
  gap: 12px;
  flex-wrap: wrap;
}

.waterfall {
  margin: 20px 28px;
  border: 1px solid var(--border-soft);
  border-radius: 16px;
  background: var(--surface);
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: 280px 1fr;
}

.axis-row {
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}

.axis-row .track {
  height: 40px;
  overflow: hidden;
}

.zone-head {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: var(--amber);
  border-right: 1px solid var(--border);
}

.axis-label {
  position: absolute;
  bottom: 7px;
  transform: translateX(-50%);
  font-family: var(--mono);
  font-size: 16px;
  color: var(--dim);
  white-space: nowrap;
}

.label {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  border-right: 1px solid var(--border);
  overflow: hidden;
  white-space: nowrap;
}

.lane-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 17px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lane-icon {
  flex: none;
  opacity: 0.85;
}

.lane-meta {
  font-family: var(--mono);
  font-size: 16px;
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
}

.lane-model {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.model-icon {
  width: 17px;
  height: 17px;
  flex: none;
  object-fit: contain;
}

/* Context occupancy — label row over a thin track, under the model. */
.lane-ctx {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
  max-width: 190px;
}

.ctx-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.ctx-label {
  font-size: 14px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--faint);
}

.ctx-pct {
  font-family: var(--mono);
  font-size: 14px;
  color: var(--dim);
}

.ctx-bar {
  height: 6px;
  border-radius: 999px;
  background: rgba(6, 8, 15, 0.75);
  border: 1px solid var(--border-soft);
  overflow: hidden;
}

.ctx-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 300ms ease;
}

.subagent-toggle {
  align-self: flex-start;
  margin-top: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--blue);
  font-family: var(--mono);
  font-size: 14px;
  cursor: pointer;
}

.subagent-toggle:hover {
  color: var(--text);
}

.subagent-toggle:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 3px;
}

.lane {
  border-bottom: 1px solid var(--border-soft);
}

.lane:last-child {
  border-bottom: none;
}

.track {
  position: relative;
  height: 118px;
  overflow: hidden;
}

.zone-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--border);
}

.gridline {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px dashed rgba(174, 191, 212, 0.14);
}

.block {
  position: absolute;
  top: 13px;
  height: 92px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 4px;
  padding: 10px 12px 16px;
  border-radius: 10px;
  border: 1px solid;
  font-size: 16px;
  color: var(--text);
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  text-align: left;
  transition: box-shadow 0.16s ease;
}

.block:hover {
  box-shadow: 0 0 18px var(--lane-glow, rgba(108, 182, 255, 0.2));
}

.b-top {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.b-status {
  flex: none;
  font-size: 16px;
}

.b-status.success {
  color: var(--green);
}

.b-status.fail {
  color: var(--red);
}

.b-status.running {
  color: var(--blue);
  animation: pulse 1.2s ease-in-out infinite;
}

.b-status.queued {
  color: var(--faint);
}

.block .b-name {
  font-size: 17px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nested-badge {
  flex: none;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
}

.nested-badge.live {
  color: var(--blue);
  border-color: var(--blue);
  animation: pulse 1.2s ease-in-out infinite;
}

.block .b-dur {
  margin-left: auto;
  flex: none;
}

.block .b-desc {
  color: var(--dim);
  font-size: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.block.running {
  animation: pulse 1.6s ease-in-out infinite;
}

.block.queued {
  background: transparent;
  border-style: dashed;
  border-color: var(--faint);
  color: var(--dim);
}

.block.selected {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
  box-shadow: 0 0 22px var(--lane-glow, rgba(108, 182, 255, 0.25));
}

.tool-tick {
  position: absolute;
  bottom: 4px;
  width: 3px;
  height: 9px;
  background: currentColor;
  opacity: 0.55;
  border-radius: 1px;
}

.tool-tick.err {
  background: var(--red);
  opacity: 1;
}

.child-row { background: rgba(8, 12, 20, 0.35); }
.child-label { position: relative; padding-left: 42px; }
.child-label .lane-name { font-family: var(--mono); font-size: 14px; color: var(--text); overflow-wrap: anywhere; white-space: normal; }
.branch { position: absolute; left: 18px; top: 16px; color: var(--faint); font-size: 20px; }
.child-track { height: 86px; }
.child-block { top: 10px; height: 66px; padding: 8px 10px 13px; background: linear-gradient(180deg, rgba(108, 182, 255, .16), rgba(108, 182, 255, .04)); border-color: rgba(108, 182, 255, .5); --lane-glow: rgba(108, 182, 255, .25); }
.child-block.error,.child-block.cancelled,.child-block.killed,.child-block.interrupted { border-color: rgba(255, 111, 103, .8); }
.child-tool-tick { position: absolute; bottom: 4px; width: 3px; height: 10px; border-radius: 2px; background: var(--green); z-index: 2; }
.child-tool-tick.err { background: var(--red); }
</style>
