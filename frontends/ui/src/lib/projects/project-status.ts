/**
 * A project's lifecycle (ADR-0089): active, or closed. The pure rule, with no
 * I/O, so the authorization seam, the agent's service-token paths and the UI
 * read one answer.
 *
 * A closed project is read-only for its files, folders, versions, its profile
 * and its project memory. Chat about it stays. What a permission still allows
 * in a closed project is {@link CLOSED_PROJECT_KEEPS}; everything else is
 * refused with {@link projectClosedError}, before the organization-admin bypass,
 * so an admin is refused too.
 *
 * Every member of the organization may read a closed project and chat about
 * it, whether or not they were a member of it ({@link CLOSED_PROJECT_OPEN_TO_ORGANIZATION}).
 * Someone who reads it only for that reason clears no folder with its own role
 * list: their folder clearance is that of a member holding no role
 * (`clearanceOf` in `lib/authz/folder-access.ts`), so closing never opens a
 * restricted folder.
 */

import { ForbiddenError } from '@/lib/api/errors'
import type { ProjectPermission } from '@/lib/authz/permissions'

export const PROJECT_STATUSES = ['active', 'closed'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

/** The machine-readable reason a write into a closed project is refused. */
export const PROJECT_CLOSED_REASON = 'project-closed'

/**
 * What a closed project still allows whoever holds it. Reading, chatting, and
 * managing who is a member (offboarding someone stays possible). Deep research
 * and tasks (`project:documents:generate`, `project:skills:manage`) are refused:
 * both file into the project or run on a schedule as if it were live.
 * `project:manage` is refused too, because it also changes folder access, the
 * name and the Papierkorb; reopening asks it with `evenWhenClosed`.
 */
export const CLOSED_PROJECT_KEEPS: ReadonlySet<ProjectPermission> = new Set<ProjectPermission>([
  'project:view',
  'project:chat',
  'project:members:manage',
])

/** What every member of the organization holds on a closed project, member of it or not. */
export const CLOSED_PROJECT_OPEN_TO_ORGANIZATION: ReadonlySet<ProjectPermission> = new Set<ProjectPermission>([
  'project:view',
  'project:chat',
])

export function isProjectClosed(project: { status?: ProjectStatus | string | null } | null | undefined): boolean {
  return project?.status === 'closed'
}

/** The permissions of `accepted` a closed project still allows. Empty: the request is a write. */
export function keptWhenClosed(accepted: readonly ProjectPermission[]): ProjectPermission[] {
  return accepted.filter((permission) => CLOSED_PROJECT_KEEPS.has(permission))
}

/** Whether every one of `accepted` is open to every member of the organization on a closed project. */
export function openToOrganizationWhenClosed(accepted: readonly ProjectPermission[]): boolean {
  return accepted.length > 0 && accepted.every((permission) => CLOSED_PROJECT_OPEN_TO_ORGANIZATION.has(permission))
}

/** The refusal of a write into a closed project. Says so: everyone in the organization may see the project exists. */
export function projectClosedError(): ForbiddenError {
  return new ForbiddenError('This project is closed and can only be read. Reopen it to change it.', {
    reason: PROJECT_CLOSED_REASON,
  })
}

/** Whether `error` is the refusal of a write into a closed project. */
export function isProjectClosedError(error: unknown): boolean {
  if (!(error instanceof ForbiddenError)) return false
  const details = error.details as { reason?: unknown } | undefined
  return details?.reason === PROJECT_CLOSED_REASON
}

/** Whether a response body is the refusal of a write into a closed project (`details.reason`). */
export function isProjectClosedBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const details = (body as { details?: unknown }).details
  return !!details && typeof details === 'object' && (details as { reason?: unknown }).reason === PROJECT_CLOSED_REASON
}

/** The SQLSTATE the database's backstop raises for an insert into a closed project (migration 0116). */
export const PROJECT_CLOSED_SQLSTATE = 'GPC01'
