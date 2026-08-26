'use client'

/**
 * ProcessMapCard — der Verfahrensablauf, with where this project stands.
 *
 * „Wie läuft das ab" is one of the most common questions there is, and
 * Einreichung → Bauverhandlung → Baubewilligung → Baubeginnsanzeige →
 * Fertigstellungsanzeige has been coming back as a numbered list: it says the
 * ORDER and nothing else. Not what a step needs in hand, not what it yields,
 * not which one the reader is at.
 *
 * The map draws the procedure as a rail of numbered nodes and opens a step on
 * click — its Voraussetzungen, its Ergebnis, who acts, the Frist as written and
 * the Bestimmung it rests on. All of that arrived with the card, so the click
 * reaches nothing („nicht zurück zum LLM … ich klick das und sehe mehr"). One
 * step open at a time, the same selection the ConditionTreeCard makes, because
 * these are alternatives for the reader's attention rather than five
 * independent toggles.
 *
 * ## Where this project stands, kept separate from what is being looked at
 *
 * `current_step` is the model's ONE positional claim and everything else is
 * derived from it here: earlier steps are done, later ones are ahead. The
 * failure mode is the ConditionTreeCard's — a reader taking the panel they
 * happen to have open for where they are — so the current step keeps its filled
 * node, its „hier stehen Sie" chip, its weight and its `aria-current` whatever
 * else is open, an opened OTHER step is chromed differently in kind (dashed on
 * muted ground, not merely a different tint), and it carries the correcting
 * sentence naming the real position inside its own rectangle, where a crop
 * cannot lose it.
 *
 * With no `current_step` nothing is marked at all and the map opens closed:
 * picking a step on the reader's behalf is the one thing worse than not knowing.
 *
 * Nothing here is computed from a date. `duration` is the Frist as the
 * Bauordnung writes it („binnen sechs Wochen"), never a deadline this card
 * worked out — that would be a legal statement about the reader's project.
 *
 * `presentational` in CARD_INTERACTIVITY: opening a step is view state for one
 * reader and commits nothing (ADR-0030).
 */

import { useState, type FC } from 'react'
import { Check, ChevronDown, Route, Scale } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations, type Translator } from '@/i18n'
import { SchematicCard, statusColor } from '../cards/shell'
import { cn } from '@/lib/utils'
import { CARD_LIST_ROW, CARD_ROW_BACK_LINK } from './card-rows'
import type { NormReferenceData, ProcessStepData } from '../schematics/types'

interface ProcessMapCardProps {
  title: string
  steps: ProcessStepData[]
  current_step?: number | null
  reference?: NormReferenceData | null
  note?: string | null
}

/** Where a step sits relative to the one the project is at. Derived, never sent. */
type StepPhase = 'done' | 'current' | 'upcoming' | 'unmarked'

const phaseOf = (index: number, currentIndex: number | null): StepPhase => {
  if (currentIndex == null) return 'unmarked'
  if (index < currentIndex) return 'done'
  if (index === currentIndex) return 'current'
  return 'upcoming'
}

/** One labelled group inside an opened step („Voraussetzungen: a, b, c"). */
const Facts: FC<{ label: string; items: string[] }> = ({ label, items }) =>
  items.length === 0 ? null : (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      {items.map((item, index) => (
        <span key={`${item}-${index}`} className="rounded bg-muted px-1.5 py-0.5 text-foreground">
          {item}
        </span>
      ))}
    </div>
  )

interface StationProps {
  step: ProcessStepData
  index: number
  phase: StepPhase
  isLast: boolean
  open: boolean
  onToggle: () => void
  /** The step the project is at, when one is marked — else null. */
  currentStep: ProcessStepData | null
  currentNumber: number | null
  /** Jump back to it. Absent when this step IS it, or none is marked. */
  onBackToCurrent?: () => void
  t: Translator
}

const Station: FC<StationProps> = ({
  step,
  index,
  phase,
  isLast,
  open,
  onToggle,
  currentStep,
  currentNumber,
  onBackToCurrent,
  t,
}) => {
  const tint = statusColor('pass')
  const current = phase === 'current'
  const done = phase === 'done'
  const number = index + 1
  const requires = step.requires ?? []
  const produces = step.produces ?? []

  return (
    <li className="relative grid grid-cols-[26px_minmax(0,1fr)]">
      {/* Rail and node are decoration in the 26px gutter, so the procedure
          reads as a sequence and never intercepts the click. The rail stops at
          the node on the last station — nothing follows it. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-[10px] top-0 w-px',
          isLast ? 'h-[15px]' : 'bottom-0',
          done ? 'bg-foreground/40' : 'bg-border'
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-[10px] top-[15px] flex size-[18px] -translate-x-1/2 -translate-y-1/2 items-center justify-center',
          'rounded-full font-mono text-[10px] tabular-nums',
          done && 'bg-foreground/70 text-background',
          !done && !current && 'border border-border bg-card text-muted-foreground',
          current && 'text-background'
        )}
        style={current ? { backgroundColor: tint } : undefined}
      >
        {done ? <Check className="size-3" /> : number}
      </span>

      <div className="col-start-2 min-w-0 pb-1.5">
        <Collapsible open={open} onOpenChange={onToggle}>
          <CollapsibleTrigger
            aria-current={current ? 'step' : undefined}
            aria-label={t('cards.processMap.stepAria', { step: String(number), label: step.label })}
            className={cn(
              CARD_LIST_ROW,
              'transition-colors duration-quick ease-out motion-reduce:transition-none',
              'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
              current ? 'hover:bg-transparent' : open ? 'bg-muted/60' : 'hover:bg-muted/50'
            )}
            style={current ? { backgroundColor: `color-mix(in oklch, ${tint} 9%, transparent)` } : undefined}
          >
            {/* The name of the step claims 9rem before the chips are allowed to
                sit beside it. Without that basis the two `shrink-0` chips took
                the whole row on a phone and „Bauverhandlung" was truncated to a
                single letter — the same failure the condition tree's correcting
                sentence hit, and the same fix: the label takes the width and the
                chips drop to their own line. */}
            <span className="flex min-w-0 flex-1 flex-wrap items-start gap-x-2 gap-y-1">
              <span className="flex min-w-0 flex-[1_1_9rem] flex-col">
                <span
                  className={cn(
                    'text-[13.5px] leading-[1.5]',
                    current ? 'font-semibold text-foreground' : 'text-default',
                    done && 'text-muted-foreground'
                  )}
                >
                  {step.label}
                </span>
                {/* One line whether open or closed: the row is the index of the
                    procedure, and the opened panel is where the detail lives. */}
                {step.summary && (
                  <span className="truncate text-xs leading-snug text-muted-foreground">{step.summary}</span>
                )}
              </span>

              {/* Wrappable, not `shrink-0`. The parent's wrap already drops this
                  cluster to its own line when the label needs the width — but on
                  a line of its own it was still sized to max-content, so in the
                  ANSWER's column (270px on a phone, against the card gallery's
                  342px) „binnen sechs Wochen" + „hier stehen Sie" together ran
                  8.5px past the card's own edge. Letting the cluster shrink and
                  wrap stacks the two chips instead; neither is ever squeezed,
                  because a chip is not a flex container here. */}
              <span className="flex min-w-0 flex-wrap items-start gap-2">
                {step.duration && (
                  <span className="mt-px rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {step.duration}
                  </span>
                )}
                {current && (
                  <span
                    className="mt-px rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{ color: tint, backgroundColor: `color-mix(in oklch, ${tint} 14%, transparent)` }}
                  >
                    {t('cards.processMap.current')}
                  </span>
                )}
              </span>
            </span>

            <ChevronDown
              className={cn(
                'mt-0.5 size-4 shrink-0 text-muted-foreground',
                'transition-transform duration-quick ease-out motion-reduce:transition-none',
                open && 'rotate-180'
              )}
              aria-hidden="true"
            />
          </CollapsibleTrigger>

          <CollapsibleContent className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
            <div
              className={cn(
                'mt-1.5 flex flex-col gap-2 rounded-md border px-3 py-2.5',
                // Chrome differs in KIND, not only in tint: dashed on muted
                // ground for a step being looked at, a solid tinted panel for
                // the one the project is actually at.
                current ? 'border-transparent' : 'border-dashed bg-muted/30'
              )}
              style={
                current
                  ? {
                      borderColor: `color-mix(in oklch, ${tint} 30%, transparent)`,
                      backgroundColor: `color-mix(in oklch, ${tint} 6%, transparent)`,
                    }
                  : undefined
              }
            >
              {step.summary && (
                <p className="max-w-prose text-[13.5px] leading-snug text-foreground">{step.summary}</p>
              )}

              <Facts label={t('cards.processMap.requires')} items={requires} />
              <Facts label={t('cards.processMap.produces')} items={produces} />

              {(step.actor || step.duration) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {step.actor && (
                    <span>
                      <span className="text-[11px] font-medium uppercase tracking-wider">
                        {t('cards.processMap.actor')}
                      </span>{' '}
                      <span className="text-foreground">{step.actor}</span>
                    </span>
                  )}
                  {step.duration && (
                    <span>
                      <span className="text-[11px] font-medium uppercase tracking-wider">
                        {t('cards.processMap.duration')}
                      </span>{' '}
                      <span className="text-foreground">{step.duration}</span>
                    </span>
                  )}
                </div>
              )}

              {!current && currentStep && currentNumber != null && (
                // The correction rides INSIDE the panel, so it is in the same
                // rectangle a reader would crop out — and it names the step
                // that applies, not merely „this is not it".
                <div className="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md bg-card px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
                  <span className="min-w-0 flex-[1_1_12rem]">
                    {t('cards.processMap.elsewhereNotice', {
                      step: String(currentNumber),
                      label: currentStep.label,
                    })}
                  </span>
                  {onBackToCurrent && (
                    <button
                      type="button"
                      onClick={onBackToCurrent}
                      className={cn(
                        CARD_ROW_BACK_LINK,
                        'transition-opacity duration-quick ease-out motion-reduce:transition-none',
                        'hover:opacity-80',
                        'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2'
                      )}
                    >
                      {t('cards.processMap.backToCurrent', { label: currentStep.label })}
                    </button>
                  )}
                </div>
              )}

              {step.reference && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-source-law-tint px-3 py-2 text-xs text-source-law-text">
                  <Scale className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="text-[11px] font-medium uppercase tracking-wider opacity-70">
                    {t('cards.processMap.basis')}
                  </span>
                  <span className="font-medium">{step.reference.document}</span>
                  {step.reference.section && <span className="font-mono opacity-90">{step.reference.section}</span>}
                  {step.reference.edition && <span className="opacity-70">{step.reference.edition}</span>}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </li>
  )
}

export const ProcessMapCard: FC<ProcessMapCardProps> = ({
  title,
  steps,
  current_step: currentStepNumber,
  reference,
  note,
}) => {
  const t = useTranslations('chat')
  // The wire carries a 1-based index; everything below counts from zero. Out of
  // range means "not stated", never step 1 — the backend rejects it, and a
  // renderer that fell back to the first step would invent a position.
  const currentIndex =
    currentStepNumber != null && currentStepNumber >= 1 && currentStepNumber <= steps.length
      ? currentStepNumber - 1
      : null
  const currentStep = currentIndex != null ? steps[currentIndex] : null

  // The step the project is at opens by default, because it is already the
  // reader's answer. With none marked the map opens closed rather than picking
  // one for them.
  const [openIndex, setOpenIndex] = useState<number | null>(currentIndex)

  return (
    <SchematicCard icon={Route} eyebrow={t('cards.processMap.eyebrow')} title={title} note={note} reference={reference}>
      <ol className="flex flex-col">
        {steps.map((step, index) => (
          <Station
            key={`${step.label}-${index}`}
            step={step}
            index={index}
            phase={phaseOf(index, currentIndex)}
            isLast={index === steps.length - 1}
            open={openIndex === index}
            onToggle={() => setOpenIndex((current) => (current === index ? null : index))}
            currentStep={currentStep}
            currentNumber={currentIndex != null ? currentIndex + 1 : null}
            onBackToCurrent={
              currentIndex != null && currentIndex !== index ? () => setOpenIndex(currentIndex) : undefined
            }
            t={t}
          />
        ))}
      </ol>
    </SchematicCard>
  )
}
