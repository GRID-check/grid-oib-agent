import 'server-only'
/**
 * Filing a mail's text into its E-Mail-Verlauf (ADR-0134, DECISION §6 "File",
 * D11, D12, D36): one new entry, and the thread document's next Fassung, which
 * holds every section of the last one and the new message's.
 *
 * Called by the filing job (`lib/inbound-mail/file-job.ts`) as the person who
 * decided, and by the follow job (D10) as the follower; the archive import
 * renders through `./render.ts` itself (D11). What it guarantees:
 *
 * 1. **One writer per thread at a time.** The thread's render lease
 *    (`mail_threads.render_lease_*`) is taken before the entries are read and
 *    let go after the Fassung is recorded: two filings rendering side by side
 *    could upload the smaller set last and drop the other's section, which the
 *    superset invariant forbids. Another writer holding it answers `busy`; the
 *    job tries again shortly, without spending an attempt.
 * 2. **Fassung N+1 is a superset of N** (`./render.ts`). The new entry's
 *    heading is made against the thread's headings once and stored; what came
 *    with it is decided once ({@link sectionAttachment}) and frozen on its
 *    rows (D36); every entry's JSON is parsed through the wire schemas, and a
 *    row that does not parse fails the filing rather than rendering text it
 *    did not mean.
 * 3. **Retry-safe.** The entry's id and the new thread's id are the
 *    decision's (uuid5), its filing time is the decision's, so a retry renders
 *    the same bytes: an upload whose answer was lost is found by its digest and
 *    not uploaded again, and the commit of an entry already recorded changes
 *    nothing. The entry, its Message-IDs, what came with it and the part's
 *    `filed` commit in one transaction, after the upload: DELETE is revoked on
 *    the entries, so nothing is written that a refused upload would have to
 *    take back.
 * 4. **Filed as the person, quietly.** The Fassung is uploaded through the
 *    ordinary upload path in their session (`uploadDocument`): their folder
 *    rights, the Namensprüfung, the Inhaltsprüfung, quota and the office's
 *    types apply. It goes into a quiet batch (D35's append row,
 *    `INBOUND_THREAD_APPEND_EFFECTS`), with `documentType: 'correspondence'`
 *    and the thread's ingest facts (`mail_thread`), both kept with the filing
 *    choice so a held Verlauf's release keeps them.
 * 5. **The original is evidence.** The commit marks the mail's raw message as
 *    moving; {@link finishOriginalMove} (`./originals.ts`) moves it to the
 *    entry's own key.
 *
 * Every refusal of the upload path maps to a typed failure the part waits
 * again with (`INBOUND_MAIL_FILING_FAILURES`); anything else throws for the
 * job's queue to retry.
 */

import { v5 as uuidv5 } from 'uuid'
import {
  ApiError,
  BadRequestError,
  ConflictError,
  FileTooLargeError,
  ForbiddenError,
  InsufficientStorageError,
  NotFoundError,
} from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { AccessFolder } from '@/lib/authz/folder-access-rule'
import type {
  InboundMailDecisionRow,
  InboundMailPartRow,
  InboundMailRow,
  MailThreadEntryAttachmentRow,
  MailThreadEntryRow,
  NewMailThreadEntryAttachmentRow,
  NewMailThreadEntryRow,
} from '@/lib/db/schema'
import { contentDigest } from '@/lib/documents/content-digest'
import { memberReader } from '@/lib/documents/document-reader'
import { documentNameKey } from '@/lib/documents/name-match'
import { uploadDocument } from '@/lib/documents/service'
import { THREAD_DOCUMENT_TYPE } from '@/lib/inbound-mail/decision'
import type {
  InboundMailFilingFailure,
  InboundMailNotStaged,
  NotStagedReason,
} from '@/lib/inbound-mail/inbound-mail-vocabulary'
import type { MailRead } from '@/lib/inbound-mail/read-client'
import { findDocumentIdByStoredName, findLiveFolders } from '@/lib/inbound-mail/repository'
import { ensureProjectFolderPaths } from '@/lib/projects/folder-service'
import { isProjectClosedError } from '@/lib/projects/project-status'
import { findSpans, maskText, type ContentScreenRules } from '@/lib/upload-screening/content-screen'
import { ScreenedUploadError } from '@/lib/upload-screening/service'
import { mailThreadIngestFacts, type MailThreadIngestFacts } from './ingest-facts'
import { clampSentAt, domainOf } from './mail-threading'
import {
  mailThreadCalendarEventSchema,
  mailThreadMaskedSpanSchema,
  mailThreadParticipantSchema,
  mailThreadQuoteSchema,
  type MailThreadAttachmentNotFiledReason,
  type MailThreadCalendarEvent,
  type MailThreadMaskedSpan,
  type MailThreadQuote,
  type MailThreadSectionAttachment,
} from './mail-thread-wire'
import {
  MAIL_THREAD_ENTRY_MAX_TEXT_BYTES,
  MAIL_THREAD_MAX_ENTRIES,
  MAIL_THREAD_MAX_RENDERED_BYTES,
  type MailThreadLocale,
} from './mail-thread-vocabulary'
import {
  mailThreadEntryHeading,
  renderMailThread,
  sectionAttachment,
  type MailThreadRenderEntry,
} from './render'
import {
  acquireRenderLease,
  commitAppend,
  findCurrentVersions,
  findEntryAttachmentRows,
  findThreadEntryRows,
  findWritableThread,
  releaseRenderLease,
  type WritableThread,
} from './write-repository'

/** How long a writer holds a thread's render lease: the part claim's own five minutes. */
export const RENDER_LEASE_MS = 5 * 60 * 1000

/** When a writer that found the lease taken tries again. */
export const RENDER_LEASE_RETRY_MS = 15 * 1000

/** The namespace the ids a decision gives an entry and a new thread are derived in. Fixed: changing it breaks retries. */
const APPEND_NAMESPACE = '3f0b8d6e-5c2a-4e7b-9a14-6d2e8c0f1b73'

/** The entry a `file` decision about a mail's text becomes: the same id on every retry. */
export const entryIdOf = (decisionId: string): string =>
  uuidv5(`entry:${decisionId}`, APPEND_NAMESPACE)

/** The thread a `create` decision starts: the same id on every retry. */
export const newThreadIdOf = (decisionId: string): string =>
  uuidv5(`thread:${decisionId}`, APPEND_NAMESPACE)

/** The file name of a thread document: the name a person gave it, as Markdown. */
export function threadDocumentFilename(name: string): string {
  const clean = documentNameKey(name)
  return /\.md$/i.test(clean) ? clean : `${clean}.md`
}

/** A thread document's title, as its rendition's first line prints it: the name without `.md`. */
export function threadTitleOf(filename: string): string {
  return filename.replace(/\.md$/i, '')
}

// ---------------------------------------------------------------------------
// Who may see where an attachment went (RT-S13)
// ---------------------------------------------------------------------------

/** The folders at or above `folderId` whose own list narrows who READS it (ADR-0088). */
export function readRestrictionsAt(
  tree: ReadonlyMap<string, AccessFolder>,
  folderId: string | null
): Set<string> {
  const found = new Set<string>()
  const seen = new Set<string>()
  for (let current = folderId ? tree.get(folderId) : undefined; current && !seen.has(current.id);) {
    seen.add(current.id)
    if (current.accessMode === 'custom' && !current.everyoneReads) found.add(current.id)
    current = current.parentId ? tree.get(current.parentId) : undefined
  }
  return found
}

/**
 * Whether everyone who may read the thread document may read a document in
 * `folderId`: every list that narrows the attachment's folder narrows the
 * thread's too. A folder that is gone answers no: nothing is named on a guess.
 */
export function readableWithThread(
  tree: ReadonlyMap<string, AccessFolder>,
  folderId: string | null,
  threadFolderId: string | null
): boolean {
  if (folderId && !tree.has(folderId)) return false
  const thread = readRestrictionsAt(tree, threadFolderId)
  return [...readRestrictionsAt(tree, folderId)].every((id) => thread.has(id))
}

// ---------------------------------------------------------------------------
// What came with the message (D36)
// ---------------------------------------------------------------------------

/** One attachment part as the entry records it: the part, its decision, and the document it is now. */
export interface AttachmentFact {
  part: InboundMailPartRow
  decision: InboundMailDecisionRow | null
  /** The document the part was filed as, as the filer may read it now; null when it is not one, or gone. */
  document: {
    id: string
    versionId: string | null
    versionCreatedAt: Date | null
    folderId: string | null
  } | null
}

/** The never-staged files a mail carried that somebody sent (a layout image, a signature, a TNEF box or an invitation is not one). */
const SENT_FILE_REASONS: ReadonlySet<NotStagedReason> = new Set([
  'encrypted',
  'archive',
  'size',
  'limit',
  'empty',
])

/** Why a part that is no document was not filed. */
function notFiledReasonOf(part: InboundMailPartRow): MailThreadAttachmentNotFiledReason {
  if (part.state === 'waiting' || part.state === 'filing') return 'pending'
  if (part.riskFlags.includes('type_not_accepted')) return 'type_not_accepted'
  if (part.scanStatus === 'infected') return 'infected'
  if (part.scanStatus !== 'clean') return 'scan_failed'
  return part.state === 'expired' ? 'expired' : 'dismissed'
}

const cut = (value: string | null, max: number): string | null =>
  value ? value.slice(0, max) : null

/**
 * One row per attachment of the mail, whatever became of it (D36), with what
 * the thread's section prints for it frozen in ({@link sectionAttachment}).
 * Pure. A Fassung that was the document's before this mail arrived is
 * `already_present`: the upload found the same bytes. A dismissed duplicate of
 * a project document is `already_present` as that document, never named.
 */
export function attachmentRowsOf(input: {
  entryId: string
  organizationId: string
  projectId: string
  receivedAt: Date
  facts: readonly AttachmentFact[]
  notStaged: readonly InboundMailNotStaged[]
  /** Whether a document in this folder is readable by everyone who reads the thread. */
  visibleWithThread: (folderId: string | null) => boolean
}): NewMailThreadEntryAttachmentRow[] {
  const base = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    entryId: input.entryId,
  }
  const rows: NewMailThreadEntryAttachmentRow[] = []
  for (const { part, decision, document } of input.facts) {
    const filename = cut(
      part.filename ?? (decision?.fileName ? documentNameKey(decision.fileName) : null),
      500
    )
    if (part.state === 'filed') {
      const present = Boolean(
        document?.versionCreatedAt && document.versionCreatedAt < input.receivedAt
      )
      const disposition = present ? 'already_present' : 'filed'
      const section = sectionAttachment({
        disposition,
        name: decision?.fileName ? documentNameKey(decision.fileName) : null,
        folderPath: decision?.folderPath ?? null,
        visibleWithThread: document !== null && input.visibleWithThread(document.folderId),
        nameReleased: decision?.screeningRelease ?? false,
      })
      rows.push({
        ...base,
        position: part.position,
        filename,
        disposition,
        notFiledReason: null,
        documentId: part.documentId,
        documentVersionId: part.documentId ? part.documentVersionId : null,
        sectionName: section.name,
        sectionFolderPath: section.folderPath,
      })
      continue
    }
    if (
      part.duplicateOfDocumentId &&
      (part.state === 'dismissed' || part.state === 'expired') &&
      document
    ) {
      rows.push({
        ...base,
        position: part.position,
        filename,
        disposition: 'already_present',
        notFiledReason: null,
        documentId: document.id,
        documentVersionId: document.versionId,
        sectionName: null,
        sectionFolderPath: null,
      })
      continue
    }
    rows.push({
      ...base,
      position: part.position,
      filename,
      disposition: 'not_filed',
      notFiledReason: notFiledReasonOf(part),
    })
  }
  let next = Math.max(0, ...input.facts.map((fact) => fact.part.position)) + 1
  for (const item of input.notStaged) {
    if (!SENT_FILE_REASONS.has(item.reason)) continue
    rows.push({
      ...base,
      position: next++,
      filename: cut(item.filename || null, 500),
      disposition: 'not_filed',
      notFiledReason: item.reason as MailThreadAttachmentNotFiledReason,
    })
  }
  return rows
}

/** What a section prints for a stored attachment row. */
export const sectionLineOf = (
  row: Pick<MailThreadEntryAttachmentRow, 'sectionName' | 'sectionFolderPath'>
): MailThreadSectionAttachment => ({
  name: row.sectionName,
  folderPath: row.sectionFolderPath,
})

// ---------------------------------------------------------------------------
// The entry
// ---------------------------------------------------------------------------

/** `text`, cut to at most `maxBytes` of UTF-8 without splitting a character. */
export function cutToBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return text
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/�$/, '')
}

/** A reader's calendar event in the entry's shape: times in UTC, nothing the renderer does not print. */
function calendarEventOf(event: MailRead['calendar'][number]): MailThreadCalendarEvent {
  const utc = (value: string | null) => {
    if (!value) return null
    const at = new Date(value)
    return Number.isNaN(at.getTime()) ? null : at.toISOString()
  }
  return {
    method: cut(event.method, 40),
    summary: cut(event.summary, 500),
    start: utc(event.start),
    end: utc(event.end),
    allDay: event.allDay,
    location: cut(event.location, 500),
    status: cut(event.status, 40),
  }
}

/** The person's choice of form (D13): masked where the office's content check finds something, or the text as sent. */
export interface MessageForm {
  masked: boolean
  /** The office's content rules for prose; null when the screening is off (nothing is masked then). */
  rules: ContentScreenRules | null
}

/**
 * The entry a held mail's text becomes, before the commit gives it its first
 * Fassung. Pure. The own text is cut to the entry's bound (the rest is in the
 * original); masking keeps the text and records the spans, so the section
 * prints placeholders while the entry keeps what was sent; a quote is stored
 * masked, since it has no spans of its own. A quote's header line is not kept:
 * it names people by their addresses, and the section labels a quote by the
 * message that kept it.
 */
export function inboundEntryOf(input: {
  id: string
  threadId: string
  mail: InboundMailRow
  read: MailRead
  decision: InboundMailDecisionRow
  heading: string
  inReplyToEntryId: string | null
  form: MessageForm
}): NewMailThreadEntryRow {
  const { mail, read, decision, form } = input
  const ownText = cutToBytes(read.ownText, MAIL_THREAD_ENTRY_MAX_TEXT_BYTES)
  const spans: MailThreadMaskedSpan[] | null =
    form.masked && form.rules
      ? findSpans(ownText, form.rules).map(({ kind, start, end }) => ({ kind, start, end }))
      : null
  const quoted: MailThreadQuote[] = read.quoted.map((quote) => ({
    text: form.masked && form.rules ? maskText(quote.text, form.rules).text : quote.text,
  }))
  return {
    id: input.id,
    organizationId: mail.organizationId,
    projectId: mail.projectId,
    threadId: input.threadId,
    source: 'inbound',
    inboundMailId: mail.id,
    messageId: mail.messageId,
    sentAt: mail.sentAt ?? mail.receivedAt,
    receivedAt: mail.receivedAt,
    heading: input.heading,
    inReplyToEntryId: input.inReplyToEntryId,
    senderAddress: cut(mail.senderAddress, 320),
    senderName: cut(mail.senderName, 300),
    senderDomain: domainOf(mail.senderAddress),
    signerDomain: mail.signerDomain,
    senderTrust: mail.senderTrust ?? 'external_unverified',
    authenticationResults: mail.authenticationResults,
    participants: mail.participants
      .slice(0, 50)
      .map((participant) => ({ ...participant, name: cut(participant.name, 300) })),
    ownText,
    maskedSpans: spans && spans.length > 0 ? spans : null,
    quoted,
    calendar: read.calendar.map(calendarEventOf),
    firstVersionId: null,
    filedBy: decision.decidedBy,
    filedVia: decision.via,
    // The decision's time, not the run's: a retry renders the same bytes.
    filedAt: decision.decidedAt,
  }
}

/** The entry an answer `inReplyTo` names, among the thread's: the latest filed of them. */
export function answeredEntryOf(
  entries: ReadonlyArray<Pick<MailThreadEntryRow, 'id' | 'messageId' | 'filedAt'>>,
  inReplyTo: readonly string[]
): string | null {
  const wanted = new Set(inReplyTo)
  const answered = entries.filter((entry) => entry.messageId && wanted.has(entry.messageId))
  answered.sort((a, b) => new Date(b.filedAt).getTime() - new Date(a.filedAt).getTime())
  return answered[0]?.id ?? null
}

/** A row parsed through the wire schemas into the renderer's input. Throws on a row that does not parse (a bug, never input). */
export function renderEntryOf(
  row: NewMailThreadEntryRow | MailThreadEntryRow,
  attachments: readonly MailThreadSectionAttachment[]
): MailThreadRenderEntry {
  return {
    id: row.id!,
    heading: row.heading,
    source: row.source,
    sentAt: new Date(row.sentAt),
    receivedAt: new Date(row.receivedAt),
    filedAt: new Date(row.filedAt ?? 0),
    senderName: row.senderName ?? null,
    senderAddress: row.senderAddress ?? null,
    senderDomain: row.senderDomain ?? null,
    signerDomain: row.signerDomain ?? null,
    senderTrust: row.senderTrust,
    inReplyToEntryId: row.inReplyToEntryId ?? null,
    participants: mailThreadParticipantSchema
      .array()
      .max(50)
      .parse(row.participants ?? []),
    ownText: row.ownText ?? '',
    maskedSpans: row.maskedSpans
      ? mailThreadMaskedSpanSchema.array().max(1000).parse(row.maskedSpans)
      : null,
    quoted: mailThreadQuoteSchema
      .array()
      .max(50)
      .parse(row.quoted ?? []),
    calendar: mailThreadCalendarEventSchema
      .array()
      .max(20)
      .parse(row.calendar ?? []),
    attachments,
  }
}

/** The renderer's input for every entry of a thread, what came with each read from its rows. */
export async function renderEntriesOf(
  rows: readonly MailThreadEntryRow[]
): Promise<MailThreadRenderEntry[]> {
  const attachments = await findEntryAttachmentRows(rows.map((row) => row.id))
  return rows.map((row) => renderEntryOf(row, (attachments.get(row.id) ?? []).map(sectionLineOf)))
}

// ---------------------------------------------------------------------------
// A Fassung
// ---------------------------------------------------------------------------

/** One Fassung of a thread document to upload. */
export interface ThreadVersionUpload {
  session: AuthorizedSession
  projectId: string
  folderId: string | null
  filename: string
  markdown: string
  facts: MailThreadIngestFacts
  /** The thread's document, when there is one: same bytes already its newest Fassung is a retry, not a new Fassung. */
  current: WritableThread['document'] | null
  /** A new thread under a name the Namensprüfung stopped, which the person released. */
  screeningRelease: boolean
  uploadBatchId: string | null
  request: Request
}

export type ThreadVersionResult =
  | { ok: true; documentId: string; versionId: string | null }
  | { ok: false; failure: InboundMailFilingFailure }

/**
 * Upload one Fassung as the person: the same name in the same folder, so the
 * thread document gets its next version, or a new document. Bytes the document
 * already holds are not uploaded again (a retry). A new thread's name another
 * document holds is `name_taken`, never that document's next version: the
 * upload path would replace it.
 */
export async function uploadThreadVersion(upload: ThreadVersionUpload): Promise<ThreadVersionResult> {
  const bytes = Buffer.from(upload.markdown, 'utf8')
  const digest = contentDigest(bytes)
  const reader = memberReader(upload.session.userId)
  const documentId = upload.current?.id ?? null
  if (!documentId) {
    const holder = await findDocumentIdByStoredName(upload.projectId, upload.filename)
    if (holder) {
      const held = (await findCurrentVersions([holder], reader)).get(holder)
      if (held?.contentHash !== digest) return { ok: false, failure: 'name_taken' }
      return { ok: true, documentId: holder, versionId: held.versionId }
    }
  } else if (upload.current?.contentHash === digest) {
    return {
      ok: true,
      documentId,
      versionId:
        (await findCurrentVersions([documentId], reader)).get(documentId)?.versionId ?? null,
    }
  }

  const uploaded = await uploadOrFailure(() =>
    uploadDocument(
      upload.session,
      {
        projectId: upload.projectId,
        folderId: upload.folderId,
        file: new File([bytes], upload.filename, { type: 'text/markdown' }),
        screeningRelease: upload.screeningRelease,
        uploadBatchId: upload.uploadBatchId,
        documentType: THREAD_DOCUMENT_TYPE,
        mailThread: upload.facts,
      },
      upload.request
    )
  )
  if (!uploaded.ok) return uploaded
  const stored = uploaded.value.documentId
  return {
    ok: true,
    documentId: stored,
    versionId: (await findCurrentVersions([stored], reader)).get(stored)?.versionId ?? null,
  }
}

/**
 * Run an upload, or anything on its path, and say which typed failure its
 * refusal is. A fault the person cannot act on throws for the job's queue.
 */
export async function uploadOrFailure<T>(
  run: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; failure: InboundMailFilingFailure }> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    const failure = filingFailureOf(error)
    if (failure) return { ok: false, failure }
    throw error
  }
}

/**
 * The typed failure a refusal of the upload path stands for (a retry would be
 * refused the same way, so the part waits again and the person is told why),
 * or null for anything else, which the queue retries.
 */
export function filingFailureOf(error: unknown): InboundMailFilingFailure | null {
  if (!(error instanceof ApiError)) return null
  if (error instanceof ScreenedUploadError) return 'screened'
  if (error instanceof FileTooLargeError) return 'size'
  if (error instanceof InsufficientStorageError) return 'quota'
  if (isProjectClosedError(error)) return 'project_closed'
  if (error instanceof ForbiddenError || error instanceof NotFoundError) return 'access'
  if (error instanceof ConflictError) return 'name_taken'
  if (error instanceof BadRequestError) return 'type'
  return null
}

/**
 * The folder a filing goes into, as the person: an existing folder that is
 * still there, a path created now (`ensureProjectFolderPaths` asks their right
 * to create it), or the project root. `access` when the folder is gone or the
 * person may not create the path.
 */
export async function ensureTargetFolder(
  session: AuthorizedSession,
  projectId: string,
  target: { folderId: string | null; folderPath: string | null }
): Promise<
  { ok: true; folderId: string | null } | { ok: false; failure: InboundMailFilingFailure }
> {
  if (target.folderId) {
    const live = await findLiveFolders(projectId, [target.folderId])
    return live.has(target.folderId)
      ? { ok: true, folderId: target.folderId }
      : { ok: false, failure: 'access' }
  }
  if (!target.folderPath) return { ok: true, folderId: null }
  const path = target.folderPath
  try {
    const ensured = await ensureProjectFolderPaths(
      { projectId, parentId: null, paths: [path] },
      session
    )
    const folderId = ensured.ok ? ensured.folderIdByPath[path] : undefined
    return folderId ? { ok: true, folderId } : { ok: false, failure: 'access' }
  } catch (error) {
    const failure = filingFailureOf(error)
    if (failure) return { ok: false, failure }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Appending a held mail's text
// ---------------------------------------------------------------------------

/** One message part to file, and everything the filing read about its mail. */
export interface AppendRequest {
  session: AuthorizedSession
  mail: InboundMailRow
  /** The message part, being filed on `decision`. */
  part: InboundMailPartRow
  decision: InboundMailDecisionRow
  /** What the reader made of the mail (`read.json`). */
  read: MailRead
  form: MessageForm
  /** Every attachment of the mail as it stands after this run's filings, for the entry's rows (D36). */
  attachments: readonly AttachmentFact[]
  /** The project's folder tree, for whether an attachment may be named beside the thread. */
  folderTree: ReadonlyMap<string, AccessFolder>
  /** A new thread's folder, created by the caller when the decision named a path; ignored on append. */
  newThreadFolderId: string | null
  /** A new thread's locale; an existing thread keeps its own. */
  newThreadLocale: MailThreadLocale
  uploadBatchId: string | null
  request: Request
}

export type AppendOutcome =
  | {
      kind: 'filed'
      entryId: string
      threadId: string
      documentId: string
      versionId: string | null
    }
  | { kind: 'failed'; failure: InboundMailFilingFailure }
  /** Another writer holds the thread's render lease: try again shortly. */
  | { kind: 'busy' }

/** File the mail's text as the next entry of its thread (see the module header). */
export async function appendInboundMessage(request: AppendRequest): Promise<AppendOutcome> {
  const { decision } = request
  if (decision.threadAction === 'append' && decision.mailThreadId) {
    const threadId = decision.mailThreadId
    if (!(await acquireRenderLease(threadId, decision.id, new Date(Date.now() + RENDER_LEASE_MS))))
      return { kind: 'busy' }
    try {
      const target = await findWritableThread(
        request.mail.projectId,
        threadId,
        memberReader(request.session.userId)
      )
      if (!target) return { kind: 'failed', failure: 'thread_document_gone' }
      return await appendTo(request, { kind: 'existing', target })
    } finally {
      await releaseRenderLease(threadId, decision.id)
    }
  }
  if (decision.threadAction === 'create' && decision.fileName) {
    return appendTo(request, {
      kind: 'new',
      threadId: newThreadIdOf(decision.id),
      filename: threadDocumentFilename(decision.fileName),
    })
  }
  throw new Error(`decision ${decision.id} files a mail text without a thread`)
}

type AppendTarget =
  { kind: 'existing'; target: WritableThread } | { kind: 'new'; threadId: string; filename: string }

async function appendTo(request: AppendRequest, target: AppendTarget): Promise<AppendOutcome> {
  const { mail, decision } = request
  const threadId = target.kind === 'existing' ? target.target.thread.id : target.threadId
  const locale = target.kind === 'existing' ? target.target.thread.locale : request.newThreadLocale
  const filename = target.kind === 'existing' ? target.target.document.filename : target.filename
  const threadFolderId =
    target.kind === 'existing' ? target.target.document.folderId : request.newThreadFolderId

  const rows = target.kind === 'existing' ? await findThreadEntryRows(threadId) : []
  if (rows.length >= MAIL_THREAD_MAX_ENTRIES) return { kind: 'failed', failure: 'size' }
  const earlier = await renderEntriesOf(rows)

  const entryId = entryIdOf(decision.id)
  const unheaded = inboundEntryOf({
    id: entryId,
    threadId,
    mail,
    read: request.read,
    decision,
    heading: '',
    inReplyToEntryId: answeredEntryOf(rows, mail.inReplyTo),
    form: request.form,
  })
  const entry = {
    ...unheaded,
    heading: mailThreadEntryHeading(
      renderEntryOf(unheaded, []),
      rows.map((row) => row.heading),
      locale
    ),
  }
  const attachments = attachmentRowsOf({
    entryId,
    organizationId: mail.organizationId,
    projectId: mail.projectId,
    receivedAt: new Date(mail.receivedAt),
    facts: request.attachments,
    notStaged: mail.notStaged,
    visibleWithThread: (folderId) =>
      readableWithThread(request.folderTree, folderId, threadFolderId),
  })
  const lines = attachments.map((row) =>
    sectionLineOf({
      sectionName: row.sectionName ?? null,
      sectionFolderPath: row.sectionFolderPath ?? null,
    })
  )
  const entries = [...earlier, renderEntryOf(entry, lines)]
  const rendition = renderMailThread({
    title: threadTitleOf(filename),
    locale,
    continues: null,
    entries,
  })
  if (rendition.bytes > MAIL_THREAD_MAX_RENDERED_BYTES) return { kind: 'failed', failure: 'size' }

  const uploaded = await uploadThreadVersion({
    session: request.session,
    projectId: mail.projectId,
    folderId: threadFolderId,
    filename,
    markdown: rendition.markdown,
    facts: mailThreadIngestFacts(entries, locale),
    current: target.kind === 'existing' ? target.target.document : null,
    screeningRelease: target.kind === 'new' && decision.screeningRelease,
    uploadBatchId: request.uploadBatchId,
    request: request.request,
  })
  if (!uploaded.ok) return { kind: 'failed', failure: uploaded.failure }

  const thread = target.kind === 'existing' ? target.target.thread : null
  const lastEntryAt = new Date(
    Math.max(...entries.map((row) => clampSentAt(row.sentAt, row.receivedAt).sentAt.getTime()))
  )
  const participantDomains = [
    ...new Set([...(thread?.participantDomains ?? []), ...mail.participantDomains]),
  ].slice(0, 200)
  await commitAppend({
    threadId,
    newThread:
      target.kind === 'new'
        ? {
            id: threadId,
            organizationId: mail.organizationId,
            projectId: mail.projectId,
            documentId: uploaded.documentId,
            baseSubject: (mail.baseSubject ?? '').slice(0, 500),
            threadIndexGuid: mail.threadIndexGuid,
            participantDomains,
            locale,
            createdBy: decision.decidedBy,
          }
        : null,
    threadUpdate: {
      documentId: uploaded.documentId,
      entryCount: entries.length,
      renderedBytes: rendition.bytes,
      lastEntryAt,
      participantDomains,
    },
    entry: { ...entry, firstVersionId: uploaded.versionId },
    messageIds: { received: mail.messageId, referenced: [...mail.inReplyTo, ...mail.referenceIds] },
    attachments,
    part: { id: request.part.id, documentId: uploaded.documentId, versionId: uploaded.versionId },
    mailId: mail.id,
    movesOriginal: mail.rawStorageKey !== null,
  })
  return {
    kind: 'filed',
    entryId,
    threadId,
    documentId: uploaded.documentId,
    versionId: uploaded.versionId,
  }
}
