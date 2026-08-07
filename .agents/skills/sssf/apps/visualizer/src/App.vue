<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { fetchHealth } from './lib/api'
import { useRoute, hrefFor, agentCrumb } from './lib/router'
import SessionsList from './components/SessionsList.vue'
import SessionTrace from './components/SessionTrace.vue'

const route = useRoute()
const workspaceName = ref('loading…')

onMounted(() => {
  void fetchHealth().then(
    (health) => {
      workspaceName.value = health.workspace.trim() || 'unavailable'
    },
    () => {
      workspaceName.value = 'unavailable'
    },
  )
})
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="topbar-main">
        <div class="brand-lockup">
          <!-- Inline copy of public/logo.svg (the favicon) so the mark renders
               crisply with no fetch; keep the two in sync. -->
          <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="4" y="6" width="17" height="5" rx="2.5" fill="#e8b64a" />
            <rect x="8" y="13.5" width="20" height="5" rx="2.5" fill="#c89bff" />
            <rect x="4" y="21" width="13" height="5" rx="2.5" fill="#5ad2dd" />
          </svg>
          <span class="brand">Super Simple Software Factory</span>
        </div>
        <div class="workspace-identity" aria-label="Target workspace" aria-live="polite">
          <span class="workspace-label">workspace</span>
          <strong class="workspace-name">{{ workspaceName }}</strong>
        </div>
        <nav class="crumbs" aria-label="Session breadcrumbs">
          <span class="sep">›</span>
          <a :href="hrefFor()" :class="{ current: !route.adwId }">sessions</a>
          <template v-if="route.adwId">
            <span class="sep">›</span>
            <a :href="hrefFor(route.adwId)" :class="{ current: !route.agentId }">{{
              route.adwId
            }}</a>
          </template>
          <template v-if="route.adwId && route.agentId">
            <span class="sep">›</span>
            <span class="current">{{ agentCrumb ?? route.agentId }}</span>
          </template>
        </nav>
      </div>
      <span class="live-hint"><span class="live-dot" /> live</span>
    </header>
    <main>
      <SessionsList v-if="!route.adwId" />
      <SessionTrace v-else :key="route.adwId" :adw-id="route.adwId" :agent-id="route.agentId" />
    </main>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 28px;
  background: rgba(11, 15, 24, 0.72);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  position: sticky;
  top: 0;
  z-index: 10;
}

/* Gradient hairline instead of a hard border — the brand colors, whispered. */
.topbar::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: linear-gradient(
    90deg,
    rgba(200, 155, 255, 0.45),
    rgba(90, 210, 221, 0.35) 40%,
    rgba(90, 210, 221, 0.06)
  );
}

.topbar-main {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.brand-lockup {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  min-width: 0;
}

.logo {
  width: 28px;
  height: 28px;
  flex: none;
  filter: drop-shadow(0 0 8px rgba(200, 155, 255, 0.35));
}

.brand {
  background: linear-gradient(90deg, var(--purple), var(--cyan));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  font-weight: 700;
  letter-spacing: 0.05em;
  white-space: nowrap;
}

.workspace-identity {
  display: grid;
  width: clamp(150px, 20vw, 260px);
  min-width: 0;
  flex: none;
  padding: 5px 11px 6px;
  border: 1px solid rgba(90, 210, 221, 0.38);
  border-radius: 8px;
  background: linear-gradient(135deg, rgba(90, 210, 221, 0.13), rgba(200, 155, 255, 0.09));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  line-height: 1.1;
}

.workspace-label {
  color: var(--faint);
  font-size: 16px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.workspace-name {
  overflow: hidden;
  color: var(--cyan);
  font-family: var(--mono);
  font-size: 19px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 17px;
  white-space: nowrap;
}

.sep {
  flex: none;
  color: var(--faint);
}

.crumbs a {
  min-width: 0;
  max-width: 240px;
  overflow: hidden;
  color: var(--dim);
  text-overflow: ellipsis;
}

.crumbs a:hover {
  color: var(--text);
}

.crumbs .current {
  min-width: 0;
  max-width: 320px;
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
}

.live-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--dim);
  font-size: 16px;
  white-space: nowrap;
}

.live-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 10px rgba(74, 222, 128, 0.7);
  animation: pulse 1.6s ease-in-out infinite;
}

@media (max-width: 1000px) {
  .brand {
    display: none;
  }
}

@media (max-width: 620px) {
  .topbar {
    gap: 10px;
    padding-inline: 14px;
  }

  .topbar-main {
    gap: 10px;
  }

  .workspace-identity {
    width: clamp(140px, 48vw, 210px);
  }

  .crumbs {
    display: none;
  }
}
</style>
