// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq } from 'drizzle-orm'
import { Users } from 'lucide-react'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { ProjectMembersForm } from '@/components/projects/project-members-form'

interface ProjectMembersPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectMembersPage({ params }: ProjectMembersPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:manage')

  const db = getDb()
  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, id)).limit(1)

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8">
      <header className="mb-8 flex items-start gap-4 border-b pb-8">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border bg-muted text-primary">
          <Users className="h-6 w-6" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
            access matrix
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">
            {project?.name ?? 'Project'} members
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Add organization members to this project by assigning a project role. Set no access to
            remove them from this workspace.
          </p>
        </div>
      </header>
      <ProjectMembersForm projectId={id} />
    </div>
  )
}
