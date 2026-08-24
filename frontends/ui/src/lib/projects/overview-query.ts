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
    .where(
      and(
        eq(documents.projectId, projectId),
        eq(documents.organizationId, organizationId),
        // The shelf, stated — the same predicate `listProjectDocuments` and
        // `countDocumentsByProject` carry (`lib/documents/repository.ts`), so
        // the overview's number is the count of the same thing the project's
        // document list shows.
        //
        // It cannot leak today: the other two shelves both have a NULL
        // `projectId` — the org-wide Archiv by construction, a session document
        // because its shelf is the conversation — and NULL never satisfies a
        // `project_id = $1` equality, so those rows are already excluded. It is
        // stated anyway because that is a coincidence of the data, not a
        // property of the query: the query asks "which rows have this project",
        // and reads as "which documents belong to this project" only while no
        // row can hold both a project and a non-project scope. The partition
        // must be an invariant, not a coincidence — which is why migration 0049
        // also writes it into the table.
        eq(documents.scope, 'project')
      )
    )

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
    .where(
      and(
        eq(documents.projectId, projectId),
        eq(documents.organizationId, organizationId),
        // Same predicate as the count above, for the same reason, and here the
        // two must agree by asking the same question: a "recent documents" list
        // that could show a row the count above excluded (or the reverse) is a
        // page that contradicts itself.
        eq(documents.scope, 'project')
      )
    )
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
