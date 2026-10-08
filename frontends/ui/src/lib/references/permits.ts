/**
 * The permit records of one project as the person reading it may see them
 * (permitting memory, ADR-0094). The access is the project memory's own: the
 * project must be viewable, and a record from a restricted folder shows only
 * to a reader cleared for every folder it sits in (`memoryClearance`, the same
 * read `getProjectMemory` judges by, ADR-0088). The query is the permits
 * repository's; this file decides who may ask.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { listPermitRecordsForProject, type ListedPermitRecord } from '@/lib/permits/repository'
import { memoryClearance } from '@/lib/projects/service'
import { SIMILAR_PERMIT_RECORDS_READ, SIMILAR_PERMIT_REQUIREMENTS_MAX } from './types'

/** The newest permit records of a project the reader may see, each with its first requirements. */
export async function listPermitRecordsForPerson(
  session: AuthorizedSession,
  projectId: string
): Promise<ListedPermitRecord[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  const { cleared } = await memoryClearance(session, projectId)
  return listPermitRecordsForProject(session.organizationId, projectId, cleared, {
    maxRecords: SIMILAR_PERMIT_RECORDS_READ,
    maxPerRecord: SIMILAR_PERMIT_REQUIREMENTS_MAX,
  })
}
