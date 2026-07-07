'use client'

/**
 * The GRID application sidebar — the product's primary navigation surface.
 *
 * Project-centric IA: wordmark → project switcher → section nav → user footer.
 * Quiet by design: sunken surface, hairline border, one accent color reserved
 * for the active section and the brand mark. The rail collapses to an
 * icon-only strip (persisted per browser) for architects who want more room.
 */

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  FlaskConical,
  FolderOpen,
  LayoutDashboard,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from 'lucide-react'

import { Logo } from '@/components/brand/logo'
import { AnimatePresence, easeQuiet, motion, springSnappy } from '@/components/motion'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { ProjectSwitcher, type ProjectSwitcherProject } from './project-switcher'
import { SidebarUserMenu, type SidebarUser } from './sidebar-user-menu'

interface NavItem {
  /** i18n key under `nav.sections` and stable React key. */
  key: 'overview' | 'chat' | 'files' | 'research' | 'members'
  segment: string | null // null = the project root (Overview)
  icon: React.ComponentType<{ className?: string }>
}

const NAV_ITEMS: NavItem[] = [
  { key: 'overview', segment: null, icon: LayoutDashboard },
  { key: 'chat', segment: 'chat', icon: MessageSquare },
  { key: 'files', segment: 'files', icon: FolderOpen },
  { key: 'research', segment: 'research', icon: FlaskConical },
  { key: 'members', segment: 'members', icon: Users },
]

const COLLAPSE_STORAGE_KEY = 'grid.sidebar.collapsed'

export interface AppSidebarProps {
  projectId: string
  projects: ProjectSwitcherProject[]
  user?: SidebarUser
  authRequired: boolean
  /**
   * Whether the current user can manage project members. When false, the
   * Members section is hidden — viewers/editors never see a nav item that
   * dead-ends in a permission error.
   */
  canManageMembers?: boolean
  /** Whether the current user can manage the organization (org admin). */
  canManageOrganization?: boolean
}

export function AppSidebar({
  projectId,
  projects,
  user,
  authRequired,
  canManageMembers = true,
  canManageOrganization = false,
}: AppSidebarProps) {
  const pathname = usePathname() ?? ''
  const base = `/app/projects/${projectId}`
  const t = useTranslations('nav')
  const [collapsed, setCollapsed] = React.useState(false)

  // Restore the persisted rail state after mount (avoids SSR hydration mismatch).
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true')
  }, [])

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

  const navItems = NAV_ITEMS.filter(
    (item) => item.segment !== 'members' || canManageMembers,
  )

  return (
    <aside
      className={cn(
        'flex h-screen shrink-0 flex-col border-r border-border bg-surface-sunken transition-[width] duration-200 ease-out',
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
      <nav
        className={cn(
          'flex flex-1 flex-col gap-1 overflow-y-auto pt-2',
          collapsed ? 'px-2' : 'px-3',
        )}
        aria-label={t('projectSections')}
      >
        {navItems.map((item) => {
          const href = item.segment ? `${base}/${item.segment}` : base
          const active = isActive(item)
          const Icon = item.icon
          return (
            <Link
              key={item.key}
              href={href}
              aria-current={active ? 'page' : undefined}
              title={collapsed ? t(`sections.${item.key}`) : undefined}
              className={cn(
                'relative flex h-9 shrink-0 items-center gap-3 rounded-lg text-sm transition-colors duration-200 ease-out',
                'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
                collapsed ? 'justify-center px-0' : 'px-3',
                active
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active"
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
            </Link>
          )
        })}
      </nav>

      {/* Footer: user + settings */}
      <div className={cn('border-t border-border', collapsed ? 'flex justify-center p-2' : 'p-3')}>
        <SidebarUserMenu
          user={user}
          authRequired={authRequired}
          compact={collapsed}
          canManageOrganization={canManageOrganization}
        />
      </div>
    </aside>
  )
}
