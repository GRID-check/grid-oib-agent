/**
 * The only module that queries `document_roles`.
 *
 * No authorization here and no vocabulary checks — both live in `service.ts`,
 * which is the layer that knows who is asking. Every query is scoped by project
 * in its WHERE clause; row-level security is the boundary underneath, not the
 * plan (ADR-0041).
 */

import { and, eq, inArray, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documentRoles, documents } from '@/lib/db/schema'
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

/** Every binding in a project, joined to the document it names. */
export async function listProjectDocumentRoles(projectId: string): Promise<DocumentRoleBinding[]> {
  const db = getDb()
  const rows = await db
    .select(SELECTION)
    .from(documentRoles)
    .innerJoin(documents, eq(documents.id, documentRoles.documentId))
    // A soft-deleted document still has its rows (the FK cascade only fires on a
    // hard delete), so without this a binding outlives the file it names and the
    // checklist reports a slot as filled by something the user already removed.
    .where(and(eq(documentRoles.projectId, projectId), isNull(documents.deletedAt)))
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
          : eq(documentRoles.scopeInstanceId, scopeInstanceId),
        isNull(documents.deletedAt)
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

export async function deleteBindings(projectId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0
  const db = getDb()
  const removed = await db
    .delete(documentRoles)
    .where(and(eq(documentRoles.projectId, projectId), inArray(documentRoles.id, ids)))
    .returning({ id: documentRoles.id })
  return removed.length
}

/** Does this document belong to this project? The FK enforces it; this reports it. */
export async function documentBelongsToProject(
  documentId: string,
  projectId: string
): Promise<boolean> {
  const db = getDb()
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.projectId, projectId),
        isNull(documents.deletedAt)
      )
    )
    .limit(1)
  return row !== undefined
}
