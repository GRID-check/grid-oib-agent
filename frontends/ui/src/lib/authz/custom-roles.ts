/**
 * An office's own roles, kept in WorkOS (ADR-0087).
 *
 * WorkOS has organization-scoped custom roles: roles that exist only inside one
 * organization, with a slug that starts `org-`, a name, and permissions from
 * the environment's set. They behave like the catalog's roles everywhere —
 * sessions, the membership API, the `UsersManagement` widget that assigns
 * roles — so an office that builds „Geschäftsführung" here assigns it on the
 * People tab like any other role, and a restricted folder can name it.
 *
 * Who may: `org:members:manage` (the User Admin persona and Admin). And only
 * with permissions they hold themselves: a role is a bundle of permissions, so
 * letting a User Admin compose one with `org:models:manage` would let them
 * grant themselves what they were never given. The catalog's environment roles
 * are listed and never edited here; they are the platform's.
 */

import 'server-only'
import { ConflictError, ForbiddenError, NotFoundError, BadRequestError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getCached, invalidateCached } from '@/lib/cache'
import { getWorkOS } from '@/lib/workos/client'
import { ORG_PERMISSION_SPECS } from './catalog'
import { listFoldersNamingRole, type FolderNamingRole } from './folder-access-repository'
import { hasPermission, ORG_PERMISSIONS, type KnownPermission } from './permissions'

/** One role as an office sees it. */
export interface OrganizationRoleView {
  slug: string
  name: string
  description: string | null
  /** True for a role this organization built; false for the platform's. */
  custom: boolean
  /** Present only for a reader who may manage roles. */
  permissions?: string[]
}

/** The permissions a custom role may carry: the organization tier of the catalog. */
export const ASSIGNABLE_ROLE_PERMISSIONS: readonly string[] = ORG_PERMISSION_SPECS.filter(
  (spec) => spec.tier === 'org'
).map((spec) => spec.slug)

const ROLE_LIST_TTL_MS = 60_000
const roleListKey = (organizationId: string): string => `authz:org-roles:${organizationId}`
/** The key `org-role-permissions` caches each organization's role → permissions map under. */
const permissionMapKey = (organizationId: string): string => `authz:org-role-permissions:${organizationId}`

interface WorkOSRole {
  slug: string
  name: string
  description: string | null
  permissions: string[]
  type: string
}

async function listRolesFromWorkOS(organizationId: string): Promise<WorkOSRole[]> {
  return getCached(roleListKey(organizationId), ROLE_LIST_TTL_MS, async () => {
    const roles = await getWorkOS().authorization.listOrganizationRoles(organizationId)
    return roles.data.map((role) => ({
      slug: role.slug,
      name: role.name,
      description: role.description ?? null,
      permissions: [...role.permissions],
      type: role.type,
    }))
  })
}

/** Whether WorkOS reports the role as built inside the organization rather than environment-wide. */
function isCustom(role: Pick<WorkOSRole, 'type'>): boolean {
  return role.type === 'OrganizationRole'
}

/** Every role in the organization, in WorkOS's priority order. Members see names; managers see permissions too. */
export async function listOrganizationRoles(session: AuthorizedSession): Promise<OrganizationRoleView[]> {
  const manager = hasPermission(session, ORG_PERMISSIONS.membersManage)
  const roles = await listRolesFromWorkOS(session.organizationId)
  return roles.map((role) => ({
    slug: role.slug,
    name: role.name,
    description: role.description,
    custom: isCustom(role),
    ...(manager ? { permissions: role.permissions } : {}),
  }))
}

/** The role slugs that exist in the organization, for validating what a folder may name. */
export async function organizationRoleSlugs(organizationId: string): Promise<Set<string>> {
  return new Set((await listRolesFromWorkOS(organizationId)).map((role) => role.slug))
}

/** One permission a custom role may carry, and whether this editor may put it into one. */
export interface AssignablePermissionView {
  slug: string
  /** False for a permission the editor does not hold: composing a role is granting. */
  grantable: boolean
}

/**
 * What the role editor offers, for a reader who may manage roles; null for
 * anyone else. `grantable` is the same rule {@link assertGrantable} enforces, so
 * the editor disables exactly the boxes a save would refuse.
 */
export function assignableRolePermissions(session: AuthorizedSession): AssignablePermissionView[] | null {
  if (!hasPermission(session, ORG_PERMISSIONS.membersManage)) return null
  return ASSIGNABLE_ROLE_PERMISSIONS.map((slug) => ({
    slug,
    grantable: hasPermission(session, slug as KnownPermission),
  }))
}

function requireRoleManager(session: AuthorizedSession): void {
  if (!hasPermission(session, ORG_PERMISSIONS.membersManage)) throw new ForbiddenError()
}

/**
 * Refuse a permission the catalog does not offer to organizations, and one the
 * editor does not hold: composing a role is granting, and nobody grants what
 * they were not given.
 */
function assertGrantable(session: AuthorizedSession, permissions: readonly string[]): void {
  const unknown = permissions.filter((permission) => !ASSIGNABLE_ROLE_PERMISSIONS.includes(permission))
  if (unknown.length > 0) throw new BadRequestError(`Not an organization permission: ${unknown.join(', ')}`)
  const beyond = permissions.filter((permission) => !hasPermission(session, permission as KnownPermission))
  if (beyond.length > 0) {
    throw new ForbiddenError(`You can only put permissions you hold into a role: ${beyond.join(', ')}`)
  }
}

const UMLAUTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/ß/g, 'ss'],
]

/**
 * The slug a role's name becomes: `Geschäftsführung` → `org-geschaeftsfuehrung`.
 * WorkOS requires the `org-` prefix on an explicit slug and keeps slugs
 * immutable, so this is decided once, at creation, from the name.
 */
export function customRoleSlug(name: string): string {
  let folded = name.normalize('NFKC').toLocaleLowerCase('de')
  for (const [pattern, replacement] of UMLAUTS) folded = folded.replace(pattern, replacement)
  const body = folded
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  if (!body) throw new BadRequestError('A role name needs at least one letter or digit')
  return `org-${body}`
}

async function forgetRoles(organizationId: string): Promise<void> {
  await Promise.all([invalidateCached(roleListKey(organizationId)), invalidateCached(permissionMapKey(organizationId))])
}

export interface CustomRoleInput {
  name: string
  description: string | null
  permissions: string[]
}

/** Create a custom role in WorkOS for the session's organization. */
export async function createCustomRole(
  session: AuthorizedSession,
  input: CustomRoleInput,
  request: Request
): Promise<OrganizationRoleView> {
  requireRoleManager(session)
  assertGrantable(session, input.permissions)
  const slug = customRoleSlug(input.name)
  const existing = await organizationRoleSlugs(session.organizationId)
  if (existing.has(slug)) throw new ConflictError('A role with this name already exists', { slug })

  const workos = getWorkOS()
  await workos.authorization.createOrganizationRole(session.organizationId, {
    slug,
    name: input.name.trim(),
    ...(input.description ? { description: input.description } : {}),
  })
  await workos.authorization.setOrganizationRolePermissions(session.organizationId, slug, {
    permissions: input.permissions,
  })
  await forgetRoles(session.organizationId)
  await auditRole(session, 'org.role.created', slug, input.permissions, request)
  return { slug, name: input.name.trim(), description: input.description, custom: true, permissions: input.permissions }
}

/** The custom role, or a 404 for a slug that is not this organization's own. */
async function requireCustomRole(organizationId: string, slug: string): Promise<WorkOSRole> {
  const role = (await listRolesFromWorkOS(organizationId)).find((candidate) => candidate.slug === slug)
  if (!role) throw new NotFoundError('Role not found')
  if (!isCustom(role)) throw new ForbiddenError('The platform’s roles are changed by the platform, not here')
  return role
}

/**
 * Rename a custom role or change its permissions. Removing a permission the
 * editor does not hold is allowed — that takes, it does not grant; adding one
 * is not.
 */
export async function updateCustomRole(
  session: AuthorizedSession,
  slug: string,
  input: Partial<CustomRoleInput>,
  request: Request
): Promise<OrganizationRoleView> {
  requireRoleManager(session)
  const role = await requireCustomRole(session.organizationId, slug)
  const workos = getWorkOS()
  if (input.name !== undefined || input.description !== undefined) {
    await workos.authorization.updateOrganizationRole(session.organizationId, slug, {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
  }
  let permissions = role.permissions
  if (input.permissions !== undefined) {
    const added = input.permissions.filter((permission) => !role.permissions.includes(permission))
    assertGrantable(session, added)
    permissions = input.permissions
    await workos.authorization.setOrganizationRolePermissions(session.organizationId, slug, { permissions })
  }
  await forgetRoles(session.organizationId)
  await auditRole(session, 'org.role.updated', slug, permissions, request)
  return {
    slug,
    name: input.name?.trim() ?? role.name,
    description: input.description !== undefined ? input.description : role.description,
    custom: true,
    permissions,
  }
}

/** `details.reason` of the refusal to delete a role that somebody still holds. */
export const ROLE_ASSIGNED_REASON = 'role-assigned'
/** `details.reason` of the refusal to delete a role that folders name, until the deletion is confirmed. */
export const ROLE_USED_BY_FOLDERS_REASON = 'role-used-by-folders'

/** What deleting a custom role would leave behind: the folders whose own list names it. */
export interface CustomRoleUsage {
  /** How many folders name the role, counting those a restore can bring back (Papierkorb, project pending deletion). */
  total: number
  /**
   * Which, with their projects (the first fifty, by project and folder name). Only
   * for someone who administers projects and so may read those folders: a role
   * manager who may not is told how many, not which, because a restricted
   * folder's name is not theirs to read.
   */
  folders: FolderNamingRole[]
}

/**
 * The folders that name a custom role: what the deletion confirmation lists
 * (ADR-0088). A role manager reads the count; naming the folders needs
 * `org:projects:administer`.
 */
export async function getCustomRoleUsage(session: AuthorizedSession, slug: string): Promise<CustomRoleUsage> {
  requireRoleManager(session)
  await requireCustomRole(session.organizationId, slug)
  const { folders, total } = await listFoldersNamingRole(session.organizationId, slug)
  return { total, folders: hasPermission(session, ORG_PERMISSIONS.projectsAdminister) ? folders : [] }
}

export interface DeleteCustomRoleOptions {
  /** The caller was shown the folders that name the role and still wants it gone. */
  confirmFolders?: boolean
}

/**
 * Delete a custom role. Two things refuse it.
 *
 * Folders that name it (ADR-0088): after the deletion their grants match
 * nobody, and a folder whose own list names no role that exists is readable by
 * organization admins only. That is not done out from under an office without
 * the caller having seen which folders, so the request must say it did
 * (`confirmFolders`); the service answers 409 `role-used-by-folders` with the
 * count until it does.
 *
 * Holders (`role-assigned`): WorkOS refuses while anybody holds it (or a
 * directory group maps to it), which is answered as 409: deleting a role out
 * from under people would silently change what they may do.
 */
export async function deleteCustomRole(
  session: AuthorizedSession,
  slug: string,
  request: Request,
  options: DeleteCustomRoleOptions = {}
): Promise<void> {
  requireRoleManager(session)
  await requireCustomRole(session.organizationId, slug)
  const { total } = await listFoldersNamingRole(session.organizationId, slug)
  if (total > 0 && !options.confirmFolders) {
    throw new ConflictError('Folders still name this role. Confirm to delete it anyway.', {
      slug,
      reason: ROLE_USED_BY_FOLDERS_REASON,
      total,
    })
  }
  try {
    await getWorkOS().authorization.deleteOrganizationRole(session.organizationId, slug)
  } catch (error) {
    const status = (error as { status?: number } | null)?.status
    if (status === 400 || status === 409 || status === 422) {
      throw new ConflictError('This role is still assigned. Give its holders another role first.', {
        slug,
        reason: ROLE_ASSIGNED_REASON,
      })
    }
    throw error
  }
  await forgetRoles(session.organizationId)
  await auditRole(session, 'org.role.deleted', slug, [], request, { folders: total })
}

async function auditRole(
  session: AuthorizedSession,
  action: 'org.role.created' | 'org.role.updated' | 'org.role.deleted',
  slug: string,
  permissions: readonly string[],
  request: Request,
  extra: Record<string, number> = {}
): Promise<void> {
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action,
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: { role: slug, permissions: permissions.join(',').slice(0, 500), ...extra },
    request,
  })
}
