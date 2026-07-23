import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * PageHeader — the single, documented page-title block every content page opens
 * with (see `grid-design-language.md` §"Component patterns"). One primitive so
 * the title size stays on-spec (`text-xl`, the documented 20px) instead of the
 * drifted `text-2xl` copies each page hand-rolled.
 *
 * @example
 * <PageHeader
 *   title={t('title')}
 *   subtitle={t('subtitle')}
 *   action={<Button>New project</Button>}
 * />
 */
export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Optional primary action rendered on the right of the header row. */
  action?: React.ReactNode
}

export function PageHeader({ title, subtitle, action, className, ...props }: PageHeaderProps): JSX.Element {
  return (
    <header className={cn('flex items-end justify-between gap-4', className)} {...props}>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </header>
  )
}
