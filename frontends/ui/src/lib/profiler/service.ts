/**
 * Agent profiler service (ADR-0017): business logic over the profiler
 * repository. Caller authorization (requirePlatformPermission) happens in the
 * routes — this module is data-only, mirrors `lib/budgets/service.ts`.
 */

import 'server-only'
import type { AgentProfilerSpan, NewAgentProfilerSpan, SpanKind, SpanStatus } from '@/lib/db/schema'
import * as repository from './repository'

export async function recordProfilerSpans(spans: NewAgentProfilerSpan[]): Promise<number> {
  return repository.insertSpans(spans)
}

export interface ProfiledConversationSummary {
  conversationId: string
  organizationId: string | null
  title: string | null
  turnCount: number
  totalDurationMs: number
  lastActiveAt: string
}

export async function listProfiledConversations(query?: string): Promise<{
  conversations: ProfiledConversationSummary[]
  capped: boolean
}> {
  const { rows, capped } = await repository.listProfiledConversations(query)
  return {
    capped,
    conversations: rows.map((row) => ({
      conversationId: row.conversationId,
      organizationId: row.organizationId,
      title: row.title,
      turnCount: row.turnCount,
      totalDurationMs: row.totalDurationMs,
      lastActiveAt: row.lastActiveAt.toISOString(),
    })),
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
  root: SpanNode | null
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

/**
 * Group a conversation's flat span list into one tree per turn, keyed by
 * `parentSpanId`. A span whose parent didn't make it into the ledger (a
 * dropped flush batch — same best-effort tolerance as the cost ledger) is
 * dropped from the tree but still counted in `spanCount`.
 */
function buildTurns(spans: AgentProfilerSpan[]): ProfiledTurn[] {
  const byTurn = new Map<string, AgentProfilerSpan[]>()
  for (const span of spans) {
    const list = byTurn.get(span.turnId)
    if (list) list.push(span)
    else byTurn.set(span.turnId, [span])
  }

  const turns: ProfiledTurn[] = []
  for (const [turnId, turnSpans] of byTurn) {
    const nodesBySpanId = new Map(turnSpans.map((span) => [span.spanId, toNode(span)]))
    let root: SpanNode | null = null
    for (const span of turnSpans) {
      const node = nodesBySpanId.get(span.spanId)
      if (!node) continue
      if (span.parentSpanId === null) {
        root = node
        continue
      }
      nodesBySpanId.get(span.parentSpanId)?.children.push(node)
    }
    for (const node of nodesBySpanId.values()) {
      node.children.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    }
    const hasError = turnSpans.some((span) => span.status === 'error')
    turns.push({
      turnId,
      jobId: turnSpans.find((span) => span.jobId)?.jobId ?? null,
      startedAt: root?.startedAt ?? turnSpans[0].startedAt.toISOString(),
      durationMs: root?.durationMs ?? Math.max(...turnSpans.map((span) => span.durationMs)),
      status: root?.status ?? (hasError ? 'error' : 'ok'),
      spanCount: turnSpans.length,
      root,
    })
  }
  turns.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return turns
}

export async function getConversationTimeline(conversationId: string): Promise<{
  conversationId: string
  turns: ProfiledTurn[]
}> {
  const spans = await repository.getSpansForConversation(conversationId)
  return { conversationId, turns: buildTurns(spans) }
}
