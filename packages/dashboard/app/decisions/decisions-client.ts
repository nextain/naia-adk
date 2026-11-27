// Unified decisions API client (single backend source of truth:
// `GET /api/portal/decisions`, `POST /api/portal/decisions/:id/resolve`).
// AI-team `open` todos stay on `/work`; only human-review items live here.

export type DecisionKind = "approval" | "note" | "work" | "publish"
export type DecisionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "acknowledged"
  | "resolved"
  | "expired"
export type DecisionAction = "approve" | "reject" | "acknowledge"

export interface DecisionItem {
  id: string
  decisionId: string
  kind: DecisionKind
  status: DecisionStatus
  title: string
  detail: string | null
  source: string | null
  path: string | null
  url: string | null
  actor: string | null
  method: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface DecisionCounts {
  total: number
  approvals: number
  notes: number
  workWaits: number
  publish: number
}

export interface DecisionsSnapshot {
  pending: DecisionItem[]
  history: DecisionItem[]
  counts: DecisionCounts
}

export const EMPTY_COUNTS: DecisionCounts = { total: 0, approvals: 0, notes: 0, workWaits: 0, publish: 0 }

export async function fetchDecisions(
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; snapshot: DecisionsSnapshot } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetchFn("/api/portal/decisions", { cache: "no-store" })
    if (!res.ok) return { ok: false, status: res.status, error: `decisions ${res.status}` }
    const json = (await res.json()) as Partial<DecisionsSnapshot>
    return {
      ok: true,
      snapshot: {
        pending: Array.isArray(json.pending) ? json.pending : [],
        history: Array.isArray(json.history) ? json.history : [],
        counts: { ...EMPTY_COUNTS, ...(json.counts ?? {}) },
      },
    }
  } catch {
    return { ok: false, status: 0, error: "decisions network" }
  }
}

export async function resolveDecisionItem(
  id: string,
  action: DecisionAction,
  opts: { comment?: string; fetchFn?: typeof fetch } = {},
): Promise<{ ok: true; item: DecisionItem } | { ok: false; status: number; error: string }> {
  const fetchFn = opts.fetchFn ?? fetch
  try {
    const res = await fetchFn(`/api/portal/decisions/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...(opts.comment ? { comment: opts.comment } : {}) }),
    })
    const json = (await res.json().catch(() => ({}))) as { item?: DecisionItem; error?: string }
    if (!res.ok || !json.item) return { ok: false, status: res.status, error: json.error ?? `resolve ${res.status}` }
    return { ok: true, item: json.item }
  } catch {
    return { ok: false, status: 0, error: "resolve network" }
  }
}

export function countsOf(items: DecisionItem[]): DecisionCounts {
  const counts = { ...EMPTY_COUNTS, total: items.length }
  for (const item of items) {
    if (item.kind === "approval") counts.approvals += 1
    else if (item.kind === "note") counts.notes += 1
    else if (item.kind === "work") counts.workWaits += 1
    else counts.publish += 1
  }
  return counts
}

export function groupDecisionsByKind(items: DecisionItem[]): Record<DecisionKind, DecisionItem[]> {
  const groups: Record<DecisionKind, DecisionItem[]> = { approval: [], note: [], work: [], publish: [] }
  for (const item of items) {
    const group = groups[item.kind] ?? groups.publish
    group.push(item)
  }
  return groups
}

// Deep link for an item: doc notes open in `/docs`, work waits in `/work`.
export function decisionHref(item: DecisionItem): string | null {
  if (item.kind === "note" && item.source && item.path) {
    return `/docs?source=${encodeURIComponent(item.source)}&path=${encodeURIComponent(item.path)}`
  }
  if (item.kind === "work") {
    return "/work"
  }
  return null
}

export function workDecisionId(role: string, id: string): string {
  return `work:${role}:${id}`
}
