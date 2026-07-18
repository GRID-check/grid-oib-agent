/**
 * Org-level top frame for surfaces that live above a project (the projects
 * home, onboarding). Mirrors the click dummy's home top bar exactly: the
 * "Piloti" wordmark on the left, and on the right an "Organisation" button
 * (raised white card, gear icon) plus the shared identity/theme menu behind a
 * round avatar. It reuses {@link SidebarUserMenu} so the profile/theme controls
 * are identical to the in-project sidebar — no second, competing shell.
 */

import Link from 'next/link'
import { Settings } from 'lucide-react'

import { getTranslations } from '@/i18n/server'
import { SidebarUserMenu, type SidebarUser } from './sidebar-user-menu'

export interface OrgTopbarProps {
  user?: SidebarUser
  authRequired: boolean
  /**
   * Deprecated. Retained for backward compatibility with callers that still
   * pass a context label; the click-dummy top bar shows only the wordmark, so
   * this is no longer rendered.
   */
  heading?: string
  /** Show the org-management entry in the user menu (org admins only). */
  canManageOrganization?: boolean
  /** Show the organization entry to any org member (UX-16). */
  canViewOrganization?: boolean
  canManagePlatform?: boolean
  /** Show the org-wide Archiv entry (any org member, when enabled — ADR-0024). */
  canAccessArchiv?: boolean
}

export async function OrgTopbar({
  user,
  authRequired,
  canManageOrganization,
  canViewOrganization,
  canManagePlatform,
  canAccessArchiv,
}: OrgTopbarProps) {
  const t = await getTranslations('nav')
  const showOrganization = Boolean(canViewOrganization || canManageOrganization)
  return (
    <header className="flex h-16 shrink-0 items-center border-b border-border bg-background pr-10 pl-[18px]">
      <Link
        href="/app/projects"
        className="rounded-md text-[19px] font-semibold tracking-[-0.015em] text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        aria-label={t('allProjects')}
      >
        Piloti
      </Link>
      <div className="ml-auto flex items-center gap-2">
        {showOrganization && (
          <Link
            href="/app/organization"
            className="inline-flex h-9 items-center gap-[7px] rounded-[10px] border border-border bg-card px-3.5 text-[13px] text-muted-foreground shadow-xs transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <Settings className="size-[15px]" aria-hidden />
            {t('orgTopbar.organization')}
          </Link>
        )}
        <SidebarUserMenu
          user={user}
          authRequired={authRequired}
          menuSide="bottom"
          menuAlign="end"
          compact
          avatarSizeClass="size-9"
          canManageOrganization={canManageOrganization}
          canViewOrganization={canViewOrganization}
          canManagePlatform={canManagePlatform}
          canAccessArchiv={canAccessArchiv}
        />
      </div>
    </header>
  )
}
