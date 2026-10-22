import 'server-only'
/**
 * Which mail brought which Fassung of a document (D36): the `mailOrigins` the
 * document routes carry (`document-get`, and per version `document-version-list`).
 *
 * The link is `mail_thread_entry_attachments`: one row per attachment of a
 * filed message, naming the document and the Fassung it became or already
 * was. A reader sees an origin only through a thread they may read (the
 * office's `inbound-mail` entitlement, the Verlauf screened, live and in a
 * folder they may open; `findMailOrigins`), because an origin names the
 * Verlauf's sender and time. The caller has already let the reader through to
 * the document itself.
 *
 * What an origin says is what the Verlauf's heading says: when the message was
 * sent (clamped) and received, the sender's display name, the signing domain
 * and the sender's trust. Never an address.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { isInboundMailEnabled } from '@/lib/authz/feature-flags'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import type { MailOriginView } from '@/lib/inbound-mail/inbound-mail-wire'
import { clampSentAt } from './mail-threading'
import type { DocumentMailOriginView } from './mail-thread-wire'
import { findMailOrigins, type MailOriginRow } from './repository'

/** One row as the wire names it. */
export function mailOriginView(row: MailOriginRow): MailOriginView {
  return {
    threadId: row.threadId,
    entryId: row.entryId,
    sentAt: clampSentAt(row.sentAt, row.receivedAt).sentAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    fromName: row.senderName,
    signerDomain: row.signerDomain,
    senderTrust: row.senderTrust,
  }
}

/**
 * The mails that brought this document, oldest first, each with the Fassung
 * it brought (null once that Fassung is gone); empty off a project, with the
 * office's entitlement off, or when no thread the reader may read names it.
 */
export async function documentMailOrigins(
  session: AuthorizedSession,
  document: { id: string; projectId: string | null }
): Promise<DocumentMailOriginView[]> {
  if (!document.projectId || !isInboundMailEnabled(session)) return []
  const hidden = await getHiddenFolderIds(session, document.projectId)
  const rows = await findMailOrigins(document.projectId, document.id, hidden)
  return rows.map((row) => ({ ...mailOriginView(row), documentVersionId: row.documentVersionId }))
}

/** {@link documentMailOrigins} by the Fassung each brought, for the version list. */
export function mailOriginsByVersion(
  origins: readonly DocumentMailOriginView[]
): Map<string, MailOriginView[]> {
  const byVersion = new Map<string, MailOriginView[]>()
  for (const { documentVersionId, ...origin } of origins) {
    if (!documentVersionId) continue
    byVersion.set(documentVersionId, [...(byVersion.get(documentVersionId) ?? []), origin])
  }
  return byVersion
}
