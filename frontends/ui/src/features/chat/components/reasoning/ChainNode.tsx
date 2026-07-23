/**
 * ChainNode — one node in the reasoning chain: a folder-tab strip sitting on a
 * card, revealed with the shared `nodeIn` entrance (click-dummy Herleitung).
 *
 * The tab tints from the `--source-*` family when a `signal` is given (reusing
 * `sourceSignalStyle` so it never drifts from the provenance chips), is neutral
 * (`--muted`) otherwise, or an outlined card-tab for the `outlined` variant.
 * Entrance reuses the existing tw-animate-css utilities with a per-node
 * `animationDelay` stagger; `prefers-reduced-motion` is honoured globally and
 * via `motion-reduce:animate-none`.
 */

import type { FC, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sourceSignalStyle } from '@/features/layout/components/SourceSignalChip'
import type { SourceSignal } from '@/features/layout/lib/source-presets'

export interface ChainNodeProps {
  tabLabel: string
  tabIcon: LucideIcon
  /** Provenance tint for the tab; omit for a neutral gray tab. */
  signal?: SourceSignal
  /** `outlined` = card-colored tab with a hairline (Folgewege style). */
  variant?: 'tinted' | 'outlined'
  /** 0-based reveal order → staggered entrance delay. */
  order?: number
  /** Constrain the card column width (mock uses 520/600/680). */
  maxWidthClassName?: string
  className?: string
  children: ReactNode
}

export const ChainNode: FC<ChainNodeProps> = ({
  tabLabel,
  tabIcon: Icon,
  signal,
  variant = 'tinted',
  order = 0,
  maxWidthClassName = 'max-w-[600px]',
  className,
  children,
}) => {
  const tinted = signal ? sourceSignalStyle(signal) : undefined
  const iconColor = signal ? `var(--source-${signal})` : undefined

  return (
    <div
      className={cn(
        // Left-aligned (never mx-auto): every node shares one clean left edge on
        // the timeline rail instead of centering at its own max-width, which used
        // to make the stack zig-zag. The max-width still caps the reading measure.
        'flex w-full flex-col',
        'animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none',
        maxWidthClassName,
        className
      )}
      style={{ animationDelay: `${order * 80}ms`, animationFillMode: 'both' }}
    >
      <span
        className={cn(
          'ml-3.5 inline-flex items-center gap-1.5 self-start rounded-t-md px-2.5 py-1',
          'text-[10.5px] font-semibold uppercase tracking-[0.05em]',
          variant === 'outlined'
            ? 'border border-b-0 bg-card text-foreground/80'
            : signal
              ? ''
              : 'bg-muted text-muted-foreground'
        )}
        style={
          variant === 'outlined'
            ? undefined
            : tinted
              ? { backgroundColor: tinted.backgroundColor, color: tinted.color }
              : undefined
        }
      >
        <Icon className="size-2.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} aria-hidden="true" />
        {tabLabel}
      </span>
      <div className="rounded-xl border bg-card px-4 py-3 shadow-xs">{children}</div>
    </div>
  )
}
