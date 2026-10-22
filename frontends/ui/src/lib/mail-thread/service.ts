import 'server-only'
/**
 * Reading the project's E-Mail-Verläufe (ADR-0134, DECISION §7):
 * `mail-thread-list` and `mail-thread-get`. A thread is a document, and it is
 * exactly as readable as that document (D9, RT-S13): screened, not in the bin,
 * in a folder the reader may open. A thread the reader may not read is not
 * found.
 *
 * What a thread view names is the reader's too: each entry's attachments are
 * listed by position (D36), but a document in a folder the reader may not
 * open is listed without its name or ids, so the count of what came with a
 * message stays true and nothing restricted is named. The waiting count is for
 * people who may file mail (`project:documents:write`), and null for everyone
 * else. The original `.eml` of an entry is downloaded through its own route
 * (`…/entries/[entryId]/original`), never through these views.
 */

import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds, projectMayWriteDocuments } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { MailThreadFollowRow } from '@/lib/db/schema'
import { decodeDocumentListCursor, encodeDocumentListCursor } from '@/lib/documents/list-cursor'
import { requireInboundMailEnabled } from '@/lib/inbound-mail/access'
import type {
  MailThreadAttachmentView,
  MailThreadEntryView,
  MailThreadFollowView,
  MailThreadListQuery,
  MailThreadListView,
  MailThreadSummaryView,
  MailThreadView,
} from './mail-thread-wire'
import {
  countWaitingForThread,
  entryAttachments,
  findActiveFollows,
  findThreadEntries,
  findVisibleThread,
  listVisibleThreads,
  type EntryAttachment,
  type EntryRow,
  type ThreadRow,
} from './repository'

/** The caller may read the project's threads: the office's `inbound-mail` entitlement and `project:view`. */
async function requireThreadReader(session: AuthorizedSession, projectId: string): Promise<string[]> {
  requireInboundMailEnabled(session)
  await requireProjectAccess(session, projectId, 'project:view')
  return getHiddenFolderIds(session, projectId)
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString())

function summaryView(thread: ThreadRow, follows: readonly MailThreadFollowRow[], userId: string): MailThreadSummaryView {
  return {
    id: thread.id,
    documentId: thread.documentId,
    name: thread.name,
    entryCount: thread.entryCount,
    lastEntryAt: iso(thread.lastEntryAt),
    followed: follows.some((follow) => follow.threadId === thread.id && follow.userId === userId),
  }
}

/**
 * The attachments of one entry as this reader may see them (D36). Pure: an
 * attachment filed into a folder the reader may not open keeps its position
 * and disposition and loses its name and ids (`visible: false`).
 */
export function attachmentViews(attachments: readonly EntryAttachment[], hiddenFolders: ReadonlySet<string>): MailThreadAttachmentView[] {
  return attachments.map((attachment) => {
    const filed = attachment.disposition !== 'not_filed'
    const folderId = attachment.document?.folderId ?? null
    const visible = !filed || (attachment.document !== null && (folderId === null || !hiddenFolders.has(folderId)))
    if (!visible) return { position: attachment.position, filename: null, disposition: attachment.disposition, visible: false }
    return {
      position: attachment.position,
      filename: attachment.filename,
      disposition: attachment.disposition,
      ...(attachment.notFiledReason ? { notFiledReason: attachment.notFiledReason } : {}),
      ...(attachment.documentId ? { documentId: attachment.documentId } : {}),
      ...(attachment.documentVersionId ? { documentVersionId: attachment.documentVersionId } : {}),
      visible: true,
    }
  })
}

function entryView(row: EntryRow, attachments: MailThreadAttachmentView[]): MailThreadEntryView {
  const { entry } = row
  return {
    id: entry.id,
    heading: entry.heading,
    source: entry.source,
    senderName: entry.senderName,
    senderDomain: entry.senderDomain,
    signerDomain: entry.signerDomain,
    senderTrust: entry.senderTrust,
    sentAt: new Date(entry.sentAt).toISOString(),
    receivedAt: new Date(entry.receivedAt).toISOString(),
    firstVersion: row.firstVersion,
    original: entry.originalStorageKey ? { scanStatus: entry.originalScanStatus ?? 'pending' } : null,
    attachments,
    filedBy: entry.filedBy,
    filedVia: entry.filedVia,
    filedAt: new Date(entry.filedAt).toISOString(),
  }
}

const followView = (follow: MailThreadFollowRow): MailThreadFollowView => ({
  id: follow.id,
  userId: follow.userId,
  createdAt: new Date(follow.createdAt).toISOString(),
  expiresAt: new Date(follow.expiresAt).toISOString(),
  renewedAt: iso(follow.renewedAt),
  dailyCap: follow.dailyCap,
})

/** One page of the project's threads the reader may read (`mail-thread-list`), newest first. */
export async function listMailThreads(
  session: AuthorizedSession,
  projectId: string,
  query: MailThreadListQuery,
): Promise<MailThreadListView> {
  const hidden = await requireThreadReader(session, projectId)
  const decoded = query.cursor ? decodeDocumentListCursor(query.cursor) : null
  if (query.cursor && !decoded) throw new BadRequestError('Invalid cursor')
  const rows = await listVisibleThreads(
    projectId,
    hidden,
    { documentId: query.documentId, limit: query.limit },
    decoded ? { createdAt: decoded.createdAt, id: decoded.id } : null,
  )
  const page = rows.slice(0, query.limit)
  const follows = await findActiveFollows(page.map((thread) => thread.id))
  const last = page.at(-1)
  return {
    items: page.map((thread) => summaryView(thread, follows, session.userId)),
    nextCursor: rows.length > query.limit && last ? encodeDocumentListCursor({ createdAt: last.createdAtText, id: last.id }) : null,
  }
}

/** One thread with its messages, their attachments and its follows (`mail-thread-get`). */
export async function getMailThread(session: AuthorizedSession, projectId: string, threadId: string): Promise<MailThreadView> {
  const hidden = await requireThreadReader(session, projectId)
  const thread = await findVisibleThread(projectId, threadId, hidden)
  if (!thread) throw new NotFoundError('Mail thread not found')
  const [entries, follows, mayFile] = await Promise.all([
    findThreadEntries(thread.id),
    findActiveFollows([thread.id]),
    projectMayWriteDocuments(session, projectId),
  ])
  const attachments = await entryAttachments(entries.map((row) => row.entry))
  const hiddenSet = new Set(hidden)
  return {
    ...summaryView(thread, follows, session.userId),
    participantDomains: thread.participantDomains,
    continuesThreadId: thread.continuesThreadId,
    entries: entries.map((row) =>
      entryView(
        row,
        attachmentViews(
          attachments.filter((attachment) => attachment.entryId === row.entry.id),
          hiddenSet,
        ),
      ),
    ),
    follows: follows.map(followView),
    waitingCount: mayFile ? await countWaitingForThread(projectId, thread.id) : null,
  }
}
