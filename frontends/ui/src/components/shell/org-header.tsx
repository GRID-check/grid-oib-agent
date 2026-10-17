'use client'

import type { JSX } from 'react'
import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Archive, Bell, MessageSquarePlus } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useInboxBadge } from '@/features/collaboration/hooks/use-inbox'
import { useFeedbackAvailable, useOpenFeedback } from '@/features/product-feedback/components'
import { InboxBadge } from '@/features/collaboration/components'
import { useTranslations } from '@/i18n'
import { TOUR_ANCHORS, type TourAnchor } from '@/features/onboarding/lib/product-tour'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { cn } from '@/lib/utils'
import { ConnectionBand } from './connection-band'
import { ShellSearchButton } from './shell-search-button'
import { SidebarUserMenu, type SidebarUser } from './sidebar-user-menu'

/**
 * The org-scope chrome: one slim header instead of a rail.
 *
 * Above a project there is no section list to navigate — the projects home IS
 * the org scope's content, and everything else up here is either a sheet that
 * floats above it (Archiv, Postfach) or an account destination that already
 * lives in the avatar menu (Profil, Organisation, Plattform). A 236px rail
 * repeating those five links earned its column inside a project and spent it up
 * here, so org scope trades it for a header and gives the page the full width.
 *
 * The header carries exactly what must stay one click away: the wordmark (the
 * way home), the two org-wide doorways with the inbox badge, and the avatar.
 * Everything account-shaped is behind the avatar — two clicks, deliberately.
 *
 * On a phone the doorways move to the tab bar at the bottom of the screen
 * (`PhoneTabBar`), where the thumb is, and this band keeps the wordmark, the
 * search that opens the command palette, the avatar, and, while the network is
 * gone, a line that says so (`ConnectionBand`).
 */

export interface OrgHeaderProps {
  user?: SidebarUser
  organizationName?: string | null
  authRequired: boolean
  canManageOrganization: boolean
  canViewOrganization: boolean
  canManagePlatform: boolean
  canAccessArchiv: boolean
  canAccessInbox: boolean
}

export function OrgHeader({
  user,
  organizationName,
  authRequired,
  canManageOrganization,
  canViewOrganization,
  canManagePlatform,
  canAccessArchiv,
  canAccessInbox,
}: OrgHeaderProps): JSX.Element {
  const pathname = usePathname() ?? ''
  const t = useTranslations('nav')
  const tCollaboration = useTranslations('collaboration')
  const { pending: inboxPending } = useInboxBadge(canAccessInbox)
  const tFeedback = useTranslations('feedback')
  const openFeedback = useOpenFeedback()
  const feedbackAvailable = useFeedbackAvailable()
  const isMobile = useIsMobile()

  return (
    <header
      data-scope="org"
      className="border-border bg-background flex w-full shrink-0 flex-col border-b pt-[env(safe-area-inset-top)]"
    >
      <div className="flex min-h-14 items-center justify-between gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] md:pl-6 md:pr-6">
        <Link
          href="/app/projects"
          aria-label={t('allProjects')}
          className="text-foreground focus-visible:ring-ring/60 rounded-md text-[19px] font-semibold tracking-[-0.015em] focus-visible:outline-none focus-visible:ring-2"
        >
          Piloti
        </Link>

        <div className="flex items-center gap-1">
          {/* On a phone the two doorways live in the tab bar, under the thumb
              (`PhoneTabBar`), and feedback in the avatar menu; the band keeps
              search and the account. */}
          {canAccessArchiv && (
            <OrgHeaderIconLink
              href="/app/archiv"
              label={t('sections.archiv')}
              icon={Archive}
              tourAnchor={TOUR_ANCHORS.archiv}
              active={pathname === '/app/archiv' || pathname.startsWith('/app/archiv/')}
            />
          )}
          {canAccessInbox && (
            <OrgHeaderIconLink
              href="/app/inbox"
              label={tCollaboration('inbox.navLabel')}
              icon={Bell}
              tourAnchor={TOUR_ANCHORS.inbox}
              active={pathname === '/app/inbox' || pathname.startsWith('/app/inbox/')}
              badgeCount={inboxPending}
            />
          )}
          {feedbackAvailable && (
            <OrgHeaderIconButton
              label={tFeedback('open')}
              hint={tFeedback('openHint')}
              icon={MessageSquarePlus}
              onClick={() => openFeedback()}
            />
          )}
          <ShellSearchButton className="md:hidden" />
          <div className="bg-border mx-2 hidden h-6 w-px md:block" aria-hidden />
          <SidebarUserMenu
            user={user}
            organizationName={organizationName}
            authRequired={authRequired}
            compact
            menuSide="bottom"
            menuAlign="end"
            avatarSizeClass="size-8"
            canManageOrganization={canManageOrganization}
            canViewOrganization={canViewOrganization}
            canManagePlatform={canManagePlatform}
            tourAnchor={TOUR_ANCHORS.account}
          />
        </div>
      </div>
      {isMobile && <ConnectionBand />}
    </header>
  )
}

function OrgHeaderIconLink({
  href,
  label,
  icon: Icon,
  active,
  badgeCount = 0,
  tourAnchor,
}: {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  badgeCount?: number
  /** Marks the link as a product-tour stop. */
  tourAnchor?: TourAnchor
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          data-tour={tourAnchor}
          className={cn(
            'focus-visible:ring-ring/60 relative hidden size-9 items-center justify-center rounded-lg transition-colors pointer-coarse:size-11 md:flex duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none',
            active
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Icon className="size-4" aria-hidden />
          <InboxBadge
            pending={badgeCount}
            className="absolute right-0.5 top-0.5 -translate-y-1/3 translate-x-1/3"
          />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/** The header's one action that is not a place: the same key shape as a link. */
function OrgHeaderIconButton({
  label,
  hint,
  icon: Icon,
  onClick,
}: {
  label: string
  hint: string
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          data-testid="org-header-feedback"
          className="focus-visible:ring-ring/60 text-muted-foreground hover:bg-accent hover:text-foreground hidden size-9 pointer-coarse:size-11 md:flex items-center justify-center rounded-lg transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none"
        >
          <Icon className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{hint}</TooltipContent>
    </Tooltip>
  )
}
