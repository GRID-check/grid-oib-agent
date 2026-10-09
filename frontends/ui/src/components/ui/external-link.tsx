/**
 * ExternalLink: an anchor that leaves the app, in a new tab.
 *
 * Every such link needs the same four things, and each hand-rolled copy forgets
 * one: `target="_blank"`, `rel="noopener noreferrer"` (the opened page gets no
 * `window.opener` and no referrer carrying a project URL), an icon that says
 * "this leaves", and the same warning in words for a screen reader, which does
 * not see the icon. The words are part of the link's accessible name, so a
 * reader hears "How it works (opens in a new tab)" before the tab switches.
 *
 * Knows no dictionary: the caller passes `newTabLabel`, like `CopyField`.
 */

import type { ComponentProps, JSX, ReactNode } from 'react'
import { ExternalLink as ExternalLinkIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ExternalLinkProps
  extends Omit<ComponentProps<'a'>, 'target' | 'rel' | 'children'> {
  href: string
  /** Spoken after the link text, e.g. "opens in a new tab". */
  newTabLabel: string
  children: ReactNode
}

export function ExternalLink({
  href,
  newTabLabel,
  className,
  children,
  ...rest
}: ExternalLinkProps): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'text-muted-foreground hover:text-foreground touch-target inline-flex items-center gap-1.5 rounded-xs text-sm',
        'duration-quick transition-colors ease-out motion-reduce:transition-none',
        'focus-visible:ring-ring/60 focus-visible:ring-2 focus-visible:outline-none',
        className
      )}
      {...rest}
    >
      {children}
      <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">({newTabLabel})</span>
    </a>
  )
}
