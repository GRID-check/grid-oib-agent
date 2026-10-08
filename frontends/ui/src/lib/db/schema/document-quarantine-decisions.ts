import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { DocumentScope } from './documents'

/**
 * `document_quarantine_decisions` — the content gate's quarantine decisions,
 * kept until the audit trail has them (migration 0118, ADR-0085; AI Act).
 *
 * One row per ingest job that quarantined a document, inserted in the same
 * transaction as the status write that records the decision
 * (`setDocumentReconciledStatus`), so a decision cannot exist without its
 * row. `lib/upload-screening/quarantine-audit.ts` sends each to the trail as
 * `document.quarantined` and sets `auditedAt`; the upload sweep sends whatever
 * is still unaudited. The WorkOS idempotency key is the row's id and the event
 * is built from the row alone, so a repeated emit is the same event.
 *
 * Keyed on the dispatch: UNIQUE (`documentId`, `jobId`). No foreign keys: a
 * reviewer may delete the document before the decision reaches the trail, so
 * the row carries what the event says. Only `auditedAt` changes, once; only
 * the platform role deletes (a trigger in the migration).
 */
export const documentQuarantineDecisions = pgTable(
  'document_quarantine_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    /** The ingest job whose gate decided; NULL only when the row carried none. */
    jobId: text('job_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    scope: text('scope').$type<DocumentScope>().notNull(),
    projectId: uuid('project_id'),
    /**
     * The folder the document was filed in when it was quarantined, or NULL at
     * a shelf's root. What the trail asks before it names the file (ADR-0086).
     */
    folderId: uuid('folder_id'),
    /** The document's name when it was quarantined. */
    filename: text('filename').notNull(),
    /** Kinds and terms (`term:Lohnzettel,iban`), as the trail records them. */
    reasons: text('reasons').notNull().default(''),
    /** `full` or `partial`, or empty when the verdict did not say. */
    checked: text('checked').notNull().default(''),
    uploadedBy: text('uploaded_by').notNull(),
    /** When the trail took it; NULL while it is owed. */
    auditedAt: timestamp('audited_at', { withTimezone: true }),
  },
  (table) => ({
    dispatchKey: unique('document_quarantine_decisions_dispatch_key').on(
      table.documentId,
      table.jobId
    ),
    scopeCheck: check(
      'document_quarantine_decisions_scope_check',
      sql`${table.scope} IN ('project', 'archiv', 'session')`
    ),
    scopeProject: check(
      'document_quarantine_decisions_scope_project',
      sql`(${table.scope} = 'project') = (${table.projectId} IS NOT NULL)`
    ),
    filenameLength: check(
      'document_quarantine_decisions_filename_length',
      sql`char_length(${table.filename}) BETWEEN 1 AND 500`
    ),
    // The sweep's discovery: what is still owed to the trail.
    due: index('document_quarantine_decisions_due_idx')
      .on(table.decidedAt)
      .where(sql`${table.auditedAt} IS NULL`),
  })
)

export type DocumentQuarantineDecision = typeof documentQuarantineDecisions.$inferSelect
