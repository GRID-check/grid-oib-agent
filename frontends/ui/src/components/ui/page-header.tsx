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

/**
 * Title beside action, but only once there is width for both.
 *
 * This was an unconditional row with a `shrink-0` action, which is a rule that a
 * phone cannot keep: the action takes its natural width — a 256px search field,
 * a toggle group — and the title column absorbs every pixel of the shortfall.
 * At 390px the Historie subtitle wrapped to one word per line beside its search
 * box. `projects-grid` had already worked around it with a local `flex-col
 * items-start sm:flex-row`; the primitive is where that belongs, since six
 * project sections reach this through `ProjectSectionFrame` and inherited none
 * of it.
 *
 * `sm:` and not `pointer-coarse:` on purpose: whether a title and a search field
 * fit side by side is a question about width, not about the pointer (see the
 * axis note in `grid-design-language.md`). Stacked, the action stretches so a
 * child's `w-full` has a real width to resolve against.
 */
const TITLE_ROW_CLASS =
  'flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4'

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
      <div className="min-w-0">
        <h1 className="text-balance text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="mt-1 text-pretty text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {action ? <div className="sm:shrink-0">{action}</div> : null}
    </>
  )

  return (
    <header
      className={cn(
        'min-w-0',
        breadcrumb ? 'flex flex-col gap-3' : TITLE_ROW_CLASS,
        className,
      )}
      {...props}
    >
      {breadcrumb}
      {breadcrumb ? <div className={TITLE_ROW_CLASS}>{titleRow}</div> : titleRow}
    </header>
  )
}
