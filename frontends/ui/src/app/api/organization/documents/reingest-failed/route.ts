/**
 * Organization-wide failed-ingestion rescan - send every document that could
 * not be read back through the ingest pipeline under its own id.
 *
 * Thin handler; the enqueue lives in `@/lib/documents/service`, the walk is a
 * `bff-jobs` job (ADR-0079) and the failed-id paging is in
 * `@/lib/documents/repository`. Answers 202 with the job's id as soon as it is
 * queued. Gated on `org:settings:manage`: only an org admin may re-read the
 * whole tenant's estate at once (per-document retries stay on their own routes
 * with their own project-scoped checks).
 */

import { apiRoute } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { reingestFailedOrgDocuments } from '@/lib/documents/service'

export const POST = apiRoute(async ({ session }) => reingestFailedOrgDocuments(session), {
  status: 202,
  authz: { permission: ORG_PERMISSIONS.settingsManage },
})
