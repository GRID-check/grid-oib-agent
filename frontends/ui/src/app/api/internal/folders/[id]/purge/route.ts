/**
 * INTERNAL service endpoint — the purger's purge of a folder from the
 * Papierkorb once its grace period is over (`purger/purge-folder.js`,
 * `docs/architecture/deletion-pipeline.md`).
 *
 * The purger claims the `deletion_queue` row (attempts, backoff, the legal-hold
 * guard, terminal `failed`) and POSTs here; this runs the same purge
 * „Endgültig löschen" runs in a request (`purgeBinnedFolder`), so the steps
 * exist once. The purger then erases the traces this answer names and closes
 * the row.
 *
 * Token-guarded (`internalApiRoute`); the organization is the queue row's.
 * Answers 409 `legal_hold` when a hold covers the folder (the purger defers the
 * row) and 409 `not_in_bin` for a folder that is not deleted (it fails the row
 * for good).
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { purgeBinnedFolder } from '@/lib/projects/folder-bin'

type Params = { id: string }

const purgeSchema = z.object({
  organizationId: z.string().min(1).max(128),
})

export const POST = internalApiRoute<Params>(
  'Internal Folder Purge',
  async ({ request, params }) => {
    const { organizationId } = await parseJsonBody(request, purgeSchema)
    const result = await withTenant({ organizationId }, () => purgeBinnedFolder(organizationId, params.id))
    return {
      status: result.status,
      counts: result.counts,
      traceConversationIds: result.traceConversationIds,
    }
  },
  { tenancy: { fromPayload: 'body.organizationId' } }
)
