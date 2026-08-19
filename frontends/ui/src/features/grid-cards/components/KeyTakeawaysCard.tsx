'use client'

/**
 * KeyTakeawaysCard — „Das Wichtigste", the generic block that survives skimming.
 *
 * This is the card for an answer with no dimension in it and no fork in it,
 * where the alternative is a markdown bullet list: three discs of equal weight
 * that a reader has to read in full to find out which one is theirs. Here each
 * takeaway is a numbered row on its own rule, so the block has a reading order
 * and a scan order at the same time — the numeral says how many there are and
 * where you are, without the reader counting.
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

interface KeyTakeawaysCardProps {
  title?: string | null
  items: KeyTakeawayData[]
}

/** „01", „02" … — the ordinal in the gutter, so a rank is visible unread. */
const ordinal = (index: number): string => String(index + 1).padStart(2, '0')

/** Shared row geometry: ordinal gutter, takeaway, chevron column. */
const ROW = 'grid w-full grid-cols-[26px_minmax(0,1fr)_16px] items-start gap-2 px-1.5 py-2.5 text-left'

/** The ordinal + the takeaway itself — identical whether or not the row opens. */
const RowBody: FC<{ index: number; text: string }> = ({ index, text }) => (
  <>
    <span className="mt-[3px] font-mono text-[11px] tabular-nums text-muted-foreground" aria-hidden="true">
      {ordinal(index)}
    </span>
    <span className="min-w-0 text-[13.5px] font-medium leading-[1.55] text-foreground">{text}</span>
  </>
)

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

      <CollapsibleContent className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
        {/* Indented to the takeaway's own text column and hung off a rule, so
            the detail reads as belonging to the row above rather than as a
            fifth takeaway. */}
        <p className="mb-2.5 ml-10 max-w-prose border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
          {item.detail}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

export const KeyTakeawaysCard: FC<KeyTakeawaysCardProps> = ({ title, items }) => {
  const t = useTranslations('chat')
  return (
    <Card className="animate-in fade-in-0 slide-in-from-bottom-1 gap-2 p-5 shadow-xs">
      <SectionLabel icon={Highlighter}>{t('cards.keyTakeaways.eyebrow')}</SectionLabel>
      {title && <p className="text-sm font-semibold text-foreground">{title}</p>}

      {/* `divide-y` over one container rather than a border per row: the rules
        separate the takeaways without drawing a box around each one. */}
      <ol className="-mx-1.5 mt-0.5 flex flex-col divide-y divide-border/60">
        {items.map((item, index) => (
          <li key={`${item.text}-${index}`}>
            <TakeawayRow item={item} index={index} />
          </li>
        ))}
      </ol>
    </Card>
  )
}
