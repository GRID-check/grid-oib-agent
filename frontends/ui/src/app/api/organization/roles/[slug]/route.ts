/**
 * One custom role (ADR-0087). `org:members:manage` for both methods; the
 * service refuses a platform role (403), a slug that is not this
 * organization's (404), adding a permission the editor lacks (403), and
 * deleting a role somebody still holds (409).
 *
 * PATCH  { name?, description?, permissions? } — the slug never changes.
 * DELETE — removes the role in WorkOS.
 */

import { BadRequestError } from '@/lib/api/errors'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { deleteCustomRole, updateCustomRole } from '@/lib/authz/custom-roles'
import { roleFieldsSchema } from '../schema'

type Params = { slug: string }

const patchSchema = roleFieldsSchema.partial().strict()

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, patchSchema)
    if (Object.keys(input).length === 0) throw new BadRequestError('Nothing to change')
    return { role: await updateCustomRole(session, params.slug, input, request) }
  },
  { authz: { permission: ORG_PERMISSIONS.membersManage } }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params, request }) => {
    await deleteCustomRole(session, params.slug, request)
    return { slug: params.slug }
  },
  { authz: { permission: ORG_PERMISSIONS.membersManage } }
)
