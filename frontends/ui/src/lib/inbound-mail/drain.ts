/**
 * The drain: file the mail the webhook queued (ADR-0074).
 *
 * The scheduler container POSTs `/api/internal/inbound-mail/drain` every tick,
 * the way it already drives the run reconciler. One call reaps the attempts
 * whose heartbeat stopped, files up to {@link DRAIN_MAX_ROWS} due deliveries
 * within {@link DRAIN_BUDGET_MS}, and sweeps retention.
 *
 * ## One delivery, one attempt
 *
 * The claim (`claimNextDelivery`) is cross-tenant and hands the attempt a
 * fresh `claim_token`; everything after it runs inside `withTenant` for the
 * row's organization, and every write names the token. An attempt that finds
 * its token gone (it stalled, was reaped, and another attempt took the row)
 * stops without writing another word.
 *
 * Filing goes through `uploadDocument` as the pinned sender, with
 * `onNameTaken: 'suffix'`, into the delivery's own folder: the folder the
 * first attempt created and recorded on the row, reused by every later one.
 * So a retry re-files every staged object and the ones already there answer
 * `unchanged`: the attempt needs no memory of how far the last one got.
 *
 * ## What skips a file and what fails the attempt
 *
 * Only `type`, `size` and `quota` are verdicts about the FILE and skip it.
 * Everything else, a 403 or 404 included (a folder deleted mid-run, an FGA
 * blip read as a denial), fails the attempt: it is retried with backoff, and
 * after {@link MAX_ATTEMPTS} the row is `failed`, its staging deleted and the
 * sender told. A rate-limit refusal is a backoff too, never a skip.
 */

import 'server-only'
import { createHash } from 'node:crypto'
import { BadRequestError, InsufficientStorageError } from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { SkippedAttachment, StagedAttachment } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { uploadDocument } from '@/lib/documents/service'
import { DOCUMENT_UPLOAD_LIMIT, enforceLimit, memberSubject } from '@/lib/limits'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { isProjectMailInboxEnabledForOrg } from '@/lib/workos/feature-flags'
import { createMailFolder } from './filing-folder'
import { notifyFailed, notifyFiled } from './notify'
import {
  claimNextDelivery,
  clearExpiredStaging,
  deleteDeliveriesOlderThan,
  findExpiredStaging,
  heartbeat,
  markDeliveryFailed,
  markDeliveryFiled,
  reapStaleClaims,
  recordDeliveryFolder,
  releaseClaim,
  scheduleRetry,
  type ClaimedDelivery,
  type DeliveryOutcome,
} from './repository'
import { deleteStagedObjects, errorName, readStagedObject } from './staging'
import type { SkipReason } from './types'

/** Attempts before a delivery is given up on. */
export const MAX_ATTEMPTS = 8

/**
 * The wait after the n-th failed attempt, in minutes: 1, 5, 30 minutes, then
 * 1, 3, 6 and 12 hours. The eighth failure is the last, about 22.6 hours
 * after the first: a WorkOS or storage outage of most of a day is survived,
 * and a mail that cannot be filed is reported the same day it was sent.
 */
export const BACKOFF_MINUTES = [1, 5, 30, 60, 180, 360, 720] as const

/** Deliveries one call files at most, and the time after which it claims no more. */
export const DRAIN_MAX_ROWS = 10
export const DRAIN_BUDGET_MS = 45_000

/** How long a delivery waits while its organization's switch is off. */
const HOLD_SECONDS = 60 * 60

/** Rows with expired staging one call cleans up. */
const STAGING_SWEEP_BATCH = 20

export interface DrainResult {
  reaped: number
  filed: number
  retried: number
  failed: number
  held: number
  lost: number
  stagingExpired: number
  deleted: number
}

type Verdict = 'filed' | 'retried' | 'failed' | 'held' | 'lost'

/** The attempt no longer owns its row: stop, and write nothing more. */
class LostClaimError extends Error {
  constructor() {
    super('The delivery was claimed by another attempt')
    this.name = 'LostClaimError'
  }
}

/** A failure of the attempt that is not an error object: a code for the row and the log. */
class AttemptFailure extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AttemptFailure'
  }
}

/** One drain pass. Never throws for one delivery's failure; the counts say what happened. */
export async function drainInboundMail(): Promise<DrainResult> {
  const result: DrainResult = {
    reaped: await withPlatformAccess('inbound mail drain: attempts of every organization whose heartbeat stopped', () =>
      reapStaleClaims()
    ),
    filed: 0,
    retried: 0,
    failed: 0,
    held: 0,
    lost: 0,
    stagingExpired: 0,
    deleted: 0,
  }
  const deadline = Date.now() + DRAIN_BUDGET_MS
  for (let taken = 0; taken < DRAIN_MAX_ROWS && Date.now() < deadline; taken += 1) {
    const row = await withPlatformAccess('inbound mail drain: the next due delivery of any organization', () =>
      claimNextDelivery()
    )
    if (!row) break
    result[await drainDelivery(row)] += 1
  }
  await sweepRetention(result)
  return result
}

/** One claimed delivery, inside its own organization. */
export async function drainDelivery(row: ClaimedDelivery): Promise<Verdict> {
  const started = Date.now()
  let verdict: Verdict = 'lost'
  let detail: string | null = null
  try {
    verdict = await withTenant({ organizationId: row.organizationId, userId: row.senderUserId }, () =>
      attemptDelivery(row)
    )
  } catch (error) {
    detail = errorName(error)
    verdict = error instanceof LostClaimError ? 'lost' : await afterFailure(row, error)
  } finally {
    logAttempt(row, verdict, detail, Date.now() - started)
  }
  return verdict
}

async function attemptDelivery(row: ClaimedDelivery): Promise<Verdict> {
  const switchOn = await isProjectMailInboxEnabledForOrg(row.organizationId).catch(() => null)
  if (switchOn !== true) {
    // Off holds the mail for an hour; unknown (WorkOS unreachable) for the
    // shortest backoff. Neither spends an attempt: neither is the mail's fault.
    const seconds = switchOn === false ? HOLD_SECONDS : BACKOFF_MINUTES[0] * 60
    if (!(await releaseClaim(row.id, row.claimToken, seconds))) throw new LostClaimError()
    return 'held'
  }
  if (row.attempts > MAX_ATTEMPTS) {
    // Reaped after its last attempt died mid-run: nothing is left to try.
    return giveUp(row, 'attempts')
  }
  const filing = await fileDelivery(row)
  const remaining = await deleteStagedObjects(row.stagingBucket, row.staged)
  const outcome: DeliveryOutcome = { filedCount: filing.filed, skipped: filing.skipped, remaining }
  if (!(await markDeliveryFiled(row.id, row.claimToken, outcome))) throw new LostClaimError()
  await notifyFiled(row, filing)
  return 'filed'
}

/** A failed attempt: back off, or give up after the last one. */
async function afterFailure(row: ClaimedDelivery, error: unknown): Promise<Verdict> {
  const code = error instanceof AttemptFailure ? error.code : errorName(error)
  try {
    return await withTenant({ organizationId: row.organizationId, userId: row.senderUserId }, async () => {
      if (row.attempts >= MAX_ATTEMPTS) return giveUp(row, code)
      const delay = BACKOFF_MINUTES[Math.min(row.attempts, BACKOFF_MINUTES.length) - 1] * 60
      if (!(await scheduleRetry(row.id, row.claimToken, delay, code))) throw new LostClaimError()
      return 'retried' as const
    })
  } catch (followUp) {
    // Recording the failure failed too (the database is gone, or the claim
    // moved on). The row stays `processing` and the reaper hands it back.
    return followUp instanceof LostClaimError ? 'lost' : 'retried'
  }
}

async function giveUp(row: ClaimedDelivery, code: string): Promise<Verdict> {
  const remaining = await deleteStagedObjects(row.stagingBucket, row.staged)
  const outcome: DeliveryOutcome = { filedCount: 0, skipped: row.skipped, remaining, lastError: code }
  if (!(await markDeliveryFailed(row.id, row.claimToken, outcome))) throw new LostClaimError()
  await notifyFailed(row)
  return 'failed'
}

function logAttempt(row: ClaimedDelivery, verdict: Verdict, detail: string | null, ms: number): void {
  const line =
    `[inbound-mail] drain outcome=${verdict} address=${row.addressId} row=${row.id} ` +
    `attempt=${row.attempts} files=${row.staged.length} skipped=${row.skipped.length} ms=${ms}` +
    (detail ? ` error=${detail}` : '')
  if (verdict === 'filed' || verdict === 'held') {
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

async function fileDelivery(row: ClaimedDelivery): Promise<Filing> {
  const skipped: SkippedAttachment[] = [...row.skipped]
  if (row.staged.length === 0) return { filed: 0, skipped, folderId: row.folderId }
  const session = await senderSession(row)
  const folderId = await deliveryFolder(row, session)
  let filed = 0
  for (const object of row.staged) {
    const reason = await fileOne(row, session, folderId, object)
    if (reason) skipped.push({ filename: object.filename, reason })
    else filed += 1
    if (!(await heartbeat(row.id, row.claimToken))) throw new LostClaimError()
  }
  return { filed, skipped, folderId }
}

/** The sender as they are NOW: a member who left, or a lookup that failed, fails the attempt. */
async function senderSession(row: ClaimedDelivery): Promise<AuthorizedSession> {
  const person = (await loadOrganizationDirectory(row.organizationId)).get(row.senderUserId)
  const session = await resolvePinnedRequesterSession(
    { userId: row.senderUserId, email: person?.email ?? null, organizationId: row.organizationId },
    { onError: 'throw' }
  )
  if (!session) throw new AttemptFailure('sender-not-member')
  return session
}

/** The folder the first attempt created, or a new one it records for every later attempt. */
async function deliveryFolder(row: ClaimedDelivery, session: AuthorizedSession): Promise<string> {
  if (row.folderId) return row.folderId
  const folderId = await createMailFolder(session, row.projectId, row.folderName)
  if (!(await recordDeliveryFolder(row.id, row.claimToken, folderId))) throw new LostClaimError()
  return folderId
}

/** File one staged object; `null` when it landed (or was already there), else why not. */
async function fileOne(
  row: ClaimedDelivery,
  session: AuthorizedSession,
  folderId: string,
  object: StagedAttachment
): Promise<SkipReason | null> {
  // The upload routes charge this per request; mail charges it per file, to
  // the same member subject, so mail is not a way around it.
  await enforceLimit(DOCUMENT_UPLOAD_LIMIT, memberSubject(session))
  const bytes = await readStagedObject(row.stagingBucket ?? '', object.key)
  if (createHash('sha256').update(bytes).digest('hex') !== object.sha256) {
    throw new AttemptFailure('staged-digest-mismatch')
  }
  const file = new File([bytes], object.filename, { type: object.contentType })
  try {
    await uploadDocument(session, {
      projectId: row.projectId,
      folderId,
      file,
      onNameTaken: 'suffix',
      audit: { channel: 'inbound-mail', ref: row.id },
    })
    return null
  } catch (error) {
    const reason = skipReason(error)
    if (!reason) throw error
    return reason
  }
}

/**
 * The three refusals that are a verdict about the file itself. Anything else
 * `uploadDocument` throws fails the attempt.
 */
export function skipReason(error: unknown): SkipReason | null {
  if (error instanceof InsufficientStorageError) return 'quota'
  if (!(error instanceof BadRequestError)) return null
  const details = error.details
  if (details && typeof details === 'object' && 'maxSizeBytes' in details) return 'size'
  if (details && typeof details === 'object' && 'extension' in details) return 'type'
  return null
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Staging older than seven days is deleted whatever its row says (a row still
 * queued then fails, and its sender is told), and rows older than thirty days
 * are deleted. Failures are logged and left for the next tick.
 */
async function sweepRetention(result: DrainResult): Promise<void> {
  try {
    result.stagingExpired = await expireStagingBatch()
    result.deleted = await withPlatformAccess('inbound mail drain: delivery rows past their thirty days', () =>
      deleteDeliveriesOlderThan()
    )
  } catch (error) {
    console.error(`[inbound-mail] retention sweep failed error=${errorName(error)}`)
  }
}

async function expireStagingBatch(): Promise<number> {
  const expired = await withPlatformAccess('inbound mail drain: staging past its seven days', () =>
    findExpiredStaging(STAGING_SWEEP_BATCH)
  )
  let cleared = 0
  for (const row of expired) {
    if (await expireStaging(row)) cleared += 1
  }
  return cleared
}

async function expireStaging(row: Awaited<ReturnType<typeof findExpiredStaging>>[number]): Promise<boolean> {
  return withTenant({ organizationId: row.organizationId }, async () => {
    const remaining = await deleteStagedObjects(row.stagingBucket, row.staged)
    const applied = await clearExpiredStaging(row, remaining)
    if (applied && row.status === 'queued') await notifyFailed(row)
    return applied
  })
}
