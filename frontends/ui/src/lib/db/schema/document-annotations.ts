import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  ANNOTATION_AUTHORS,
  ANNOTATION_KINDS,
  ANNOTATION_SHAPES,
  ANNOTATION_STATUSES,
  PILOTI_WAKE_STATUSES,
  PILOTI_WAKE_TRIGGERS,
  type AnnotationAuthor,
  type AnnotationKind,
  type AnnotationShape,
  type AnnotationStatus,
  type PilotiWakeStatus,
  type PilotiWakeTrigger,
} from '@/lib/annotations/types'
import { documentVersions } from './document-versions'
import { documents } from './documents'

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '))

/**
 * `document_annotations` — a mark set at a place on a page of a document, a
 * point or a region, by a person or proposed by Piloti (migration 0138;
 * CONTEXT.md „Anmerkung").
 *
 * Bound to the document and to the Fassung shown when it was set: a position
 * is true of the sheet somebody looked at. A document fact: every read is keyed
 * by a document its reader's rule already let through
 * (`documents/document-visibility.spec.ts`). The CHECKs carry the two rules no
 * code path may break: only Piloti proposes, and only a person takes a proposal
 * over.
 */
export const documentAnnotations = pgTable(
  'document_annotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    versionId: uuid('version_id'),
    number: integer('number').notNull(),
    page: integer('page').notNull(),
    shape: text('shape').$type<AnnotationShape>().notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    w: doublePrecision('w'),
    h: doublePrecision('h'),
    kind: text('kind').$type<AnnotationKind>().notNull(),
    body: text('body').notNull(),
    basis: text('basis'),
    authorKind: text('author_kind').$type<AnnotationAuthor>().notNull(),
    status: text('status').$type<AnnotationStatus>().notNull(),
    assigneeUserId: text('assignee_user_id'),
    dueOn: date('due_on', { mode: 'string' }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    acceptedBy: text('accepted_by'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    closedBy: text('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /**
     * Piloti is the delegate: it works the mark on this person's behalf
     * (migration 0139, ADR-0105). The mark keeps its human assignee. Set by the
     * person's own PATCH, cleared when Piloti replies (it hands the mark back)
     * or the mark closes.
     */
    delegatedBy: text('delegated_by'),
    delegatedAt: timestamp('delegated_at', { withTimezone: true }),
  },
  (table) => ({
    documentFk: foreignKey({
      name: 'document_annotations_document_fkey',
      columns: [table.documentId],
      foreignColumns: [documents.id],
    }).onDelete('cascade'),
    versionFk: foreignKey({
      name: 'document_annotations_version_fkey',
      columns: [table.versionId],
      foreignColumns: [documentVersions.id],
    }).onDelete('set null'),
    numberUniq: uniqueIndex('uniq_document_annotations_number').on(table.documentId, table.number),
    organizationIdx: index('idx_document_annotations_organization_id').on(table.organizationId),
    numberPositive: check('document_annotations_number_positive', sql`${table.number} >= 1`),
    pagePositive: check('document_annotations_page_positive', sql`${table.page} >= 1`),
    shapeKnown: check('document_annotations_shape_known', sql`${table.shape} IN (${list(ANNOTATION_SHAPES)})`),
    pointOnPage: check(
      'document_annotations_point_on_page',
      sql`${table.x} >= 0 AND ${table.x} <= 1 AND ${table.y} >= 0 AND ${table.y} <= 1`
    ),
    regionOnPage: check(
      'document_annotations_region_on_page',
      sql`(${table.shape} = 'point' AND ${table.w} IS NULL AND ${table.h} IS NULL) OR (${table.shape} = 'region' AND ${table.w} > 0 AND ${table.h} > 0 AND ${table.x} + ${table.w} <= 1.000001 AND ${table.y} + ${table.h} <= 1.000001)`
    ),
    kindKnown: check('document_annotations_kind_known', sql`${table.kind} IN (${list(ANNOTATION_KINDS)})`),
    authorKnown: check('document_annotations_author_known', sql`${table.authorKind} IN (${list(ANNOTATION_AUTHORS)})`),
    statusKnown: check('document_annotations_status_known', sql`${table.status} IN (${list(ANNOTATION_STATUSES)})`),
    onlyPilotiProposes: check(
      'document_annotations_only_piloti_proposes',
      sql`${table.status} <> 'proposed' OR ${table.authorKind} = 'piloti'`
    ),
    acceptanceComplete: check(
      'document_annotations_acceptance_complete',
      sql`(${table.acceptedBy} IS NULL) = (${table.acceptedAt} IS NULL)`
    ),
    pilotiNeedsAPerson: check(
      'document_annotations_piloti_needs_a_person',
      sql`${table.authorKind} = 'person' OR ${table.status} IN ('proposed', 'dismissed') OR ${table.acceptedBy} IS NOT NULL`
    ),
    closingComplete: check(
      'document_annotations_closing_complete',
      sql`(${table.status} IN ('resolved', 'dismissed')) = (${table.closedBy} IS NOT NULL) AND (${table.closedBy} IS NULL) = (${table.closedAt} IS NULL)`
    ),
    bodyLength: check('document_annotations_body_length', sql`char_length(btrim(${table.body})) BETWEEN 1 AND 2000`),
    basisLength: check(
      'document_annotations_basis_length',
      sql`${table.basis} IS NULL OR char_length(${table.basis}) BETWEEN 1 AND 300`
    ),
    delegationComplete: check(
      'document_annotations_delegation_complete',
      sql`(${table.delegatedBy} IS NULL) = (${table.delegatedAt} IS NULL)`
    ),
    delegatedWhileOpen: check(
      'document_annotations_delegated_while_open',
      sql`${table.delegatedBy} IS NULL OR ${table.status} = 'open'`
    ),
  })
)

export type DocumentAnnotationRow = typeof documentAnnotations.$inferSelect
export type NewDocumentAnnotationRow = typeof documentAnnotations.$inferInsert

/** `document_annotation_replies` — the thread under one Anmerkung, in order (migration 0138). */
export const documentAnnotationReplies = pgTable(
  'document_annotation_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    annotationId: uuid('annotation_id').notNull(),
    authorKind: text('author_kind').$type<AnnotationAuthor>().notNull(),
    body: text('body').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The reply addresses Piloti: the composer's mention chip, never a match on the text (migration 0139). */
    addressesAgent: boolean('addresses_agent').notNull().default(false),
  },
  (table) => ({
    annotationFk: foreignKey({
      name: 'document_annotation_replies_annotation_fkey',
      columns: [table.annotationId],
      foreignColumns: [documentAnnotations.id],
    }).onDelete('cascade'),
    annotationIdx: index('idx_document_annotation_replies_annotation').on(table.annotationId, table.createdAt),
    organizationIdx: index('idx_document_annotation_replies_organization_id').on(table.organizationId),
    authorKnown: check(
      'document_annotation_replies_author_known',
      sql`${table.authorKind} IN (${list(ANNOTATION_AUTHORS)})`
    ),
    bodyLength: check(
      'document_annotation_replies_body_length',
      sql`char_length(btrim(${table.body})) BETWEEN 1 AND 2000`
    ),
  })
)

export type DocumentAnnotationReplyRow = typeof documentAnnotationReplies.$inferSelect

/**
 * `piloti_wakes` — one row per event on an Anmerkung that met a wake rule
 * (migration 0139, ADR-0106). Its id is the `bff_job_queue` job id and the
 * turn id, uuid5 of the event (`lib/annotations/wake-ids.ts`), so one event
 * wakes Piloti at most once. The queue forgets a finished job; this row keeps
 * what the wake came to, and the caps count it.
 */
export const pilotiWakes = pgTable(
  'piloti_wakes',
  {
    id: uuid('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    annotationId: uuid('annotation_id').notNull(),
    triggerKind: text('trigger_kind').$type<PilotiWakeTrigger>().notNull(),
    /** The reply id, or the delegation's event id. */
    eventId: text('event_id').notNull(),
    /** The person whose act is the event: the turn runs as them. */
    actorUserId: text('actor_user_id').notNull(),
    status: text('status').$type<PilotiWakeStatus>().notNull().default('queued'),
    /** Why it started no turn; set exactly when the status says so. */
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** When it reached its final word: the turn's end, or the settle of one that never started (0141). */
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => ({
    annotationFk: foreignKey({
      name: 'piloti_wakes_annotation_fkey',
      columns: [table.annotationId],
      foreignColumns: [documentAnnotations.id],
    }).onDelete('cascade'),
    annotationIdx: index('idx_piloti_wakes_annotation_created').on(table.annotationId, table.createdAt),
    /** A document's wakes, the newest of each mark first (0148): `listLatestWakes`, `listAnsweringWakes`. */
    documentIdx: index('idx_piloti_wakes_document_annotation_created').on(
      table.documentId,
      table.annotationId,
      table.createdAt.desc()
    ),
    actorIdx: index('idx_piloti_wakes_actor_created').on(table.organizationId, table.actorUserId, table.createdAt),
    triggerKnown: check('piloti_wakes_trigger_known', sql`${table.triggerKind} IN (${list(PILOTI_WAKE_TRIGGERS)})`),
    statusKnown: check('piloti_wakes_status_known', sql`${table.status} IN (${list(PILOTI_WAKE_STATUSES)})`),
    reasonWhenNotStarted: check(
      'piloti_wakes_reason_when_not_started',
      sql`(${table.status} IN ('suppressed', 'refused', 'failed')) = (${table.reason} IS NOT NULL)`
    ),
    reasonLength: check(
      'piloti_wakes_reason_length',
      sql`${table.reason} IS NULL OR char_length(${table.reason}) BETWEEN 1 AND 500`
    ),
    settledWhenNotQueued: check(
      'piloti_wakes_settled_when_not_queued',
      sql`(${table.status} = 'queued') = (${table.settledAt} IS NULL)`
    ),
    endedWhenFinal: check(
      'piloti_wakes_ended_when_final',
      sql`(${table.status} IN ('queued', 'started')) = (${table.endedAt} IS NULL)`
    ),
  })
)

export type PilotiWakeRow = typeof pilotiWakes.$inferSelect
