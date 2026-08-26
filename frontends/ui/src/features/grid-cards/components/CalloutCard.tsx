'use client'

/**
 * CalloutCard — one remark, for the sentence that must not drown.
 *
 * The smallest block in the set and the only one with no domain in it: a
 * Land-specific deviation, a Frist, an easily-missed condition. Inside a
 * paragraph such a sentence reads at exactly the weight of the sentence beside
 * it — which is the one weight it must not have — so it gets a recessed panel,
 * an accent edge in its own tone and an icon well to scan to.
 *
 * FLAT register (§A1), and that is the 2026-08 revision's change here: the
 * white card around the panel is gone. A remark arriving on the same plate as
 * the evidence beside it reads AS evidence, and this is the one block on the
 * result surface that is explicitly not — it is the margin note. Recessed, it
 * says so before it is read. Several callouts stack with 10px between them and
 * nothing around the stack.
 *
 * The kind is ALWAYS written out („Hinweis", „Achtung", „Frist", „Tipp") next
 * to the tint. Colour alone would leave a reader who cannot separate the four
 * hues with a coloured box and no idea whether it is a tip or a trap — and the
 * whole point of the card is that this one sentence lands.
 *
 * `detail` is a disclosure, not a second paragraph: the background is one click
 * away rather than doubling the height of a card whose value is being small.
 * Local `useState` only — nothing is committed, so there is nothing to persist
 * (`presentational` in CARD_INTERACTIVITY).
 *
 * THE WIDTH CAP is half the mark (`docs/design/grid-card-charter.md` §A5 —
 * "the only block that is a bare recessed panel with an icon well and no card
 * around it"; the other half is the missing frame). A remark that spans the whole
 * column reads as a section of the answer; one that stops short of it reads as
 * an aside, which is exactly what it is. `46ch` is a measure rather than a
 * pixel width, so it stays an aside whatever the column does, and on a phone
 * the column is narrower than the cap and nothing binds.
 */

import { useState, type FC } from 'react'
import { CalendarClock, ChevronDown, CircleAlert, Info, Lightbulb, type LucideIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations, type Translator } from '@/i18n'
import { cn } from '@/lib/utils'
import type { CalloutKind } from '../schematics/types'

interface CalloutCardProps {
  kind: CalloutKind
  text: string
  title?: string | null
  detail?: string | null
}

interface CalloutTone {
  /** The kind in words — the carrier of the signal; the tint only reinforces it. */
  label: (t: Translator) => string
  icon: LucideIcon
  /** Ink for the icon and the eyebrow. */
  ink: string
  /** The icon well behind that ink. */
  well: string
  /** The 3px accent edge. */
  edge: string
}

const TONES: Record<CalloutKind, CalloutTone> = {
  hinweis: {
    label: (t) => t('cards.callout.hinweis'),
    icon: Info,
    ink: 'text-info',
    well: 'bg-info-subtle',
    edge: 'bg-info',
  },
  achtung: {
    label: (t) => t('cards.callout.achtung'),
    icon: CircleAlert,
    ink: 'text-error',
    well: 'bg-danger-subtle',
    edge: 'bg-danger',
  },
  frist: {
    label: (t) => t('cards.callout.frist'),
    icon: CalendarClock,
    ink: 'text-warning',
    well: 'bg-warning-subtle',
    edge: 'bg-warning',
  },
  tipp: {
    label: (t) => t('cards.callout.tipp'),
    icon: Lightbulb,
    ink: 'text-success',
    well: 'bg-success-subtle',
    edge: 'bg-success',
  },
}

export const CalloutCard: FC<CalloutCardProps> = ({ kind, text, title, detail }) => {
  const t = useTranslations('chat')
  const [open, setOpen] = useState(false)
  // `?? TONES.hinweis`, because `kind` arrives through a `z.any()`-typed union
  // member: an unknown value must render as a neutral remark rather than crash
  // the whole answer's card block.
  const tone = TONES[kind] ?? TONES.hinweis
  const Icon = tone.icon

  return (
    // FLAT register (§A1): the callout IS its panel — recessed ground, hairline,
    // `rounded-md` — with no card around it. A remark that arrives inside the
    // same white plate as the evidence beside it reads as evidence; recessed,
    // it reads as a note in the margin, which is what it is. It is also the one
    // block in the set narrower than the column (`max-w-[46ch]`), and the two
    // together are what make it identifiable before it is read.
    <div className="relative max-w-[46ch] overflow-hidden rounded-md border bg-input-background py-3 pl-5 pr-4">
      {/* The accent edge rides the panel's own left border rather than being a
          border-left of its own: `overflow-hidden` clips it to the radius, so
          the tone reads at full strength without rounding the corner twice. */}
      <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-[3px]', tone.edge)} />

      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn('mt-px flex size-7 shrink-0 items-center justify-center rounded-md', tone.well, tone.ink)}
        >
          <Icon className="size-4" />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {/* The kind word is CONTENT, not a type label: it is the word the
                tone's colour travels with, and without it the ink would be a
                signal on its own (§A3, §A8.4). So it survives §A2's retirement
                of the eyebrow — but it stops being SET as one. Uppercase at
                10.5px made it look like the card announcing its own type; at
                Body/600 in the tone ink it reads as the first word of the
                remark, which is what it is.

                It shares a baseline with the title instead of sitting on a row
                of its own: that quirk is this card's identity and stays
                (grid-card-charter.md §B1 — do not "fix" it). */}
            <span className={cn('card-body font-semibold', tone.ink)}>{tone.label(t)}</span>
            {title && <p className="card-title text-foreground">{title}</p>}
          </div>

          <p className="card-body text-default">{text}</p>

          {detail && (
            <Collapsible open={open} onOpenChange={setOpen}>
              <CollapsibleTrigger
                className={cn(
                  // `touch-target` rather than real padding: this is a caption-sized
                  // disclosure sitting directly under the card's body text, and adding
                  // 20px of vertical padding to reach the floor would open a visible gap
                  // in the card on phones only. The utility widens the CATCHMENT to 44px
                  // and leaves the drawn control exactly where the card's rhythm puts it.
                  '-ml-1 mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5 touch-target',
                  'card-meta text-muted-foreground',
                  'transition-colors duration-quick ease-out hover:text-foreground',
                  'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
                )}
              >
                {open ? t('cards.callout.less') : t('cards.callout.more')}
                <ChevronDown
                  className={cn(
                    'size-3.5',
                    'transition-transform duration-quick ease-out motion-reduce:transition-none',
                    open && 'rotate-180',
                  )}
                  aria-hidden="true"
                />
              </CollapsibleTrigger>

              <CollapsibleContent className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
                <p className="card-meta mt-1.5 border-l-2 border-border pl-3 text-muted-foreground">
                  {detail}
                </p>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </div>
  )
}
