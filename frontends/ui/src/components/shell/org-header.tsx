'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Archive, Inbox } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useInboxBadge } from '@/features/collaboration/hooks/use-inbox'
import { InboxBadge } from '@/features/collaboration/components'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
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

  return (
    <header
      data-scope="org"
      className="border-border bg-background flex min-h-14 w-full shrink-0 items-center justify-between gap-3 border-b px-4 pt-[env(safe-area-inset-top)] md:px-6"
    >
      <Link
        href="/app/projects"
        aria-label={t('allProjects')}
        className="text-foreground focus-visible:ring-ring/60 rounded-md text-[19px] font-semibold tracking-[-0.015em] focus-visible:outline-none focus-visible:ring-2"
      >
        Piloti
      </Link>

      <div className="flex items-center gap-1">
        {canAccessArchiv && (
          <OrgHeaderIconLink
            href="/app/archiv"
            label={t('sections.archiv')}
            icon={Archive}
            active={pathname === '/app/archiv' || pathname.startsWith('/app/archiv/')}
          />
        )}
        {canAccessInbox && (
          <OrgHeaderIconLink
            href="/app/inbox"
            label={tCollaboration('inbox.navLabel')}
            icon={Inbox}
            active={pathname === '/app/inbox' || pathname.startsWith('/app/inbox/')}
            badgeCount={inboxPending}
          />
        )}
        <div className="bg-border mx-2 h-6 w-px" aria-hidden />
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
          canAccessArchiv={canAccessArchiv}
        />
      </div>
    </header>
  )
}

function OrgHeaderIconLink({
  href,
  label,
  icon: Icon,
  active,
  badgeCount = 0,
}: {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  badgeCount?: number
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'focus-visible:ring-ring/60 relative flex size-9 items-center justify-center rounded-lg transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none',
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
