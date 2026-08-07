<script setup lang="ts">
import { computed } from 'vue'
import type { SessionSummary } from '../lib/types'
import { axisTicks, fmtDate, fmtOffset, ts } from '../lib/format'
import { agentColor, dotColor } from '../lib/events'
import { hrefFor } from '../lib/router'
import StatusChip from './StatusChip.vue'
import StatChip from './StatChip.vue'
import PhaseDots from './PhaseDots.vue'

type PendingAction = 'archive' | 'restore' | 'delete'

const props = defineProps<{
  session: SessionSummary
  nowMs: number
  archived: boolean
  pendingAction?: PendingAction | null
}>()
const emit = defineEmits<{
  changeArchived: [adwId: string]
  deleteSession: [adwId: string]
}>()

// The card is an <a>; keep visible review actions from navigating.
function changeArchived(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  emit('changeArchived', props.session.adw_id)
}

function deleteSession(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  emit('deleteSession', props.session.adw_id)
}

const running = computed(() => props.session.status === 'running')

const range = computed(() => {
  const s = props.session
  let t0 = ts(s.started_at)
  if (!Number.isFinite(t0)) {
    t0 = Math.min(...props.session.timeline.map((e) => ts(e.started_at)).filter(Number.isFinite))
  }
  if (!Number.isFinite(t0)) t0 = props.nowMs
  let t1 = running.value ? props.nowMs : ts(s.ended_at)
  if (!Number.isFinite(t1)) {
    t1 = Math.max(...props.session.timeline.map((e) => ts(e.started_at)).filter(Number.isFinite))
  }
  if (!Number.isFinite(t1)) t1 = t0 + 1000
  return { t0, span: Math.max(t1 - t0, 1000) }
})

const ticks = computed(() => axisTicks(range.value.span, 5))

interface TimelineDot {
  id: string
  xPct: number
  color: string
  title: string
  latest: boolean
}

interface TimelineRow {
  owner: string
  color: string
  title: string
  dots: TimelineDot[]
}

// Per-agent rows: events attribute to an agent through their phase's owner.
const rows = computed<TimelineRow[]>(() => {
  const owners: string[] = []
  const ownerByPhase = new Map<string, string>()
  for (const p of props.session.phases ?? []) {
    if (p.kind !== 'agent' || !p.owner) continue
    ownerByPhase.set(p.phase_id, p.owner)
    if (!owners.includes(p.owner)) owners.push(p.owner)
  }
  if (!owners.length) return []

  const { t0, span } = range.value
  const byOwner = new Map<string, TimelineDot[]>(owners.map((o) => [o, []]))
  let latest: TimelineDot | null = null
  let latestT = -Infinity

  for (const e of props.session.timeline) {
    const owner = e.phase_id ? ownerByPhase.get(e.phase_id) : undefined
    const color = dotColor(e.type)
    if (!owner || !color) continue
    const t = ts(e.started_at)
    if (!Number.isFinite(t)) continue
    const dot: TimelineDot = {
      id: e.event_id,
      xPct: Math.min(Math.max(((t - t0) / span) * 100, 0), 100),
      color,
      title: `${e.type} ${e.name ?? e.type ?? ''} at ${fmtOffset(t - t0)}`,
      latest: false,
    }
    byOwner.get(owner)?.push(dot)
    if (t >= latestT) {
      latestT = t
      latest = dot
    }
  }
  if (running.value && latest) latest.latest = true

  // /api/sessions embeds agents so the labels can use config colors with no
  // extra request; historical sessions return color null → fallback palette.
  return owners.map((owner, i) => {
    const info = (props.session.agents ?? []).find((a) => a.agent === owner)
    return {
      owner,
      color: agentColor(info?.color, null, i),
      title: info?.model ? `${owner} ${info.model}` : owner,
      dots: byOwner.get(owner) ?? [],
    }
  })
})

const durationMs = computed(() => {
  const s = props.session
  const start = ts(s.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = running.value ? props.nowMs : ts(s.ended_at)
  return (Number.isFinite(end) ? end : props.nowMs) - start
})

// Cards are a fixed size, so the timeline region fits exactly MAX_VISIBLE_ROWS
// row slots. A roster that overflows spends one slot on the "+N more" line and
// shows MIN_VISIBLE_ROWS agents in the rest — never fewer than three, so a
// five-agent chain still reads as a chain rather than as a pair and a count.
const MAX_VISIBLE_ROWS = 4
const MIN_VISIBLE_ROWS = 3

const overflowing = computed(() => rows.value.length > MAX_VISIBLE_ROWS)

const visibleRows = computed(() =>
  overflowing.value ? rows.value.slice(0, MIN_VISIBLE_ROWS) : rows.value,
)

const hiddenRowCount = computed(() =>
  overflowing.value ? rows.value.length - MIN_VISIBLE_ROWS : 0,
)
</script>

<template>
  <a class="card" :class="session.status" :href="hrefFor(session.adw_id)">
    <div class="card-actions">
      <button
        class="card-action"
        type="button"
        :disabled="Boolean(pendingAction)"
        :aria-busy="pendingAction === (archived ? 'restore' : 'archive')"
        :title="archived ? 'Restore this run to the active list' : 'Archive this run from the active list'"
        :aria-label="archived ? 'Restore run' : 'Archive run'"
        @click="changeArchived"
      >
        {{ pendingAction === (archived ? 'restore' : 'archive') ? (archived ? 'Restoring…' : 'Archiving…') : archived ? 'Restore' : 'Archive' }}
      </button>
      <button
        v-if="archived"
        class="card-action card-delete"
        type="button"
        :disabled="Boolean(pendingAction)"
        :aria-busy="pendingAction === 'delete'"
        title="Permanently delete this archived run and its files"
        aria-label="Permanently delete run"
        @click="deleteSession"
      >
        {{ pendingAction === 'delete' ? 'Deleting…' : 'Delete' }}
      </button>
    </div>
    <span class="card-id">{{ session.adw_id }}</span>
    <span class="card-adw" :title="session.adw_name ?? ''">{{ session.adw_name ?? '—' }}</span>
    <span class="card-req" :title="session.request ?? ''">{{ session.request }}</span>

    <div
      v-if="rows.length"
      class="tl"
      :title="
        session.timeline_truncated
          ? `Timeline sampled: showing ${session.timeline.length} of ${session.timeline_marker_count} activity markers`
          : `${session.timeline_marker_count} activity markers`
      "
      :aria-label="
        session.timeline_truncated
          ? `Sampled timeline showing ${session.timeline.length} of ${session.timeline_marker_count} activity markers`
          : undefined
      "
    >
      <div class="tl-axis">
        <span class="tl-gutter" />
        <span class="tl-scale">
          <span
            v-for="(t, i) in ticks"
            :key="i"
            class="tl-tick"
            :class="{ edge: t.pct === 0 }"
            :style="{ left: `${t.pct}%` }"
            >{{ t.label }}</span
          >
        </span>
      </div>
      <div v-for="row in visibleRows" :key="row.owner" class="tl-row">
        <span class="tl-agent" :style="{ color: row.color }" :title="row.title">{{
          row.owner
        }}</span>
        <span class="tl-track">
          <span
            v-for="dot in row.dots"
            :key="dot.id"
            class="tl-dot"
            :class="{ latest: dot.latest }"
            :style="{ left: `${dot.xPct}%`, background: dot.color }"
            :title="dot.title"
          />
        </span>
      </div>
      <div v-if="hiddenRowCount" class="tl-more dim">+{{ hiddenRowCount }} more agents</div>
    </div>
    <div v-else class="tl tl-empty faint">no agent activity yet</div>

    <div class="card-foot">
      <span class="foot-status">
        <StatusChip :status="session.status ?? 'fail'" />
        <PhaseDots :phases="session.phases ?? []" />
      </span>
      <span class="dim">{{ fmtDate(session.started_at) }}</span>
    </div>
    <div class="card-stats">
      <StatChip kind="cost" :value="session.total_cost" />
      <StatChip kind="runtime" :value="durationMs" />
      <StatChip kind="tokens" :value="session.total_tokens" />
    </div>
  </a>
</template>

<style scoped>
.card {
  /* Uniform size: the grid fixes the width, this fixes the height — content
     clamps and truncates rather than resizing the card. Grew by one 40px row
     slot when the timeline went from three to four. */
  height: 420px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px 22px;
  position: relative;          /* anchors the review action group */
  border: 1px solid var(--border-soft);
  border-radius: 16px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  overflow: hidden;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.18s ease;
}

.card-actions {
  position: absolute;
  top: 10px;
  right: 12px;
  display: flex;
  gap: 6px;
}

.card-action {
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--dim);
  font-family: inherit;
  font-size: 16px;
  line-height: 1.2;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.card-action:hover:not(:disabled) {
  color: var(--text);
}

.card-delete {
  border-color: rgba(255, 111, 103, 0.5);
  color: #ff6f67;
}

.card-delete:hover:not(:disabled) {
  background: rgba(255, 111, 103, 0.16);
  color: #ff6f67;
}

.card-action:disabled {
  cursor: wait;
  opacity: 0.65;
}

.card:hover {
  border-color: rgba(148, 163, 255, 0.45);
  box-shadow: 0 10px 34px rgba(148, 163, 255, 0.12);
  transform: translateY(-2px);
}

.card.running {
  border-color: rgba(108, 182, 255, 0.6);
  box-shadow: 0 0 22px rgba(108, 182, 255, 0.16);
}

.card.fail {
  border-color: rgba(255, 111, 103, 0.6);
}

/* Text rows must never absorb flex shrink — the fixed-height card squeezes
   overflow into .tl (which clips), not into the text. */
.card-id {
  flex: none;
  font-family: var(--mono);
  font-size: 18px;
  font-weight: 700;
  color: var(--purple);
}

.card-adw {
  flex: none;
  font-family: var(--mono);
  font-size: 16px;
  color: var(--cyan);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-req {
  flex: none;
  font-size: 16px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl {
  display: flex;
  flex-direction: column;
  margin-top: 4px;
  /* Fixed region: axis (28 + 6) + four 40px row slots, roster size or not.
     Four slots is what lets three agents show alongside a "+N more" line. */
  height: 194px;
  flex: none;
  overflow: hidden;
}

.tl-more {
  display: flex;
  align-items: center;
  height: 40px;
  padding-left: 96px;
  font-size: 16px;
}

.tl-axis {
  display: flex;
  align-items: flex-end;
  height: 28px;
  margin-bottom: 6px;
}

.tl-gutter,
.tl-agent {
  flex: none;
  /* Wide enough for full agent names (planner, builder, documenter). */
  width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-right: 8px;
}

.tl-scale {
  position: relative;
  flex: 1;
  height: 100%;
  border-bottom: 1px solid var(--border);
}

.tl-tick {
  position: absolute;
  bottom: 4px;
  transform: translateX(-50%);
  font-family: var(--mono);
  font-size: 16px;
  color: var(--faint);
  white-space: nowrap;
}

.tl-tick.edge {
  transform: none;
}

.tl-row {
  display: flex;
  align-items: center;
  height: 40px;
}

.tl-agent {
  font-size: 16px;
  color: var(--dim);
}

.tl-track {
  position: relative;
  flex: 1;
  height: 100%;
  border-bottom: 1px solid var(--border-soft);
}

.tl-dot {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

.tl-dot.latest {
  width: 13px;
  height: 13px;
  box-shadow: 0 0 10px currentColor;
  animation: pulse 1.4s ease-in-out infinite;
}

.tl-empty {
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: auto;
  font-size: 16px;
}

.foot-status {
  display: inline-flex;
  align-items: center;
  gap: 14px;
}

.card-stats {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
