/**
 * Who may read and change a shelf — the ONE place the project's and the
 * Archiv's authorization are told apart (ADR-0078).
 *
 * Everything else about filing — folders, moving a document into one, uploading
 * into it — is the same on both shelves and takes a {@link DocumentShelf}; what
 * is not the same is the answer to "may this caller", and that is here:
 *
 *   - project: `project:view` reads; `project:documents:write` or `project:edit`
 *     changes (ADR-0038).
 *   - archiv: any member of the organization reads; `org:archiv:manage`
 *     (`canManageArchiv`) changes. Reading is open because the Archiv is shared
 *     knowledge, so only mutations gate.
 *
 * Deliberately not a role-name check: both are permissions, so a custom role
 * holding them works and a role that merely shares a name does not.
 */

import { ForbiddenError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canManageArchiv } from '@/lib/authz/organizations'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { DocumentShelf } from './shelf'

const PROJECT_WRITE_PERMISSIONS = ['project:documents:write', 'project:edit'] as const

export async function requireShelfRead(session: AuthorizedSession, shelf: DocumentShelf): Promise<void> {
  if (shelf.kind === 'archiv') return
  await requireProjectAccess(session, shelf.projectId, 'project:view')
}

export async function requireShelfWrite(session: AuthorizedSession, shelf: DocumentShelf): Promise<void> {
  if (shelf.kind === 'project') {
    await requireProjectAccess(session, shelf.projectId, PROJECT_WRITE_PERMISSIONS)
    return
  }
  if (!canManageArchiv(session)) throw new ForbiddenError()
}
