/**
 * Close or reopen a project (ADR-0086). Thin handler; who may, and the audit
 * trail, live in `setProjectStatus` (`@/lib/projects/service`).
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { setProjectStatus } from '@/lib/projects/service'
import { PROJECT_STATUSES } from '@/lib/projects/project-status'

const statusSchema = z.object({ status: z.enum(PROJECT_STATUSES) })

export const PUT = apiRoute<{ id: string }>(
  async ({ session, params, request }) => {
    const { status } = await parseJsonBody(request, statusSchema)
    const project = await setProjectStatus(session, params.id, status, request)
    return {
      id: project.id,
      status: project.status,
      closedAt: project.closedAt?.toISOString() ?? null,
      closedBy: project.closedBy,
    }
  },
  { authz: { enforcedBy: 'setProjectStatus (requireProjectAccess project:manage, evenWhenClosed)' } }
)
