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
    // `flex-wrap` + a real basis on the title is what keeps a crowded header
    // honest: with `min-w-0` alone the title shrank ahead of the controls and
    // "Files" rendered as "Fi" on a phone. The 8rem basis makes the ACTION wrap
    // to its own line first; only past that does the title truncate.
    <header className={cn('flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3', className)} {...props}>
      <h1 className="min-w-0 grow basis-32 truncate text-xl font-semibold tracking-tight">{title}</h1>
      {/* `max-w-full` is what lets a crowded action set wrap INSIDE itself once
          it has its own line — without it the row keeps its content width and
          runs off the edge of the band. */}
      {action ? <div className="ml-auto max-w-full shrink-0">{action}</div> : null}
    </header>
  )
}
