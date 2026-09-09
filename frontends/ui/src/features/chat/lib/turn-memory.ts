/**
 * What Piloti recorded DURING ONE TURN — the input to the „Piloti hat sich
 * gemerkt" chip (`docs/architecture/post-answer-stages.md` §1.1, §1.7, §5.1).
 *
 * Three things write project memory and only one of them is the post-answer
 * stage. Two of them reach the reader here, and the chip labels them apart:
 *
 * 1. **In-turn.** The `remember` tool, called by the model while it answers.
 *    When the write needs the user's own authority it arrives as a
 *    `memory_proposal` card, and it is a memory only once they say yes — which
 *    is why the decision, not the card, is what admits it here.
 * 2. **After the answer.** The `memory_reflection` stage, whose frame lands on
 *    `message.stages.memoryReflection` (`provenance_type = 'distillation'` on
 *    the row it wrote).
 *
 * Both are read off the MESSAGE, which is the whole point. Until this existed
 * the chip was fed by `useConversationMemory`, a three-shot HTTP poll on a
 * `[0, 1500, 4000]` ms schedule — a guess about how long an LLM takes, made by
 * the half of the system that cannot know, and mounted once per rendered
 * answer, so a ten-answer thread fired thirty GETs for one conversation's
 * memory. Worse, what came back was scoped to the CONVERSATION, so after turn
 * five, turn one's answer also read „Piloti hat sich 5 gemerkt". A memory row
 * has never had a turn identity (§1.6); the stage frame gives it one, and this
 * module is where a turn's memory finally means the turn's.
 *
 * A pure module with its own fast spec, not logic inside the render function —
 * `src/features/chat/lib/` is where this codebase puts the part that can be
 * tested in a millisecond instead of a mount (AGENTS.md).
 *
 * **What is deliberately NOT here:** a project-scoped in-turn `remember` write
 * that succeeded on its own, with no card. It writes a `project_memory` row
 * carrying only `source_conversation_id`, so it cannot be attributed to a turn
 * by anything the browser holds — a per-turn surface cannot render it honestly,
 * and the old chip only appeared to by showing the whole conversation's memory
 * against every answer. Those rows live in the project memory panel, which is
 * where they are curated. See §11.3 for the change that would give them a turn.
 */

import type { GridCard } from '@/shared/cards/schemas'
import { cardKey, type CardInteractions } from '@/features/grid-cards/card-decision'
import type { MessageStages } from '@/lib/conversations/message-stages'

/**
 * Where a remembered item came from. Not the raw `provenance_type` of the row:
 * the reader is being told WHEN it happened relative to the answer they are
 * looking at, which is the only distinction the chip draws.
 */
export type TurnMemoryProvenance =
  /** The post-answer reflection stage — „nach der Antwort ergänzt". */
  | 'distillation'
  /** The `remember` tool, mid-answer — „während der Antwort notiert". */
  | 'inTurn'

/** One thing Piloti recorded during this turn, as the chip renders it. */
export interface TurnMemoryItem {
  /** Stable within the turn: a row id, or the card key that produced it. */
  id: string
  /** `decision` | `constraint` | `open_question` | `derived_fact` | `preference`. */
  kind: string
  /** The finding itself, shown verbatim. */
  content: string
  provenance: TurnMemoryProvenance
  /**
   * The note this one RETIRED, when the write was a correction (ADR-0055, C5).
   *
   * Read defensively off the stage payload rather than required of it: the
   * stored stage is the BFF's shape, and a build whose backend does not yet
   * carry the field simply renders no supersession notice — which is the
   * behaviour that existed before, not a new failure.
   *
   * **The producer half is `StoredMemoryItem`** in
   * `lib/conversations/message-stages.ts`, whose key set is deliberately CLOSED
   * — an unknown key is dropped on write. So until `supersedes` is declared and
   * sanitised there, this field never arrives and `MemorySupersededNotices`
   * renders nothing. The memory panel shows the same correction regardless; it
   * is only the transcript half that waits on that declaration.
   */
  supersedes?: { id: string; content: string }
}

/**
 * A stored reflection item, plus the supersession the write path records.
 *
 * `StoredMemoryItem` is owned by the persistence layer and carries the three
 * fields the chip has always needed. The supersession rides alongside it, so
 * this widening is where the optional field is READ — never a second copy of
 * the stored shape.
 */
type ReflectionItem = {
  id: string
  kind: string
  content: string
  supersedes?: { id: string; content: string } | null
}

/**
 * The card decisions that mean a memory was actually WRITTEN.
 *
 * A `memory_proposal` card is a question, and its own tool result says so in as
 * many words: "It has NOT been saved yet — do not claim it was saved; the user
 * decides." Counting an undecided or dismissed one as something Piloti
 * remembered would make the chip lie in the direction that matters most, since
 * its entire job is to tell a reader what is now durable about their project.
 */
const SAVED: ReadonlySet<string> = new Set(['savedOrg', 'savedProject'])

/**
 * One `memory_proposal` this turn OFFERED, from either producer.
 *
 * A proposal is a question and stays one all the way to the reader: it is never
 * folded into {@link TurnMemoryItem}, which is the list of things that were
 * actually written. Rendering an offer as a write would claim a firm-wide note
 * that nobody made — the failure ADR-0055's own wire contract calls out.
 */
export interface TurnMemoryProposal {
  /** The key its persisted decision is stored under on the message. */
  key: string
  card: MemoryProposalCard
  /**
   * WHEN the offer was made. The card reads the same either way; this exists
   * because the two producers are two different promises, exactly as the chip
   * already labels an in-turn write apart from a post-answer one.
   */
  origin: TurnMemoryProvenance
}

/** The one card type this module deals in. */
type MemoryProposalCard = Extract<GridCard, { type: 'memory_proposal' }>

/**
 * Identity of an offer, for the merge below.
 *
 * The CONTENT, normalized, because that is what the two producers share: a
 * finding proposed mid-answer and re-proposed by the reflection pass is one
 * offer told twice, and the ids are minted independently on each side so they
 * cannot say so. Same normalization the memory write path uses — case, and
 * runs of anything that is not a letter or digit.
 */
const proposalIdentity = (card: MemoryProposalCard): string =>
  card.content.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Key for a proposal the post-answer stage made.
 *
 * Deliberately outside `cardKey`'s namespace (`<type>-<index>`), because these
 * are NOT slots in the turn's card array: minting `memory_proposal-3` for one
 * would collide with the answer's own fourth card the moment the model emits
 * one, and a decision would then be attributed to a card the reader never saw.
 * The index is the position within the stage's own list, which is fixed once
 * the frame has landed.
 */
const stageProposalKey = (index: number): string => `stage:memory_proposal-${index}`

/**
 * Every proposal this turn offered — the answer's own cards first, then the
 * ones the post-answer reflection added, deduped by content.
 *
 * The turn's card WINS a collision: it was on screen first, and it is the one
 * that already holds the reader's decision. A stage proposal that repeats it is
 * dropped rather than stacked, so a reader is never asked the same question
 * twice with two different answers possible.
 */
export function turnMemoryProposals({
  stages,
  cards,
}: Pick<TurnMemoryInput, 'stages' | 'cards'>): TurnMemoryProposal[] {
  const out: TurnMemoryProposal[] = []
  const seen = new Set<string>()

  for (const [index, card] of (cards ?? []).entries()) {
    if (!card || card.type !== 'memory_proposal') continue
    seen.add(proposalIdentity(card))
    out.push({ key: cardKey(card, index), card, origin: 'inTurn' })
  }

  for (const [index, card] of (stages?.memoryReflection?.proposals ?? []).entries()) {
    const identity = proposalIdentity(card)
    if (seen.has(identity)) continue
    seen.add(identity)
    out.push({ key: stageProposalKey(index), card, origin: 'distillation' })
  }

  return out
}

interface TurnMemoryInput {
  /** Post-answer stage output on this message. */
  stages?: MessageStages
  /** The cards this answer carried, in the order they were emitted. */
  cards?: (GridCard | undefined)[]
  /** The reader's answer to each interactive card, keyed by `cardKey`. */
  cardInteractions?: CardInteractions
}

/**
 * Everything this turn recorded, in-turn writes first.
 *
 * Order is deliberate and chronological: the `remember` tool ran while the
 * answer was being written, the reflection stage ran after it was finished. The
 * chip's popover is a list of what happened, so it reads in the order it
 * happened.
 */
export function turnMemoryItems({ stages, cards, cardInteractions }: TurnMemoryInput): TurnMemoryItem[] {
  const items: TurnMemoryItem[] = []

  // Every offer this turn made, from both producers, so a proposal the
  // reflection pass added after the answer becomes a recorded finding on the
  // same terms as one the `remember` tool made during it. A hole in the card
  // array is a card validation rejected (`validateGridCards` keeps wire
  // positions) and never reaches here.
  for (const proposal of turnMemoryProposals({ stages, cards })) {
    if (!SAVED.has(cardInteractions?.[proposal.key]?.decision ?? '')) continue
    items.push({
      id: proposal.key,
      kind: proposal.card.kind,
      content: proposal.card.content,
      provenance: proposal.origin,
    })
  }

  for (const item of (stages?.memoryReflection?.items ?? []) as ReflectionItem[]) {
    items.push({
      id: item.id,
      kind: item.kind,
      content: item.content,
      provenance: 'distillation',
      // A correction is a fact about THIS turn, so it travels with the item
      // rather than being fetched back out of the panel.
      ...(item.supersedes ? { supersedes: item.supersedes } : {}),
    })
  }

  return items
}
