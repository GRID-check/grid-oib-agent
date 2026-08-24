'use client'

/**
 * FollowUpsCard — the two to four questions this answer just made askable.
 *
 * The reader who has only now learnt what a Fluchtniveau is has a next
 * question and no phrasing for it, and phrasing it is most of the work. So the
 * card is chips, not a list: one click and the question is IN the composer,
 * where the reader edits it or presses send. Clicking sends nothing and calls
 * nothing — „nicht zurück zum LLM … ich klick das und sehe mehr". A chip that
 * fired a turn on its own would be a different (and much more expensive)
 * promise than the one its appearance makes.
 *
 * The prefill pipe is the SAME one the welcome chips use
 * (`layout/components/ChatArea.tsx`): `setComposerPrefill(question)` queues the
 * text on the chat store, and `InputArea` consumes it once — filling the draft,
 * focusing the textarea and putting the caret at the end. Focus is therefore
 * not this card's job, and a second mechanism here would be a second set of
 * rules about what happens when the composer already holds the user's own text
 * (it wins; the prefill is dropped).
 *
 * `presentational` in CARD_INTERACTIVITY: a click writes nothing anywhere and
 * commits the user to nothing, so there is no decision to persist (ADR-0030) —
 * the store write is a queued draft, and the user can simply not send it.
 *
 * Each chip stays ONE line. A question that wraps into three lines stops being
 * a chip and becomes a paragraph with a border, and four of those are a wall
 * the reader has to read; truncated with the whole question in the `title`, the
 * set can still be taken in at a glance. The optional `hint` rides in that same
 * tooltip rather than as a second line, for the same reason.
 *
 * NO FRAME (`docs/design/grid-card-charter.md` §A1 flat register, §B1). This
 * card closes every subject-matter answer by default, so its box is seen more
 * often than any other box in the product — and a large share of the
 * "everything is a card" feeling is this one frame, seen a hundred times. The
 * chips already carry their own border and shadow; a bordered card around them
 * is a card inside a card's worth of chrome for content that is not evidence at
 * all. Which is the second reason: this is the one card that must never be
 * screenshotted into an Einreichung, and being the only unframed trailing block
 * says so before anyone reads it.
 *
 * `mt-5` is the block's own 20px of air. The trailing offer stands away from
 * the evidence above it — that separation is doing the work the border used to
 * do, and it is the only thing this card has instead.
 *
 * The chips themselves live in `FollowUpChips`, because a post-answer STAGE now
 * renders the same offer BELOW the answer (`FollowUpsRail`,
 * `docs/architecture/post-answer-stages.md` §6). This card is the form stored
 * threads keep forever — retired, never deleted (§7.10) — so the two must never
 * drift apart: a reader scrolling across the migration should see one
 * affordance, in two places, not two affordances.
 */

import { type FC } from 'react'
import { FollowUpChips } from './FollowUpChips'
import type { FollowUpData } from '../schematics/types'

interface FollowUpsCardProps {
  title?: string | null
  items: FollowUpData[]
}

export const FollowUpsCard: FC<FollowUpsCardProps> = ({ title, items }) => (
  <FollowUpChips title={title} items={items} className="mt-5" />
)
