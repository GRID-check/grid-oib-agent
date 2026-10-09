/**
 * Agent profiler service (ADR-0017): business logic over the profiler
 * repository. Caller authorization (requirePlatformPermission) happens in the
 * routes — this module is data-only, mirrors `lib/budgets/service.ts`.
 */

import 'server-only'
import type { AgentProfilerSpan, NewAgentProfilerSpan, SpanKind, SpanStatus } from '@/lib/db/schema'
import { getOrganizationDisplayNames } from '@/lib/organizations/display-names'
import { scopeBounds, type QualityScope } from '@/lib/quality/scope'
import * as repository from './repository'

export async function recordProfilerSpans(spans: NewAgentProfilerSpan[]): Promise<number> {
  return repository.insertSpans(spans)
}

export interface ProfiledConversationSummary {
  conversationId: string
  organizationId: string | null
  /** Display name for `organizationId`; null when unknown or unresolvable. */
  organizationName: string | null
  title: string | null
  /** Turns in the scope's range, not in the conversation's whole life. */
  turnCount: number
  /** Summed turn time in the scope's range. */
  totalDurationMs: number
  /** The newest turn in the scope's range. */
  lastActiveAt: string
}

export interface ProfiledConversationList {
  conversations: ProfiledConversationSummary[]
  capped: boolean
  /**
   * Only when a conversation was asked about: its row within the scope, or
   * null when it has no turn in the scope. Independent of the search and of
   * the list's cap, so a client can deselect exactly what fell out of scope.
   */
  selected?: ProfiledConversationSummary | null
}

/**
 * The conversation directory in one Answer-quality scope: conversations with a
 * turn in the date range, in the named organizations and projects when any
 * are named, narrowed by `query` within that.
 */
export async function listProfiledConversations(
  scope: QualityScope,
  options: { query?: string; conversationId?: string } = {}
): Promise<ProfiledConversationList> {
  const filter = {
    ...scopeBounds(scope),
    organizationIds: scope.organizationIds,
    projectIds: scope.projectIds,
  }
  const [{ rows, capped }, selectedRow] = await Promise.all([
    repository.listProfiledConversations(filter, options.query),
    options.conversationId
      ? repository.findProfiledConversation(filter, options.conversationId)
      : Promise.resolve(undefined),
  ])
  const names = await getOrganizationDisplayNames(
    [...rows, ...(selectedRow ? [selectedRow] : [])].map((row) => row.organizationId)
  )
  const toSummary = (row: repository.ProfiledConversationRow): ProfiledConversationSummary => ({
    conversationId: row.conversationId,
    organizationId: row.organizationId,
    organizationName: row.organizationId ? (names.get(row.organizationId) ?? null) : null,
    title: row.title,
    turnCount: row.turnCount,
    totalDurationMs: row.totalDurationMs,
    lastActiveAt: row.lastActiveAt.toISOString(),
  })
  return {
    capped,
    conversations: rows.map(toSummary),
    ...(selectedRow === undefined ? {} : { selected: selectedRow ? toSummary(selectedRow) : null }),
  }
}

export interface SpanNode {
  spanId: string
  kind: SpanKind
  name: string
  startedAt: string
  endedAt: string
  durationMs: number
  status: SpanStatus
  errorMessage: string | null
  metadata: Record<string, unknown> | null
  children: SpanNode[]
}

export interface ProfiledTurn {
  turnId: string
  jobId: string | null
  startedAt: string
  durationMs: number
  status: SpanStatus
  spanCount: number
  /** Never null: a turn whose root span was lost gets a synthetic one. */
  root: SpanNode
}

function toNode(span: AgentProfilerSpan): SpanNode {
  return {
    spanId: span.spanId,
    kind: span.kind as SpanKind,
    name: span.name,
    startedAt: span.startedAt.toISOString(),
    endedAt: span.endedAt.toISOString(),
    durationMs: span.durationMs,
    status: span.status as SpanStatus,
    errorMessage: span.errorMessage,
    metadata: (span.metadata as Record<string, unknown> | null) ?? null,
    children: [],
  }
}

const byStart = (
  a: { startedAt: string; spanId: string },
  b: { startedAt: string; spanId: string }
): number => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId)

/**
 * The turn's root: the earliest `turn`-kind span without a parent, else the
 * earliest parentless span. Deterministic, because a turn CAN carry several
 * parentless spans (a retried flush, a second entry point), and "the last one
 * in the loop wins" made the tree depend on row order.
 */
function pickRoot(candidates: SpanNode[]): SpanNode | null {
  const sorted = [...candidates].sort(byStart)
  return sorted.find((node) => node.kind === 'turn') ?? sorted[0] ?? null
}

/**
 * A stand-in root for a turn whose root span never reached the ledger (a
 * dropped flush batch). Spans the whole turn, so the turn still has a duration
 * and a tree; `metadata.synthetic` marks it as not a recorded span.
 */
function syntheticRoot(turnId: string, nodes: SpanNode[]): SpanNode {
  const startedAt = nodes.map((node) => node.startedAt).sort()[0]
  const endedAt = nodes
    .map((node) => node.endedAt)
    .sort()
    .at(-1) as string
  return {
    spanId: `${turnId}:root`,
    kind: 'turn',
    name: 'turn',
    startedAt,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    status: nodes.some((node) => node.status === 'error') ? 'error' : 'ok',
    errorMessage: null,
    metadata: { synthetic: true },
    children: [],
  }
}

/**
 * True when following `spanId`'s parents leads back to it. A cycle would make
 * the tree infinite (and the JSON response unserializable), so its spans are
 * treated as parentless instead.
 */
function inCycle(spanId: string, parentOf: Map<string, string | null>): boolean {
  let current = parentOf.get(spanId) ?? null
  for (let steps = 0; current !== null && steps <= parentOf.size; steps += 1) {
    if (current === spanId) return true
    current = parentOf.get(current) ?? null
  }
  return false
}

/**
 * One turn's tree, keyed by `parentSpanId`. Every span lands in it: a span
 * whose parent is missing from the ledger (a dropped flush batch, the same
 * best-effort tolerance as the cost ledger), and every parentless span other
 * than the root, hang off the root rather than vanishing.
 */
function buildTurn(turnId: string, turnSpans: AgentProfilerSpan[]): ProfiledTurn {
  const nodes = new Map(turnSpans.map((span) => [span.spanId, toNode(span)]))
  const parentOf = new Map(turnSpans.map((span) => [span.spanId, span.parentSpanId]))
  const isTopLevel = (span: AgentProfilerSpan): boolean =>
    span.parentSpanId === null || inCycle(span.spanId, parentOf)
  const recordedRoot = pickRoot(
    turnSpans.filter(isTopLevel).map((span) => nodes.get(span.spanId) as SpanNode)
  )
  const root = recordedRoot ?? syntheticRoot(turnId, [...nodes.values()])

  for (const span of turnSpans) {
    const node = nodes.get(span.spanId) as SpanNode
    if (node === root) continue
    const parent = isTopLevel(span) ? undefined : nodes.get(span.parentSpanId as string)
    ;(parent ?? root).children.push(node)
  }
  for (const node of [root, ...nodes.values()]) node.children.sort(byStart)

  return {
    turnId,
    jobId: turnSpans.find((span) => span.jobId)?.jobId ?? null,
    startedAt: root.startedAt,
    durationMs: root.durationMs,
    status: root.status,
    spanCount: turnSpans.length,
    root,
  }
}

/** Group a conversation's flat span list into one tree per turn, oldest turn first. */
function buildTurns(spans: AgentProfilerSpan[]): ProfiledTurn[] {
  const byTurn = new Map<string, AgentProfilerSpan[]>()
  for (const span of spans) {
    const list = byTurn.get(span.turnId)
    if (list) list.push(span)
    else byTurn.set(span.turnId, [span])
  }
  return [...byTurn]
    .map(([turnId, turnSpans]) => buildTurn(turnId, turnSpans))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

export interface ConversationTimeline {
  conversationId: string
  /** The newest turns, oldest first (at most `TIMELINE_TURN_CAP`). */
  turns: ProfiledTurn[]
  /** Distinct turns the conversation has in the ledger, loaded or not. */
  totalTurns: number
  /** True when older turns, or spans past the span ceiling, were left out. */
  capped: boolean
}

export async function getConversationTimeline(
  conversationId: string
): Promise<ConversationTimeline> {
  const { spans, totalTurns, capped } = await repository.getSpansForConversation(conversationId)
  return { conversationId, turns: buildTurns(spans), totalTurns, capped }
}
