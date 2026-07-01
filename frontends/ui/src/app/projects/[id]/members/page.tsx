// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { Text } from '@/adapters/ui'
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
    <main className="container mx-auto px-4 py-8">
      <Text kind="body/bold/2xl" className="mb-6 text-primary">
        {project?.name ?? 'Project'} members
      </Text>
      <ProjectMembersForm projectId={id} />
    </main>
  )
}
