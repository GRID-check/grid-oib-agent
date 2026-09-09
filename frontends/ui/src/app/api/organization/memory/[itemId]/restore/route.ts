/**
 * Undo a supersession on one ORGANIZATION-scoped memory item (ADR-0055).
 *
 * The org twin of `POST /api/projects/{id}/memory/{itemId}/restore`, and it
 * exists because the project memory panel lists org-wide notes alongside the
 * project's own: a correction visible there with no way to reverse it would be
 * the same dead end the ADR is closing, one surface along. Tenancy comes from
 * the session's organization id and the service scopes the swap in SQL, exactly
 * as the PATCH and DELETE beside it do — so an item id from another tenant
 * resolves to nothing.
 *
 * Deliberately open to members like the rest of this route family: org memory
 * is shared by every project in the tenant and is not admin-gated here.
 */

import { apiRoute } from '@/lib/api/handler'
import { NotFoundError } from '@/lib/api/errors'
import { restoreSupersededMemoryItem } from '@/lib/projects/memory-service'

type Params = { itemId: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => {
    const outcome = await restoreSupersededMemoryItem(
      { organizationId: session.organizationId },
      params.itemId
    )
    if (!outcome) throw new NotFoundError()
    return outcome
  },
  {
    authz: {
      sessionOnly: true,
      why: 'org-scoped memory restore, keyed by session.organizationId; deliberately open to members like the create and edit paths',
    },
  }
)
