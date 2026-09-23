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
 *
 * Motion lives here too, so every surface that composes these moves the same
 * way (`docs/design/run-block.md`, *Motion*):
 *
 * - a section or a chip ARRIVES with a fade and a short rise on the entrance
 *   curve, and LEAVES one step shorter on the exit curve; its neighbours glide
 *   to their new places (`layout`, a tween: the travel is a row, not a panel);
 * - a mark that lands under the reader's hand — the tile's check, a met
 *   requirement, the genre's glyph — lands on `springSnap`, all under 24px;
 * - the chosen segment's pill travels on the kit's `ToggleGroup`;
 * - the countdown drains as a clock (`motionCountdown`), not in steps.
 *
 * Provenance (the document chips) never springs: it is a tween, like every
 * other evidentiary mark.
 */

import { forwardRef, useEffect, useRef, type FC, type ReactNode } from 'react'
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
import {
  AnimatePresence,
  motion,
  motionBase,
  motionCountdown,
  motionEntrance,
  motionQuick,
  motionQuickExit,
  springSnap,
  staggerMaxSteps,
  staggerStepSeconds,
  useReducedMotion,
} from '@/components/motion'
import { StageTrack } from '@/components/ui/stage-track'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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
      className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md"
      aria-hidden
    >
      {/* A new genre's glyph lands in the well: a 16px icon, inside springSnap's 24px. */}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={genre}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1, transition: springSnap }}
          exit={{ opacity: 0, scale: 0.6, transition: motionQuickExit }}
          className="flex"
        >
          <Icon className="size-4" />
        </motion.span>
      </AnimatePresence>
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

/** Keys that survive an edit: the section's text, and which occurrence of it. */
function stableKeys(items: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const n = seen.get(item) ?? 0
    seen.set(item, n + 1)
    return `${item}\u0000${n}`
  })
}

/**
 * The sections as an outline: numbered discs on a hairline rail, the way a
 * report's table of contents reads. `limit` folds a long outline into its
 * first rows and a „+n" line; `action` puts a control at a row's end; a
 * trailing `footer` row carries the add field in the editor.
 *
 * Motion: the rows that are there when the outline first paints arrive as a
 * capped cascade (a reading cue, done inside 200ms). After that, a row added
 * rises in where it lands, a struck row folds away to the left, and the rows
 * below glide up into its place — so the reader sees which one went.
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
  const keys = stableKeys(shown)
  const painted = useRef(false)
  const reduced = useReducedMotion()
  useEffect(() => {
    painted.current = true
  }, [])
  const delay = (index: number): number =>
    painted.current || reduced ? 0 : Math.min(index, staggerMaxSteps) * staggerStepSeconds
  return (
    <ol className="relative flex flex-col" aria-label={label} data-testid={testId}>
      {/* The rail: one hairline behind the discs, so the list reads as one sequence. */}
      <span className="bg-border absolute bottom-3 left-[9.5px] top-3 w-px" aria-hidden />
      <AnimatePresence initial={!reduced} mode="popLayout">
        {shown.map((item, index) => (
          <motion.li
            key={keys[index]}
            layout="position"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0, transition: { ...motionEntrance, delay: delay(index) } }}
            exit={{ opacity: 0, x: -8, transition: motionQuickExit }}
            transition={{ layout: motionBase }}
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
          <motion.li
            key="more"
            layout="position"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: motionQuick }}
            exit={{ opacity: 0, transition: motionQuickExit }}
            transition={{ layout: motionBase }}
            className="text-muted-foreground relative flex min-h-6 items-center gap-2.5 text-xs"
          >
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
          </motion.li>
        )}
        {footer && (
          <motion.li
            key="footer"
            layout="position"
            transition={{ layout: motionBase }}
            className="relative flex min-h-8 items-center gap-2.5 pt-1"
          >
            {footer}
          </motion.li>
        )}
      </AnimatePresence>
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
      <AnimatePresence initial={false}>
        {selected && (
          <motion.span
            key="check"
            className="ml-auto flex"
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1, transition: springSnap }}
            exit={{ opacity: 0, scale: 0.4, transition: motionQuickExit }}
            aria-hidden
          >
            <Check className="text-foreground size-3.5" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
    <span className="text-muted-foreground text-xs leading-snug">{hint}</span>
  </button>
)

export const OptionTiles: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={label}>
    {children}
  </div>
)

/**
 * Two or three options in one well, the chosen one on a pill that travels to
 * it — the kit's segmented `ToggleGroup`, so this control moves exactly like
 * every other segmented control in the product.
 */
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
    <ToggleGroup
      type="single"
      segmented
      variant="outline"
      size="sm"
      value={value}
      disabled={disabled}
      aria-label={label}
      // Radix clears a single group when its chosen item is pressed again;
      // a segmented choice always has one, so that press changes nothing.
      onValueChange={(next) => next && onPick(next as T)}
      className="shrink-0 bg-muted"
    >
      {options.map(({ value: option, label: optionLabel, icon: Icon }) => (
        <ToggleGroupItem key={option} value={option} aria-label={optionLabel} className="h-7 gap-1.5 px-2.5">
          <Icon className="size-3.5" aria-hidden />
          {optionLabel}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/**
 * The grace running out: a bar that drains as the plan's clock runs down,
 * with the words beside it. Determinate, so it is progress, not an ambient loop.
 */
export const CountdownBar: FC<{
  /** How much of the grace is left when the bar mounts, 0–1. */
  remaining: number
  /** Seconds until the clock runs out; the bar drains over exactly these. */
  seconds: number
  label: string
}> = ({ remaining, seconds, label }) => {
  const start = Math.max(0, Math.min(1, remaining))
  return (
    <div className="flex items-center gap-2.5" data-testid="run-plan-countdown">
      <Timer className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <div
        className="bg-secondary relative h-1 flex-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(start * 100)}
      >
        {/* Set once and left to run: from where the grace stands to empty,
            at the rate time passes (`motionCountdown`). A re-render does not
            restart it — its target never changes. */}
        <motion.span
          className="bg-foreground absolute inset-0 origin-left rounded-full"
          initial={{ scaleX: start }}
          animate={{ scaleX: 0 }}
          transition={motionCountdown(seconds)}
        />
      </div>
    </div>
  )
}

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
}> = ({ label, docs, excluded = false, removeLabel, onRemove, testId }) => (
  <AnimatePresence initial={false}>
    {docs.length > 0 && (
      <motion.div
        key="line"
        layout="position"
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0, transition: motionEntrance }}
        exit={{ opacity: 0, transition: motionQuickExit }}
        transition={{ layout: motionBase }}
        className="flex flex-wrap items-center gap-1.5"
        data-testid={testId}
      >
        <span className="text-muted-foreground text-xs">{label}</span>
        {/* Provenance is evidence: chips come and go on tweens, never a spring. */}
        <AnimatePresence initial={false} mode="popLayout">
          {docs.map((doc) => (
            <motion.span
              key={doc.name}
              layout="position"
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1, transition: motionQuick }}
              exit={{ opacity: 0, scale: 0.94, transition: motionQuickExit }}
              transition={{ layout: motionBase }}
              className="inline-flex max-w-full"
            >
              <PlanDocChip
                doc={doc}
                excluded={excluded}
                removeLabel={removeLabel?.(planDocumentLabel(doc))}
                onRemove={onRemove ? () => onRemove(doc) : undefined}
              />
            </motion.span>
          ))}
        </AnimatePresence>
      </motion.div>
    )}
  </AnimatePresence>
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
export const SuggestionChip = forwardRef<
  HTMLButtonElement,
  { label: string; ariaLabel: string; onClick: () => void; disabled?: boolean }
>(({ label, ariaLabel, onClick, disabled = false }, ref) => (
  <motion.button
    ref={ref}
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={ariaLabel}
    data-testid="plan-suggestion"
    layout="position"
    initial={{ opacity: 0, scale: 0.94 }}
    animate={{ opacity: 1, scale: 1, transition: motionQuick }}
    exit={{ opacity: 0, scale: 0.94, transition: motionQuickExit }}
    transition={{ layout: motionBase }}
    className={cn(
      'border-border text-muted-foreground inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-dashed px-2.5 text-xs',
      'hover:text-foreground hover:border-foreground/40 hover:bg-accent/50 transition-colors duration-quick motion-reduce:transition-none',
      'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2 pointer-coarse:h-11',
      'disabled:pointer-events-none disabled:opacity-50'
    )}
  >
    <Plus className="size-3 shrink-0" aria-hidden />
    <span className="truncate">{label}</span>
  </motion.button>
))
SuggestionChip.displayName = 'SuggestionChip'

/**
 * The suggestions beside an outline: a label and the chips, each chip leaving
 * as it is taken while the row it became rises into the outline above.
 */
export const PlanSuggestions: FC<{ label: string; show: boolean; children: ReactNode }> = ({ label, show, children }) => (
  <AnimatePresence initial={false}>
    {show && (
      <motion.div
        key="suggestions"
        layout="position"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: motionQuick }}
        exit={{ opacity: 0, transition: motionQuickExit }}
        transition={{ layout: motionBase }}
        className="flex flex-wrap items-center gap-1.5"
        data-testid="plan-suggestions"
      >
        <span className="text-muted-foreground text-xs">{label}</span>
        <AnimatePresence initial={false} mode="popLayout">
          {children}
        </AnimatePresence>
      </motion.div>
    )}
  </AnimatePresence>
)

/** An outline with no rows yet: what to do about it, in a dashed well that leaves once it is done. */
export const PlanEmptyOutline: FC<{ show: boolean; hint: string; children: ReactNode }> = ({ show, hint, children }) => (
  <AnimatePresence initial={false}>
    {show && (
      <motion.div
        key="empty"
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0, transition: motionEntrance }}
        exit={{ opacity: 0, transition: motionQuickExit }}
        className="border-border flex flex-col items-start gap-2 rounded-md border border-dashed px-3 py-3"
      >
        <span className="text-muted-foreground text-xs">{hint}</span>
        {children}
      </motion.div>
    )}
  </AnimatePresence>
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
  <li
    className={cn('inline-flex items-center gap-1 transition-colors duration-quick ease-out', met && 'text-foreground')}
    data-met={met || undefined}
  >
    <span className="relative flex size-3.5 items-center justify-center" aria-hidden>
      <AnimatePresence mode="popLayout" initial={false}>
        {met ? (
          <motion.span
            key="met"
            className="flex"
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1, transition: springSnap }}
            exit={{ opacity: 0, transition: motionQuickExit }}
          >
            <Check className="size-3.5" />
          </motion.span>
        ) : (
          <motion.span
            key="open"
            className="flex"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: motionQuick }}
            exit={{ opacity: 0, transition: motionQuickExit }}
          >
            <Circle className="size-3" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
    {label}
  </li>
)

/** One of the block's actions: arrives and leaves on its own, the others glide over. */
export const PlanAction = forwardRef<HTMLSpanElement, { children: ReactNode }>(({ children }, ref) => (
  <motion.span
    ref={ref}
    layout="position"
    initial={{ opacity: 0, scale: 0.96 }}
    animate={{ opacity: 1, scale: 1, transition: motionQuick }}
    exit={{ opacity: 0, scale: 0.96, transition: motionQuickExit }}
    transition={{ layout: motionBase }}
    className="flex"
  >
    {children}
  </motion.span>
))
PlanAction.displayName = 'PlanAction'

/** A line of small print closing a surface: what happens next. */
export const PlanNote: FC<{ children: ReactNode; ruled?: boolean }> = ({ children, ruled = false }) => (
  <p className={cn('text-muted-foreground text-[11px] leading-snug', ruled && 'border-border border-t pt-2.5')}>
    {children}
  </p>
)
