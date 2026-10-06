/**
 * The shelf a document or a folder lives on — the ONE definition of "which
 * rows are these" that the project's Dateien and the org-wide Archiv share
 * (ADR-0078).
 *
 * The two used to be answered by two sets of queries that agreed by copy: a
 * project's `projectListingWhere` and the Archiv repository's own
 * `scope = 'archiv'` clauses. Folders made that untenable — the Archiv would
 * have grown a second copy of every folder query — so the shelf is a value, and
 * each question about it (documents, folders, the row a new folder is inserted
 * as) is one function over it.
 *
 * A third shelf, `session`, exists on `documents.scope` and is deliberately not
 * a member: a chat attachment is never filed, and the database says so
 * (`documents_folder_id_organization_id_scope_fkey`).
 */

import { and, eq, isNull, type SQL } from 'drizzle-orm'
import { documents, projectFolders } from '@/lib/db/schema'

export type DocumentShelf = { kind: 'project'; projectId: string } | { kind: 'archiv' }

/** The Archiv's shelf as a type: what an Archiv-only operation (a folder's re-filing delete) takes. */
export type ArchivShelf = Extract<DocumentShelf, { kind: 'archiv' }>

/** The org-wide Archiv. A constant, because it has no identity beyond the tenant. */
export const ARCHIV_SHELF: ArchivShelf = { kind: 'archiv' }

export function projectShelf(projectId: string): DocumentShelf {
  return { kind: 'project', projectId }
}

/** The `scope` column value of the shelf's rows (`documents.scope`, `project_folders.scope`). */
export function shelfScope(shelf: DocumentShelf): 'project' | 'archiv' {
  return shelf.kind
}

/**
 * The shelf a stored row is on, or `null` for one that is on none a folder can
 * hang from (a `session` attachment).
 *
 * A project is named by `projectId`, as it always has been; the Archiv by its
 * scope. The two never overlap: a row with a project is a project document, and
 * `documents_session_requires_conversation` keeps a session row projectless.
 */
export function documentShelf(doc: {
  scope?: string
  projectId: string | null
}): DocumentShelf | null {
  if (doc.projectId) return projectShelf(doc.projectId)
  if (doc.scope === 'archiv') return ARCHIV_SHELF
  return null
}

/**
 * The `documents` rows of a shelf, in a tenant.
 *
 * The scope is stated for BOTH shelves. The project listing used to filter on
 * `project_id` alone and be correct by accident (the only other shelf had a NULL
 * project); a shelf is named by its scope and, for a project, narrowed by its
 * id — never inferred from a NULL.
 */
export function shelfDocumentWhere(shelf: DocumentShelf, organizationId: string): SQL {
  return and(
    eq(documents.organizationId, organizationId),
    eq(documents.scope, shelfScope(shelf)),
    ...(shelf.kind === 'project' ? [eq(documents.projectId, shelf.projectId)] : []),
  ) as SQL
}

/** The `project_folders` rows of a shelf, in a tenant. The folder twin of {@link shelfDocumentWhere}. */
export function shelfFolderWhere(shelf: DocumentShelf, organizationId: string): SQL {
  return and(
    eq(projectFolders.organizationId, organizationId),
    eq(projectFolders.scope, shelfScope(shelf)),
    // A deleted project folder, in the Papierkorb or a tombstone (migrations
    // 0109, 0112), is no folder of the shelf: only the access rule and the bin
    // read it, through their own repositories.
    isNull(projectFolders.deletedAt),
    ...(shelf.kind === 'project' ? [eq(projectFolders.projectId, shelf.projectId)] : []),
  ) as SQL
}

/** The owner columns a new row — a document or a folder — on this shelf is inserted with. */
export function shelfOwner(
  shelf: DocumentShelf,
  organizationId: string,
): { organizationId: string; scope: 'project' | 'archiv'; projectId: string | null } {
  return {
    organizationId,
    scope: shelfScope(shelf),
    projectId: shelf.kind === 'project' ? shelf.projectId : null,
  }
}
