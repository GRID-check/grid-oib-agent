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

/**
 * Title beside action, but only once there is width for both.
 *
 * This was an unconditional row with a `shrink-0` action, which is a rule that a
 * phone cannot keep: the action takes its natural width — a 256px search field,
 * a toggle group — and the title column absorbs every pixel of the shortfall.
 * Files rendered as "Fi" at 390px beside its control set. `projects-grid` had
 * already worked around it with a local `flex-col items-start sm:flex-row`; the
 * primitive is where that belongs, since six project sections reach this through
 * `ProjectSectionFrame` and inherited none of it.
 *
 * `sm:` and not `pointer-coarse:` on purpose: whether a title and a search field
 * fit side by side is a question about width, not about the pointer (see the
 * axis note in `grid-design-language.md`). Stacked, the action stretches so a
 * child's `w-full` has a real width to resolve against.
 *
 * `sm:items-center`, where this row once used `items-end`: that alignment existed
 * to drop the action to the baseline of a two-line title-plus-subtitle block.
 * With the subtitle gone the left column is one line, and centre is the only
 * alignment that reads level.
 */
const TITLE_ROW_CLASS =
  'flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4'

export function PageHeader({ title, action, className, ...props }: PageHeaderProps): JSX.Element {
  return (
    <header className={cn(TITLE_ROW_CLASS, className)} {...props}>
      {/* `truncate` guards the case stacking does not: a narrow DESKTOP, where
          the row still applies and a crowded action would otherwise eat the
          title character by character. */}
      <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{title}</h1>
      {action ? <div className="sm:shrink-0">{action}</div> : null}
    </header>
  )
}
