/**
 * The only module that queries `document_roles`.
 *
 * No authorization here and no vocabulary checks — both live in `service.ts`,
 * which is the layer that knows who is asking. Every query is scoped by project
 * in its WHERE clause; row-level security is the boundary underneath, not the
 * plan (ADR-0041).
 */

import { and, eq, inArray, isNotNull, isNull, notInArray, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { outsideHiddenFolders } from '@/lib/documents/repository'
import { documentRoles, documents } from '@/lib/db/schema'
import type { DbTransaction } from '@/lib/storage/repository'
import type { DocumentRole, RoleConfidence, RoleSource } from '@/lib/project-profile/document-roles'

export interface DocumentRoleBinding {
  id: string
  projectId: string
  documentId: string
  role: DocumentRole
  scopeInstanceId: string | null
  confidence: RoleConfidence
  source: RoleSource
  createdBy: string
  createdAt: Date
  /** Resolved for display; the binding itself stores only the id. */
  filename: string
  displayName: string | null
}

interface RoleRowShape {
  id: string
  projectId: string
  documentId: string
  role: string
  scopeInstanceId: string | null
  confidence: string
  source: string
  createdBy: string
  createdAt: Date
  filename: string
  displayName: string | null
}

/**
 * A row's `role`, `confidence` and `source` are `text` in the database, so they
 * arrive as strings. They are narrowed here rather than validated: the CHECK
 * constraints cover confidence and source, and the service is the only writer
 * of `role`, so a value outside the vocabulary means the vocabulary shrank
 * under existing data — which the caller sees as an unknown role rather than a
 * crash.
 */
function toBinding(row: RoleRowShape): DocumentRoleBinding {
  return {
    id: row.id,
    projectId: row.projectId,
    documentId: row.documentId,
    role: row.role as DocumentRole,
    scopeInstanceId: row.scopeInstanceId,
    confidence: row.confidence as RoleConfidence,
    source: row.source as RoleSource,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    filename: row.filename,
    displayName: row.displayName,
  }
}

const SELECTION = {
  id: documentRoles.id,
  projectId: documentRoles.projectId,
  documentId: documentRoles.documentId,
  role: documentRoles.role,
  scopeInstanceId: documentRoles.scopeInstanceId,
  confidence: documentRoles.confidence,
  source: documentRoles.source,
  createdBy: documentRoles.createdBy,
  createdAt: documentRoles.createdAt,
  filename: documents.filename,
  displayName: documents.displayName,
} as const

/**
 * Who the list is for (ADR-0080). A binding names its document's filename, so a
 * binding to a document in a folder the reader may not see is left out as if
 * it did not exist. Required: there is no reader for whom "every folder" is the
 * safe default.
 *
 * - `hiddenFolderIds`: the folders hidden from this reader, from
 *   `getHiddenFolderIds` (a session) or `getRestrictedFolderIds` (nobody's
 *   clearance: the prompt view every member and every scheduled run shares).
 * - `unfiledOnly`: no tenant to read the folder tree in (an anonymous
 *   deployment), so no folder can be decided and none is shown.
 */
export type DocumentRoleReader = { hiddenFolderIds: readonly string[] } | { unfiledOnly: true }

function visibleTo(reader: DocumentRoleReader): SQL[] {
  if ('unfiledOnly' in reader) return [isNull(documents.folderId)]
  return outsideHiddenFolders(reader.hiddenFolderIds)
}

/** Every binding in a project the reader may see, joined to the document it names. */
export async function listProjectDocumentRoles(
  projectId: string,
  reader: DocumentRoleReader
): Promise<DocumentRoleBinding[]> {
  const db = getDb()
  const rows = await db
    .select(SELECTION)
    .from(documentRoles)
    // The join is the liveness check: a document delete is a hard DELETE and the
    // FK cascade takes the binding with it, so a row here always names a file
    // that exists. (Documents have no soft delete — 0077.)
    .innerJoin(documents, eq(documents.id, documentRoles.documentId))
    .where(and(eq(documentRoles.projectId, projectId), ...visibleTo(reader)))
    .orderBy(documentRoles.role, documentRoles.createdAt)
  return rows.map(toBinding)
}

/** Bindings already held for one role slot, used to enforce cardinality. */
export async function findBindingsForRole(
  projectId: string,
  role: DocumentRole,
  scopeInstanceId: string | null
): Promise<DocumentRoleBinding[]> {
  const db = getDb()
  const rows = await db
    .select(SELECTION)
    .from(documentRoles)
    .innerJoin(documents, eq(documents.id, documentRoles.documentId))
    .where(
      and(
        eq(documentRoles.projectId, projectId),
        eq(documentRoles.role, role),
        // `eq(col, null)` renders `= NULL`, which is never true. A project-scope
        // slot has to be matched with IS NULL, or it always reads as empty and
        // cardinality silently stops being enforced for exactly the roles that
        // have it — the single-holder ones.
        scopeInstanceId === null
          ? isNull(documentRoles.scopeInstanceId)
          : eq(documentRoles.scopeInstanceId, scopeInstanceId)
      )
    )
    .orderBy(documentRoles.createdAt)
  return rows.map(toBinding)
}

export interface InsertBindingInput {
  organizationId: string
  projectId: string
  documentId: string
  role: DocumentRole
  scopeInstanceId: string | null
  confidence: RoleConfidence
  source: RoleSource
  createdBy: string
}

export async function insertBinding(input: InsertBindingInput): Promise<string> {
  const db = getDb()
  const [inserted] = await db
    .insert(documentRoles)
    .values(input)
    .returning({ id: documentRoles.id })
  return inserted.id
}

/**
 * Replace a single-holder slot's bindings with one new binding, atomically.
 *
 * The delete and the insert were two unlocked statements. A failing insert left
 * the slot EMPTY — the user's existing Bebauungsplan deleted and nothing put
 * back — and two concurrent declarations could both pass the read and leave two
 * bindings in a slot the vocabulary says holds one. The unique index cannot
 * catch that: it keys on the document, so two DIFFERENT documents in the same
 * slot are distinct rows.
 *
 * One transaction fixes the first; `FOR UPDATE` on the slot's existing rows
 * serialises the second, so the loser observes the winner's state.
 *
 * `guard` runs first in the same transaction and may throw to refuse: it is
 * where a building binding locks the project and checks the building still
 * exists, so a profile save removing it cannot interleave with the insert.
 */
export async function replaceSlotBinding(
  input: InsertBindingInput,
  displacedIds: readonly string[],
  guard?: (tx: DbTransaction) => Promise<void>
): Promise<string> {
  const db = getDb()
  return db.transaction(async (tx) => {
    if (guard) await guard(tx)
    if (displacedIds.length > 0) {
      await tx
        .delete(documentRoles)
        .where(
          and(
            eq(documentRoles.projectId, input.projectId),
            inArray(documentRoles.id, [...displacedIds])
          )
        )
    }
    const [inserted] = await tx
      .insert(documentRoles)
      .values(input)
      .returning({ id: documentRoles.id })
    return inserted.id
  })
}

/**
 * Re-declare an existing binding as user-confirmed.
 *
 * A classifier's `suggested` binding that the user then confirms was returned
 * unchanged by the "already bound" no-op, so the prompt kept marking it
 * `[nicht bestätigt]` however many times the user confirmed it.
 */
export async function confirmBinding(
  projectId: string,
  bindingId: string,
  confidence: RoleConfidence,
  source: RoleSource
): Promise<void> {
  const db = getDb()
  await db
    .update(documentRoles)
    .set({ confidence, source, updatedAt: new Date() })
    .where(and(eq(documentRoles.projectId, projectId), eq(documentRoles.id, bindingId)))
}

export async function deleteBindings(projectId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0
  const db = getDb()
  const removed = await db
    .delete(documentRoles)
    .where(and(eq(documentRoles.projectId, projectId), inArray(documentRoles.id, ids)))
    .returning({ id: documentRoles.id })
  return removed.length
}

/**
 * Remove the building-scoped bindings of every building not in `keep`; how many.
 *
 * A non-null scope instance is always a Bauwerk id: no other scope takes one
 * (`roleRequiresScopeInstance`).
 */
export async function deleteBindingsOutsideBauwerke(
  projectId: string,
  keep: readonly string[],
  tx: DbTransaction
): Promise<number> {
  const outside =
    keep.length > 0
      ? and(isNotNull(documentRoles.scopeInstanceId), notInArray(documentRoles.scopeInstanceId, [...keep]))
      : isNotNull(documentRoles.scopeInstanceId)
  const removed = await tx
    .delete(documentRoles)
    .where(and(eq(documentRoles.projectId, projectId), outside))
    .returning({ id: documentRoles.id })
  return removed.length
}

/**
 * Does this document belong to this project, in a folder the reader may see?
 * The FK enforces the first; the second is ADR-0080, so a document in a hidden
 * folder answers like one that is not there.
 */
export async function documentBelongsToProject(
  documentId: string,
  projectId: string,
  reader: DocumentRoleReader
): Promise<boolean> {
  const db = getDb()
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.projectId, projectId),
        ...visibleTo(reader)
      )
    )
    .limit(1)
  return row !== undefined
}
