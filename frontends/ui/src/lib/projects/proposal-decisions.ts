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
import { formatBoundedDigest, type DigestLineItem } from '@/lib/knowledge/digest-format'

export const PROPOSAL_DECISIONS_HEADER = 'PROPOSAL_DECISIONS v1'
/** Messages scanned, newest first. Decisions are rare, so this reaches back far. */
const MESSAGE_SCAN_LIMIT = 40
/** Decisions kept, newest first. The next turn needs the recent ones, not the history. */
const MAX_DECISIONS = 10
/** Same order of size as one memory digest, so the two share the header budget. */
const MAX_CHARS = 900

type Decision = 'accepted' | 'rejected' | 'savedOrg' | 'savedProject' | 'dismissed'

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
    MAX_CHARS,
  )
}

/** The memory digest and the decisions block, as one header value. */
export function composeMemoryContext(digest: string | null, decisions: string | null): string | null {
  const parts = [digest, decisions].filter((part): part is string => Boolean(part && part.trim()))
  return parts.length > 0 ? parts.join('\n\n') : null
}
