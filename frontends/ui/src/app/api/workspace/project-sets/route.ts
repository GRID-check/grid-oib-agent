/**
 * Sammlungen — the organization's named sets of projects (ADR-0054, spec GR-2).
 *
 * `GET` is what the Büro's scope tree reads to offer "Bezirk 3" beside the
 * individual projects; `POST` is what naming one does. Mounting a Sammlung is
 * NOT here — it is `POST /api/conversations/:id/mounts` with a `projectSetId`,
 * because a set expands to the same mount rows through the same service and the
 * cap must stay in one place (MT-8).
 *
 * Thin adapters. Every decision — `org:chat`, the creator-or-administrator edit
 * rule, `project:view` per member, and the per-caller readability that keeps a
 * set from naming a project the projects grid hides — belongs to
 * `lib/workspace/project-sets-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { createProjectSet, listProjectSets } from '@/lib/workspace/project-sets-service'

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
})

export const GET = apiRoute(async ({ session }) => ({ sets: await listProjectSets(session) }), {
  authz: {
    enforcedBy:
      'listProjectSets (org:chat; each set’s projectCount is filtered per caller through ' +
      'filterReadableProjects, so a member never learns a project name via a Sammlung)',
  },
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const body = await parseJsonBody(request, createSchema)
    return { set: await createProjectSet(session, body) }
  },
  {
    status: 201,
    authz: {
      enforcedBy:
        'createProjectSet (org:chat — a Sammlung is a label over projects and grants ' +
        'nobody access to any of them, so naming one is the ordinary right to use the Büro)',
    },
  }
)
