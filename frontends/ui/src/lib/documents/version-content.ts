/**
 * A version's BYTES: where they live, how they are rendered, and what happens
 * to an item when it leaves the working set (ADR-0054).
 *
 * Split out of `./lifecycle`, which had grown to hold two unrelated things: the
 * transition table's service — states, guards, the compare-and-swap, the
 * effects registry — and everything that touches the object store. This module
 * is the second half. It knows about SeaweedFS, about the storage quota and
 * about the producer that rendered a document; it knows nothing about states.
 *
 * ## The import direction, and why the renderer is not imported from its producer
 *
 * `./lifecycle` imports THIS; this imports nothing of it. The producer's
 * renderer is reached through `./agent-document-markdown` — the pure half of
 * `./agent-document` — because that module imports the lifecycle to create a
 * version, and importing it here would close the cycle. A producer stays a call
 * site of the lifecycle, never a branch inside it, and the renderer table below
 * is data.
 */

import 'server-only'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { NotFoundError } from '@/lib/api/errors'
import { markingIsInBytes, type AiProvenanceMarking } from '@/lib/ai-provenance'
import type { AuthorizedSession } from '@/lib/auth/types'
import { recordAuditEvent } from '@/lib/audit/service'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getBackendUrl } from '@/lib/backend-proxy'
import { findConversationInOrg } from '@/lib/conversations/repository'
import type { Document, DocumentVersion } from '@/lib/db/schema'
import { getOrganizationDisplayName } from '@/lib/organizations/service'
import { bucketAdminS3Client, s3Client } from '@/lib/s3'
import { assertWithinStorageQuota } from '@/lib/storage/service'
import { ensureTenantBucketChecked, resolveDocumentBucket } from '@/lib/storage/bucket'
import { getAccessibleDocument } from './access'
import { AGENT_DOCUMENT_MEDIA_TYPE, renderAgentDocumentMarkdown } from './agent-document-markdown'
import { resolveDocumentBranding, type DocumentBranding } from './branding'
import { collectionFileRef, purgeIngestedChunks } from './collection-file-ref'
import { contentDigest } from './content-digest'
import { documentDisplayName } from './display-name'
import {
  generatedDocumentMarking,
  UnmarkedRenderingError,
  type GeneratedDocumentProducer,
  type GeneratedRendering,
} from './generated'
import type { DocumentVersionState } from './lifecycle-types'
import { findDocumentInOrg } from './repository'
import {
  findDocumentVersion,
  findDocumentVersionInOrg,
  mirrorVersionOntoDocument,
  setDocumentLifecycle,
} from './version-repository'

/**
 * Ceiling on the chunk purges this tier runs against the backend.
 *
 * Its own constant rather than an import of `documents/service.ts`'s
 * `BACKEND_FETCH_TIMEOUT_MS`, which is module-private there, and the same ten
 * seconds for the same reason: an unreachable backend must not hold a BFF
 * request past Cloudflare's ~100s origin timeout. The purge is best-effort, so
 * exceeding it costs a superseded version's chunks lingering until the
 * platform's vector reconcile, never a failed publish or a failed archive.
 */
export const BACKEND_PURGE_TIMEOUT_MS = 10_000

/**
 * The key a version's OWN bytes live under.
 *
 * Version 1 keeps today's key exactly — `doc/<id>/<filename>` — so nothing that
 * predates versioning moves, and every stored object, thumbnail and `_bim/`
 * derivative stays where its row says it is. Later versions get a `v<n>/`
 * segment of their own, which is what makes "a superseded version keeps its
 * bytes" possible at all: without it the re-upload would write over the object
 * the previous version's row names.
 */
export function versionStorageKey(document: Document, versionNumber: number): string {
  return versionedStorageKey(document.storageKey, versionNumber)
}

/**
 * The same rule, applied to a key that has no row yet.
 *
 * The upload paths build their key before the document exists, so they cannot
 * hand in a `Document`. Pure, so all four shelves — project, Archiv, session and
 * the generated-document filer — get the same answer.
 */
export function versionedStorageKey(baseStorageKey: string, versionNumber: number): string {
  if (versionNumber <= 1) return baseStorageKey
  // Derived from the item's OWN key rather than rebuilt from its parts, so the
  // folder path, the shelf prefix (`project/`, `archiv/`, `session/`) and the
  // sanitised filename are whatever this document already uses. Rebuilding them
  // here would be a second copy of `buildStorageKey`'s three shelf variants,
  // and the copies would agree until somebody moved a document.
  return baseStorageKey.replace(/\/([^/]+)$/, `/v${versionNumber}/$1`)
}

/**
 * Whether this version's bytes are the ones the ITEM's storage columns describe.
 *
 * Two rows can be true of one document at once — `documents.file_size` is what
 * the quota ledger sums and what the download path serves — so a replacement
 * has to know whether it is rewriting the file people open or a draft standing
 * beside it. The published pointer answers it whenever there is one; before the
 * first publish (an agent's own first draft) version 1 IS the item's bytes,
 * because `fileGeneratedDocument` wrote both from the same render.
 */
export function versionMirrorsItem(document: Document, version: DocumentVersion): boolean {
  if (document.publishedVersionId) return document.publishedVersionId === version.id
  return version.versionNumber === 1
}

/**
 * The renderers that own a producer's bytes, by producer.
 *
 * DATA, not a `switch`, and the reason is the extension story ADR-0054 states:
 * "a new deliverable kind is a renderer". A producer with no entry here has no
 * Markdown body to re-render — `deep_research` hands over a finished PDF — and
 * its versions are never reachable by `update` anyway, since only a Markdown
 * draft is editable.
 */
type VersionRenderer = (
  body: string,
  marking: AiProvenanceMarking,
  branding: DocumentBranding,
) => GeneratedRendering

const PRODUCER_RENDERERS: Partial<Record<GeneratedDocumentProducer, VersionRenderer>> = {
  agent_document: renderAgentDocumentMarkdown,
}

/** What the caller handed in, turned into the bytes that will be stored. */
export interface RenderedVersionBytes {
  bytes: Buffer
  contentType: string
  contentHash: string
}

/**
 * Turn a replacement body into the bytes a version stores.
 *
 * ## Why this is not `Buffer.from(content)`
 *
 * It was, and it silently stripped the AI-provenance marking off every document
 * Piloti revised. The Python tool sends the model's raw Markdown — that is the
 * whole point of the working directory, where the model can read and edit the
 * text it wrote — and the branding line, the disclaimer and the marking are the
 * FILING seam's job, added by the producer's renderer when the first draft was
 * written. Writing the body verbatim over them meant version 2 of an
 * agent-authored file left the product saying nothing about its own authorship,
 * which is the one failure `markingIsInBytes` exists to make impossible.
 *
 * So the update runs the same render as the create, and re-asks the same
 * question of the bytes it produced. Belt and braces on purpose: the check is
 * on the BYTES rather than on the renderer's promise, because two of the three
 * earlier producers shipped unmarked while passing every test there was.
 *
 * A human-authored document is NOT rendered through anything. Its bytes are its
 * own, and stamping „von Piloti erstellt" onto a Markdown file a person wrote
 * would be the same lie in the other direction.
 */
export async function renderVersionBytes(
  document: Document,
  version: DocumentVersion,
  content: string,
): Promise<RenderedVersionBytes> {
  const renderer =
    document.authoredBy === 'user'
      ? undefined
      : PRODUCER_RENDERERS[document.authoredByProducer as GeneratedDocumentProducer]

  if (!renderer) {
    const bytes = Buffer.from(content, 'utf8')
    return {
      bytes,
      contentType: version.contentType ?? 'text/markdown',
      contentHash: contentDigest(bytes),
    }
  }

  const producer = document.authoredByProducer as GeneratedDocumentProducer
  const marking = generatedDocumentMarking(producer, document.authoredByRef ?? document.id)
  // No locale, for the reason `fileAgentDocumentDraft` states: this path's
  // callers are the agent's internal route and a revision run, neither of which
  // sends a `grid-locale` cookie, so the office's own `default_locale` is what
  // the header line should inherit rather than the app default.
  const organizationName = await getOrganizationDisplayName(document.organizationId)
  const branding = await resolveDocumentBranding({
    organizationId: document.organizationId,
    organizationName,
  })
  const rendered = renderer(content, marking, branding)
  if (!markingIsInBytes(rendered.bytes, marking)) {
    throw new UnmarkedRenderingError(producer, rendered.contentType)
  }
  const bytes = Buffer.from(rendered.bytes)
  return {
    bytes,
    contentType: rendered.contentType || AGENT_DOCUMENT_MEDIA_TYPE,
    contentHash: contentDigest(bytes),
  }
}

/**
 * Refuse a replacement the organization has no room for.
 *
 * The DELTA and not the whole file: the version being replaced is already
 * counted, whichever row carries it, so charging the full new size against a
 * total that still includes the old one would refuse a corrected report for
 * space the correction itself frees — the argument `replaceDocumentWithinQuota`
 * makes for a re-upload, restated for a version.
 *
 * This is `assertWithinStorageQuota`, the advisory half of the admission, and
 * that is a deliberate trade rather than an oversight. The hard ceiling on the
 * upload paths is an insert inside the quota transaction; a version replacement
 * has no insert — it is a compare-and-swap whose whole job is to lose races —
 * and holding the quota lock across the object write is exactly what
 * `insertDocumentWithinQuota`'s header refuses to do. Before this there was no
 * check of any kind on this path, which is what made an unattended revision
 * loop unbounded.
 */
export async function admitVersionBytes(
  organizationId: string,
  version: DocumentVersion,
  incomingBytes: number,
): Promise<void> {
  const delta = incomingBytes - (version.fileSize ?? 0)
  if (delta <= 0) return
  await assertWithinStorageQuota(organizationId, delta)
}

/**
 * Write a version's bytes and, when they are the item's own, mirror them onto it.
 *
 * Called AFTER the compare-and-swap has won. The order is the one thing here
 * that is not obvious: writing first and swapping second is how a caller that
 * LOST the race still overwrote the winner's object, because both were aiming
 * at the same key. The cost of this order is the opposite failure — a row that
 * names bytes the object store refused — and that one is recoverable by writing
 * again, whereas bytes destroyed by a loser are not.
 */
export async function storeVersionBytes(
  organizationId: string,
  document: Document,
  version: DocumentVersion,
  rendered: RenderedVersionBytes,
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: resolveDocumentBucket(version.storageBucket),
      Key: version.storageKey,
      Body: rendered.bytes,
      ContentType: rendered.contentType,
    }),
  )
  if (!versionMirrorsItem(document, version)) return
  // The ledger reads `documents.file_size`, and the download path reads
  // `documents.storage_key`. A version that IS the item's bytes and did not
  // write them back would leave the organization charged the size the file had
  // on the day it was created.
  await mirrorVersionOntoDocument(document.id, organizationId, {
    storageKey: version.storageKey,
    storageBucket: version.storageBucket,
    contentType: version.contentType,
    fileSize: version.fileSize,
    contentHash: version.contentHash,
  })
}

/** The tenant bucket this organization's version objects go to. */
export async function resolveVersionBucket(organizationId: string): Promise<string> {
  return ensureTenantBucketChecked(bucketAdminS3Client, organizationId)
}

/** One version's stored bytes, as text. */
async function readObjectText(
  storageBucket: string | null,
  storageKey: string,
): Promise<string> {
  const object = await s3Client.send(
    new GetObjectCommand({ Bucket: resolveDocumentBucket(storageBucket), Key: storageKey }),
  )
  const body = await object.Body?.transformToString('utf8')
  if (body === undefined) throw new NotFoundError('Version content not available')
  return body
}

/** Read one version's bytes back as text — the diff endpoint's other half. */
export async function readVersionContent(
  session: AuthorizedSession,
  documentId: string,
  versionId: string,
): Promise<string> {
  await getAccessibleDocument(session, documentId, 'read')
  const version = await findDocumentVersion(versionId, documentId, session.organizationId)
  if (!version) throw new NotFoundError('Version not found')
  return readObjectText(version.storageBucket, version.storageKey)
}

/**
 * One version's bytes and its identity, for a SERVICE caller that holds only a
 * version id and the conversation it is answering
 * (`GET /api/internal/document-versions/[versionId]/content`).
 *
 * Not an authorization bypass and not a second read path: it is the same object
 * fetch {@link readVersionContent} runs, with the organization and the
 * CONVERSATION standing in for the session.
 *
 * ## Why the conversation is part of the predicate and not context
 *
 * The organization alone was the whole of it, and the organization is something
 * the caller STATES. Anything holding the internal token could then name any
 * tenant and any version id and read the bytes — a service token is not a
 * person, and this route's own header says the version id "is not addressed
 * through an unguessable collection name". Requiring the version to be the
 * SUBJECT of the conversation the turn is running in narrows that to exactly
 * what the turn already had: `conversations.subject_resource_id` was written by
 * a person's own session through `resolveResourceAccess`, so a caller that
 * cannot name the right conversation reads nothing. A wrong pairing answers 404
 * exactly as an invented id does, because "this version exists but not for you"
 * is the sentence that makes an id worth guessing.
 *
 * Why the state travels back with the text: the Python tier writes the bytes
 * into the conversation's working directory and stamps a filing record on them
 * so a later `file_draft` on that path UPDATES this document's open version
 * rather than creating a second item, and the `update` op needs both the state
 * (is it still replaceable) and the content hash (If-Match).
 */
export async function readVersionForService(
  versionId: string,
  organizationId: string,
  conversationId: string,
): Promise<{
  documentId: string
  versionId: string
  versionNumber: number
  state: DocumentVersionState
  contentHash: string | null
  contentType: string | null
  filename: string
  displayName: string
  content: string
}> {
  const version = await findDocumentVersionInOrg(versionId, organizationId)
  if (!version) throw new NotFoundError('Version not found')
  const conversation = await findConversationInOrg(conversationId, organizationId)
  if (
    !conversation ||
    conversation.subjectResourceType !== 'document' ||
    conversation.subjectResourceId !== version.documentId
  ) {
    throw new NotFoundError('Version not found')
  }
  const document = await findDocumentInOrg(version.documentId, organizationId)
  if (!document) throw new NotFoundError('Version not found')
  return {
    documentId: version.documentId,
    versionId: version.id,
    versionNumber: version.versionNumber,
    state: version.state,
    contentHash: version.contentHash,
    contentType: version.contentType,
    filename: document.filename,
    displayName: documentDisplayName(document),
    content: await readObjectText(version.storageBucket, version.storageKey),
  }
}

/**
 * Take a document out of the working set.
 *
 * An item-level act, not a version state: „archiviert" is a statement about the
 * FILE, and putting it on a version would make it ambiguous which version was
 * archived. The bytes and every version stay — this is not a delete, and there
 * is no soft delete on this table. What goes is the chunks, so an archived
 * document stops answering questions, and the default listings, which read
 * `lifecycle = 'active'`.
 */
export async function archiveDocument(
  session: AuthorizedSession,
  documentId: string,
  request?: Request,
): Promise<{ documentId: string; lifecycle: 'archived' }> {
  const document = await getAccessibleDocument(session, documentId, 'write')
  if (document.projectId) {
    await requireProjectAccess(session, document.projectId, [
      'project:documents:write',
      'project:edit',
    ])
  }
  await setDocumentLifecycle(documentId, session.organizationId, 'archived')
  // „Archiviert" is a statement that the file has left the working set, and a
  // file that keeps answering questions has not left it. The chunks therefore
  // go, for a human upload as much as for a Piloti document — this docstring
  // said so before the code did. Purged and not deleted: the row, every
  // version and every object stay, so the only thing that has to be rebuilt if
  // somebody ever un-archives is the index.
  //
  // Best-effort, and AFTER the lifecycle write: the row is the durable record
  // of intent, and an unreachable backend must not leave a document that a
  // person believes is archived still listed as active. `chunksPurged` rides on
  // the audit event so a `false` is visible where somebody looks, exactly as
  // `deleteDocument` records it.
  const purgeRef = collectionFileRef(document)
  const chunksPurged = purgeRef
    ? await purgeIngestedChunks(getBackendUrl(), purgeRef, BACKEND_PURGE_TIMEOUT_MS)
    : null
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.archived',
    targetType: 'document',
    targetId: documentId,
    metadata: {
      projectId: document.projectId ?? '',
      filename: document.filename.slice(0, 200),
      collectionName: document.collectionName,
      // `null` is "this row owns no chunks", which is a different fact from
      // "the backend refused" and must not read as one.
      chunksPurged,
    },
    request,
  })
  return { documentId, lifecycle: 'archived' }
}
