/**
 * INTERNAL service endpoint — resolves a document's SeaweedFS storage key from
 * the `(collectionName, filename)` pair the Python backend carries. Called
 * just-in-time by the backend's `view_knowledge_image` tool (ADR-0039) so it
 * can fetch the raw bytes for a project/Archiv document that lives only in
 * SeaweedFS (never on the backend's disk).
 *
 * Service-to-service only: guarded by `GRID_INTERNAL_API_TOKEN` via
 * `internalApiRoute` (fail-closed when the token is unconfigured). Read-only:
 * returns the storage key AND its bucket, not the bytes (the backend fetches
 * those itself from SeaweedFS).
 *
 * ## Which collections it answers for (ADR-0081)
 *
 * The collection is an argument the MODEL chose, so its name is not a boundary.
 * A chat turn's tool echoes the signed request-context envelope the BFF minted
 * for the turn (`lib/request-context.ts`, ADR-0054 §4), and with one the route
 * answers only:
 *
 *   * for a collection in the scope that envelope signs, in the organization it
 *     names, and
 *   * for a restricted folder's collection (`<project collection>_r<12 hex>`),
 *     only when the asker and everyone the conversation is shared with may read
 *     that folder NOW (`drawableRestrictedCollections`, the check the agent's
 *     turn start makes). A person who lost read gets nothing, whatever the
 *     scope signed hours ago.
 *
 * Without an envelope (a job worker, which has no per-turn credential to
 * forward) a restricted folder's collection is never answered for, and any
 * other collection is looked up as before: by name, narrowed to the
 * organization an `archiv_<orgId>` collection names. An envelope that is
 * presented and does not verify is a 401, never a fall back to that path.
 * Every refusal is the same 404 as an unknown document, so the route says
 * nothing about what exists outside the caller's reach.
 *
 * With `imageIndex`, the key returned is that of the `_img/<index>.jpg` raster
 * the ingest pipeline stored beside the document, built from the row's own
 * storage key (`buildImageStorageKey`). The backend never names a derived key
 * itself: the only thing it can vary is a bounded integer, so a derived read
 * can only ever land under the owning document's prefix.
 */

import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { requireVerifiedContext } from '@/lib/api/internal-envelope'
import { withOptionalTenant, withTenant } from '@/lib/db/tenant-context'
import { NotFoundError } from '@/lib/api/errors'
import { restrictedCollectionBase } from '@/lib/authz/folder-access-rule'
import { drawableRestrictedCollections } from '@/lib/conversations/restricted-use'
import { findDocumentImageStorageKey, findDocumentStorageKey } from '@/lib/documents/service'
import { GRID_HEADER_NAMES, type VerifiedGridRequestContext } from '@/lib/request-context'

const querySchema = z.object({
  collection: z.string().min(1),
  filename: z.string().min(1),
  organizationId: z.string().min(1).optional(),
  imageIndex: z.coerce.number().int().min(0).optional(),
})

type DocumentFileQuery = z.infer<typeof querySchema>

/** The verified envelope when the caller presented one (a 401 when it does not verify); null when it presented none. */
function presentedContext(request: Request): VerifiedGridRequestContext | null {
  const presented =
    request.headers.has(GRID_HEADER_NAMES.REQUEST_CONTEXT) || request.headers.has(GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG)
  return presented ? requireVerifiedContext(request) : null
}

/** A restricted folder's collection, case-insensitively: a renamed case must not read as an open collection. */
function isRestrictedCollection(collection: string): boolean {
  return restrictedCollectionBase(collection.toLowerCase()) !== null
}

/** Refuse, as an unknown document, a collection the caller's signed turn may not read. Runs inside the tenant scope. */
async function requireReadable(collection: string, context: VerifiedGridRequestContext | null): Promise<void> {
  const restricted = isRestrictedCollection(collection)
  if (!context) {
    if (restricted) throw new NotFoundError('Document not found')
    return
  }
  if (!context.collectionScope.includes(collection)) throw new NotFoundError('Document not found')
  if (!restricted) return
  if (!context.conversationId) throw new NotFoundError('Document not found')
  const drawable = await drawableRestrictedCollections(
    {
      organizationId: context.organizationId,
      conversationId: context.conversationId,
      userId: context.userId,
      projectId: context.projectId,
    },
    [collection]
  )
  if (!drawable.includes(collection)) throw new NotFoundError('Document not found')
}

async function lookUp({ collection, filename, imageIndex }: DocumentFileQuery, organizationId: string | undefined) {
  if (imageIndex !== undefined) {
    const image = await findDocumentImageStorageKey(collection, filename, imageIndex, organizationId)
    if (!image) throw new NotFoundError('Document image not found')
    return { storageKey: image.storageKey, storageBucket: image.storageBucket, contentType: image.contentType }
  }
  const document = await findDocumentStorageKey(collection, filename, organizationId)
  if (!document) throw new NotFoundError('Document not found')
  return {
    storageKey: document.storageKey,
    // The bucket, not just the key (ADR-0043). Per-organization buckets
    // mean the key alone no longer locates an object, and the agent tier
    // calls get_object directly rather than through a presigned URL — so
    // it must be TOLD where the object is. Deriving it there would put a
    // second implementation of the naming rule in a third language, in
    // the one place a mismatch surfaces as a silent 404 rather than an
    // error. NULL means the shared bucket, exactly as the column does.
    storageBucket: document.storageBucket,
    contentType: document.contentType,
  }
}

export const GET = internalApiRoute(
  'document-file',
  async ({ request }) => {
    const query = parseQuery(request, querySchema)
    const context = presentedContext(request)
    if (context) {
      // The organization is the signed one. A query that names another is
      // asking outside the turn, and is answered like an unknown document.
      if (query.organizationId && query.organizationId !== context.organizationId) {
        throw new NotFoundError('Document not found')
      }
      return withTenant({ organizationId: context.organizationId }, async () => {
        await requireReadable(query.collection, context)
        return lookUp(query, context.organizationId)
      })
    }
    // No envelope: a run that is not a chat turn. The backend derives an
    // organization only from an `archiv_<orgId>` collection; for `proj_<uuid>`
    // it has none to send, and no restricted folder's collection is answered.
    return withOptionalTenant(
      query.organizationId,
      'document addressed by collection name, with no envelope and no organization supplied',
      async () => {
        await requireReadable(query.collection, null)
        return lookUp(query, query.organizationId)
      }
    )
  },
  { tenancy: { fromPayload: 'the signed envelope, or ?organizationId when the collection is an Archiv' } }
)
