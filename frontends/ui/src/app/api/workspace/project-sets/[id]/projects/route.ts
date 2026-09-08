/**
 * What a Sammlung names: add projects to it, take projects out of it (GR-2).
 *
 * The two directions are deliberately asymmetric, for the reason mounting and
 * unmounting are:
 *
 *   - **Adding** demands `project:view` on every id, and refuses the WHOLE call
 *     if any fails. Otherwise a Sammlung would be a way to publish a project's
 *     name to people who may not see the project, and a half-applied add would
 *     leave the caller believing the set holds seven projects when it holds
 *     five. The refusal is a 404 naming nothing: adding ids to your own set must
 *     not be a way to discover which project ids this organization holds.
 *   - **Removing** demands no project permission at all. Narrowing a set edits
 *     the LABEL, not the project, so a member who has since lost `project:view`
 *     on something in their own set must still be able to take it out.
 *
 * Both answer with the whole set, so a client never has to re-read to render
 * the result of its own edit.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { addProjectsToSet, removeProjectsFromSet } from '@/lib/workspace/project-sets-service'

type Params = { id: string }

const projectIdsSchema = z.object({
  projectIds: z.array(z.string().uuid()).min(1),
})

export const POST = apiRoute<Params>(
  async ({ session, request, params }) => {
    const { projectIds } = await parseJsonBody(request, projectIdsSchema)
    return { set: await addProjectsToSet(session, params.id, projectIds) }
  },
  {
    authz: {
      enforcedBy:
        'addProjectsToSet (org:chat + creator-or-org:projects:administer on the set, and ' +
        'requireProjectAccess project:view on EVERY id before anything is written)',
    },
  }
)

export const DELETE = apiRoute<Params>(
  async ({ session, request, params }) => {
    const { projectIds } = await parseJsonBody(request, projectIdsSchema)
    return { set: await removeProjectsFromSet(session, params.id, projectIds) }
  },
  {
    authz: {
      enforcedBy:
        'removeProjectsFromSet (org:chat + creator-or-org:projects:administer on the set; ' +
        'no project permission — narrowing a set edits the label, not the project)',
    },
  }
)
