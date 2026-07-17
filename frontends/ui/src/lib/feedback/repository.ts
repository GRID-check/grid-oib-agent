/**
 * Feedback repository — the only module that queries the `answer_feedback`
 * table (ADR-0017, WS-7).
 *
 * Repository rules (see docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no WorkOS.
 *   - Every query that serves tenant data takes `organizationId` and scopes
 *     the WHERE clause with it — tenancy is enforced in SQL, not in JS.
 *   - List queries are always bounded (`limit`).
 *
 * Voting model (documented on the schema): re-vote = upsert on the
 * (user_id, message_id) unique key; toggle-off = delete. The upsert's
 * conflict target already pins the row to the voting user, and the service
 * only ever passes the session's own user/org ids, so a conflicting update
 * can never cross tenants.
 */

import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  answerFeedback,
  type AnswerFeedback,
  type AnswerFeedbackReason,
  type AnswerFeedbackVerdict,
} from '@/lib/db/schema'

/** Hard cap for the per-conversation hydration list. */
export const CONVERSATION_FEEDBACK_LIST_LIMIT = 200

export interface UpsertAnswerFeedbackValues {
  organizationId: string
  projectId: string | null
  conversationId: string | null
  messageId: string
  userId: string
  verdict: AnswerFeedbackVerdict
  reason: AnswerFeedbackReason | null
}

/** Insert or update the caller's vote on one answer (re-vote semantics). */
export async function upsertAnswerFeedback(values: UpsertAnswerFeedbackValues): Promise<AnswerFeedback> {
  const db = getDb()
  const [row] = await db
    .insert(answerFeedback)
    .values(values)
    .onConflictDoUpdate({
      target: [answerFeedback.userId, answerFeedback.messageId],
      set: {
        verdict: values.verdict,
        reason: values.reason,
        conversationId: values.conversationId,
        projectId: values.projectId,
        organizationId: values.organizationId,
        updatedAt: new Date(),
      },
    })
    .returning()
  return row
}

/** Toggle-off: delete the caller's vote. Returns whether a row existed. */
export async function deleteAnswerFeedbackForUser(
  userId: string,
  messageId: string,
  organizationId: string,
): Promise<boolean> {
  const db = getDb()
  const rows = await db
    .delete(answerFeedback)
    .where(
      and(
        eq(answerFeedback.userId, userId),
        eq(answerFeedback.messageId, messageId),
        eq(answerFeedback.organizationId, organizationId),
      ),
    )
    .returning({ id: answerFeedback.id })
  return rows.length > 0
}

/** The caller's own votes in one conversation (bounded; newest first). */
export async function listAnswerFeedbackForConversation(
  userId: string,
  conversationId: string,
  organizationId: string,
  limit = CONVERSATION_FEEDBACK_LIST_LIMIT,
): Promise<AnswerFeedback[]> {
  const db = getDb()
  return db
    .select()
    .from(answerFeedback)
    .where(
      and(
        eq(answerFeedback.organizationId, organizationId),
        eq(answerFeedback.userId, userId),
        eq(answerFeedback.conversationId, conversationId),
      ),
    )
    .orderBy(desc(answerFeedback.createdAt))
    .limit(limit)
}
