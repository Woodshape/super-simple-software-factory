<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import type { AgentMessage } from '../lib/types'
import { fetchAgentMessages } from '../lib/api'
import { mergeAgentMessages } from '../lib/messages'
import { fmtDate } from '../lib/format'

const props = defineProps<{
  adwId: string
  agentId: string
  running: boolean
}>()

const messages = ref<AgentMessage[]>([])
const cursor = ref(0)
const available = ref<boolean | null>(null)
const state = ref<'loading' | 'ready' | 'error'>('loading')
const error = ref('')

const PAGE_LIMIT = 200
const POLL_MS = 750
const RETRY_MS = 1500
let generation = 0
const inFlight = new Set<number>()
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false

function schedule(delay: number, token: number) {
  clearTimeout(timer)
  if (!disposed && token === generation && props.running) {
    timer = setTimeout(() => void load(token), delay)
  }
}

async function load(token: number) {
  if (disposed || token !== generation || inFlight.has(token)) return
  inFlight.add(token)
  let hasMore = false
  try {
    do {
      const after = cursor.value
      // Cursor pages are dependent: the next request starts at this page's returned cursor.
      // eslint-disable-next-line no-await-in-loop
      const page = await fetchAgentMessages(props.adwId, props.agentId, after, PAGE_LIMIT)
      if (disposed || token !== generation) return
      messages.value = mergeAgentMessages(messages.value, page.messages)
      cursor.value = Math.max(cursor.value, page.cursor)
      available.value = page.available
      // A malformed page must not trap backlog loading on a non-advancing cursor.
      hasMore = page.available && page.has_more && cursor.value > after
    } while (hasMore)
    state.value = 'ready'
    error.value = ''
    schedule(POLL_MS, token)
  } catch (cause) {
    if (disposed || token !== generation) return
    state.value = 'error'
    error.value = cause instanceof Error ? cause.message : String(cause)
    schedule(RETRY_MS, token)
  } finally {
    inFlight.delete(token)
  }
}

watch(
  () => `${props.adwId}:${props.agentId}`,
  () => {
    clearTimeout(timer)
    generation += 1
    messages.value = []
    cursor.value = 0
    available.value = null
    state.value = 'loading'
    error.value = ''
    void load(generation)
  },
  { immediate: true },
)

watch(
  () => props.running,
  (running) => {
    clearTimeout(timer)
    if (running && state.value !== 'loading') schedule(0, generation)
  },
)

onUnmounted(() => {
  disposed = true
  generation += 1
  clearTimeout(timer)
})

const labels = { user: 'User', thinking: 'Thinking', assistant: 'Assistant' } as const
</script>

<template>
  <div class="message-flow" aria-live="polite">
    <p v-if="state === 'loading' && !messages.length" class="flow-state">loading messages…</p>
    <p v-else-if="state === 'error' && !messages.length" class="flow-state error">
      messages could not be loaded<span v-if="error">: {{ error }}</span>
    </p>
    <p v-else-if="available === false" class="flow-state">
      No Pi message file is available for this legacy agent. The Actions view remains available.
    </p>
    <p v-else-if="state === 'ready' && !messages.length" class="flow-state">
      No user, thinking, or assistant text has been recorded yet.
    </p>

    <ol v-if="messages.length" class="entries" aria-label="Agent messages">
      <li v-for="message in messages" :key="message.cursor" class="entry" :class="message.role">
        <header>
          <strong>{{ labels[message.role] }}</strong>
          <span v-if="message.turn !== undefined">turn {{ message.turn }}</span>
          <time v-if="message.timestamp" :datetime="message.timestamp">{{ fmtDate(message.timestamp) }}</time>
        </header>
        <div class="message-text">{{ message.text }}</div>
      </li>
    </ol>

    <p v-if="state === 'error' && messages.length" class="flow-state error">
      New messages could not be loaded<span v-if="error">: {{ error }}</span>
    </p>
  </div>
</template>

<style scoped>
.message-flow { padding: 20px 18px 24px; }
.entries { display: grid; gap: 14px; margin: 0; padding: 0; list-style: none; }
.entry { padding: 14px 16px; border: 1px solid var(--border-soft); border-left-width: 4px; border-radius: 10px; background: var(--panel-2); }
.entry.user { border-left-color: var(--cyan); }
.entry.thinking { border-left-color: var(--violet); background: rgba(126, 103, 193, .08); }
.entry.assistant { border-left-color: var(--green); }
.entry header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 9px; color: var(--dim); flex-wrap: wrap; }
.entry header strong { color: var(--text); }
.entry header time { margin-left: auto; color: var(--faint); }
.message-text { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); line-height: 1.55; }
.flow-state { margin: 0; padding: 18px; border: 1px dashed var(--border-soft); border-radius: 10px; color: var(--dim); }
.flow-state.error { color: var(--red); }
@media (max-width: 640px) {
  .message-flow { padding: 14px 10px 18px; }
  .entry { padding: 12px; }
  .entry header time { width: 100%; margin-left: 0; }
}
</style>
