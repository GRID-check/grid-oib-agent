import 'server-only'
/**
 * The E-Mail-Eingang as a person (or an agent acting as one) reads and decides
 * it (ADR-0134, DECISION §6 "Decide", §7). The routes under
 * `/api/projects/[id]/inbound-mails` are thin adapters over this module.
 *
 * What it guarantees:
 *
 * - **Who.** Every function asks `access.ts` first: the office's
 *   `inbound-mail` entitlement and `project:documents:write` (C1); a refusal is
 *   a 404. Filing asks write on every target folder too (C2).
 * - **What a reader is shown.** Metadata, masked: the subject runs through the
 *   office's content check (`maskText`) for every reader, the text only through
 *   {@link getInboundMailText}, masked the same way, and candidates are the
 *   viewer's (`candidates.ts`). No bytes leave except through the two content
 *   functions, and those only after a clean scan (RT-S3).
 * - **What a decision is.** Rows in `inbound_mail_decisions`, written with the
 *   claims and the filing job in one transaction, compare-and-set against the
 *   mail the person read (`ifMatch`, C3). The request files nothing: the job
 *   does, as the person, from those rows (`file-job.ts`). It answers 202.
 * - **How it reached us.** `via` is read from the call, never from the body:
 *   the app, an outside agent acting as the person, or a Piloti card the
 *   person accepted (`actingProposalId`). A card carries no acknowledgement
 *   and no release (RT-S5).
 */

import { v5 as uuidv5 } from 'uuid'
import { actingProposalId, actingReaderIsAgent, currentActingSession } from '@/lib/agent-api/acting-session'
import { captureServer } from '@/lib/analytics/posthog-server'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { InboundMailPartRow, InboundMailRow } from '@/lib/db/schema'
import { acceptedTypesForOrganization } from '@/lib/documents/accepted-types'
import { contentDisposition } from '@/lib/documents/content-disposition'
import { decodeDocumentListCursor, encodeDocumentListCursor } from '@/lib/documents/list-cursor'
import { bestEffortInbox } from '@/lib/inbox/best-effort'
import { resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'
import { requesterOf } from '@/lib/jobs-queue/types'
import { domainOf } from '@/lib/mail-thread/mail-threading'
import { publishProjectChanged } from '@/lib/realtime/door-events'
import { chatScreeningRules, maskText, type ContentScreenRules } from '@/lib/upload-screening/content-screen'
import { screenUploadName } from '@/lib/upload-screening/name-screen'
import { gatePolicy } from '@/lib/upload-screening/service'
import { requireMailReviewer } from './access'
import { auditDecisions } from './audit'
import { candidatesFor, type ViewerCandidates } from './candidates'
import { mailIfMatch, planMailDecision, refusal, requireDecisionRights, type DecisionContext } from './decision'
import { INBOUND_MAIL_RESTORE_DAYS, type InboundSenderTrust } from './inbound-mail-vocabulary'
import type {
  DismissInboundMailsBody,
  FileInboundMailsBody,
  InboundMailDecisionResultView,
  InboundMailListQuery,
  InboundMailListStatus,
  InboundMailListView,
  InboundMailOutcome,
  InboundMailPartView,
  InboundMailSummaryView,
  InboundMailTextView,
  InboundMailView,
} from './inbound-mail-wire'
import { scanForStorage } from './malware-scan'
import { mailReadSchema } from './read-client'
import {
  dismissMails,
  findCandidateDocuments,
  findFollowDeciders,
  findLiveFolders,
  findMailParts,
  findProjectMail,
  findThreadDocuments,
  hasOpenParts,
  listProjectMails,
  MailChangedError,
  PartNotWaitingError,
  restoreMailParts,
  writeMailDecisions,
  type DecisionActor,
  type DecisionsWritten,
} from './repository'
import { readStagedObject } from './staging'
import { readSuggestion } from './suggest'
import { scoreMailDecision } from './suggest-scores'

/** How long a claim on a part holds before the sweep hands it back (D8: the proposals' apply claim, reused). */
export const FILING_CLAIM_MS = 5 * 60 * 1000

const DAY_MS = 86_400_000

/** The job id of the filing job one request queues: uuid5 of its first decision, so a retried enqueue is no second job. */
export function filingJobId(firstDecisionId: string): string {
  return uuidv5(`grid:inbound-mail:file:${firstDecisionId}`, uuidv5.URL)
}

/**
 * How the decision in flight reached us (`inbound_mail_decisions.via`), from
 * the call itself: a Piloti card the person accepted, an outside agent acting
 * as the person, or the app. Never from the body, which an agent writes.
 */
export function decisionActor(session: AuthorizedSession): DecisionActor {
  const proposalId = actingProposalId()
  if (proposalId) return { decidedBy: session.userId, via: 'piloti_proposal', proposalId }
  if (currentActingSession() && actingReaderIsAgent()) return { decidedBy: session.userId, via: 'agent', proposalId: null }
  return { decidedBy: session.userId, via: 'app', proposalId: null }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The office's content check for this project, as a reader's mask: the same rules a chat attachment is screened with. */
async function maskRulesFor(organizationId: string, projectId: string): Promise<ContentScreenRules | null> {
  return chatScreeningRules(await gatePolicy(organizationId, projectId))
}

const masked = (text: string | null, rules: ContentScreenRules | null): string | null =>
  text === null ? null : maskText(text, rules).text

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString())

/** Whether anything of the mail still waits for a person: the waiting list's, else the handled list's. */
function listStatusOf(mail: InboundMailRow, parts: readonly InboundMailPartRow[]): InboundMailListStatus {
  const open = parts.some((part) => part.state === 'waiting' || part.state === 'filing')
  return mail.status === 'waiting' && open ? 'waiting' : 'handled'
}

/** Until when a dismissed or expired part can be restored: only while the mail is held and its bytes are there. */
function restorableUntil(mail: InboundMailRow, part: InboundMailPartRow, now: number): string | null {
  if (mail.status !== 'waiting' || (part.state !== 'dismissed' && part.state !== 'expired') || !part.endedAt) return null
  if (part.kind === 'attachment' && part.storageKey === null) return null
  const until = new Date(part.endedAt).getTime() + INBOUND_MAIL_RESTORE_DAYS * DAY_MS
  return until > now ? new Date(until).toISOString() : null
}

function partView(mail: InboundMailRow, part: InboundMailPartRow, candidates: ViewerCandidates, now: number): InboundMailPartView {
  const matched = candidates.part(part)
  return {
    id: part.id,
    kind: part.kind,
    position: part.position,
    filename: part.filename,
    contentType: part.contentType,
    sizeBytes: part.sizeBytes,
    state: part.state,
    scan: part.scanStatus,
    scannedAt: iso(part.scannedAt),
    riskFlags: part.riskFlags,
    nameStopTerms: part.nameStopTerms,
    contentFindings: part.contentFindings,
    offered: part.kind === 'message' || !part.riskFlags.includes('type_not_accepted'),
    lastFailure: part.lastFailure,
    documentId: part.documentId && candidates.readsDocument(part.documentId) ? part.documentId : null,
    duplicateOf: matched.duplicateOf,
    revisionCandidate: matched.revisionCandidate,
    revisionCandidateHidden: matched.revisionCandidateHidden,
    suggestion: readSuggestion(part.suggestion),
    restorableUntil: restorableUntil(mail, part, now),
  }
}

/** One mail as `inbound-mail-get` answers it. */
function mailView(
  mail: InboundMailRow,
  parts: readonly InboundMailPartRow[],
  candidates: ViewerCandidates,
  context: { closed: boolean; rules: ContentScreenRules | null; followedBy: string | null; now: number },
): InboundMailView {
  const threads = candidates.threads(mail)
  return {
    id: mail.id,
    projectId: mail.projectId,
    status: listStatusOf(mail, parts),
    projectClosed: context.closed,
    ifMatch: mailIfMatch(mail, parts),
    subject: masked(mail.subject, context.rules),
    sender:
      mail.senderAddress && mail.senderTrust && mail.senderReason
        ? {
            name: mail.senderName,
            address: mail.senderAddress,
            domain: domainOf(mail.senderAddress),
            signerDomain: mail.signerDomain,
            trust: mail.senderTrust,
            reason: mail.senderReason,
            flags: mail.senderFlags,
          }
        : null,
    participants: mail.participants,
    sentAt: iso(mail.sentAt),
    receivedAt: new Date(mail.receivedAt).toISOString(),
    expiresAt: new Date(mail.expiresAt).toISOString(),
    automatic: mail.automatic,
    rawScan: mail.rawScanStatus,
    originalHeld: mail.rawStorageKey !== null,
    notStaged: mail.notStaged,
    parts: parts.map((part) => partView(mail, part, candidates, context.now)),
    threadCandidates: threads.shown,
    hiddenThreadCandidates: threads.hidden,
    followedBy: context.followedBy,
    updatedAt: new Date(mail.updatedAt).toISOString(),
  }
}

function summaryView(
  mail: InboundMailRow,
  parts: readonly InboundMailPartRow[],
  candidates: ViewerCandidates,
  rules: ContentScreenRules | null,
  now: number,
): InboundMailSummaryView {
  const count = (state: InboundMailOutcome) => parts.filter((part) => part.state === state).length
  const until = parts
    .map((part) => restorableUntil(mail, part, now))
    .filter((value): value is string => value !== null)
    .sort()
  const [best] = candidates.threads(mail).shown
  return {
    id: mail.id,
    projectId: mail.projectId,
    status: listStatusOf(mail, parts),
    subject: masked(mail.subject, rules),
    senderName: mail.senderName,
    senderDomain: domainOf(mail.senderAddress),
    senderTrust: (mail.senderTrust as InboundSenderTrust | null) ?? null,
    senderFlags: mail.senderFlags,
    automatic: mail.automatic,
    receivedAt: new Date(mail.receivedAt).toISOString(),
    expiresAt: new Date(mail.expiresAt).toISOString(),
    attachments: parts.filter((part) => part.kind === 'attachment').length,
    waitingParts: parts.filter((part) => part.state === 'waiting').length,
    outcomes: { filed: count('filed'), dismissed: count('dismissed'), expired: count('expired') },
    restorableUntil: until.at(-1) ?? null,
    thread: best
      ? { threadId: best.threadId, name: best.name, nextVersion: best.nextVersion, preselected: best.preselected }
      : null,
    updatedAt: new Date(mail.updatedAt).toISOString(),
  }
}

const groupParts = (parts: readonly InboundMailPartRow[]): Map<string, InboundMailPartRow[]> => {
  const byMail = new Map<string, InboundMailPartRow[]>()
  for (const part of parts) byMail.set(part.mailId, [...(byMail.get(part.mailId) ?? []), part])
  return byMail
}

/** These mails as the viewer reads them, with one load of parts, candidates and the mask for all of them. */
async function mailViews(
  session: AuthorizedSession,
  projectId: string,
  mails: readonly InboundMailRow[],
  closed: boolean,
): Promise<InboundMailView[]> {
  const parts = await findMailParts(mails.map((mail) => mail.id))
  const [candidates, rules, followers] = await Promise.all([
    candidatesFor(session, projectId, mails, parts),
    maskRulesFor(session.organizationId, projectId),
    findFollowDeciders(mails.map((mail) => mail.id)),
  ])
  const byMail = groupParts(parts)
  const now = Date.now()
  return mails.map((mail) =>
    mailView(mail, byMail.get(mail.id) ?? [], candidates, { closed, rules, followedBy: followers.get(mail.id) ?? null, now }),
  )
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One page of the project's E-Mail-Eingang (`inbound-mail-list`): waiting or handled mail, newest first. */
export async function listInboundMails(
  session: AuthorizedSession,
  projectId: string,
  query: InboundMailListQuery,
): Promise<InboundMailListView> {
  await requireMailReviewer(session, projectId)
  const decoded = query.cursor ? decodeDocumentListCursor(query.cursor) : null
  if (query.cursor && !decoded) throw new BadRequestError('Invalid cursor')
  const after = decoded ? { receivedAt: decoded.createdAt, id: decoded.id } : null
  const rows = await listProjectMails(projectId, { status: query.status, outcome: query.outcome, limit: query.limit }, after)
  const page = rows.slice(0, query.limit)
  const mails = page.map((row) => row.mail)
  const parts = await findMailParts(mails.map((mail) => mail.id))
  const [candidates, rules] = await Promise.all([
    candidatesFor(session, projectId, mails, parts),
    maskRulesFor(session.organizationId, projectId),
  ])
  const byMail = groupParts(parts)
  const now = Date.now()
  const last = page.at(-1)
  return {
    items: mails.map((mail) => summaryView(mail, byMail.get(mail.id) ?? [], candidates, rules, now)),
    nextCursor:
      rows.length > query.limit && last
        ? encodeDocumentListCursor({ createdAt: last.position.receivedAt, id: last.position.id })
        : null,
  }
}

/** A mail of the project the reviewer may read, or 404. */
async function requireMail(projectId: string, mailId: string): Promise<InboundMailRow> {
  const mail = await findProjectMail(projectId, mailId)
  if (!mail) throw new NotFoundError('Mail not found')
  return mail
}

/** One held mail (`inbound-mail-get`): headers, labels, parts and the viewer's candidates. Never its text. */
export async function getInboundMail(session: AuthorizedSession, projectId: string, mailId: string): Promise<InboundMailView> {
  const { closed } = await requireMailReviewer(session, projectId)
  const [view] = await mailViews(session, projectId, [await requireMail(projectId, mailId)], closed)
  return view as InboundMailView
}

/**
 * The text of a held mail (`inbound-mail-text-get`, D7): the sender's own text
 * and the quoted blocks, every finding of the office's content check masked,
 * for every reader. Not offered to Piloti (the exposure config); outside agents
 * and people read it masked.
 */
export async function getInboundMailText(session: AuthorizedSession, projectId: string, mailId: string): Promise<InboundMailTextView> {
  await requireMailReviewer(session, projectId)
  const mail = await requireMail(projectId, mailId)
  if (mail.status !== 'waiting' || !mail.readStorageKey) {
    if (mail.status !== 'waiting') throw refusal('gone', 'The text of a handled mail is in its mail thread, if it was filed', { mailId })
    return { ownText: '', ownTextTruncated: false, quoted: [], calendar: [], masked: false, unreadable: true }
  }
  const read = mailReadSchema.parse(JSON.parse(new TextDecoder().decode(await readStagedObject(mail.stagingBucket, mail.readStorageKey))))
  const rules = await maskRulesFor(session.organizationId, projectId)
  const own = maskText(read.ownText, rules)
  const quoted = read.quoted.map((block) => ({ header: maskText(block.header, rules), text: maskText(block.text, rules) }))
  const anyMasked = own.findings.length > 0 || quoted.some((block) => block.header.findings.length + block.text.findings.length > 0)
  return {
    ownText: own.text,
    ownTextTruncated: read.ownTextTruncated,
    quoted: quoted.map((block) => ({ header: block.header.text, text: block.text.text })),
    calendar: read.calendar.map((event) => ({
      summary: masked(event.summary, rules),
      start: event.start,
      end: event.end,
      allDay: event.allDay,
      location: masked(event.location, rules),
      status: event.status,
    })),
    masked: anyMasked,
    unreadable: read.unreadable,
  }
}

/** The media types a held attachment is served as; anything else is `application/octet-stream`. */
const SERVED_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** The headers every held byte is served with: never sniffed, never run, never cached, always a download. */
export function heldBytesHeaders(contentType: string, filename: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition('attachment', filename),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, no-store',
  }
}

/**
 * The bytes of one held attachment (`inbound-mail-part-content-get`), for the
 * person's preview and download: only after a clean scan (409
 * `scan_not_clean` otherwise, RT-S3), served so a browser never runs them, and
 * audited (`inbound_mail.part_read`). Not offered to Piloti.
 */
export async function readInboundMailPart(
  session: AuthorizedSession,
  projectId: string,
  mailId: string,
  partId: string,
): Promise<Response> {
  await requireMailReviewer(session, projectId)
  const mail = await requireMail(projectId, mailId)
  const part = (await findMailParts([mail.id])).find((candidate) => candidate.id === partId && candidate.kind === 'attachment')
  if (!part) throw new NotFoundError('Part not found')
  if (part.scanStatus !== 'clean') throw refusal('scan_not_clean', 'This attachment has no clean scan', { partId })
  if (!part.storageKey) throw refusal('gone', 'The bytes of this attachment are no longer held', { partId })
  const bytes = await readStagedObject(mail.stagingBucket, part.storageKey)
  recordAuditEventAfterCommit({
    action: 'inbound_mail.part_read',
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email || null },
    targetType: 'inbound_mail',
    targetId: mail.id,
    alsoTargets: [{ type: 'project', id: projectId }],
    metadata: { projectId, partId, scan: part.scanStatus },
  })
  const type = SERVED_TYPES.has(part.contentType) ? part.contentType : 'application/octet-stream'
  return new Response(new Blob([new Uint8Array(bytes)]), { status: 200, headers: heldBytesHeaders(type, part.filename ?? `attachment-${part.position}`) })
}

/**
 * The original `.eml` of a held mail (`inbound-mail-original-get`), scanned
 * whole on this request (`ScanMail`), served only on a clean answer (409
 * `original_not_clean` otherwise) and audited (`inbound_mail.original_read`).
 * Evidence: no agent door offers it (withheld, `evidence`). The copy warns
 * that a mail program loads remote images.
 */
export async function readInboundMailOriginal(session: AuthorizedSession, projectId: string, mailId: string): Promise<Response> {
  await requireMailReviewer(session, projectId)
  const mail = await requireMail(projectId, mailId)
  if (!mail.rawStorageKey) throw refusal('gone', 'The original of this mail is no longer held here', { mailId })
  const bytes = await readStagedObject(mail.stagingBucket, mail.rawStorageKey)
  const scan = await scanForStorage(bytes)
  recordAuditEventAfterCommit({
    action: 'inbound_mail.original_read',
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email || null },
    targetType: 'inbound_mail',
    targetId: mail.id,
    alsoTargets: [{ type: 'project', id: projectId }],
    metadata: { projectId, scan: scan.status },
  })
  if (scan.status !== 'clean') {
    throw refusal(
      'original_not_clean',
      scan.status === 'infected' ? 'The original contains malware and cannot be downloaded' : 'The original could not be scanned; try again',
      { mailId, scan: scan.status },
    )
  }
  return new Response(new Blob([new Uint8Array(bytes)]), { status: 200, headers: heldBytesHeaders('message/rfc822', `mail-${mail.id}.eml`) })
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** After a decision committed: the trail, the live hint, the waiting notice of each mail nothing waits in any more. */
async function afterDecisions(
  session: AuthorizedSession,
  projectId: string,
  written: DecisionsWritten,
  mailIds: readonly string[],
): Promise<void> {
  publishProjectChanged(session.organizationId, projectId)
  await auditDecisions(written.decisions)
  for (const mailId of mailIds) {
    if (await hasWaitingPart(mailId)) continue
    await bestEffortInbox(`inbound_mail.waiting settled for mail ${mailId}`, session.organizationId, () =>
      resolveInboxItemsAnchoredOn({ organizationId: session.organizationId, types: ['inbound_mail.waiting'], anchorId: mailId }),
    )
  }
}

/** Whether a part of the mail still waits for a person (a part being filed was decided). */
async function hasWaitingPart(mailId: string): Promise<boolean> {
  return (await findMailParts([mailId])).some((part) => part.state === 'waiting')
}

/** The rows a request's decisions are checked against, loaded once (`DecisionContext`). */
async function decisionContext(
  session: AuthorizedSession,
  projectId: string,
  body: FileInboundMailsBody,
  mails: readonly InboundMailRow[],
  parts: readonly InboundMailPartRow[],
): Promise<DecisionContext> {
  const folderIds = body.mails.flatMap((mail) => [
    ...mail.parts.map((part) => part.folderId),
    mail.message?.thread.action === 'create' ? mail.message.thread.folderId : null,
  ])
  const threadIds = body.mails.flatMap((mail) => (mail.message?.thread.action === 'append' ? [mail.message.thread.mailThreadId] : []))
  const revisionIds = body.mails.flatMap((mail) => mail.parts.flatMap((part) => (part.revisionOf ? [part.revisionOf] : [])))
  const [acceptedTypes, policy, candidates, folders, threads, documents] = await Promise.all([
    acceptedTypesForOrganization(session.organizationId),
    gatePolicy(session.organizationId, projectId),
    candidatesFor(session, projectId, mails, parts),
    findLiveFolders(projectId, folderIds.filter((id): id is string => id !== null)),
    findThreadDocuments(projectId, threadIds),
    findCandidateDocuments(projectId, revisionIds),
  ])
  return {
    actor: decisionActor(session),
    bulk: body.mails.length > 1,
    acceptedTypes,
    nameStops: (filename, folderPath) => [
      ...new Set(screenUploadName(policy, { filename, folderPath }).matches.map((match) => match.term)),
    ],
    candidates,
    folders,
    threads: new Map(threads.map((thread) => [thread.threadId, thread])),
    documents: new Map(documents.map((document) => [document.documentId, document])),
  }
}

/** The PostHog bucket of how long a mail waited, never the exact time. */
function hoursWaitingBucket(receivedAt: Date | string, now: number): string {
  const hours = (now - new Date(receivedAt).getTime()) / 3_600_000
  if (hours < 1) return 'lt_1h'
  if (hours < 24) return 'lt_1d'
  if (hours < 24 * 7) return 'lt_7d'
  return 'gte_7d'
}

/**
 * Decide up to 20 mails (`inbound-mail-file`, D26): file the named parts,
 * dismiss every other waiting part. Checks every rule of C2 for every mail
 * before anything is written, then writes the decisions, the claims and the
 * filing job in one transaction (C3), and answers 202 with the mails as they
 * stand now. The filing job files each part as this person.
 */
export async function fileInboundMails(
  session: AuthorizedSession,
  projectId: string,
  body: FileInboundMailsBody,
): Promise<InboundMailDecisionResultView> {
  const { closed } = await requireMailReviewer(session, projectId)
  const mails = await Promise.all(body.mails.map((decision) => requireMail(projectId, decision.mailId)))
  const parts = await findMailParts(mails.map((mail) => mail.id))
  const context = await decisionContext(session, projectId, body, mails, parts)
  const byMail = groupParts(parts)
  const plans = body.mails.map((decision, index) =>
    planMailDecision(mails[index] as InboundMailRow, byMail.get(decision.mailId) ?? [], decision, context),
  )
  await requireDecisionRights(session, projectId, plans)

  const files = plans.flatMap((plan) => plan.files)
  const first = files[0]
  const jobId = first?.id ? filingJobId(first.id) : null
  const job = jobId
    ? {
        jobId,
        organizationId: session.organizationId,
        payload: {
          projectId,
          mailIds: plans.filter((plan) => plan.files.length > 0).map((plan) => plan.mailId),
          requester: requesterOf(session),
        },
      }
    : null
  let written: DecisionsWritten
  try {
    written = await writeMailDecisions(
      plans.map((plan) => ({ mailId: plan.mailId, ifMatch: plan.ifMatch, files: plan.files })),
      context.actor,
      mailIfMatch,
      new Date(Date.now() + FILING_CLAIM_MS),
      job,
    )
  } catch (error) {
    if (error instanceof MailChangedError) {
      throw refusal('stale', 'The mail changed since it was read; read it again and decide again', { mailId: error.mailId })
    }
    if (error instanceof PartNotWaitingError) {
      throw refusal('part_not_waiting', 'A part is no longer waiting; read the mail again', { mailId: error.mailId })
    }
    throw error
  }

  const now = Date.now()
  const folderPathOf = (folderId: string) => context.folders.get(folderId) ?? null
  for (const plan of plans) {
    const mail = mails.find((candidate) => candidate.id === plan.mailId)
    const message = plan.files.find((row) => row.threadAction)
    // Scored against the parts as they were before this decision (D21, §10).
    const suggestionFollowed = mail
      ? scoreMailDecision({
          organizationId: session.organizationId,
          decidedBy: session.userId,
          mail,
          parts: byMail.get(plan.mailId) ?? [],
          decision: body.mails.find((decision) => decision.mailId === plan.mailId) ?? null,
          via: context.actor.via,
          folderPathOf,
        })
      : 'no_suggestion'
    captureServer({
      event: 'inbound_mail_decided',
      distinctId: session.userId,
      organizationId: session.organizationId,
      properties: {
        files: plan.files.length,
        dismissed: written.decisions.filter((row) => row.mailId === plan.mailId && row.action === 'dismiss').length,
        suggestion_followed: suggestionFollowed,
        thread_action: message?.threadAction ?? null,
        hours_waiting_bucket: mail ? hoursWaitingBucket(mail.receivedAt, now) : null,
        via: context.actor.via,
      },
    })
  }
  await afterDecisions(session, projectId, written, body.mails.map((mail) => mail.mailId))
  const fresh = await Promise.all(body.mails.map((decision) => requireMail(projectId, decision.mailId)))
  return { mails: await mailViews(session, projectId, fresh, closed), filingJobId: jobId }
}

/**
 * Dismiss every waiting part of these mails (`inbound-mail-dismiss`),
 * restorable for seven days. Possible in a closed project. A mail with nothing
 * waiting is left as it is, so dismissing twice changes nothing.
 */
export async function dismissInboundMails(
  session: AuthorizedSession,
  projectId: string,
  body: DismissInboundMailsBody,
): Promise<{ mails: InboundMailView[] }> {
  const { closed } = await requireMailReviewer(session, projectId)
  const mails = await Promise.all(body.mailIds.map((mailId) => requireMail(projectId, mailId)))
  // The parts before the dismissal: each suggestion they carried is scored as not followed.
  const before = groupParts(await findMailParts(body.mailIds))
  const actor = decisionActor(session)
  const written = await dismissMails(projectId, body.mailIds, actor)
  for (const mail of mails) {
    const dismissed = written.decisions.filter((row) => row.mailId === mail.id).length
    if (dismissed === 0) continue
    const suggestionFollowed = scoreMailDecision({
      organizationId: session.organizationId,
      decidedBy: session.userId,
      mail,
      parts: before.get(mail.id) ?? [],
      decision: null,
      via: actor.via,
      folderPathOf: () => null,
    })
    captureServer({
      event: 'inbound_mail_decided',
      distinctId: session.userId,
      organizationId: session.organizationId,
      properties: { files: 0, dismissed, suggestion_followed: suggestionFollowed, thread_action: null, via: actor.via },
    })
  }
  await afterDecisions(session, projectId, written, body.mailIds)
  const fresh = await Promise.all(body.mailIds.map((mailId) => requireMail(projectId, mailId)))
  return { mails: await mailViews(session, projectId, fresh, closed) }
}

/**
 * Restore a mail's dismissed or expired parts within their seven days
 * (`inbound-mail-restore`, D8): they wait again, and an expired mail waits at
 * least seven more days. Idempotent: a second call finds nothing to restore and
 * answers the mail as it is. Refused (`not_restorable`) when nothing of the
 * mail can come back and nothing waits.
 */
export async function restoreInboundMail(session: AuthorizedSession, projectId: string, mailId: string): Promise<InboundMailView> {
  const { closed } = await requireMailReviewer(session, projectId)
  await requireMail(projectId, mailId)
  const now = Date.now()
  const written = await restoreMailParts(
    projectId,
    mailId,
    decisionActor(session),
    new Date(now - INBOUND_MAIL_RESTORE_DAYS * DAY_MS),
    new Date(now + INBOUND_MAIL_RESTORE_DAYS * DAY_MS),
  )
  if (written.decisions.length === 0 && !(await hasOpenParts(mailId))) {
    throw refusal('not_restorable', 'Nothing of this mail can be restored any more', { mailId })
  }
  if (written.decisions.length > 0) {
    publishProjectChanged(session.organizationId, projectId)
    await auditDecisions(written.decisions)
  }
  const [view] = await mailViews(session, projectId, [await requireMail(projectId, mailId)], closed)
  return view as InboundMailView
}
