/**
 * Confirming, or taking back, that a newer document replaces an older one
 * (CONTEXT.md, „Fassung").
 *
 * The backend suggests such a link; only a person makes it. This is that
 * gesture: `PUT /api/documents/{newer}/fassung` with the older document and
 * whether the two are linked. The backend stores the link by file name in the
 * collection both documents are indexed in, so everything it needs to be true
 * is decided here first: the caller may change both documents, both are
 * visible to them and past screening, both are active, and they are two
 * documents of one collection. A document the caller may not open is a 404, as
 * everywhere else, never a 403 that confirms it exists.
 */

import 'server-only'
import { BadRequestError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getBackendUrl } from '@/lib/backend-proxy'
import type { Document } from '@/lib/db/schema'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { getAccessibleDocument } from './access'
import { collectionFileRef } from './collection-file-ref'
import { hasPassedScreening } from './document-reader'
import type { FassungFacts } from './fassung'
import { loadFassungFacts } from './fassung-facts'

const BACKEND_TIMEOUT_MS = 10_000

export interface FassungLinkResult {
  /** The newer document, whose facts changed. */
  id: string
  fassung: FassungFacts | null
  /** The older one: its `supersededBy` changed with the link. */
  older: { id: string; fassung: FassungFacts | null }
}

/**
 * The backend route that stores the link. One function, so a path that changes
 * on the Python side is a one-line fix here.
 */
const fassungUrl = (backendUrl: string, collectionName: string): string =>
  `${backendUrl}/v1/collections/${encodeURIComponent(collectionName)}/fassung`

/** Load a document for a change: write access to its shelf and folder, not held, in the working set. */
async function loadForLinking(session: AuthorizedSession, documentId: string): Promise<Document> {
  const doc = await getAccessibleDocument(session, documentId, 'write')
  // A held upload is the uploader's and the reviewers' alone (ADR-0086), and a
  // link would carry its name and, through the change summary, what it holds
  // into documents everyone reads. Not found, like every other path.
  if (!hasPassedScreening(doc)) throw new NotFoundError()
  if (doc.scope === 'session') throw new BadRequestError('A chat attachment has no Fassungen', { reason: 'session_document' })
  if (doc.lifecycle !== 'active') throw new BadRequestError('An archived document has no Fassungen', { reason: 'archived' })
  return doc
}

async function putLink(newer: Document, older: Document, linked: boolean): Promise<void> {
  // The same gate as every `(collection, filename)` call: a machine-authored
  // row owns no chunks over there, and a name it shares belongs to someone else.
  if (!collectionFileRef(newer) || !collectionFileRef(older)) throw new NotFoundError()

  let res: Response
  try {
    res = await fetch(fassungUrl(getBackendUrl(), newer.collectionName), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newer: newer.filename, older: older.filename, linked }),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    })
  } catch {
    throw new UpstreamError('Could not reach the document service')
  }
  if (res.status === 404) throw new NotFoundError()
  if (res.status === 400 || res.status === 409 || res.status === 422) {
    throw new BadRequestError('The document service refused this Fassung link')
  }
  if (!res.ok) throw new UpstreamError('The document service rejected the Fassung update')
}

/**
 * Link `olderId` to `newerId` as its earlier Fassung, or take the link back.
 * Answers the facts of both documents as the caller now reads them.
 */
export async function setFassungLink(
  session: AuthorizedSession,
  newerId: string,
  olderId: string,
  linked: boolean,
  request: Request,
): Promise<FassungLinkResult> {
  if (newerId === olderId) throw new BadRequestError('A document is not its own earlier Fassung', { reason: 'same_document' })

  const newer = await loadForLinking(session, newerId)
  const older = await loadForLinking(session, olderId)
  if (newer.collectionName !== older.collectionName) {
    throw new BadRequestError('Both documents must be in the same collection', { reason: 'different_collection' })
  }

  await putLink(newer, older, linked)

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.fassung_changed',
    targetType: 'document',
    targetId: newer.id,
    metadata: { olderDocumentId: older.id, linked, collectionName: newer.collectionName },
    request,
  })

  // Read back from the backend's listing, fresh: the cached one predates the write.
  const reader = await shelfReaderFor(session, newer)
  const facts = await loadFassungFacts(session, [newer, older], reader, { fresh: true })
  return {
    id: newer.id,
    fassung: facts.get(newer.id) ?? null,
    older: { id: older.id, fassung: facts.get(older.id) ?? null },
  }
}
