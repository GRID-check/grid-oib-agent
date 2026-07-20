/**
 * Agent profiler repository (ADR-0017): the ONLY module that queries the DB
 * for the profiler domain. Raw data access and row shaping only —
 * authorization lives in the routes (platform-owner gate, mirrors
 * `api/platform/overview/route.ts`); tree-building lives in `./service`.
 */

import 'server-only'
import { and, desc, eq, ilike, isNotNull, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { agentProfilerSpans, conversations, type AgentProfilerSpan, type NewAgentProfilerSpan } from '@/lib/db/schema'

export async function insertSpans(spans: NewAgentProfilerSpan[]): Promise<number> {
  if (spans.length === 0) return 0
  const db = getDb()
  const inserted = await db.insert(agentProfilerSpans).values(spans).returning({ id: agentProfilerSpans.id })
  return inserted.length
}

export interface ProfiledConversationRow {
  conversationId: string
  organizationId: string | null
  title: string | null
  turnCount: number
  totalDurationMs: number
  lastActiveAt: Date
}

const CONVERSATION_LIST_CAP = 200

/**
 * Cross-org conversation directory, most recently active first — the same
 * "fetch N, report whether more exist" shape as `getPlatformOverview`'s
 * organization directory rather than full cursor pagination (an ops list,
 * not an infinite-scroll surface).
 */
export async function listProfiledConversations(query?: string): Promise<{
  rows: ProfiledConversationRow[]
  capped: boolean
}> {
  const db = getDb()
  const searchCondition = query
    ? or(ilike(agentProfilerSpans.conversationId, `%${query}%`), ilike(conversations.title, `%${query}%`))
    : undefined

  const rows = await db
    .select({
      conversationId: agentProfilerSpans.conversationId,
      organizationId: sql<string | null>`max(coalesce(${conversations.organizationId}, ${agentProfilerSpans.organizationId}))`,
      title: sql<string | null>`max(${conversations.title})`,
      turnCount: sql<number>`count(*)::int`,
      totalDurationMsRaw: sql<string>`coalesce(sum(${agentProfilerSpans.durationMs}), 0)::bigint`,
      lastActiveAt: sql<Date>`max(${agentProfilerSpans.startedAt})`,
    })
    .from(agentProfilerSpans)
    .leftJoin(conversations, eq(conversations.id, agentProfilerSpans.conversationId))
    .where(
      and(
        eq(agentProfilerSpans.kind, 'turn'),
        isNotNull(agentProfilerSpans.conversationId),
        ...(searchCondition ? [searchCondition] : []),
      ),
    )
    .groupBy(agentProfilerSpans.conversationId)
    .orderBy(desc(sql`max(${agentProfilerSpans.startedAt})`))
    .limit(CONVERSATION_LIST_CAP + 1)

  const capped = rows.length > CONVERSATION_LIST_CAP
  return {
    capped,
    rows: rows.slice(0, CONVERSATION_LIST_CAP).map((row) => ({
      conversationId: row.conversationId as string,
      organizationId: row.organizationId,
      title: row.title,
      turnCount: row.turnCount,
      totalDurationMs: Number(row.totalDurationMsRaw),
      lastActiveAt: row.lastActiveAt,
    })),
  }
}

export async function getSpansForConversation(conversationId: string): Promise<AgentProfilerSpan[]> {
  const db = getDb()
  return db
    .select()
    .from(agentProfilerSpans)
    .where(eq(agentProfilerSpans.conversationId, conversationId))
    .orderBy(agentProfilerSpans.startedAt)
}
