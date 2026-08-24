/**
 * Projects API — list and create projects for the current organization.
 * Thin handlers; all logic lives in `@/lib/projects/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { createProject, listProjects } from '@/lib/projects/service'

const createProjectSchema = z.object({
  name: z.string().min(1).max(255).trim(),
})

export const GET = apiRoute(async ({ session }) => listProjects(session), {
  authz: { enforcedBy: 'listProjects (per-project FGA filter, ADR-0038)' },
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, createProjectSchema)
    return createProject(session, input, request)
  },
  { status: 201, authz: { permission: ORG_PERMISSIONS.projectsCreate } }
)
