/**
 * Organization-wide failed-ingestion rescan - send every document that could
 * not be read back through the ingest pipeline under its own id.
 *
 * Thin handler; the failed-id listing lives in `@/lib/documents/repository`
 * and the bounded fan-out in `@/lib/documents/service`. Gated on
 * `org:settings:manage`: only an org admin may re-read the whole tenant's
 * estate at once (per-document retries stay on their own routes with their
 * own project-scoped checks).
 */

import { apiRoute } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { reingestFailedOrgDocuments } from '@/lib/documents/service'

export const POST = apiRoute(
  async ({ session }) => reingestFailedOrgDocuments(session),
  { authz: { permission: ORG_PERMISSIONS.settingsManage } }
)
