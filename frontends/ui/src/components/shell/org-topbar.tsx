/**
 * Org-level top frame for surfaces that live above a project (the projects
 * list, onboarding). Deliberately lightweight: brand mark on the left, the
 * shared user + theme menu on the right. It reuses {@link SidebarUserMenu} so
 * the identity/theme controls are identical to the in-project sidebar — no
 * second, competing shell.
 */

import Link from 'next/link'

import { Logo } from '@/components/brand/logo'
import { FadeIn } from '@/components/motion'
import { getTranslations } from '@/i18n/server'
import { ConnectionPresenceIndicator } from './connection-presence-indicator'
import { SidebarUserMenu, type SidebarUser } from './sidebar-user-menu'

export interface OrgTopbarProps {
  user?: SidebarUser
  authRequired: boolean
  /** Optional context label shown next to the wordmark (e.g. "Projects"). */
  heading?: string
  /** Show the org-management entry in the user menu (org admins only). */
  canManageOrganization?: boolean
  /** Show the organization entry to any org member (UX-16). */
  canViewOrganization?: boolean
  canManagePlatform?: boolean
  /** Show the org-wide Archiv entry (any org member, when enabled — ADR-0024). */
  canAccessArchiv?: boolean
}

export async function OrgTopbar({ user, authRequired, heading, canManageOrganization, canViewOrganization, canManagePlatform, canAccessArchiv }: OrgTopbarProps) {
  const t = await getTranslations('nav')
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl">
      <FadeIn
        distance={4}
        className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-4 sm:px-6 md:px-8"
      >
        <div className="flex items-center gap-3">
          <Link
            href="/app/projects"
            className="rounded-md focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
            aria-label={t('allProjects')}
          >
            <Logo kind="horizontal" size="small" />
          </Link>
          {heading && (
            <>
              <span className="h-4 w-px bg-border" aria-hidden />
              <span className="text-sm font-medium text-muted-foreground">{heading}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <ConnectionPresenceIndicator className="hidden sm:inline-flex" />
          <SidebarUserMenu
            user={user}
            authRequired={authRequired}
            menuSide="bottom"
            menuAlign="end"
            compact
            canManageOrganization={canManageOrganization}
            canViewOrganization={canViewOrganization}
            canManagePlatform={canManagePlatform}
            canAccessArchiv={canAccessArchiv}
          />
        </div>
      </FadeIn>
    </header>
  )
}
