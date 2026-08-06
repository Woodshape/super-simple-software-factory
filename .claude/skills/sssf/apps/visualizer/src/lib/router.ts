import { ref } from 'vue'

// Hash routes: #/ → sessions · #/<adw_id> → waterfall · #/<adw_id>/<agent_id> → unified detail panel
export interface Route {
  adwId: string | null
  agentId: string | null
}

function parse(): Route {
  const parts = window.location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent)
  return { adwId: parts[0] ?? null, agentId: parts[1] ?? null }
}

const route = ref<Route>(parse())

window.addEventListener('hashchange', () => {
  route.value = parse()
})

export function useRoute() {
  return route
}

// Display name for the selected agent/phase crumb, resolved after the trace loads.
export const agentCrumb = ref<string | null>(null)

export function hrefFor(adwId?: string | null, agentId?: string | null): string {
  let h = '#/'
  if (adwId) h += encodeURIComponent(adwId)
  if (adwId && agentId) h += `/${encodeURIComponent(agentId)}`
  return h
}

export function navigate(adwId?: string | null, agentId?: string | null): void {
  window.location.hash = hrefFor(adwId, agentId)
}
