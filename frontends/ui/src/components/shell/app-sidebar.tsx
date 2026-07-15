'use client'

/**
 * The GRID application sidebar — the product's primary navigation surface.
 *
 * Project-centric IA: wordmark → project switcher → section nav → user footer.
 * Quiet by design: sunken surface, hairline border, one accent color reserved
 * for the active section and the brand mark. The rail collapses to an
 * icon-only strip (persisted per browser) for architects who want more room.
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
  BookOpenCheck,
  FlaskConical,
  FolderOpen,
  LayoutDashboard,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
  X,
} from 'lucide-react'

import { Logo } from '@/components/brand/logo'
import { AnimatePresence, easeQuiet, motion, springSnappy } from '@/components/motion'
import { useTranslations } from '@/i18n'
import { pruneProjectSections, useRecordProjectSection } from '@/hooks/use-last-project-section'
import { cn } from '@/lib/utils'
import { ConnectionPresenceIndicator } from './connection-presence-indicator'
import { ProjectSwitcher, type ProjectSwitcherProject } from './project-switcher'
import { SidebarUserMenu, type SidebarUser } from './sidebar-user-menu'

interface NavItem {
  /** i18n key under `nav.sections` and stable React key. */
  key: 'overview' | 'chat' | 'files' | 'knowledge' | 'research' | 'members'
  segment: string | null // null = the project root (Overview)
  icon: React.ComponentType<{ className?: string }>
}

const NAV_ITEMS: NavItem[] = [
  { key: 'overview', segment: null, icon: LayoutDashboard },
  { key: 'chat', segment: 'chat', icon: MessageSquare },
  { key: 'files', segment: 'files', icon: FolderOpen },
  { key: 'knowledge', segment: 'knowledge', icon: BookOpenCheck },
  { key: 'research', segment: 'research', icon: FlaskConical },
  { key: 'members', segment: 'members', icon: Users },
]

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
  /** Whether the project knowledge page is enabled (feature-flagged, default off). */
  showKnowledge?: boolean
  /**
   * Whether the standalone Research nav item is shown. False when the
   * `research-in-chat-history` flag folds research runs into the chat-history
   * panel (FB-10). Defaults to true (legacy tab visible) for back-compat.
   */
  showResearch?: boolean
}

export function AppSidebar({
  projectId,
  projects,
  user,
  authRequired,
  canManageOrganization = false,
  canViewOrganization = false,
  canManagePlatform = false,
  showKnowledge = false,
  showResearch = true,
}: AppSidebarProps) {
  const pathname = usePathname() ?? ''
  const base = `/app/projects/${projectId}`
  const t = useTranslations('nav')
  const [collapsed, setCollapsed] = React.useState(false)
  const [mobileOpen, setMobileOpen] = React.useState(false)

  // "Resume where you left off": remember the section the user is currently on
  // for this project so entry points (project card / switcher) can land them
  // back here next time. Records Overview too — an explicit Overview visit is a
  // real visit and becomes the new memory, so resume never traps the user.
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
  }, [pathname])

  // Escape closes the drawer (it behaves like a modal over the page).
  React.useEffect(() => {
    if (!mobileOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mobileOpen])

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next))
      }
      return next
    })
  }, [])

  const isActive = (item: NavItem) => {
    const href = item.segment ? `${base}/${item.segment}` : base
    return item.segment ? pathname.startsWith(href) : pathname === base
  }

  // Members is shown to every project member: the roster page renders a
  // dignified read-only view for viewers/editors and full controls for admins,
  // so the nav item never dead-ends. Knowledge is feature-flagged (default off).
  // Research is hidden when its runs are folded into the chat-history panel
  // (research-in-chat-history flag, FB-10).
  const navItems = NAV_ITEMS.filter(
    (item) =>
      (item.key !== 'knowledge' || showKnowledge) && (item.key !== 'research' || showResearch),
  )

  const activeItem = navItems.find(isActive)

  const renderNav = (variant: 'desktop' | 'mobile') => (
    <nav
      className={cn(
        'flex flex-1 flex-col gap-1 overflow-y-auto pt-2',
        variant === 'desktop' && collapsed ? 'px-2' : 'px-3',
      )}
      aria-label={t('projectSections')}
    >
      {navItems.map((item) => {
        const href = item.segment ? `${base}/${item.segment}` : base
        const active = isActive(item)
        const Icon = item.icon
        const showLabel = variant === 'mobile' || !collapsed
        return (
          <Link
            key={item.key}
            href={href}
            aria-current={active ? 'page' : undefined}
            title={!showLabel ? t(`sections.${item.key}`) : undefined}
            className={cn(
              'relative flex shrink-0 items-center gap-3 rounded-lg text-sm transition-colors duration-200 ease-out',
              'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
              // Roomier touch targets in the drawer; the compact desktop rail keeps h-9.
              variant === 'mobile' ? 'h-11' : 'h-9',
              showLabel ? 'px-3' : 'justify-center px-0',
              active
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId={variant === 'mobile' ? 'sidebar-active-mobile' : 'sidebar-active'}
                className="absolute inset-0 rounded-lg bg-accent"
                transition={springSnappy}
                aria-hidden
              />
            )}
            <Icon
              aria-hidden
              className={cn(
                'relative z-10 size-4 shrink-0',
                active ? 'text-foreground' : 'text-muted-foreground',
              )}
            />
            {variant === 'mobile' ? (
              <span className="relative z-10 truncate">{t(`sections.${item.key}`)}</span>
            ) : (
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.span
                    className="relative z-10 truncate"
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -4 }}
                    transition={{ ...easeQuiet, duration: 0.15 }}
                  >
                    {t(`sections.${item.key}`)}
                  </motion.span>
                )}
              </AnimatePresence>
            )}
          </Link>
        )
      })}
    </nav>
  )

  return (
    <>
      {/* ---- Mobile top bar (below md) ---- */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-sunken px-3 md:hidden">
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
            className="rounded-md focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <Logo kind="horizontal" size="small" />
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
                className="rounded-md focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
              >
                <Logo kind="horizontal" size="small" />
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

            <div className="flex flex-col gap-2 border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <ConnectionPresenceIndicator className="px-1" />
              <SidebarUserMenu
                user={user}
                authRequired={authRequired}
                compact={false}
                canManageOrganization={canManageOrganization}
                canViewOrganization={canViewOrganization}
                canManagePlatform={canManagePlatform}
              />
            </div>
          </div>
        </div>
      )}

      {/* ---- Desktop rail (md and up) ---- */}
      <aside
        className={cn(
          'hidden h-full shrink-0 flex-col border-r border-border bg-surface-sunken transition-[width] duration-200 ease-out md:flex',
          collapsed ? 'w-14' : 'w-60',
        )}
        aria-label={t('projectNavigation')}
      >
        {/* Wordmark + collapse toggle */}
        <div
          className={cn(
            'flex h-14 items-center',
            collapsed ? 'justify-center px-0' : 'justify-between px-4',
          )}
        >
          <Link
            href="/app/projects"
            aria-label={t('allProjects')}
            className="rounded-md focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <Logo kind={collapsed ? 'logo-only' : 'horizontal'} size="small" />
          </Link>
          {!collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={t('collapseSidebar')}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
            >
              <motion.span
                className="flex"
                initial={{ rotate: 180 }}
                animate={{ rotate: 0 }}
                transition={springSnappy}
                aria-hidden
              >
                <PanelLeftClose className="size-4" aria-hidden />
              </motion.span>
            </button>
          )}
        </div>

        {collapsed && (
          <div className="flex justify-center pb-2">
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={t('expandSidebar')}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
            >
              <motion.span
                className="flex"
                initial={{ rotate: -180 }}
                animate={{ rotate: 0 }}
                transition={springSnappy}
                aria-hidden
              >
                <PanelLeftOpen className="size-4" aria-hidden />
              </motion.span>
            </button>
          </div>
        )}

        {/* Project switcher */}
        <div className={cn('pb-2', collapsed ? 'px-2' : 'px-3')}>
          <ProjectSwitcher projects={projects} activeProjectId={projectId} collapsed={collapsed} />
        </div>

        {/* Section nav */}
        {renderNav('desktop')}

        {/* Footer: connection presence + user + settings */}
        <div className={cn('flex flex-col gap-2 border-t border-border', collapsed ? 'items-center p-2' : 'p-3')}>
          <ConnectionPresenceIndicator compact={collapsed} className={collapsed ? undefined : 'px-1'} />
          <SidebarUserMenu
            user={user}
            authRequired={authRequired}
            compact={collapsed}
            canManageOrganization={canManageOrganization}
            canViewOrganization={canViewOrganization}
            canManagePlatform={canManagePlatform}
          />
        </div>
      </aside>
    </>
  )
}
