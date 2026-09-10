/**
 * The document lifecycle as data: states, operations, the transition table, and
 * the wire schemas every client of the HTTP API validates against (ADR-0054,
 * ADR-0055).
 *
 * ## Why this module has no `server-only` and no drizzle
 *
 * It is the contract, and the contract has four readers that are not the
 * service: the route handlers, the browser, the typed client
 * (`./lifecycle-client`), and — through the JSON Schema written from these zod
 * schemas into `tests/fixtures/document-lifecycle.schema.json` — the Python
 * agent tier. Importing the schema module here would drag the database into the
 * transport layer, which `server-component-db-access.spec.ts` fails on, and it
 * would make the Python export impossible to build without a database.
 *
 * The dependency therefore points the other way, exactly as `document-authors.ts`
 * and `document-status.ts` do: this module is pure data, `db/schema/document-
 * versions.ts` imports the state tuple from it, and `@/lib/db/schema` re-exports
 * it so every existing caller is unchanged.
 *
 * ## Why the transitions are a frozen table and not a library
 *
 * The authority for "may this version go from here to there" is **Postgres** —
 * the CHECKs on `document_versions` plus the compare-and-swap
 * `UPDATE … WHERE state = $expected` in `./lifecycle`. A state-machine library
 * would hold the rule in one process's memory, which is the one place it cannot
 * be true: two reviewers pressing Freigeben at the same moment, a retried
 * request, a half-applied deploy. What the table adds is everything a CHECK
 * cannot say — who may act, what the request must carry, and what else has to
 * happen — and it says it as DATA, so a new state is one row here, one CHECK
 * edit and one i18n key rather than a new branch in a service.
 *
 * The shape is `DOCUMENT_STATUS_FACTS`'s: `as const satisfies`, so the members
 * are literal types AND every row is checked against the interface.
 */

import { z } from 'zod'

/**
 * The editorial states of one version.
 *
 * ```
 * draft → in_review → approved → published → superseded
 *           ├→ changes_requested → (edit, file again) → draft
 *           └→ rejected
 * ```
 *
 * `approved` and `published` stay distinct because approving a Befund on
 * Tuesday and issuing it with the Einreichung on Friday are two acts by two
 * people with two different consequences — and because a later `scheduled`
 * state attaches to publish without touching approval.
 *
 * A tuple, so the set is enumerable at runtime (the CHECK in migration 0082 is
 * generated from it) and the type is derived rather than restated.
 */
export const DOCUMENT_VERSION_STATES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'published',
  'superseded',
  'rejected',
] as const
export type DocumentVersionState = (typeof DOCUMENT_VERSION_STATES)[number]

/**
 * The states in which a version is still being worked on — at most ONE per
 * document, enforced by a partial unique index in migration 0082.
 *
 * Derived here rather than restated in SQL and in the service: the index's
 * predicate is generated from this list, so widening it is one edit.
 */
export const OPEN_DOCUMENT_VERSION_STATES = [
  'draft',
  'in_review',
  'changes_requested',
] as const satisfies readonly DocumentVersionState[]

/** The operations a caller may ask for. One per row of the transition table. */
export const DOCUMENT_VERSION_OPS = [
  'upload',
  'create',
  'update',
  'submit',
  'approve',
  'request_changes',
  'reject',
  'publish',
] as const
export type DocumentVersionOp = (typeof DOCUMENT_VERSION_OPS)[number]

/**
 * The project permissions the lifecycle asks about. A narrow restatement of
 * `ProjectPermission` rather than an import of it, so this module stays free of
 * `@/lib/authz`, which is `server-only` through its FGA client.
 */
export type DocumentLifecyclePermission =
  | 'project:view'
  | 'project:edit'
  | 'project:documents:write'
  | 'project:documents:generate'

/**
 * The effects a transition runs, by name.
 *
 * A registry key rather than a function reference, because the table is DATA:
 * it is serialised to JSON Schema, read by a spec that asserts the internal
 * route reaches only `either` rows, and rendered in the docs. `./lifecycle`
 * holds the one `Record<DocumentVersionEffect, …>` that maps each name to an
 * async function, and `tsc` fails until every name here has one — so a new
 * consumer of the lifecycle is a registry entry, never an `if` inside a
 * transition.
 */
export const DOCUMENT_VERSION_EFFECTS = [
  /** WorkOS audit event. The action is the row's own; see `auditAction`. */
  'audit',
  /** Open an actionable `document.review_requested` item for each reviewer. */
  'openReviewInbox',
  /** Resolve the items the submit opened — the reviewer never tidies up. */
  'resolveReviewInbox',
  /** A live hint on the event hub. Never authoritative; the client re-reads. */
  'eventHint',
  /**
   * Dispatch the published bytes to `/v1/ingest` with provenance.
   *
   * A NO-OP in this slice, and deliberately present anyway. Slice 4 is the one
   * that may turn it on, and it may do so only together with the labelled-
   * citation work — the build spec's own condition on this seam. Naming the slot
   * now is what makes that a registry entry rather than a new call site inside
   * `publish`, which is where the no-ingest rule would quietly stop being true.
   */
  'ingestPublished',
] as const
export type DocumentVersionEffect = (typeof DOCUMENT_VERSION_EFFECTS)[number]

/** The audit actions the lifecycle emits. Registered in `lib/audit/schemas.mjs`. */
export type DocumentLifecycleAuditAction =
  | 'document.version.drafted'
  | 'document.version.submitted'
  | 'document.version.approved'
  | 'document.version.changes_requested'
  | 'document.version.rejected'
  | 'document.version.published'
  | 'document.archived'

export interface DocumentVersionTransition {
  /** The state the version must be in. `null` is "there is no version yet". */
  readonly from: DocumentVersionState | null
  readonly to: DocumentVersionState
  readonly op: DocumentVersionOp
  /**
   * `human` means a person in their own session, and it is the whole of the
   * publish door: the internal route the agent reaches serves `either` rows
   * only, so approve, request changes, reject and publish have no machine path
   * at all. `lifecycle.spec.ts` and the internal route's own spec both read this
   * field rather than a second list.
   */
  readonly actor: 'human' | 'either'
  /**
   * Any ONE of these is enough (`requireProjectAccess`'s any-of list). The
   * umbrella `project:edit` rides along wherever the narrow permission is a
   * post-ADR-0038 split, so a custom role provisioned before the split keeps
   * working.
   */
  readonly permission: readonly DocumentLifecyclePermission[]
  /**
   * Required IN ADDITION to {@link permission}, never instead of it. Machine
   * authorship is a conjunction (ADR-0047's third addendum): filing a generated
   * document is still a document write, and letting authorship REPLACE access
   * would rebuild the wider principal the design deleted.
   */
  readonly alsoRequires?: DocumentLifecyclePermission
  readonly requires: {
    /** The body must carry a non-empty `comment`. */
    readonly comment?: true
    /** The actor may not be the person who submitted this version. */
    readonly notSubmitter?: true
    /** The request must carry `ifMatch` equal to the stored `contentHash`. */
    readonly ifMatch?: true
  }
  readonly auditAction: DocumentLifecycleAuditAction
  /**
   * This transition also supersedes the document's previous published version
   * and moves `documents.published_version_id` here.
   *
   * A FLAG and not two more effect names, because unlike every effect it cannot
   * run after the state change: `uniq_document_versions_published_per_document`
   * makes "two published versions of one document" unrepresentable, so the
   * moment the new version becomes `published` the old one must already have
   * stopped being. The three statements are therefore one transaction in
   * `version-repository.promoteVersionToPublished`, and if the compare-and-swap
   * loses its race the supersede rolls back with it. An effect that ran
   * afterwards would have to leave the database in a state it refuses to hold.
   *
   * The previous version's BYTES STAY. A superseded version is history, and
   * history you cannot open is a list of dates; objects are purged when the
   * document is deleted (`deleteDocument` walks every version), never when a
   * version is replaced.
   */
  readonly promotes?: true
  readonly effects: readonly DocumentVersionEffect[]
}

/**
 * Every transition, in the order a document walks them.
 *
 * Read it as the table in `docs/roadmap/piloti-writes-artifacts-and-approval.md`
 * §2, because it IS that table: the design's Op / Actor / Guard / Effects
 * columns are these four fields, and a row that disagrees with the design is a
 * row somebody has to change in one place.
 */
export const DOCUMENT_VERSION_TRANSITIONS = [
  {
    /**
     * A person uploads a file — the FIRST version, or the next one under the
     * same name.
     *
     * This row is why `document_versions` is the version table for every
     * document rather than an agent-only structure. Re-uploading under a name
     * that already exists has replaced the document in place since migration
     * 0074, keeping the id so citations and subjects survive, and threw the old
     * bytes away. That was versioning without the history. The same gesture now
     * writes version N+1 and leaves N standing as `superseded`.
     *
     * `from: null` because the row being acted on is the NEW version; the
     * previous one is superseded by the same transaction (see `promotes`). Born
     * `published` and born approved: a person put the file there in their own
     * session, which is the assertion, and a review round nobody asked for is
     * not what „Datei hochladen" means. No inbox item for the same reason.
     */
    from: null,
    to: 'published',
    op: 'upload',
    actor: 'human',
    permission: ['project:documents:write', 'project:edit'],
    requires: {},
    auditAction: 'document.version.published',
    promotes: true,
    effects: ['audit', 'eventHint'],
  },
  {
    from: null,
    to: 'draft',
    op: 'create',
    actor: 'either',
    permission: ['project:documents:write', 'project:edit'],
    alsoRequires: 'project:documents:generate',
    requires: {},
    auditAction: 'document.version.drafted',
    effects: ['audit', 'eventHint'],
  },
  {
    from: 'draft',
    to: 'draft',
    op: 'update',
    actor: 'either',
    permission: ['project:documents:write', 'project:edit'],
    alsoRequires: 'project:documents:generate',
    requires: { ifMatch: true },
    auditAction: 'document.version.drafted',
    effects: ['audit', 'eventHint'],
  },
  {
    // A revision comes back as a draft rather than as a fourth state: the
    // reviewer's comment stays on the row, and „was ist noch offen" is answered
    // by reading it, not by a state that has to be cleared.
    from: 'changes_requested',
    to: 'draft',
    op: 'update',
    actor: 'either',
    permission: ['project:documents:write', 'project:edit'],
    alsoRequires: 'project:documents:generate',
    requires: { ifMatch: true },
    auditAction: 'document.version.drafted',
    effects: ['audit', 'eventHint'],
  },
  {
    from: 'draft',
    to: 'in_review',
    op: 'submit',
    actor: 'either',
    permission: ['project:edit', 'project:documents:write'],
    requires: {},
    auditAction: 'document.version.submitted',
    effects: ['openReviewInbox', 'audit', 'eventHint'],
  },
  {
    from: 'changes_requested',
    to: 'in_review',
    op: 'submit',
    actor: 'either',
    permission: ['project:edit', 'project:documents:write'],
    requires: {},
    auditAction: 'document.version.submitted',
    effects: ['openReviewInbox', 'audit', 'eventHint'],
  },
  {
    from: 'in_review',
    to: 'approved',
    op: 'approve',
    actor: 'human',
    permission: ['project:edit', 'project:documents:write'],
    // Not the submitter, because approval is the office asserting the content
    // and an assertion nobody but the author has read is not one.
    requires: { notSubmitter: true },
    auditAction: 'document.version.approved',
    effects: ['resolveReviewInbox', 'audit', 'eventHint'],
  },
  {
    from: 'in_review',
    to: 'changes_requested',
    op: 'request_changes',
    actor: 'human',
    permission: ['project:edit', 'project:documents:write'],
    requires: { comment: true },
    auditAction: 'document.version.changes_requested',
    effects: ['resolveReviewInbox', 'audit', 'eventHint'],
  },
  {
    from: 'in_review',
    to: 'rejected',
    op: 'reject',
    actor: 'human',
    permission: ['project:edit', 'project:documents:write'],
    requires: { comment: true },
    auditAction: 'document.version.rejected',
    effects: ['resolveReviewInbox', 'audit', 'eventHint'],
  },
  {
    from: 'approved',
    to: 'published',
    op: 'publish',
    actor: 'human',
    permission: ['project:documents:write', 'project:edit'],
    requires: {},
    auditAction: 'document.version.published',
    promotes: true,
    effects: ['ingestPublished', 'audit', 'eventHint'],
  },
] as const satisfies readonly DocumentVersionTransition[]

/** The transition for one (state, op) pair, or `null` when there is none. */
export function findDocumentVersionTransition(
  from: DocumentVersionState | null,
  op: DocumentVersionOp,
): DocumentVersionTransition | null {
  return DOCUMENT_VERSION_TRANSITIONS.find((row) => row.from === from && row.op === op) ?? null
}

/** Every transition for one op, whatever it starts from. */
export function transitionsForOp(op: DocumentVersionOp): readonly DocumentVersionTransition[] {
  return DOCUMENT_VERSION_TRANSITIONS.filter((row) => row.op === op)
}

/**
 * The ops a machine may ask for.
 *
 * DERIVED from the `actor` field, never listed a second time — the internal
 * route's op union and the spec that guards it both read this, so "the agent
 * cannot approve its own document" is one property of the table rather than an
 * agreement between three files.
 */
export const AGENT_REACHABLE_OPS: readonly DocumentVersionOp[] = DOCUMENT_VERSION_OPS.filter((op) => {
  const rows = transitionsForOp(op)
  return rows.length > 0 && rows.every((row) => row.actor === 'either')
})

/** Whether a document is listed by default, or has left the working set. */
export const DOCUMENT_LIFECYCLES = ['active', 'archived'] as const
export type DocumentLifecycle = (typeof DOCUMENT_LIFECYCLES)[number]

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------
//
// One zod object per request body, exported so the routes parse with them, the
// typed client validates responses with them, and the JSON Schema fixture is
// written from them. There is no second hand-written model anywhere — that is
// what ADR-0055 means by "one HTTP API with a typed client".

/** The reviewer's words. Bounded so a comment stays a comment. */
export const MAX_REVIEW_COMMENT_LENGTH = 4000

export const reviewCommentSchema = z.string().trim().min(1).max(MAX_REVIEW_COMMENT_LENGTH)

/** `POST /api/documents/[id]/versions` — fork a draft from the published version. */
export const forkDraftRequestSchema = z.object({}).strict()

/** `PUT /api/documents/[id]/versions/[versionId]/content` */
export const replaceContentRequestSchema = z
  .object({
    /**
     * The whole body, as text. Never a string replacement: editing happens in
     * the working directory (slice 1) and filing is a whole document, so the
     * API has no patch verb to get wrong.
     */
    content: z.string().max(2_000_000),
    /**
     * The `content_hash` the caller believes it is replacing. A mismatch is a
     * 409, not a last-write-wins overwrite — two turns of one conversation can
     * both hold a draft.
     */
    ifMatch: z.string().min(1),
  })
  .strict()

/** `POST …/[versionId]/submit` */
export const submitRequestSchema = z
  .object({
    /** Who is asked. Empty is legal: the item's assignees are asked instead. */
    reviewerUserIds: z.array(z.string().min(1)).max(20).default([]),
  })
  .strict()

/** `POST …/[versionId]/approve` */
export const approveRequestSchema = z.object({ comment: reviewCommentSchema.optional() }).strict()

/** `POST …/[versionId]/changes` and `…/reject` — both require words. */
export const refuseRequestSchema = z.object({ comment: reviewCommentSchema }).strict()

/** `POST /api/documents/[id]/archive` */
export const archiveRequestSchema = z.object({}).strict()

/**
 * `POST /api/internal/document-versions` — the ONE machine entry point.
 *
 * The op union is `AGENT_REACHABLE_OPS` restated as a zod enum because zod
 * cannot take a `readonly string[]` as an enum source; `lifecycle-types.spec.ts`
 * asserts the two agree, so the restatement cannot drift.
 */
export const internalDocumentVersionOpSchema = z.enum(['create', 'update', 'submit'])

export const internalDocumentVersionRequestSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('create'),
      projectId: z.string().uuid(),
      /** The idempotency key — `{conversationId}-{slug}`, minted by the caller. */
      ref: z.string().min(1).max(200),
      title: z.string().trim().min(1).max(200),
      content: z.string().max(2_000_000),
    })
    .strict(),
  z
    .object({
      op: z.literal('update'),
      documentId: z.string().uuid(),
      versionId: z.string().uuid(),
      content: z.string().max(2_000_000),
      ifMatch: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal('submit'),
      documentId: z.string().uuid(),
      versionId: z.string().uuid(),
      reviewerUserIds: z.array(z.string().min(1)).max(20).default([]),
    })
    .strict(),
])

export type InternalDocumentVersionRequest = z.infer<typeof internalDocumentVersionRequestSchema>

/** One version, as the browser and the agent receive it. */
export const documentVersionViewSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  versionNumber: z.number().int(),
  state: z.enum(DOCUMENT_VERSION_STATES),
  contentType: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  contentHash: z.string().nullable(),
  submittedBy: z.string().nullable(),
  submittedAt: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  publishedBy: z.string().nullable(),
  publishedAt: z.string().nullable(),
  reviewComment: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type DocumentVersionView = z.infer<typeof documentVersionViewSchema>

export const documentVersionListResponseSchema = z.object({
  documentId: z.string(),
  lifecycle: z.enum(DOCUMENT_LIFECYCLES),
  publishedVersionId: z.string().nullable(),
  versions: z.array(documentVersionViewSchema),
})

export type DocumentVersionListResponse = z.infer<typeof documentVersionListResponseSchema>

export const documentVersionResponseSchema = z.object({ version: documentVersionViewSchema })

export type DocumentVersionResponse = z.infer<typeof documentVersionResponseSchema>

/** `GET …/versions/diff?from=&to=` — both contents; the client renders. */
export const documentVersionDiffResponseSchema = z.object({
  from: z.object({ version: documentVersionViewSchema, content: z.string() }),
  to: z.object({ version: documentVersionViewSchema, content: z.string() }),
})

export type DocumentVersionDiffResponse = z.infer<typeof documentVersionDiffResponseSchema>

export const documentArchiveResponseSchema = z.object({
  documentId: z.string(),
  lifecycle: z.enum(DOCUMENT_LIFECYCLES),
})

export type DocumentArchiveResponse = z.infer<typeof documentArchiveResponseSchema>

/**
 * The schemas exported to JSON Schema for the Python tier, by name.
 *
 * A map rather than "every export that happens to be a zod object", so what
 * crosses the language boundary is a decision somebody took rather than a
 * consequence of a rename. `tests/fixtures/document-lifecycle.schema.json` is
 * generated from exactly this, and `lifecycle-schema.spec.ts` fails when the
 * file and the code disagree.
 */
export const DOCUMENT_LIFECYCLE_WIRE_SCHEMAS = {
  internalDocumentVersionRequest: internalDocumentVersionRequestSchema,
  replaceContentRequest: replaceContentRequestSchema,
  submitRequest: submitRequestSchema,
  documentVersionView: documentVersionViewSchema,
  documentVersionListResponse: documentVersionListResponseSchema,
  documentVersionResponse: documentVersionResponseSchema,
} as const
