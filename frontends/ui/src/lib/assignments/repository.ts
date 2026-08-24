/**
 * Assignments repository — who is on the hook for a shareable resource (ADR-0047).
 * No authorization here; the service owns that.
 */

import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { resourceAssignments, type ShareableResourceType } from '@/lib/db/schema'

export interface AssignmentRow {
  resourceType: ShareableResourceType
  resourceId: string
  subjectUserId: string
  assignedBy: string
  createdAt: Date
}

export async function listAssignmentsForResources(
  organizationId: string,
  resourceType: ShareableResourceType,
  resourceIds: readonly string[],
): Promise<AssignmentRow[]> {
  if (resourceIds.length === 0) return []
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({
        resourceType: resourceAssignments.resourceType,
        resourceId: resourceAssignments.resourceId,
        subjectUserId: resourceAssignments.subjectUserId,
        assignedBy: resourceAssignments.assignedBy,
        createdAt: resourceAssignments.createdAt,
      })
      .from(resourceAssignments)
      .where(
        and(
          eq(resourceAssignments.organizationId, organizationId),
          eq(resourceAssignments.resourceType, resourceType),
          inArray(resourceAssignments.resourceId, [...resourceIds]),
        ),
      ),
  )
}

export async function listAssignmentsForSubject(
  organizationId: string,
  resourceType: ShareableResourceType,
  subjectUserId: string,
): Promise<AssignmentRow[]> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({
        resourceType: resourceAssignments.resourceType,
        resourceId: resourceAssignments.resourceId,
        subjectUserId: resourceAssignments.subjectUserId,
        assignedBy: resourceAssignments.assignedBy,
        createdAt: resourceAssignments.createdAt,
      })
      .from(resourceAssignments)
      .where(
        and(
          eq(resourceAssignments.organizationId, organizationId),
          eq(resourceAssignments.resourceType, resourceType),
          eq(resourceAssignments.subjectUserId, subjectUserId),
        ),
      ),
  )
}

export async function insertAssignment(input: {
  organizationId: string
  resourceType: ShareableResourceType
  resourceId: string
  subjectUserId: string
  assignedBy: string
}): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId: input.organizationId }, () =>
    db
      .insert(resourceAssignments)
      .values({
        organizationId: input.organizationId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        subjectUserId: input.subjectUserId,
        assignedBy: input.assignedBy,
      })
      .onConflictDoNothing(),
  )
}

export async function deleteAssignment(
  organizationId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
): Promise<boolean> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .delete(resourceAssignments)
      .where(
        and(
          eq(resourceAssignments.organizationId, organizationId),
          eq(resourceAssignments.resourceType, resourceType),
          eq(resourceAssignments.resourceId, resourceId),
          eq(resourceAssignments.subjectUserId, subjectUserId),
        ),
      )
      .returning({ id: resourceAssignments.id }),
  )
  return rows.length > 0
}

export async function deleteAssignmentsForResource(
  organizationId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<number> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .delete(resourceAssignments)
      .where(
        and(
          eq(resourceAssignments.organizationId, organizationId),
          eq(resourceAssignments.resourceType, resourceType),
          eq(resourceAssignments.resourceId, resourceId),
        ),
      )
      .returning({ id: resourceAssignments.id }),
  )
  return rows.length
}

export async function deleteAssignmentsForSubjectInResources(
  organizationId: string,
  resourceType: ShareableResourceType,
  resourceIds: readonly string[],
  subjectUserId: string,
): Promise<number> {
  if (resourceIds.length === 0) return 0
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .delete(resourceAssignments)
      .where(
        and(
          eq(resourceAssignments.organizationId, organizationId),
          eq(resourceAssignments.resourceType, resourceType),
          eq(resourceAssignments.subjectUserId, subjectUserId),
          inArray(resourceAssignments.resourceId, [...resourceIds]),
        ),
      )
      .returning({ id: resourceAssignments.id }),
  )
  return rows.length
}
