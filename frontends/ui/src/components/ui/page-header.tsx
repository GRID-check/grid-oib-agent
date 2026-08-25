import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * PageHeader — the single, documented page-title block every content page opens
 * with (see `grid-design-language.md` §"Component patterns"). One primitive so
 * the title size stays on-spec (`text-xl`, the documented 20px) instead of the
 * drifted `text-2xl` copies each page hand-rolled.
 *
 * It is deliberately ONE line: a title, and the controls that act on the page.
 * There is no subtitle slot and no breadcrumb slot — both restated what the rail
 * and the title already say, and cost every page ~50px above its content.
 *
 * @example
 * <PageHeader title={t('title')} action={<Button>New project</Button>} />
 */
export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode
  /** Optional primary action rendered on the right of the header row. */
  action?: React.ReactNode
}

export function PageHeader({ title, action, className, ...props }: PageHeaderProps): JSX.Element {
  return (
    <header className={cn('flex min-w-0 items-center justify-between gap-4', className)} {...props}>
      <h1 className="min-w-0 text-balance text-xl font-semibold tracking-tight">{title}</h1>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  )
}
