/**
 * The work starts a reading (ADR-0111): a completed upload batch on a project
 * whose intake is not finished queues a BFF job, `project_intake_read`, that
 * starts one as the uploader, unless the batch was opened with `startsIntake`
 * off. `settleUploadBatches` is where "these documents
 * are read" first becomes true on the server, so it calls here.
 *
 * Only an uploader who may write the profile (`project:memory:write` or
 * `project:edit`) starts one; for anyone else nothing is queued and the setup
 * page offers „Lesen starten" to someone who may. Decided now and again when
 * the job runs, because a job can wait.
 *
 * Imports no service, so the settle path does not pull the intake's service
 * (and everything behind it) into reconciliation.
 */

import 'server-only'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import type { UploadBatch } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { BFF_JOB_PRIORITY, requesterOf, type ProjectIntakeReadPayload } from '@/lib/jobs-queue/types'
import { listOpenIntakeProjectIds } from './repository'

/** The two rights that write the profile, either one enough (`PROFILE_WRITE` in `profile-service.ts`). */
const PROFILE_WRITE = ['project:memory:write', 'project:edit'] as const

async function mayWriteProfile(organizationId: string, projectId: string, userId: string): Promise<boolean> {
  for (const permission of PROFILE_WRITE) {
    if (await userHoldsProjectPermission({ organizationId }, projectId, userId, permission)) return true
  }
  return false
}

/** Queue a reading of `projectId` as `userId`. Whether one was queued. */
export async function enqueueIntakeRead(organizationId: string, projectId: string, userId: string): Promise<boolean> {
  const session = await resolvePinnedRequesterSession({ userId, email: null, organizationId })
  if (!session) return false
  if (!(await mayWriteProfile(organizationId, projectId, userId))) return false
  const payload: ProjectIntakeReadPayload = { projectId, requester: requesterOf(session) }
  // The queue row is the organization's lane, stored in its tenant scope.
  await withTenant({ organizationId }, () =>
    enqueueJob({
      kind: 'project_intake_read',
      organizationId,
      payload,
      // A finished upload is nobody's question: it yields to a person's upload.
      priority: BFF_JOB_PRIORITY.bulk,
    })
  )
  return true
}

/**
 * After these batches completed: one reading per project with an open intake,
 * as the uploader of the first of its batches that starts one. A batch opened
 * with `startsIntake` off (migration 0185) starts none. The projects queued.
 */
export async function queueIntakeReadsAfterUpload(
  organizationId: string,
  completed: readonly Pick<UploadBatch, 'scope' | 'projectId' | 'createdBy' | 'startsIntake'>[]
): Promise<string[]> {
  const uploaderOf = new Map<string, string>()
  for (const batch of completed) {
    if (!batch.startsIntake || batch.scope !== 'project' || !batch.projectId || uploaderOf.has(batch.projectId)) continue
    uploaderOf.set(batch.projectId, batch.createdBy)
  }
  if (uploaderOf.size === 0) return []
  const open = await listOpenIntakeProjectIds(organizationId, [...uploaderOf.keys()])
  const queued = await Promise.all(
    open.map(async (projectId) =>
      (await enqueueIntakeRead(organizationId, projectId, uploaderOf.get(projectId) ?? '')) ? projectId : null
    )
  )
  return queued.filter((projectId): projectId is string => projectId !== null)
}
