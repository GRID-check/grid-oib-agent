// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
import { cn } from '@/lib/utils'
import { ProjectSwitcher, type ProjectSwitcherProject } from './project-switcher'
import { SidebarUserMenu, type SidebarUser } from './sidebar-user-menu'

interface NavItem {
  label: string
  segment: string | null // null = the project root (Overview)
  icon: React.ComponentType<{ className?: string }>
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Overview', segment: null, icon: LayoutDashboard },
  { label: 'Chat', segment: 'chat', icon: MessageSquare },
  { label: 'Files', segment: 'files', icon: FolderOpen },
  { label: 'Research', segment: 'research', icon: FlaskConical },
  { label: 'Members', segment: 'members', icon: Users },
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
}

export function AppSidebar({
  projectId,
  projects,
  user,
  authRequired,
  canManageMembers = true,
}: AppSidebarProps) {
  const pathname = usePathname() ?? ''
  const base = `/projects/${projectId}`
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
      aria-label="Project navigation"
    >
      {/* Wordmark + collapse toggle */}
      <div
        className={cn(
          'flex h-14 items-center',
          collapsed ? 'justify-center px-0' : 'justify-between px-4',
        )}
      >
        <Link
          href="/projects"
          aria-label="Grid — all projects"
          className="rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Logo kind={collapsed ? 'logo-only' : 'horizontal'} size="small" />
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Collapse sidebar"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <PanelLeftClose className="size-4" />
          </button>
        )}
      </div>

      {collapsed && (
        <div className="flex justify-center pb-2">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <PanelLeftOpen className="size-4" />
          </button>
        </div>
      )}

      {/* Project switcher */}
      <div className={cn('pb-2', collapsed ? 'px-2' : 'px-2')}>
        <ProjectSwitcher projects={projects} activeProjectId={projectId} collapsed={collapsed} />
      </div>

      {/* Section nav */}
      <nav
        className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pt-2"
        aria-label="Project sections"
      >
        {navItems.map((item) => {
          const href = item.segment ? `${base}/${item.segment}` : base
          const active = isActive(item)
          const Icon = item.icon
          return (
            <Link
              key={item.label}
              href={href}
              aria-current={active ? 'page' : undefined}
              title={collapsed ? item.label : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-lg py-1.5 text-sm transition-colors',
                'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                collapsed ? 'justify-center px-0' : 'px-2.5',
                active
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <Icon
                className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')}
              />
              {!collapsed && item.label}
            </Link>
          )
        })}
      </nav>

      {/* Footer: user + settings */}
      <div className={cn('border-t border-border p-2', collapsed && 'flex justify-center')}>
        <SidebarUserMenu user={user} authRequired={authRequired} compact={collapsed} />
      </div>
    </aside>
  )
}
