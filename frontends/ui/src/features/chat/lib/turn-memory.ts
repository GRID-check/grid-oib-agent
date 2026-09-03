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

  for (const [index, card] of (cards ?? []).entries()) {
    // A hole is a card validation rejected (`validateGridCards` keeps wire
    // positions): nothing to attribute a memory write to.
    if (!card || card.type !== 'memory_proposal') continue
    const key = cardKey(card, index)
    if (!SAVED.has(cardInteractions?.[key]?.decision ?? '')) continue
    items.push({ id: key, kind: card.kind, content: card.content, provenance: 'inTurn' })
  }

  for (const item of stages?.memoryReflection?.items ?? []) {
    items.push({ ...item, provenance: 'distillation' })
  }

  return items
}
