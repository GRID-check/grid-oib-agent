// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq, and } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { ProjectFileWorkspace } from '@/features/documents/components/project-file-workspace'

interface FilesPageProps {
  params: Promise<{ id: string }>
}

export default async function FilesPage({ params }: FilesPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params
  await requireProjectAccess(session, id, 'project:view')

  const db = getDb()
  const [project] = await db
    .select({ name: projects.name, collectionName: projects.collectionName })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.organizationId, session.organizationId)))
    .limit(1)

  if (!project) {
    notFound()
  }

  return <ProjectFileWorkspace projectId={id} projectName={project.name} collectionName={project.collectionName} />
}
