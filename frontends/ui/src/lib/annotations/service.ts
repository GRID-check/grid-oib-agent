/**
 * Anmerkungen service — the logic and the authorization for a document's
 * Anmerkungen and their threads (migration 0138; CONTEXT.md „Anmerkung").
 *
 * Access follows the document and nothing else: whoever may read the document
 * reads its Anmerkungen, and whoever may write in its folder sets, takes over,
 * resolves and answers them (`getAccessibleDocument`, so a closed project, a
 * read-only folder and a held upload refuse exactly as they refuse a rename).
 * Deleting one is for the person who set it: a mark somebody else is working
 * from does not vanish under them, it is resolved. A mark Piloti set for its
 * asker counts as theirs ({@link mayDeleteMark}), and a reply is deleted by
 * the person it was posted for ({@link deleteReply}).
 *
 * Piloti works through the same functions with the asker's pinned session
 * (`/api/internal/document-annotations`), so it may do exactly what the asker
 * may, and nothing more. Its own findings are born proposals a person takes
 * over or dismisses. A mark the asker asked for is born open, taken over by
 * the asker in the same move (`accepted_by`); a change the asker asked for runs
 * through `updateAnnotation` like a person's PATCH, and Piloti says what it did
 * in the mark's thread (`updateAnnotationForAsker`). The CHECKs in 0138 hold
 * that Piloti's mark is open only with a person behind it, so the rule does
 * not depend on this file.
 *
 * A reply that addresses Piloti, a reply on Piloti's own open question, and
 * making Piloti the delegate on a mark wake Piloti (ADR-0106, `./wake.ts`):
 * the wake is enqueued in the write's own transaction, and the response says
 * whether the server will answer (`wake`), so the browser never asks twice.
 *
 * Taking a mark back from Piloti (clearing the delegation, or resolving,
 * dismissing or deleting the mark) ends what the delegation started
 * (`./take-back.ts`): a wake still queued never starts, and a turn that runs
 * is stopped by a job queued in the take-back's own transaction. Only the
 * delegation's own turn ending hands a mark back, never a reply of Piloti's
 * (`lib/turns/outcome.ts`).
 *
 * A person's decisions leave traces after the write committed, all
 * best-effort: what Piloti asked on a mark is no longer waiting on them
 * (`./attention.ts`), and taking over or dismissing a mark Piloti proposed is
 * a line in the organization's audit trail (`piloti.mark.decided`,
 * `./mark-audit.ts`) and a score on the turn that proposed it
 * (`lib/langfuse/decision-score.ts`).
 *
 * Every write tells the document's room (the `doc:<id>` live channel,
 * `lib/realtime/document-channel.ts`), so everyone looking at the document
 * re-reads; a failed publish never fails the write.
 *
 * Only the office's own shelves carry Anmerkungen, the project and the
 * Büroablage. A chat attachment has no folder and no team to act on a mark.
 */

import 'server-only'
import {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document, DocumentAnnotationReplyRow, DocumentAnnotationRow, PilotiWakeRow } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { mayOpenDocument } from '@/lib/documents/may-open'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import {
  AnnotationLimitReachedError,
  deleteAnnotationReply,
  deleteDocumentAnnotation,
  findDocumentAnnotation,
  insertAnnotationReply,
  insertDocumentAnnotations,
  listDocumentAnnotations,
  ReplyLimitReachedError,
  updateDocumentAnnotation,
  type AnnotationChanges,
  type AnnotationRecord,
  type NewAnnotationValues,
} from './repository'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import {
  onAssigneeChanged,
  onMarkDeleted,
  onMarkMoved,
  onMarkReplied,
  onMarkSettledByPerson,
  type MarkRef,
  type MayOpen,
} from './attention'
import { auditMarkDecided } from './mark-audit'
import type { AnnotationChange } from './room-types'
import { auditSuppressedWake, enqueueWake, replyTrigger, wakeOutcomeOf, wakesEnabled, type EnqueuedWake } from './wake'
import { delegationEventId } from './wake-ids'
import { latestWakesFor, pilotiWorkOf } from './piloti-work'
import { wakeOfReply, wakeSpansFor, type WakeSpan } from './wake-attribution'
import {
  auditDeletedWithMark,
  readTakeBack,
  settleTakenBack,
  type EndedDelegation,
  type TakeBack,
  type TakeBackAudit,
} from './take-back'
import {
  annotationBox,
  annotationProposalSchema,
  compareAnnotations,
  createAnnotationRequestSchema,
  createReplyRequestSchema,
  MAX_ANNOTATIONS_PER_DOCUMENT,
  MAX_PROPOSALS_PER_CALL,
  MAX_REPLIES_PER_ANNOTATION,
  updateAnnotationRequestSchema,
  type AnnotationAuthor,
  type AnnotationListResponse,
  type AnnotationProposal,
  type AnnotationReplyView,
  type AnnotationStatus,
  type AnnotationView,
  type CreateAnnotationRequest,
  type CreateReplyRequest,
  type InternalAnnotation,
  type PilotiWakeTrigger,
  type UpdateAnnotationRequest,
  type WakeOutcome,
} from './types'

/** Who acts: a person in their own session, or Piloti in the asker's. `peerId` is the person's tab, when it says. */
export interface AnnotationActor {
  kind: AnnotationAuthor
  peerId?: string | null
}

const PERSON: AnnotationActor = { kind: 'person' }
export const PILOTI: AnnotationActor = { kind: 'piloti' }

/**
 * Whether this person may delete the mark: one they set themselves, or one
 * Piloti set for them. Piloti's mark carries the asker as `created_by` (the
 * session it works in), and `accepted_by` is the asker too when they asked for
 * exactly this mark (born open) or took their own proposal over. A mark
 * Piloti proposed and somebody ELSE took over has two people behind it, so
 * neither deletes it; it is resolved or dismissed. A proposal nobody took
 * over has no `accepted_by`, so it is dismissed, never deleted.
 */
const mayDeleteMark = (record: Pick<AnnotationRecord, 'authorKind' | 'createdBy' | 'acceptedBy'>, userId: string) =>
  record.createdBy === userId && (record.authorKind === 'person' || record.acceptedBy === userId)

/** Whether the document sits on a shelf that carries Anmerkungen. */
const annotatable = (doc: Document) => doc.scope === 'project' || doc.scope === 'archiv'

/**
 * Whether this session may write on the document, as a boolean. A refusal of
 * the write (403) is an answer here, not an error: the reader still sees the
 * Anmerkungen, without the controls.
 */
async function mayWrite(session: AuthorizedSession, documentId: string): Promise<boolean> {
  try {
    await getAccessibleDocument(session, documentId, 'write')
    return true
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return false
    throw error
  }
}

/** Display names by user id; empty when the directory cannot be read, which costs names and nothing else. */
type Names = ReadonlyMap<string, { name: string }>

async function directoryNames(organizationId: string): Promise<Names> {
  return loadOrganizationDirectory(organizationId).catch(() => new Map())
}

const nameOf = (names: Names, userId: string | null) => (userId ? (names.get(userId)?.name ?? null) : null)

function toReplyView(
  reply: DocumentAnnotationReplyRow,
  names: Names,
  wakes: readonly WakeSpan[]
): AnnotationReplyView {
  return {
    id: reply.id,
    annotationId: reply.annotationId,
    authorKind: reply.authorKind,
    body: reply.body,
    createdBy: reply.createdBy,
    createdByName: nameOf(names, reply.createdBy),
    createdAt: reply.createdAt.toISOString(),
    addressesPiloti: reply.addressesAgent,
    wokenBy: wakeOfReply(reply, wakes),
  }
}

function toView(
  record: AnnotationRecord,
  doc: Document,
  session: AuthorizedSession,
  writable: boolean,
  names: Names,
  wakes: readonly WakeSpan[] = [],
  work: ReadonlyMap<string, PilotiWakeRow> = new Map()
): AnnotationView {
  const wake = work.get(record.id)
  return {
    id: record.id,
    documentId: record.documentId,
    number: record.number,
    page: record.page,
    shape: record.shape,
    x: record.x,
    y: record.y,
    w: record.w,
    h: record.h,
    kind: record.kind,
    body: record.body,
    basis: record.basis,
    authorKind: record.authorKind,
    status: record.status,
    assigneeUserId: record.assigneeUserId,
    assigneeName: nameOf(names, record.assigneeUserId),
    dueOn: record.dueOn,
    fassungNumber: record.fassungNumber,
    // A document with no version row shows the bytes its row holds, which is
    // where an Anmerkung set without a version was set.
    onCurrentFassung: (record.versionId ?? null) === (doc.publishedVersionId ?? null),
    createdBy: record.createdBy,
    createdByName: nameOf(names, record.createdBy),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    acceptedBy: record.acceptedBy,
    acceptedByName: nameOf(names, record.acceptedBy),
    closedBy: record.closedBy,
    closedByName: nameOf(names, record.closedBy),
    closedAt: record.closedAt ? record.closedAt.toISOString() : null,
    delegatedBy: record.delegatedBy,
    delegatedByName: nameOf(names, record.delegatedBy),
    delegatedAt: record.delegatedAt ? record.delegatedAt.toISOString() : null,
    replies: record.replies.map((reply) => toReplyView(reply, names, wakes)),
    pilotiWork: wake ? pilotiWorkOf(wake, nameOf(names, wake.actorUserId)) : null,
    canEdit: writable,
    canDelete: writable && mayDeleteMark(record, session.userId),
  }
}

/** Whether this person could open the document, its folder included, which is what being assigned to it needs. */
async function isAssignable(session: AuthorizedSession, doc: Document, userId: string): Promise<boolean> {
  return (await mayOpenDocument(session, doc, [userId])).has(userId)
}

/**
 * Refuse an assignee who could not open the document: assigning is not access
 * (ADR-0059), so a person outside the project would be on the hook for a sheet
 * they cannot see.
 */
async function requireAssignable(session: AuthorizedSession, doc: Document, userId: string): Promise<void> {
  if (await isAssignable(session, doc, userId)) return
  throw new UnprocessableError('The assignee cannot open this document.', { field: 'assigneeUserId' })
}

/** How many name matches an assignee lookup checks for access before it asks instead. */
const MAX_ASSIGNEE_CANDIDATES = 10

const nameKey = (value: string | null | undefined) =>
  (value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de')

/**
 * The one member a name or an e-mail address means, among those who can open
 * the document. Piloti has no roster and never sees a user id, so it passes
 * the person as the asker said it („Anna"): an exact name or address first,
 * then a first name or the start of a name. None, or more than one, is a 422
 * naming the candidates, which the tool turns into a question.
 */
export async function resolveAssignee(session: AuthorizedSession, doc: Document, query: string): Promise<string> {
  const key = nameKey(query)
  const people = [...(await loadOrganizationDirectory(session.organizationId)).values()]
  const exact = people.filter(
    (person) => person.userId === query.trim() || nameKey(person.name) === key || nameKey(person.email) === key
  )
  const loose = people.filter((person) => {
    const name = nameKey(person.name)
    return name.startsWith(key) || name.split(' ').includes(key)
  })
  const candidates = (exact.length > 0 ? exact : loose).slice(0, MAX_ASSIGNEE_CANDIDATES)
  const mayOpen = await mayOpenDocument(session, doc, candidates.map((person) => person.userId))
  const reachable = candidates.filter((person) => mayOpen.has(person.userId))
  if (reachable.length === 1) return reachable[0].userId
  if (reachable.length === 0) {
    throw new UnprocessableError(`Nobody called „${query.trim()}" can open this document.`, {
      field: 'assignee',
      reason: 'assignee-unknown',
    })
  }
  const named = reachable.map((person) => (person.email ? `${person.name} (${person.email})` : person.name))
  throw new UnprocessableError(`„${query.trim()}" could be ${named.join(', ')}.`, {
    field: 'assignee',
    reason: 'assignee-ambiguous',
  })
}

/** Tell the room, never failing the write that caused it. */
function announce(
  session: AuthorizedSession,
  documentId: string,
  annotationIds: string[],
  change: AnnotationChange,
  actor: AnnotationActor
): void {
  void publishToDocumentRoom(documentId, {
    kind: 'annotations.changed',
    annotationIds,
    change,
    actor: {
      peerId: actor.peerId ?? null,
      userId: session.userId,
      name: actor.kind === 'piloti' ? 'Piloti' : (session.name ?? session.email),
      kind: actor.kind,
    },
  })
}

async function requireWritableDocument(session: AuthorizedSession, documentId: string): Promise<Document> {
  const doc = await getAccessibleDocument(session, documentId, 'write')
  if (!annotatable(doc)) throw new BadRequestError('This document cannot carry Anmerkungen.')
  return doc
}

async function viewOf(session: AuthorizedSession, doc: Document, annotationId: string): Promise<AnnotationView> {
  const record = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!record) throw new NotFoundError()
  const [names, wakes, work] = await Promise.all([
    directoryNames(session.organizationId),
    wakeSpansFor(session.organizationId, doc.id, [record]),
    latestWakesFor(session.organizationId, doc.id, record.id),
  ])
  return toView(record, doc, session, true, names, wakes, work)
}

const limitReached = (error: unknown): never => {
  if (error instanceof AnnotationLimitReachedError) {
    throw new UnprocessableError(`A document carries at most ${MAX_ANNOTATIONS_PER_DOCUMENT} Anmerkungen.`)
  }
  throw error
}

const toMark = (input: {
  page: number
  shape: NewAnnotationValues['shape']
  x: number
  y: number
  w?: number | null
  h?: number | null
  kind: NewAnnotationValues['kind']
  body: string
  basis?: string | null
  assigneeUserId?: string | null
  dueOn?: string | null
}): NewAnnotationValues => ({
  page: input.page,
  shape: input.shape,
  x: input.x,
  y: input.y,
  w: input.shape === 'region' ? (input.w ?? null) : null,
  h: input.shape === 'region' ? (input.h ?? null) : null,
  kind: input.kind,
  body: input.body,
  basis: input.basis ?? null,
  assigneeUserId: input.assigneeUserId ?? null,
  dueOn: input.dueOn ?? null,
})

/** Every Anmerkung on a document this session may read, live ones first. */
export async function listAnnotations(session: AuthorizedSession, documentId: string): Promise<AnnotationListResponse> {
  const doc = await getAccessibleDocument(session, documentId, 'read')
  if (!annotatable(doc)) return { annotations: [], canAnnotate: false, pilotiWakes: false }
  const [records, writable, names] = await Promise.all([
    listDocumentAnnotations(session.organizationId, doc.id),
    mayWrite(session, doc.id),
    directoryNames(session.organizationId),
  ])
  const [wakes, work] = await Promise.all([
    wakeSpansFor(session.organizationId, doc.id, records),
    latestWakesFor(session.organizationId, doc.id),
  ])
  const annotations = records
    .map((record) => toView(record, doc, session, writable, names, wakes, work))
    .sort(compareAnnotations)
  return { annotations, canAnnotate: writable, pilotiWakes: wakesEnabled(session) }
}

/** A person sets one Anmerkung on the Fassung the document shows now. */
export async function createAnnotation(
  session: AuthorizedSession,
  documentId: string,
  input: CreateAnnotationRequest,
  actor: AnnotationActor = PERSON
): Promise<{ annotation: AnnotationView }> {
  const parsed = createAnnotationRequestSchema.parse(input)
  const doc = await requireWritableDocument(session, documentId)
  if (parsed.assigneeUserId) await requireAssignable(session, doc, parsed.assigneeUserId)
  const [row] = await insertDocumentAnnotations({
    organizationId: session.organizationId,
    documentId: doc.id,
    versionId: doc.publishedVersionId ?? null,
    authorKind: 'person',
    createdBy: session.userId,
    marks: [toMark(parsed)],
  }).catch(limitReached)
  announce(session, doc.id, [row.id], 'created', { ...actor, kind: 'person' })
  if (row.assigneeUserId) traceAssigned(session, doc, row, null, PERSON)
  return { annotation: await viewOf(session, doc, row.id) }
}

/**
 * Piloti proposes findings on a document, on behalf of the person it works for.
 * Each is born `proposed`; none counts until a person takes it over.
 */
export async function proposeAnnotations(
  session: AuthorizedSession,
  documentId: string,
  proposals: readonly AnnotationProposal[]
): Promise<{ annotations: AnnotationView[] }> {
  return insertPilotiMarks(session, documentId, proposals, null)
}

/**
 * Piloti sets marks the asker asked for („Setz dort eine Anmerkung"). Each is
 * born `open`, taken over by the asker in the same move, because the person
 * stood behind it by asking: the asker is `accepted_by` and accountable.
 */
export async function setAnnotationsForAsker(
  session: AuthorizedSession,
  documentId: string,
  marks: readonly AnnotationProposal[]
): Promise<{ annotations: AnnotationView[] }> {
  return insertPilotiMarks(session, documentId, marks, session.userId)
}

async function insertPilotiMarks(
  session: AuthorizedSession,
  documentId: string,
  proposals: readonly AnnotationProposal[],
  acceptedBy: string | null
): Promise<{ annotations: AnnotationView[] }> {
  if (proposals.length === 0 || proposals.length > MAX_PROPOSALS_PER_CALL) {
    throw new BadRequestError(`Between 1 and ${MAX_PROPOSALS_PER_CALL} marks per call.`)
  }
  const parsed = proposals.map((proposal) => annotationProposalSchema.parse(proposal))
  const doc = await requireWritableDocument(session, documentId)
  const rows = await insertDocumentAnnotations({
    organizationId: session.organizationId,
    documentId: doc.id,
    versionId: doc.publishedVersionId ?? null,
    authorKind: 'piloti',
    createdBy: session.userId,
    acceptedBy,
    marks: parsed.map(toMark),
  }).catch(limitReached)
  const ids = rows.map((row) => row.id)
  announce(session, doc.id, ids, 'created', PILOTI)
  const names = await directoryNames(session.organizationId)
  const records = await listDocumentAnnotations(session.organizationId, doc.id)
  const annotations = records
    .filter((record) => ids.includes(record.id))
    .map((record) => toView(record, doc, session, true, names))
  return { annotations }
}

/**
 * The bookkeeping a status move carries, or a 409 for a move that does not
 * exist. Taking over a proposal is the only way a machine finding becomes the
 * office's; dismissing it closes it as „verworfen".
 */
export function transition(
  from: AnnotationStatus,
  to: 'open' | 'resolved' | 'dismissed',
  record: Pick<AnnotationRecord, 'acceptedBy' | 'authorKind'>,
  userId: string,
  now: Date
): NonNullable<AnnotationChanges['transition']> {
  const closed = { closedBy: userId, closedAt: now }
  const reopened = { closedBy: null, closedAt: null }
  const acceptance = record.acceptedBy ? {} : { acceptedBy: userId, acceptedAt: now }
  if (from === 'proposed' && to === 'open') return { status: 'open', ...reopened, ...acceptance }
  if (from === 'proposed' && to === 'dismissed') return { status: 'dismissed', ...closed }
  if (from === 'open' && to === 'resolved') return { status: 'resolved', ...closed }
  if (from === 'resolved' && to === 'open') return { status: 'open', ...reopened }
  if (from === 'dismissed' && to === 'open') {
    return { status: 'open', ...reopened, ...(record.authorKind === 'piloti' ? acceptance : {}) }
  }
  throw new ConflictError(`An Anmerkung cannot go from ${from} to ${to}.`)
}

/** Run work that must never fail the write behind it: a throw or a rejection is a warning. */
function bestEffort(label: string, work: () => Promise<unknown>): void {
  const warn = (error: unknown) => console.warn(`[annotations] ${label} failed:`, error)
  try {
    void Promise.resolve(work()).catch(warn)
  } catch (error) {
    warn(error)
  }
}

/**
 * A person answered in a mark's thread, or the mark was closed (by a person, or
 * by Piloti in their name): what Piloti asked there no longer waits on anybody,
 * and a closed mark asks its Zuständige nothing.
 */
function traceSettled(session: AuthorizedSession, annotationId: string, closed: boolean): void {
  bestEffort('mark the mark settled', () =>
    onMarkSettledByPerson({ organizationId: session.organizationId, annotationId, closed })
  )
}

/** The mark an inbox item is about. */
const markRefOf = (session: AuthorizedSession, doc: Document, mark: { id: string; number: number }): MarkRef => ({
  organizationId: session.organizationId,
  documentId: doc.id,
  annotationId: mark.id,
  annotationNumber: mark.number,
  projectId: doc.projectId ?? null,
})

/** Who may open the document now: the one filter every item about its marks passes. */
const mayOpenOf =
  (session: AuthorizedSession, doc: Document): MayOpen =>
  (userIds) =>
    mayOpenDocument(session, doc, userIds)

/** The mark as a change left it, for the people the change concerns. */
type ChangedMark = Pick<DocumentAnnotationRow, 'id' | 'number' | 'body' | 'assigneeUserId' | 'status'>

/**
 * The mark's Zuständige changed, or a person took over Piloti's proposal that
 * names one (`previous` is then null): tell the new one, settle the old one's
 * row (`onAssigneeChanged`). Whoever acted is the session, Piloti's for the asker.
 */
function traceAssigned(
  session: AuthorizedSession,
  doc: Document,
  mark: ChangedMark,
  previous: string | null,
  actor: AnnotationActor
): void {
  bestEffort('tell the Zuständige', () =>
    onAssigneeChanged({
      ...markRefOf(session, doc, mark),
      actorUserId: session.userId,
      byPiloti: actor.kind === 'piloti',
      markText: mark.body,
      previousAssigneeUserId: previous,
      assigneeUserId: mark.assigneeUserId,
      open: mark.status === 'open',
    })
  )
}

/**
 * What a change tells people, once it committed, whoever made it (a person in
 * their PATCH, or Piloti for the asker through {@link updateAnnotationForAsker}):
 * a new Zuständige, a mark closed or reopened under its author, and a closed
 * mark settles what was asked on it.
 */
function traceChange(
  session: AuthorizedSession,
  doc: Document,
  existing: AnnotationRecord,
  after: ChangedMark,
  actor: AnnotationActor
): void {
  const reassigned = after.assigneeUserId !== existing.assigneeUserId
  const takenOver = existing.status === 'proposed' && after.status === 'open'
  if (reassigned || (takenOver && after.assigneeUserId)) {
    traceAssigned(session, doc, after, reassigned ? existing.assigneeUserId : null, actor)
  }
  if (after.status === existing.status) return
  const closedAs = after.status === 'resolved' || after.status === 'dismissed' ? after.status : null
  if (closedAs) traceSettled(session, existing.id, true)
  // Taking over a proposal is no news to its author: there was none yet.
  const move = closedAs ?? (existing.status === 'proposed' ? null : 'reopened')
  if (!move) return
  bestEffort('tell the mark’s author', () =>
    onMarkMoved({
      ...markRefOf(session, doc, existing),
      actorUserId: session.userId,
      byPiloti: actor.kind === 'piloti',
      markText: after.body,
      move,
      mark: existing,
      mayOpen: mayOpenOf(session, doc),
    })
  )
}

/**
 * What a person's move of status leaves behind, once it committed: taking
 * over or dismissing a mark Piloti proposed is a decision on Piloti's work, in
 * the audit trail (`piloti.mark.decided`, `./mark-audit.ts`) and as a score on
 * the turn that proposed it.
 */
function traceMove(
  session: AuthorizedSession,
  doc: { id: string; projectId: string | null },
  annotationId: string,
  existing: Pick<AnnotationRecord, 'authorKind' | 'status' | 'number' | 'kind' | 'createdBy'>,
  to: 'open' | 'resolved' | 'dismissed' | undefined
): void {
  const proposal = existing.authorKind === 'piloti' && existing.status === 'proposed'
  if (!proposal || (to !== 'open' && to !== 'dismissed')) return
  auditMarkDecided(session, doc, { ...existing, id: annotationId }, to === 'open' ? 'taken_over' : 'dismissed')
  bestEffort('score the decision', () =>
    recordDecisionScore({
      subject: 'annotation',
      subjectId: annotationId,
      decision: to === 'open' ? 'accepted' : 'dismissed',
      decidedBy: session.userId,
      organizationId: session.organizationId,
    })
  )
}

/** The delegation a mark carries, with where it lives; none when the mark is not delegated. */
const delegationOfMark = (
  session: AuthorizedSession,
  documentId: string,
  mark: Pick<AnnotationRecord, 'id' | 'delegatedAt'>
): EndedDelegation | null =>
  mark.delegatedAt
    ? { organizationId: session.organizationId, documentId, annotationId: mark.id, delegatedAt: mark.delegatedAt }
    : null

const conflict = () => new ConflictError('Somebody changed this Anmerkung a moment ago. Look again.')

/**
 * The delegation a change makes, or none. Making Piloti the delegate is a
 * person's act on an open mark, and only with the organization's switch on;
 * a mark already delegated is not delegated again, so a second click is no
 * second event. Closing a mark ends a delegation, because nobody works a
 * closed mark.
 */
function delegationOf(
  session: AuthorizedSession,
  existing: AnnotationRecord,
  parsed: { delegateToPiloti?: boolean; status?: 'open' | 'resolved' | 'dismissed' },
  actor: AnnotationActor,
  now: Date
): AnnotationChanges['delegation'] | undefined {
  const cleared = { delegatedBy: null, delegatedAt: null } as const
  const closing = parsed.status === 'resolved' || parsed.status === 'dismissed'
  if (parsed.delegateToPiloti === undefined) return closing && existing.delegatedBy ? cleared : undefined
  if (actor.kind === 'piloti') throw new ForbiddenError('Piloti cannot delegate a mark to itself.')
  if (!parsed.delegateToPiloti) return existing.delegatedBy ? cleared : undefined
  if (!wakesEnabled(session)) {
    throw new ForbiddenError('Delegating to Piloti is not switched on for this organization.', {
      reason: 'piloti-wakes-off',
    })
  }
  if ((parsed.status ?? existing.status) !== 'open') {
    throw new UnprocessableError('Only an open Anmerkung can be delegated to Piloti.', { field: 'delegateToPiloti' })
  }
  return existing.delegatedBy ? undefined : { delegatedBy: session.userId, delegatedAt: now }
}

/**
 * Change one Anmerkung: take it over, dismiss, resolve or reopen it, reword
 * it, assign it, give it a date, delegate it to Piloti or take it back.
 * Delegating wakes Piloti, enqueued in the change's transaction; nothing else
 * a change does wakes it, taking over or dismissing Piloti's mark included.
 */
export async function updateAnnotation(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  input: UpdateAnnotationRequest,
  actor: AnnotationActor = PERSON
): Promise<{ annotation: AnnotationView; wake?: WakeOutcome }> {
  const parsed = updateAnnotationRequestSchema.parse(input)
  const doc = await requireWritableDocument(session, documentId)
  const existing = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!existing) throw new NotFoundError()
  if (parsed.expectedStatus && parsed.expectedStatus !== existing.status) throw conflict()
  if (parsed.assigneeUserId) await requireAssignable(session, doc, parsed.assigneeUserId)

  const now = new Date()
  const changes: AnnotationChanges = {
    ...(parsed.kind !== undefined && { kind: parsed.kind }),
    ...(parsed.body !== undefined && { body: parsed.body }),
    ...(parsed.basis !== undefined && { basis: parsed.basis }),
    ...(parsed.assigneeUserId !== undefined && { assigneeUserId: parsed.assigneeUserId }),
    ...(parsed.dueOn !== undefined && { dueOn: parsed.dueOn }),
  }
  const moves = parsed.status !== undefined && parsed.status !== existing.status
  if (moves && parsed.status) {
    changes.transition = transition(existing.status, parsed.status, existing, session.userId, now)
  }
  const delegation = delegationOf(session, existing, { ...parsed, status: moves ? parsed.status : undefined }, actor, now)
  if (delegation) changes.delegation = delegation
  if (Object.keys(changes).length === 0) return { annotation: await viewOf(session, doc, annotationId) }

  const delegating = delegation?.delegatedBy ? delegation.delegatedAt : null
  // A change that clears the delegation ends it; delegating an already delegated mark changes nothing.
  const ended = delegation && delegation.delegatedBy === null ? delegationOfMark(session, doc.id, existing) : null
  // Piloti closing a mark in the asker's name is usually the delegation's own turn finishing: it is not stopped.
  const stopTurn = actor.kind === 'person'
  // Set in the write's transaction; a holder, because a closure's assignment is not narrowed.
  const enqueued: { wake: EnqueuedWake | null; takeBack: TakeBack | null } = { wake: null, takeBack: null }
  const updated = await updateDocumentAnnotation(
    session.organizationId,
    doc.id,
    annotationId,
    existing.status,
    changes,
    delegating || ended
      ? async (tx) => {
          if (ended) enqueued.takeBack = await readTakeBack(tx, ended, { stopTurn })
          if (!delegating) return
          enqueued.wake = await enqueueWake(tx, {
            organizationId: session.organizationId,
            documentId: doc.id,
            annotationId,
            trigger: 'assigned',
            eventId: delegationEventId(annotationId, delegating),
            actor: { userId: session.userId, email: session.email || null },
          })
        }
      : undefined
  )
  // Gone, or a colleague moved it first: say so rather than overwrite their move.
  if (!updated) throw conflict()
  announce(session, doc.id, [annotationId], 'updated', actor)
  auditHeldWake(session, doc.id, annotationId, 'assigned', enqueued.wake)
  if (ended && enqueued.takeBack) {
    const { takeBack } = enqueued
    // The queued wake is the one thing a crash here can leave behind; its job would run a turn nobody wants.
    const by = takeBackAudit(session, doc, existing, actor)
    await settleTakenBack(ended, takeBack, { stopTurn }, by).catch((error: unknown) =>
      console.warn('[annotations] could not keep a taken-back wake from starting:', error)
    )
  }
  traceChange(
    session,
    doc,
    existing,
    {
      id: annotationId,
      number: existing.number,
      body: changes.body ?? existing.body,
      assigneeUserId: changes.assigneeUserId !== undefined ? changes.assigneeUserId : existing.assigneeUserId,
      status: changes.transition?.status ?? existing.status,
    },
    actor
  )
  if (actor.kind === 'person' && moves) {
    traceMove(session, { id: doc.id, projectId: doc.projectId ?? null }, annotationId, existing, parsed.status)
  }
  const annotation = await viewOf(session, doc, annotationId)
  return delegating ? { annotation, wake: wakeOutcomeOf(enqueued.wake) } : { annotation }
}

/** Who took a mark back from Piloti, for the wakes it stops (`./take-back`). */
const takeBackAudit = (
  session: AuthorizedSession,
  doc: { projectId: string | null },
  mark: { number: number },
  actor: AnnotationActor
): TakeBackAudit => ({
  userId: session.userId,
  email: session.email || null,
  piloti: actor.kind === 'piloti',
  projectId: doc.projectId ?? null,
  markNumber: mark.number,
})

/** A wake a cap held at enqueue goes into the audit trail, after its write committed. */
function auditHeldWake(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  trigger: PilotiWakeTrigger,
  wake: EnqueuedWake | null
): void {
  if (wake?.outcome !== 'suppressed') return
  auditSuppressedWake({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email || null },
    annotationId,
    documentId,
    trigger,
    status: 'suppressed',
    reason: wake.reason,
    stage: 'enqueue',
  })
}

/**
 * Delete one Anmerkung the session set itself, or Piloti set for it
 * ({@link mayDeleteMark}). Piloti's proposals are dismissed, never deleted.
 */
export async function deleteAnnotation(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  actor: AnnotationActor = PERSON
): Promise<null> {
  const doc = await requireWritableDocument(session, documentId)
  const existing = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!existing) throw new NotFoundError()
  if (!mayDeleteMark(existing, session.userId)) {
    throw new ForbiddenError('Only the person who set an Anmerkung can delete it. Resolve or dismiss it instead.')
  }
  const ended = delegationOfMark(session, doc.id, existing)
  const stopTurn = actor.kind === 'person'
  // Set in the delete's transaction; a holder, because a closure's assignment is not narrowed.
  const found: { takeBack: TakeBack | null } = { takeBack: null }
  await deleteDocumentAnnotation(
    session.organizationId,
    doc.id,
    annotationId,
    // The mark takes its wakes with it: the running turn is read, and its stop queued, before they go.
    // A wake still queued needs nothing: its job finds the mark gone.
    ended
      ? async (tx) => {
          found.takeBack = await readTakeBack(tx, ended, { stopTurn })
        }
      : undefined
  )
  announce(session, doc.id, [annotationId], 'deleted', actor)
  if (found.takeBack) auditDeletedWithMark(found.takeBack, takeBackAudit(session, doc, existing, actor))
  bestEffort('clear the deleted mark’s rows', () =>
    onMarkDeleted({ organizationId: session.organizationId, annotationId })
  )
  return null
}

/** One Anmerkung as this session reads it; 404 when the document or the mark is not there for it. */
export async function readAnnotation(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string
): Promise<AnnotationView> {
  const doc = await getAccessibleDocument(session, documentId, 'read')
  const record = annotatable(doc) ? await findDocumentAnnotation(session.organizationId, doc.id, annotationId) : null
  if (!record) throw new NotFoundError()
  const [writable, names, wakes, work] = await Promise.all([
    mayWrite(session, doc.id),
    directoryNames(session.organizationId),
    wakeSpansFor(session.organizationId, doc.id, [record]),
    latestWakesFor(session.organizationId, doc.id, record.id),
  ])
  return toView(record, doc, session, writable, names, wakes, work)
}

/** What Piloti may change on a mark for the asker: what a person's PATCH changes, the assignee by name. */
export interface AskedChange {
  status?: 'open' | 'resolved' | 'dismissed'
  /** A name or an e-mail address as the asker said it ({@link resolveAssignee}); null clears it. */
  assignee?: string | null
  dueOn?: string | null
  kind?: AnnotationView['kind']
  body?: string
  expectedStatus?: AnnotationStatus
}

/** The fields a change can move, compared between two reads of one mark. */
const CHANGEABLE = ['status', 'assigneeUserId', 'dueOn', 'kind', 'body'] as const
export type ChangeableField = (typeof CHANGEABLE)[number]

export const changedFields = (before: AnnotationView, after: AnnotationView): ChangeableField[] =>
  CHANGEABLE.filter((field) => before[field] !== after[field])

/**
 * Piloti changes a mark because the asker asked it to, and says so in the
 * mark's thread: the change runs through {@link updateAnnotation} exactly as
 * the asker's own PATCH would (their rights, the state machine, the 409 on a
 * stale `expectedStatus`), then `note` is posted as Piloti's reply in the same
 * request, so the change and its note cannot drift apart. A change that moved
 * nothing posts nothing.
 *
 * The thread's room is checked BEFORE the change, so a full thread refuses the
 * change rather than landing it without its note. Without an `expectedStatus`
 * the status read here is the one the write compares against, so a colleague's
 * move between this read and the write is a 409 rather than overwritten.
 */
export async function updateAnnotationForAsker(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  change: AskedChange,
  note: string
): Promise<{ before: AnnotationView; after: AnnotationView; changed: ChangeableField[] }> {
  const { body: noteBody } = createReplyRequestSchema.parse({ body: note })
  const doc = await requireWritableDocument(session, documentId)
  const before = await viewOf(session, doc, annotationId)
  if (change.expectedStatus && change.expectedStatus !== before.status) throw conflict()
  if (before.replies.length >= MAX_REPLIES_PER_ANNOTATION) {
    throw new UnprocessableError(`A thread carries at most ${MAX_REPLIES_PER_ANNOTATION} replies.`)
  }
  const assigneeUserId =
    change.assignee === undefined || change.assignee === null
      ? change.assignee
      : await resolveAssignee(session, doc, change.assignee)
  const { annotation: after } = await updateAnnotation(
    session,
    doc.id,
    annotationId,
    {
      ...(change.status !== undefined && { status: change.status }),
      ...(assigneeUserId !== undefined && { assigneeUserId }),
      ...(change.dueOn !== undefined && { dueOn: change.dueOn }),
      ...(change.kind !== undefined && { kind: change.kind }),
      ...(change.body !== undefined && { body: change.body }),
      expectedStatus: change.expectedStatus ?? before.status,
    },
    PILOTI
  )
  const changed = changedFields(before, after)
  if (changed.length === 0) return { before, after, changed }
  // The note says what the change did; the change already told whoever it
  // concerns, exactly as the asker's own PATCH would, so the note tells nobody twice.
  await postReply(session, doc.id, annotationId, { body: noteBody }, PILOTI)
  return { before, after: await viewOf(session, doc, annotationId), changed }
}

/**
 * Answer in an Anmerkung's thread, as a person or as Piloti for one.
 *
 * A person's reply that addresses Piloti, or answers Piloti's own open
 * question, wakes Piloti: with the organization's switch on, the wake is
 * enqueued in the reply's transaction (`wake: 'queued'`, or `'suppressed'`
 * when a cap holds it); with it off, the response says `'off'` and the
 * browser asks Piloti itself, as before. Piloti's reply never wakes it, and
 * never hands a delegated mark back: only the delegation's own turn ending does.
 */
export async function replyToAnnotation(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  input: CreateReplyRequest,
  actor: AnnotationActor = PERSON
): Promise<{ annotation: AnnotationView; replyId: string; wake: WakeOutcome }> {
  const { doc, existing, reply, wake } = await postReply(session, documentId, annotationId, input, actor)
  bestEffort('tell the thread', () =>
    onMarkReplied({
      ...markRefOf(session, doc, existing),
      actorUserId: session.userId,
      byPiloti: actor.kind === 'piloti',
      markText: existing.body,
      mark: existing,
      replyText: reply.body,
      mayOpen: mayOpenOf(session, doc),
    })
  )
  return { annotation: await viewOf(session, doc, annotationId), replyId: reply.id, wake }
}

/** Post one reply, wake Piloti where it should, tell the room: {@link replyToAnnotation} without telling the thread. */
async function postReply(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  input: CreateReplyRequest,
  actor: AnnotationActor
): Promise<{ doc: Document; existing: AnnotationRecord; reply: DocumentAnnotationReplyRow; wake: WakeOutcome }> {
  const { body, addressesPiloti } = createReplyRequestSchema.parse(input)
  const doc = await requireWritableDocument(session, documentId)
  const existing = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!existing) throw new NotFoundError()
  const addresses = actor.kind === 'person' && Boolean(addressesPiloti)
  const trigger = replyTrigger(existing, { authorKind: actor.kind, addressesPiloti: addresses })
  const enabled = trigger !== null && wakesEnabled(session)
  const enqueued: { wake: EnqueuedWake | null } = { wake: null }
  const reply = await insertAnnotationReply(
    {
      organizationId: session.organizationId,
      annotationId,
      authorKind: actor.kind,
      body,
      createdBy: session.userId,
      addressesAgent: addresses,
    },
    enabled && trigger
      ? async (tx, row) => {
          enqueued.wake = await enqueueWake(tx, {
            organizationId: session.organizationId,
            documentId: doc.id,
            annotationId,
            trigger,
            eventId: row.id,
            actor: { userId: session.userId, email: session.email || null },
          })
        }
      : undefined
  ).catch((error: unknown) => {
    if (error instanceof ReplyLimitReachedError) {
      throw new UnprocessableError(`A thread carries at most ${MAX_REPLIES_PER_ANNOTATION} replies.`)
    }
    throw error
  })
  announce(session, doc.id, [annotationId], 'replied', actor)
  if (trigger) auditHeldWake(session, doc.id, annotationId, trigger, enqueued.wake)
  if (actor.kind === 'person') traceSettled(session, annotationId, false)
  const outcome: WakeOutcome = trigger === null ? 'none' : enabled ? wakeOutcomeOf(enqueued.wake) : 'off'
  return { doc, existing, reply, wake: outcome }
}

/**
 * Delete one reply from a thread: the person it was posted for may, whether
 * they wrote it or Piloti did in their name (`created_by` is the session the
 * reply was posted in, for both). Nobody else's thread entry vanishes under
 * them. `expectedBody` is a compare-and-swap for undo: a reply that says
 * something else now is a 409, never deleted. Tells the room, which re-reads.
 */
export async function deleteReply(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  replyId: string,
  options: { expectedBody?: string; actor?: AnnotationActor } = {}
): Promise<null> {
  const actor = options.actor ?? PERSON
  const doc = await requireWritableDocument(session, documentId)
  const existing = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  const reply = existing?.replies.find((candidate) => candidate.id === replyId)
  if (!existing || !reply) throw new NotFoundError()
  if (reply.createdBy !== session.userId) {
    throw new ForbiddenError('Only the person an answer was written for can delete it.')
  }
  if (options.expectedBody !== undefined && options.expectedBody !== reply.body) throw conflict()
  const gone = await deleteAnnotationReply(session.organizationId, annotationId, replyId, options.expectedBody)
  if (!gone) throw conflict()
  announce(session, doc.id, [annotationId], 'updated', actor)
  return null
}

/** The Anmerkungen as Piloti reads them: place as a box, without a reader's controls. */
export async function listAnnotationsForAgent(
  session: AuthorizedSession,
  documentId: string
): Promise<{ documentId: string; annotations: InternalAnnotation[] }> {
  const { annotations } = await listAnnotations(session, documentId)
  return {
    documentId,
    annotations: annotations.map((annotation) => ({
      id: annotation.id,
      number: annotation.number,
      page: annotation.page,
      shape: annotation.shape,
      box: annotationBox(annotation),
      kind: annotation.kind,
      status: annotation.status,
      authorKind: annotation.authorKind,
      body: annotation.body,
      basis: annotation.basis,
      assigneeName: annotation.assigneeName,
      dueOn: annotation.dueOn,
      onCurrentFassung: annotation.onCurrentFassung,
      createdByName: annotation.createdByName,
      createdAt: annotation.createdAt,
      replies: annotation.replies.map((reply) => ({
        authorKind: reply.authorKind,
        body: reply.body,
        createdByName: reply.createdByName,
      })),
    })),
  }
}
