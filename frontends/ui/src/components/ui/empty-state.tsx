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
 *   description="Upload building documents so Grid can ground its answers in your project."
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
        'flex flex-col items-center justify-center text-center',
        variant === 'panel' ? 'rounded-2xl border border-dashed bg-muted/30 px-6 py-14' : 'py-10',
        className,
      )}
      {...props}
    >
      {Icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted shadow-2xs">
          <Icon className="size-5 text-muted-foreground" aria-hidden />
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground text-balance">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
