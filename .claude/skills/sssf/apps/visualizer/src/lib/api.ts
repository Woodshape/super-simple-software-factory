import type {
  Envelope,
  EventRow,
  EventsPage,
  GateResult,
  HealthResponse,
  PromptsResponse,
  SessionDetail,
  SessionSummary,
  SubagentActivitiesPage,
  SubagentDetail,
  SubagentSummary,
} from './types'
import { normalizeSubagentDetail, normalizeSubagents } from './subagents'

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return res.json()
}

export async function fetchSessions(archived = false): Promise<SessionSummary[]> {
  const data = await getJson(`/api/sessions?archived=${archived ? 1 : 0}`)
  if (!Array.isArray(data)) return []
  return data.map((value) => {
    const row = value as Partial<SessionSummary>
    const timeline = Array.isArray(row.timeline) ? row.timeline : []
    const markerCount =
      typeof row.timeline_marker_count === 'number' ? row.timeline_marker_count : timeline.length
    return Object.assign(row, {
      phases: Array.isArray(row.phases) ? row.phases : [],
      phase_count: typeof row.phase_count === 'number' ? row.phase_count : 0,
      agents: Array.isArray(row.agents) ? row.agents : [],
      timeline,
      timeline_marker_count: markerCount,
      timeline_truncated:
        typeof row.timeline_truncated === 'boolean'
          ? row.timeline_truncated
          : markerCount > timeline.length,
    }) as SessionSummary
  })
}

export async function fetchSession(adwId: string): Promise<SessionDetail> {
  const detail = (await getJson(`/api/sessions/${encodeURIComponent(adwId)}`)) as SessionDetail
  return {
    session: detail.session,
    usage: detail.usage ?? { read: 0, written: 0 },
    phases: detail.phases ?? [],
    agents: detail.agents ?? [],
  }
}

export async function fetchEvents(adwId: string, after: number, limit = 500): Promise<EventsPage> {
  const page = (await getJson(
    `/api/sessions/${encodeURIComponent(adwId)}/events?after=${after}&limit=${limit}`,
  )) as EventsPage | EventRow[]
  if (Array.isArray(page)) {
    const cursor = page.reduce((max, e) => Math.max(max, e.rowid), after)
    return { events: page, cursor, has_more: page.length === limit }
  }
  return { events: page.events ?? [], cursor: page.cursor ?? after, has_more: page.has_more ?? false }
}

/** Archive a run out of the review list (or restore it with archived=false). */
export async function archiveSession(adwId: string, archived = true): Promise<void> {
  const url = `/api/sessions/${encodeURIComponent(adwId)}/archive`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived }),
  })
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`)
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson('/api/health') as Promise<HealthResponse>
}

// PhaseDetail imports the prompts type from here alongside fetchPrompts.
export type { PromptsResponse }

export async function fetchPrompts(adwId: string, agent: string): Promise<PromptsResponse> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(adwId)}/agents/${encodeURIComponent(agent)}/prompts`,
  )
  // Not recorded (or endpoint not deployed yet) renders as "no prompts", not an error.
  if (res.status === 404) return { system: null, user: null }
  if (!res.ok) throw new Error(`GET prompts → ${res.status}`)
  const data = (await res.json()) as Partial<PromptsResponse>
  return { system: data.system ?? null, user: data.user ?? null }
}

export function fetchEnvelopes(adwId: string): Promise<Envelope[]> {
  return getJson(`/api/sessions/${encodeURIComponent(adwId)}/envelopes`) as Promise<Envelope[]>
}

export function fetchGates(adwId: string): Promise<GateResult[]> {
  return getJson(`/api/sessions/${encodeURIComponent(adwId)}/gates`) as Promise<GateResult[]>
}

export async function fetchSubagents(adwId: string): Promise<SubagentSummary[]> {
  const data = await getJson(`/api/sessions/${encodeURIComponent(adwId)}/subagents`)
  return normalizeSubagents(data)
}

export async function fetchSubagent(adwId: string, childId: string): Promise<SubagentDetail> {
  const data = await getJson(
    `/api/sessions/${encodeURIComponent(adwId)}/subagents/${encodeURIComponent(childId)}`,
  )
  return normalizeSubagentDetail(data)
}

export async function fetchSubagentActivity(
  adwId: string,
  childId: string,
  after: number,
  limit = 200,
): Promise<SubagentActivitiesPage> {
  const data = (await getJson(
    `/api/sessions/${encodeURIComponent(adwId)}/subagents/${encodeURIComponent(childId)}/activity?after=${after}&limit=${limit}`,
  )) as SubagentActivitiesPage
  return {
    activities: Array.isArray(data.activities) ? data.activities : [],
    cursor: typeof data.cursor === 'number' ? data.cursor : after,
    has_more: data.has_more === true,
  }
}
