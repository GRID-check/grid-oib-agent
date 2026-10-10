import 'server-only'
import { and, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { conversations, messages } from '@/lib/db/schema'

export interface DailyQuestions {
  /** UTC day, `YYYY-MM-DD`. */
  day: string
  questions: number
}

/**
 * Questions asked in one project per UTC day since `start`: the user turns of
 * every conversation filed under it. Counts only; no conversation is read.
 */
export async function countQuestionsPerDay(
  organizationId: string,
  projectId: string,
  start: Date
): Promise<DailyQuestions[]> {
  const db = getDb()
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${messages.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      questions: sql<string>`count(*)`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.projectId, projectId),
        eq(messages.role, 'user'),
        gte(messages.createdAt, start)
      )
    )
    .groupBy(sql`1`)

  return rows.map((row) => ({ day: row.day, questions: Number(row.questions) }))
}

/** How many different people asked in the project since `start`. */
export async function countAskingPeople(
  organizationId: string,
  projectId: string,
  start: Date
): Promise<number> {
  const db = getDb()
  const [row] = await db
    .select({ people: sql<string>`count(distinct ${messages.authorUserId})` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.projectId, projectId),
        eq(messages.role, 'user'),
        gte(messages.createdAt, start)
      )
    )
  return Number(row?.people ?? 0)
}
