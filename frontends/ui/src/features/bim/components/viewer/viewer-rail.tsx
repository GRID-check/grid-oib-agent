'use client'

/**
 * The slim card on the left: which model, and which level.
 *
 * Two lists and nothing else. This is the one place the redesign kept a panel,
 * and it earns it by answering the only two questions a reader has BEFORE they
 * have clicked anything — "is this the right building?" and "can I see just
 * this floor?" Everything that describes an element waits until an element is
 * selected, and everything analytical waits behind one button.
 *
 * A floating card inset from the edge rather than a docked column, so the
 * canvas stays edge to edge underneath it. The model is the surface; the rail
 * is something lying on top of it.
 *
 * Composed entirely from the atoms — `ViewerSurface` for the material,
 * `ViewerRailItem` for every row — so a new section cannot introduce a fourth
 * kind of list row.
 */

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ViewerSurface } from './viewer-surface'
import { ViewerSectionHeader } from './viewer-panel'

export interface ViewerRailProps {
  children: ReactNode
  className?: string
}

export function ViewerRail({ children, className }: ViewerRailProps): JSX.Element {
  return (
    <ViewerSurface
      className={cn(
        // ONE scroller for the whole card, not one per section.
        //
        // Each section used to cap itself at `max-h-52` with its own overflow,
        // which produced two independent scrollbars inside a 14 rem card and —
        // worse — let a section's content run past its own bottom border, so
        // the divider drew straight through a model name. A building with
        // forty storeys is one long list; scrolling it as one is both simpler
        // and what a reader expects.
        // The fade says "there is more" without a scrollbar. A hard cut across
        // a half-height row reads as a rendering fault; a fade reads as a list.
        'scroll-fade-bottom flex max-h-[calc(100%-1.5rem)] w-52 flex-col overflow-y-auto overscroll-contain',
        'animate-in fade-in-0 slide-in-from-left-2 duration-base ease-entrance motion-reduce:animate-none',
        className
      )}
    >
      {children}
    </ViewerSurface>
  )
}

export interface ViewerRailSectionProps {
  /** The section's heading — visible, and the group's accessible name. */
  label: string
  /** A control belonging to the heading row, e.g. "show all levels". */
  action?: ReactNode
  children: ReactNode
}

/**
 * One titled group of rows.
 *
 * The heading is a real `<h3>` inside a labelled group, not a styled `div`:
 * this card is the viewport's only landmark, and a screen-reader user arriving
 * at it should be able to tell the model list from the level list without
 * reading every row.
 */
export function ViewerRailSection({ label, action, children }: ViewerRailSectionProps): JSX.Element {
  return (
    <section aria-label={label} className="border-border shrink-0 border-b last:border-b-0">
      <ViewerSectionHeader className="justify-between">
        {/*
          Sentence case, not uppercase. Shouted micro-labels are a habit from
          dashboards, and this rail is a list of buildings and floors — the
          reference this design follows labels the same thing "Models" and
          "Layers", quietly.
        */}
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide">{label}</h3>
        {action}
      </ViewerSectionHeader>
      <div className="px-1.5 pb-2">{children}</div>
    </section>
  )
}

export interface ViewerRailItemProps {
  label: string
  /** Right-aligned secondary text: an elevation, an element count, a status. */
  meta?: ReactNode
  /** Leading glyph. Absent is fine — a level list reads better without one. */
  icon?: ReactNode
  selected?: boolean
  disabled?: boolean
  onClick?: () => void
  /** Overrides the accessible name when `label` alone would be ambiguous. */
  ariaLabel?: string
  'data-testid'?: string
}

/**
 * One selectable row.
 *
 * `aria-pressed` rather than `aria-selected`: these are toggles in a group of
 * buttons, not options in a listbox, and claiming listbox semantics without
 * listbox keyboard behaviour (arrow-key roving focus, type-ahead) is worse for
 * a screen-reader user than the plain button this actually is.
 *
 * The selected row is a filled surface, not a coloured one. Colour in this app
 * carries provenance — blue means Rechtsquelle — so a blue "selected" row here
 * would be making a claim about where the model came from.
 */
export function ViewerRailItem({
  label,
  meta,
  icon,
  selected = false,
  disabled = false,
  onClick,
  ariaLabel,
  ...rest
}: ViewerRailItemProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={ariaLabel}
      title={label}
      data-testid={rest['data-testid']}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm font-medium',
        // Weight is stable: toggling `font-medium` on the selected row reflows
        // the truncated name. Colour + fill already say which row is on.
        'transition-colors duration-quick ease-out',
        'focus-visible:ring-ring/60 outline-none focus-visible:ring-2',
        // `min-h-11` as well as the padding: 20 px of padding on a 14 px line
        // comes to ~38 px, six short of the floor the repo asserts in
        // `touch-target.spec.ts`. A level list on a forty-storey model is
        // exactly where a mis-tap costs the reader the wrong isolation.
        'pointer-coarse:min-h-11 pointer-coarse:py-2.5',
        // Hover sits BELOW selected on the surface ladder, which is what keeps
        // them distinguishable without an alpha: the selected row is the solid
        // card surface with the tab shadow (the Tabs HERE-semantics), hover is
        // the muted wash. Colour carries provenance here — blue means
        // Rechtsquelle — so a coloured "selected" row would be making a claim
        // about where the model came from.
        selected ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        disabled && 'pointer-events-none opacity-50'
      )}
    >
      {icon && <span className="shrink-0 [&_svg]:size-3.5">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{meta}</span>}
    </button>
  )
}
