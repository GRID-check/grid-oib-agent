'use client'

/**
 * The inbox entry for surfaces ABOVE a project.
 *
 * `AppSidebar` was the only thing in the product that rendered an inbox entry, and
 * it mounts only inside `app/projects/[id]/layout.tsx`. So being tagged produced no
 * observable effect anywhere else: on the projects home, the profile page, the
 * archive, or the inbox page itself, there was no link and no count. For somebody who
 * opens the product once a month — which is most of the people a mention is aimed at
 * — a request for their input was invisible.
 *
 * A client island rather than part of `OrgTopbar`, because the count rides a live
 * event channel and the topbar is a server component.
 *
 * Gated on `canAccessInbox`, NOT on the collaboration flag. The inbox stopped
 * being a collaboration-only surface when it started carrying operational alerts
 * (ADR-0042) — hiding the entry from a tenant without collaboration hid the
 * warning that its storage was filling up, which is the one notification that
 * cannot afford to be invisible. `canAccessInbox` is derived from the item-type
 * registry, so with no operational type registered it collapses back to the
 * collaboration flag and the frame is exactly the one NF-8 describes.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Inbox } from 'lucide-react'

import { InboxBadge } from '@/features/collaboration/components'
import { useInboxBadge } from '@/features/collaboration/hooks/use-inbox'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

export interface TopbarInboxLinkProps {
  /** Whether the inbox is reachable for this reader. False renders nothing. */
  canAccessInbox?: boolean
}

export function TopbarInboxLink({ canAccessInbox = false }: TopbarInboxLinkProps): JSX.Element | null {
  const t = useTranslations('collaboration')
  const pathname = usePathname() ?? ''
  // One request on mount, then the live channel. The hook does nothing when
  // disabled, so a gated reader issues no request either.
  const { pending } = useInboxBadge(canAccessInbox)

  if (!canAccessInbox) return null

  const isCurrent = pathname.startsWith('/app/inbox')

  return (
    <Link
      href="/app/inbox"
      data-testid="topbar-inbox-link"
      aria-current={isCurrent ? 'page' : undefined}
      className={cn(
        'inline-flex h-9 items-center gap-[7px] rounded-[10px] border border-border bg-card px-3.5 text-[13px] shadow-xs',
        'transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground',
        'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
        // Matches the Organisation button beside it, so the two read as one row of
        // controls rather than two competing styles.
        isCurrent ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <Inbox className="size-[15px]" aria-hidden />
      {t('inbox.navLabel')}
      {/* The count is the whole point of putting this here — a link with no badge
          would still leave "somebody needs you" invisible until you clicked. */}
      <InboxBadge pending={pending} />
    </Link>
  )
}
