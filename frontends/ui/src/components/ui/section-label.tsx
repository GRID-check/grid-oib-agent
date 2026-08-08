import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * SectionLabel — the uppercase ~10.5px eyebrow/section-label convention (wide
 * tracking, muted ink) from `grid-design-language.md` §"Type ramp". One
 * primitive so the ~39 hand-rolled eyebrows stop drifting across four tracking
 * values. Renders a `<span>` by default; pass `as` (e.g. `h2`) when the label
 * is the accessible heading for a section.
 *
 * @example
 * <SectionLabel>{t('project.eyebrow')}</SectionLabel>
 * <SectionLabel as="h2">{sectionLabel}</SectionLabel>
 */
export interface SectionLabelProps extends React.HTMLAttributes<HTMLElement> {
  /** Element to render. Defaults to `span`. */
  as?: 'span' | 'h2' | 'h3' | 'p' | 'div'
  children: React.ReactNode
}

export function SectionLabel({ as: Comp = 'span', className, children, ...props }: SectionLabelProps): JSX.Element {
  return (
    <Comp
      className={cn(
        'text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </Comp>
  )
}
