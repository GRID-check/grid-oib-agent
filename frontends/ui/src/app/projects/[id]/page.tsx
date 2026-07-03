// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq, and, desc, sql } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects, documents } from '@/lib/db/schema'
import { ProjectOverview } from '@/features/projects/components/project-overview'
import type { ProjectOverviewData } from '@/features/projects/types'

interface ProjectPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectPage({ params }: ProjectPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const db = getDb()

  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      collectionName: projects.collectionName,
      createdAt: projects.createdAt,
      profileDisplay: projects.profileDisplay,
    })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.organizationId, session.organizationId)))
    .limit(1)

  if (!project) {
    throw new Error('Project not found')
  }

  const [stats] = await db
    .select({
      count: sql<number>`count(*)::int`.as('count'),
      totalSize: sql<number>`coalesce(sum(${documents.fileSize}), 0)::bigint`.as('total_size'),
    })
    .from(documents)
    .where(and(eq(documents.projectId, id), eq(documents.organizationId, session.organizationId)))

  const recentDocs = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      fileSize: documents.fileSize,
      contentType: documents.contentType,
      status: documents.status,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(and(eq(documents.projectId, id), eq(documents.organizationId, session.organizationId)))
    .orderBy(desc(documents.createdAt))
    .limit(5)

  const data: ProjectOverviewData = {
    id: project.id,
    name: project.name,
    collectionName: project.collectionName,
    createdAt: project.createdAt.toISOString(),
    profileDisplay: project.profileDisplay
      ? {
          ...project.profileDisplay,
          keyFacts: project.profileDisplay?.keyFacts ?? [],
        }
      : null,
    documentCount: stats?.count ?? 0,
    totalFileSize: Number(stats?.totalSize) || 0,
    recentDocuments: recentDocs.map((d) => ({
      ...d,
      fileSize: d.fileSize,
    })),
  }

  return <ProjectOverview data={data} />
}
