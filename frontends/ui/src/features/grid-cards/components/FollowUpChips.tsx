'use client'

/**
 * The follow-up chips themselves — the one presentation shared by the two
 * places follow-ups are rendered.
 *
 * There are two, and they are not a duplication: `FollowUpsCard` renders the
 * chips a model EMITTED inside an answer (a card, placed among the answer's
 * other cards, stored in `metadata.cards`), and `FollowUpsRail` renders the
 * chips a post-answer STAGE computed after the answer landed
 * (`docs/architecture/post-answer-stages.md` §6). Old threads keep the first
 * form forever (§7.10: retire, never delete), so both must render — and they
 * must render IDENTICALLY, because a reader scrolling a thread that spans the
 * migration should see one affordance, not two.
 *
 * Only the wrapper differs: the card owns its own 20px of air (`mt-5`) because
 * it is a trailing block inside the answer surface; the rail takes the message
 * column's own `gap-4` and adds nothing.
 *
 * Everything below is the original card body, moved and not rewritten: the chip
 * chrome copied from the welcome chips, the one-line truncation with the whole
 * question in `title`, and `setComposerPrefill` on click and nothing else.
 */

import { type FC } from 'react'
import { CornerDownRight, MessageCircleQuestion } from 'lucide-react'
import { SectionLabel } from '@/components/ui/section-label'
import { useChatStore } from '@/features/chat/store'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { FollowUpData } from '../schematics/types'

interface FollowUpChipsProps {
  title?: string | null
  items: FollowUpData[]
  /** Wrapper-level spacing owned by the caller — the block's own air. */
  className?: string
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

/**
 * The questions worth offering. Exported because a CALLER may have to know
 * whether there are any before it renders a wrapper: in the message column the
 * rail's wrapper would contribute the column's `gap-4` even while rendering
 * nothing, which is a 16px hole under the answer for a turn with no chips.
 */
export const usableFollowUps = (items: FollowUpData[]): FollowUpData[] =>
  items.filter((item) => Boolean(item?.question))

export const FollowUpChips: FC<FollowUpChipsProps> = ({ title, items, className }) => {
  const t = useTranslations('chat')
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)
  // An empty set renders NOTHING — not an eyebrow over an empty row. An offer
  // with nothing in it is an unkept promise, and with no frame there is not
  // even a box left to explain the gap.
  const questions = usableFollowUps(items)

  if (questions.length === 0) return null

  return (
    <div className={cn('flex flex-col gap-2.5', className)}>
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
