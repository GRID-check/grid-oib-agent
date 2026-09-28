'use client'

/**
 * The answer's own kit: the atoms its designed blocks are drawn from.
 *
 * `directive-blocks.tsx` and the table overrides compose these and nothing
 * else, so the look of a check, a procedure or a figure is decided here, once,
 * in the tokens of `grid-design-language.md`. They carry the visual language
 * of the cards they replace: `process_map`'s rail and node, `condition_tree`'s
 * tinted case, the checklist's pills, the energy label's ladder, the verdict's
 * figure scale. Colour never travels alone: every tint has its word beside it.
 */

import { useState, type FC, type ReactNode } from 'react'
import { Check, ChevronDown, CircleCheck } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { ENERGY_CLASSES } from '@/lib/text/answer-directives'
import type { StatusTone } from './status-marks'

// ---------------------------------------------------------------------------
// Value against limit
// ---------------------------------------------------------------------------

export interface ValueBarProps {
  value: number
  limit: number
  bound: 'min' | 'max'
  pass: boolean
  /** The value and the limit as the answer wrote them, for the accessible name. */
  valueText: string
  limitText: string
}

/**
 * A value drawn against its limit: a track, the value's fill in pass or fail
 * ink, and a tick at the limit. The scale reaches a tenth past the larger of
 * the two, so the tick never sits on the edge and a failing value shows by how
 * much. What the acoustic, thermal and area cards drew per row.
 */
export const ValueBar: FC<ValueBarProps> = ({ value, limit, bound, pass, valueText, limitText }) => {
  const t = useTranslations('common')
  const top = Math.max(Math.abs(value), Math.abs(limit)) * 1.1 || 1
  const fill = Math.min(100, (Math.max(0, value) / top) * 100)
  const tick = Math.min(100, (Math.max(0, limit) / top) * 100)
  return (
    <span
      role="img"
      data-testid="value-bar"
      data-pass={pass ? 'true' : 'false'}
      data-bound={bound}
      aria-label={t('markdown.valueBar', {
        value: valueText,
        limit: limitText,
        verdict: t(pass ? 'markdown.limitKept' : 'markdown.limitMissed'),
      })}
      className="relative mt-1.5 block h-1.5 w-full min-w-16 max-w-40 rounded-full bg-muted"
    >
      <span
        className={cn('absolute inset-y-0 left-0 rounded-full', pass ? 'bg-success' : 'bg-danger')}
        style={{ width: `${fill}%` }}
      />
      <span className="absolute -inset-y-0.5 w-0.5 rounded-full bg-foreground/70" style={{ left: `calc(${tick}% - 1px)` }} />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Rows that hold, rows that do not
// ---------------------------------------------------------------------------

/** The row classes of an answer table: the case that holds is tinted, the others muted when one does. */
export const tableRowClass = ({ active, muted, conflict = false }: { active: boolean; muted: boolean; conflict?: boolean }): string =>
  cn(
    'border-base border-b last:border-b-0',
    // A row whose written status contradicts its own numbers: the reader must look.
    conflict && 'bg-warning-subtle',
    active && 'bg-success-subtle',
    muted && '[&>td]:text-muted-foreground'
  )

/** A list item of the same kinds. */
export const ListCase: FC<{ active: boolean; muted: boolean; id?: string; compact: boolean; children: ReactNode }> = ({
  active,
  muted,
  id,
  compact,
  children,
}) => (
  <li
    id={id}
    data-active={active ? 'true' : undefined}
    className={cn(
      compact ? 'text-sm' : 'text-base',
      muted ? 'text-muted-foreground' : 'text-foreground',
      active && '-ml-2 rounded-md bg-success-subtle py-0.5 pl-2'
    )}
  >
    {children}
  </li>
)

/** The word beside a tint: „trifft zu", „hier stehen Sie", „empfohlen". */
export const MarkChip: FC<{ tone?: 'success' | 'muted'; children: ReactNode }> = ({ tone = 'success', children }) => (
  <span
    data-testid="answer-mark"
    className={cn(
      'card-meta ml-1.5 inline-flex h-5 items-center rounded-full px-2 align-[1px]',
      tone === 'success' ? 'bg-success-subtle text-success' : 'bg-muted text-muted-foreground'
    )}
  >
    {children}
  </span>
)

// ---------------------------------------------------------------------------
// A procedure
// ---------------------------------------------------------------------------

export type StepPhase = 'none' | 'done' | 'current' | 'upcoming'

/** The list a procedure's steps hang from. */
export const StepList: FC<{ ordered: boolean; children: ReactNode }> = ({ ordered, children }) => {
  const Tag = ordered ? 'ol' : 'ul'
  return <Tag className="my-4 flex list-none flex-col pl-0">{children}</Tag>
}

/**
 * One station: the rail and its node in a 26px gutter (decoration, never a
 * click target), the step beside it. `process_map`'s geometry.
 */
export const StepStation: FC<{ phase: StepPhase; number: string; last: boolean; children: ReactNode }> = ({
  phase,
  number,
  last,
  children,
}) => (
  <li className="relative grid grid-cols-[26px_minmax(0,1fr)]" data-phase={phase}>
    <span
      aria-hidden="true"
      className={cn('absolute left-[10px] top-0 w-px', last ? 'h-[15px]' : 'bottom-0', phase === 'done' ? 'bg-foreground/40' : 'bg-border')}
    />
    <span
      aria-hidden="true"
      className={cn(
        'absolute left-[10px] top-[15px] flex size-[18px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full font-mono text-[10px] tabular-nums',
        phase === 'done' && 'bg-foreground/70 text-background',
        phase === 'current' && 'bg-success text-background',
        (phase === 'none' || phase === 'upcoming') && 'border border-border bg-card text-muted-foreground'
      )}
    >
      {phase === 'done' ? <Check className="size-3.5" /> : number}
    </span>
    <div className="col-start-2 min-w-0 pb-1.5">{children}</div>
  </li>
)

/** The step's own line: its name, its Frist, and whether the project is at it. */
export const StepLine: FC<{ phase: StepPhase; title: ReactNode; due?: ReactNode; open?: boolean; expandable: boolean }> = ({
  phase,
  title,
  due,
  open,
  expandable,
}) => {
  const t = useTranslations('common')
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-wrap items-start gap-x-2 gap-y-1">
        <span
          className={cn(
            'min-w-0 flex-[1_1_9rem] text-left text-[15px] leading-[1.5]',
            phase === 'current' ? 'font-semibold text-foreground' : 'text-default',
            phase === 'done' && 'text-muted-foreground'
          )}
        >
          {title}
        </span>
        <span className="flex min-w-0 flex-wrap items-start gap-2">
          {due && <span className="card-meta mt-0.5 rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{due}</span>}
          {phase === 'current' && (
            <span className="card-meta mt-0.5 rounded-full bg-success-subtle px-2 py-0.5 text-success">
              {t('markdown.stepCurrent')}
            </span>
          )}
        </span>
      </span>
      {expandable && (
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-quick ease-out motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      )}
    </>
  )
}

/** The row a step or a `details` block opens from. */
export const disclosureRowClass = ({ current, open }: { current: boolean; open: boolean }): string =>
  cn(
    'flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left touch-target',
    'transition-colors duration-quick ease-out motion-reduce:transition-none',
    'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
    current ? 'bg-success-subtle' : open ? 'bg-muted/60' : 'hover:bg-muted/50'
  )

/** What a step or a `details` block holds, once opened: dashed on muted ground (charter §A4). */
export const DisclosurePanel: FC<{ current?: boolean; children: ReactNode }> = ({ current, children }) => (
  <div
    className={cn(
      'mt-1.5 flex flex-col gap-2 rounded-md px-3 py-2.5 text-sm [&>*:last-child]:mb-0',
      current ? 'border border-success' : 'border border-dashed bg-muted/30'
    )}
  >
    {children}
  </div>
)

/** A `details` block's label, above its content where it is printed open (inside a step). */
export const InlineDetailsLabel: FC<{ children: ReactNode }> = ({ children }) => (
  <SectionLabel as="p" className="mb-1">
    {children}
  </SectionLabel>
)

/** The block a `details` stands in: its row, then its panel. */
export const DetailsFrame: FC<{ children: ReactNode }> = ({ children }) => <div className="my-3">{children}</div>

/** A `details` summary line. */
export const DetailsSummary: FC<{ children: ReactNode; open: boolean }> = ({ children, open }) => (
  <>
    <span className="min-w-0 flex-1 text-[15px] font-medium leading-[1.5] text-foreground">{children}</span>
    <ChevronDown
      aria-hidden="true"
      className={cn(
        'mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-quick ease-out motion-reduce:transition-none',
        open && 'rotate-180'
      )}
    />
  </>
)

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export type FigureTone = StatusTone | 'none'

const FIGURE_INK: Record<FigureTone, string> = {
  success: 'text-success',
  destructive: 'text-error',
  warning: 'text-warning',
  info: 'text-info',
  muted: 'text-foreground',
  none: 'text-foreground',
}

/** The status swatch (design language §Component patterns): a 10px square on the label line, never a rail. */
const FIGURE_SWATCH: Record<FigureTone, string> = {
  success: 'bg-success',
  destructive: 'bg-danger',
  warning: 'bg-warning',
  info: 'bg-info',
  muted: 'bg-muted-foreground',
  none: '',
}

/** The tiles, two a row on a phone and up to four where there is room. */
export const FigureGrid: FC<{ count: number; children: ReactNode }> = ({ count, children }) => (
  <div className="my-4 @container">
    <div className={cn('grid grid-cols-2 gap-2', count >= 3 && '@[36rem]:grid-cols-3', count >= 4 && '@[44rem]:grid-cols-4')}>
      {children}
    </div>
  </div>
)

/** One figure: the value at the verdict's figure scale, its label, its limit underneath. */
export const FigureTile: FC<{
  tone: FigureTone
  value: ReactNode
  label: ReactNode
  limit?: ReactNode
  /** The verdict in words, beside its swatch: colour never travels alone. */
  verdict?: string
}> = ({ tone, value, label, limit, verdict }) => {
  const t = useTranslations('common')
  return (
    <div data-testid="figure-tile" data-tone={tone} className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted/40 px-3.5 py-3">
      <span className={cn('card-figure-24 break-words', FIGURE_INK[tone])}>{value}</span>
      <span className="card-caption flex items-baseline gap-1.5 text-default">
        {tone !== 'none' && <span aria-hidden="true" className={cn('size-2.5 shrink-0 translate-y-px rounded-[3px]', FIGURE_SWATCH[tone])} />}
        <span className="min-w-0">{label}</span>
      </span>
      {(limit || verdict) && (
        <span className="card-meta text-muted-foreground">
          {limit && (
            <>
              {t('markdown.figureLimit')} {limit}
            </>
          )}
          {limit && verdict && ' · '}
          {verdict}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Energy class
// ---------------------------------------------------------------------------

/** The Energieeffizienzklasse as the certificate prints it: the letter on its band's colour. */
export const EnergyClassChip: FC<{ klasse: string }> = ({ klasse }) => {
  const t = useTranslations('common')
  const band = (ENERGY_CLASSES as readonly string[]).indexOf(klasse) + 1
  if (band <= 0) return <>{klasse}</>
  return (
    <abbr
      title={t('markdown.energyClass', { klasse })}
      data-testid="energy-class"
      data-class={klasse}
      className="mx-0.5 inline-flex h-5 min-w-7 items-center justify-center rounded-sm px-1.5 align-[1px] text-[12px] font-semibold no-underline"
      style={{
        backgroundColor: `var(--energy-band-${band})`,
        color: band === ENERGY_CLASSES.length ? 'var(--energy-band-paper)' : 'var(--energy-band-ink)',
      }}
    >
      {klasse}
    </abbr>
  )
}

// ---------------------------------------------------------------------------
// Excerpt
// ---------------------------------------------------------------------------

/**
 * A Fundstelle excerpt: the passage at a reading measure on the law accent,
 * its source in the margin beside it where there is room and under it where
 * there is not. `LegalBasisCard`'s blockquote, with the Fundstelle moved from
 * the card's header to where a commentary sets it.
 */
export const ExcerptFigure: FC<{ number: string; source: ReactNode; children: ReactNode }> = ({ number, source, children }) => (
  <figure className="my-5 @container" data-excerpt={number}>
    <div className={cn('grid gap-2', source && '@[36rem]:grid-cols-[minmax(0,1fr)_12rem] @[36rem]:gap-6')}>
      <blockquote className="max-w-prose border-l-2 border-l-source-law/40 pl-4 italic leading-relaxed text-default [&_p]:mb-2 [&_p:last-child]:mb-0">
        {children}
      </blockquote>
      {source && <figcaption className="min-w-0 pl-4 @[36rem]:pl-0 @[36rem]:pt-0.5">{source}</figcaption>}
    </div>
  </figure>
)

/** The margin note itself: „Fundstelle", the document, its place, an action. */
export const ExcerptMargin: FC<{ title: ReactNode; locus?: ReactNode; action?: ReactNode }> = ({ title, locus, action }) => {
  const t = useTranslations('common')
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel as="p">{t('markdown.excerptSource')}</SectionLabel>
      <p className="card-caption break-words font-medium text-foreground">{title}</p>
      {locus && <div className="card-meta text-muted-foreground">{locus}</div>}
      {action && <div className="mt-0.5">{action}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Comparison, per variant (a phone)
// ---------------------------------------------------------------------------

/**
 * Below 30rem of the comparison's own width the columns do not fit, and a
 * sideways scroll hides the variants the reader came to compare. The table
 * gives way to one block per variant, each criterion under its name.
 */
export const CompareStackFrame: FC<{ children: ReactNode }> = ({ children }) => (
  <div data-testid="compare-stack" className="my-4 hidden flex-col gap-2 @max-[30rem]/compare:flex">
    {children}
  </div>
)

export const CompareVariantCard: FC<{ recommended: boolean; children: ReactNode }> = ({ recommended, children }) => (
  <section
    data-recommended={recommended ? 'true' : undefined}
    className={cn('flex flex-col gap-1.5 rounded-lg px-3.5 py-3', recommended ? 'bg-card shadow-xs ring-1 ring-border' : 'bg-muted/40')}
  >
    {children}
  </section>
)

export const CompareVariantTitle: FC<{ recommended: boolean; children: ReactNode }> = ({ recommended, children }) => {
  const t = useTranslations('common')
  return (
    <p className="card-title text-foreground">
      {children}
      {recommended && <MarkChip>{t('markdown.recommended')}</MarkChip>}
    </p>
  )
}

export const CompareVariantRow: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="grid grid-cols-[38%_minmax(0,1fr)] items-baseline gap-3 text-sm">{children}</div>
)

export const CompareVariantLabel: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="card-caption text-muted-foreground">{children}</span>
)

export const CompareVariantValue: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="min-w-0 text-foreground">{children}</span>
)

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export type TableVariant = 'plain' | 'check' | 'cases' | 'compare'

export const tableVariant = (value: unknown): TableVariant =>
  value === 'check' || value === 'cases' || value === 'compare' ? value : 'plain'

/** The frame around a table and its tally. A comparison gives way to its per-variant blocks on a phone. */
export const tableFrameClass = (variant: TableVariant): string =>
  cn('my-4 flex flex-col gap-2 [container:answer-table/inline-size]', variant === 'compare' && '@max-[30rem]/compare:hidden')

/**
 * Zebra rows and tabular figures. A row that holds keeps its tint over the
 * zebra. A comparison's first column (the criterion) stays in view while the
 * variants scroll.
 */
export const tableClass = (variant: TableVariant): string =>
  cn(
    'min-w-full caption-bottom tabular-nums [&>tbody>tr:nth-child(even):not([data-active]):not([data-conflict])]:bg-muted/30',
    variant === 'compare' &&
      '[&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-10 [&_td:first-child]:bg-card [&_th:first-child]:bg-muted'
  )

export const headerCellClass = ({ align, recommended }: { align: string; recommended: boolean }): string =>
  cn('text-foreground px-3 py-2 text-sm font-semibold', align, recommended && 'bg-success-subtle')

export const dataCellClass = ({ align, recommended }: { align?: string; recommended: boolean }): string =>
  cn('text-foreground px-3 py-2 text-sm', align, recommended && 'bg-success-subtle')

// ---------------------------------------------------------------------------
// Check outcomes
// ---------------------------------------------------------------------------

/** The renderer's own outcome words (`directive-shape.ts`), in the reader's language. */
export function useOutcomeLabel(): (word: string, where: 'cell' | 'tally') => string {
  const t = useTranslations('common')
  return (word, where) => {
    if (word === '@pass') return t('markdown.limitKept')
    if (word === '@fail') return t('markdown.limitMissed')
    if (word === '@conflict') return t(where === 'tally' ? 'markdown.tallyConflict' : 'markdown.outcomeConflict')
    return word
  }
}

/**
 * A check every row of which passes: one line that says so („4 von 4
 * erfüllt"), the rows behind it. Nothing to decide is not worth a screen.
 */
export const PassedCheck: FC<{ passed: number; children: ReactNode }> = ({ passed, children }) => {
  const t = useTranslations('common')
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-4">
      <CollapsibleTrigger
        data-testid="check-passed"
        className={disclosureRowClass({ current: false, open })}
        aria-label={`${t('markdown.allPassed', { passed, total: passed })} – ${t('markdown.showRows')}`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Chip size="md" variant="success">
            <CircleCheck aria-hidden="true" />
            {t('markdown.allPassed', { passed, total: passed })}
          </Chip>
          <span className="card-caption text-muted-foreground">{t('markdown.showRows')}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-quick ease-out motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  )
}
