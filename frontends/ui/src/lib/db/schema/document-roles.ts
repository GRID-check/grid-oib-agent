import { pgTable, uuid, text, timestamp, index, foreignKey, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { projects } from './projects'
import { documents } from './documents'

/**
 * Which document plays which role in a project (migration 0063).
 *
 * A join table rather than a column on `documents`, because a column cannot
 * carry any of the four things this binding needs:
 *
 *   1. One document can fill several roles — a combined Lageplan-and-
 *      Bebauungsplan PDF is one file and two roles.
 *   2. One role can be filled by several documents — a Bestandsplan set is a
 *      dozen sheets.
 *   3. The binding has its OWN provenance. Who declared it, when, and whether a
 *      person confirmed it or a classifier guessed it, are facts about the
 *      binding and not about the file.
 *   4. The binding is SCOPED. "Bestandsplan of Bauwerk bw2" is not a project
 *      fact, and a project with a Neubau and a Bestand in it — the case the
 *      intake concept exists for — needs to say which building.
 *
 * The vocabulary and its rules live in `lib/project-profile/document-roles`;
 * this file is storage only.
 */
export const documentRoles = pgTable(
  'document_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    /**
     * NOT NULL, unlike `documents.project_id`. A role is a statement about a
     * project's estate, so an Archiv or session document cannot hold one
     * without first being filed into a project. That is the correct rule rather
     * than a limitation: "the Bebauungsplan" is meaningless org-wide.
     */
    projectId: uuid('project_id').notNull(),
    documentId: uuid('document_id').notNull(),
    /** Closed vocabulary — `DOCUMENT_ROLES`. Validated at the service boundary. */
    role: text('role').notNull(),
    /**
     * The instance the role binds to: a bauwerk id for a `bauwerk` role, NULL
     * for a `projekt` one. `grundstueck` roles carry NULL until the data model
     * grows past one plot per project, which it is allowed to (`v1 darf mit
     * einem starten`) and which this column is already shaped for.
     */
    scopeInstanceId: text('scope_instance_id'),
    /** `declared` (a person said so) or `suggested` (a classifier proposed it). */
    confidence: text('confidence').notNull().default('declared'),
    /** `user` | `wizard` | `classifier`. Provenance, not confidence. */
    source: text('source').notNull().default('user'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectRoleIdx: index('document_roles_project_role_idx').on(table.projectId, table.role),
    documentIdx: index('document_roles_document_idx').on(table.documentId),
    /**
     * A role can only bind a document in its OWN project (composite, the same
     * pattern `documents_folder_id_project_id_fkey` uses).
     *
     * A plain `references(documents.id)` would let a row claim this project
     * while pointing at another project's file — and since `organization_id` is
     * denormalised here, at another TENANT's file. Both columns of the key are
     * NOT NULL, so MATCH SIMPLE never skips the check, which is the trap the
     * documents/folders comment documents at length.
     *
     * CASCADE: deleting a document takes its role bindings with it. A binding
     * whose document is gone is not a fact about anything.
     */
    documentProjectFk: foreignKey({
      name: 'document_roles_document_id_project_id_fkey',
      columns: [table.documentId, table.projectId],
      foreignColumns: [documents.id, documents.projectId],
    }).onDelete('cascade'),
    /**
     * The project reference carries the ORGANIZATION too.
     *
     * `organizationId` is denormalised onto this table and `grid_secure_table`
     * checks only that column, so a single-column project reference let a row
     * bear this tenant's organization while pointing at another tenant's
     * project — every constraint passed, and the row was then readable under
     * this tenant's own policy. Tenancy is structural (ADR-0041), not a
     * predicate the writer is trusted to get right.
     */
    projectOrgFk: foreignKey({
      name: 'document_roles_project_id_organization_id_fkey',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete('cascade'),
    /**
     * A `bauwerk` role names its building; a `projekt` role does not. The
     * vocabulary decides which is which, so the database cannot check the pair
     * — but it CAN check the shape: an empty string is not an instance id, and
     * storing one would make `scope_instance_id` sometimes-NULL and
     * sometimes-empty for the same meaning, which every consumer would then have
     * to normalise.
     */
    scopeInstanceNotBlank: check(
      'document_roles_scope_instance_not_blank',
      sql`${table.scopeInstanceId} IS NULL OR length(${table.scopeInstanceId}) > 0`
    ),
    confidenceKnown: check(
      'document_roles_confidence_known',
      sql`${table.confidence} IN ('declared', 'suggested')`
    ),
    sourceKnown: check(
      'document_roles_source_known',
      sql`${table.source} IN ('user', 'wizard', 'classifier')`
    ),
    /**
     * NOTE: the database also has `uniq_document_roles_binding`, a UNIQUE over
     * (project_id, document_id, role, scope_instance_id) declared `NULLS NOT
     * DISTINCT` so a project-scope binding (NULL instance) cannot be inserted
     * twice. Drizzle's index builder cannot express `NULLS NOT DISTINCT`, so it
     * lives only in migration 0063 — the same arrangement as
     * `documents_conversation_idx`, which is partial for the same reason.
     */
  })
)

export type DocumentRoleRow = typeof documentRoles.$inferSelect
export type NewDocumentRoleRow = typeof documentRoles.$inferInsert
