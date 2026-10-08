/**
 * Organization roles client (ADR-0084): the office's roles and its own custom
 * roles, through their first-party BFF routes.
 *
 *   - list   → `GET    /api/organization/roles`
 *   - create → `POST   /api/organization/roles`
 *   - update → `PATCH  /api/organization/roles/[slug]`
 *   - delete → `DELETE /api/organization/roles/[slug]`
 *
 * The server type lives in `lib/authz/custom-roles.ts`, which is server-only,
 * so the wire shape is declared here.
 */

import { z } from 'zod'
import { ApiRequestError } from './api-error'

const OrganizationRoleSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  custom: z.boolean(),
  permissions: z.array(z.string()).optional(),
})

const AssignablePermissionSchema = z.object({ slug: z.string(), grantable: z.boolean() })

const OrganizationRolesSchema = z.object({
  roles: z.array(OrganizationRoleSchema),
  assignable: z.array(AssignablePermissionSchema).nullable(),
})

const RoleResponseSchema = z.object({ role: OrganizationRoleSchema })

export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>
export type AssignablePermission = z.infer<typeof AssignablePermissionSchema>
export type OrganizationRoles = z.infer<typeof OrganizationRolesSchema>

export interface CustomRoleFields {
  name: string
  description: string | null
  permissions: string[]
}

async function requestError(response: Response, fallback: string): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null)
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  return new ApiRequestError(
    typeof message === 'string' && message ? message : `${fallback}: ${response.status}`,
    response.status
  )
}

const roleUrl = (slug: string): string => `/api/organization/roles/${encodeURIComponent(slug)}`

/** Every role in the organization; permissions and `assignable` only for a role manager. */
export async function listOrganizationRoles(signal?: AbortSignal): Promise<OrganizationRoles> {
  const response = await fetch('/api/organization/roles', { signal })
  if (!response.ok) throw await requestError(response, 'Failed to load the roles')
  return OrganizationRolesSchema.parse(await response.json())
}

/** Create a custom role. 409 = a role of that name exists; 403 = a permission the editor lacks. */
export async function createCustomRole(fields: CustomRoleFields): Promise<OrganizationRole> {
  const response = await fetch('/api/organization/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  if (!response.ok) throw await requestError(response, 'Failed to create the role')
  return RoleResponseSchema.parse(await response.json()).role
}

/** Change a custom role's name, description or permissions. The slug never changes. */
export async function updateCustomRole(slug: string, fields: Partial<CustomRoleFields>): Promise<OrganizationRole> {
  const response = await fetch(roleUrl(slug), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  if (!response.ok) throw await requestError(response, 'Failed to update the role')
  return RoleResponseSchema.parse(await response.json()).role
}

/** Delete a custom role. 409 = somebody still holds it. */
export async function deleteCustomRole(slug: string): Promise<void> {
  const response = await fetch(roleUrl(slug), { method: 'DELETE' })
  if (!response.ok) throw await requestError(response, 'Failed to delete the role')
}
