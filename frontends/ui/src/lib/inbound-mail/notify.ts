/**
 * The sender's receipt (ADR-0075): one inbox item per delivery, anchored on
 * its row, saying what was filed and what was not, or that it could not be
 * filed at all.
 *
 * In the inbox and never by mail: telling somebody by email that their email
 * arrived is the loop the feature exists to avoid. Never fails the delivery:
 * the files are filed whether or not the receipt could be written.
 */

import 'server-only'
import type { InboundMailMessageRow, SkippedAttachment } from '@/lib/db/schema'
import {
  INBOX_PROJECT_NAME_MAX,
  INBOX_SKIPPED_FILES_MAX,
  INBOX_SKIPPED_NAME_MAX,
  inboxGroupKey,
} from '@/lib/inbox/registry'
import { emitInboxItems, type InboxEmission } from '@/lib/inbox/service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { truncateGraphemes } from '@/lib/text/graphemes'
import { errorName } from './staging'
import type { SkipReason } from './types'

type NotifiedRow = Pick<
  InboundMailMessageRow,
  'id' | 'organizationId' | 'projectId' | 'senderUserId' | 'subject' | 'folderId'
>

export interface FiledSummary {
  filed: number
  skipped: SkippedAttachment[]
  folderId: string | null
}

/** The files a notification names: the first ten skipped parts that still have a name. */
export function skippedFilesForNotice(skipped: readonly SkippedAttachment[]): { name: string; reason: SkipReason }[] {
  return skipped
    .filter((entry): entry is Required<SkippedAttachment> => Boolean(entry.filename?.trim()))
    .slice(0, INBOX_SKIPPED_FILES_MAX)
    .map((entry) => ({
      name: truncateGraphemes(entry.filename.trim(), INBOX_SKIPPED_NAME_MAX, '…'),
      reason: entry.reason as SkipReason,
    }))
}

async function projectName(row: NotifiedRow): Promise<string> {
  const project = await findProjectInOrg(row.projectId, row.organizationId, { includeDeleted: true })
  return truncateGraphemes(project?.name ?? '', INBOX_PROJECT_NAME_MAX, '…')
}

function frame(row: NotifiedRow, type: 'inbound_mail.filed' | 'inbound_mail.failed') {
  return {
    organizationId: row.organizationId,
    recipientUserId: row.senderUserId,
    resourceType: 'project' as const,
    resourceId: row.projectId,
    anchorId: row.id,
    // A system item: the recipient is the one who sent it, and an emission
    // whose actor is its recipient is dropped as self-notification.
    actorUserId: null,
    groupKey: inboxGroupKey(type, 'project', row.projectId, row.id),
  }
}

async function emit(emission: InboxEmission): Promise<void> {
  try {
    await emitInboxItems([emission])
  } catch (error) {
    console.warn(`[inbound-mail] could not notify the sender error=${errorName(error)}`)
  }
}

/** What became of a filed mail. An empty subject is `null`; the copy renders it. */
export async function notifyFiled(row: NotifiedRow, filing: FiledSummary): Promise<void> {
  await emit({
    ...frame(row, 'inbound_mail.filed'),
    type: 'inbound_mail.filed',
    payload: {
      subject: row.subject?.trim() || null,
      folderId: filing.folderId,
      params: {
        filed: filing.filed,
        skipped: filing.skipped.length,
        project: await projectName(row),
        skippedFiles: skippedFilesForNotice(filing.skipped),
      },
    },
  })
}

/** Every attempt is spent (or the staging expired): nothing more of this mail will be filed. */
export async function notifyFailed(row: NotifiedRow): Promise<void> {
  await emit({
    ...frame(row, 'inbound_mail.failed'),
    type: 'inbound_mail.failed',
    payload: {
      subject: row.subject?.trim() || null,
      folderId: row.folderId,
      params: { project: await projectName(row) },
    },
  })
}
