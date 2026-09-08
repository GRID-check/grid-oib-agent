/**
 * Unmounting one project from a Büro conversation (ADR-0054, spec MT-13).
 *
 * `204`, and deliberately the same `204` whether a row was there or not: the
 * caller asked for "this conversation no longer reads that project", and that
 * is true either way. Nothing about answers already given changes — a mount
 * decides what the NEXT turn may read.
 */

import { apiRoute } from '@/lib/api/handler'
import { unmountProject } from '@/lib/workspace/mounts-service'

type Params = { id: string; projectId: string }

export const DELETE = apiRoute<Params>(
  async ({ session, params }) => {
    await unmountProject(session, params.id, params.projectId)
    return null
  },
  {
    status: 204,
    authz: {
      enforcedBy:
        'unmountProject (requireResourceAccess conversation collaborator — narrowing a ' +
        'thread’s scope is contributing to it, and needs no project permission)',
    },
  }
)
