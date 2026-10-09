/**
 * Filing the mail the webhook queued (ADR-0075), one delivery per job on the
 * BFF's job queue (ADR-0079).
 *
 * The webhook stages a mail's attachments, queues its `inbound_mail_messages`
 * row and enqueues an `inbound_mail` job for it (`./receive`). A `bff-jobs`
 * worker claims the job and calls {@link runInboundMailJob}, inside the
 * delivery's organization. The queue owns the claim, the heartbeat and the
 * worker that died; the row owns what outlives one job.
 *
 * ## One delivery, one attempt per job
 *
 * Filing goes through the one mail filer (`lib/mail-import/filing.ts`, the
 * Outlook import's) as the sender: a folder `E-Mail-Eingang/<date> – <sender>`
 * with the first free name, made by the first attempt and recorded on the row
 * so every later attempt reuses it, and each file under the mail's folder name
 * and its own (`<date> – <sender> – Plan.pdf`), numbered where it still
 * collides. A retry re-files every staged object; the ones already in the
 * folder come back as the same document, `unchanged` when their bytes match.
 *
 * Every write is conditional on the row still being `queued`, so a second job
 * for one delivery (the sweep re-queued it while the first was slow) changes
 * nothing once the first has finished it.
 *
 * ## Retries are the row's, not the queue's
 *
 * A failed attempt counts on the row and hands the delivery to a FRESH job
 * that waits out the next backoff ({@link BACKOFF_MINUTES}); the job itself
 * always ends. The queue's own retries are seconds to minutes apart and spent
 * per job, so leaning on them would give up on a mail during a WorkOS or
 * storage outage of an hour. After {@link MAX_ATTEMPTS} the row is `failed`,
 * its staging deleted and the sender told. A worker that dies mid-job is the
 * queue's to retry; a delivery whose job is gone for good is the sweep's
 * ({@link sweepInboundMail}).
 *
 * ## What skips a file and what fails the attempt
 *
 * Only `type`, `size` (the organization's upload limit), `screened` (the
 * office's name screening, ADR-0086) and `quota` are verdicts about the FILE
 * and skip it, as they do for an imported mail. Everything else, a 403 or 404
 * included (a folder deleted or turned read-only mid-run, an FGA blip read as
 * a denial), fails the attempt. A rate-limit refusal is a backoff too, never a
 * skip.
 */

import 'server-only'
import { createHash } from 'node:crypto'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { InboundMailMessageRow, MailImportSkipReason, SkippedAttachment, StagedAttachment } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { resolveShelfFolderPath } from '@/lib/documents/folder-path'
import { projectShelf } from '@/lib/documents/shelf'
import { requireShelfWrite } from '@/lib/documents/shelf-authz'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import { BFF_JOB_PRIORITY, type InboundMailPayload } from '@/lib/jobs-queue/types'
import { DOCUMENT_UPLOAD_LIMIT, enforceLimit, memberSubject } from '@/lib/limits'
import {
  createFolderWithFreeName,
  fileBytes,
  MailImportQuotaError,
  type AttachmentOutcome,
  type MailFilingTarget,
  type MailFolder,
} from '@/lib/mail-import/filing'
import { attachmentFilename } from '@/lib/mail-import/naming'
import { getOrCreateProjectFolderByName } from '@/lib/projects/folder-service'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { isProjectMailInboxEnabledForOrg } from '@/lib/workos/feature-flags'
import { notifyFailed, notifyFiled } from './notify'
import {
  clearExpiredStaging,
  deleteDeliveriesOlderThan,
  findDeliveryRow,
  findExpiredStaging,
  listStalledDeliveries,
  markDeliveryFailed,
  markDeliveryFiled,
  recordDeliveryFolder,
  recordFailedAttempt,
  touchDelivery,
  type DeliveryOutcome,
} from './repository'
import { deleteStagedObjects, errorName, readStagedObject } from './staging'
import type { SkipReason } from './types'

/** The top-level folder every mail is filed under. */
export const INBOUND_MAIL_ROOT_FOLDER = 'E-Mail-Eingang'

/** Attempts before a delivery is given up on. */
export const MAX_ATTEMPTS = 8

/**
 * The wait after the n-th failed attempt, in minutes: 1, 5, 30 minutes, then
 * 1, 3, 6 and 12 hours. The eighth failure is the last, about 22.6 hours
 * after the first: a WorkOS or storage outage of most of a day is survived,
 * and a mail that cannot be filed is reported the same day it was sent.
 */
export const BACKOFF_MINUTES = [1, 5, 30, 60, 180, 360, 720] as const

/** How long a delivery waits while its organization's switch is off. */
const HOLD_MINUTES = 60

/** A queued delivery without progress for this long is checked for a live job. */
export const STALLED_DELIVERY_MINUTES = 15

/** Rows one sweep looks at, per part. */
const SWEEP_BATCH = 20

/** The audit trail reads an IP and a user agent off the request; a job has neither, so it names itself. */
const JOB_REQUEST_URL = 'http://bff-jobs.internal/inbound-mail'

type Verdict = 'filed' | 'retried' | 'failed' | 'held' | 'gone'

/** The delivery moved on under this job (another job finished it): stop, and write nothing more. */
class DeliveryMovedOnError extends Error {
  constructor() {
    super('The delivery is no longer queued')
    this.name = 'DeliveryMovedOnError'
  }
}

/** A failure of the attempt that is not an error object: a code for the row and the log. */
class AttemptFailure extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AttemptFailure'
  }
}

/** Hand the delivery to a job, now or after a backoff. Inside the delivery's organization. */
export async function enqueueDelivery(
  organizationId: string,
  payload: InboundMailPayload,
  notBefore?: Date
): Promise<void> {
  await enqueueJob({
    kind: 'inbound_mail',
    organizationId,
    // A person sent this and is waiting for the files; ahead of a reindex.
    priority: BFF_JOB_PRIORITY.interactive,
    payload,
    notBefore,
  })
}

/**
 * One job: one attempt at one delivery. Throws only when even recording the
 * outcome failed, which the queue retries.
 */
export async function runInboundMailJob(organizationId: string, payload: InboundMailPayload): Promise<Verdict> {
  const row = await findDeliveryRow(organizationId, payload.deliveryId)
  if (!row || row.status !== 'queued') return 'gone'
  const started = Date.now()
  let verdict: Verdict = 'gone'
  let detail: string | null = null
  try {
    verdict = await withTenant({ organizationId, userId: row.senderUserId }, () => attemptDelivery(row))
  } catch (error) {
    if (error instanceof DeliveryMovedOnError) return 'gone'
    detail = error instanceof AttemptFailure ? error.code : errorName(error)
    verdict = await afterFailure(row, detail)
  } finally {
    logAttempt(row, verdict, detail, Date.now() - started)
  }
  return verdict
}

async function attemptDelivery(row: InboundMailMessageRow): Promise<Verdict> {
  const switchOn = await isProjectMailInboxEnabledForOrg(row.organizationId).catch(() => null)
  if (switchOn !== true) {
    // Off holds the mail for an hour; unknown (WorkOS unreachable) for the
    // shortest backoff. Neither counts as an attempt: neither is the mail's fault.
    const minutes = switchOn === false ? HOLD_MINUTES : BACKOFF_MINUTES[0]
    await enqueueDelivery(row.organizationId, payloadOf(row), minutesFromNow(minutes))
    return 'held'
  }
  const filing = await fileDelivery(row)
  const remaining = await deleteStagedObjects(row.stagingBucket, row.staged)
  const outcome: DeliveryOutcome = { filedCount: filing.filed, skipped: filing.skipped, remaining }
  if (!(await markDeliveryFiled(row.organizationId, row.id, outcome))) throw new DeliveryMovedOnError()
  await notifyFiled(row, filing)
  return 'filed'
}

/**
 * A failed attempt: count it and hand the delivery to a job that waits out the
 * next backoff, or give up after the last one. Inside the delivery's
 * organization. A failure to record it throws, and the queue retries the job.
 */
async function afterFailure(row: InboundMailMessageRow, code: string): Promise<Verdict> {
  return withTenant({ organizationId: row.organizationId, userId: row.senderUserId }, async () => {
    const attempts = row.attempts + 1
    if (attempts >= MAX_ATTEMPTS) return giveUp(row, code)
    if (!(await recordFailedAttempt(row.organizationId, row.id, attempts, code))) return 'gone'
    await enqueueDelivery(row.organizationId, payloadOf(row), minutesFromNow(BACKOFF_MINUTES[attempts - 1]))
    return 'retried'
  })
}

async function giveUp(row: InboundMailMessageRow, code: string): Promise<Verdict> {
  const remaining = await deleteStagedObjects(row.stagingBucket, row.staged)
  const outcome: DeliveryOutcome = { filedCount: 0, skipped: row.skipped, remaining, lastError: code }
  if (!(await markDeliveryFailed(row.organizationId, row.id, outcome))) return 'gone'
  await notifyFailed(row)
  return 'failed'
}

function payloadOf(row: Pick<InboundMailMessageRow, 'id' | 'projectId'>): InboundMailPayload {
  return { deliveryId: row.id, projectId: row.projectId }
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000)
}

function logAttempt(row: InboundMailMessageRow, verdict: Verdict, detail: string | null, ms: number): void {
  const line =
    `[inbound-mail] job outcome=${verdict} address=${row.addressId} row=${row.id} ` +
    `attempt=${row.attempts + 1} files=${row.staged.length} skipped=${row.skipped.length} ms=${ms}` +
    (detail ? ` error=${detail}` : '')
  if (verdict === 'filed' || verdict === 'held' || verdict === 'gone') {
    // The operator trail (D-7): one INFO line per delivery, which the container
    // log collector keeps. WARN would file every accepted mail as a problem.
    // eslint-disable-next-line no-console
    console.info(line)
  } else if (verdict === 'failed') console.error(line)
  else console.warn(line)
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

export interface Filing {
  filed: number
  skipped: SkippedAttachment[]
  folderId: string | null
}

async function fileDelivery(row: InboundMailMessageRow): Promise<Filing> {
  const skipped: SkippedAttachment[] = [...row.skipped]
  if (row.staged.length === 0) return { filed: 0, skipped, folderId: row.folderId }
  const session = await senderSession(row)
  const target: MailFilingTarget = {
    session,
    projectId: row.projectId,
    request: new Request(JOB_REQUEST_URL, { headers: { 'user-agent': 'piloti-inbound-mail' } }),
    priority: 'interactive',
    audit: { channel: 'inbound-mail', ref: row.id },
  }
  const folder = await deliveryFolder(row, target)
  // Names this mail has taken so far: the second `scan.pdf` of one mail is
  // `scan (2).pdf`, not a new version of the first.
  const claimed = new Set<string>()
  let filed = 0
  for (const object of row.staged) {
    const reason = await fileOne(row, target, folder, object, claimed)
    if (reason) skipped.push({ filename: object.filename, reason })
    else filed += 1
    if (!(await touchDelivery(row.organizationId, row.id))) throw new DeliveryMovedOnError()
  }
  return { filed, skipped, folderId: folder.id }
}

/** The sender as they are NOW: a member who left, or a lookup that failed, fails the attempt. */
async function senderSession(row: InboundMailMessageRow): Promise<AuthorizedSession> {
  const person = (await loadOrganizationDirectory(row.organizationId)).get(row.senderUserId)
  const session = await resolvePinnedRequesterSession(
    { userId: row.senderUserId, email: person?.email ?? null, organizationId: row.organizationId },
    { onError: 'throw' }
  )
  if (!session) throw new AttemptFailure('sender-not-member')
  return session
}

/**
 * The folder the first attempt created, or a new one it records for every
 * later attempt: `E-Mail-Eingang/<leaf>`, or `<leaf> (2)` when another mail
 * (or a person) already has the name. Authorizes the sender first: the root
 * folder is made by a resolver that trusts its caller to have done so.
 */
async function deliveryFolder(row: InboundMailMessageRow, target: MailFilingTarget): Promise<MailFolder> {
  if (row.folderId) {
    // Gone when somebody deleted it meanwhile (the foreign key nulls the
    // column too): this attempt makes a new one, as the first would have.
    const path = await resolveShelfFolderPath(projectShelf(row.projectId), row.folderId, row.organizationId)
    if (path !== null) return { id: row.folderId, name: path.split('/').pop() ?? path }
  }
  await requireShelfWrite(target.session, projectShelf(row.projectId))
  const root = await getOrCreateProjectFolderByName(row.projectId, INBOUND_MAIL_ROOT_FOLDER, row.organizationId)
  const folder = await createFolderWithFreeName(target, root.id, row.folderName)
  if (!(await recordDeliveryFolder(row.organizationId, row.id, folder.id))) throw new DeliveryMovedOnError()
  return folder
}

/** File one staged object; `null` when it landed (or was already there), else why not. */
async function fileOne(
  row: InboundMailMessageRow,
  target: MailFilingTarget,
  folder: MailFolder,
  object: StagedAttachment,
  claimed: Set<string>
): Promise<SkipReason | null> {
  // The upload routes charge this per request; mail charges it per file, to
  // the same member subject, so mail is not a way around it.
  await enforceLimit(DOCUMENT_UPLOAD_LIMIT, memberSubject(target.session))
  const bytes = await readStagedObject(row.stagingBucket ?? '', object.key)
  if (createHash('sha256').update(bytes).digest('hex') !== object.sha256) {
    throw new AttemptFailure('staged-digest-mismatch')
  }
  const desired = attachmentFilename(folder.name, object.filename)
  let outcome: AttachmentOutcome
  try {
    outcome = await fileBytes(target, folder.id, desired, bytes, object.contentType, claimed)
  } catch (error) {
    if (error instanceof MailImportQuotaError) return 'quota'
    throw error
  }
  return outcome.filed ? null : skipReasonOf(outcome.reason)
}

/**
 * A refusal of the upload path as the sender's skip reason. A read-only folder
 * (ADR-0088) and a name taken between the probe and the upload (ADR-0087) are
 * not about the file: they fail the attempt, and the retry decides again.
 */
function skipReasonOf(reason: MailImportSkipReason): SkipReason {
  if (reason === 'type' || reason === 'size' || reason === 'screened') return reason
  throw new AttemptFailure(`upload-refused-${reason}`)
}

// ---------------------------------------------------------------------------
// The sweep: deliveries without a job, and retention
// ---------------------------------------------------------------------------

export interface InboundMailSweepResult {
  requeued: number
  waiting: number
  failed: number
  stagingExpired: number
  deleted: number
  errors: number
}

/**
 * What the background-work sweep does for the inbox, every scheduler tick
 * (`/api/internal/maintenance/reconcile-background-work`):
 *
 *   - a `queued` delivery that has made no progress for
 *     {@link STALLED_DELIVERY_MINUTES} and has no live job (the enqueue after
 *     the webhook failed, or its job died with its attempts spent) gets a new
 *     one, counted as a failed attempt so a delivery that kills its worker
 *     still reaches the give-up;
 *   - staging older than seven days is deleted whatever its row says (a row
 *     still queued then fails, and its sender is told);
 *   - rows older than thirty days are deleted.
 *
 * Discovery under the platform bypass, each delivery's work inside its own
 * organization. A failure of one row is counted and left for the next tick.
 */
export async function sweepInboundMail(now: Date = new Date()): Promise<InboundMailSweepResult> {
  const result: InboundMailSweepResult = { requeued: 0, waiting: 0, failed: 0, stagingExpired: 0, deleted: 0, errors: 0 }
  const before = new Date(now.getTime() - STALLED_DELIVERY_MINUTES * 60_000)
  const stalled = await withPlatformAccess('inbound mail sweep: queued deliveries of every organization without progress', () =>
    listStalledDeliveries(before, SWEEP_BATCH)
  )
  for (const row of stalled) {
    try {
      const verdict = await withTenant({ organizationId: row.organizationId }, () => settleStalled(row))
      if (verdict !== 'gone') result[verdict] += 1
    } catch (error) {
      console.error(`[inbound-mail] could not settle a stalled delivery row=${row.id} error=${errorName(error)}`)
      result.errors += 1
    }
  }
  result.stagingExpired = await expireStagingBatch(result)
  result.deleted = await withPlatformAccess('inbound mail sweep: delivery rows past their thirty days', () =>
    deleteDeliveriesOlderThan()
  )
  return result
}

async function settleStalled(row: InboundMailMessageRow): Promise<'requeued' | 'waiting' | 'failed' | 'gone'> {
  const job = await findOpenJobId({
    kind: 'inbound_mail',
    organizationId: row.organizationId,
    matching: { deliveryId: row.id },
  })
  if (job) {
    // Waiting out a backoff or a hold is progress enough: touched, it leaves
    // the front of the stalled list, so a mail whose job really is gone is not
    // starved behind twenty that are only waiting.
    await touchDelivery(row.organizationId, row.id)
    return 'waiting'
  }
  const attempts = row.attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    const verdict = await giveUp(row, 'job-lost')
    return verdict === 'failed' ? 'failed' : 'gone'
  }
  if (!(await recordFailedAttempt(row.organizationId, row.id, attempts, 'job-lost'))) return 'gone'
  await enqueueDelivery(row.organizationId, payloadOf(row))
  return 'requeued'
}

async function expireStagingBatch(result: InboundMailSweepResult): Promise<number> {
  const expired = await withPlatformAccess('inbound mail sweep: staging past its seven days', () =>
    findExpiredStaging(SWEEP_BATCH)
  )
  let cleared = 0
  for (const row of expired) {
    try {
      if (await withTenant({ organizationId: row.organizationId }, () => expireStaging(row))) cleared += 1
    } catch (error) {
      console.error(`[inbound-mail] could not expire the staging of row=${row.id} error=${errorName(error)}`)
      result.errors += 1
    }
  }
  return cleared
}

async function expireStaging(row: InboundMailMessageRow): Promise<boolean> {
  const remaining = await deleteStagedObjects(row.stagingBucket, row.staged)
  const applied = await clearExpiredStaging(row, remaining)
  if (applied && row.status === 'queued') await notifyFailed(row)
  return applied
}
