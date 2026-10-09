'use client'

/**
 * FollowUpsRail — the questions this answer made askable, BELOW the answer.
 *
 * The product owner's ruling, in their words: the chips „should live below the
 * actual message and not in the message"
 * (`docs/architecture/post-answer-stages.md` §6). So this is not a card: it is
 * a sibling of the answer in the message column, outside the white answer
 * surface, sharing its edges and its full column width.
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
 *     4px rise, and never reflow anything above. ← this one.
 *
 * The third only works because the rail is the last element in the column, so
 * growing it moves nothing already read: the answer card, its provenance footer
 * and the meta row keep their positions to the pixel, and the only movement is
 * at the composer-ward end, which is where the reader's next action already is.
 *
 * That claim is load-bearing, so it is not left to this component to honour.
 * The conditions under which it is TRUE — nothing below the answer in the
 * thread, the answer no longer streaming, the reader not already typing — are
 * checked at arrival, where the turn's view is drawn into the thread
 * (`lib/turn-projection.ts`), and a stage that would break them is not drawn. A rail that were admitted and then hidden here would pop
 * in later, which is the defect itself.
 *
 * `FadeIn distance={4}` is the standard 4px rise on the entrance curve, and
 * reduced motion drops the rise (`<MotionConfig reducedMotion="user">`). No
 * `layout`: the rail is the last thing in the column, nothing beside it moves,
 * so a layout animation had only the rail's own box to glide, and it slid on
 * its own whenever anything above it changed height.
 *
 * ── What it must not read as ─────────────────────────────────────────────────
 *
 * A second answer. It sits outside the answer's surface with no frame of its
 * own, at the muted weight of the eyebrow — an offer at the end of a column,
 * not another block of content to read.
 */

import { type FC, useMemo } from 'react'
import { PenLine } from 'lucide-react'
import { FadeIn } from '@/components/motion'
import {
  FollowUpChips,
  usableFollowUps,
  type FollowUpAction,
} from '@/features/grid-cards/components/FollowUpChips'
import { useTranslations } from '@/i18n'
import type { StoredFollowUp } from '@/lib/conversations/message-stages'

/** No stage output yet, as one array rather than a new `[]` per render. */
const NO_ITEMS: StoredFollowUp[] = []

interface FollowUpsRailProps {
  /** The stage's questions; absent while only the Aktenvermerk chip is offered. */
  items?: StoredFollowUp[]
  /**
   * Offer „Als Aktenvermerk schreiben" beside the questions (ledger 23). The
   * CONDITION is decided by the caller through
   * `features/chat/lib/aktenvermerk-chip`, because it depends on the turn (its
   * answer kind, its project, the length of its body) and this component is
   * handed one message's worth of chips; the COPY is decided here, because it
   * is chat copy and this is the chat feature.
   */
  offerAktenvermerk?: boolean
  /**
   * Whether the rail arrives with its entrance. Only a rail that lands under
   * a reader who is already reading earns one; on a restored or reopened
   * thread it is simply there, and a fade on every open replayed an arrival
   * that happened days ago. The caller knows which (`ChatArea`, from its
   * hydration bookkeeping).
   */
  animateIn?: boolean
}

export const FollowUpsRail: FC<FollowUpsRailProps> = ({
  items = NO_ITEMS,
  offerAktenvermerk = false,
  animateIn = true,
}) => {
  const t = useTranslations('chat')
  const actions = useMemo<FollowUpAction[]>(
    () =>
      offerAktenvermerk
        ? [
            {
              key: 'aktenvermerk',
              label: t('cards.followUps.aktenvermerk'),
              // The label is the offer; this is the ask. A chip that typed its
              // own label would send „Als Aktenvermerk schreiben" as a message,
              // which is a fragment and not a request.
              prefill: t('cards.followUps.aktenvermerkPrefill'),
              icon: PenLine,
            },
          ]
        : [],
    [offerAktenvermerk, t]
  )

  // Checked HERE and not left to `FollowUpChips`, which would return null from
  // inside a wrapper that still exists: in the message column an empty wrapper
  // contributes the column's `gap-4` all the same, which is a 16px hole under
  // an answer that has nothing to offer — exactly the reserved space §8 refused.
  if (usableFollowUps(items).length === 0 && actions.length === 0) return null

  // `w-full` here and no wrapper in the caller: an empty wrapper around a
  // rail that decided to render nothing still took the column's gap.
  return (
    <FadeIn
      distance={4}
      className="w-full"
      data-testid="follow-ups-rail"
      {...(animateIn ? {} : { initial: false as const })}
    >
      {/* No `mt-5`: inside the message column the parent's `gap-4` is the air,
          and a second margin would put the rail further from its answer than the
          answer is from the question. */}
      <FollowUpChips items={items} actions={actions} />
    </FadeIn>
  )
}
