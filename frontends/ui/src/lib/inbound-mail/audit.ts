import 'server-only'
/**
 * The audit trail of the E-Mail-Eingang's decisions (ADR-0134, `lib/audit/schemas.mjs`).
 *
 * A decision row IS the record of what a person decided about a held mail, so
 * its line in the trail is owed, not best effort: each decision is sent under
 * a fixed idempotency key with the time it was decided, and marked
 * `audited_at` only once WorkOS took it. One that could not be sent stays
 * `audited_at IS NULL`, and the sweep sends it again (sweep 11, which also
 * runs before any decision may be deleted, RT-S8). The same function serves
 * the request that decided, the follow job and the sweep.
 *
 * Every key is an id, a code or a flag: never a sender, a subject, a file name
 * or an address (the trail outlives the scrub of a settled mail).
 */

import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import { recordAuditEventOrThrow } from '@/lib/audit/service'
import type { InboundMailDecisionRow } from '@/lib/db/schema'
import type { EndedFollow } from './repository'
import { findPartKinds, markDecisionsAudited } from './repository'

/** The metadata of one decision's line: ids, codes and the person's acknowledgements. Absent values are left out. */
export function decisionMetadata(
  decision: InboundMailDecisionRow,
  partKind: 'message' | 'attachment' | undefined,
): Record<string, string | boolean> {
  const optional: Record<string, string | null | undefined> = {
    partKind,
    threadAction: decision.threadAction,
    mailThreadId: decision.mailThreadId,
    documentType: decision.documentType,
    targetDocumentId: decision.targetDocumentId,
    followId: decision.followId,
    proposalId: decision.proposalId,
  }
  return {
    projectId: decision.projectId,
    decisionId: decision.id,
    partId: decision.partId,
    action: decision.action,
    via: decision.via,
    ...Object.fromEntries(Object.entries(optional).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    screeningRelease: decision.screeningRelease,
    acknowledgedSender: decision.acknowledgedSender,
    acknowledgedRisk: decision.acknowledgedRisk,
  }
}

/**
 * Send each decision to the trail and mark the ones it took. Never throws: a
 * line that failed stays owed for the sweep, and the decision itself stands.
 * Whether every line was taken.
 */
export async function auditDecisions(decisions: readonly InboundMailDecisionRow[]): Promise<boolean> {
  if (decisions.length === 0) return true
  const kinds = await findPartKinds(decisions.map((decision) => decision.partId)).catch(() => new Map<string, 'message' | 'attachment'>())
  const taken: string[] = []
  for (const decision of decisions) {
    try {
      await recordAuditEventOrThrow({
        action: 'inbound_mail.decided',
        organizationId: decision.organizationId,
        actor: { userId: decision.decidedBy },
        targetType: 'inbound_mail',
        targetId: decision.mailId,
        alsoTargets: [{ type: 'project', id: decision.projectId }],
        metadata: decisionMetadata(decision, kinds.get(decision.partId)),
        occurredAt: new Date(decision.decidedAt),
        idempotencyKey: `inbound_mail.decided:${decision.id}`,
      })
      taken.push(decision.id)
    } catch (error) {
      console.warn(`[inbound-mail] decision ${decision.id} is owed to the audit trail; the sweep sends it again`, error)
    }
  }
  try {
    await markDecisionsAudited(taken)
  } catch (error) {
    // Unmarked lines are sent again under the same key; WorkOS answers the repeat with the first event.
    console.warn('[inbound-mail] could not mark decisions audited; the sweep sends them again', error)
  }
  return taken.length === decisions.length
}

/**
 * The lines for the follows an address change ended (D31: replacing or
 * switching off the address ends every follow on the project), as the person
 * who changed it. After commit, best effort: the follow rows say it already.
 */
export function auditFollowsEnded(
  organizationId: string,
  projectId: string,
  endedBy: string,
  follows: readonly EndedFollow[],
): void {
  for (const follow of follows) {
    recordAuditEventAfterCommit({
      action: 'mail_thread.follow_ended',
      organizationId,
      actor: { userId: endedBy },
      targetType: 'mail_thread',
      targetId: follow.threadId,
      alsoTargets: [{ type: 'project', id: projectId }],
      metadata: { projectId, followId: follow.id, reason: 'address_rotated', followerUserId: follow.userId },
      idempotencyKey: `mail_thread.follow_ended:${follow.id}`,
    })
  }
}
