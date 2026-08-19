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
 */

import { type FC } from 'react'
import { CornerDownRight, MessageCircleQuestion } from 'lucide-react'
import { Card } from '@/components/ui/card'
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
  'bg-card text-foreground/85 shadow-xs text-xs font-medium',
  'transition-colors duration-quick ease-out motion-reduce:transition-none',
  'hover:bg-accent hover:text-foreground',
  'focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-2',
  'pointer-coarse:h-11',
)

export const FollowUpsCard: FC<FollowUpsCardProps> = ({ title, items }) => {
  const t = useTranslations('chat')
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)

  return (
    <Card className="animate-in fade-in-0 slide-in-from-bottom-1 gap-2.5 p-5 shadow-xs">
      <SectionLabel icon={MessageCircleQuestion}>{t('cards.followUps.eyebrow')}</SectionLabel>
      {title && <p className="text-sm font-semibold text-foreground">{title}</p>}

      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t('cards.followUps.groupAria')}
      >
        {items.map((item, index) => (
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
    </Card>
  )
}
