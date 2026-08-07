<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { AgentMessage } from '../lib/types'
import { fetchAgentMessages } from '../lib/api'
import {
  emptyAgentMessageState,
  mergeAgentMessagePage,
  type AgentMessageState,
} from '../lib/messages'
import { fmtDate } from '../lib/format'

const props = defineProps<{
  adwId: string
  agentId: string
  running: boolean
}>()

const agentKey = computed(() => `${props.adwId}:${props.agentId}`)
const flow = ref<AgentMessageState>(emptyAgentMessageState(agentKey.value))
const state = ref<'loading' | 'ready' | 'error'>('loading')
const error = ref('')

const PAGE_LIMIT = 200
const POLL_MS = 750
const RETRY_MS = 1500
let generation = 0
const inFlight = new Set<number>()
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let pendingFinalDrain = false

function schedule(delay: number, token: number) {
  clearTimeout(timer)
  if (!disposed && token === generation && props.running) {
    timer = setTimeout(() => void load(token, false), delay)
  }
}

async function load(token: number, finalDrain: boolean) {
  if (disposed || token !== generation || inFlight.has(token)) return
  inFlight.add(token)
  try {
    let hasMore: boolean
    do {
      const after = flow.value.cursor
      // Cursor pages are dependent: only an accepted contiguous cursor starts the next request.
      // eslint-disable-next-line no-await-in-loop
      const page = await fetchAgentMessages(props.adwId, props.agentId, after, PAGE_LIMIT)
      if (disposed || token !== generation) return
      flow.value = mergeAgentMessagePage(flow.value, agentKey.value, page)
      hasMore = flow.value.available === true && flow.value.hasMore && flow.value.cursor > after
    } while (hasMore)
    state.value = 'ready'
    error.value = ''
    if (!finalDrain) schedule(POLL_MS, token)
  } catch (cause) {
    if (disposed || token !== generation) return
    state.value = 'error'
    error.value = cause instanceof Error ? cause.message : String(cause)
    if (!finalDrain) schedule(RETRY_MS, token)
  } finally {
    inFlight.delete(token)
    if (!disposed && token === generation && pendingFinalDrain) {
      pendingFinalDrain = false
      void load(token, true)
    }
  }
}

watch(
  agentKey,
  (key) => {
    clearTimeout(timer)
    generation += 1
    pendingFinalDrain = false
    flow.value = emptyAgentMessageState(key)
    state.value = 'loading'
    error.value = ''
    void load(generation, false)
  },
  { immediate: true },
)

watch(
  () => props.running,
  (running, wasRunning) => {
    clearTimeout(timer)
    if (running) {
      if (state.value !== 'loading') schedule(0, generation)
    } else if (wasRunning) {
      if (inFlight.has(generation)) pendingFinalDrain = true
      else void load(generation, true)
    }
  },
)

onUnmounted(() => {
  disposed = true
  generation += 1
  pendingFinalDrain = false
  clearTimeout(timer)
})

const labels: Record<AgentMessage['role'], string> = {
  user: 'User',
  thinking: 'Thinking',
  assistant: 'Assistant',
  tool_call: 'Tool Call',
  tool_result: 'Tool Result',
}
</script>

<template>
  <div class="message-flow" aria-live="polite">
    <p v-if="state === 'loading' && !flow.messages.length" class="flow-state">loading entries…</p>
    <p v-else-if="state === 'error' && !flow.messages.length" class="flow-state error">
      entries could not be loaded<span v-if="error">: {{ error }}</span>
    </p>
    <p v-else-if="flow.available === false && running" class="flow-state">
      The Pi stream is not available yet. Waiting for the agent to start writing it…
    </p>
    <p v-else-if="flow.available === false" class="flow-state">
      No Pi message stream is available for this legacy agent. The Actions view remains available.
    </p>
    <p v-else-if="state === 'ready' && !flow.messages.length" class="flow-state">
      No entries have been recorded yet.
    </p>

    <ol v-if="flow.messages.length" class="entries" aria-label="Agent message entries">
      <li v-for="message in flow.messages" :key="message.cursor" class="entry" :class="message.role">
        <header>
          <strong>{{ labels[message.role] }}</strong>
          <span v-if="message.turn !== undefined">turn {{ message.turn }}</span>
          <time v-if="message.timestamp" :datetime="message.timestamp">{{ fmtDate(message.timestamp) }}</time>
        </header>

        <div
          v-if="message.role === 'user' || message.role === 'thinking' || message.role === 'assistant'"
          class="entry-content"
        >{{ message.text }}</div>

        <template v-else-if="message.role === 'tool_call'">
          <div class="tool-meta"><b>{{ message.tool }}</b><code>{{ message.tool_call_id }}</code></div>
          <pre class="entry-content">{{ message.arguments_json }}</pre>
        </template>

        <template v-else-if="message.role === 'tool_result'">
          <div class="tool-meta">
            <b>{{ message.tool }}</b>
            <code>{{ message.tool_call_id }}</code>
            <span class="result-status" :class="message.is_error ? 'failed' : 'succeeded'">
              {{ message.is_error ? 'Error' : 'Success' }}
            </span>
          </div>
          <pre class="entry-content">{{ message.result }}</pre>
        </template>
      </li>
    </ol>

    <p v-if="state === 'error' && flow.messages.length" class="flow-state error">
      New entries could not be loaded<span v-if="error">: {{ error }}</span>
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
.entry.tool_call { border-left-color: var(--amber); background: rgba(211, 172, 74, .07); }
.entry.tool_result { border-left-color: var(--blue); background: rgba(83, 145, 214, .07); }
.entry.tool_result:has(.failed) { border-left-color: var(--red); }
.entry header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 9px; color: var(--dim); flex-wrap: wrap; }
.entry header strong { color: var(--text); }
.entry header time { margin-left: auto; color: var(--faint); }
.entry-content { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); line-height: 1.55; font-family: inherit; }
.tool-meta { display: flex; align-items: baseline; gap: 10px; margin-bottom: 9px; flex-wrap: wrap; }
.tool-meta code { color: var(--dim); overflow-wrap: anywhere; }
.result-status { margin-left: auto; padding: 1px 8px; border: 1px solid currentColor; border-radius: 999px; font-size: 12px; font-weight: 700; }
.result-status.succeeded { color: var(--green); }
.result-status.failed { color: var(--red); }
.flow-state { margin: 0; padding: 18px; border: 1px dashed var(--border-soft); border-radius: 10px; color: var(--dim); }
.flow-state.error { color: var(--red); }
@media (max-width: 640px) {
  .message-flow { padding: 14px 10px 18px; }
  .entry { padding: 12px; }
  .entry header time { width: 100%; margin-left: 0; }
  .result-status { margin-left: 0; }
}
</style>
