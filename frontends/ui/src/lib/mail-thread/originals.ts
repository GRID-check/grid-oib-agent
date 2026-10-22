import 'server-only'
/**
 * A filed message's original `.eml` (ADR-0134, D6): evidence, kept beside its
 * section of the E-Mail-Verlauf, never a document, never indexed, never read
 * by a model.
 *
 * **The move** ({@link finishOriginalMove}). Filing a message marks its mail's
 * raw message as moving (`inbound_mails.original_move_pending_at`, in the
 * commit of the entry); this copies it to `_mail-originals/<entryId>.eml` in
 * the same bucket, reads the copy back and checks its SHA-256, records it on
 * the entry, and only then erases the staged raw by its key and forgets the
 * key. Every step finds what the step before it left, so a run that stopped
 * anywhere is finished by the next run of the filing job or by sweep 13, and
 * no step loses the bytes: the raw is erased only once the copy is proven.
 *
 * **The download** ({@link readEntryOriginal}). Anyone who may read the
 * Verlauf may download it (D9): the office's `inbound-mail` entitlement,
 * `project:view`, and the thread document screened, live and in a folder they
 * may open. It is scanned WHOLE on every request (C5, `ScanMail`, so clamd
 * opens the MIME tree itself): signatures change, and a verdict from the day it
 * arrived says nothing about today. Served only on a clean answer (409
 * `original_not_clean` otherwise), never sniffed or run, and audited
 * (`mail_thread.original_read`); a rate limit bounds the scanning
 * (`MAIL_ORIGINAL_DOWNLOAD_LIMIT`). No agent door offers it (withheld,
 * `evidence`).
 */

import { createHash } from 'node:crypto'
import { captureServer } from '@/lib/analytics/posthog-server'
import { NotFoundError } from '@/lib/api/errors'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { InboundMailRow, MailThreadEntryRow } from '@/lib/db/schema'
import { requireInboundMailEnabled } from '@/lib/inbound-mail/access'
import { refusal } from '@/lib/inbound-mail/decision'
import { mailOriginalStorageKey } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import { scanForStorage } from '@/lib/inbound-mail/malware-scan'
import { heldBytesHeaders } from '@/lib/inbound-mail/service'
import {
  eraseStagedObjects,
  putStagedObject,
  RAW_MESSAGE_CONTENT_TYPE,
  readStagedObject,
} from '@/lib/inbound-mail/staging'
import { findVisibleThread } from './repository'
import { findEntry, forgetMovedRaw, recordEntryOriginal } from './write-repository'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** The raw message's scan as an entry's original keeps it: the verdict it was shown with. */
function originalScanOf(
  mail: Pick<InboundMailRow, 'rawScanStatus' | 'rawScannedAt'>
): Pick<MailThreadEntryRow, 'originalScanStatus' | 'originalScannedAt'> {
  return {
    originalScanStatus: mail.rawScanStatus,
    originalScannedAt: mail.rawScanStatus === 'pending' ? null : mail.rawScannedAt,
  }
}

/**
 * Move a filed message's raw message to its entry's original, retry-safe (see
 * the module header). `mail` is the row as the caller read it; `entry` the
 * entry the mail was filed as. Throws when a store step fails or the copy does
 * not read back as the bytes, for the caller's queue to retry; the raw stays.
 */
export async function finishOriginalMove(
  mail: Pick<
    InboundMailRow,
    | 'id'
    | 'organizationId'
    | 'projectId'
    | 'stagingBucket'
    | 'rawStorageKey'
    | 'rawScanStatus'
    | 'rawScannedAt'
  >,
  entry: Pick<MailThreadEntryRow, 'id' | 'originalStorageKey'>
): Promise<'moved' | 'already'> {
  if (!mail.rawStorageKey) return 'already'
  if (!entry.originalStorageKey) {
    const bytes = await readStagedObject(mail.stagingBucket, mail.rawStorageKey)
    const digest = sha256(bytes)
    const key = mailOriginalStorageKey(mail, entry.id)
    await putStagedObject(mail.stagingBucket, key, bytes, RAW_MESSAGE_CONTENT_TYPE)
    const copy = await readStagedObject(mail.stagingBucket, key)
    if (copy.byteLength !== bytes.byteLength || sha256(copy) !== digest) {
      throw new Error(
        `the original of mail ${mail.id} did not read back as written; the raw message stays`
      )
    }
    await recordEntryOriginal(entry.id, {
      originalBucket: mail.stagingBucket,
      originalStorageKey: key,
      originalSha256: digest,
      originalBytes: bytes.byteLength,
      ...originalScanOf(mail),
    })
  }
  const left = await eraseStagedObjects(mail.stagingBucket, [mail.rawStorageKey])
  if (left.length > 0)
    throw new Error(
      `the staged raw message of mail ${mail.id} could not be erased yet; the next run tries again`
    )
  await forgetMovedRaw(mail.id)
  return 'moved'
}

/** The entry of a thread the reader may read, or 404. */
async function readableEntry(
  session: AuthorizedSession,
  projectId: string,
  threadId: string,
  entryId: string
): Promise<MailThreadEntryRow> {
  requireInboundMailEnabled(session)
  await requireProjectAccess(session, projectId, 'project:view')
  const thread = await findVisibleThread(
    projectId,
    threadId,
    await getHiddenFolderIds(session, projectId)
  )
  const entry = thread ? await findEntry(projectId, entryId) : null
  if (!entry || entry.threadId !== threadId) throw new NotFoundError('Mail not found')
  return entry
}

/**
 * The original `.eml` of a filed message (`mail-thread-entry-original-get`),
 * scanned whole on this request (see the module header). 404 for a message
 * whose thread the reader may not read; `gone` for one that has no original (an
 * archive entry, or one whose move has not finished); `original_not_clean`
 * unless the scan said clean.
 */
export async function readEntryOriginal(
  session: AuthorizedSession,
  projectId: string,
  threadId: string,
  entryId: string
): Promise<Response> {
  const entry = await readableEntry(session, projectId, threadId, entryId)
  if (!entry.originalStorageKey || !entry.originalBucket) {
    throw refusal(
      'gone',
      'This message has no kept original: it was imported from an archive, or is still being filed',
      { entryId }
    )
  }
  const bytes = await readStagedObject(entry.originalBucket, entry.originalStorageKey)
  const scan = await scanForStorage(bytes)
  recordAuditEventAfterCommit({
    action: 'mail_thread.original_read',
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email || null },
    targetType: 'mail_thread_entry',
    targetId: entry.id,
    alsoTargets: [
      { type: 'mail_thread', id: threadId },
      { type: 'project', id: projectId },
    ],
    metadata: { projectId, scan: scan.status },
  })
  captureServer({
    event: 'mail_thread_original_downloaded',
    distinctId: session.userId,
    organizationId: session.organizationId,
    properties: { scan: scan.status, sender_trust: entry.senderTrust },
  })
  if (scan.status !== 'clean') {
    throw refusal(
      'original_not_clean',
      scan.status === 'infected'
        ? 'The original contains malware and cannot be downloaded'
        : 'The original could not be scanned; try again',
      { entryId, scan: scan.status }
    )
  }
  return new Response(new Blob([new Uint8Array(bytes)]), {
    status: 200,
    headers: heldBytesHeaders('message/rfc822', `mail-${entry.id}.eml`),
  })
}
