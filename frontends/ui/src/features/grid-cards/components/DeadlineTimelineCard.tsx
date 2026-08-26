'use client'

/**
 * DeadlineTimelineCard — die Fristen eines Bauverfahrens, in der Reihenfolge.
 *
 * `callout` carries ONE Frist. A Bauverfahren has several in sequence —
 * Einspruchs- bzw. Beschwerdefrist, Baubeginn, Fertigstellungsanzeige, die
 * Geltungsdauer der Bewilligung — and as four sentences of prose the reader has
 * to sort them themselves. The sorting is where the mistake happens, so the
 * ORDER and the event each clock runs from ARE the information this card is
 * built to carry.
 *
 * ## Nothing here is a date, and nothing here is to scale
 *
 * The period is the Bauordnung's own wording („binnen vier Wochen ab Zustellung
 * des Bescheids"), never a calendar day: the product does not know this
 * project's Zustelldatum, and a wrong date on a card is worse than no card at
 * all — the backend rejects a `period` or `starts_from` containing one, so the
 * renderer never has to decide what to do with it.
 *
 * The rail is spaced EVENLY on purpose. A bar whose length meant anything would
 * be claiming that four weeks and four years sit on one timeline, when each
 * period starts from a different event; the drawing says sequence, which is
 * true, and says nothing about duration, which it cannot know. The footer says
 * both out loud, because a reader who assumes otherwise assumes it silently.
 *
 * A click opens what happens if the Frist lapses, who has to act and where it
 * is written — all of it already on the client („nicht zurück zum LLM … ich
 * klick das und sehe mehr").
 *
 * `presentational` in CARD_INTERACTIVITY: opening a Frist commits nothing and
 * reaches no backend (ADR-0030).
 */

import { useState, type FC } from 'react'
import { ChevronDown, Scale } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations, type Translator } from '@/i18n'
import { SchematicCard } from '../cards/shell'
import { cn } from '@/lib/utils'
import type { DeadlineData, NormReferenceData } from '../schematics/types'

interface DeadlineTimelineCardProps {
  title: string
  deadlines: DeadlineData[]
  reference?: NormReferenceData | null
  note?: string | null
}

/** One labelled fact inside an opened Frist. */
const Fact: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
    <span className="min-w-0 flex-[1_1_12rem] text-foreground">{value}</span>
  </div>
)

interface StationProps {
  deadline: DeadlineData
  index: number
  isLast: boolean
  open: boolean
  onToggle: () => void
  t: Translator
}

const Station: FC<StationProps> = ({ deadline, index, isLast, open, onToggle, t }) => {
  const number = index + 1
  // A Frist whose consequence, actor and Fundstelle are all unstated has
  // nothing behind it, and an expander that opens onto nothing teaches the
  // reader that the chevrons are decorative — the CalculationCard's rule, and
  // it bites harder in a list where some rows do have something to show.
  const hasDetail = Boolean(deadline.actor || deadline.consequence || deadline.reference)
  const Shell = hasDetail ? CollapsibleTrigger : 'div'

  return (
    <li className="relative grid grid-cols-[26px_minmax(0,1fr)]">
      {/* Rail and node are decoration in the 26px gutter — the sequence reads
          as one, and neither intercepts the click. The rail stops at the last
          node because nothing follows it. */}
      <span
        aria-hidden="true"
        className={cn('absolute left-[10px] top-0 w-px bg-border', isLast ? 'h-[15px]' : 'bottom-0')}
      />
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-[10px] top-[15px] flex size-[18px] -translate-x-1/2 -translate-y-1/2 items-center',
          'justify-center rounded-full border border-border bg-card font-mono text-[10px] tabular-nums',
          'text-muted-foreground'
        )}
      >
        {number}
      </span>

      <div className="col-start-2 min-w-0 pb-1.5">
        <Collapsible open={open} onOpenChange={onToggle}>
          <Shell
            aria-label={
              hasDetail
                ? t('cards.deadlineTimeline.deadlineAria', { index: String(number), label: deadline.label })
                : undefined
            }
            className={cn(
              'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left',
              hasDetail && [
                'group transition-colors duration-quick ease-out motion-reduce:transition-none',
                'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
                open ? 'bg-muted/60' : 'hover:bg-muted/50',
              ]
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13.5px] leading-[1.5] text-default">{deadline.label}</span>
              {/* The period is what the reader came for, so it carries the
                  weight; the event it runs from is labelled directly under it,
                  because a period without its trigger cannot be placed. */}
              <span className="text-[13.5px] font-semibold leading-snug text-foreground">{deadline.period}</span>
              <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs leading-snug text-muted-foreground">
                <span className="text-[11px] font-medium uppercase tracking-wider">
                  {t('cards.deadlineTimeline.startsFrom')}
                </span>
                <span className="min-w-0">{deadline.starts_from}</span>
              </span>
            </span>

            {hasDetail && (
              <ChevronDown
                className={cn(
                  'mt-0.5 size-4 shrink-0 text-muted-foreground',
                  'transition-transform duration-quick ease-out motion-reduce:transition-none',
                  open && 'rotate-180'
                )}
                aria-hidden="true"
              />
            )}
          </Shell>

          <CollapsibleContent className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
            <div className="mt-1.5 flex flex-col gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2.5">
              {deadline.actor && <Fact label={t('cards.deadlineTimeline.actor')} value={deadline.actor} />}
              {deadline.consequence && (
                <Fact label={t('cards.deadlineTimeline.consequence')} value={deadline.consequence} />
              )}

              {deadline.reference && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-source-law-tint px-3 py-2 text-xs text-source-law-text">
                  <Scale className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="text-[11px] font-medium uppercase tracking-wider opacity-70">
                    {t('cards.deadlineTimeline.basis')}
                  </span>
                  <span className="font-medium">{deadline.reference.document}</span>
                  {deadline.reference.section && (
                    <span className="font-mono opacity-90">{deadline.reference.section}</span>
                  )}
                  {deadline.reference.edition && <span className="opacity-70">{deadline.reference.edition}</span>}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </li>
  )
}

export const DeadlineTimelineCard: FC<DeadlineTimelineCardProps> = ({ title, deadlines, reference, note }) => {
  const t = useTranslations('chat')
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  return (
    <SchematicCard
      title={title}
      note={note}
      reference={reference}
    >
      <ol className="flex flex-col">
        {deadlines.map((deadline, index) => (
          <Station
            key={`${deadline.label}-${index}`}
            deadline={deadline}
            index={index}
            isLast={index === deadlines.length - 1}
            open={openIndex === index}
            onToggle={() => setOpenIndex((current) => (current === index ? null : index))}
            t={t}
          />
        ))}
      </ol>

      {/* Said out loud rather than implied by the drawing: the two assumptions
          a reader would otherwise make silently — that the spacing means
          duration, and that somebody could turn these into dates. */}
      <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
        {t('cards.deadlineTimeline.notToScale')} {t('cards.deadlineTimeline.noDatesNote')}
      </p>
    </SchematicCard>
  )
}
