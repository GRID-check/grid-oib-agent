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
export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  /** 'panel' = bordered dashed card (default); 'bare' = no border, for use inside an existing card */
  variant?: 'panel' | 'bare'
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = 'panel',
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-col items-center justify-center text-center',
        variant === 'panel' ? 'rounded-2xl border border-dashed bg-muted/25 px-6 py-12' : 'py-10',
        className,
      )}
      {...props}
    >
      {Icon && (
        // A raised disc that catches the light (border + card surface + soft
        // shadow) reads more considered than a flat muted circle.
        <div className="mb-4 flex size-12 shrink-0 select-none items-center justify-center rounded-full border bg-card text-muted-foreground/70 shadow-sm">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <p className="text-balance text-[15px] font-semibold tracking-tight text-foreground">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5 shrink-0">{action}</div>}
    </div>
  )
}
