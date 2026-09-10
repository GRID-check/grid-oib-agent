import 'server-only'
/**
 * What a reviewer decided about the drafts THIS conversation filed.
 *
 * ## The gap this closes
 *
 * A chat turn writes an Aktenvermerk, `file_draft` files it, `submit_draft`
 * sends it for review, and a Ziviltechniker presses „Änderungen anfordern" with
 * three sentences of what is wrong. Those sentences reached the Files pane, the
 * inbox item and the audit trail — and never reached the one place that could
 * act on them, which is the next turn of the conversation that wrote the draft.
 * The reader then had to retype the reviewer's comment at the agent that had
 * just been told it.
 *
 * This is the `PROPOSAL_DECISIONS` pattern applied one level up, deliberately
 * and in the same shape: a bounded block, the decision quoted VERBATIM, riding
 * the memory channel (`x-grid-project-memory` and the live per-turn digest
 * fetch) so it needed no new header and reaches every surface memory reaches.
 * `composeMemoryContext` is where the two are joined.
 *
 * ## Why it is scoped to the conversation and not to the project
 *
 * Because a decision about a draft is an instruction to whoever wrote it. Two
 * conversations in one project write two different documents, and pouring one
 * thread's review comments into the other's prompt would tell the second turn to
 * revise a document it has never seen. The scope is `origin_conversation_id`
 * (migration 0084), which the internal filing route stamps from the VERIFIED
 * envelope — so a version's origin is a fact this tier asserted, not one a
 * caller chose.
 *
 * A version whose origin is NOT a conversation gets nothing from here, and that
 * is the other half of the design: unattended work (a scheduled report, a
 * revision the reviewer delegated) has nobody typing, so its decision becomes a
 * `revision` task instead. See the `openRevisionTask` effect in `./lifecycle`.
 */

import { formatBoundedDigest, type DigestLineItem } from '@/lib/knowledge/digest-format'
import { resolvePeople } from '@/lib/sharing/directory'
import { listRefusedVersionsForConversation } from './version-repository'

/** The block's header, versioned like the memory channel's. */
export const REVIEW_DECISIONS_HEADER = 'REVIEW_DECISIONS v1'

/**
 * Decisions carried, newest first. A conversation that has had four drafts sent
 * back does not need the fifth in its prompt: the ones that are still open are
 * the recent ones, and the older lines would spend a shared budget on work that
 * has moved on.
 */
export const MAX_REVIEW_DECISIONS = 5

/** Same order of size as one memory digest, so the three share the channel. */
const MAX_CHARS = 900

/** The verdict word the model reads. The two refusing states differ in finality. */
const VERDICT: Record<string, string> = {
  changes_requested: 'Änderungen angefordert',
  rejected: 'abgelehnt',
}

/**
 * The block, or null when this conversation has had nothing sent back —
 * callers omit it rather than injecting a bare header, exactly as the memory
 * digest and the proposal decisions do.
 *
 * The reviewer's name is resolved through `resolvePeople`, the one place this
 * tier turns a user id into a name, so the block and the share roster cannot
 * disagree about what somebody is called. An id the directory cannot resolve
 * yields no name rather than a raw `user_01…` at an architect.
 */
export async function buildReviewDecisionsBlock(
  conversationId: string,
  organizationId: string,
): Promise<string | null> {
  const rows = await listRefusedVersionsForConversation(
    conversationId,
    organizationId,
    MAX_REVIEW_DECISIONS,
  )
  if (rows.length === 0) return null

  const reviewerIds = [...new Set(rows.map((row) => row.reviewedBy).filter((id): id is string => Boolean(id)))]
  // Returns an empty map for an empty list, so no guard is needed here.
  const people = await resolvePeople(organizationId, reviewerIds)

  const items: DigestLineItem[] = rows.map((row) => {
    const who = row.reviewedBy ? people.get(row.reviewedBy)?.name : undefined
    const when = row.reviewedAt ? row.reviewedAt.toISOString().slice(0, 10) : undefined
    const title = row.displayName?.trim() || row.filename
    return {
      tags: [
        VERDICT[row.state] ?? row.state,
        title,
        `v${row.versionNumber}`,
        ...(who ? [who] : []),
        ...(when ? [when] : []),
      ],
      // Verbatim. The instruction around the block is meta and says what a
      // decision IS; the words inside it are the reviewer's own and are never
      // paraphrased — a summarised objection is an objection somebody else made.
      content: row.reviewComment,
    }
  })

  return formatBoundedDigest(REVIEW_DECISIONS_HEADER, items, MAX_CHARS)
}
