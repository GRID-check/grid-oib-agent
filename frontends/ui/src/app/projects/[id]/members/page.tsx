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

  // Read access is enough to view the roster; management controls are gated
  // separately (below) so editors/viewers get a dignified read-only view
  // instead of a hard crash.
  const { role } = await requireProjectAccess(session, id, 'project:view')
  const canManage = role === 'project-admin'

  const db = getDb()
  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, id)).limit(1)

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8">
      <header className="mb-8 flex items-start gap-4 border-b pb-8">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border bg-muted text-primary">
          <Users className="h-6 w-6" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Access
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">
            {project?.name ?? 'Project'} members
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {canManage
              ? 'Grant organization members access to this project by assigning a project role, or set no access to remove them.'
              : 'Everyone with access to this project. Only project admins can change roles or add members.'}
          </p>
        </div>
      </header>
      <ProjectMembersForm projectId={id} canManage={canManage} />
    </div>
  )
}
