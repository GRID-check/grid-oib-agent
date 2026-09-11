/**
 * What the project decided about the agent's own proposals.
 *
 * A `project_profile_patch` or `memory_proposal` card is a proposal; the
 * reader's Accept or Reject is recorded on the message (ADR-0030) and, until
 * this existed, nowhere the agent could read. So a declined patch came back
 * next turn, and the assistant read as not listening — the user's decision
 * was durable and invisible to the thing that made the proposal (ADR-0030's
 * own last open question).
 *
 * This renders those decisions as a bounded block that rides the memory
 * digest channel (`x-grid-project-memory` and the live per-turn fetch), so it
 * needed no new header and reaches every surface memory reaches, including a
 * background run. The prompt explains the block once, in the same place it
 * explains PROJECT_MEMORY.
 */

import 'server-only'
import { listRecentMessagesWithCardDecisions } from '@/lib/conversations/repository'
import {
  DIGEST_BLOCK_MAX_CHARS,
  formatBoundedDigest,
  type DigestLineItem,
} from '@/lib/knowledge/digest-format'

export const PROPOSAL_DECISIONS_HEADER = 'PROPOSAL_DECISIONS v1'
/** Messages scanned, newest first. Decisions are rare, so this reaches back far. */
const MESSAGE_SCAN_LIMIT = 40
/** Decisions kept, newest first. The next turn needs the recent ones, not the history. */
const MAX_DECISIONS = 10

type Decision =
  | 'accepted'
  | 'rejected'
  | 'savedOrg'
  | 'savedProject'
  | 'dismissed'
  | 'partiallyApplied'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** The verdict tag the model reads: a decision is either for or against. */
function verdictOf(decision: string): 'angenommen' | 'abgelehnt' | null {
  switch (decision as Decision) {
    case 'accepted':
    case 'savedOrg':
    case 'savedProject':
    // A partial application is a YES. What failed is a transport fact the next
    // turn cannot act on and the reader can see in the Files pane; what the
    // agent must not do is propose the same tidy-up again because some of it
    // did not land.
    case 'partiallyApplied':
      return 'angenommen'
    case 'rejected':
    case 'dismissed':
      return 'abgelehnt'
    default:
      return null
  }
}

/** One line of content for a card: what was proposed, in the card's own words. */
function describeCard(card: Record<string, unknown>): { kind: string; content: string } | null {
  const type = asString(card.type)
  if (type === 'project_profile_patch') {
    const title = asString(card.title) ?? 'Projektkontext aktualisieren'
    const preview = Array.isArray(card.preview) ? card.preview : []
    const changes = preview
      .filter(isRecord)
      .map((item) => {
        const label = asString(item.label)
        const before = asString(item.before)
        const after = asString(item.after)
        if (!label || !after) return null
        return before ? `${label}: ${before} → ${after}` : `${label}: ${after}`
      })
      .filter((change): change is string => change !== null)
      .slice(0, 3)
    return { kind: 'Profil', content: changes.length > 0 ? `${title} (${changes.join('; ')})` : title }
  }
  if (type === 'memory_proposal') {
    const content = asString(card.content)
    return content ? { kind: 'Notiz', content } : null
  }
  if (type === 'file_operation_proposal') {
    // The decision, in the words the card showed: the verb and what it named.
    // Enough for the next turn to know it must not propose this again — and
    // deliberately not the whole payload, which would spend the block's budget
    // on rows nobody will act on.
    const title = asString(card.title)
    const operation = asString(card.operation)
    const rows = Array.isArray(card.operations) ? card.operations : []
    const subjects = rows
      .filter(isRecord)
      .map((row) => asString(row.document) ?? asString(row.folder_name))
      .filter((subject): subject is string => subject !== undefined)
      .slice(0, 3)
    if (!title && !operation) return null
    const named = subjects.length > 0 ? ` (${subjects.join('; ')})` : ''
    return { kind: 'Ablage', content: `${title ?? operation}${named}` }
  }
  return null
}

interface DecidedProposal {
  decidedAt: string
  item: DigestLineItem
}

/** The decisions one stored message carries, paired with the cards they were about. */
function decisionsOf(metadata: unknown, fallbackDate: Date): DecidedProposal[] {
  if (!isRecord(metadata) || !isRecord(metadata.cardInteractions)) return []
  const cards = Array.isArray(metadata.cards) ? metadata.cards : []
  const out: DecidedProposal[] = []
  for (const [key, interaction] of Object.entries(metadata.cardInteractions)) {
    if (!isRecord(interaction)) continue
    const decision = asString(interaction.decision)
    const verdict = decision ? verdictOf(decision) : null
    if (!verdict) continue
    // The key is `${type}-${index}`; the index is positional into `cards`.
    // Positions stay aligned with what the reader saw: `validateGridCards`
    // never compacts the array, so the validated card at `index` is the same
    // proposal this raw row holds at `index` — or a hole, which is skipped
    // below like any other non-record.
    const index = Number(key.slice(key.lastIndexOf('-') + 1))
    const card = Number.isInteger(index) ? cards[index] : undefined
    if (!isRecord(card)) continue
    const described = describeCard(card)
    if (!described) continue
    const decidedAt = asString(interaction.decidedAt) ?? fallbackDate.toISOString()
    out.push({
      decidedAt,
      item: { tags: [verdict, described.kind, decidedAt.slice(0, 10)], content: described.content },
    })
  }
  return out
}

/**
 * The block, or null when the project has decided nothing yet — callers omit
 * it rather than injecting a bare header, exactly as the memory digest does.
 */
export async function buildProposalDecisionsBlock(
  projectId: string,
  organizationId: string,
): Promise<string | null> {
  const rows = await listRecentMessagesWithCardDecisions(projectId, organizationId, MESSAGE_SCAN_LIMIT)
  const decided = rows
    .flatMap((row) => decisionsOf(row.metadata, row.createdAt))
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : 0))
    .slice(0, MAX_DECISIONS)
  return formatBoundedDigest(
    PROPOSAL_DECISIONS_HEADER,
    decided.map((entry) => entry.item),
    DIGEST_BLOCK_MAX_CHARS,
  )
}

/**
 * The memory channel, as one header value: the digest, what the project decided
 * about the agent's own proposals, and what a reviewer decided about the drafts
 * this conversation filed (`lib/documents/review-decisions.ts`).
 *
 * Three blocks on one channel rather than three headers, for the reason the
 * second one is here at all: `x-grid-project-memory` already reaches every
 * surface memory reaches — the WS upgrade, the live per-turn digest fetch and a
 * background run — and a new header would have to be added to each of them and
 * to the envelope's TS/Python twins. Each block is bounded on its own and each
 * is null when it has nothing to say, so a turn with no decisions carries
 * exactly what it carried before.
 */
export function composeMemoryContext(
  digest: string | null,
  decisions: string | null,
  reviewDecisions: string | null = null,
): string | null {
  const parts = [digest, decisions, reviewDecisions].filter((part): part is string =>
    Boolean(part && part.trim()),
  )
  return parts.length > 0 ? parts.join('\n\n') : null
}
