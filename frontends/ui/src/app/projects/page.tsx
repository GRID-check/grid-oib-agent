// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq, asc } from 'drizzle-orm'
import { FolderOpen, Plus } from 'lucide-react'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
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
        <header className="flex flex-col justify-between gap-6 border-b pb-8 md:flex-row md:items-end">
          <div className="flex max-w-2xl flex-col gap-3">
            <span className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
              Architecture project OS
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">
              Run every building project from one calm workspace.
            </h1>
            <p className="text-sm text-muted-foreground">
              Grid keeps files, context, colleagues, OIB research, and project conversations
              together so the assistant is only one part of the workspace.
            </p>
          </div>
          <div className="grid min-w-[220px] grid-cols-2 gap-3 rounded-lg border bg-card p-4">
            <div>
              <p className="text-2xl font-semibold tracking-tight">{rows.length}</p>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">active</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tracking-tight">OIB</p>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">corpus</p>
            </div>
          </div>
        </header>

        <section className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[380px_1fr]">
          <aside className="h-fit rounded-lg border bg-card p-5 lg:sticky lg:top-6">
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted text-primary">
                  <Plus className="h-5 w-5" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <h2 className="text-sm font-semibold">New workspace</h2>
                  <p className="text-sm text-muted-foreground">
                    Name the mission, then add documents and members.
                  </p>
                </div>
              </div>
              <CreateProjectForm />
            </div>
          </aside>

          {rows.length === 0 ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-md border bg-muted text-primary">
                <FolderOpen className="h-6 w-6" />
              </div>
              <h2 className="text-lg font-semibold tracking-tight">
                No project has been staged yet
              </h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Create the first workspace on the left. The project selector, member access, and
                project chat unlock after that.
              </p>
            </div>
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
