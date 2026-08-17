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
  /** Optional trail rendered above the title row. Absent = today's DOM. */
  breadcrumb?: React.ReactNode
}

export function PageHeader({
  title,
  subtitle,
  action,
  breadcrumb,
  className,
  ...props
}: PageHeaderProps): JSX.Element {
  const titleRow = (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </>
  )

  return (
    <header
      className={cn(breadcrumb ? 'flex flex-col gap-3' : 'flex items-end justify-between gap-4', className)}
      {...props}
    >
      {breadcrumb}
      {breadcrumb ? <div className="flex items-end justify-between gap-4">{titleRow}</div> : titleRow}
    </header>
  )
}
