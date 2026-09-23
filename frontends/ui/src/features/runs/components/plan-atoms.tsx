'use client'

/**
 * The research plan's own atom kit (ADR-0065). One decision each, no domain
 * logic: the organisms — `PlanChecklist` and `PlanUnterlagen` on the
 * block and in the „Recherche planen" dialog, `RunPlan` and `PlanDialog`
 * around them — compose these.
 *
 * The material follows the design language: ink and paper, hairlines, one
 * surface step. The only chroma is provenance, on the document chips, and it
 * never travels without its icon and label.
 */

import type { FC, ReactNode } from 'react'
import {
  Ban,
  Check,
  Circle,
  ClipboardCheck,
  Columns2,
  FileText,
  Gauge,
  Layers,
  ListChecks,
  NotebookPen,
  Plus,
  Timer,
  X,
  type LucideIcon,
} from 'lucide-react'
import { motion, motionEntrance } from '@/components/motion'
import { Progress } from '@/components/ui/progress'
import { StageTrack } from '@/components/ui/stage-track'
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
    <div className="bg-muted inline-flex w-fit shrink-0 gap-0.5 rounded-md p-0.5" role="radiogroup" aria-label={label}>
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
              'flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-xs font-medium pointer-coarse:h-11',
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
 * A line of named documents under its label — the plan's Schwerpunkt, its
 * „Nur diese", its exclusions — each strikable where the plan can still change.
 */
export const PlanDocLine: FC<{
  label: string
  docs: readonly PlanDocument[]
  excluded?: boolean
  removeLabel?: (label: string) => string
  onRemove?: (doc: PlanDocument) => void
  testId: string
}> = ({ label, docs, excluded = false, removeLabel, onRemove, testId }) =>
  docs.length === 0 ? null : (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      <span className="text-muted-foreground text-xs">{label}</span>
      {docs.map((doc) => (
        <PlanDocChip
          key={doc.name}
          doc={doc}
          excluded={excluded}
          removeLabel={removeLabel?.(planDocumentLabel(doc))}
          onRemove={onRemove ? () => onRemove(doc) : undefined}
        />
      ))}
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

/**
 * One step of the plan: a numeral, what the step decides, and the one line
 * that says what deciding it does. The numerals are the order a reader who
 * has never seen a plan walks it in; the line is so they need no manual.
 */
export const PlanStep: FC<{
  n: number
  title: string
  hint: string
  /** A quiet tag beside the title, „optional" where skipping is the default. */
  tag?: string
  /** Something at the header's end: a count, a toggle. */
  aside?: ReactNode
  testId?: string
  children?: ReactNode
}> = ({ n, title, hint, tag, aside, testId, children }) => (
  <section className="flex flex-col gap-2.5" data-testid={testId} aria-label={title}>
    <header className="flex items-start gap-2.5">
      <span
        className="border-foreground/70 text-foreground mt-px flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10.5px] font-medium tabular-nums"
        aria-hidden
      >
        {n}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-foreground text-sm font-semibold">{title}</span>
          {tag && (
            <span className="border-border text-muted-foreground rounded-full border px-1.5 py-px text-[10.5px] leading-none">
              {tag}
            </span>
          )}
        </span>
        <span className="text-muted-foreground text-xs leading-snug">{hint}</span>
      </span>
      {aside && <span className="shrink-0">{aside}</span>}
    </header>
    {children && <div className="pl-7.5">{children}</div>}
  </section>
)

/** Where a plan is in its life, as a track the reader can place it on. */
export type PlanStage = 'proposed' | 'held' | 'approved' | 'started'

export const PlanLifecycle: FC<{
  stage: PlanStage
  labels: { proposed: string; held: string; approved: string; started: string }
}> = ({ stage, labels }) => {
  const reached = stage === 'started' ? 2 : stage === 'approved' ? 1 : 0
  const words = [stage === 'held' ? labels.held : labels.proposed, labels.approved, labels.started]
  return (
    <div className="flex flex-col gap-1" data-testid="run-plan-lifecycle" data-stage={stage}>
      <StageTrack
        stages={['plan', 'freigabe', 'lauf']}
        reached={reached}
        active={stage !== 'held'}
        halted={stage === 'held'}
      />
      <span className="grid grid-cols-3 gap-1 text-[10.5px]">
        {words.map((word, index) => (
          <span
            key={word}
            className={cn(
              'truncate',
              index === reached ? 'text-foreground font-medium' : 'text-muted-foreground',
              index === 1 && 'text-center',
              index === 2 && 'text-right'
            )}
            aria-current={index === reached ? 'step' : undefined}
          >
            {word}
          </span>
        ))}
      </span>
    </div>
  )
}

/** A proposal the reader can take with one press: a dashed chip with a plus. */
export const SuggestionChip: FC<{ label: string; ariaLabel: string; onClick: () => void; disabled?: boolean }> = ({
  label,
  ariaLabel,
  onClick,
  disabled = false,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={ariaLabel}
    data-testid="plan-suggestion"
    className={cn(
      'border-border text-muted-foreground inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-dashed px-2.5 text-xs',
      'hover:text-foreground hover:border-foreground/40 hover:bg-accent/50 transition-colors duration-quick motion-reduce:transition-none',
      'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2 pointer-coarse:h-11',
      'disabled:pointer-events-none disabled:opacity-50'
    )}
  >
    <Plus className="size-3 shrink-0" aria-hidden />
    <span className="truncate">{label}</span>
  </button>
)

/** The dialog's preview pane: one quiet surface step, sticky beside the controls. */
export const PlanPreviewFrame: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <aside
    className="bg-muted/40 border-border flex h-fit flex-col gap-3 rounded-lg border p-3 md:sticky md:top-0"
    aria-label={label}
    data-testid="plan-dialog-preview"
  >
    <PlanEyebrow>{label}</PlanEyebrow>
    {children}
  </aside>
)

/** One thing a plan still needs, ticked when it has it. */
export const PlanRequirement: FC<{ met: boolean; label: string }> = ({ met, label }) => (
  <li className={cn('inline-flex items-center gap-1', met && 'text-foreground')} data-met={met || undefined}>
    {met ? <Check className="size-3.5" aria-hidden /> : <Circle className="size-3" aria-hidden />}
    {label}
  </li>
)

/** A line of small print closing a surface: what happens next. */
export const PlanNote: FC<{ children: ReactNode; ruled?: boolean }> = ({ children, ruled = false }) => (
  <p className={cn('text-muted-foreground text-[11px] leading-snug', ruled && 'border-border border-t pt-2.5')}>
    {children}
  </p>
)
