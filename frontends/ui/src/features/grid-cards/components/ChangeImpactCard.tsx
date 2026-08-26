'use client'

/**
 * ChangeImpactCard — was sich ändert, wenn sich X ändert.
 *
 * The card a Ziviltechniker needs while the design is still moving: „was
 * passiert, wenn das Fluchtniveau über 11 m geht?" — the Gebäudeklasse changes,
 * and with it the required fire resistance, the second escape route and the
 * lift. As prose that is one paragraph whose consequences the reader has to
 * separate from each other and pair back to their sources by hand.
 *
 * ## Not a condition tree
 *
 * The tree shows which case the project is IN; this shows what a MOVE would
 * cost. So the card names one trigger fact and its two values at the top, and
 * every row below is a requirement that follows — with its own Fundstelle and
 * its own direction. That difference is why the two cards are drawn
 * differently: the tree marks one branch as the reader's, and here NO row is
 * „the answer" — all of them are.
 *
 * ## What the renderer derives, and what it refuses to invent
 *
 * The direction tally under the header is counted here from the rows; there is
 * no summary field on the wire, the invariant `calculation` established, so
 * nothing exists for a stated count to disagree with.
 *
 * `from_value` is the model's one claim about where the project stands today
 * and it is frequently unknown. Absent, the header reads „Fluchtniveau → über
 * 11 m" and says in a sentence that the starting point does not follow from the
 * conversation — rather than printing a plausible „7–11 m" nobody stated. A row
 * with no `before` says „bisher nicht bekannt" in the same spirit: the size of
 * a change is only known when both ends are.
 *
 * A click opens what the new requirement means in practice and where it is
 * written — already on the client („nicht zurück zum LLM … ich klick das und
 * sehe mehr").
 *
 * `presentational` in CARD_INTERACTIVITY: opening a consequence commits nothing
 * and reaches no backend (ADR-0030).
 */

import { useState, type FC } from 'react'
import { ArrowDownRight, ArrowUpRight, ChevronDown, GitCompareArrows, Minus, Scale } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations, type Translator } from '@/i18n'
import { SchematicCard, statusColor } from '../cards/shell'
import { cn } from '@/lib/utils'
import { CARD_LIST_ROW } from './card-rows'
import type { ChangeConsequenceData, ChangeDirection, NormReferenceData } from '../schematics/types'

interface ChangeImpactCardProps {
  title: string
  factor: string
  from_value?: string | null
  to_value: string
  consequences: ChangeConsequenceData[]
  reference?: NormReferenceData | null
  note?: string | null
}

/**
 * How each direction is drawn.
 *
 * `tightens` is amber rather than red: a stricter requirement is a cost to plan
 * around, not a failure — the danger colour is reserved for a limit that is
 * actually missed, and spending it here would make every impact card read as an
 * alarm.
 */
const DIRECTION_FACE = {
  tightens: { icon: ArrowUpRight, tint: 'warning' },
  relaxes: { icon: ArrowDownRight, tint: 'pass' },
  unchanged: { icon: Minus, tint: 'needs_input' },
} as const

/**
 * The word for a direction, one case at a time — spelled out rather than
 * composed, so `key-coverage.spec.ts` can see every key (same reason as
 * `provenanceLabel` in the kit).
 */
const directionLabel = (direction: ChangeDirection, t: Translator): string => {
  switch (direction) {
    case 'tightens':
      return t('cards.changeImpact.direction.tightens')
    case 'relaxes':
      return t('cards.changeImpact.direction.relaxes')
    case 'unchanged':
      return t('cards.changeImpact.direction.unchanged')
  }
}

/** One derived count, drawn as `3 verschärft`. The number is computed here. */
const Count: FC<{ count: number; label: string; tint: string }> = ({ count, label, tint }) => (
  <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
    <span className="font-mono text-[13px] font-semibold tabular-nums" style={{ color: tint }}>
      {count}
    </span>
    <span className="text-[11px] text-muted-foreground">{label}</span>
  </span>
)

interface ConsequenceRowProps {
  consequence: ChangeConsequenceData
  open: boolean
  onToggle: () => void
  t: Translator
}

const ConsequenceRow: FC<ConsequenceRowProps> = ({ consequence, open, onToggle, t }) => {
  const face = DIRECTION_FACE[consequence.direction] ?? DIRECTION_FACE.unchanged
  const Icon = face.icon
  const tint = statusColor(face.tint)

  return (
    <li>
      <Collapsible open={open} onOpenChange={onToggle}>
        <CollapsibleTrigger
          aria-label={t('cards.changeImpact.consequenceAria', { aspect: consequence.aspect })}
          className={cn(
            CARD_LIST_ROW,
            'transition-colors duration-quick ease-out motion-reduce:transition-none',
            'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
            open ? 'bg-muted/60' : 'hover:bg-muted/50'
          )}
        >
          <Icon className="mt-[3px] size-4 shrink-0" style={{ color: tint }} aria-hidden="true" />

          {/* The label takes 9rem before the chip may sit beside it, and the
              chip wraps to its own line rather than squeezing the aspect to a
              letter — the process map's phone-column lesson. */}
          <span className="flex min-w-0 flex-1 flex-wrap items-start gap-x-2 gap-y-1">
            <span className="flex min-w-0 flex-[1_1_9rem] flex-col">
              <span className="text-[13.5px] leading-[1.5] text-default">{consequence.aspect}</span>
              {/* The new requirement, at rest: it is what the reader has to
                  plan against, so it is not behind the click. */}
              <span className="text-[13.5px] font-semibold leading-snug text-foreground">{consequence.after}</span>
            </span>

            <span
              className="mt-px shrink rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{ color: tint, backgroundColor: `color-mix(in oklch, ${tint} 14%, transparent)` }}
            >
              {directionLabel(consequence.direction, t)}
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
          <div className="ml-6 mt-1.5 flex flex-col gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('cards.changeImpact.before')}
              </span>
              {consequence.before ? (
                <span className="text-foreground">{consequence.before}</span>
              ) : (
                // The size of a change is only known when both ends are. A
                // blank here would read as „nothing applied before".
                <span className="italic text-muted-foreground">{t('cards.changeImpact.unknownBefore')}</span>
              )}
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('cards.changeImpact.after')}
              </span>
              <span className="font-medium text-foreground">{consequence.after}</span>
            </div>

            {consequence.detail && (
              <p className="max-w-prose text-[13px] leading-snug text-foreground">{consequence.detail}</p>
            )}

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-source-law-tint px-3 py-2 text-xs text-source-law-text">
              <Scale className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="text-[11px] font-medium uppercase tracking-wider opacity-70">
                {t('cards.changeImpact.basis')}
              </span>
              <span className="font-medium">{consequence.reference.document}</span>
              {consequence.reference.section && (
                <span className="font-mono opacity-90">{consequence.reference.section}</span>
              )}
              {consequence.reference.edition && <span className="opacity-70">{consequence.reference.edition}</span>}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

export const ChangeImpactCard: FC<ChangeImpactCardProps> = ({
  title,
  factor,
  from_value: fromValue,
  to_value: toValue,
  consequences,
  reference,
  note,
}) => {
  const t = useTranslations('chat')
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  // Counted here, from the rows. There is no tally on the wire.
  const tightens = consequences.filter((c) => c.direction === 'tightens').length
  const relaxes = consequences.filter((c) => c.direction === 'relaxes').length
  const unchanged = consequences.filter((c) => c.direction === 'unchanged').length

  return (
    <SchematicCard
      icon={GitCompareArrows}
      eyebrow={t('cards.changeImpact.eyebrow')}
      title={title}
      note={note}
      reference={reference}
    >
      <div className="flex flex-col gap-1.5 rounded-md border border-dashed bg-muted/30 px-3 py-2.5">
        <p className="text-[13.5px] font-medium leading-snug text-foreground">
          {fromValue
            ? t('cards.changeImpact.changeWithBefore', { factor, from: fromValue, to: toValue })
            : t('cards.changeImpact.changeWithoutBefore', { factor, to: toValue })}
        </p>
        {!fromValue && (
          <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
            {t('cards.changeImpact.currentUnknown')}
          </p>
        )}

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {tightens > 0 && (
            <Count
              count={tightens}
              label={t('cards.changeImpact.direction.tightens')}
              tint={statusColor('warning')}
            />
          )}
          {relaxes > 0 && (
            <Count count={relaxes} label={t('cards.changeImpact.direction.relaxes')} tint={statusColor('pass')} />
          )}
          {unchanged > 0 && (
            <Count
              count={unchanged}
              label={t('cards.changeImpact.direction.unchanged')}
              tint={statusColor('needs_input')}
            />
          )}
        </div>
      </div>

      <ul className="flex flex-col">
        {consequences.map((consequence, index) => (
          <ConsequenceRow
            key={`${consequence.aspect}-${index}`}
            consequence={consequence}
            open={openIndex === index}
            onToggle={() => setOpenIndex((current) => (current === index ? null : index))}
            t={t}
          />
        ))}
      </ul>
    </SchematicCard>
  )
}
