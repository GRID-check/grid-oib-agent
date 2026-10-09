import 'server-only'

import type { AuthorizedSession } from '@/lib/auth/types'
import { can } from '@/lib/authz/decide'
import { canManageBudgets } from '@/lib/authz/organizations'
import type { ProjectPermission } from '@/lib/authz/projects'

/**
 * What this session may do on a project's Settings, one flag per affordance.
 *
 * Each flag is the permission the matching API enforces, and nothing else. The
 * page used to derive all of it from `role === 'project-admin'`: a role-name
 * check that denies a custom role holding every permission, and that showed
 * every viewer a member roster whose endpoint answers them 404.
 */
export interface ProjectSettingsAccess {
  /** Rename and delete: `project:manage`. */
  manage: boolean
  /** Read and change the roster, as `listProjectMembers` gates it. */
  manageMembers: boolean
  /** Open the intake wizard to change the profile: `project:edit` (`PUT /profile`). */
  editProfile: boolean
  /** Add, confirm, pin and remove memory items: `project:memory:write`. */
  writeMemory: boolean
  /** Rebuild the index: `project:documents:write` (`POST /reindex`). */
  writeDocuments: boolean
  /**
   * See the project's spend and set its limit. A project's admins may set it
   * (`saveBudgetPolicy`), and so may the organization's budget admins.
   */
  manageBudget: boolean
}

/**
 * The permission sets, as ANY-OF lists. The `project:edit` umbrella stays on
 * the narrow write permissions for the reason `requireProjectAccess` gives: a
 * custom role provisioned before the ADR-0038 split may hold only the umbrella.
 */
const CHECKS = {
  manage: ['project:manage'],
  manageMembers: ['project:members:manage', 'project:manage'],
  editProfile: ['project:edit'],
  writeMemory: ['project:memory:write', 'project:edit'],
  writeDocuments: ['project:documents:write', 'project:edit'],
} as const satisfies Record<string, readonly ProjectPermission[]>

type CheckKey = keyof typeof CHECKS

async function holdsAny(
  session: AuthorizedSession,
  projectId: string,
  permissions: readonly ProjectPermission[]
): Promise<boolean> {
  const resource = { type: 'project', id: projectId } as const
  const held = await Promise.all(permissions.map((permission) => can(session, permission, resource)))
  return held.some(Boolean)
}

/**
 * Resolve every flag concurrently. The caller has already proved
 * `project:view`; this only decides what the page offers, and every write is
 * checked again by its route.
 */
export async function resolveProjectSettingsAccess(
  session: AuthorizedSession,
  projectId: string
): Promise<ProjectSettingsAccess> {
  const keys = Object.keys(CHECKS) as CheckKey[]
  const results = await Promise.all(keys.map((key) => holdsAny(session, projectId, CHECKS[key])))
  const flags = Object.fromEntries(keys.map((key, index) => [key, results[index]])) as Record<
    CheckKey,
    boolean
  >
  return { ...flags, manageBudget: flags.manage || canManageBudgets(session) }
}
