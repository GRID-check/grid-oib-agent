/**
 * IconList: a short list of statements, one line each, each led by an icon.
 *
 * For the conditions a section states up front ("what applies"), where the
 * icon lets the eye find the one it is looking for and the words carry the
 * meaning. The icon is decoration (`aria-hidden`); the list is named by
 * `label`, so a screen reader announces it as "What applies, list, 5 items".
 *
 * Two columns from `sm` up, one on a phone.
 */

import type { JSX, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function IconList({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <ul aria-label={label} className={cn('grid gap-2.5 sm:grid-cols-2', className)}>
      {children}
    </ul>
  )
}

export function IconListItem({
  icon: Icon,
  children,
}: {
  icon: LucideIcon
  children: ReactNode
}): JSX.Element {
  return (
    <li className="text-muted-foreground flex items-start gap-2.5 text-sm leading-relaxed">
      <Icon className="text-foreground/70 mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </li>
  )
}
