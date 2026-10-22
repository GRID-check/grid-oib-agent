import 'server-only'
/**
 * The filing job (`inbound_mail_file`, ADR-0134, DECISION §6 "File"): files the
 * parts a person decided on, AS THAT PERSON (`handler`, the decider's session
 * resolved for every slice; a person who left the organization ends it, and
 * the claims run out to sweep 5). What to file, where, under which name and
 * with which acknowledgements is read from the decision rows each claimed part
 * names (`decision_id`), never from the payload, which says only which mails
 * and who.
 *
 * Per mail, in this order:
 *
 * 1. **A move that stopped half-way is finished**: a mail whose text was filed
 *    while its raw message was still being moved to the entry's original
 *    (`original_move_pending_at`, `lib/mail-thread/originals.ts`).
 * 2. **Each attachment** being filed (`fileAttachment`): the claim renewed; the
 *    bytes read from staging; scanned again when the verdict is older than a
 *    day; checked against the SHA-256 the person saw; its folder (or the path
 *    to create) resolved as the person; then the ordinary upload path in the
 *    person's session (`uploadDocument`: folder rights, Namensprüfung,
 *    Inhaltsprüfung, the office's types, quota), in this run's quiet batch
 *    (D35, `INBOUND_ATTACHMENT_EFFECTS`), with the type the person chose and
 *    the mail it came with (`mail_origin`). Filed: the staged bytes are erased
 *    by their key and the part names its document and Fassung (D36). Refused:
 *    the part waits again with a typed `last_failure`.
 * 3. **The text**, after the attachments, so its entry records what became of
 *    each of them (`lib/mail-thread/append.ts`). A thread another filing is
 *    writing makes the run answer „not yet“ without spending an attempt.
 * 4. **An attachment filed after its text** (a retry, a restore) is linked to
 *    the entry's row that still said `pending` (D36).
 * 5. **Settle**, once every part of the mail is filed: the staged objects are
 *    erased by their keys (deferred under a legal hold) and the row is
 *    scrubbed to ids. A mail with a dismissed part is left to sweep 6: the part
 *    can be restored for seven days.
 *
 * Retry-safe: every write is a compare-and-set on the part's claim, the
 * entry's and a new thread's ids are the decision's, and an upload whose answer
 * was lost is found by its digest. A failure a retry would repeat is a part's
 * `last_failure`; anything else throws for the queue's next attempt.
 */

import { createHash } from 'node:crypto'
import type { AuthorizedSession } from '@/lib/auth/types'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import type { AccessFolder } from '@/lib/authz/folder-access-rule'
import type { InboundMailDecisionRow, InboundMailPartRow, InboundMailRow } from '@/lib/db/schema'
import { memberReader } from '@/lib/documents/document-reader'
import { uploadDocument } from '@/lib/documents/service'
import { documentTypeOf } from '@/lib/documents/tag-vocabulary'
import { bestEffortInbox } from '@/lib/inbox/best-effort'
import { resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'
import type { InboundMailFilePayload, JobSliceResult } from '@/lib/jobs-queue/types'
import {
  appendInboundMessage,
  ensureTargetFolder,
  RENDER_LEASE_RETRY_MS,
  uploadOrFailure,
  type AttachmentFact,
} from '@/lib/mail-thread/append'
import { mailOriginIngestFacts } from '@/lib/mail-thread/ingest-facts'
import { domainOf } from '@/lib/mail-thread/mail-threading'
import type { MailThreadLocale } from '@/lib/mail-thread/mail-thread-vocabulary'
import { finishOriginalMove } from '@/lib/mail-thread/originals'
import {
  decidePendingAttachment,
  findCurrentVersions,
  findEntryOfMail,
  findThreadRow,
  findVersionTimes,
} from '@/lib/mail-thread/write-repository'
import { findOrganization } from '@/lib/organizations/repository'
import { publishProjectChanged } from '@/lib/realtime/door-events'
import { chatScreeningRules } from '@/lib/upload-screening/content-screen'
import { gatePolicy } from '@/lib/upload-screening/service'
import { findUserPreferences } from '@/lib/user-preferences/repository'
import { isLocale } from '@/i18n/config'
import { INBOUND_ATTACHMENT_EFFECTS, INBOUND_THREAD_APPEND_EFFECTS } from './batch-effects'
import {
  findFilingWork,
  markAttachmentFiled,
  projectIsHeld,
  recordFilingScan,
  renewClaim,
  returnPartToWaiting,
  settleFiledMail,
  type FilingWork,
} from './filing-repository'
import { scanForStorage } from './malware-scan'
import { openQuietBatch, sealQuietBatch } from './quiet-batch'
import { mailReadSchema } from './read-client'
import { FILING_CLAIM_MS } from './service'
import { eraseStagedObjects, readStagedObject } from './staging'

/** A scan older than this is repeated before the bytes are filed: signatures change. */
export const RESCAN_AFTER_MS = 24 * 60 * 60 * 1000

/** The request the uploads' audit lines carry: a job, not a browser. */
const jobRequest = (): Request =>
  new Request('http://bff-jobs.internal/inbound-mail-file', {
    headers: { 'user-agent': 'piloti-inbound-mail' },
  })

/** What one run shares across its mails: the person, the project, and what it reads or opens at most once. */
interface FilingRun {
  session: AuthorizedSession
  projectId: string
  request: Request
  once: <T>(key: string, load: () => Promise<T>) => Promise<T>
}

function filingRun(session: AuthorizedSession, projectId: string): FilingRun {
  const cache = new Map<string, Promise<unknown>>()
  return {
    session,
    projectId,
    request: jobRequest(),
    once: <T>(key: string, load: () => Promise<T>) => {
      if (!cache.has(key)) cache.set(key, load())
      return cache.get(key) as Promise<T>
    },
  }
}

const attachmentBatch = (run: FilingRun) =>
  run.once('batch:attachments', () =>
    openQuietBatch(run.session, run.projectId, INBOUND_ATTACHMENT_EFFECTS)
  )
const threadBatch = (run: FilingRun) =>
  run.once('batch:thread', () =>
    openQuietBatch(run.session, run.projectId, INBOUND_THREAD_APPEND_EFFECTS)
  )
const held = (run: FilingRun) =>
  run.once('held', () => projectIsHeld(run.projectId, run.session.organizationId))

/**
 * The locale a new thread is rendered in, for its whole life: the decider's
 * own, else their office's default (the chain the UI resolves them by,
 * `user-preferences/locale.ts`), else German, the language an office's mail
 * to its projects is written in.
 */
const newThreadLocale = (run: FilingRun): Promise<MailThreadLocale> =>
  run.once('locale', async () => {
    const preferences = await findUserPreferences(
      run.session.userId,
      run.session.organizationId
    ).catch(() => null)
    if (isLocale(preferences?.locale)) return preferences.locale
    const organization = await findOrganization(run.session.organizationId).catch(() => null)
    return isLocale(organization?.defaultLocale) ? organization.defaultLocale : 'de'
  })

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** The slice (`handler`): every mail of the payload, then the run's batches sealed. */
export async function runInboundMailFiling(
  session: AuthorizedSession,
  payload: InboundMailFilePayload
): Promise<JobSliceResult<InboundMailFilePayload>> {
  const work = await findFilingWork(payload.projectId, payload.mailIds)
  if (work.length === 0) return { done: true, payload }
  const run = filingRun(session, payload.projectId)
  let busy = false
  try {
    for (const mail of work) busy = (await fileMail(run, mail)) === 'busy' || busy
  } finally {
    for (const key of ['batch:attachments', 'batch:thread']) {
      const opened = await run.once<string | null>(key, async () => null).catch(() => null)
      if (opened) await sealQuietBatch(session, opened)
    }
    publishProjectChanged(session.organizationId, payload.projectId)
  }
  return busy
    ? { done: false, payload, notBefore: new Date(Date.now() + RENDER_LEASE_RETRY_MS) }
    : { done: true, payload }
}

/** One mail, in the order of the module header. `busy` when its text waits for another writer of its thread. */
async function fileMail(run: FilingRun, work: FilingWork): Promise<'done' | 'busy'> {
  await finishInterruptedMove(run, work.mail)
  const filedNow: Array<{
    part: InboundMailPartRow
    documentId: string
    versionId: string | null
  }> = []
  for (const part of work.parts) {
    const decision = work.decisions.get(part.id)
    if (part.kind !== 'attachment' || part.state !== 'filing' || !decision) continue
    const filed = await fileAttachment(run, work, part, decision)
    if (filed) filedNow.push({ part, ...filed })
  }

  let outcome: 'done' | 'busy' = 'done'
  const message = work.parts.find((part) => part.kind === 'message' && part.state === 'filing')
  const messageDecision = message ? work.decisions.get(message.id) : undefined
  if (message && messageDecision) outcome = await fileText(run, work.mail, message, messageDecision)
  else await linkLateAttachments(run, work.mail, filedNow)

  await settleIfFiled(run, work.mail.id)
  return outcome
}

/** A mail whose text was filed while its raw message was still moving to the entry's original (originals.ts). */
async function finishInterruptedMove(run: FilingRun, mail: InboundMailRow): Promise<void> {
  if (!mail.originalMovePendingAt || !mail.rawStorageKey) return
  const entry = await findEntryOfMail(run.projectId, mail.id)
  if (entry) await finishOriginalMove(mail, entry)
}

/** The message an attachment came with, as its `mail_origin` names it. */
function messageOf(mail: InboundMailRow) {
  return {
    sentAt: mail.sentAt ?? mail.receivedAt,
    receivedAt: mail.receivedAt,
    senderName: mail.senderName,
    senderDomain: domainOf(mail.senderAddress),
    signerDomain: mail.signerDomain,
    senderTrust: mail.senderTrust ?? 'external_unverified',
  } as const
}

/** The thread the mail's text goes (or went) into, as far as it exists: its document and locale. */
async function threadOf(
  run: FilingRun,
  work: FilingWork
): Promise<{ documentId: string | null; locale: MailThreadLocale }> {
  const message = work.parts.find((part) => part.kind === 'message')
  const decision = message ? work.decisions.get(message.id) : undefined
  const threadId =
    decision?.mailThreadId ??
    (message?.mailThreadEntryId
      ? (await findEntryOfMail(run.projectId, work.mail.id))?.threadId
      : null)
  const thread = threadId ? await findThreadRow(run.projectId, threadId) : null
  if (thread) return { documentId: thread.documentId, locale: thread.locale }
  return { documentId: null, locale: await newThreadLocale(run) }
}

/**
 * File one attachment as the person (step 2 of the module header). Null when
 * it was not filed: it waits again with its failure, or it is no longer this
 * run's (its claim was handed back).
 */
async function fileAttachment(
  run: FilingRun,
  work: FilingWork,
  part: InboundMailPartRow,
  decision: InboundMailDecisionRow
): Promise<{ documentId: string; versionId: string | null } | null> {
  const { mail } = work
  if (!(await renewClaim(part.id, decision.id, new Date(Date.now() + FILING_CLAIM_MS)))) return null
  const fail = async (
    failure: Parameters<typeof returnPartToWaiting>[2],
    scan?: Parameters<typeof returnPartToWaiting>[3]
  ) => {
    await returnPartToWaiting(part.id, decision.id, failure, scan)
    return null
  }
  if (!part.storageKey) return fail('unavailable')
  const bytes = await readStagedObject(mail.stagingBucket, part.storageKey)
  if (!part.scannedAt || Date.now() - new Date(part.scannedAt).getTime() > RESCAN_AFTER_MS) {
    const scan = await scanForStorage(bytes)
    if (scan.status !== 'clean') return fail('scan_not_clean', scan)
    await recordFilingScan(part.id, decision.id, scan)
  }
  if (sha256(bytes) !== part.sha256) return fail('digest_mismatch')

  const folder = await ensureTargetFolder(run.session, run.projectId, {
    folderId: decision.folderId,
    folderPath: decision.folderId ? null : decision.folderPath,
  })
  if (!folder.ok) return fail(folder.failure)
  const thread = await threadOf(run, work)
  const documentType = documentTypeOf([decision.documentType ?? ''])
  const uploaded = await uploadOrFailure(async () =>
    uploadDocument(
      run.session,
      {
        projectId: run.projectId,
        folderId: folder.folderId,
        file: new File(
          [new Uint8Array(bytes)],
          decision.fileName ?? part.filename ?? `attachment-${part.position}`,
          { type: part.contentType }
        ),
        revisionOf: decision.targetDocumentId,
        screeningRelease: decision.screeningRelease,
        uploadBatchId: await attachmentBatch(run),
        ...(documentType ? { documentType } : {}),
        mailOrigin: mailOriginIngestFacts(messageOf(mail), {
          threadDocumentId: thread.documentId,
          locale: thread.locale,
        }),
      },
      run.request
    )
  )
  if (!uploaded.ok) return fail(uploaded.failure)

  const documentId = uploaded.value.documentId
  const version = (await findCurrentVersions([documentId], memberReader(run.session.userId))).get(
    documentId
  )
  const deferred =
    (await held(run)) ||
    (await eraseStagedObjects(mail.stagingBucket, [part.storageKey])).length > 0
  await markAttachmentFiled(part.id, decision.id, {
    documentId,
    versionId: version?.versionId ?? null,
    erasureDeferred: deferred,
  })
  return { documentId, versionId: version?.versionId ?? null }
}

/** File the mail's text into its thread (step 3), now that its attachments are decided. */
async function fileText(
  run: FilingRun,
  filedMail: InboundMailRow,
  part: InboundMailPartRow,
  decision: InboundMailDecisionRow
): Promise<'done' | 'busy'> {
  if (!(await renewClaim(part.id, decision.id, new Date(Date.now() + FILING_CLAIM_MS))))
    return 'done'
  const [fresh] = await findFilingWork(run.projectId, [filedMail.id])
  if (!fresh) return 'done'
  const { mail } = fresh
  if (!mail.readStorageKey) {
    await returnPartToWaiting(part.id, decision.id, 'unreadable')
    return 'done'
  }
  const read = mailReadSchema.parse(
    JSON.parse(
      new TextDecoder().decode(await readStagedObject(mail.stagingBucket, mail.readStorageKey))
    )
  )
  const folder =
    decision.threadAction === 'create'
      ? await ensureTargetFolder(run.session, run.projectId, {
          folderId: decision.folderId,
          folderPath: decision.folderId ? null : decision.folderPath,
        })
      : { ok: true as const, folderId: null }
  if (!folder.ok) {
    await returnPartToWaiting(part.id, decision.id, folder.failure)
    return 'done'
  }

  const outcome = await appendInboundMessage({
    session: run.session,
    mail,
    part,
    decision,
    read,
    form: {
      masked: decision.messageText === 'masked',
      rules: chatScreeningRules(
        await run.once('policy', () => gatePolicy(run.session.organizationId, run.projectId))
      ),
    },
    attachments: await attachmentFacts(run, fresh),
    folderTree: await run.once(
      'tree',
      async () =>
        new Map(
          (await listProjectFolderTree(run.session.organizationId, run.projectId)).map(
            (folder): [string, AccessFolder] => [folder.id, folder]
          )
        )
    ),
    newThreadFolderId: folder.folderId,
    newThreadLocale: await newThreadLocale(run),
    uploadBatchId: await threadBatch(run),
    request: run.request,
  })
  if (outcome.kind === 'busy') return 'busy'
  if (outcome.kind === 'failed') {
    await returnPartToWaiting(part.id, decision.id, outcome.failure)
    return 'done'
  }
  await finishOriginalMove(mail, { id: outcome.entryId, originalStorageKey: null })
  return 'done'
}

/** Every attachment of the mail with its decision and the document it is now, as the person reads it (for D36). */
async function attachmentFacts(run: FilingRun, work: FilingWork): Promise<AttachmentFact[]> {
  const attachments = work.parts.filter((part) => part.kind === 'attachment')
  const reader = memberReader(run.session.userId)
  const documentIds = attachments.flatMap((part) =>
    part.documentId
      ? [part.documentId]
      : part.duplicateOfDocumentId
        ? [part.duplicateOfDocumentId]
        : []
  )
  const [documents, versionTimes] = await Promise.all([
    findCurrentVersions(documentIds, reader),
    findVersionTimes(
      attachments.flatMap((part) => (part.documentVersionId ? [part.documentVersionId] : [])),
      reader
    ),
  ])
  return attachments.map((part) => {
    const decision = work.decisions.get(part.id) ?? null
    if (part.state === 'filed' && part.documentId) {
      const current = documents.get(part.documentId)
      return {
        part,
        decision,
        document: current
          ? {
              id: part.documentId,
              versionId: part.documentVersionId,
              versionCreatedAt: part.documentVersionId
                ? (versionTimes.get(part.documentVersionId) ?? null)
                : null,
              folderId: current.folderId,
            }
          : null,
      }
    }
    const duplicate = part.duplicateOfDocumentId
      ? documents.get(part.duplicateOfDocumentId)
      : undefined
    return {
      part,
      decision,
      document: duplicate
        ? {
            id: duplicate.documentId,
            versionId: duplicate.versionId,
            versionCreatedAt: duplicate.versionCreatedAt,
            folderId: duplicate.folderId,
          }
        : null,
    }
  })
}

/** Attachments filed after their mail's text: the entry's `pending` rows learn their documents (step 4). */
async function linkLateAttachments(
  run: FilingRun,
  mail: InboundMailRow,
  filed: ReadonlyArray<{ part: InboundMailPartRow; documentId: string; versionId: string | null }>
): Promise<void> {
  if (filed.length === 0) return
  const entry = await findEntryOfMail(run.projectId, mail.id)
  if (!entry) return
  const times = await findVersionTimes(
    filed.flatMap((item) => (item.versionId ? [item.versionId] : [])),
    memberReader(run.session.userId)
  )
  for (const item of filed) {
    const createdAt = item.versionId ? times.get(item.versionId) : undefined
    const present = Boolean(createdAt && createdAt < new Date(mail.receivedAt))
    await decidePendingAttachment(entry.id, item.part.position, {
      disposition: present ? 'already_present' : 'filed',
      documentId: item.documentId,
      versionId: item.versionId,
    })
  }
}

/** Step 5: a mail every part of which is filed is scrubbed, its staged objects erased by key (or kept under a hold). */
async function settleIfFiled(run: FilingRun, mailId: string): Promise<void> {
  const [work] = await findFilingWork(run.projectId, [mailId])
  if (!work || work.parts.some((part) => part.state !== 'filed')) return
  const { mail } = work
  // A raw message still moving to its entry's original is the move's to erase.
  const keys = [mail.readStorageKey, mail.originalMovePendingAt ? null : mail.rawStorageKey].filter(
    (key): key is string => key !== null
  )
  const deferred =
    (await held(run)) || (await eraseStagedObjects(mail.stagingBucket, keys)).length > 0
  if (!(await settleFiledMail(mail, deferred))) return
  await bestEffortInbox(
    `inbound_mail.waiting settled for mail ${mail.id}`,
    run.session.organizationId,
    () =>
      resolveInboxItemsAnchoredOn({
        organizationId: run.session.organizationId,
        types: ['inbound_mail.waiting'],
        anchorId: mail.id,
      })
  )
}
