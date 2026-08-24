import * as React from 'react'

import { Logo } from '@/components/brand/logo'
import { cn } from '@/lib/utils'

/**
 * Full-page status screen used by not-found / error / permission boundaries.
 * Calm, centered, branded — a real Piloti surface instead of an unstyled crash.
 */
export interface StatusScreenProps {
  code?: string
  title: string
  description: string
  actions?: React.ReactNode
  className?: string
}

export function StatusScreen({ code, title, description, actions, className }: StatusScreenProps) {
  return (
    <div
      className={cn(
        'flex min-h-dvh flex-col items-center justify-center bg-background px-6 text-center',
        className,
      )}
    >
      <Logo size="medium" className="mb-8" />
      {code && (
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{code}</p>
      )}
      <h1 className="mt-2 text-xl font-semibold tracking-tight text-foreground text-balance">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground text-balance">{description}</p>
      {actions && <div className="mt-6 flex items-center gap-3">{actions}</div>}
    </div>
  )
}
