/**
 * One Sammlung: read it, rename or re-describe it, delete it (spec GR-2).
 *
 * `GET` answers with the members THIS caller may view, which is also the number
 * the Büro would mount — so a UI measuring it against the mount cap is
 * measuring the right thing. `PATCH` and `DELETE` are the creator's, or an
 * organization project administrator's (`org:projects:administer`): personal
 * shorthand should not need an administrator, and the office's shared
 * vocabulary should not be editable by whoever happens to open it.
 *
 * Deleting a Sammlung takes its memberships and NOTHING else. A conversation
 * that mounted it holds ordinary mount rows from the moment they were written
 * (spec MT-14), so the name going away must not change what a thread reads.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import {
  deleteProjectSet,
  getProjectSet,
  updateProjectSet,
} from '@/lib/workspace/project-sets-service'

type Params = { id: string }

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullish(),
})

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({ set: await getProjectSet(session, params.id) }),
  {
    authz: {
      enforcedBy:
        'getProjectSet (org:chat + the set resolved inside the caller’s organization; its ' +
        'members are filtered per caller through filterReadableProjects)',
    },
  }
)

export const PATCH = apiRoute<Params>(
  async ({ session, request, params }) => {
    const body = await parseJsonBody(request, updateSchema)
    return { set: await updateProjectSet(session, params.id, body) }
  },
  {
    authz: {
      enforcedBy:
        'updateProjectSet (org:chat + creator-or-org:projects:administer on the set itself)',
    },
  }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params }) => {
    await deleteProjectSet(session, params.id)
    return null
  },
  {
    status: 204,
    authz: {
      enforcedBy:
        'deleteProjectSet (org:chat + creator-or-org:projects:administer on the set itself)',
    },
  }
)
