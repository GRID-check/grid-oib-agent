'use client'

/**
 * The research plan's own atom kit (ADR-0065). One decision each, no domain
 * logic: the organisms — `PlanChecklist` on the block and in the „Recherche
 * planen" dialog, `RunPlan` around it — compose these and reach for no
 * Tailwind of their own.
 *
 * The material follows the design language: ink and paper, hairlines, one
 * surface step. The only chroma is provenance, on the document chips, and it
 * never travels without its icon and label.
 */

import type { FC, ReactNode } from 'react'
import {
  Ban,
  Check,
  ClipboardCheck,
  Columns2,
  FileText,
  Gauge,
  Layers,
  ListChecks,
  NotebookPen,
  Timer,
  X,
  type LucideIcon,
} from 'lucide-react'
import { motion, motionEntrance } from '@/components/motion'
import { Progress } from '@/components/ui/progress'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import type { PlanDepth, PlanGenre } from '@/lib/plans/plan-types'
import { planDocumentLabel, type PlanDocument } from '@/lib/runs/plan-documents'
import { cn } from '@/lib/utils'
import { docProvenance } from '../lib/doc-provenance'

/** What each genre looks like at a glance. Icons carry the kind, never colour. */
export const GENRE_ICON: Record<PlanGenre, LucideIcon> = {
  pruefbericht: ClipboardCheck,
  aktenvermerk: NotebookPen,
  vergleich: Columns2,
  checkliste: ListChecks,
  bericht: FileText,
}

export const DEPTH_ICON: Record<PlanDepth, LucideIcon> = {
  kurzpruefung: Gauge,
  gutachten: Layers,
}

/** The uppercase label the design language uses above a group. */
export const PlanEyebrow: FC<{ children: ReactNode; className?: string }> = ({ children, className }) => (
  <span
    className={cn('text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider', className)}
  >
    {children}
  </span>
)

/** A group of the plan: an eyebrow and what it labels. */
export const PlanGroup: FC<{ label: string; children: ReactNode; testId?: string }> = ({
  label,
  children,
  testId,
}) => (
  <section className="flex flex-col gap-2" data-testid={testId} aria-label={label}>
    <PlanEyebrow>{label}</PlanEyebrow>
    {children}
  </section>
)

/** The genre as the plan's emblem: its glyph in a quiet well. */
export const GenreWell: FC<{ genre: PlanGenre }> = ({ genre }) => {
  const Icon = GENRE_ICON[genre]
  return (
    <span
      className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-md"
      aria-hidden
    >
      <Icon className="size-4" />
    </span>
  )
}

/**
 * One line of facts, each an icon and a word. The icons are the separators:
 * a middot would start the second line when the facts wrap.
 */
export const PlanFacts: FC<{ facts: { icon: LucideIcon; label: string }[] }> = ({ facts }) => (
  <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
    {facts.map(({ icon: Icon, label }) => (
      <span key={label} className="inline-flex items-center gap-1">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
      </span>
    ))}
  </span>
)

/**
 * The sections as an outline: numbered discs on a hairline rail, the way a
 * report's table of contents reads. `limit` folds a long outline into its
 * first rows and a „+n" line; `action` puts a control at a row's end; a
 * trailing `footer` row carries the add field in the editor.
 */
export const OutlineRail: FC<{
  items: readonly string[]
  limit?: number
  moreLabel?: (count: number) => string
  /** Unfold the rest; the „+n" row becomes a button when given. */
  onMore?: () => void
  action?: (index: number, item: string) => ReactNode
  footer?: ReactNode
  itemTestId?: string
  testId?: string
  label: string
}> = ({ items, limit, moreLabel, onMore, action, footer, itemTestId, testId, label }) => {
  const shown = limit !== undefined ? items.slice(0, limit) : items
  const hidden = items.length - shown.length
  return (
    <ol className="relative flex flex-col" aria-label={label} data-testid={testId}>
      {/* The rail: one hairline behind the discs, so the list reads as one sequence. */}
      <span className="bg-border absolute bottom-3 left-[9.5px] top-3 w-px" aria-hidden />
      {shown.map((item, index) => (
        <motion.li
          key={`${index}-${item}`}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...motionEntrance, delay: Math.min(index, 6) * 0.03 }}
          className="relative flex min-h-7 items-center gap-2.5 py-0.5"
          data-testid={itemTestId}
        >
          <span
            className="bg-card border-border text-muted-foreground relative flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10.5px] tabular-nums"
            aria-hidden
          >
            {index + 1}
          </span>
          <span className="text-foreground min-w-0 flex-1 text-sm leading-snug">{item}</span>
          {action?.(index, item)}
        </motion.li>
      ))}
      {hidden > 0 && moreLabel && (
        <li className="text-muted-foreground relative flex min-h-6 items-center gap-2.5 text-xs">
          <span className="bg-card border-border relative size-5 shrink-0 rounded-full border border-dashed" aria-hidden />
          {onMore ? (
            <button
              type="button"
              onClick={onMore}
              className="hover:text-foreground focus-visible:ring-ring/60 rounded-md underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2"
            >
              {moreLabel(hidden)}
            </button>
          ) : (
            moreLabel(hidden)
          )}
        </li>
      )}
      {footer && <li className="relative flex min-h-8 items-center gap-2.5 pt-1">{footer}</li>}
    </ol>
  )
}

/** The dashed disc that marks the outline's open end, where a section is added. */
export const OutlineAddDisc: FC = () => (
  <span
    className="bg-card border-border text-muted-foreground relative flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed"
    aria-hidden
  >
    <span className="text-[11px] leading-none">+</span>
  </span>
)

/** The quiet × at a row's end. */
export const RowRemove: FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring/60 flex size-6 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 pointer-coarse:size-11"
  >
    <X className="size-3.5" aria-hidden />
  </button>
)

/**
 * One option as a tile: glyph, name, and the one line that says what choosing
 * it means. Selection is contrast — an ink hairline and a check — never chroma.
 */
export const OptionTile: FC<{
  icon: LucideIcon
  label: string
  hint: string
  selected: boolean
  disabled?: boolean
  onSelect: () => void
}> = ({ icon: Icon, label, hint, selected, disabled = false, onSelect }) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    disabled={disabled}
    onClick={onSelect}
    className={cn(
      'bg-card relative flex min-h-16 flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left',
      'transition-[border-color,box-shadow,background-color] duration-quick ease-out motion-reduce:transition-none',
      'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
      selected ? 'border-foreground shadow-xs' : 'border-border hover:bg-accent/60',
      disabled && 'cursor-default opacity-60 hover:bg-card'
    )}
  >
    <span className="flex w-full items-center gap-1.5">
      <Icon className={cn('size-4 shrink-0', selected ? 'text-foreground' : 'text-muted-foreground')} aria-hidden />
      <span className="text-foreground text-sm font-medium">{label}</span>
      {selected && <Check className="text-foreground ml-auto size-3.5" aria-hidden />}
    </span>
    <span className="text-muted-foreground text-xs leading-snug">{hint}</span>
  </button>
)

export const OptionTiles: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={label}>
    {children}
  </div>
)

/** Two or three options in one well, the chosen one raised onto the card. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  disabled = false,
  onPick,
}: {
  label: string
  options: readonly { value: T; label: string; icon: LucideIcon }[]
  value: T
  disabled?: boolean
  onPick: (value: T) => void
}): JSX.Element {
  return (
    <div className="bg-muted inline-flex w-fit gap-0.5 rounded-md p-0.5" role="radiogroup" aria-label={label}>
      {options.map(({ value: option, label: optionLabel, icon: Icon }) => {
        const selected = option === value
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onPick(option)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium pointer-coarse:h-11',
              'transition-[background-color,color,box-shadow] duration-quick ease-out motion-reduce:transition-none',
              'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
              selected ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
              disabled && 'cursor-default'
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {optionLabel}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The grace running out: a bar that drains as the plan's clock runs down,
 * with the words beside it. Determinate, so it is progress, not an ambient loop.
 */
export const CountdownBar: FC<{ remaining: number; label: string }> = ({ remaining, label }) => (
  <div className="flex items-center gap-2.5" data-testid="run-plan-countdown">
    <Timer className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
    <Progress
      value={Math.max(0, Math.min(100, remaining * 100))}
      className="h-1 flex-1"
      aria-label={label}
    />
  </div>
)

/**
 * A named document: in its provenance family when it is read, struck through
 * in grey when it is excluded. Removable where the plan can still change.
 */
export const PlanDocChip: FC<{
  doc: PlanDocument
  excluded?: boolean
  removeLabel?: string
  onRemove?: () => void
}> = ({ doc, excluded = false, removeLabel, onRemove }) => {
  const label = planDocumentLabel(doc)
  const remove = onRemove ? (
    <button
      type="button"
      onClick={onRemove}
      aria-label={removeLabel}
      className="-mr-1 ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <X className="size-3" aria-hidden />
    </button>
  ) : null
  if (excluded) {
    return (
      <span
        className="border-border bg-muted text-muted-foreground inline-flex h-6 max-w-full items-center gap-1 rounded-full border px-2.5 text-xs font-medium"
        title={doc.name}
      >
        <Ban className="size-3 shrink-0" aria-hidden />
        <span className="truncate line-through">{label}</span>
        {remove}
      </span>
    )
  }
  return (
    <SourceSignalChip signal={docProvenance(doc).tint} title={doc.name}>
      <span className="truncate">{label}</span>
      {remove}
    </SourceSignalChip>
  )
}
