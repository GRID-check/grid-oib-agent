import 'server-only'
/**
 * A person's decision on something Piloti produced, as a Langfuse score on the
 * trace of the turn that produced it (ADR-0089, ADR-0105, ADR-0109): a proposal
 * applied or dismissed, a proposed mark taken over or dismissed, an applied
 * change undone. Best-effort: never throws into the decision that called it.
 *
 * ## The score
 *
 * `piloti-decision`, `CATEGORICAL`, value `accepted | dismissed | undone`,
 * declared in `aiq_agent.observability.langfuse_scores.SCORE_DEFINITIONS`.
 * Categorical because Langfuse charts it as a distribution, and the share of
 * `accepted` among the decisions is how often Piloti's work was right to
 * propose. `metadata` names the subject (`proposal`, `annotation`, `change`,
 * `intake_suggestion`, `inbound_mail_suggestion`) and its id, so a trace with
 * several decisions is readable; a subject may add codes of its own (`detail`).
 *
 * The score id is derived from the subject, so a repeated call (a retried
 * request, a second replica) upserts instead of counting twice. A mark Piloti
 * proposed and a change that put it there are different subjects, so one mark
 * taken over and later undone is two scores, which is what happened.
 *
 * ## Whose decision
 *
 * Not recorded. The score says what was decided and about what, never by whom:
 * Langfuse's readers are platform staff, scores reach PostHog with their
 * metadata, and a user id on a score would sit outside the gate that keeps
 * identity off traces (`GRID_TRACE_IDENTITY_ATTRIBUTES`,
 * `docs/observability/langfuse.md`). `decidedBy` stays in the signature
 * because the caller holds it; the ledger of who decided is the proposal, the
 * mark and the change rows.
 *
 * ## Finding the trace
 *
 * The answer message of the turn carries its trace id in `metadata.trace_id`
 * (`chat_socket.turn_row_metadata`). The caller passes the turn as `origin`
 * when it knows it; otherwise the producing row names it: a proposal's
 * `origin_message_id`, a change's own, and for a mark the `create` row of
 * `piloti_changes`. No trace id on the answer (an unpersisted turn, or one from
 * before traces were recorded) means no score: a score on a guessed trace id
 * attaches to nothing.
 */

import type { LangfuseClient } from '@langfuse/client'
import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { pilotiChanges } from '@/lib/db/schema/piloti-changes'
import { getAnswerTraceId } from '@/lib/feedback/repository'
import { findProposedChange } from '@/lib/proposals/repository'
import { langfuseApiConfig } from './config'
import { upsertScore } from './feedback-score'

/**
 * What was decided on. `intake_suggestion` is one value a reading of the
 * project's documents suggested (ADR-0111), confirmed or dismissed on the
 * review; it has no turn, so its caller passes the reading's trace id.
 * `inbound_mail_suggestion` is where Piloti suggested filing one part of a
 * held mail (ADR-0134, D21), filed there (accepted) or not (dismissed); its
 * trace is the `filing-fit` generation's, stored on the part.
 */
export type DecisionSubject = 'proposal' | 'annotation' | 'change' | 'intake_suggestion' | 'inbound_mail_suggestion'
export type Decision = 'accepted' | 'dismissed' | 'undone'

/** The score's name in Langfuse. A contract: dashboards and filters select it by name. */
export const DECISION_SCORE_NAME = 'piloti-decision'


type ScoreRequest = Parameters<LangfuseClient['api']['scores']['create']>[0]

export interface DecisionScoreInput {
  organizationId: string
  subject: DecisionSubject
  /** The proposal, mark or change id. */
  subjectId: string
  decision: Decision
  decidedBy: string
  /** The turn that produced it, when the caller knows; otherwise looked up (a mark's `create` change). */
  origin?: { conversationId: string; messageId: string } | null
  /**
   * The producing trace itself, for work that ran outside a turn (a reading of
   * the project's documents, `research-job`). Wins over `origin`.
   */
  traceId?: string | null
  /** Codes the subject adds to the score's metadata (never names, text or a person). */
  detail?: Readonly<Record<string, string>>
}

/** The Langfuse score id for one subject. Stable, so a repeated decision upserts. */
export function decisionScoreId(subject: DecisionSubject, subjectId: string): string {
  return `${DECISION_SCORE_NAME}-${subject}-${subjectId}`
}

/** The decision as a Langfuse score. Pure, so the mapping is tested without a network. */
export function toDecisionScore(input: {
  traceId: string
  subject: DecisionSubject
  subjectId: string
  decision: Decision
  detail?: Readonly<Record<string, string>>
}): ScoreRequest {
  return {
    id: decisionScoreId(input.subject, input.subjectId),
    traceId: input.traceId,
    name: DECISION_SCORE_NAME,
    dataType: 'CATEGORICAL',
    value: input.decision,
    // The subject and its id last, so a detail cannot rename what was decided on.
    metadata: { ...input.detail, subject: input.subject, subject_id: input.subjectId },
  }
}

// ── Finding the turn ────────────────────────────────────────────────────────

/** The answer message of the turn a `piloti_changes` row was made in. */
async function changeOriginMessage(
  organizationId: string,
  where: ReturnType<typeof and>
): Promise<string | null> {
  const [row] = await withTenant({ organizationId }, () =>
    getDb()
      .select({ messageId: pilotiChanges.originMessageId })
      .from(pilotiChanges)
      .where(where)
      .orderBy(asc(pilotiChanges.createdAt))
      .limit(1)
  )
  return row?.messageId ?? null
}

/** The answer message that produced the subject: the caller's word first, then the row that names it. */
async function originMessageId(input: DecisionScoreInput): Promise<string | null> {
  if (input.origin?.messageId) return input.origin.messageId
  const org = eq(pilotiChanges.organizationId, input.organizationId)
  switch (input.subject) {
    case 'proposal':
      return (await findProposedChange(input.organizationId, input.subjectId))?.originMessageId ?? null
    case 'annotation':
      return changeOriginMessage(
        input.organizationId,
        and(org, eq(pilotiChanges.annotationId, input.subjectId), eq(pilotiChanges.op, 'create'))
      )
    case 'change':
      return changeOriginMessage(input.organizationId, and(org, eq(pilotiChanges.id, input.subjectId)))
    case 'intake_suggestion':
    case 'inbound_mail_suggestion':
      // A reading and a suggestion job are no turn: the trace comes with the input, or there is none.
      return null
  }
}

/** The trace the score goes on: the caller's, else the producing turn's answer's. */
async function producingTraceId(input: DecisionScoreInput): Promise<string | null> {
  if (input.traceId) return input.traceId
  const messageId = await originMessageId(input)
  if (!messageId) return null
  return withTenant({ organizationId: input.organizationId }, () => getAnswerTraceId(messageId, input.organizationId))
}

// ── Posting ─────────────────────────────────────────────────────────────────

/**
 * Record one decision as a score on the producing turn's trace. Resolves when
 * done and never rejects: Langfuse being slow, down or unconfigured, a missing
 * trace and a failed lookup each cost the decision nothing.
 */
export async function recordDecisionScore(input: DecisionScoreInput): Promise<void> {
  const config = langfuseApiConfig()
  if (!config) return
  try {
    const traceId = await producingTraceId(input)
    if (!traceId) return
    // The feedback score's poster: one client, bounded, never rejecting.
    await upsertScore(config, decisionScoreId(input.subject, input.subjectId), toDecisionScore({ ...input, traceId }))
  } catch (error) {
    console.warn(`[Langfuse] decision score failed for ${input.subject} ${input.subjectId} (non-fatal):`, error)
  }
}
