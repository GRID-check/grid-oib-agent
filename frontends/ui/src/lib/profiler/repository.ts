/**
 * Agent profiler repository (ADR-0017): the ONLY module that queries the DB
 * for the profiler domain. Raw data access and row shaping only —
 * authorization lives in the routes (platform-owner gate, mirrors
 * `api/platform/overview/route.ts`); tree-building lives in `./service`.
 */

import 'server-only'
import { and, desc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withOptionalTenant, withPlatformAccess } from '@/lib/db/tenant-context'
import { escapeLikePattern } from '@/lib/text/like-pattern'
import {
  agentProfilerSpans,
  conversations,
  type AgentProfilerSpan,
  type NewAgentProfilerSpan,
} from '@/lib/db/schema'

const PROFILER_ACCESS_REASON =
  'platform profiler: a deliberately cross-organization operations directory'

export async function insertSpans(spans: NewAgentProfilerSpan[]): Promise<number> {
  if (spans.length === 0) return 0
  const db = getDb()
  // Every span in a batch comes from one turn and carries that turn's
  // organization, which is nullable: a turn from a session with no organization
  // selected belongs to no tenant and stays visible only to the platform tier.
  const inserted = await withOptionalTenant(
    spans[0].organizationId ?? null,
    'profiler spans from a turn with no organization selected belong to no tenant',
    () => db.insert(agentProfilerSpans).values(spans).returning({ id: agentProfilerSpans.id })
  )
  return inserted.length
}

export interface ProfiledConversationRow {
  conversationId: string
  organizationId: string | null
  /** Null when withheld: see {@link RESTRICTED_USE}. */
  title: string | null
  /** The conversation drew on a folder with restricted access, so its title is not shown. */
  titleWithheld: boolean
  turnCount: number
  totalDurationMs: number
  lastActiveAt: Date
}

const CONVERSATION_LIST_CAP = 200

/** The tenant a span's conversation belongs to: the conversation's, else the span's own. */
const SPAN_ORGANIZATION = sql`coalesce(${conversations.organizationId}, ${agentProfilerSpans.organizationId})`

/**
 * The span's conversation drew on a folder with restricted access, as the
 * database's one rule answers it (`grid_conversation_restricted_use`,
 * migration 0123, ADR-0091): a restricted-use record, or a revision task
 * whose document now sits where not every member may read. Its
 * title is a person's words about that conversation, often the first question,
 * and the profiler is a cross-organization staff view outside the folder's
 * audience: the title is withheld from the list and from the search, which
 * would otherwise confirm a word of it. The id stays, the operator's handle on
 * the timeline.
 */
const RESTRICTED_USE = sql`grid_conversation_restricted_use(${SPAN_ORGANIZATION}, ${agentProfilerSpans.conversationId})`

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
  // Escaped: the operator types a literal string, and `%` or `_` in it must
  // match themselves, not every conversation.
  const pattern = query ? `%${escapeLikePattern(query)}%` : null
  const searchCondition = pattern
    ? or(
        ilike(agentProfilerSpans.conversationId, pattern),
        and(ilike(conversations.title, pattern), sql`not ${RESTRICTED_USE}`)
      )
    : undefined

  const rows = await withPlatformAccess(PROFILER_ACCESS_REASON, () =>
    db
      .select({
        conversationId: agentProfilerSpans.conversationId,
        organizationId: sql<
          string | null
        >`max(coalesce(${conversations.organizationId}, ${agentProfilerSpans.organizationId}))`,
        title: sql<
          string | null
        >`max(case when ${RESTRICTED_USE} then null else ${conversations.title} end)`,
        titleWithheld: sql<boolean>`bool_or(${RESTRICTED_USE})`,
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
          ...(searchCondition ? [searchCondition] : [])
        )
      )
      .groupBy(agentProfilerSpans.conversationId)
      .orderBy(desc(sql`max(${agentProfilerSpans.startedAt})`))
      .limit(CONVERSATION_LIST_CAP + 1)
  )

  const capped = rows.length > CONVERSATION_LIST_CAP
  return {
    capped,
    rows: rows.slice(0, CONVERSATION_LIST_CAP).map((row) => ({
      conversationId: row.conversationId as string,
      organizationId: row.organizationId,
      title: row.title,
      // Raw `sql` results are not runtime-validated — coerce at this boundary.
      titleWithheld: row.titleWithheld === true,
      turnCount: row.turnCount,
      totalDurationMs: Number(row.totalDurationMsRaw),
      // `max(started_at)` is annotated `sql<Date>` but the pg driver hands back
      // a timestamp string at runtime; coerce at the boundary (same defensive
      // conversion as `Number(row.totalDurationMsRaw)` above) so downstream
      // `.toISOString()` in the service does not crash on a string.
      lastActiveAt: new Date(row.lastActiveAt),
    })),
  }
}

/** Newest turns one timeline reads; older turns are reported, not loaded. */
export const TIMELINE_TURN_CAP = 50
/** Hard ceiling on spans per timeline, whatever the turn count. */
export const TIMELINE_SPAN_CAP = 5000

export interface ConversationSpans {
  spans: AgentProfilerSpan[]
  /** Distinct turns the conversation has in the ledger, loaded or not. */
  totalTurns: number
  /** True when older turns, or spans past the span ceiling, were left out. */
  capped: boolean
}

/**
 * The newest `TIMELINE_TURN_CAP` turns of one conversation, spans returned
 * oldest first. Bounded twice: by turns (a long-running conversation must not load
 * its whole history) and by spans (one runaway turn must not either).
 */
export async function getSpansForConversation(conversationId: string): Promise<ConversationSpans> {
  const db = getDb()
  return withPlatformAccess(PROFILER_ACCESS_REASON, async () => {
    const turnRows = await db
      .select({
        turnId: agentProfilerSpans.turnId,
        totalTurns: sql<string>`count(*) over ()`,
      })
      .from(agentProfilerSpans)
      .where(eq(agentProfilerSpans.conversationId, conversationId))
      .groupBy(agentProfilerSpans.turnId)
      .orderBy(desc(sql`min(${agentProfilerSpans.startedAt})`))
      .limit(TIMELINE_TURN_CAP)

    const totalTurns = Number(turnRows[0]?.totalTurns ?? 0)
    if (turnRows.length === 0) return { spans: [], totalTurns: 0, capped: false }

    const spans = await db
      .select()
      .from(agentProfilerSpans)
      .where(
        and(
          eq(agentProfilerSpans.conversationId, conversationId),
          inArray(
            agentProfilerSpans.turnId,
            turnRows.map((row) => row.turnId)
          )
        )
      )
      // Newest first, so a cut drops the OLDEST spans: the recent turns are
      // the ones an operator opens the timeline for.
      .orderBy(desc(agentProfilerSpans.startedAt), desc(agentProfilerSpans.spanId))
      // One over the ceiling, so "exactly full" reads differently from "cut".
      .limit(TIMELINE_SPAN_CAP + 1)

    const spansCapped = spans.length > TIMELINE_SPAN_CAP
    return {
      spans: spans.slice(0, TIMELINE_SPAN_CAP).reverse(),
      totalTurns,
      capped: spansCapped || totalTurns > turnRows.length,
    }
  })
}
