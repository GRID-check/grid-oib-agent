'use client'

/**
 * The viewport when there is no building to show.
 *
 * Four different situations end here — no WebGPU, no adapter, a failed
 * extraction, a project with no model at all — and the thing they have in
 * common is that each is a DIFFERENT fact and the reader must be able to tell
 * which. A shared "something went wrong" is what makes a user believe their
 * upload vanished.
 *
 * So the atom takes a title and a description and renders them plainly, and
 * the callers are responsible for saying the true one. The optional `detail`
 * is where a raw error message goes: support needs it, the reader does not,
 * and it is set at a size that says so.
 */

import { type ComponentType, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ViewerNoticeProps {
  icon: ComponentType<{ className?: string }>
  title: string
  description?: string
  /** The raw reason, for a support conversation. Rendered quietly. */
  detail?: string
  /** One way forward, when there is one. */
  action?: ReactNode
  className?: string
}

export function ViewerNotice({
  icon: Icon,
  title,
  description,
  detail,
  action,
  className,
}: ViewerNoticeProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex size-full flex-col items-center justify-center gap-2 p-8 text-center',
        className
      )}
    >
      <Icon className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="max-w-prose text-sm text-balance text-muted-foreground">{description}</p>
      )}
      {detail && <p className="max-w-prose text-xs text-muted-foreground/80">{detail}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
