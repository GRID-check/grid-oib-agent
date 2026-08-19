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
 * `detail` is a disclosure, not a second paragraph: the background is one click
 * away rather than doubling the height of a card whose value is being small.
 * Local `useState` only — nothing is committed, so there is nothing to persist
 * (`presentational` in CARD_INTERACTIVITY).
 */

import { useState, type FC } from 'react'
import { CalendarClock, ChevronDown, CircleAlert, Info, Lightbulb, type LucideIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
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
    <Card className="animate-in fade-in-0 slide-in-from-bottom-1 relative gap-0 overflow-hidden py-3.5 pl-5 pr-4 shadow-xs">
      {/* The accent edge rides the card's own left border rather than being a
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
            {/* Hand-rolled rather than `SectionLabel`, because this eyebrow
                carries the kind's ink: SectionLabel hard-codes the muted one
                and `cn` cannot dedupe it against a project-custom `text-*`
                utility, so the two would fight on CSS order. */}
            <span className={cn('text-[10.5px] font-medium uppercase tracking-wider', tone.ink)}>
              {tone.label(t)}
            </span>
            {title && <p className="text-sm font-semibold text-foreground">{title}</p>}
          </div>

          <p className="max-w-prose text-[13.5px] leading-[1.6] text-default">{text}</p>

          {detail && (
            <Collapsible open={open} onOpenChange={setOpen}>
              <CollapsibleTrigger
                className={cn(
                  '-ml-1 mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5',
                  'text-xs font-medium text-muted-foreground',
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
                <p className="mt-1.5 max-w-prose border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
                  {detail}
                </p>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </Card>
  )
}
