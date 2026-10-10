/**
 * Change or delete one person of a project's Steckbrief (ADR-0091). Deleting
 * is the erasure, and stays possible in a closed project for whoever manages
 * it. Thin handlers; the rules live in `steckbrief-service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { deleteProjectPerson, updateProjectPerson } from '@/lib/projects/steckbrief-service'
import { projectPersonSchema } from '@/lib/projects/steckbrief-types'

type Params = { id: string; personId: string }

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const person = await parseJsonBody(request, projectPersonSchema)
    return updateProjectPerson(session, params.id, params.personId, person, request)
  },
  { authz: { enforcedBy: 'updateProjectPerson (requireProjectAccess project:memory:write | project:edit)' } }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params, request }) => {
    await deleteProjectPerson(session, params.id, params.personId, request)
    return null
  },
  {
    status: 204,
    authz: { enforcedBy: 'deleteProjectPerson (profile write; project:manage in a closed project)' },
  }
)
