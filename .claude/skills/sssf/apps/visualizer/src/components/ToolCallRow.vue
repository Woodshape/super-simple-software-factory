<script setup lang="ts">
import { computed, ref } from 'vue'
import { fmtClock } from '../lib/format'
import { highlightJson } from '../lib/highlight'
import StatChip from './StatChip.vue'

const props = withDefaults(defineProps<{
  time: string | null
  tool: string | null
  ok: boolean | number | null
  durationMs: number | null
  argsJson: string | null
  result: string | null
  turn?: number | null
  tokens?: number | null
  legacyPayload?: string | null
}>(), {
  turn: null,
  tokens: null,
  legacyPayload: null,
})

const open = ref(false)
const failed = computed(() => props.ok === false || props.ok === 0)
const argsHtml = computed(() => highlightJson(props.argsJson ?? '{}'))
</script>

<template>
  <div class="event tool-call">
    <button class="event-row" :class="{ open }" @click="open = !open">
      <span class="e-time dim">{{ fmtClock(time) }}</span>
      <span class="e-type t-cyan">tool_call</span>
      <span class="e-name" :class="{ 't-red': failed }" :title="tool ?? 'tool'">{{ tool ?? 'tool' }}</span>
      <span v-if="turn != null" class="turn dim">turn {{ turn }}</span>
      <span class="e-extra">
        <StatChip v-if="durationMs != null && Number.isFinite(durationMs)" kind="runtime" compact :value="durationMs" />
        <StatChip v-if="tokens" kind="tokens" compact :value="tokens" />
      </span>
    </button>

    <div v-if="open" class="payload-panel">
      <template v-if="!legacyPayload">
        <div class="p-meta">
          <span class="p-tool">{{ tool ?? 'tool' }}</span>
          <span v-if="failed" class="t-red">failed</span>
          <StatChip v-if="durationMs != null" kind="runtime" compact :value="durationMs" />
          <span v-if="turn != null" class="dim">turn {{ turn }}</span>
        </div>
        <h4>args</h4>
        <!-- Safe: highlightJson escapes all input before emitting its own spans. -->
        <pre class="p-pre" v-html="argsHtml" />
        <template v-if="result">
          <h4>result</h4>
          <pre class="p-pre">{{ result }}</pre>
        </template>
        <div v-else class="faint">no result recorded</div>
      </template>
      <template v-else>
        <div class="faint">no detail available — legacy event payload</div>
        <pre class="p-pre" v-html="highlightJson(legacyPayload)" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.event { border-bottom: 1px solid var(--border-soft); }
.event-row { display:flex; gap:14px; align-items:baseline; width:100%; padding:7px 6px; background:none; border:none; border-radius:6px; color:var(--text); font-family:var(--mono); font-size:16px; cursor:pointer; text-align:left; }
.event-row:hover,.event-row.open { background:var(--panel-2); }
.e-time { flex:none; font-variant-numeric:tabular-nums; }
.e-type { flex:none; width:130px; }
.e-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.turn { flex:none; }
.e-extra { margin-left:auto; flex:none; display:inline-flex; gap:14px; }
.payload-panel { margin:6px 0 14px; padding:14px 16px; border:1px solid var(--border); border-radius:10px; background:var(--panel-3); }
.p-meta { display:flex; gap:16px; align-items:baseline; margin-bottom:10px; }
.p-tool { color:var(--cyan); font-weight:700; font-size:17px; }
.payload-panel h4 { margin:14px 0 6px; font-size:16px; font-weight:700; color:var(--dim); text-transform:lowercase; letter-spacing:.06em; }
.payload-panel h4:first-of-type { margin-top:0; }
.p-pre { border:1px solid var(--border-soft); border-radius:8px; padding:10px 12px; background:rgba(6,8,15,.55); max-height:42vh; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
.t-red { color:var(--red); }
.t-cyan { color:var(--cyan); }
</style>
