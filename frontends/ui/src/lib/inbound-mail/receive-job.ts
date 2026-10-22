/**
 * The receive job (`inbound_mail_receive`, ADR-0134, DECISION §6 "Read and
 * stage"): read one staged mail, scan it, label it and hold it for a person.
 *
 * Runs AS THE SYSTEM (`SYSTEM_ACTORS.inboundMail`), one step, bulk. It decides
 * nothing a person would and it cannot file: it imports no filing code
 * (`review-first.spec.ts`), and the database refuses a filed part without a
 * person's decision (migration 0186). What it leaves is a `waiting` mail with
 * its parts, and at most two jobs queued for later: Piloti's suggestion
 * (metadata only, D21) and, when a person's standing decision to follow the
 * thread could cover the reply, the follow job, which runs as that person and
 * re-checks everything before it appends a word.
 *
 * Each run asks again, in this order:
 *  1. Load the row and read `raw.eml`. A mail past `received` was done by an
 *     earlier run (a `waiting` one not yet announced is announced now).
 *  2. Scan the whole raw message (`ScanMail yes`) and store the verdict, before
 *     anything else: a mail is never `waiting` unscanned (CHECK).
 *  3. Drop auto-replies, delivery reports and loops, erasing the raw message by
 *     its key (a legal hold defers that). List and bulk mail is kept, marked
 *     `automatic`.
 *  4. Authenticate the sender (DKIM and DMARC, `sender-auth.ts`) and find the
 *     member by exact address; a transient verdict retries.
 *  5. Read the MIME tree (`mime.ts`) against the office's accepted types.
 *  6. The Namensprüfung on each attachment's name and the base subject.
 *  7. Scan each attachment.
 *  8. The Python reader (`/v1/mail/read`): own text, quotes, invitations; the
 *     content check on the own text, after the signature was removed.
 *  9. Redact every other project's address (B8) in the subject, the
 *     participants, the text, every quote and its header, the invitations.
 * 10. Match the project's threads and look up the Message-ID
 *     (`message_id_reused`, `already_filed`); ids and strengths only.
 * 11. Stage the attachments and `read.json`, insert the parts, `waiting`.
 * 12. Following: conditions 1–6 of D31 (`followEligibility`, pure); only when
 *     they hold is `inbound_mail_follow` queued.
 * 13. Announce (`inbound_mail.waiting`, every held mail), the live hint, the
 *     audit event, PostHog, and Piloti's suggestion unless the sender's domain
 *     is unconfirmed or the mail automatic.
 *
 * A failure retries through the queue. On the last attempt the mail is held
 * anyway, flagged `unreadable`, with a text part whose original can be
 * downloaded once its scan is clean: mail is never lost to a parser bug.
 */

import 'server-only'
import { createHash } from 'node:crypto'
import { v5 as uuidv5 } from 'uuid'
import { captureServer } from '@/lib/analytics/posthog-server'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import { SYSTEM_ACTORS } from '@/lib/audit/service'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { isCoveredByActiveHold } from '@/lib/compliance/repository'
import type { InboundMailRow, NewInboundMailPartRow } from '@/lib/db/schema'
import { acceptedTypesForOrganization } from '@/lib/documents/accepted-types'
import { documentNameKey } from '@/lib/documents/name-match'
import { insertJobIfAbsent } from '@/lib/jobs-queue/repository'
import { BFF_JOB_PRIORITY, requesterOf, type InboundMailReceivePayload, type JobAttempt } from '@/lib/jobs-queue/types'
import { followEligibility, type FollowCandidateMail } from '@/lib/mail-thread/follow-eligibility'
import { baseSubject, clampSentAt, domainOf, matchThread, type ThreadMatch } from '@/lib/mail-thread/mail-threading'
import { publishProjectChanged } from '@/lib/realtime/door-events'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { asciiLower, inboundMailDomain, redactProjectAddresses } from './address'
import { announceWaiting } from './announce'
import { classifyAutomaticMail } from './automatic-mail'
import { NULL_SENDER } from './contract'
import {
  inboundMailStagingKey,
  type InboundMailContentFinding,
  type InboundMailIgnoredCounts,
  type InboundMailNotStaged,
  type MailParticipant,
  type PartRiskFlag,
  type SenderFlag,
} from './inbound-mail-vocabulary'
import { scanForStorage } from './malware-scan'
import { rawHeaderFields, readMime, type MailAttachment, type MailHeaders, type NotStagedPart } from './mime'
import { MailReadRefusedError, readMail, redactRead, unreadableRead, type MailRead } from './read-client'
import {
  dropMail,
  findAddressToken,
  findFiledMessages,
  findMailForReceive,
  findPartSummaries,
  findScreenedDuplicates,
  findScreenedNamesakes,
  findThreadCandidates,
  findThreadFollowContext,
  holdMail,
  markNotified,
  recordRawScan,
  type HeldMailFields,
  type PartSummary,
  type StoredScan,
} from './repository'
import { mailScreeningFor, type MailScreening } from './screening'
import { authenticateSender, dateHeaderOf, isTransientReason, judgeSender, type SenderVerdict } from './sender-auth'
import { eraseStagedObjects, putStagedObject, readStagedObject, stagedObjectUrlForBackend } from './staging'

/** The job ids of the jobs one mail queues: uuid5 of the kind and the mail, so a second enqueue is no second job. */
export function inboundMailJobId(kind: 'suggest' | 'follow', mailId: string): string {
  return uuidv5(`grid:inbound-mail:${kind}:${mailId}`, uuidv5.URL)
}

/** The job's step (`systemHandler`): throws to retry, holds the mail anyway on its last attempt. */
export async function runInboundMailReceive(
  organizationId: string,
  payload: InboundMailReceivePayload,
  attempt: JobAttempt,
): Promise<void> {
  const mail = await findMailForReceive(payload.mailId)
  if (!mail || mail.projectId !== payload.projectId || mail.organizationId !== organizationId) return
  const domain = inboundMailDomain()
  if (!domain) throw new Error('GRID_INBOUND_MAIL_DOMAIN is not set: a received mail cannot be read')
  if (mail.status === 'waiting') {
    // An earlier run held it and died before telling anyone.
    if (!mail.notifiedAt) await afterHold(mail.id, domain, null)
    return
  }
  if (mail.status !== 'received' || !mail.rawStorageKey) return

  const raw = await readStagedObject(mail.stagingBucket, mail.rawStorageKey)
  if (mail.rawScanStatus === 'pending') await recordRawScan(mail.id, await scanForStorage(raw))

  const automatic = classifyAutomaticMail({ headers: rawHeaderFields(raw), envelopeFrom: mail.envelopeFrom, inboundDomain: domain })
  if (automatic.outcome === 'drop') return drop(mail, automatic.reason, attempt)

  let held: boolean
  try {
    held = await readAndHold(mail, raw, domain, automatic.automatic, attempt)
  } catch (error) {
    if (!attempt.last) throw error
    console.error(`[inbound-mail] mail ${mail.id} could not be read (${errorName(error)}); holding it as unreadable`)
    held = await holdUnreadable(mail, raw, automatic.automatic)
  }
  if (held) await afterHold(mail.id, domain, raw)
}

// ---------------------------------------------------------------------------
// Step 3: automatic mail nobody needs to see
// ---------------------------------------------------------------------------

async function drop(mail: InboundMailRow, reason: NonNullable<InboundMailRow['droppedReason']>, attempt: JobAttempt): Promise<void> {
  const deferred = await isCoveredByActiveHold(mail.organizationId, 'project', mail.projectId)
  if (!deferred && mail.rawStorageKey) {
    const left = await eraseStagedObjects(mail.stagingBucket, [mail.rawStorageKey])
    // The key may only go with its object: retry, and on the last attempt let
    // the deferred-erasure sweep finish it.
    if (left.length > 0 && !attempt.last) throw new Error(`the raw message of mail ${mail.id} could not be erased`)
    if (left.length > 0) return void (await dropMail(mail.id, { reason, erasureDeferred: true }))
  }
  if (!(await dropMail(mail.id, { reason, erasureDeferred: deferred }))) return
  recordAuditEventAfterCommit({
    organizationId: mail.organizationId,
    actor: { userId: SYSTEM_ACTORS.inboundMail, email: null },
    action: 'inbound_mail.received',
    targetType: 'inbound_mail',
    targetId: mail.id,
    alsoTargets: [{ type: 'project', id: mail.projectId }],
    metadata: { projectId: mail.projectId, dropped: reason },
    idempotencyKey: `inbound_mail.received:${mail.id}`,
  })
  captureServer({ event: 'inbound_mail_dropped', distinctId: null, organizationId: mail.organizationId, properties: { reason } })
}

// ---------------------------------------------------------------------------
// Steps 4-11: read, label, hold
// ---------------------------------------------------------------------------

/** A transient answer a later attempt may change: the queue retries it. */
class RetryLaterError extends Error {}

async function readAndHold(
  mail: InboundMailRow,
  raw: Uint8Array,
  domain: string,
  automatic: boolean,
  attempt: JobAttempt,
): Promise<boolean> {
  const token = await findAddressToken(mail.addressId)
  if (!token) throw new Error(`the address of mail ${mail.id} is gone`)
  const authentication = await authenticateSender(raw, { projectToken: token, inboundDomain: domain, envelopeFrom: mail.envelopeFrom })
  if (isTransientReason(authentication.reason) && !attempt.last) {
    throw new RetryLaterError(`sender authentication was inconclusive (${authentication.reason})`)
  }
  const memberUserId = await memberUserIdFor(mail.organizationId, authentication.fromAddress, attempt)
  const mime = await readMime(raw, { acceptedTypes: await acceptedTypesForOrganization(mail.organizationId) })
  const sentAtHeader = mime.kind === 'read' ? mime.headers.sentAtHeader : dateHeaderOf(raw)
  const verdict = judgeSender(authentication, { memberUserId, receivedAt: mail.receivedAt, sentAtHeader })
  if (mime.kind === 'unreadable') return holdUnreadable(mail, raw, automatic, verdict)

  const screening = await mailScreeningFor(mail.organizationId, mail.projectId)
  const scans = await Promise.all(mime.attachments.map((attachment) => scanForStorage(attachment.content)))
  const read = redactRead(await readText(mail, attempt), (text) => redactProjectAddresses(text, domain, token))
  const redact = (text: string) => redactProjectAddresses(text, domain, token)
  const subject = mime.headers.subject === null ? null : redact(mime.headers.subject)
  const participants = mailParticipants(mime.headers, domain, redact)
  const base = baseSubject(subject)
  const ownTextSha256 = sha256Hex(read.ownText)

  const flags: SenderFlag[] = [...verdict.flags, ...(await messageIdFlags(mail.projectId, mime.headers.messageId, ownTextSha256))]
  const candidates = await findThreadCandidates(mail.projectId, {
    messageIds: [mime.headers.messageId, ...mime.headers.inReplyTo, ...mime.headers.references].filter((id): id is string => !!id),
    threadIndexGuid: mime.headers.threadIndexGuid,
    baseSubject: base,
    participants: participants.map((participant) => participant.address),
  })
  const threadMatch = matchThread(
    {
      messageId: mime.headers.messageId,
      inReplyTo: mime.headers.inReplyTo,
      references: mime.headers.references,
      threadIndexGuid: mime.headers.threadIndexGuid,
      baseSubject: base,
      participants: participants.map((participant) => participant.address),
      sentAt: verdict.sentAt,
    },
    candidates,
  ).slice(0, 50)

  const owner = { organizationId: mail.organizationId, projectId: mail.projectId }
  const attachmentParts = await attachmentPartsOf(mail, mime.attachments, scans, screening)
  for (const [index, attachment] of mime.attachments.entries()) {
    const key = attachmentParts[index].storageKey as string
    await putStagedObject(mail.stagingBucket, key, attachment.content, attachmentParts[index].contentType)
  }
  const readKey = inboundMailStagingKey(owner, mail.id, 'read.json')
  await putStagedObject(mail.stagingBucket, readKey, Buffer.from(JSON.stringify(read)), 'application/json')

  const messagePart = textPartOf(mail, read, ownTextSha256, screening.contentFindings(read.ownText))
  const fields: HeldMailFields = {
    ...senderFields(verdict, flags, mail, mime.headers.from?.address ?? null),
    readStorageKey: readKey,
    messageId: mime.headers.messageId,
    inReplyTo: mime.headers.inReplyTo.slice(0, 5),
    referenceIds: mime.headers.references.slice(0, 50),
    threadIndexGuid: mime.headers.threadIndexGuid,
    baseSubject: base.slice(0, 500),
    threadMatch,
    senderName: mime.headers.from?.name ? redact(mime.headers.from.name).slice(0, 300) : null,
    subject: subject?.slice(0, 998) ?? null,
    participants: participants.slice(0, 200),
    participantDomains: participantDomainsOf(participants),
    recipientCount: Math.min(mime.headers.recipientCount, 1000),
    automatic,
    ...notStagedFields(mime.notStaged, mime.notStagedOverflow, redact),
  }
  return holdMail(mail.id, fields, [messagePart, ...attachmentParts])
}

/**
 * The member whose address the From is, exact after ASCII lower-casing
 * (display names never count, D4). An unreadable directory reads as an empty
 * one, which would label a member's mail as a stranger's: retried, and on the
 * last attempt taken as "no member" (the safe direction).
 */
async function memberUserIdFor(organizationId: string, fromAddress: string | null, attempt: JobAttempt): Promise<string | null> {
  if (!fromAddress) return null
  const directory = await loadOrganizationDirectory(organizationId)
  if (directory.size === 0 && !attempt.last) throw new RetryLaterError('the member directory could not be read')
  const wanted = asciiLower(fromAddress.trim())
  for (const person of directory.values()) {
    if (person.email && asciiLower(person.email.trim()) === wanted) return person.userId
  }
  return null
}

/** Step 8: the Python reader. A refusal is permanent and reads as unreadable; any other fault retries until the last attempt. */
async function readText(mail: InboundMailRow, attempt: JobAttempt): Promise<MailRead> {
  try {
    return await readMail(await stagedObjectUrlForBackend(mail.stagingBucket, mail.rawStorageKey as string))
  } catch (error) {
    if (error instanceof MailReadRefusedError) {
      console.error(`[inbound-mail] the reader refused mail ${mail.id}; its text is held as unreadable`)
      return unreadableRead('failed')
    }
    if (!attempt.last) throw error
    return unreadableRead('failed')
  }
}

/**
 * The participants a person is shown: From, Reply-To, To and Cc (the Sender
 * field is the mailbox that submitted it, not a party), the project addresses
 * of this deployment taken out (B8: they are not people), every display name
 * redacted.
 */
function mailParticipants(headers: MailHeaders, domain: string, redact: (text: string) => string): MailParticipant[] {
  const participants: MailParticipant[] = []
  for (const participant of headers.participants) {
    if (participant.role === 'sender') continue
    if (isOurDomain(participant.domain, domain)) continue
    participants.push({
      role: participant.role,
      name: participant.name ? redact(participant.name).slice(0, 300) : null,
      address: participant.address.slice(0, 320),
    })
  }
  return participants
}

function isOurDomain(candidate: string | null, domain: string): boolean {
  return candidate !== null && (candidate === domain || candidate.endsWith(`.${domain}`))
}

/** Distinct participant domains in one form (`domainOf`), at most 50 (the CHECK). */
function participantDomainsOf(participants: readonly MailParticipant[]): string[] {
  const domains = new Set<string>()
  for (const participant of participants) {
    const domain = domainOf(participant.address)
    if (domain) domains.add(domain)
  }
  return [...domains].slice(0, 50)
}

/**
 * The Message-ID flags (D11, D33): the project already received this id
 * (`message_id_reused`, perhaps a forger took it first), or the same message is
 * in a Verlauf already (`already_filed`: the same own text, or an entry from
 * the person's own archive). Neither blocks anything; each unchecks a default.
 */
async function messageIdFlags(projectId: string, messageId: string | null, ownTextSha256: string): Promise<SenderFlag[]> {
  if (!messageId) return []
  const filed = await findFiledMessages(projectId, messageId)
  if (filed.length === 0) return []
  const same = filed.some((entry) => entry.source === 'archive' || entry.ownTextSha256 === ownTextSha256)
  return [same ? 'already_filed' : 'message_id_reused']
}

/** Steps 6, 7 and the ids of step 10, per attachment: the part rows (bytes are written by the caller). */
async function attachmentPartsOf(
  mail: InboundMailRow,
  attachments: readonly MailAttachment[],
  scans: readonly StoredScan[],
  screening: MailScreening,
): Promise<Array<NewInboundMailPartRow & { storageKey: string; contentType: string }>> {
  const owner = { organizationId: mail.organizationId, projectId: mail.projectId }
  const names = attachments.map((attachment) => (attachment.filename ? documentNameKey(attachment.filename) : null))
  const [duplicates, namesakes] = await Promise.all([
    findScreenedDuplicates(mail.projectId, attachments.map((attachment) => attachment.sha256)),
    findScreenedNamesakes(mail.projectId, names.filter((name): name is string => !!name)),
  ])
  return attachments.map((attachment, index) => {
    const scan = scans[index]
    const nameStops = attachment.filename ? screening.nameStops(attachment.filename) : []
    const duplicateOf = duplicates.get(attachment.sha256) ?? null
    const name = names[index]
    const riskFlags: PartRiskFlag[] = [
      ...attachment.riskFlags,
      ...(nameStops.length > 0 ? (['name_stop'] as const) : []),
      ...(duplicateOf ? (['duplicate_of'] as const) : []),
    ]
    return {
      organizationId: mail.organizationId,
      projectId: mail.projectId,
      mailId: mail.id,
      position: attachment.position,
      kind: 'attachment' as const,
      filename: attachment.filename?.slice(0, 500) ?? null,
      contentType: (attachment.declaredType || 'application/octet-stream').slice(0, 255),
      sizeBytes: attachment.size,
      sha256: attachment.sha256,
      storageKey: inboundMailStagingKey(owner, mail.id, { position: attachment.position }),
      scanStatus: scan.status,
      scanEngine: scan.engine,
      scanSignature: scan.signature,
      scannedAt: scan.scannedAt,
      scanAttempts: 1,
      riskFlags: [...new Set(riskFlags)],
      nameStopTerms: nameStops,
      duplicateOfDocumentId: duplicateOf,
      revisionCandidateDocumentId: duplicateOf ? null : (name ? namesakes.get(name) ?? null : null),
    }
  })
}

/** The mail's own text as the one part every mail has, at position 0. Its raw message was scanned whole. */
function textPartOf(
  mail: InboundMailRow,
  read: MailRead,
  ownTextSha256: string,
  contentFindings: readonly InboundMailContentFinding[],
): NewInboundMailPartRow {
  return {
    organizationId: mail.organizationId,
    projectId: mail.projectId,
    mailId: mail.id,
    position: 0,
    kind: 'message',
    filename: null,
    contentType: 'text/plain; charset=utf-8',
    sizeBytes: Buffer.byteLength(read.ownText),
    sha256: ownTextSha256,
    storageKey: null,
    scanStatus: 'not_applicable',
    riskFlags: read.unreadable ? ['unreadable'] : [],
    contentFindings: [...contentFindings].slice(0, 32),
  }
}

/** The sender columns from the verdict (D4). A mail with no single From shows its envelope sender, never ''. */
function senderFields(
  verdict: SenderVerdict,
  flags: readonly SenderFlag[],
  mail: InboundMailRow,
  fromAddress: string | null,
): Pick<
  HeldMailFields,
  | 'senderAddress'
  | 'senderTrust'
  | 'senderUserId'
  | 'senderReason'
  | 'signerDomain'
  | 'signedHeaders'
  | 'senderFlags'
  | 'authenticationResults'
  | 'sentAt'
  | 'sentAtHeader'
> {
  return {
    senderAddress: (fromAddress || mail.envelopeFrom || NULL_SENDER).slice(0, 320),
    senderTrust: verdict.trust,
    senderUserId: verdict.senderUserId,
    senderReason: verdict.reason,
    signerDomain: verdict.signerDomain?.slice(0, 253) ?? null,
    signedHeaders: verdict.signedHeaders.map((header) => header.toLowerCase()).filter((header) => /^[a-z0-9-]+$/.test(header)).slice(0, 64),
    senderFlags: [...new Set(flags)],
    authenticationResults: verdict.authenticationResults.slice(0, 4096),
    sentAt: verdict.sentAt,
    sentAtHeader: verdict.sentAtHeader,
  }
}

/** What was left out of the parts, by name while the mail waits (redacted), and counted by reason. */
function notStagedFields(
  notStaged: readonly NotStagedPart[],
  overflow: number,
  redact: (text: string) => string,
): Pick<HeldMailFields, 'notStaged' | 'ignored'> {
  const listed: InboundMailNotStaged[] = notStaged
    .slice(0, 100)
    .map((part) => ({ filename: part.filename ? redact(part.filename).slice(0, 500) : '', reason: part.reason }))
  const ignored: InboundMailIgnoredCounts = {}
  for (const part of notStaged) ignored[part.reason] = (ignored[part.reason] ?? 0) + 1
  if (overflow > 0) ignored.limit = (ignored.limit ?? 0) + overflow
  return { notStaged: listed, ignored }
}

/**
 * The mail held without being read (the last attempt failed, or the parser
 * refused the message): one text part flagged `unreadable`, the sender as the
 * verdict knows it or else unverified, the Date clamped. The original is
 * downloadable once its scan is clean; a raw scan that never ran counts as
 * `failed` and the sweep scans it again.
 */
async function holdUnreadable(mail: InboundMailRow, raw: Uint8Array, automatic: boolean, known?: SenderVerdict): Promise<boolean> {
  const current = await findMailForReceive(mail.id)
  if (!current || current.status !== 'received') return false
  if (current.rawScanStatus === 'pending') {
    await recordRawScan(mail.id, { status: 'failed', engine: null, signature: null, scannedAt: new Date() })
  }
  const verdict = known ?? unverifiedVerdict(mail.receivedAt, dateHeaderOf(raw))
  const read = unreadableRead('failed')
  const fields: HeldMailFields = {
    ...senderFields(verdict, verdict.flags, mail, null),
    readStorageKey: null,
    automatic,
  }
  return holdMail(mail.id, fields, [textPartOf(mail, read, sha256Hex(''), [])])
}

/** The verdict of a mail whose sender could not be checked at all: unverified, nobody's member. */
function unverifiedVerdict(receivedAt: Date, sentAtHeader: Date | null): SenderVerdict {
  const clamped = clampSentAt(sentAtHeader, receivedAt)
  return {
    trust: 'external_unverified',
    senderUserId: null,
    flags: clamped.outOfRange ? ['date_out_of_range'] : [],
    reason: 'verifier_error',
    signerDomain: null,
    signedHeaders: [],
    authenticationResults: '',
    sentAt: clamped.sentAt,
    sentAtHeader,
  }
}

// ---------------------------------------------------------------------------
// Steps 12-13: after the mail is held
// ---------------------------------------------------------------------------

/**
 * Everything that follows holding a mail, read back from the row so a run that
 * finds it held but not announced does the same. `raw` is the message when the
 * caller still has it; the follow check reads its header block for which
 * recipient fields it carries.
 */
async function afterHold(mailId: string, domain: string, raw: Uint8Array | null): Promise<void> {
  const mail = await findMailForReceive(mailId)
  if (!mail || mail.status !== 'waiting' || mail.notifiedAt || !mail.senderTrust) return
  const parts = await findPartSummaries(mail.id)
  const followQueued = await queueFollowIfEligible(mail, parts, domain, raw)
  if (mail.senderTrust !== 'external_unverified' && !mail.automatic) await queueSuggestion(mail)
  await announceWaiting({
    organizationId: mail.organizationId,
    projectId: mail.projectId,
    mailId: mail.id,
    senderTrust: mail.senderTrust,
    senderUserId: mail.senderUserId,
    senderFlags: mail.senderFlags,
    automatic: mail.automatic,
  })
  publishProjectChanged(mail.organizationId, mail.projectId)
  const metadata = receivedMetadata(mail, parts, followQueued)
  recordAuditEventAfterCommit({
    organizationId: mail.organizationId,
    actor: { userId: SYSTEM_ACTORS.inboundMail, email: null },
    action: 'inbound_mail.received',
    targetType: 'inbound_mail',
    targetId: mail.id,
    alsoTargets: [{ type: 'project', id: mail.projectId }],
    metadata: { projectId: mail.projectId, ...metadata },
    idempotencyKey: `inbound_mail.received:${mail.id}`,
  })
  captureServer({
    event: 'inbound_mail_received',
    distinctId: null,
    organizationId: mail.organizationId,
    properties: {
      outcome: 'held',
      sender_trust: mail.senderTrust,
      automatic: mail.automatic,
      attachments: metadata.attachments,
      size_bucket: sizeBucket(mail.rawSizeBytes ?? 0),
    },
  })
  await markNotified(mail.id)
}

/** The audit metadata of a held mail: codes, counts and flags only (the PII canary checks it). */
export function receivedMetadata(mail: InboundMailRow, parts: readonly PartSummary[], followQueued: boolean) {
  const attachments = parts.filter((part) => part.kind === 'attachment')
  const notStaged = Object.values(mail.ignored).reduce((sum: number, count) => sum + (count ?? 0), 0)
  return {
    senderTrust: mail.senderTrust ?? '',
    senderReason: mail.senderReason ?? '',
    senderFlags: mail.senderFlags.join(','),
    automatic: mail.automatic,
    attachments: attachments.length,
    notStaged,
    riskFlags: [...new Set(attachments.flatMap((part) => part.riskFlags))].sort().join(','),
    rawScan: mail.rawScanStatus,
    unreadable: parts.some((part) => part.kind === 'message' && part.riskFlags.includes('unreadable')),
    threadMatches: mail.threadMatch.length,
    followQueued,
  }
}

/** PostHog's size bucket for a raw message, never the size itself. */
export function sizeBucket(bytes: number): string {
  if (bytes < 100 * 1024) return 'lt_100k'
  if (bytes < 1024 * 1024) return 'lt_1m'
  if (bytes < 10 * 1024 * 1024) return 'lt_10m'
  return 'ge_10m'
}

/** Piloti's suggestion (D21), queued once per mail; the job reads the budget and the names itself. */
async function queueSuggestion(mail: InboundMailRow): Promise<void> {
  await insertJobIfAbsent({
    kind: 'inbound_mail_suggest',
    organizationId: mail.organizationId,
    priority: BFF_JOB_PRIORITY.bulk,
    jobId: inboundMailJobId('suggest', mail.id),
    payload: { mailId: mail.id, projectId: mail.projectId },
  })
}

/**
 * Step 12: queue the follow job when conditions 1–6 of D31 hold for the
 * thread the mail matched by reference. The job runs as the follower and
 * re-checks all nine; this only decides whether there is anything to check.
 * Whether a follow job was queued.
 */
async function queueFollowIfEligible(
  mail: InboundMailRow,
  parts: readonly PartSummary[],
  domain: string,
  raw: Uint8Array | null,
): Promise<boolean> {
  const match = mail.threadMatch.find((candidate) => candidate.strength === 'reference')
  if (!match || !mail.senderTrust) return false
  const thread = await findThreadFollowContext(mail.projectId, match.threadId)
  if (!thread || thread.follows.length === 0) return false
  const screening = await mailScreeningFor(mail.organizationId, mail.projectId)
  const candidate: FollowCandidateMail = {
    receivedAt: mail.receivedAt,
    senderTrust: mail.senderTrust,
    senderFlags: mail.senderFlags,
    signedHeaders: mail.signedHeaders,
    automatic: mail.automatic,
    recipientHeaders: await recipientHeadersOf(mail, raw),
    participantAddresses: [
      ...(mail.senderAddress ? [mail.senderAddress] : []),
      ...mail.participants.filter((participant) => participant.role !== 'reply_to').map((participant) => participant.address),
    ],
    match: match as ThreadMatch,
    subjectNameStops: screening.nameStops(mail.baseSubject ?? ''),
    contentFindings: parts.find((part) => part.kind === 'message')?.contentFindings.length ?? 0,
  }
  const eligibility = followEligibility(
    candidate,
    { id: thread.threadId, participantDomains: thread.participantDomains },
    thread.follows,
    { now: new Date(), ownDomains: [domain] },
  )
  if (!eligibility.eligible) return false
  const directory = await loadOrganizationDirectory(mail.organizationId)
  const follower = directory.get(eligibility.follow.userId)
  const session = await resolvePinnedRequesterSession({
    userId: eligibility.follow.userId,
    email: follower?.email ?? null,
    organizationId: mail.organizationId,
  })
  // A follower who left the organization appends nothing; the follow job, which
  // ends such a follow, is not needed for that: the mail simply waits.
  if (!session) return false
  return insertJobIfAbsent({
    kind: 'inbound_mail_follow',
    organizationId: mail.organizationId,
    priority: BFF_JOB_PRIORITY.interactive,
    jobId: inboundMailJobId('follow', mail.id),
    payload: { projectId: mail.projectId, mailId: mail.id, followId: eligibility.follow.id, requester: requesterOf(session) },
  })
}

/** Which recipient fields the message carries (D31 cond. 3 needs each signed), from its header block. */
async function recipientHeadersOf(mail: InboundMailRow, raw: Uint8Array | null): Promise<Array<'to' | 'cc'>> {
  const bytes = raw ?? (mail.rawStorageKey ? await readStagedObject(mail.stagingBucket, mail.rawStorageKey) : null)
  const fields = bytes ? rawHeaderFields(bytes) : null
  if (!fields) return []
  return (['to', 'cc'] as const).filter((name) => fields.some((field) => field.name === name))
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The class and code of an error, never its message (which may quote the mail). */
function errorName(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const code = 'code' in error && typeof error.code === 'string' ? `:${error.code}` : ''
  return `${error.name}${code}`
}
