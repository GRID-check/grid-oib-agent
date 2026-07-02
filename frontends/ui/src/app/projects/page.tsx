// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq, asc } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { Flex, Text } from '@/adapters/ui'
import { Folder, Plus, SelectEllipse } from '@/adapters/ui/icons'
import { ProjectCard } from '@/components/projects/project-card'
import { CreateProjectForm } from '@/components/projects/create-project-form'
import { AppShell } from '@/features/layout/components/AppShell'

export default async function ProjectsPage(): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const db = getDb()

  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, session.organizationId))
    .orderBy(asc(projects.createdAt))

  return (
    <AppShell>
      <main className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
        <section className="relative overflow-hidden rounded-[2rem] border border-base bg-surface-raised-30 p-6 shadow-[0_35px_100px_-75px_rgba(15,23,42,0.8)] md:p-8">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full border border-base bg-surface-raised-50 opacity-70" />
        <div className="pointer-events-none absolute bottom-0 right-0 h-px w-2/3 bg-gradient-to-l from-brand/60 to-transparent" />
        <Flex direction="col" gap="8" className="relative">
          <Flex align="start" justify="between" gap="6" className="flex-col md:flex-row">
            <Flex direction="col" gap="4" className="max-w-3xl">
              <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.24em]">
                Architecture project OS
              </Text>
              <Text kind="title/xl" className="max-w-3xl text-primary tracking-[-0.04em] md:text-5xl md:leading-none">
                Run every building project from one calm workspace.
              </Text>
              <Text kind="body/regular/md" className="max-w-2xl text-subtle">
                Grid keeps files, context, colleagues, OIB research, and project conversations together so the assistant is only one part of the workspace.
              </Text>
            </Flex>
            <div className="grid min-w-[220px] grid-cols-2 gap-3 rounded-[1.5rem] border border-base bg-surface-sunken p-4">
              <div>
                <Text kind="body/bold/2xl" className="text-primary">
                  {rows.length}
                </Text>
                <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.18em]">
                  active
                </Text>
              </div>
              <div>
                <Text kind="body/bold/2xl" className="text-primary">
                  OIB
                </Text>
                <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.18em]">
                  corpus
                </Text>
              </div>
            </div>
          </Flex>
        </Flex>
      </section>

      <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[380px_1fr]">
        <aside className="rounded-[1.75rem] border border-base bg-surface-raised-30 p-5 lg:sticky lg:top-6 lg:self-start">
          <Flex direction="col" gap="4">
            <Flex align="center" gap="3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-base bg-surface-sunken text-brand">
                <Plus className="h-5 w-5" />
              </div>
              <Flex direction="col" gap="1">
                <Text kind="label/bold/md" className="text-primary">
                  New workspace
                </Text>
                <Text kind="body/regular/sm" className="text-subtle">
                  Name the mission, then add documents and members.
                </Text>
              </Flex>
            </Flex>
            <CreateProjectForm />
          </Flex>
        </aside>

        {rows.length === 0 ? (
          <Flex direction="col" align="center" justify="center" gap="4" className="min-h-[420px] rounded-[2rem] border border-dashed border-base bg-surface-raised-30 p-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-[1.25rem] border border-base bg-surface-sunken text-brand">
              <SelectEllipse className="h-7 w-7" />
            </div>
            <Text kind="label/bold/lg" className="text-primary">
              No project has been staged yet
            </Text>
            <Text kind="body/regular/md" className="max-w-md text-subtle">
              Create the first workspace on the left. The project selector, member access, and project chat unlock after that.
            </Text>
          </Flex>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {rows.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </section>
      </main>
    </AppShell>
  )
}
