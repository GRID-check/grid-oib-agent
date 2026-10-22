import 'server-only'
/**
 * What a person did with the E-Mail-Verlauf a held mail matched, as a Langfuse
 * score (ADR-0089, ADR-0134, DECISION §10): `mail-thread-match`, categorical,
 * declared in `aiq_agent.observability.langfuse_scores.SCORE_DEFINITIONS`.
 *
 * - `followed`: the text was appended to the strongest match (the candidate
 *   the E-Mail-Eingang offers first), or by a follow (metadata `via: follow`);
 * - `other_thread`: appended to another Verlauf, a weaker match or none of them;
 * - `new_thread`: a new Verlauf was started although one matched.
 *
 * One score per decided mail text that had a match; a text with no match says
 * nothing about matching and is not scored. Charted by `strength` and
 * `sender_trust`, the share `followed` is the precision of the thread core's
 * matching and of its pre-selection (`preselected`), which is what decides
 * whether a stranger's References may ever pre-select.
 *
 * ## The trace it sits on
 *
 * Matching is the receive job's, a rule and not a model call, so it has no
 * generation of its own; and a mail Piloti made no suggestion for (an
 * unconfirmed sender's, or with the budget spent) has no trace at all. The
 * score therefore comes with its own trace, `mail-thread-match`, written in the
 * same ingestion batch: ids, codes and counts, never a subject, a name or an
 * address. Both ids derive from the text part, so a repeated decision (a
 * retried request, a restore and a second decision) overwrites, never counts
 * twice.
 *
 * Best-effort: never throws into the decision that called it, and nothing is
 * sent with Langfuse unconfigured.
 */

import type { LangfuseClient } from '@langfuse/client'
import { v5 as uuidv5 } from 'uuid'
import type { InboundMailDecisionVia } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import { threadPreselection, type SenderEvidence, type ThreadMatch } from '@/lib/mail-thread/mail-threading'
import { langfuseApiConfig } from './config'
import { clientFor, environment, release } from './tool-call-trace'

/** The score's name in Langfuse, and the name of the trace it sits on. */
export const MAIL_THREAD_MATCH_SCORE_NAME = 'mail-thread-match'

export type MailThreadMatchValue = 'followed' | 'other_thread' | 'new_thread'

/** What the person did with the text: appended it to a Verlauf, or started one. */
export type ThreadChoice = { action: 'append'; mailThreadId: string } | { action: 'create' }

/**
 * The score's value, or null when the mail matched no Verlauf (nothing to
 * score). `matches` is the stored `thread_match`, strongest first.
 */
export function mailThreadMatchValue(matches: readonly ThreadMatch[], choice: ThreadChoice): MailThreadMatchValue | null {
  const strongest = matches[0]
  if (!strongest) return null
  if (choice.action === 'create') return 'new_thread'
  return choice.mailThreadId === strongest.threadId ? 'followed' : 'other_thread'
}

export interface MailThreadMatchRecord {
  organizationId: string
  projectId: string
  mailId: string
  /** The mail's text part: one score per decided text. */
  partId: string
  /** The stored `thread_match`, strongest first. */
  matches: readonly ThreadMatch[]
  /** The stored sender evidence, as the candidates were pre-selected with it. */
  sender: SenderEvidence
  choice: ThreadChoice
  via: InboundMailDecisionVia
  /** When the decision was made. */
  decidedAt: Date
}

type IngestionBatch = Parameters<LangfuseClient['api']['ingestion']['batch']>[0]

/** A 32-hex id derived from a name, the form `isTraceId` accepts. */
const derivedHexId = (name: string): string => uuidv5(name, uuidv5.URL).replace(/-/g, '')

/** The trace's and the score's ids for one text part. Stable, so a repeated decision overwrites. */
export function mailThreadMatchIds(partId: string): { traceId: string; scoreId: string } {
  return {
    traceId: derivedHexId(`grid:mail-thread-match:${partId}`),
    scoreId: `${MAIL_THREAD_MATCH_SCORE_NAME}-${partId}`,
  }
}

/**
 * The ingestion batch for one decision: the trace and the score, or null when
 * there is nothing to score. Pure, so the mapping is tested without a network.
 */
export function mailThreadMatchBatch(record: MailThreadMatchRecord, eventIds: [string, string]): IngestionBatch | null {
  const value = mailThreadMatchValue(record.matches, record.choice)
  const strongest = record.matches[0]
  if (!value || !strongest) return null
  const { traceId, scoreId } = mailThreadMatchIds(record.partId)
  const { choice } = record
  const chosenRank = choice.action === 'append' ? record.matches.findIndex((match) => match.threadId === choice.mailThreadId) : -1
  const metadata = {
    mail_id: record.mailId,
    project_id: record.projectId,
    part_id: record.partId,
    strength: strongest.strength,
    preselected: threadPreselection(strongest, record.sender).preselected,
    candidates: record.matches.length,
    chosen_rank: chosenRank,
    sender_trust: record.sender.senderTrust,
    via: record.via,
  }
  const timestamp = record.decidedAt.toISOString()
  const env = environment()
  const rel = release()
  return {
    batch: [
      {
        type: 'trace-create',
        id: eventIds[0],
        timestamp,
        body: {
          id: traceId,
          timestamp,
          name: MAIL_THREAD_MATCH_SCORE_NAME,
          metadata,
          tags: ['feature:inbound-mail', `strength:${strongest.strength}`, `via:${record.via}`],
          ...(env ? { environment: env } : {}),
          ...(rel ? { release: rel } : {}),
        },
      },
      {
        type: 'score-create',
        id: eventIds[1],
        timestamp,
        body: {
          id: scoreId,
          traceId,
          name: MAIL_THREAD_MATCH_SCORE_NAME,
          dataType: 'CATEGORICAL',
          value,
          metadata,
          ...(env ? { environment: env } : {}),
        },
      },
    ],
  }
}

/**
 * Record one decision on a matched Verlauf. Resolves when sent (or skipped)
 * and never rejects.
 */
export async function recordMailThreadMatchScore(record: MailThreadMatchRecord): Promise<void> {
  const config = langfuseApiConfig()
  if (!config) return
  try {
    const batch = mailThreadMatchBatch(record, [crypto.randomUUID(), crypto.randomUUID()])
    if (!batch) return
    await clientFor(config).api.ingestion.batch(batch, { timeoutInSeconds: 5, maxRetries: 1 })
  } catch (error) {
    console.warn(`[Langfuse] mail-thread-match score failed for part ${record.partId} (non-fatal):`, error)
  }
}
