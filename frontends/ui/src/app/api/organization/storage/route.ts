/**
 * Organization storage usage (ADR-0042). READ ONLY.
 *
 * Every member may read this: a member whose upload was just refused is usually
 * not an admin, and this is the only thing that explains the refusal.
 *
 * There is deliberately no PUT. The quota is a commercial constraint the
 * platform operator imposes, so a tenant that could raise its own would not be
 * constrained at all. The write lives at
 * `/api/platform/organizations/[organizationId]/storage`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getStorageOverview } from '@/lib/storage/service'

export const GET = apiRoute(async ({ session }) => getStorageOverview(session), {
  authz: {
    sessionOnly: true,
    why: "every member may read their own organization's storage usage; the read is keyed by session.organizationId, and the quota is not writable from inside the tenant at all",
  },
})
