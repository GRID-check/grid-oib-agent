import 'server-only'
/**
 * The scores a person's decision on a held mail writes (ADR-0089, ADR-0134,
 * DECISION §10), and what PostHog's `inbound_mail_decided` says of Piloti's
 * suggestion. Called where the decision is made, once per mail: the review
 * service when a person files or dismisses (`via` app, agent or a Piloti card),
 * the follow job when a person's standing decision appended the text (`via`
 * follow).
 *
 * - `piloti-decision`, subject `inbound_mail_suggestion`, per part that carried
 *   a suggestion: `accepted` when it was filed where Piloti suggested, as the
 *   Dokumentart it suggested; `dismissed` otherwise (filed elsewhere, or not
 *   filed). On the `filing-fit` trace that made the suggestion; metadata
 *   `folder` (`same`, `other`, `not_filed`) and `type` (`same`, `other`,
 *   `none`) say which half was not followed.
 * - `mail-thread-match` for the text, when the mail matched a Verlauf
 *   (`lib/langfuse/mail-thread-match-score.ts`).
 *
 * Best-effort: both recorders never reject, and nothing here throws into the
 * decision. The parts are read as they were BEFORE the decision (a part that
 * no longer waits was decided by someone else and is not scored again).
 */

import type { InboundMailPartRow, InboundMailRow } from '@/lib/db/schema'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
import { recordMailThreadMatchScore, type ThreadChoice } from '@/lib/langfuse/mail-thread-match-score'
import { senderEvidenceOf } from './candidates'
import type { InboundMailDecisionVia } from './inbound-mail-vocabulary'
import type { InboundMailDecision } from './inbound-mail-wire'
import { decidedSuggestions, suggestionFollowed, type SuggestionFollowed } from './suggest'

export interface MailDecisionToScore {
  organizationId: string
  /** The person who decided, or the follower; not recorded on the scores (see `decision-score.ts`). */
  decidedBy: string
  mail: InboundMailRow
  /** The mail's parts as they were before the decision was written. */
  parts: readonly InboundMailPartRow[]
  /** What the person decided for this mail; null when the whole mail was dismissed. */
  decision: Pick<InboundMailDecision, 'parts' | 'message'> | null
  via: InboundMailDecisionVia
  /** The path of a folder the decision named by id; null when the folder is unknown. */
  folderPathOf: (folderId: string) => string | null
  decidedAt?: Date
}

/**
 * Score one mail's decision and answer PostHog's `suggestion_followed` for it.
 * The scores are posted without waiting; the answer is immediate.
 */
export function scoreMailDecision(input: MailDecisionToScore): SuggestionFollowed {
  const decided = decidedSuggestions(input.parts, input.decision, input.folderPathOf)
  for (const entry of decided) {
    if (!entry.traceId) continue
    void recordDecisionScore({
      organizationId: input.organizationId,
      subject: 'inbound_mail_suggestion',
      subjectId: entry.partId,
      decision: entry.outcome.decision,
      decidedBy: input.decidedBy,
      traceId: entry.traceId,
      detail: { folder: entry.outcome.folder, type: entry.outcome.type },
    })
  }
  const choice = threadChoiceOf(input.decision)
  const text = input.parts.find((part) => part.kind === 'message')
  if (choice && text && text.state === 'waiting') {
    void recordMailThreadMatchScore({
      organizationId: input.organizationId,
      projectId: input.mail.projectId,
      mailId: input.mail.id,
      partId: text.id,
      matches: input.mail.threadMatch,
      sender: senderEvidenceOf(input.mail),
      choice,
      via: input.via,
      decidedAt: input.decidedAt ?? new Date(),
    })
  }
  return suggestionFollowed(decided.map((entry) => entry.outcome))
}

/** How the text was filed, or null when it was not (dismissed, or the mail dismissed whole). */
function threadChoiceOf(decision: MailDecisionToScore['decision']): ThreadChoice | null {
  const thread = decision?.message?.thread
  if (!thread) return null
  return thread.action === 'append' ? { action: 'append', mailThreadId: thread.mailThreadId } : { action: 'create' }
}
