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

/**
 * The floor the title column refuses to go below, and the reason the action can
 * shrink at all.
 *
 * Stacking fixed the phone. It did not fix the laptop, because in the row the
 * old rule still held: the action was `sm:shrink-0`, so it kept its natural
 * width at every width above 640px and the title column was still the only
 * thing that could give. Project → Dateien is the case that shows it — a view
 * toggle, four filter chips, a `lg:w-72` search field and an upload button want
 * about 1100px, and inside a sidebar the header gets ~900px — so at 900px the
 * Dateien subtitle rendered as a one-to-two-word column beside a row that had
 * spare capacity it would not use.
 *
 * Two changes, and they only work together. The title gets a minimum, so the
 * squeeze stops at something readable rather than at one word. The action stops
 * being `shrink-0`, so it is the side that yields once the title is at its
 * floor — and yielding is not damage there, because these action rows are
 * `flex-wrap`: they answer a narrower box with a second line. That wrap was
 * already written and was dead code, since `shrink-0` meant the box was never
 * narrower than its content.
 *
 * 14rem is two-thirds of the widest section subtitle at `text-sm`: enough for
 * three or four words a line, which reads as a paragraph. Below `sm` it does
 * not apply — the row is stacked there and the title already owns the width.
 */
const TITLE_COLUMN_CLASS = 'min-w-0 sm:min-w-56'

export function PageHeader({
  title,
  subtitle,
  action,
  className,
  ...props
}: PageHeaderProps): JSX.Element {
  return (
    <header className={cn('min-w-0', TITLE_ROW_CLASS, className)} {...props}>
      <div className={TITLE_COLUMN_CLASS}>
        <h1 className="text-balance text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="mt-1 text-pretty text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {action ? <div className="min-w-0">{action}</div> : null}
    </header>
  )
}
