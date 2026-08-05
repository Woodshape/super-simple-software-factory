<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { SessionSummary } from '../lib/types'
import { archiveSession, fetchSessions } from '../lib/api'
import { ts } from '../lib/format'
import SessionCard from './SessionCard.vue'

type ListMode = 'active' | 'archived'

const activeSessions = shallowRef<SessionSummary[]>([])
const archivedSessions = shallowRef<SessionSummary[]>([])
const mode = ref<ListMode>('active')
const apiError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())

const POLL_MS = 2000
let timer: ReturnType<typeof setInterval> | undefined
let inflight = false
let refreshPending = false

async function tick() {
  if (inflight) {
    refreshPending = true
    return
  }
  inflight = true
  try {
    const [active, archived] = await Promise.all([fetchSessions(false), fetchSessions(true)])
    activeSessions.value = active
    archivedSessions.value = archived
    nowMs.value = Date.now()
    apiError.value = null
    loaded.value = true
  } catch (err) {
    apiError.value = err instanceof Error ? err.message : String(err)
  } finally {
    inflight = false
    if (refreshPending) {
      refreshPending = false
      void tick()
    }
  }
}

onMounted(() => {
  void tick()
  timer = setInterval(() => void tick(), POLL_MS)
})

onUnmounted(() => clearInterval(timer))

async function changeArchived(adwId: string) {
  const restoring = mode.value === 'archived'
  const activeBefore = activeSessions.value
  const archivedBefore = archivedSessions.value
  const source = restoring ? archivedBefore : activeBefore
  const session = source.find((item) => item.adw_id === adwId)
  if (!session) return

  actionError.value = null
  const moved = { ...session, archived: restoring ? 0 : 1 }
  if (restoring) {
    archivedSessions.value = archivedBefore.filter((item) => item.adw_id !== adwId)
    activeSessions.value = [moved, ...activeBefore]
  } else {
    activeSessions.value = activeBefore.filter((item) => item.adw_id !== adwId)
    archivedSessions.value = [moved, ...archivedBefore]
  }

  try {
    await archiveSession(adwId, !restoring)
    await tick()
  } catch (err) {
    activeSessions.value = activeBefore
    archivedSessions.value = archivedBefore
    actionError.value = `${restoring ? 'restore' : 'archive'} failed — ${err instanceof Error ? err.message : String(err)}`
    await tick()
  }
}

const selected = computed(() =>
  mode.value === 'active' ? activeSessions.value : archivedSessions.value,
)

const ordered = computed(() =>
  selected.value.toSorted((a, b) => (ts(b.started_at) || 0) - (ts(a.started_at) || 0)),
)
</script>

<template>
  <div class="sessions">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>
    <div v-if="actionError" class="error-bar">{{ actionError }}</div>

    <div class="list-toolbar" aria-label="Session collections">
      <div class="list-tabs" role="tablist">
        <button
          class="list-tab"
          :class="{ selected: mode === 'active' }"
          type="button"
          role="tab"
          :aria-selected="mode === 'active'"
          @click="mode = 'active'"
        >
          Active <span class="tab-count">{{ activeSessions.length }}</span>
        </button>
        <button
          class="list-tab"
          :class="{ selected: mode === 'archived' }"
          type="button"
          role="tab"
          :aria-selected="mode === 'archived'"
          @click="mode = 'archived'"
        >
          Archived <span class="tab-count">{{ archivedSessions.length }}</span>
        </button>
      </div>
      <span v-if="loaded" class="dim">{{ ordered.length }} {{ mode }} runs</span>
    </div>

    <div v-if="ordered.length" class="cards">
      <SessionCard
        v-for="session in ordered"
        :key="session.adw_id"
        :session="session"
        :now-ms="nowMs"
        :archived="mode === 'archived'"
        @change-archived="changeArchived"
      />
    </div>
    <div v-else-if="loaded" class="empty-state">
      {{ mode === 'archived' ? 'no archived sessions' : 'no active sessions yet — run an ADW to see it here' }}
    </div>
    <div v-else-if="!apiError" class="empty-state">loading sessions…</div>
  </div>
</template>

<style scoped>
.sessions {
  display: flex;
  flex-direction: column;
}

.list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 24px 0;
}

.list-tabs {
  display: inline-flex;
  gap: 8px;
}

.list-tab {
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-2);
  color: var(--dim);
  font: inherit;
  cursor: pointer;
}

.list-tab.selected {
  border-color: var(--violet);
  color: var(--text);
  box-shadow: 0 0 14px rgba(148, 163, 255, 0.14);
}

.tab-count {
  margin-left: 6px;
  font-family: var(--mono);
  color: var(--cyan);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(460px, 1fr));
  gap: 18px;
  padding: 16px 24px 28px;
}
</style>
