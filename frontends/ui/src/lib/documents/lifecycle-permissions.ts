/**
 * Which lifecycle permissions a reader holds on one project.
 *
 * ## Why the browser is told, rather than guessing
 *
 * The review controls are shown per state AND per permission (ADR-0054 §2). The
 * state comes from the version row, but the permission is an FGA question, and
 * the browser cannot ask it: `lib/authz/decide` is `server-only` through its FGA
 * client. Without this, the pane's choices would be a role-name check or a
 * blanket "show everything and let the route refuse" — the first breaks every
 * custom role (ADR-0038), the second offers a person a button that answers 404.
 *
 * So the surface is handed the SET, resolved here from `decide`, and the client
 * filters the transition table with it. That is not authorization: the route
 * checks again, on every call, from the session. It is what the surface renders,
 * and it agrees with the route because both read the same table.
 *
 * Narrow on purpose: exactly the four permissions
 * `DOCUMENT_VERSION_TRANSITIONS` names, so a caller cannot use this as a general
 * "what may this person do" oracle and start rendering other features from it.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { can } from '@/lib/authz/decide'
import type { DocumentLifecyclePermission } from './lifecycle-types'

/**
 * The permissions the lifecycle asks about, in one place.
 *
 * Not derived from `DOCUMENT_VERSION_TRANSITIONS` by flattening `permission` +
 * `alsoRequires`: the archive gesture is item-level and appears in no row (see
 * `archiveDocument`), so a derived list would be missing the one permission the
 * Archivieren control needs. The type keeps the two honest — a permission the
 * table names that is absent here does not compile at the call site.
 */
const LIFECYCLE_PERMISSIONS: readonly DocumentLifecyclePermission[] = [
  'project:view',
  'project:edit',
  'project:documents:write',
  'project:documents:generate',
]

/**
 * Resolve the subset this session holds on this project.
 *
 * Four concurrent decisions rather than four awaits: they are independent, and
 * this runs on the Files page's critical path beside the listing.
 */
export async function resolveDocumentLifecyclePermissions(
  session: AuthorizedSession,
  projectId: string,
): Promise<DocumentLifecyclePermission[]> {
  const resource = { type: 'project', id: projectId } as const
  const held = await Promise.all(
    LIFECYCLE_PERMISSIONS.map(async (permission) => ({
      permission,
      allowed: await can(session, permission, resource),
    })),
  )
  return held.filter((row) => row.allowed).map((row) => row.permission)
}
