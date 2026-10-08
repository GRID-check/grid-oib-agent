/**
 * Add a person to a project's Steckbrief (ADR-0090). Thin handler; who may,
 * the account check and the audit trail live in `steckbrief-service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { addProjectPerson } from '@/lib/projects/steckbrief-service'
import { projectPersonSchema } from '@/lib/projects/steckbrief-types'

export const POST = apiRoute<{ id: string }>(
  async ({ session, params, request }) => {
    const person = await parseJsonBody(request, projectPersonSchema)
    return addProjectPerson(session, params.id, person, request)
  },
  { status: 201, authz: { enforcedBy: 'addProjectPerson (requireProjectAccess project:memory:write | project:edit)' } }
)
