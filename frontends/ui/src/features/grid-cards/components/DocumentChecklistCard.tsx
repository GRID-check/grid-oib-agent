'use client'

/**
 * DocumentChecklistCard — die Einreichunterlagen, as a list you can work down.
 *
 * „Was brauche ich für die Einreichung?" is one of the most common questions
 * there is, and the answer written as a markdown list carries the NAMES and
 * nothing else. What the reader actually needs is the STATE of each document:
 * whether it is always required or only for their kind of Vorhaben (and on
 * what), who has to produce it, where it is prescribed, and — where the
 * conversation established it — whether they already hold it.
 *
 * Each row shows what is known at rest and opens on click onto the condition,
 * the issuer, the form and the Fundstelle. All of it arrived with the card, so
 * the click reaches nothing („nicht zurück zum LLM … ich klick das und sehe
 * mehr").
 *
 * ## Unknown is drawn, not defaulted
 *
 * `status` is the model's only claim about the READER's project, and it is
 * absent far more often than it is set. An absent status renders as „nicht
 * bekannt" — never as „fehlt", which would tell someone their dossier is
 * further behind than it is, and never as a blank, which the eye reads as
 * „nothing to do here". The same rule governs the tally: it counts the
 * unresolved rows out loud, and where NO row carries a status it says so in a
 * sentence instead of drawing a „0 von 5" progress line that would be a claim
 * about the project rather than a summary of the card.
 *
 * ## The card counts, the model does not
 *
 * There is no count, total or progress field on the wire — the tally below the
 * title is derived here from the rows themselves, the invariant `calculation`
 * established. Nothing exists for a stated summary to disagree with.
 *
 * Rows open independently (a Set, not a single index), unlike the process map's
 * one-at-a-time selection: those steps are alternatives for the reader's
 * attention, these are items on one list a reader compares side by side.
 *
 * `presentational` in CARD_INTERACTIVITY: opening a row is view state for one
 * reader and commits nothing (ADR-0030).
 */

import { useState, type FC } from 'react'
import { ChevronDown, Circle, CircleCheck, CircleHelp, Scale } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations, type Translator } from '@/i18n'
import { SchematicCard, statusColor } from '../cards/shell'
import { cn } from '@/lib/utils'
import { CARD_LIST_ROW } from './card-rows'
import type { DocumentStatus, NormReferenceData, RequiredDocumentData } from '../schematics/types'

interface DocumentChecklistCardProps {
  title: string
  items: RequiredDocumentData[]
  reference?: NormReferenceData | null
  note?: string | null
}

/**
 * What a row's status looks like — including the case where there is none.
 *
 * The absent case is a face of its own rather than a fallback into `missing`:
 * a hollow ring says „still to obtain", a question mark says „nobody has said",
 * and collapsing the two would put words in the reader's mouth.
 */
const STATUS_FACE = {
  present: { icon: CircleCheck, tint: 'pass' },
  missing: { icon: Circle, tint: 'warning' },
  unknown: { icon: CircleHelp, tint: 'needs_input' },
} as const

const faceFor = (status: DocumentStatus | null | undefined) =>
  status === 'present' ? STATUS_FACE.present : status === 'missing' ? STATUS_FACE.missing : STATUS_FACE.unknown

/**
 * The word for a row's status, one case at a time.
 *
 * Spelled out rather than composed from the value, the same reason
 * `provenanceLabel` is: a literal key is a key `key-coverage.spec.ts` can see,
 * and a template-literal one silently ships the dot-path when it is wrong.
 */
const statusLabel = (status: DocumentStatus | null | undefined, t: Translator): string => {
  switch (status) {
    case 'present':
      return t('cards.documentChecklist.status.present')
    case 'missing':
      return t('cards.documentChecklist.status.missing')
    default:
      return t('cards.documentChecklist.status.unknown')
  }
}

/** One derived count, drawn as `3 vorhanden`. The number is computed here. */
const Count: FC<{ count: number; label: string; tint?: string }> = ({ count, label, tint }) => (
  <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
    <span className="font-mono text-[13px] font-semibold tabular-nums" style={tint ? { color: tint } : undefined}>
      {count}
    </span>
    <span className="text-[11px] text-muted-foreground">{label}</span>
  </span>
)

/** One labelled fact inside an opened row. */
const Fact: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
    <span className="min-w-0 flex-[1_1_12rem] text-foreground">{value}</span>
  </div>
)

interface RowProps {
  item: RequiredDocumentData
  open: boolean
  onToggle: () => void
  t: Translator
}

const Row: FC<RowProps> = ({ item, open, onToggle, t }) => {
  const face = faceFor(item.status)
  const Icon = face.icon
  const tint = statusColor(face.tint)
  const conditional = item.requirement === 'conditional'

  return (
    <li>
      <Collapsible open={open} onOpenChange={onToggle}>
        <CollapsibleTrigger
          aria-label={t('cards.documentChecklist.itemAria', { label: item.label })}
          className={cn(
            CARD_LIST_ROW,
            'transition-colors duration-quick ease-out motion-reduce:transition-none',
            'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
            open ? 'bg-muted/60' : 'hover:bg-muted/50'
          )}
        >
          <Icon className="mt-[3px] size-4 shrink-0" style={{ color: tint }} aria-hidden="true" />

          {/* Same wrap treatment the process map's row needed: the name claims
              9rem before the chips may sit beside it, and the chip cluster
              shrinks and wraps rather than being sized to max-content — in the
              answer's 270px phone column two chips at max-content pushed past
              the card's own edge. */}
          <span className="flex min-w-0 flex-1 flex-wrap items-start gap-x-2 gap-y-1">
            <span className="flex min-w-0 flex-[1_1_9rem] flex-col">
              <span className="text-[13.5px] leading-[1.5] text-default">{item.label}</span>
              {/* The condition is the whole point of a conditional document, so
                  it rides in the row and not only behind the click. */}
              {conditional && item.condition && (
                <span className="truncate text-xs leading-snug text-muted-foreground">{item.condition}</span>
              )}
            </span>

            <span className="flex min-w-0 flex-wrap items-start gap-1.5">
              <span
                className={cn(
                  'mt-px rounded px-1.5 py-0.5 text-[11px]',
                  conditional
                    ? 'border border-dashed border-border text-muted-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {conditional
                  ? t('cards.documentChecklist.requirement.conditional')
                  : t('cards.documentChecklist.requirement.required')}
              </span>
              <span
                className="mt-px rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ color: tint, backgroundColor: `color-mix(in oklch, ${tint} 14%, transparent)` }}
              >
                {statusLabel(item.status, t)}
              </span>
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
            {item.condition && <Fact label={t('cards.documentChecklist.condition')} value={item.condition} />}
            {item.issuer && <Fact label={t('cards.documentChecklist.issuer')} value={item.issuer} />}
            {item.note && <Fact label={t('cards.documentChecklist.form')} value={item.note} />}

            {item.reference && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-source-law-tint px-3 py-2 text-xs text-source-law-text">
                <Scale className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="text-[11px] font-medium uppercase tracking-wider opacity-70">
                  {t('cards.documentChecklist.basis')}
                </span>
                <span className="font-medium">{item.reference.document}</span>
                {item.reference.section && <span className="font-mono opacity-90">{item.reference.section}</span>}
                {item.reference.edition && <span className="opacity-70">{item.reference.edition}</span>}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

export const DocumentChecklistCard: FC<DocumentChecklistCardProps> = ({ title, items, reference, note }) => {
  const t = useTranslations('chat')
  const [openRows, setOpenRows] = useState<ReadonlySet<number>>(() => new Set())

  const toggle = (index: number) =>
    setOpenRows((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })

  // Every number under the title is worked out here, from the rows. The wire
  // carries no count, so there is nothing for a stated total to contradict.
  const required = items.filter((item) => item.requirement === 'required').length
  const conditional = items.length - required
  const present = items.filter((item) => item.status === 'present').length
  const missing = items.filter((item) => item.status === 'missing').length
  const unresolved = items.length - present - missing
  const anyStatus = present + missing > 0

  return (
    <SchematicCard
      title={title}
      note={note}
      reference={reference}
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Count count={required} label={t('cards.documentChecklist.tally.required')} />
          {conditional > 0 && (
            <Count count={conditional} label={t('cards.documentChecklist.tally.conditional')} />
          )}
        </div>

        {anyStatus ? (
          <div
            aria-label={t('cards.documentChecklist.tallyAria')}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <Count
              count={present}
              label={t('cards.documentChecklist.tally.present')}
              tint={statusColor('pass')}
            />
            {missing > 0 && (
              <Count
                count={missing}
                label={t('cards.documentChecklist.tally.missing')}
                tint={statusColor('warning')}
              />
            )}
            {unresolved > 0 && (
              <Count count={unresolved} label={t('cards.documentChecklist.tally.unknown')} />
            )}
          </div>
        ) : (
          // No row carries a status, so there is no progress to draw. A bar at
          // 0 % would read as „you have none of these", which is a claim about
          // the reader's project that nothing in the conversation supports.
          <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
            {t('cards.documentChecklist.noStatus')}
          </p>
        )}
      </div>

      <ul className="flex flex-col">
        {items.map((item, index) => (
          <Row
            key={`${item.label}-${index}`}
            item={item}
            open={openRows.has(index)}
            onToggle={() => toggle(index)}
            t={t}
          />
        ))}
      </ul>
    </SchematicCard>
  )
}
