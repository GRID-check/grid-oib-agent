'use client'

/**
 * CalloutCard — one framed remark, for the sentence that must not drown.
 *
 * The smallest card in the set and the only one with no domain in it: a
 * Land-specific deviation, a Frist, an easily-missed condition. Inside a
 * paragraph such a sentence reads at exactly the weight of the sentence beside
 * it — which is the one weight it must not have — so it gets a frame, an
 * accent edge in its own tone and an icon well to scan to.
 *
 * The kind is ALWAYS written out („Hinweis", „Achtung", „Frist", „Tipp") next
 * to the tint. Colour alone would leave a reader who cannot separate the four
 * hues with a coloured box and no idea whether it is a tip or a trap — and the
 * whole point of the card is that this one sentence lands.
 *
 * THREE MUTED TIERS, not four hues (`TONES`): Hinweis is the neutral aside
 * (slate rule, no wash, subdued eyebrow — petrol was considered for the
 * eyebrow and rejected to hold the viewport's hue budget); Frist is the one
 * warm constant (amber wash + rule + clock); Achtung is brick red (wash + rule
 * + triangle). Tipp renders on the neutral tier: a second green would collide
 * with the takeaways' distillation marker, and the bulb + the written word
 * still triple-code it. No new alarm colors beyond these two.
 *
 * `detail` is a disclosure, not a second paragraph: the background is one click
 * away rather than doubling the height of a card whose value is being small.
 * Local `useState` only — nothing is committed, so there is nothing to persist
 * (`presentational` in CARD_INTERACTIVITY).
 *
 * THE WIDTH CAP is the card's mark (`docs/design/grid-card-charter.md` §A5:
 * "the only card narrower than the column"). A remark that spans the whole
 * column reads as a section of the answer; one that stops short of it reads as
 * an aside, which is exactly what it is. `46ch` is a measure rather than a
 * pixel width, so it stays an aside whatever the column does, and on a phone
 * the column is narrower than the cap and nothing binds.
 */

import { useState, type FC } from 'react'
import { AlertTriangle, CalendarClock, ChevronDown, Info, Lightbulb, type LucideIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { StatCardIcon, type StatCardIconTone } from '@/components/ui/stat-card'
import { useTranslations, type Translator } from '@/i18n'
import { cn } from '@/lib/utils'
import type { CalloutKind } from '../schematics/types'
import { CARD_SHELL } from './card-chrome'

interface CalloutCardProps {
  kind: CalloutKind
  text: string
  title?: string | null
  detail?: string | null
  /**
   * Render as an ASIDE in the answer's own flow: the accent edge, the icon
   * well and the kind word stay (they are the identity), the frame and the
   * ground go. This is how the envelope's native `callout` field renders —
   * beside the paragraph its `[[callout]]` marker anchors it to, or after the
   * prose — an emphasized remark IN the answer, not a box ON it. The framed
   * default remains for stored threads whose callout arrived as a card.
   */
  flat?: boolean
}

interface CalloutTone {
  /** The kind in words — the carrier of the signal; the tint only reinforces it. */
  label: (t: Translator) => string
  icon: LucideIcon
  /** Ink for the eyebrow. */
  ink: string
  /** The well behind the icon — the shared `StatCardIcon` tint pair. */
  iconTone: StatCardIconTone
  /** The 3px accent edge. */
  edge: string
  /**
   * The muted wash behind the eyebrow pill: the tier's hue at ~6-7% via
   * `color-mix`, never a fill behind running text (the body stays on the
   * shell ground). Empty for the neutral tier, which keeps the eyebrow bare.
   */
  wash: string
}

/** Amber at 7% — the Frist wash, the one warm constant. */
const AMBER_WASH = 'bg-[color-mix(in_oklch,var(--source-office)_7%,transparent)]'
/** Brick red at 6% — the Achtung wash. */
const RED_WASH = 'bg-[color-mix(in_oklch,var(--signal-error)_6%,transparent)]'
/** Slate — the neutral tier's rule (warm-gray ink at 40%, no chromatic hue). */
const SLATE_EDGE = 'bg-muted-foreground/40'

const TONES: Record<CalloutKind, CalloutTone> = {
  hinweis: {
    label: (t) => t('cards.callout.hinweis'),
    icon: Info,
    ink: 'text-muted-foreground',
    iconTone: 'muted',
    edge: SLATE_EDGE,
    wash: '',
  },
  achtung: {
    label: (t) => t('cards.callout.achtung'),
    icon: AlertTriangle,
    ink: 'text-error',
    iconTone: 'destructive',
    edge: 'bg-danger',
    wash: RED_WASH,
  },
  frist: {
    label: (t) => t('cards.callout.frist'),
    icon: CalendarClock,
    ink: 'text-warning',
    iconTone: 'warning',
    edge: 'bg-warning',
    wash: AMBER_WASH,
  },
  // Deliberately the neutral tier, not a fourth hue: Tipp in success green
  // would put a second green beside the takeaways' distillation marker with a
  // different meaning, and the viewport's chromatic budget is spent already
  // (takeaway green, Frist amber, Achtung red, evidence lane tint).
  tipp: {
    label: (t) => t('cards.callout.tipp'),
    icon: Lightbulb,
    ink: 'text-muted-foreground',
    iconTone: 'muted',
    edge: SLATE_EDGE,
    wash: '',
  },
}

export const CalloutCard: FC<CalloutCardProps> = ({ kind, text, title, detail, flat = false }) => {
  const t = useTranslations('chat')
  const [open, setOpen] = useState(false)
  // `?? TONES.hinweis`, because `kind` arrives through a `z.any()`-typed union
  // member: an unknown value must render as a neutral remark rather than crash
  // the whole answer's card block.
  const tone = TONES[kind] ?? TONES.hinweis
  const Icon = tone.icon

  const body = (
    <div className="flex items-start gap-3">
        <StatCardIcon icon={Icon} tone={tone.iconTone} size="sm" className="mt-px" />

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {/* Hand-rolled rather than `SectionLabel`, because this eyebrow
                carries the kind's ink where SectionLabel hard-codes the muted
                one — so it reaches for the ramp's Eyebrow step directly. The
                tier's wash rides this pill alone, never the remark below: the
                marker marks the kind word, it never fills behind running text.
                And it shares a baseline with the title instead of sitting on a row
                of its own: that quirk is this card's identity and stays
                (grid-card-charter.md §B1 — do not "fix" it). */}
            <span className={cn('card-eyebrow rounded-sm px-1.5 py-0.5', tone.wash, tone.ink)}>{tone.label(t)}</span>
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
                  'card-caption font-medium text-muted-foreground',
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

              <CollapsibleContent>
                <p className="card-caption mt-1.5 border-l-2 border-border pl-3 text-muted-foreground">
                  {detail}
                </p>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
  )

  if (flat) {
    return (
      // The edge alone carries the tone — inset from the block's ends and
      // rounded, so it reads as an emphasis rule beside the remark rather
      // than as the border of a missing box. The tier's wash rides the kind
      // pill above, so the flat register keeps the same marker as the framed
      // one without filling behind the remark.
      <div className="relative max-w-[46ch] py-1 pl-5 pr-1">
        <span aria-hidden="true" className={cn('absolute inset-y-1 left-0 w-[3px] rounded-full', tone.edge)} />
        {body}
      </div>
    )
  }

  return (
    <Card
      className={cn(CARD_SHELL, 'relative max-w-[46ch] gap-0 overflow-hidden py-3.5 pl-5 pr-4')}
    >
      {/* The accent edge rides the card's own left border rather than being a
          border-left of its own: `overflow-hidden` clips it to the radius, so
          the tone reads at full strength without rounding the corner twice. */}
      <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-[3px]', tone.edge)} />
      {body}
    </Card>
  )
}
