'use client'

/**
 * KeyTakeawaysCard — „Das Wichtigste", the generic block that survives skimming.
 *
 * This is the card for an answer with no dimension in it and no fork in it,
 * where the alternative is a markdown bullet list: three discs of equal weight
 * that a reader has to read in full to find out which one is theirs.
 *
 * THE SHAPE (`docs/design/grid-card-charter.md` §A5). Each takeaway is its own
 * RECESSED PANEL, and the panel LIGHTENS TO THE CARD SURFACE WHEN IT OPENS.
 * The disclosure state is carried by the ground rather than by a chevron alone,
 * so an open row is legible from across the card before a word of it is read,
 * and nothing else in the set changes surface on disclosure.
 *
 * This replaced a descending staircase — each takeaway indented 6px further
 * than the one above it — which is worth recording because the staircase was
 * not a bad idea, it was the wrong claim. It encoded RANK, which a two-item
 * card cannot show at all, which the .docx export cannot carry (§D.5), and
 * which the model is not actually asked to order that strictly. The panel
 * encodes DISCLOSURE, which is the thing this card genuinely does.
 *
 * NO FIGURE. The previous revision spent one on the first takeaway. §A2 now
 * says a card with no single answer spends no figure at all rather than
 * picking one arbitrarily — five roughly equal points are five roughly equal
 * points, and typesetting the first one larger asserted a ranking the payload
 * does not carry.
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
import { ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { KeyTakeawayData } from '../schematics/types'

interface KeyTakeawaysCardProps {
  title?: string | null
  items: KeyTakeawayData[]
}

/** „01", „02" … — the ordinal in the gutter, so the count is visible unread. */
const ordinal = (index: number): string => String(index + 1).padStart(2, '0')

/**
 * Shared row geometry: chevron, ordinal gutter, takeaway.
 *
 * The chevron leads rather than trails, which is what makes the panel read as
 * openable before it is hovered — a chevron at the far right of a wide row is
 * a control the eye finds only after it has read the row it belongs to.
 *
 * The 18px ordinal column plus the gaps puts the takeaway's text at 66px, and
 * the open body below is padded to the same x: the detail then hangs under the
 * takeaway rather than under the panel.
 */
const ROW = 'grid w-full grid-cols-[14px_18px_minmax(0,1fr)] items-start gap-[11px] px-4 py-3 text-left'

/** The ordinal + the takeaway itself — identical whether or not the row opens. */
const RowBody: FC<{ index: number; text: string }> = ({ index, text }) => (
  <>
    <span className="card-meta mt-px font-mono text-muted-foreground/70" aria-hidden="true">
      {ordinal(index)}
    </span>
    {/* NEVER truncated — a takeaway is the payload, and a German compound that
        wraps to two lines is still the answer. */}
    <span className="card-title min-w-0 text-pretty leading-normal text-foreground">{text}</span>
  </>
)

/** Recessed by default, card-surface when open. */
const PANEL = 'rounded-md border transition-colors duration-quick ease-out motion-reduce:transition-none'

const TakeawayRow: FC<{ item: KeyTakeawayData; index: number }> = ({ item, index }) => {
  const [open, setOpen] = useState(false)

  if (!item.detail) {
    return (
      <div className={cn(PANEL, 'bg-input-background')}>
        <div className={ROW}>
          <span aria-hidden="true" />
          <RowBody index={index} text={item.text} />
        </div>
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn(PANEL, open ? 'bg-card' : 'bg-input-background')}>
      <CollapsibleTrigger
        className={cn(ROW, 'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60')}
      >
        <ChevronRight
          className={cn(
            'mt-0.5 size-3.5 text-muted-foreground',
            'transition-transform duration-quick ease-out motion-reduce:transition-none',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />
        <RowBody index={index} text={item.text} />
      </CollapsibleTrigger>

      <CollapsibleContent className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
        {/* Aligned to the takeaway's own text column, so the detail reads as
            belonging to the row above rather than as a further takeaway. */}
        <p className="card-body max-w-prose pb-4 pl-[66px] pr-4 text-muted-foreground">{item.detail}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

export const KeyTakeawaysCard: FC<KeyTakeawaysCardProps> = ({ title, items }) => {
  // An item with no `text` is skipped rather than rendered empty: every field
  // inside every array item reaches the renderer unvalidated (§0.5.1), and a
  // blank numbered row would claim the card has a takeaway it does not have.
  // Filtering BEFORE numbering keeps the ordinals contiguous — „01, 03" would
  // tell the reader something was withheld.
  const takeaways = items.filter((item) => Boolean(item?.text))

  if (takeaways.length === 0) return null

  return (
    <Card className="gap-3 p-5 shadow-xs">
      {title && <p className="card-title text-foreground">{title}</p>}

      <ol className="flex flex-col gap-2">
        {takeaways.map((item, index) => (
          <li key={`${item.text}-${index}`}>
            <TakeawayRow item={item} index={index} />
          </li>
        ))}
      </ol>
    </Card>
  )
}
