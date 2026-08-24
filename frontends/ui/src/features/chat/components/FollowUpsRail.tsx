'use client'

/**
 * FollowUpsRail — the questions this answer made askable, BELOW the answer.
 *
 * The product owner's ruling, in their words: the chips „should live below the
 * actual message and not in the message"
 * (`docs/architecture/post-answer-stages.md` §6). So this is not a card: it is
 * a sibling of the answer in the message column, outside the white answer
 * surface, sharing its left edge and its 680px width.
 *
 * ── Why it may simply appear ─────────────────────────────────────────────────
 *
 * A stage computes this AFTER the answer is delivered, so it lands two to six
 * seconds later, under a reader who is already reading. A block that appears
 * under someone's eyes and pushes the page is its own defect, and there were
 * three candidate answers (§8):
 *
 *   • Reserve the space — leaves a visible hole under every answer for the
 *     turns the gate skips, and reserving the minimum still jumps.
 *   • No treatment — content popping in at 2–6s is the thing being avoided.
 *   • Reserve NOTHING, append below the last element, enter with opacity and a
 *     6px rise, and never reflow anything above. ← this one.
 *
 * The third only works because the rail is the last element in the column, so
 * growing it moves nothing already read: the answer card, its provenance footer
 * and the meta row keep their positions to the pixel, and the only movement is
 * at the composer-ward end, which is where the reader's next action already is.
 *
 * That claim is load-bearing, so it is not left to this component to honour.
 * The conditions under which it is TRUE — nothing below the answer in the
 * thread, the answer no longer streaming, the reader not already typing — are
 * checked at arrival, in `applyStageFrame`, where a frame that would break them
 * is refused outright. A rail that were admitted and then hidden here would pop
 * in later, which is the defect itself.
 *
 * `FadeIn distance={6}` is the same entrance every card already uses, and
 * reduced motion is handled globally by `<MotionConfig reducedMotion="user">`.
 *
 * ── What it must not read as ─────────────────────────────────────────────────
 *
 * A second answer. It sits outside the answer's surface with no frame of its
 * own, at the muted weight of the eyebrow — an offer at the end of a column,
 * not another block of content to read.
 */

import { type FC } from 'react'
import { FadeIn } from '@/components/motion'
import { FollowUpChips, usableFollowUps } from '@/features/grid-cards/components/FollowUpChips'
import type { StoredFollowUp } from '@/lib/conversations/message-stages'

interface FollowUpsRailProps {
  items: StoredFollowUp[]
}

export const FollowUpsRail: FC<FollowUpsRailProps> = ({ items }) => {
  // Checked HERE and not left to `FollowUpChips`, which would return null from
  // inside a wrapper that still exists: in the message column an empty wrapper
  // contributes the column's `gap-4` all the same, which is a 16px hole under
  // an answer that has nothing to offer — exactly the reserved space §8 refused.
  if (usableFollowUps(items).length === 0) return null

  return (
    <FadeIn distance={6} data-testid="follow-ups-rail">
      {/* No `mt-5`: inside the message column the parent's `gap-4` is the air,
          and a second margin would put the rail further from its answer than the
          answer is from the question. */}
      <FollowUpChips items={items} />
    </FadeIn>
  )
}
