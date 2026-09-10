/**
 * The document lifecycle service: one transition function, one effects registry
 * (ADR-0054, ADR-0055).
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is the ONE place a `document_versions` row changes state. Every caller —
 * the ten HTTP routes, the human upload path, the agent's internal route — goes
 * through {@link transitionDocumentVersion} or through one of the three entry
 * points that create a version. There is no second path, which is what ADR-0055
 * means by "no service function is reached from a second path": the audit
 * event, the inbox item, the pointer move and the compare-and-swap are true of
 * every transition because there is only one that runs them.
 *
 * It is NOT a state-machine engine. The table lives in `./lifecycle-types` as
 * data, and the authority for "may this go from here to there" is Postgres: the
 * CHECKs on the table plus `UPDATE … WHERE state = $expected`. This module reads
 * the row of the table, checks the things a CHECK cannot see (who is asking,
 * what the body carries), and hands the swap to the database.
 *
 * ## It imports no producer
 *
 * `agent-document.ts` (the Markdown producer) imports THIS; this imports
 * nothing of it. That direction is what makes "a new producer is one map key
 * plus one caller plus one renderer" true — a producer is a call site of
 * {@link createDocumentVersion}, never a branch inside it. `lifecycle.spec.ts`
 * asserts the import direction.
 *
 * ## Effects are a registry, not a switch
 *
 * `EFFECT_REGISTRY` is a `Record<DocumentVersionEffect, …>`, so `tsc` fails
 * until every name in the tuple has a function, and a new consumer of the
 * lifecycle (a webhook, a task, the ingest of slice 4) is a registry entry plus
 * a name in a row's `effects` — never an `if` inside `publish`.
 */

import 'server-only'
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { recordAuditEvent } from '@/lib/audit/service'
import { publishToUsers } from '@/lib/events/bus'
import { emitInboxItems, resolveInboxItemsFor } from '@/lib/inbox/service'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { listAssignmentsForResources } from '@/lib/assignments/repository'
import { getBackendUrl } from '@/lib/backend-proxy'
import { resolvePeople } from '@/lib/sharing/directory'
import { bucketAdminS3Client, s3Client } from '@/lib/s3'
import { ensureTenantBucketChecked, resolveDocumentBucket } from '@/lib/storage/bucket'
import type { Document, DocumentVersion } from '@/lib/db/schema'
import { getAccessibleDocument } from './access'
import { isAgentDocumentFilename } from './agent-namespace'
import { collectionFileRef, purgeIngestedChunks } from './collection-file-ref'
import { contentDigest } from './content-digest'
import { documentDisplayName } from './display-name'
import { findDocumentInOrg, findFolderPathInProject } from './repository'
import type { AgentDocumentProvenance } from './service'
import {
  DOCUMENT_VERSION_TRANSITIONS,
  findDocumentVersionTransition,
  type DocumentVersionEffect,
  type DocumentVersionOp,
  type DocumentVersionState,
  type DocumentVersionTransition,
  type DocumentVersionView,
} from './lifecycle-types'
import {
  compareAndSwapVersionState,
  findDocumentVersion,
  findDocumentVersionInOrg,
  listDocumentVersionSummaries,
  findOpenVersion,
  findPublishedVersion,
  insertDocumentVersion,
  listDocumentVersions,
  nextVersionNumber,
  promoteVersionToPublished,
  setDocumentLifecycle,
  type DocumentVersionSummary,
} from './version-repository'

/**
 * Ceiling on the chunk purge the publish path runs.
 *
 * Its own constant rather than an import of `documents/service.ts`'s
 * `BACKEND_FETCH_TIMEOUT_MS`, which is module-private there, and the same ten
 * seconds for the same reason: an unreachable backend must not hold a BFF
 * request past Cloudflare's ~100s origin timeout. The purge is best-effort, so
 * exceeding it costs a superseded version's chunks lingering until the
 * platform's vector reconcile, never a failed publish.
 */
const BACKEND_PURGE_TIMEOUT_MS = 10_000

/** What a transition needs beyond the row it is acting on. */
export interface TransitionInput {
  /** Required by the rows whose `requires.comment` is set. */
  comment?: string | null
  /** Who is asked to review. Empty falls back to the document's assignees. */
  reviewerUserIds?: readonly string[]
  /** The `content_hash` the caller believes it is replacing. */
  ifMatch?: string | null
  /** Source request, for the audit event's IP + user agent context. */
  request?: Request
  /**
   * Whether the caller is a person in their own session.
   *
   * `false` is the agent's internal route, and it is the whole publish door: a
   * row whose `actor` is `human` is refused for a machine caller before any
   * permission is read. Defaults to `true` because every OTHER caller of this
   * function is a route holding a real session — a default of `false` would make
   * the ten human routes depend on remembering to pass it.
   */
  actingHuman?: boolean
  /**
   * „Piloti überarbeiten lassen" — the reviewer's third action on
   * `request_changes`.
   *
   * Without it, a version filed from a live conversation reaches that
   * conversation as a `REVIEW_DECISIONS v1` block and no task is opened; with
   * it, a `revision` task is opened as well, because the reviewer has said they
   * do not want to wait for somebody to type the next message. A version with no
   * origin conversation opens one either way — see the `openRevisionTask` effect.
   */
  delegateRevision?: boolean
}

/** The context every effect receives. Read-only; effects do not chain. */
interface EffectContext {
  session: AuthorizedSession
  document: Document
  version: DocumentVersion
  /** The version this one replaces, when there is one. */
  previous: DocumentVersion | null
  transition: DocumentVersionTransition
  input: TransitionInput
}

type EffectRunner = (context: EffectContext) => Promise<void>

/**
 * The inbox group key for one version's review round.
 *
 * `per-anchor` on the VERSION, so two review rounds on one document are two
 * rows rather than one counted row: each asks a different question about
 * different bytes, and collapsing them would hide the second.
 */
function reviewGroupKey(documentId: string, versionId: string): string {
  return inboxGroupKey('document.review_requested', 'document', documentId, versionId)
}

/**
 * Who is asked to review this version.
 *
 * The caller's list, or — when it is empty — whoever is already on the hook for
 * the file (`resource_assignments`, ADR-0047). That fallback is why submitting
 * without naming anybody is not a no-op: „Unvergeben" plus no named reviewer is
 * genuinely nobody, and the caller is told so rather than the submission
 * silently reaching no inbox.
 */
async function resolveReviewers(context: EffectContext): Promise<string[]> {
  const named = [...(context.input.reviewerUserIds ?? [])].filter(Boolean)
  if (named.length > 0) return [...new Set(named)]
  const assignments = await listAssignmentsForResources(
    context.session.organizationId,
    'document',
    [context.document.id],
  )
  return [...new Set(assignments.map((row) => row.subjectUserId))]
}

const EFFECT_REGISTRY: Record<DocumentVersionEffect, EffectRunner> = {
  /**
   * The audit event, with the row's own action.
   *
   * The NON-throwing variant, unlike `document.generated`. That action throws
   * because "a machine wrote this on a human's authority" has no domain table to
   * fall back on; here the version row IS that table — it records who submitted,
   * who approved and when, durably and inside the tenant boundary — so losing
   * the WorkOS line costs an export, not the fact. Failing an approval because
   * an audit API was slow would be the worse trade.
   */
  audit: async ({ session, document, version, transition, input }) => {
    await recordAuditEvent({
      organizationId: session.organizationId,
      actor: { userId: session.userId, email: session.email },
      action: transition.auditAction,
      targetType: 'document',
      targetId: document.id,
      metadata: {
        versionId: version.id,
        versionNumber: version.versionNumber,
        state: version.state,
        projectId: document.projectId ?? '',
        withComment: Boolean(input.comment?.trim()),
      },
      request: input.request,
    })
  },

  openReviewInbox: async (context) => {
    const reviewers = await resolveReviewers(context)
    if (reviewers.length === 0) {
      throw new UnprocessableError(
        'Nobody to review this version: name a reviewer or assign the document first',
      )
    }
    await emitInboxItems(
      reviewers.map((recipientUserId) => ({
        organizationId: context.session.organizationId,
        recipientUserId,
        type: 'document.review_requested' as const,
        resourceType: 'document' as const,
        resourceId: context.document.id,
        anchorId: context.version.id,
        actorUserId: context.session.userId,
        groupKey: reviewGroupKey(context.document.id, context.version.id),
        // `subject` is what the inbox ROW renders — the generic renderer reads
        // it out of the payload and interpolates it into „{actor} bittet Sie um
        // die Freigabe von {subject}". Without it the row named no file and the
        // reader had to open the link to find out which one was waiting.
        payload: {
          versionId: context.version.id,
          versionNumber: context.version.versionNumber,
          subject: documentDisplayName(context.document),
        },
      })),
    )
  },

  /**
   * Resolve the round the submit opened, for EVERY reviewer.
   *
   * Not only the one who acted: a decision has been taken, so the question is
   * settled for everybody who was asked. Leaving the others actionable would
   * park a row in three people's badges that nothing can ever resolve.
   */
  resolveReviewInbox: async (context) => {
    const reviewers = await resolveReviewers(context)
    const groupKey = reviewGroupKey(context.document.id, context.version.id)
    await resolveInboxItemsFor(
      // The actor too: they may well have been one of the people asked.
      [...new Set([...reviewers, context.session.userId])].map((recipientUserId) => ({
        organizationId: context.session.organizationId,
        recipientUserId,
        groupKey,
      })),
    )
  },

  /**
   * A hint on the event hub, never the new state.
   *
   * Published to the people who have a stake in this version — the actor, the
   * author, the submitter — because there is no document channel and inventing
   * one to carry a nudge would be a second subscription surface. Fail-open by
   * construction: `publishToUsers` swallows, and every receiver re-reads.
   */
  eventHint: async ({ session, document, version }) => {
    const audience = [session.userId, version.createdBy, version.submittedBy].filter(
      (userId): userId is string => Boolean(userId),
    )
    await publishToUsers([...new Set(audience)], {
      kind: 'document.version.changed',
      documentId: document.id,
      versionId: version.id,
      state: version.state,
    })
  },

  /**
   * Index the version that was just published, with the provenance that says
   * who wrote it and who cleared it (ADR-0054 § Indexing).
   *
   * The slot was named before it did anything, and that is why the door could
   * be opened without moving a call site: "only a published version is ever
   * dispatched" is a property of the transition table — this effect appears on
   * the `publish` row and nowhere else — rather than of somebody remembering
   * where to put the dispatch. Do not call `dispatchDocument` from anywhere
   * else in this module.
   *
   * ## Purge first, then dispatch
   *
   * The previous published version's chunks go BEFORE the new bytes are sent,
   * and the order is not tidiness. A version does not have a filename; the ITEM
   * does (`documents.filename` is written once and never renamed), so both
   * versions address the same chunks. Purging after the dispatch would delete
   * the passages that had just been written. Purging first also decides the
   * failure case correctly: when the backend is down, the superseded version's
   * chunks are already gone and the new ones never arrive, so the document
   * stops answering rather than answering out of the version somebody
   * replaced. `unregister_summary` on the backend takes the document-metadata
   * row with them, so the superseded version's provenance does not outlive its
   * chunks.
   *
   * ## What is NOT decided here
   *
   * The `doc_class` is untouched. Provenance is its own axis
   * (`docs/architecture/agent-document-provenance.md`): `doc_class` is a closed
   * norm-hierarchy vocabulary whose fail-open lane is "Basisdokument", and
   * filing authorship there would file a Piloti document under the hierarchy of
   * authority. The shelf is untouched for the same reason — the document really
   * does sit on the project or Archiv shelf, and `collectionName` already says
   * which.
   */
  ingestPublished: async ({ session, document, version, previous }) => {
    // Human-authored items are dispatched by whatever wrote their bytes — the
    // three upload shelves — and re-dispatching here would double-ingest every
    // re-upload. This effect exists for the door ADR-0054 opened.
    if (document.authoredBy === 'user') return

    // Both halves of `collectionFileRef`'s restated rule, asked before anything
    // is sent: a row outside the `piloti/` namespace would be indexed under a
    // name no purge can address, because every purge builds its ref from the
    // row and that constructor would answer `null`. Refusing to index it is the
    // safe direction and the only one that keeps "indexed" and "purgeable" the
    // same set. Reachable for a document filed before the namespace existed.
    if (!isAgentDocumentFilename(document.filename)) {
      console.warn(
        `[documents] published version ${version.id} is not under the piloti/ namespace; not indexed`,
      )
      return
    }

    // Cycle-broken on purpose: `documents/service.ts` imports this module for
    // `recordUploadedVersion` and `versionedStorageKey`, so a static import
    // back would be a load-order cycle. Same device, same reason, as
    // `sharing/service.ts` reaching the mentions service.
    const { dispatchDocument, AgentAuthoredDocumentNotIndexableError } = await import('./service')

    if (previous) {
      await purgeSupersededChunks(document)
    }

    try {
      await dispatchDocument({
        organizationId: session.organizationId,
        projectId: document.projectId,
        documentId: document.id,
        filename: document.filename,
        storageKey: version.storageKey,
        storageBucket: version.storageBucket,
        collectionName: document.collectionName,
        folderPath: await resolveFolderPath(document, session.organizationId),
        versionId: version.id,
        provenance: await agentProvenance(session.organizationId, document, version),
      })
    } catch (error) {
      // The one refusal this effect can provoke and must not turn into a failed
      // publish: the version row is durable and a person approved it, so the
      // editorial act stands whether or not the index accepted the bytes. Every
      // other outcome — a backend timeout, a non-2xx — is already absorbed by
      // `dispatchIngest`, which records `failed` on the row. Anything else is a
      // real fault and is re-raised rather than swallowed.
      if (!(error instanceof AgentAuthoredDocumentNotIndexableError)) throw error
      console.warn(`[documents] ingest refused the published version ${version.id}`)
    }
  },

  /**
   * Hand a sent-back version to Piloti as a `revision` task — when there is
   * nobody in a conversation to hand it to instead.
   *
   * ## Why this is a condition and not a second button
   *
   * „Request changes reaches the agent twice" is the design's own phrasing, and
   * the two are not alternatives to pick between: a version filed from a live
   * chat already has a reader and a thread, and the next turn there carries the
   * comment verbatim (`./review-decisions.ts`). Opening a task for that case as
   * well would queue a run for work the person is about to ask for in their next
   * sentence, spend their budget on it, and put a second draft beside the one
   * the conversation is holding. So the origin decides, and the reviewer can
   * override it — `delegateRevision` is the one thing that opens a task for a
   * conversation-born version.
   *
   * ## Why it cannot fail the transition
   *
   * The reviewer's decision is recorded the moment the compare-and-swap lands;
   * everything here is what happens NEXT. A queue that will not take the run, a
   * requester who has left the organization, a project whose skills feature is
   * off — none of those is a reason to tell a Ziviltechniker that their
   * „Änderungen anfordern" did not go through. The failure is logged and the
   * comment still stands on the row, which is where the Files pane reads it.
   */
  openRevisionTask: async ({ session, document, version, input }) => {
    const delegated = input.delegateRevision === true
    if (version.originConversationId && !delegated) return
    // A document with no project has no task table to hang off: the org-wide
    // Archiv and a conversation's private attachments are both project-less, and
    // `tasks.project_id` is NOT NULL for the tenant predicate's sake.
    if (!document.projectId) return

    try {
      // Cycle-broken like the ingest dispatch above: `lib/tasks/delegation`
      // imports the jobs service, which imports the tasks service, which imports
      // THIS module for the filing it does at completion.
      const { delegateTask } = await import('@/lib/tasks/delegation')
      // Read in the REVIEWER's session, which has just been checked against this
      // document — the run itself has no session and the worker holds no
      // envelope, so the bytes have to be fetched by whoever is standing here.
      const source = await readVersionContent(session, document.id, version.id).catch(() => null)
      await delegateTask(session, {
        projectId: document.projectId,
        kind: 'revision',
        goal: input.comment?.trim() ?? '',
        subject: {
          documentId: document.id,
          versionId: version.id,
          comment: input.comment?.trim() ?? '',
        },
        sourceText: source,
        // The permissions the RE-FILING has to carry are the ones the original
        // filing carried: whoever wrote this draft. The reviewer authorizes the
        // delegation — it is their decision — and does not lend their own
        // permissions to the work.
        requester: { userId: version.createdBy, email: null },
      })
    } catch (error) {
      console.error(
        `[documents] could not open a revision task for version ${version.id}`,
        error,
      )
    }
  },
}

/**
 * Forget the chunks the version being replaced left behind.
 *
 * Through `collectionFileRef` like every other `(collection, filename)` call:
 * `null` means "this row owns nothing over there", which is the honest answer
 * for a document nobody ever published. Best-effort, because the publish itself
 * is durable and the platform's vector reconcile is the sweep that catches a
 * backend that said no.
 */
async function purgeSupersededChunks(document: Document): Promise<void> {
  const ref = collectionFileRef(document)
  if (!ref) return
  await purgeIngestedChunks(getBackendUrl(), ref, BACKEND_PURGE_TIMEOUT_MS)
}

/**
 * The four keys a published Piloti document carries into every chunk.
 *
 * `approved_by` is the person's DISPLAY NAME and not their user id, because the
 * value is rendered into a German line the model and the reader both see
 * („freigegeben von Maria Huber am 01.09.2026"). Resolved through
 * `resolvePeople`, which is how every collaboration surface in this tier turns
 * an id into a name, so the grounding block and the share roster cannot
 * disagree about what somebody is called. An id the directory cannot resolve —
 * a deactivated member, a WorkOS hiccup — yields `null` rather than a raw id:
 * the label degrades to the bare „Piloti-Dokument" instead of printing a
 * `user_01…` at an architect.
 */
async function agentProvenance(
  organizationId: string,
  document: Document,
  version: DocumentVersion,
): Promise<AgentDocumentProvenance> {
  const approver = version.approvedBy
    ? (await resolvePeople(organizationId, [version.approvedBy])).get(version.approvedBy)
    : undefined
  return {
    authored_by: 'agent',
    approved_by: approver?.name ?? null,
    approved_at: version.approvedAt?.toISOString() ?? null,
    producer: document.authoredByProducer,
  }
}

/**
 * The materialised folder path the item is filed under, or `null`.
 *
 * Re-resolved rather than carried, for the reason the re-ingest path resolves
 * it: `folder_path` is what the backend files the document under (ADR-0049),
 * and a dispatch that omitted it would silently un-file a document somebody had
 * filed.
 */
async function resolveFolderPath(document: Document, organizationId: string): Promise<string | null> {
  if (!document.folderId || !document.projectId) return null
  return findFolderPathInProject(document.folderId, document.projectId, organizationId)
}

/** Every effect a transition names, in order. */
async function runEffects(context: EffectContext): Promise<void> {
  for (const effect of context.transition.effects) {
    await EFFECT_REGISTRY[effect](context)
  }
}

/**
 * The permission gate for one row.
 *
 * `alsoRequires` is a CONJUNCTION and never a substitution — ADR-0047's third
 * addendum, one level up: filing a generated document is still a document
 * write, so `project:documents:generate` is asked IN ADDITION to
 * `project:documents:write`, never instead of it.
 *
 * A document with no project (the org-wide Archiv, a chat attachment) has no
 * project to check against; `getAccessibleDocument` has already resolved that
 * shelf's own permission from the row, which is the honest gate for it.
 */
async function requireTransitionPermission(
  session: AuthorizedSession,
  document: Document,
  transition: DocumentVersionTransition,
): Promise<void> {
  if (!document.projectId) return
  await requireProjectAccess(session, document.projectId, transition.permission)
  if (transition.alsoRequires) {
    await requireProjectAccess(session, document.projectId, transition.alsoRequires)
  }
}

/** The guards a CHECK cannot see: who is asking, and what the body carries. */
function assertGuards(
  session: AuthorizedSession,
  version: DocumentVersion,
  transition: DocumentVersionTransition,
  input: TransitionInput,
): void {
  if (transition.actor === 'human' && input.actingHuman === false) {
    throw new ForbiddenError(`${transition.op} is a person's decision`, { op: transition.op })
  }
  if (transition.requires.comment && !input.comment?.trim()) {
    throw new UnprocessableError('This decision needs a comment', { op: transition.op })
  }
  if (transition.requires.notSubmitter && version.submittedBy === session.userId) {
    // Approving your own submission is not a review. The office asserting a
    // Befund means somebody OTHER than its author read it.
    throw new ForbiddenError('The submitter cannot approve their own version', {
      op: transition.op,
    })
  }
  if (transition.requires.ifMatch && (input.ifMatch ?? null) !== version.contentHash) {
    throw new ConflictError('The version changed since you read it', {
      op: transition.op,
      contentHash: version.contentHash,
    })
  }
}

/** The columns a transition stamps, by the state it lands in. */
function stampFor(
  to: DocumentVersionState,
  session: AuthorizedSession,
  input: TransitionInput,
  now: Date,
): Record<string, unknown> {
  const comment = input.comment?.trim() || null
  switch (to) {
    case 'in_review':
      return { state: to, submittedBy: session.userId, submittedAt: now }
    case 'approved':
      return {
        state: to,
        reviewedBy: session.userId,
        reviewedAt: now,
        approvedBy: session.userId,
        approvedAt: now,
        reviewComment: comment,
      }
    case 'changes_requested':
    case 'rejected':
      return { state: to, reviewedBy: session.userId, reviewedAt: now, reviewComment: comment }
    case 'published':
      return { state: to, publishedBy: session.userId, publishedAt: now }
    case 'draft':
      // A revision clears the reviewer's words: they were about the bytes that
      // have just been replaced, and a comment that outlives its subject reads
      // as an outstanding objection to something nobody wrote.
      return { state: to, reviewComment: null, reviewedBy: null, reviewedAt: null }
    default:
      return { state: to }
  }
}

/**
 * Move one version through one transition.
 *
 * The order is deliberate and is the whole of the concurrency story:
 *
 *   1. resolve the document through its own shelf's access rule;
 *   2. read the version, find the row of the transition table for
 *      `(its state, this op)` — no row is a 409, not a 400: the caller asked for
 *      something legal on a version that has moved on;
 *   3. check the guards the database cannot see;
 *   4. check the permission;
 *   5. **compare and swap** — `WHERE state = $expected`. A caller that lost the
 *      race between (2) and (5) gets the 409 here rather than a lost update;
 *   6. run the effects, on the row the database handed back.
 */
export async function transitionDocumentVersion(
  session: AuthorizedSession,
  documentId: string,
  versionId: string,
  op: DocumentVersionOp,
  input: TransitionInput = {},
): Promise<DocumentVersion> {
  const document = await getAccessibleDocument(session, documentId, 'write')
  const version = await findDocumentVersion(versionId, documentId, session.organizationId)
  if (!version) throw new NotFoundError('Version not found')

  const transition = findDocumentVersionTransition(version.state, op)
  if (!transition) {
    throw new ConflictError(`Cannot ${op} a version that is ${version.state}`, {
      state: version.state,
      op,
    })
  }

  assertGuards(session, version, transition, input)
  await requireTransitionPermission(session, document, transition)

  const stamp = stampFor(transition.to, session, input, new Date())
  // `promotes` rows go through the transaction that also supersedes the
  // previous published version and moves the item's pointer; see the flag.
  const promoted = transition.promotes
    ? await promoteVersionToPublished(
        versionId,
        documentId,
        session.organizationId,
        version.state,
        stamp,
      )
    : null
  const swapped = transition.promotes
    ? (promoted?.version ?? null)
    : await compareAndSwapVersionState(versionId, session.organizationId, version.state, stamp)
  if (!swapped) {
    throw new ConflictError('The version changed while you were deciding', { op })
  }

  await runEffects({
    session,
    document,
    version: swapped,
    previous: promoted?.superseded[0] ?? null,
    transition,
    input,
  })
  return swapped
}

/** What a caller hands in to create a version from nothing. */
export interface CreateVersionInput {
  document: Document
  op: Extract<DocumentVersionOp, 'upload' | 'create'>
  storageKey: string
  storageBucket: string | null
  contentType: string | null
  fileSize: number | null
  contentHash: string | null
  request?: Request
  actingHuman?: boolean
  /**
   * The chat conversation this version was filed from (migration 0084).
   *
   * Supplied only by the agent's internal route, out of the VERIFIED envelope.
   * It is why a reviewer's „Änderungen anfordern" can reach the next turn of
   * that conversation instead of opening a task nobody asked for.
   */
  originConversationId?: string | null
}

/**
 * Record a version that did not come from another version — a human upload, or
 * a producer's first draft.
 *
 * Both go through the transition table's `from: null` rows rather than
 * inserting directly, so the permission, the audit action and the effects of
 * "a person uploaded a file" and "Piloti filed a draft" are stated in the same
 * place as every other transition. The bytes are already stored by the time
 * this runs: whoever wrote them owns the quota admission, because that is the
 * path the object went through (`admitOrDiscard` for an upload,
 * `fileGeneratedDocument` for a draft) and a second charge here would double
 * count.
 */
export async function createDocumentVersion(
  session: AuthorizedSession,
  input: CreateVersionInput,
): Promise<DocumentVersion> {
  const transition = findDocumentVersionTransition(null, input.op)
  if (!transition) throw new ConflictError(`No transition creates a version by ${input.op}`)
  if (transition.actor === 'human' && input.actingHuman === false) {
    throw new ForbiddenError(`${input.op} is a person's decision`, { op: input.op })
  }
  await requireTransitionPermission(session, input.document, transition)

  const now = new Date()
  const version = await insertDocumentVersion({
    organizationId: session.organizationId,
    documentId: input.document.id,
    projectId: input.document.projectId,
    versionNumber: await nextVersionNumber(input.document.id, session.organizationId),
    storageKey: input.storageKey,
    storageBucket: input.storageBucket,
    contentType: input.contentType,
    fileSize: input.fileSize,
    contentHash: input.contentHash,
    createdBy: session.userId,
    originConversationId: input.originConversationId ?? null,
    // A published version needs an approver, and for an upload the person who
    // uploaded it IS the assertion — the CHECK is satisfied honestly rather
    // than worked around. A draft carries none of this.
    ...(transition.to === 'published'
      ? {
          state: 'published' as const,
          approvedBy: session.userId,
          approvedAt: now,
          publishedBy: session.userId,
          publishedAt: now,
        }
      : { state: transition.to }),
  })

  const promoted = transition.promotes
    ? await promoteVersionToPublished(
        version.id,
        input.document.id,
        session.organizationId,
        null,
      )
    : null

  await runEffects({
    session,
    document: input.document,
    version,
    previous: promoted?.superseded[0] ?? null,
    transition,
    input: { request: input.request, actingHuman: input.actingHuman },
  })
  return version
}

/**
 * Start a new draft from the published version.
 *
 * The draft SHARES the published version's storage key until its content is
 * replaced. That is not a shortcut: a fork that copied the bytes would charge
 * the quota twice for a file nobody has changed yet, and the object it made
 * would be identical to the one beside it. The first `PUT content` is what
 * allocates the draft its own key, under `v<n>/`, so the published version's
 * bytes are never written over.
 *
 * One open version per document is the database's rule (a partial unique
 * index); this reports it as a 409 with the existing draft named, because "there
 * is already a draft" is something the caller can act on.
 */
export async function forkDraftVersion(
  session: AuthorizedSession,
  documentId: string,
  request?: Request,
): Promise<DocumentVersion> {
  const document = await getAccessibleDocument(session, documentId, 'write')
  const open = await findOpenVersion(documentId, session.organizationId)
  if (open) {
    throw new ConflictError('This document already has an open version', {
      versionId: open.id,
      state: open.state,
    })
  }
  const published = await findPublishedVersion(documentId, session.organizationId)
  const source = published ?? {
    storageKey: document.storageKey,
    storageBucket: document.storageBucket,
    contentType: document.contentType,
    fileSize: document.fileSize,
    contentHash: document.contentHash,
  }

  const transition = findDocumentVersionTransition(null, 'create')
  if (!transition) throw new ConflictError('No transition creates a draft')
  await requireTransitionPermission(session, document, transition)

  const version = await insertDocumentVersion({
    organizationId: session.organizationId,
    documentId,
    projectId: document.projectId,
    versionNumber: await nextVersionNumber(documentId, session.organizationId),
    state: 'draft',
    storageKey: source.storageKey,
    storageBucket: source.storageBucket,
    contentType: source.contentType,
    fileSize: source.fileSize,
    contentHash: source.contentHash,
    createdBy: session.userId,
  })

  await runEffects({
    session,
    document,
    version,
    previous: published,
    transition,
    input: { request },
  })
  return version
}

/**
 * Replace an open version's bytes, whole-body, with `If-Match` on the digest.
 *
 * **Whole body, never a string replacement.** The API has no patch verb, and
 * that is a decision rather than an omission: exact-string editing happens in
 * the working directory (slice 1), where the model can read what it is editing;
 * filing is a whole document. An API that offered `old_string`/`new_string`
 * would re-derive the uniqueness check, the newline hints and six error strings
 * on the wrong side of the boundary.
 *
 * The new bytes go to the version's OWN key. A draft forked from a published
 * version starts out sharing that version's key (see {@link forkDraftVersion}),
 * so the first replace moves it to `v<n>/…` and the published bytes are never
 * written over. A second replace overwrites the draft's own object in place —
 * a draft is not history and its intermediate bytes belong to no version.
 */
export async function replaceVersionContent(
  session: AuthorizedSession,
  documentId: string,
  versionId: string,
  content: string,
  ifMatch: string,
  request?: Request,
): Promise<DocumentVersion> {
  const document = await getAccessibleDocument(session, documentId, 'write')
  const version = await findDocumentVersion(versionId, documentId, session.organizationId)
  if (!version) throw new NotFoundError('Version not found')

  const transition = findDocumentVersionTransition(version.state, 'update')
  if (!transition) {
    throw new ConflictError(`Cannot replace the content of a version that is ${version.state}`, {
      state: version.state,
    })
  }
  assertGuards(session, version, transition, { ifMatch })
  await requireTransitionPermission(session, document, transition)

  const bytes = Buffer.from(content, 'utf8')
  const storageBucket = await ensureTenantBucketChecked(
    bucketAdminS3Client,
    session.organizationId,
  )
  const storageKey = versionStorageKey(document, version.versionNumber)
  await s3Client.send(
    new PutObjectCommand({
      Bucket: storageBucket,
      Key: storageKey,
      Body: bytes,
      ContentType: version.contentType ?? 'text/markdown',
    }),
  )

  const swapped = await compareAndSwapVersionState(
    versionId,
    session.organizationId,
    version.state,
    {
      ...stampFor(transition.to, session, {}, new Date()),
      storageKey,
      storageBucket,
      fileSize: bytes.byteLength,
      contentHash: contentDigest(bytes),
    },
  )
  if (!swapped) throw new ConflictError('The version changed while you were writing')

  await runEffects({
    session,
    document,
    version: swapped,
    previous: null,
    transition,
    input: { request },
  })
  return swapped
}

/**
 * The key a version's OWN bytes live under.
 *
 * Version 1 keeps today's key exactly — `doc/<id>/<filename>` — so nothing that
 * predates versioning moves, and every stored object, thumbnail and `_bim/`
 * derivative stays where its row says it is. Later versions get a `v<n>/`
 * segment of their own, which is what makes "a superseded version keeps its
 * bytes" possible at all: without it the re-upload would write over the object
 * the previous version's row names.
 */
export function versionStorageKey(document: Document, versionNumber: number): string {
  return versionedStorageKey(document.storageKey, versionNumber)
}

/**
 * The same rule, applied to a key that has no row yet.
 *
 * The upload paths build their key before the document exists, so they cannot
 * hand in a `Document`. Pure, so all four shelves — project, Archiv, session and
 * the generated-document filer — get the same answer.
 */
export function versionedStorageKey(baseStorageKey: string, versionNumber: number): string {
  if (versionNumber <= 1) return baseStorageKey
  // Derived from the item's OWN key rather than rebuilt from its parts, so the
  // folder path, the shelf prefix (`project/`, `archiv/`, `session/`) and the
  // sanitised filename are whatever this document already uses. Rebuilding them
  // here would be a second copy of `buildStorageKey`'s three shelf variants,
  // and the copies would agree until somebody moved a document.
  return baseStorageKey.replace(/\/([^/]+)$/, `/v${versionNumber}/$1`)
}

/**
 * Record the version a human upload just stored.
 *
 * Called by all three upload shelves AFTER the bytes are admitted, so the row it
 * reads already carries the storage columns it should mirror. The quota is not
 * charged again here: `admitOrDiscard` / `admitReplacementOrDiscard` is the one
 * admitting path and this is bookkeeping on top of it.
 *
 * A re-upload's previous version is superseded by the same transaction and
 * KEEPS ITS OBJECT — which is why the callers no longer call
 * `discardSupersededObjects`. That was correct while a document had one set of
 * bytes; with a history it deletes the object a row still names.
 */
export async function recordUploadedVersion(
  session: AuthorizedSession,
  documentId: string,
  request?: Request,
): Promise<DocumentVersion | null> {
  const document = await findDocumentInOrg(documentId, session.organizationId)
  // The upload wrote the row a moment ago; a miss means somebody deleted it in
  // between, and inventing a version for a document that is gone helps nobody.
  if (!document) return null
  return createDocumentVersion(session, {
    document,
    op: 'upload',
    storageKey: document.storageKey,
    storageBucket: document.storageBucket,
    contentType: document.contentType,
    fileSize: document.fileSize,
    contentHash: document.contentHash,
    request,
  })
}

/** The version number the next upload of this document will be. */
export { nextVersionNumber }

/** Read one version's bytes back as text — the diff endpoint's other half. */
export async function readVersionContent(
  session: AuthorizedSession,
  documentId: string,
  versionId: string,
): Promise<string> {
  await getAccessibleDocument(session, documentId, 'read')
  const version = await findDocumentVersion(versionId, documentId, session.organizationId)
  if (!version) throw new NotFoundError('Version not found')
  const bucket = resolveDocumentBucket(version.storageBucket)
  const object = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: version.storageKey }),
  )
  const body = await object.Body?.transformToString('utf8')
  if (body === undefined) throw new NotFoundError('Version content not available')
  return body
}

/**
 * One version's bytes and its identity, for a SERVICE caller that holds only a
 * version id (`GET /api/internal/document-versions/[versionId]/content`).
 *
 * Not an authorization bypass and not a second read path: it is the same object
 * fetch {@link readVersionContent} runs, with the organization — which the
 * caller states and the internal route puts in the tenant slot — as the whole
 * of the predicate instead of a session. A version id from another tenant finds
 * no row, so it answers 404 exactly as a made-up id does.
 *
 * Why the state travels back with the text: the Python tier writes the bytes
 * into the conversation's working directory and stamps a filing record on them
 * so a later `file_draft` on that path UPDATES this document's open version
 * rather than creating a second item, and the `update` op needs both the state
 * (is it still replaceable) and the content hash (If-Match).
 */
export async function readVersionForService(
  versionId: string,
  organizationId: string,
): Promise<{
  documentId: string
  versionId: string
  versionNumber: number
  state: DocumentVersionState
  contentHash: string | null
  contentType: string | null
  filename: string
  displayName: string
  content: string
}> {
  const version = await findDocumentVersionInOrg(versionId, organizationId)
  if (!version) throw new NotFoundError('Version not found')
  const document = await findDocumentInOrg(version.documentId, organizationId)
  if (!document) throw new NotFoundError('Version not found')
  const object = await s3Client.send(
    new GetObjectCommand({
      Bucket: resolveDocumentBucket(version.storageBucket),
      Key: version.storageKey,
    }),
  )
  const content = await object.Body?.transformToString('utf8')
  if (content === undefined) throw new NotFoundError('Version content not available')
  return {
    documentId: version.documentId,
    versionId: version.id,
    versionNumber: version.versionNumber,
    state: version.state,
    contentHash: version.contentHash,
    contentType: version.contentType,
    filename: document.filename,
    displayName: documentDisplayName(document),
    content,
  }
}

/**
 * Take a document out of the working set.
 *
 * An item-level act, not a version state: „archiviert" is a statement about the
 * FILE, and putting it on a version would make it ambiguous which version was
 * archived. The bytes and every version stay — this is not a delete, and there
 * is no soft delete on this table. What goes is the chunks, so an archived
 * document stops answering questions.
 */
export async function archiveDocument(
  session: AuthorizedSession,
  documentId: string,
  request?: Request,
): Promise<{ documentId: string; lifecycle: 'archived' }> {
  const document = await getAccessibleDocument(session, documentId, 'write')
  if (document.projectId) {
    await requireProjectAccess(session, document.projectId, [
      'project:documents:write',
      'project:edit',
    ])
  }
  await setDocumentLifecycle(documentId, session.organizationId, 'archived')
  // „Archiviert" is a statement that the file has left the working set, and a
  // file that keeps answering questions has not left it. The chunks therefore
  // go, for a human upload as much as for a Piloti document — this docstring
  // said so before the code did. Purged and not deleted: the row, every
  // version and every object stay, so the only thing that has to be rebuilt if
  // somebody ever un-archives is the index.
  //
  // Best-effort, and AFTER the lifecycle write: the row is the durable record
  // of intent, and an unreachable backend must not leave a document that a
  // person believes is archived still listed as active. `chunksPurged` rides on
  // the audit event so a `false` is visible where somebody looks, exactly as
  // `deleteDocument` records it.
  const purgeRef = collectionFileRef(document)
  const chunksPurged = purgeRef
    ? await purgeIngestedChunks(getBackendUrl(), purgeRef, BACKEND_PURGE_TIMEOUT_MS)
    : null
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.archived',
    targetType: 'document',
    targetId: documentId,
    metadata: {
      projectId: document.projectId ?? '',
      filename: document.filename.slice(0, 200),
      collectionName: document.collectionName,
      // `null` is "this row owns no chunks", which is a different fact from
      // "the backend refused" and must not read as one.
      chunksPurged,
    },
    request,
  })
  return { documentId, lifecycle: 'archived' }
}

/** One version as the wire carries it. Dates as ISO strings, no storage keys. */
export function toDocumentVersionView(version: DocumentVersion): DocumentVersionView {
  return {
    id: version.id,
    documentId: version.documentId,
    versionNumber: version.versionNumber,
    state: version.state,
    contentType: version.contentType,
    fileSize: version.fileSize,
    contentHash: version.contentHash,
    submittedBy: version.submittedBy,
    submittedAt: version.submittedAt?.toISOString() ?? null,
    reviewedBy: version.reviewedBy,
    reviewedAt: version.reviewedAt?.toISOString() ?? null,
    approvedBy: version.approvedBy,
    approvedAt: version.approvedAt?.toISOString() ?? null,
    publishedBy: version.publishedBy,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    reviewComment: version.reviewComment,
    createdBy: version.createdBy,
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
  }
}

/** `GET /api/documents/[id]/versions` */
export async function listDocumentVersionViews(
  session: AuthorizedSession,
  documentId: string,
): Promise<{
  documentId: string
  lifecycle: 'active' | 'archived'
  publishedVersionId: string | null
  versions: DocumentVersionView[]
}> {
  const document = await getAccessibleDocument(session, documentId, 'read')
  const versions = await listDocumentVersions(documentId, session.organizationId)
  return {
    documentId,
    lifecycle: document.lifecycle,
    publishedVersionId: document.publishedVersionId,
    versions: versions.map(toDocumentVersionView),
  }
}

/**
 * The editorial state of documents a caller has ALREADY listed.
 *
 * Authorization is the listing's. These ids come out of `listDocuments`, which
 * ran `requireProjectAccess` before it returned them, and this adds no field a
 * reader of that listing may not see — how many versions a file has and what
 * state the newest one is in are the two facts the Files badge renders. Passing
 * the ids rather than a project id is what keeps it that way: this function
 * cannot widen a listing, only annotate one.
 *
 * Returned as a Map because every caller merges it row by row.
 */
export async function summarizeDocumentVersions(
  organizationId: string,
  documentIds: readonly string[],
): Promise<Map<string, DocumentVersionSummary>> {
  const summaries = await listDocumentVersionSummaries(documentIds, organizationId)
  return new Map(summaries.map((summary) => [summary.documentId, summary]))
}

/** `GET /api/documents/[id]/versions/[versionId]` */
export async function getDocumentVersionView(
  session: AuthorizedSession,
  documentId: string,
  versionId: string,
): Promise<DocumentVersionView> {
  await getAccessibleDocument(session, documentId, 'read')
  const version = await findDocumentVersion(versionId, documentId, session.organizationId)
  if (!version) throw new NotFoundError('Version not found')
  return toDocumentVersionView(version)
}

/** Every transition, re-exported so a spec reads one list rather than two. */
export { DOCUMENT_VERSION_TRANSITIONS }
export type { DocumentVersionSummary }
