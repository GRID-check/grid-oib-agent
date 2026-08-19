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
 */

import { type FC } from 'react'
import { CornerDownRight, MessageCircleQuestion } from 'lucide-react'
import { SectionLabel } from '@/components/ui/section-label'
import { useChatStore } from '@/features/chat/store'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { FollowUpData } from '../schematics/types'

interface FollowUpsCardProps {
  title?: string | null
  items: FollowUpData[]
}

/**
 * The chip chrome, copied from the welcome chips so the two offers read as one
 * affordance: the reader who learnt on the empty canvas that a quiet hairline
 * chip fills the composer should not have to learn it twice.
 */
const CHIP = cn(
  'group inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border px-[13px]',
  // On a phone a chip is given a floor of 12rem and the row wraps, so each
  // question gets a line of its own: „Wie wird das Hauptgeschoß…" is still a
  // usable offer where „Wie…" is not. On desktop the chips size to their
  // content, because four of them fit across 636px and a set the eye takes in
  // at once is the whole affordance.
  'max-sm:min-w-[12rem] bg-card text-foreground/85 shadow-xs card-caption font-medium',
  'transition-colors duration-quick ease-out motion-reduce:transition-none',
  'hover:bg-accent hover:text-foreground',
  'focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-2',
  'pointer-coarse:h-11',
)

export const FollowUpsCard: FC<FollowUpsCardProps> = ({ title, items }) => {
  const t = useTranslations('chat')
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)
  // An empty set renders NOTHING — not an eyebrow over an empty row. An offer
  // with nothing in it is an unkept promise, and with no frame there is not
  // even a box left to explain the gap.
  const questions = items.filter((item) => Boolean(item?.question))

  if (questions.length === 0) return null

  return (
    <div className="mt-5 flex flex-col gap-2.5">
      <SectionLabel icon={MessageCircleQuestion}>{t('cards.followUps.eyebrow')}</SectionLabel>
      {title && <p className="card-title text-foreground">{title}</p>}

      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t('cards.followUps.groupAria')}
      >
        {questions.map((item, index) => (
          <button
            key={`${item.question}-${index}`}
            type="button"
            // The whole question in the tooltip, so nothing is lost to the
            // one-line truncation; the hint follows it rather than replacing it.
            title={item.hint ? `${item.question} — ${item.hint}` : item.question}
            onClick={() => setComposerPrefill(item.question)}
            className={CHIP}
          >
            <CornerDownRight
              className="text-subtle group-hover:text-foreground size-3.5 shrink-0 transition-colors duration-quick ease-out motion-reduce:transition-none"
              aria-hidden="true"
            />
            <span className="truncate">{item.question}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
