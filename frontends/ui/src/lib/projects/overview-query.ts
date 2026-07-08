import { eq, and, desc, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projects, documents } from '@/lib/db/schema'
import type { ProjectOverviewData } from '@/features/projects/types'
import { getApplicableStandards } from '@/lib/oib/applicable-standards'

/**
 * Load the project overview data (project metadata, document stats, and the
 * most recent documents) scoped to the given organization.
 *
 * Returns null when the project does not exist or does not belong to the
 * organization, so callers can decide how to surface that (404 page vs.
 * JSON error envelope).
 */
export async function getProjectOverviewData(
  projectId: string,
  organizationId: string
): Promise<ProjectOverviewData | null> {
  const db = getDb()

  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      collectionName: projects.collectionName,
      createdAt: projects.createdAt,
      profile: projects.profile,
      profileDisplay: projects.profileDisplay,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
    .limit(1)

  if (!project) {
    return null
  }

  const [stats] = await db
    .select({
      count: sql<number>`count(*)::int`.as('count'),
      totalSize: sql<number>`coalesce(sum(${documents.fileSize}), 0)::bigint`.as('total_size'),
    })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.organizationId, organizationId)))

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
    .where(and(eq(documents.projectId, projectId), eq(documents.organizationId, organizationId)))
    .orderBy(desc(documents.createdAt))
    .limit(5)

  // Derive which OIB-Richtlinien apply from the project's own brief, and whether
  // that brief has enough captured facts to tailor the applicability.
  const applicableStandards = getApplicableStandards(project.profile ?? null)
  const briefComplete = Boolean(project.profileDisplay?.keyFacts?.length)

  return {
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
    profile: project.profile ?? null,
    applicableStandards,
    briefComplete,
    documentCount: stats?.count ?? 0,
    totalFileSize: Number(stats?.totalSize) || 0,
    recentDocuments: recentDocs.map((d) => ({
      ...d,
      fileSize: d.fileSize,
    })),
  }
}
