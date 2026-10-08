/**
 * The rows „Ausmisten" reads and undoes beyond what the folder and document
 * services already offer (ADR-0088). Tenant-scoped, bounded by their input.
 */

import 'server-only'
import { and, eq, isNull, notExists } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, projectFolders } from '@/lib/db/schema'

/**
 * Remove a folder the clean-out created, when it is living and empty: no
 * document filed in it and no folder below it. The undo of a clean-out that
 * failed halfway; never a delete a person asked for (that is the Papierkorb).
 * True when the row went.
 */
export async function deleteEmptyCreatedFolder(organizationId: string, projectId: string, folderId: string): Promise<boolean> {
  const db = getDb()
  const child = alias(projectFolders, 'child')
  const rows = await withTenant({ organizationId }, () =>
    db
      .delete(projectFolders)
      .where(
        and(
          eq(projectFolders.id, folderId),
          eq(projectFolders.organizationId, organizationId),
          eq(projectFolders.projectId, projectId),
          isNull(projectFolders.deletedAt),
          notExists(db.select({ id: documents.id }).from(documents).where(eq(documents.folderId, folderId))),
          notExists(db.select({ id: child.id }).from(child).where(eq(child.parentId, folderId)))
        )
      )
      .returning({ id: projectFolders.id })
  )
  return rows.length > 0
}
