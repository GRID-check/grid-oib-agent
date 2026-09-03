'use client'

/**
 * KeyTakeawaysCard — „Das Wichtigste", the generic block that survives skimming.
 *
 * This is the card for an answer with no dimension in it and no fork in it,
 * where the alternative is a markdown bullet list: three discs of equal weight
 * that a reader has to read in full to find out which one is theirs.
 *
 * THE SHAPE (`docs/design/grid-card-charter.md` §A5: "ordinals in a descending
 * staircase"). The rows used to be separated by `divide-y` hairlines, which is
 * what made this a generic list — four cards in the set drew the same rules
 * around the same rows. Now the rank is drawn instead of ruled: the ordinals
 * hang off one continuous hairline while each takeaway steps 6px further right
 * than the one above it, so „most important first" is visible before a word is
 * read, and no other card in the set indents by rank.
 *
 * THE FIGURE (§A2). A card carries exactly one element above 14px and it must
 * be the card's answer. This card's answer is five things, so the figure is
 * spent on the FIRST — 15px/600 with a full-ink ordinal, everything below it at
 * Body. A reader who reads nothing else reads takeaway one, which is what
 * „most important first" is supposed to buy.
 *
 * A `detail` is a DISCLOSURE on its row, not a second line: it stays folded
 * until clicked, so the qualification (the derivation, the exception) survives
 * into the card instead of being cut for brevity, and the block stays four
 * lines tall for the reader who does not want it. That is purely presentational
 * state — a `useState` per row — never `useCardDecision`: opening a row changes
 * what this reader sees, it commits nothing and reaches no backend.
 *
 * A row with no `detail` is NOT a button. An expander that opens onto nothing
 * teaches the reader the chevrons are decorative, and then they stop clicking
 * the ones that are not.
 */

import { useState, type FC } from 'react'
import { ChevronDown, Highlighter } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { KeyTakeawayData } from '../schematics/types'
import { CARD_SHELL } from './card-chrome'

interface KeyTakeawaysCardProps {
  title?: string | null
  items: KeyTakeawayData[]
  /**
   * Render flat on the answer surface: the envelope's native `takeaways`
   * field is the answer's own closing block, so it gets the eyebrow and the
   * staircase but no ground and no frame. The framed default remains for
   * stored threads whose takeaways arrived as a card.
   */
  flat?: boolean
}

/** „01", „02" … — the ordinal in the gutter, so a rank is visible unread. */
const ordinal = (index: number): string => String(index + 1).padStart(2, '0')

/**
 * The staircase, written out rather than computed.
 *
 * Tailwind reads class names out of the source, so `pl-${n * 1.5}` would
 * produce a class that exists in the DOM and in no stylesheet. Five entries is
 * also the whole range — the schema caps `items` at 5 — and 24px of total
 * indent is what the charter budgeted for the narrow column: at 314px the
 * fifth takeaway still has ~250px of measure.
 */
const INDENT = ['pl-0', 'pl-1.5', 'pl-3', 'pl-4.5', 'pl-6'] as const
const indentFor = (index: number): string => INDENT[Math.min(index, INDENT.length - 1)]

/**
 * Shared row geometry: ordinal gutter, takeaway, chevron column.
 *
 * The 26px gutter is one of the two widths §A4 allows (22px for a rail, 26px
 * for a numbered node), so a takeaways card and a process map stacked in one
 * answer put their gutters on the same x. Here it is 8px of padding plus an
 * 18px ordinal column, hung off the list's own left hairline.
 */
const ROW = 'grid w-full grid-cols-[18px_minmax(0,1fr)_16px] items-start gap-2 py-2 pl-2 pr-1.5 text-left'

/** The ordinal + the takeaway itself — identical whether or not the row opens. */
const RowBody: FC<{ index: number; text: string }> = ({ index, text }) => {
  const isFigure = index === 0
  return (
    <>
      <span
        className={cn(
          'card-meta mt-1 font-mono',
          // Full ink on the first ordinal, 60% on the rest: the ordinals are a
          // scale and the first one is the top of it.
          isFigure ? 'text-foreground' : 'text-muted-foreground/60',
        )}
        aria-hidden="true"
      >
        {ordinal(index)}
      </span>
      <span
        className={cn(
          'min-w-0 text-pretty text-foreground',
          indentFor(index),
          // NEVER truncated — a takeaway is the payload, and a German compound
          // that wraps to two lines is still the answer.
          isFigure ? 'card-figure-15' : 'card-body',
        )}
      >
        {text}
      </span>
    </>
  )
}

const TakeawayRow: FC<{ item: KeyTakeawayData; index: number }> = ({ item, index }) => {
  const [open, setOpen] = useState(false)

  if (!item.detail) {
    return (
      <div className={ROW}>
        <RowBody index={index} text={item.text} />
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          ROW,
          'group rounded-md transition-colors duration-quick ease-out hover:bg-muted/50',
          'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
        )}
      >
        <RowBody index={index} text={item.text} />
        <ChevronDown
          className={cn(
            'mt-1 size-4 text-muted-foreground',
            'transition-transform duration-quick ease-out motion-reduce:transition-none',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </CollapsibleTrigger>

      <CollapsibleContent>
        {/* Indented to the takeaway's own text column and hung off a rule, so
            the detail reads as belonging to the row above rather than as a
            fifth takeaway. */}
        <p className="card-caption mb-2 ml-9 max-w-prose border-l-2 border-border pl-3 text-muted-foreground">
          {item.detail}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

export const KeyTakeawaysCard: FC<KeyTakeawaysCardProps> = ({ title, items, flat = false }) => {
  const t = useTranslations('chat')
  // An item with no `text` is skipped rather than rendered empty: every field
  // inside every array item reaches the renderer unvalidated (§0.5.1), and a
  // blank numbered row would claim the card has a takeaway it does not have.
  // Filtering BEFORE numbering keeps the ordinals contiguous — „01, 03" would
  // tell the reader something was withheld.
  const takeaways = items.filter((item) => Boolean(item?.text))

  if (takeaways.length === 0) return null

  const body = (
    <>
      <SectionLabel icon={Highlighter}>{t('cards.keyTakeaways.eyebrow')}</SectionLabel>
      {title && <p className="card-title text-foreground">{title}</p>}

      {/* One continuous hairline down the gutter, and no rules between rows:
          the rank is carried by the indent, not by a box per takeaway. */}
      <ol className="mt-0.5 flex flex-col border-l border-border/70">
        {takeaways.map((item, index) => (
          <li key={`${item.text}-${index}`}>
            <TakeawayRow item={item} index={index} />
          </li>
        ))}
      </ol>
    </>
  )

  if (flat) {
    return <div className="flex flex-col gap-2">{body}</div>
  }

  return <Card className={cn(CARD_SHELL, 'gap-2 p-5')}>{body}</Card>
}
