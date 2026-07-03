// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * The GRID application sidebar — the product's primary navigation surface.
 *
 * Project-centric IA: wordmark → project switcher → section nav → user footer.
 * Quiet by design: sunken surface, hairline border, one accent color reserved
 * for the active section and the brand mark.
 */

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  FlaskConical,
  FolderOpen,
  LayoutDashboard,
  MessageSquare,
  Users,
} from 'lucide-react'

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

export interface AppSidebarProps {
  projectId: string
  projects: ProjectSwitcherProject[]
  user?: SidebarUser
  authRequired: boolean
}

export function AppSidebar({ projectId, projects, user, authRequired }: AppSidebarProps) {
  const pathname = usePathname()
  const base = `/projects/${projectId}`

  const isActive = (item: NavItem) => {
    const href = item.segment ? `${base}/${item.segment}` : base
    return item.segment ? pathname.startsWith(href) : pathname === base
  }

  return (
    <aside
      className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-surface-sunken"
      aria-label="Project navigation"
    >
      {/* Wordmark */}
      <div className="flex h-14 items-center px-4">
        <Link
          href="/projects"
          className="text-sm font-semibold tracking-[0.2em] text-foreground uppercase focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none rounded-sm"
        >
          Grid
        </Link>
      </div>

      {/* Project switcher */}
      <div className="px-2 pb-2">
        <ProjectSwitcher projects={projects} activeProjectId={projectId} />
      </div>

      {/* Section nav */}
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pt-2" aria-label="Project sections">
        {NAV_ITEMS.map((item) => {
          const href = item.segment ? `${base}/${item.segment}` : base
          const active = isActive(item)
          const Icon = item.icon
          return (
            <Link
              key={item.label}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                active
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
              {item.label}
            </Link>
          )
        })}
      </nav>

      {/* Footer: user + settings */}
      <div className="border-t border-border p-2">
        <SidebarUserMenu user={user} authRequired={authRequired} />
      </div>
    </aside>
  )
}
