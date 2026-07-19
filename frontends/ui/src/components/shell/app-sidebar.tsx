'use client'

/**
 * The GRID application sidebar — the product's primary navigation surface.
 *
 * Project-centric IA (click-dummy overhaul §5, FB-9/FB-10): "Piloti" wordmark →
 * project switcher → Ask Piloti / Workflows* / Files / Archiv* / History →
 * (spacer) → Settings → user footer. Overview and Members left the nav — their
 * content lives in the project Settings page; the project root redirects to
 * Chat. Quiet by design: a warm sunken surface, hairline border, and one
 * treatment for the active section — a raised white card, matching the click
 * dummy exactly. The rail collapses to an icon-only strip (persisted per
 * browser) for architects who want more room.
 *
 * Mobile-first: below `md` the rail disappears entirely and the shell becomes
 * a slim top bar with a hamburger that opens the same navigation as a
 * left-docked drawer over a scrim. Same content, same design language —
 * only the container changes.
 */

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Archive,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Compass,
  Folder,
  Menu,
  Settings,
  X,
  Zap,
} from 'lucide-react'

import { Logo } from '@/components/brand/logo'
import { useTranslations } from '@/i18n'
import { pruneProjectSections, useRecordProjectSection } from '@/hooks/use-last-project-section'
import { useLayoutStore } from '@/features/layout/store'
import { cn } from '@/lib/utils'
import { ProjectSwitcher, type ProjectSwitcherProject } from './project-switcher'
import { SidebarUserMenu, type SidebarUser } from './sidebar-user-menu'

interface NavItem {
  /** i18n key under `nav.sections` and stable React key. */
  key: 'chat' | 'files' | 'workflows' | 'archiv' | 'history' | 'settings'
  /** Project path segment, or null when `href` carries an absolute target. */
  segment: string | null
  /** Absolute href for items outside the project subtree (the org Archiv). */
  href?: string
  icon: React.ComponentType<{ className?: string }>
}

// Order and icons mirror the click dummy's sidebar exactly:
// Ask Piloti (compass) · Workflows (bolt) · Files (folder) · Archiv (box) ·
// History (clock).
const NAV_ITEMS: NavItem[] = [
  { key: 'chat', segment: 'chat', icon: Compass },
  { key: 'workflows', segment: 'workflows', icon: Zap },
  { key: 'files', segment: 'files', icon: Folder },
  // The org-wide Archiv (ADR-0024) keeps its org-scoped route; the sidebar
  // entry is a doorway, not a project subpage (spec §5: project-chrome Archiv
  // is a later phase — until then this links to the existing org page).
  { key: 'archiv', segment: null, href: '/app/archiv', icon: Archive },
  { key: 'history', segment: 'history', icon: Clock },
]

/** Pinned bottom entry, rendered above the user footer (spec §5). */
const SETTINGS_ITEM: NavItem = { key: 'settings', segment: 'settings', icon: Settings }

const COLLAPSE_STORAGE_KEY = 'grid.sidebar.collapsed'

export interface AppSidebarProps {
  projectId: string
  projects: ProjectSwitcherProject[]
  user?: SidebarUser
  authRequired: boolean
  /** Whether the current user can manage the organization (org admin). */
  canManageOrganization?: boolean
  /**
   * Whether the current user may open the organization page at all. True for
   * every authenticated org member — the org page serves capability subsets
   * (budgets/models/audit) and a member self-usage view, so the nav entry is
   * discoverable even for non-admins (UX-16).
   */
  canViewOrganization?: boolean
  /** Whether the current user is the platform owner (ADR-0016). */
  canManagePlatform?: boolean
  /**
   * Whether the org-wide Archiv is reachable (any member, gated by the
   * `organization-archiv` feature flag — ADR-0024). Also gates the Archiv
   * nav item.
   */
  canAccessArchiv?: boolean
  /** Whether the Workflows page is enabled (feature-flagged, default off). */
  showWorkflows?: boolean
}

export function AppSidebar({
  projectId,
  projects,
  user,
  authRequired,
  canManageOrganization = false,
  canViewOrganization = false,
  canManagePlatform = false,
  canAccessArchiv = false,
  showWorkflows = false,
}: AppSidebarProps) {
  const pathname = usePathname() ?? ''
  const base = `/app/projects/${projectId}`
  const t = useTranslations('nav')
  const [collapsed, setCollapsed] = React.useState(false)

  // The mobile nav drawer's open state lives in the layout store so the chat's
  // floating toolbar can open it: on the chat route the standalone mobile top
  // bar is hidden (to give the chat plane the full height), and its hamburger
  // moves into the chat toolbar's pill.
  const mobileOpen = useLayoutStore((s) => s.isMobileNavOpen)
  const setMobileOpen = useLayoutStore((s) => s.setMobileNavOpen)

  // Chat owns its top chrome (floating pills), so the global mobile top bar is
  // redundant there — hide it and let the chat toolbar host the nav opener.
  const isChatRoute = pathname === `${base}/chat` || pathname.startsWith(`${base}/chat/`)

  // "Resume where you left off": remember the section the user is currently on
  // for this project so entry points (project card / switcher) can land them
  // back here next time.
  useRecordProjectSection(projectId)

  // Keep the memory tidy: drop entries for projects that no longer exist
  // (deleted, or no longer accessible) whenever the known project set changes.
  React.useEffect(() => {
    pruneProjectSections(projects.map((p) => p.id))
  }, [projects])

  // Restore the persisted rail state after mount (avoids SSR hydration mismatch).
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true')
  }, [])

  // Close the mobile drawer whenever navigation lands somewhere new.
  React.useEffect(() => {
    setMobileOpen(false)
  }, [pathname, setMobileOpen])

  // Escape closes the drawer (it behaves like a modal over the page).
  React.useEffect(() => {
    if (!mobileOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mobileOpen, setMobileOpen])

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next))
      }
      return next
    })
  }, [])

  const itemHref = (item: NavItem) => item.href ?? `${base}/${item.segment}`

  const isActive = (item: NavItem) => pathname.startsWith(itemHref(item))

  // Workflows is feature-flagged (default off). Archiv shows for any member of
  // an org with the `organization-archiv` flag — the same gate the user menu's
  // Archiv entry uses (the layout passes both from getNavFlags).
  const navItems = NAV_ITEMS.filter(
    (item) =>
      (item.key !== 'workflows' || showWorkflows) &&
      (item.key !== 'archiv' || canAccessArchiv),
  )

  const activeItem = [...navItems, SETTINGS_ITEM].find(isActive)

  // A nav row — shared by the desktop rail, the collapsed rail (icon-only
  // tiles) and the mobile drawer. Active = raised white card with a hairline
  // border and soft shadow; inactive = quiet muted ink with a sidebar hover.
  const renderNavLink = (item: NavItem, variant: 'desktop' | 'mobile') => {
    const href = itemHref(item)
    const active = isActive(item)
    const Icon = item.icon
    const iconOnly = variant === 'desktop' && collapsed
    const label = t(`sections.${item.key}`)
    return (
      <Link
        key={item.key}
        href={href}
        aria-current={active ? 'page' : undefined}
        title={iconOnly ? label : undefined}
        className={cn(
          'flex shrink-0 items-center rounded-[10px] transition-colors duration-200 ease-out',
          'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
          iconOnly ? 'h-9 w-10 justify-center' : 'gap-[11px] px-3',
          variant === 'mobile' ? 'h-11 text-sm' : 'h-9 text-[13px]',
          active
            ? 'border border-border bg-card font-medium text-foreground shadow-xs'
            : 'text-muted-foreground hover:bg-accent',
        )}
      >
        <Icon
          aria-hidden
          className={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')}
        />
        {!iconOnly && <span className="truncate">{label}</span>}
      </Link>
    )
  }

  const renderNav = (variant: 'desktop' | 'mobile') => (
    <nav
      className={cn(
        'flex flex-1 flex-col gap-0.5',
        variant === 'desktop' && collapsed ? 'items-center' : undefined,
        variant === 'mobile' ? 'overflow-y-auto px-3 pt-2' : 'mt-5',
      )}
      aria-label={t('projectSections')}
    >
      {navItems.map((item) => renderNavLink(item, variant))}
    </nav>
  )

  // Settings sits pinned at the bottom, separated from the section nav by the
  // flexible spacer above it (spec §5) — same row anatomy, same active card.
  const renderSettings = (variant: 'desktop' | 'mobile') => (
    <div
      className={cn(
        'flex flex-col',
        variant === 'desktop' && collapsed ? 'items-center' : undefined,
        variant === 'mobile' ? 'px-3 pb-2' : 'mb-2.5',
      )}
    >
      {renderNavLink(SETTINGS_ITEM, variant)}
    </div>
  )

  return (
    <>
      {/* ---- Mobile top bar (below md) ----
          Hidden on the chat route: chat's own floating toolbar carries the nav
          opener there, so this bar would just double the top chrome and cramp
          the conversation. Every other section still gets it. */}
      <header
        className={cn(
          'h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-sunken px-3 md:hidden',
          isChatRoute ? 'hidden' : 'flex',
        )}
      >
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label={t('openNavigation')}
            aria-expanded={mobileOpen}
            className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <Link
            href="/app/projects"
            aria-label={t('allProjects')}
            className="rounded-md text-[19px] font-semibold tracking-[-0.015em] text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            Piloti
          </Link>
        </div>
        {activeItem && (
          <span className="truncate text-sm font-medium text-muted-foreground">
            {t(`sections.${activeItem.key}`)}
          </span>
        )}
      </header>

      {/* ---- Mobile navigation drawer ---- */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label={t('projectNavigation')}>
          <div
            className="absolute inset-0 bg-overlay backdrop-blur-sm animate-in fade-in-0 duration-200"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface-sunken shadow-lg animate-in slide-in-from-left duration-200 motion-reduce:animate-none">
            <div className="flex h-14 shrink-0 items-center justify-between px-4">
              <Link
                href="/app/projects"
                aria-label={t('allProjects')}
                className="rounded-md text-[19px] font-semibold tracking-[-0.015em] text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
              >
                Piloti
              </Link>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label={t('closeNavigation')}
                className="flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>

            <div className="px-3 pb-2">
              <ProjectSwitcher projects={projects} activeProjectId={projectId} collapsed={false} />
            </div>

            {renderNav('mobile')}

            {renderSettings('mobile')}

            <div className="border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <SidebarUserMenu
                user={user}
                authRequired={authRequired}
                compact={false}
                canManageOrganization={canManageOrganization}
                canViewOrganization={canViewOrganization}
                canManagePlatform={canManagePlatform}
                canAccessArchiv={canAccessArchiv}
              />
            </div>
          </div>
        </div>
      )}

      {/* ---- Desktop rail (md and up) ---- */}
      <aside
        className={cn(
          'hidden h-full shrink-0 flex-col border-r border-border bg-surface-sunken px-3 pt-[18px] pb-[14px] transition-[width] duration-200 ease-out md:flex',
          collapsed ? 'w-16 items-center' : 'w-[236px]',
        )}
        aria-label={t('projectNavigation')}
      >
        {/* Wordmark + collapse toggle */}
        {collapsed ? (
          <>
            <Link
              href="/app/projects"
              aria-label={t('allProjects')}
              className="flex h-7 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
            >
              <Logo kind="logo-only" size="small" />
            </Link>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={t('expandSidebar')}
              className="mt-[18px] flex h-9 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
            >
              <ChevronsRight className="size-4" aria-hidden />
            </button>
          </>
        ) : (
          <div className="flex items-center px-1.5">
            <Link
              href="/app/projects"
              aria-label={t('allProjects')}
              className="rounded-md text-[19px] font-semibold tracking-[-0.015em] text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
            >
              Piloti
            </Link>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={t('collapseSidebar')}
              className="ml-auto flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
            >
              <ChevronsLeft className="size-4" aria-hidden />
            </button>
          </div>
        )}

        {/* Project switcher — hidden on the collapsed rail (matches the dummy). */}
        {!collapsed && (
          <div className="mt-[18px]">
            <ProjectSwitcher projects={projects} activeProjectId={projectId} collapsed={false} />
          </div>
        )}

        {/* Section nav (flex-1 — doubles as the spacer above Settings) */}
        {renderNav('desktop')}

        {/* Pinned Settings entry */}
        {renderSettings('desktop')}

        {/* Footer: user (avatar + name) with a hairline top border */}
        <div className={cn('border-t border-border pt-3', collapsed ? 'flex w-full justify-center' : undefined)}>
          <SidebarUserMenu
            user={user}
            authRequired={authRequired}
            compact={collapsed}
            canManageOrganization={canManageOrganization}
            canViewOrganization={canViewOrganization}
            canManagePlatform={canManagePlatform}
            canAccessArchiv={canAccessArchiv}
          />
        </div>
      </aside>
    </>
  )
}
