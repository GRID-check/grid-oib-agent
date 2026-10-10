/**
 * Agent profiler repository (ADR-0017): the ONLY module that queries the DB
 * for the profiler domain. Raw data access and row shaping only —
 * authorization lives in the routes (platform-owner gate, mirrors
 * `api/platform/overview/route.ts`); tree-building lives in `./service`.
 */

import 'server-only'
import { and, desc, eq, gte, ilike, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm'
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
 * migration 0124, ADR-0093): a restricted-use record, or a revision task
 * whose document now sits where not every member may read. Its
 * title is a person's words about that conversation, often the first question,
 * and the profiler is a cross-organization staff view outside the folder's
 * audience: the title is withheld from the list and from the search, which
 * would otherwise confirm a word of it. The id stays, the operator's handle on
 * the timeline.
 */
const RESTRICTED_USE = sql`grid_conversation_restricted_use(${SPAN_ORGANIZATION}, ${agentProfilerSpans.conversationId})`

/**
 * Which conversations the directory lists: those with a turn that STARTED in
 * `[start, endExclusive)`, optionally only in the named organizations and
 * projects. Built from the Answer-quality scope by the service.
 */
export interface ProfiledConversationFilter {
  start: Date
  endExclusive: Date
  /** Empty means every organization. */
  organizationIds: readonly string[]
  /** Empty means every project. */
  projectIds: readonly string[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The scope as conditions over turn spans joined to their conversation. The
 * organization is the conversation's, falling back to the span's for a turn
 * whose conversation row is gone; the project can only come from the
 * conversation, so a project filter drops turns without one. A project id
 * that is not a UUID names no project and matches nothing.
 */
function scopeConditions(filter: ProfiledConversationFilter): SQL[] {
  const conditions: SQL[] = [
    eq(agentProfilerSpans.kind, 'turn'),
    isNotNull(agentProfilerSpans.conversationId),
    gte(agentProfilerSpans.startedAt, filter.start),
    lt(agentProfilerSpans.startedAt, filter.endExclusive),
  ]
  if (filter.organizationIds.length > 0) {
    conditions.push(
      inArray(
        sql`coalesce(${conversations.organizationId}, ${agentProfilerSpans.organizationId})`,
        [...filter.organizationIds]
      )
    )
  }
  if (filter.projectIds.length > 0) {
    const projectIds = filter.projectIds.filter((id) => UUID.test(id))
    conditions.push(
      projectIds.length > 0 ? inArray(conversations.projectId, projectIds) : sql`false`
    )
  }
  return conditions
}

/**
 * One row per conversation, aggregated over its turns IN SCOPE: `turnCount`
 * and `totalDurationMs` count the turns in the range, and `lastActiveAt` is the
 * newest of them.
 */
async function selectConversations(conditions: SQL[], limit: number) {
  const db = getDb()
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
      .where(and(...conditions))
      .groupBy(agentProfilerSpans.conversationId)
      .orderBy(desc(sql`max(${agentProfilerSpans.startedAt})`))
      .limit(limit)
  )
  return rows.map((row): ProfiledConversationRow => ({
    conversationId: row.conversationId as string,
    organizationId: row.organizationId,
    title: row.title,
    // Raw `sql` results are not runtime-validated — coerce at this boundary.
    titleWithheld: row.titleWithheld === true,
    turnCount: Number(row.turnCount),
    totalDurationMs: Number(row.totalDurationMsRaw),
    // `max(started_at)` is annotated `sql<Date>` but the pg driver hands back
    // a timestamp string at runtime; coerce at the boundary so downstream
    // `.toISOString()` in the service does not crash on a string.
    lastActiveAt: new Date(row.lastActiveAt),
  }))
}

/**
 * Cross-org conversation directory, most recently active first — the same
 * "fetch N, report whether more exist" shape as `getPlatformOverview`'s
 * organization directory rather than full cursor pagination (an ops list,
 * not an infinite-scroll surface). `query` narrows it within the scope.
 */
export async function listProfiledConversations(
  filter: ProfiledConversationFilter,
  query?: string
): Promise<{
  rows: ProfiledConversationRow[]
  capped: boolean
}> {
  const conditions = scopeConditions(filter)
  if (query) {
    // Escaped: the operator types a literal string, and `%` or `_` in it must
    // match themselves, not every conversation.
    const pattern = `%${escapeLikePattern(query)}%`
    conditions.push(
      or(
        ilike(agentProfilerSpans.conversationId, pattern),
        // A withheld title is not searchable either: a hit would confirm a word of it.
        and(ilike(conversations.title, pattern), sql`not ${RESTRICTED_USE}`)
      ) as SQL
    )
  }
  const rows = await selectConversations(conditions, CONVERSATION_LIST_CAP + 1)
  return {
    capped: rows.length > CONVERSATION_LIST_CAP,
    rows: rows.slice(0, CONVERSATION_LIST_CAP),
  }
}

/**
 * One conversation's directory row within the scope, or null when it has no
 * turn in it. Lets the client tell "outside the scope" from "below the list's
 * cap" or "filtered out by the search" for the conversation it has selected.
 */
export async function findProfiledConversation(
  filter: ProfiledConversationFilter,
  conversationId: string
): Promise<ProfiledConversationRow | null> {
  const rows = await selectConversations(
    [...scopeConditions(filter), eq(agentProfilerSpans.conversationId, conversationId)],
    1
  )
  return rows[0] ?? null
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
