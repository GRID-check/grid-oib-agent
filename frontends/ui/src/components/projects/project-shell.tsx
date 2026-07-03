// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { LayoutDashboard, FileText, MessageSquare, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppShell } from '@/features/layout/components/AppShell'

interface ProjectShellProps {
  projectId: string
  projectName: string
  children: ReactNode
}

const projectNavItems = [
  { label: 'Overview', href: '', icon: LayoutDashboard, exact: true },
  { label: 'Files', href: '/files', icon: FileText, exact: false },
  { label: 'Ask Grid', href: '/chat', icon: MessageSquare, exact: false },
  { label: 'Members', href: '/members', icon: Users, exact: false },
]

export function ProjectShell({ projectId, projectName, children }: ProjectShellProps): JSX.Element {
  const pathname = usePathname()

  function isActive(href: string, exact: boolean): boolean {
    if (!pathname) return false
    const fullHref = `/projects/${projectId}${href}`
    return exact ? pathname === fullHref : pathname.startsWith(fullHref)
  }

  return (
    <AppShell>
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] bg-muted/40">
        <aside className="hidden border-r bg-background p-4 lg:block">
          <div className="sticky top-20 flex flex-col gap-6">
            <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
              <span className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
                Project
              </span>
              <h2 className="truncate text-lg font-semibold tracking-tight">{projectName}</h2>
            </div>
            <nav className="flex flex-col gap-1" aria-label="Project navigation">
              {projectNavItems.map(({ label, href, icon: Icon, exact }) => {
                const active = isActive(href, exact)
                return (
                  <Link
                    key={label}
                    href={`/projects/${projectId}${href}`}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    )}
                  >
                    <Icon className={cn('h-4 w-4', active ? 'text-primary' : 'text-muted-foreground')} />
                    {label}
                  </Link>
                )
              })}
            </nav>
            <Link
              href="/projects"
              className="rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              All projects
            </Link>
          </div>
        </aside>
        <main className="flex min-w-0 flex-col overflow-y-auto">{children}</main>
      </div>
    </AppShell>
  )
}
