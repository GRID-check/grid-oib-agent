import * as React from 'react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * Shared empty-state. Every "there's nothing here yet" moment in the app uses
 * this so empty states are a crafted, consistent invitation — never bare text.
 *
 * @example
 * <EmptyState
 *   icon={FolderOpen}
 *   title="No files yet"
 *   description="Upload building documents so Piloti can ground its answers in your project."
 *   action={<Button>Upload files</Button>}
 * />
 */
export type EmptyStateDiscTone = 'muted' | 'destructive' | 'warning'
export type EmptyStateDiscSize = 'md' | 'sm'

const EMPTY_STATE_DISC_TONES: Record<EmptyStateDiscTone, string> = {
  muted: 'border bg-card text-muted-foreground/70',
  destructive: 'border-transparent bg-danger-subtle text-error',
  warning: 'border-transparent bg-warning-subtle text-warning',
}

/**
 * The raised icon disc shared by empty states and confirm dialogs — a disc
 * that catches the light (soft shadow) reads more considered than a flat
 * muted circle. `md` is the empty-state panel disc, `sm` the dialog disc;
 * both keep `shadow-sm`. Tones reuse the chip tint pairs.
 */
export function EmptyStateDisc({
  icon: Icon,
  tone = 'muted',
  size = 'md',
  className,
}: {
  icon: LucideIcon
  tone?: EmptyStateDiscTone
  size?: EmptyStateDiscSize
  className?: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex shrink-0 select-none items-center justify-center rounded-full shadow-sm',
        size === 'md' ? 'size-12' : 'size-9',
        EMPTY_STATE_DISC_TONES[tone],
        className
      )}
      aria-hidden="true"
    >
      <Icon className="size-5" aria-hidden />
    </div>
  )
}

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  /** 'panel' = bordered dashed card (default); 'bare' = no border, for use inside an existing card */
  variant?: 'panel' | 'bare'
  /** Icon-disc tone. Defaults to the muted panel disc. */
  tone?: EmptyStateDiscTone
  /** Icon-disc size. Defaults to the `size-12` panel disc. */
  size?: EmptyStateDiscSize
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = 'panel',
  tone = 'muted',
  size = 'md',
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-col items-center justify-center text-center',
        variant === 'panel' ? 'rounded-lg border border-dashed bg-muted/25 px-6 py-12' : 'py-10',
        // Staged entrance, CSS-only (this stays server-safe): the panel fades
        // in, the disc lands a beat later. Transform/opacity only, and the
        // parent already reserves the space, so no layout shift. `fade-in-0`
        // is the design language's content-entrance fade.
        'animate-in fade-in-0 duration-base ease-entrance motion-reduce:animate-none',
        className,
      )}
      {...props}
    >
      {Icon && (
        // The staged entrance keeps its own motion: the panel fades in, the
        // disc lands a beat later.
        <EmptyStateDisc
          icon={Icon}
          tone={tone}
          size={size}
          className="mb-4 animate-in zoom-in-95 duration-base ease-entrance motion-reduce:animate-none"
        />
      )}
      <p className="text-balance text-sm font-semibold tracking-tight text-foreground">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5 shrink-0">{action}</div>}
    </div>
  )
}
