/**
 * Telling people about a new Fassung (CONTEXT.md „Fassung", ADR-0054, ADR-0099).
 *
 * Two events make a document newer: a person confirms that another document
 * replaces it (`PUT /api/documents/{id}/revision-links`, `./revision-service`), or a new
 * version is published under its own name (the `upload` and `publish`
 * transitions in `./lifecycle`, and — for a person's upload, which is held until
 * its bytes are screened — the moment screening lets it through,
 * `upload-batches/settle`). Both end here, in one `document.new_revision` inbox
 * item per recipient.
 *
 * ## Who hears
 *
 * The people assigned to the OLDER document (ADR-0047) and its uploader, and
 * everyone working on one of its open marks that the new Fassung leaves behind
 * (`markParticipants`: who set it, its Zuständige, who delegated it, answered
 * or was mentioned in it), minus the person who made the change: nobody needs
 * telling about their own gesture. The row then says how many open marks to
 * check, and from which Fassung („4 offene Anmerkungen aus Fassung 2 prüfen"):
 * each is listed and not drawn on the new sheet until someone carries it on
 * („Auf aktuelle Fassung übernehmen", `lib/annotations/carry.ts`).
 * An upload batch can narrow that to the mark participants alone
 * (`revision_notice = 'marks_only'`, migration 0185): the next Fassung of an
 * E-Mail-Verlauf is news to nobody but the people with an open mark on the
 * one before, who must still hear that it left their mark behind.
 * Assignment is not access, so the list is then cut to those who may open BOTH
 * documents: project membership and the folder each is filed in, or
 * organization membership for the Büroablage. The row names the older document
 * and, for another name, the newer one, so a recipient who may not read either
 * must not receive it.
 *
 * ## A held document never notifies
 *
 * Both documents are re-read with the screened-only reader
 * (`documentVisibleTo`, ADR-0086) before anything is written. A held upload is
 * its uploader's and the reviewers' alone, and the row would carry its name and,
 * through the change summary, what it holds, to people who may not know it
 * exists. When the document passes screening later the settle hook calls again.
 *
 * ## Told once
 *
 * A Fassung is announced once (`document_revision_announcements`, migration
 * 0129). The settle hook sees the same document settle again on every re-read
 * („Erneut lesen", the folder brief's bulk re-read, a retry); without the
 * record, a person assigned since, or whose row had aged out, was told about the
 * same Fassung again. A recipient who still holds the item is skipped too, not
 * folded, so a read item is never marked unread.
 *
 * ## Piloti notices it
 *
 * A Fassung under another name, claimed here, also queues Piloti's notice of
 * it (`lib/revision-notice`, ADR-0130): a comparison with the older one whose
 * changes are proposed as marks. Only where the office switched it on.
 *
 * ## It never fails its caller
 *
 * {@link announceNewRevision} is detached and logs. The link is stored and the
 * version is published whether or not anyone could be told.
 */

import 'server-only'
import { markParticipants } from '@/lib/annotations/attention'
import { queueRevisionNotice } from '@/lib/revision-notice/queue'
import { documentCheckMaxBatch } from '@/lib/document-check/check'
import { queueDocumentCheck } from '@/lib/document-check/queue'
import { listDocumentAnnotations, type AnnotationRecord } from '@/lib/annotations/repository'
import { listAssignmentsForResources } from '@/lib/assignments/repository'
import { DEFAULT_UPLOAD_BATCH_EFFECTS, type Document, type UploadBatchRevisionNotice } from '@/lib/db/schema'
import { findBatchSettleEffects, type BatchSettleEffects } from '@/lib/upload-batches/repository'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { recipientsHoldingGroup } from '@/lib/inbox/repository'
import { emitInboxItems } from '@/lib/inbox/service'
import { collectionFileRef } from './collection-file-ref'
import { SCREENED_ONLY } from './document-reader'
import { documentDisplayName, splitDocumentName, type NamedDocument } from './display-name'
import { claimRevisionAnnouncement, releaseRevisionAnnouncement } from './revision-announcement-repository'
import type { RevisionLinkNames } from './revision-links'
import { mayOpenDocument } from './may-open'
import { documentNameKey } from './name-match'
import { readRevisionLinkNames, refreshCollectionFiles } from './reconcile-status'
import { findDocumentInOrg, findRevisionCounterparts } from './repository'
import { findPreviousVersion, findPublishedVersion } from './version-repository'

/** The longest first line of a change summary the row carries. */
const SUMMARY_LINE_MAX = 200

/** The most documents one settle looks at; the rest are caught by the next read. */
const SETTLE_LOOKUP_LIMIT = 50

export interface NewRevisionAnnouncement {
  organizationId: string
  /** Whoever made the change. Never told. `null` when no person did. */
  actorUserId: string | null
  /** The document that is new: where the row opens. */
  newerId: string
  /** The document that was followed. The same id as `newerId` for a same-name version. */
  olderId: string
  /**
   * The new version, for a same-name Fassung. It anchors the item, so two
   * versions of one document are two rows. Absent for a confirmed link, which
   * anchors on the older document.
   */
  versionId?: string | null
  /** People who uploaded the bytes that were replaced, beside the older document's own uploader. */
  previousUploaderIds?: readonly (string | null | undefined)[]
  /** The change summary Piloti wrote, when there is one; only its first line is sent. */
  changeSummary?: string | null
  /**
   * Who is told: `all` (the default) or `marks_only`, the people working on an
   * open mark the new Fassung leaves behind and nobody else. Set from the
   * upload batch that brought the newer document (migration 0185).
   */
  audience?: UploadBatchRevisionNotice
}

/**
 * The first line of a change summary that says something, without list or
 * heading markers. Null for nothing to say.
 */
export function firstSummaryLine(summary: string | null | undefined): string | null {
  for (const raw of (summary ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, '').trim()
    if (line) return line.length > SUMMARY_LINE_MAX ? `${line.slice(0, SUMMARY_LINE_MAX - 1).trimEnd()}…` : line
  }
  return null
}

/**
 * A document's name as the row says it: the name people see, without the
 * file's extension. „Grundriss EG Index B.pdf" in a sentence reads as a file,
 * and the row is about a document. Only the extension of the stored FILE name
 * is taken off, so a label such as „Stand 14.08.2026" keeps its digits.
 */
function nameWithoutExtension(document: NamedDocument): string {
  const name = documentDisplayName(document)
  const { extension } = splitDocumentName(document.filename)
  if (extension === '' || !name.toLowerCase().endsWith(extension.toLowerCase())) return name
  const stem = name.slice(0, -extension.length).trimEnd()
  return stem === '' ? name : stem
}

/**
 * The names the row carries: the document followed and, for another name, the
 * newer one. Without extensions, unless the two names would then read the same
 * („Grundriss.pdf" replaced by „Grundriss.dwg"), where the extension is the
 * only thing telling them apart. Pure.
 */
export function revisionRowNames(follow: NamedDocument, newer: NamedDocument | null): { subject: string; related?: string } {
  if (!newer) return { subject: nameWithoutExtension(follow) }
  const subject = nameWithoutExtension(follow)
  const related = nameWithoutExtension(newer)
  if (subject.toLowerCase() === related.toLowerCase()) {
    return { subject: documentDisplayName(follow), related: documentDisplayName(newer) }
  }
  return { subject, related }
}

/**
 * The people a new Fassung is announced to, before anyone's access is asked:
 * the older document's assignees and uploaders, once each, minus the actor.
 * `marks_only` drops the assignees and uploaders. Pure, so the rule is
 * testable without a database.
 */
export function revisionRecipients(input: {
  assigneeIds: readonly string[]
  uploaderIds: readonly (string | null | undefined)[]
  /** The people working on the open marks the new Fassung leaves behind. */
  participantIds?: readonly string[]
  actorUserId: string | null
  /** `marks_only` keeps the mark participants alone. */
  audience?: UploadBatchRevisionNotice
}): string[] {
  const followers = input.audience === 'marks_only' ? [] : [...input.assigneeIds, ...input.uploaderIds]
  const everyone = [...followers, ...(input.participantIds ?? [])]
  return [...new Set(everyone.filter((id): id is string => Boolean(id) && id !== input.actorUserId))]
}

/**
 * What the row says about the open marks the new Fassung leaves behind: how
 * many, and from which Fassung when they all sit on one numbered Fassung of
 * the same document. Its `variant` picks the words (one or several, a Fassung
 * named or „the previous one"); nothing when there are none. Pure.
 */
export function openMarksFacts(
  marks: ReadonlyArray<Pick<AnnotationRecord, 'revisionNumber'>>,
  { sameDocument }: { sameDocument: boolean }
): { variant: string; openMarks: number; marksRevision: number | null } | null {
  if (marks.length === 0) return null
  const numbers = new Set(marks.map((mark) => mark.revisionNumber))
  const [only] = [...numbers]
  // Another document's own Fassung numbers count its states, not this timeline's.
  const marksRevision = sameDocument && numbers.size === 1 && typeof only === 'number' ? only : null
  const variant = `${marks.length === 1 ? 'mark' : 'marks'}${marksRevision === null ? '_earlier' : ''}`
  return { variant, openMarks: marks.length, marksRevision }
}

/**
 * The open marks of the followed document that the new Fassung does not carry:
 * for a same-name version every open mark set on another version, for a
 * document another one replaced every open mark it has. Keyed by a document
 * read with the screened-only reader above. Bounded by the list read.
 */
async function marksLeftBehind(
  organizationId: string,
  follow: Document,
  versionId: string | null | undefined
): Promise<AnnotationRecord[]> {
  if (follow.scope !== 'project' && follow.scope !== 'office_shelf') return []
  const marks = await listDocumentAnnotations(organizationId, follow.id)
  return marks.filter((mark) => mark.status === 'open' && (!versionId || (mark.versionId ?? null) !== versionId))
}

/**
 * Write the items. Returns how many people were told.
 *
 * Once per Fassung: the newer document and its anchor are claimed
 * (`document_revision_announcements`) before anything is written, and a Fassung
 * claimed before is not announced again. The claim is taken only once both
 * documents are screened, so a held upload announces when it passes; a failed
 * announcement gives it back, so the next settle tries again.
 *
 * Throws on a failed read or write; callers that must not fail use
 * {@link announceNewRevision}.
 */
export async function notifyNewRevision(announcement: NewRevisionAnnouncement): Promise<number> {
  const { organizationId, newerId, olderId } = announcement
  const sameDocument = newerId === olderId
  const [newer, older] = await Promise.all([
    findDocumentInOrg(newerId, organizationId, SCREENED_ONLY),
    sameDocument ? null : findDocumentInOrg(olderId, organizationId, SCREENED_ONLY),
  ])
  const follow = sameDocument ? newer : older
  // Held, gone or not in this organization: nothing is said about it.
  if (!newer || !follow) return 0
  if (newer.lifecycle !== 'active' || newer.scope === 'session' || follow.scope === 'session') return 0

  const claim = { organizationId, documentId: newer.id, anchorId: announcement.versionId ?? follow.id }
  if (!(await claimRevisionAnnouncement(claim))) return 0
  // Piloti checks a Fassung under another name against the one it replaces
  // (ADR-0130), where the office switched it on. Once per claim, detached, never failing this.
  if (!sameDocument) {
    void queueRevisionNotice({ organizationId, actorUserId: announcement.actorUserId, newerId: newer.id, olderId: follow.id })
  }
  try {
    return await writeRevisionItems(announcement, newer, follow, claim.anchorId)
  } catch (error) {
    await releaseRevisionAnnouncement(claim).catch(() => undefined)
    throw error
  }
}

/** The items of one claimed announcement: who may open both documents, and has not been told. */
async function writeRevisionItems(
  announcement: NewRevisionAnnouncement,
  newer: Document,
  follow: Document,
  anchorId: string,
): Promise<number> {
  const { organizationId } = announcement
  const sameDocument = newer.id === follow.id
  const marksOnly = announcement.audience === 'marks_only'
  const [assignments, marks] = await Promise.all([
    marksOnly ? [] : listAssignmentsForResources(organizationId, 'document', [follow.id]),
    marksLeftBehind(organizationId, follow, sameDocument ? (announcement.versionId ?? newer.publishedVersionId) : null),
  ])
  const candidates = revisionRecipients({
    assigneeIds: assignments.map((row) => row.subjectUserId),
    uploaderIds: [follow.createdBy, ...(announcement.previousUploaderIds ?? [])],
    participantIds: marks.flatMap((mark) => markParticipants(mark)),
    actorUserId: announcement.actorUserId,
    audience: announcement.audience,
  })
  if (candidates.length === 0) return 0

  const mayOpenNewer = await mayOpenDocument({ organizationId }, newer, candidates)
  const mayOpenBoth = sameDocument
    ? mayOpenNewer
    : await mayOpenDocument({ organizationId }, follow, [...mayOpenNewer])
  if (mayOpenBoth.size === 0) return 0

  const groupKey = inboxGroupKey('document.new_revision', 'document', newer.id, anchorId)
  const already = await recipientsHoldingGroup(organizationId, groupKey, [...mayOpenBoth])
  const told = [...mayOpenBoth].filter((userId) => !already.has(userId))
  if (told.length === 0) return 0

  const excerpt = firstSummaryLine(announcement.changeSummary)
  const openMarks = openMarksFacts(marks, { sameDocument })
  await emitInboxItems(
    told.map((recipientUserId) => ({
      organizationId,
      recipientUserId,
      type: 'document.new_revision' as const,
      resourceType: 'document' as const,
      resourceId: newer.id,
      anchorId,
      actorUserId: announcement.actorUserId,
      groupKey,
      // A second name only when there is one: a same-name version is the
      // same document, and the title reads without it. Who made the change is
      // `actorUserId`, resolved to a name when the inbox is read.
      payload: {
        ...revisionRowNames(follow, sameDocument ? null : newer),
        ...(excerpt ? { excerpt } : {}),
        ...(openMarks ?? {}),
      },
    })),
  )
  return told.length
}

/**
 * {@link notifyNewRevision}, detached: the caller carries on at once and a
 * failure is logged, never raised. The one call a confirmed link, a published
 * version and a settled upload make.
 */
export function announceNewRevision(announcement: NewRevisionAnnouncement): Promise<void> {
  return notifyNewRevision(announcement).then(
    () => undefined,
    (error: unknown) => {
      console.warn(`[revision-notify] could not announce the new Fassung of ${announcement.olderId}:`, error)
    },
  )
}

/**
 * The change line, when it was written against the file named `olderName`. A
 * line against no basis is about the earlier upload under the document's own
 * name, and one against another name describes another comparison: neither is
 * what this notification is about, and the second may say what a document the
 * recipient may not open held.
 */
function changeAgainstName(change: RevisionLinkNames['change'], olderName: string): string | null {
  if (!change || change.basis === null) return null
  return documentNameKey(change.basis) === documentNameKey(olderName) ? change.text : null
}

/** The same-name half: a published version that is not the document's first. */
async function announceSettledVersion(
  organizationId: string,
  document: Document,
  audience: UploadBatchRevisionNotice,
): Promise<void> {
  const version = await findPublishedVersion(document.id, organizationId)
  if (!version || version.versionNumber < 2) return
  const previous = await findPreviousVersion(document.id, organizationId, version.versionNumber)
  await announceNewRevision({
    organizationId,
    actorUserId: version.createdBy,
    newerId: document.id,
    olderId: document.id,
    versionId: version.id,
    previousUploaderIds: [previous?.createdBy],
    audience,
  })
}

/**
 * The cross-name half: the older documents the backend lists as replaced by
 * this one. A link written at ingestion (the upload dialog's confirmation, a
 * Fassung Piloti read from the title block) exists before the job finishes, so
 * the moment the document is readable is the first moment anyone can be told.
 * Names resolve to screened documents of the SAME collection; who may open
 * which is cut by {@link notifyNewRevision}.
 */
async function announceSettledLinks(
  organizationId: string,
  document: Document,
  audience: UploadBatchRevisionNotice,
): Promise<void> {
  const ref = collectionFileRef(document)
  const names = ref ? await readRevisionLinkNames(ref) : null
  if (!names || names.supersedes.length === 0) return
  const olders = await findRevisionCounterparts(organizationId, document.collectionName, names.supersedes, SCREENED_ONLY)
  for (const older of olders) {
    if (older.id === document.id) continue
    await announceNewRevision({
      organizationId,
      actorUserId: document.createdBy,
      newerId: document.id,
      olderId: older.id,
      changeSummary: changeAgainstName(names.change, older.filename),
      audience,
    })
  }
}

/**
 * Piloti checks a document that just came to rest against the project's
 * others (ADR-0130), where the office switched it on: a FIRST upload as much as
 * a Fassung. A project document only, once per published version, as the person
 * who uploaded it; `queueDocumentCheck` never throws.
 */
async function queueSettledDocumentCheck(organizationId: string, document: Document): Promise<void> {
  if (document.scope !== 'project' || !document.projectId || document.lifecycle !== 'active') return
  const version = await findPublishedVersion(document.id, organizationId).catch(() => null)
  await queueDocumentCheck({
    organizationId,
    actorUserId: document.createdBy,
    documentId: document.id,
    versionId: version?.id ?? null,
  })
}

/**
 * Announce the Fassungen among documents that just came to rest.
 *
 * A person's upload is held until its bytes are screened, so the `upload`
 * transition cannot tell anyone: the document it replaces is not yet readable
 * by them. This is the other half, called by the settle hook (which never
 * throws): for each document that is screened now, the people who followed
 * what it replaces are told, whether it replaced a version under its own name
 * or an older document under another (a link already written at ingestion).
 * A Piloti document (its publish transition announces it) says nothing, and
 * neither does a Fassung announced before: a re-read settles the document
 * again, and {@link notifyNewRevision} announces each Fassung once.
 *
 * Who is told, and whether Piloti checks it, is the batch's (migration 0185):
 * a document whose batch says `revision_notice = 'marks_only'` reaches the
 * people on its open marks alone, and one whose batch has
 * `runs_document_check` off is not checked (the next Fassung of an
 * E-Mail-Verlauf is no drawing to check). A document carries the batch of its
 * newest upload, which is the upload whose Fassung settles here.
 *
 * Bounded by {@link SETTLE_LOOKUP_LIMIT}. The collection listings are read
 * fresh once per collection, because the cached one may predate the link.
 */
export async function announceSettledVersions(organizationId: string, documentIds: readonly string[]): Promise<void> {
  const settled: Document[] = []
  for (const documentId of documentIds.slice(0, SETTLE_LOOKUP_LIMIT)) {
    const document = await findDocumentInOrg(documentId, organizationId, SCREENED_ONLY)
    if (document && document.authoredBy === 'user' && document.scope !== 'session') settled.push(document)
  }
  const collections = new Set(settled.filter((document) => collectionFileRef(document)).map((d) => d.collectionName))
  await Promise.all([...collections].map((collection) => refreshCollectionFiles(collection).catch(() => undefined)))
  const effectsOf = await settleEffectsOf(organizationId, settled)
  // A bulk import is not checked file by file: that is not what a colleague does.
  const checkBatch = settled.length <= documentCheckMaxBatch()
  for (const document of settled) {
    const effects = effectsOf(document)
    await announceSettledVersion(organizationId, document, effects.revisionNotice)
    await announceSettledLinks(organizationId, document, effects.revisionNotice)
    if (checkBatch && effects.runsDocumentCheck) await queueSettledDocumentCheck(organizationId, document)
  }
}

/**
 * The batch effects each document settles under, a person's upload's where it
 * carries no batch or its batch is not found; no batch is asked when no
 * document carries one.
 */
async function settleEffectsOf(
  organizationId: string,
  documents: readonly Document[]
): Promise<(document: Document) => BatchSettleEffects> {
  const batchIds = new Set(documents.flatMap((document) => (document.uploadBatchId ? [document.uploadBatchId] : [])))
  const byBatch = batchIds.size === 0 ? new Map<string, BatchSettleEffects>() : await findBatchSettleEffects(organizationId, [...batchIds])
  return (document) => (document.uploadBatchId && byBatch.get(document.uploadBatchId)) || DEFAULT_UPLOAD_BATCH_EFFECTS
}
