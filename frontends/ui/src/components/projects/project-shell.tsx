// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { SelectEllipse, Document, Chat, Users } from '@/adapters/ui/icons'
import { Flex, Text } from '@/adapters/ui'
import { AppShell } from '@/features/layout/components/AppShell'

interface ProjectShellProps {
  projectId: string
  projectName: string
  children: ReactNode
}

const projectNavItems = [
  { label: 'Overview', href: '', icon: SelectEllipse, exact: true },
  { label: 'Files', href: '/files', icon: Document, exact: false },
  { label: 'Ask Grid', href: '/chat', icon: Chat, exact: false },
  { label: 'Members', href: '/members', icon: Users, exact: false },
]

export function ProjectShell({ projectId, projectName, children }: ProjectShellProps): JSX.Element {
  const pathname = usePathname()

  function isActive(href: string, exact: boolean): boolean {
    const fullHref = `/projects/${projectId}${href}`
    return exact ? pathname === fullHref : pathname.startsWith(fullHref)
  }

  return (
    <AppShell>
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] bg-surface-sunken">
        <aside className="hidden border-r border-base bg-surface-raised-30 p-4 lg:block">
          <Flex direction="col" gap="5" className="sticky top-20">
            <Flex direction="col" gap="1" className="rounded-3xl border border-base bg-surface-base p-4">
              <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.24em]">Project</Text>
              <Text kind="label/bold/lg" className="text-primary tracking-[-0.03em]">{projectName}</Text>
            </Flex>
            <nav className="flex flex-col gap-2" aria-label="Project navigation">
              {projectNavItems.map(({ label, href, icon: Icon, exact }) => {
                const active = isActive(href, exact)
                return (
                  <Link
                    key={label}
                    href={`/projects/${projectId}${href}`}
                    aria-current={active ? 'page' : undefined}
                    className={`group flex items-center gap-3 rounded-2xl border px-3 py-3 text-sm font-semibold transition ${
                      active
                        ? 'border-transparent bg-surface-raised-30 text-primary'
                        : 'border-transparent text-subtle hover:border-base hover:bg-surface-sunken hover:text-primary'
                    }`}
                  >
                    <span
                      className={`flex h-9 w-9 items-center justify-center rounded-xl transition ${
                        active
                          ? 'bg-surface-sunken text-brand'
                          : 'bg-surface-sunken text-brand group-hover:bg-surface-raised-50'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    {label}
                  </Link>
                )
              })}
            </nav>
            <Link href="/projects" className="rounded-2xl border border-base px-4 py-3 text-sm font-semibold text-subtle transition hover:bg-surface-base hover:text-primary">
              All projects
            </Link>
          </Flex>
        </aside>
        <main className="flex min-w-0 flex-col overflow-y-auto">{children}</main>
      </div>
    </AppShell>
  )
}
