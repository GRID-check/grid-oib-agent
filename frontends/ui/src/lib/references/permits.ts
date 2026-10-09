/**
 * The permit records of one project as the person reading it may see them
 * (permitting memory, ADR-0094). The project must be viewable, and a record
 * whose document sits in a restricted folder shows only to a reader whose
 * roles may read every folder restricting it now: the folders they may read
 * come from their per-role read grants (`memoryClearance`, the read
 * `getProjectMemory` judges by, ADR-0088), and each document is judged from
 * its live folder against them (`liveFolderAccess`). The query is the permits
 * repository's; this file decides who may ask.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { liveFolderAccess } from '@/lib/permits/live-access'
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
  // Judged from where each document is now, as the search judges it (permits/live-access.ts).
  const access = await liveFolderAccess(session.organizationId, projectId, cleared)
  return listPermitRecordsForProject(session.organizationId, projectId, access.visibleFolderIds, {
    maxRecords: SIMILAR_PERMIT_RECORDS_READ,
    maxPerRecord: SIMILAR_PERMIT_REQUIREMENTS_MAX,
  })
}
