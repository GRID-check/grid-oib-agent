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
import { randomUUID } from 'node:crypto'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { ConflictError, InsufficientStorageError, NotFoundError } from '@/lib/api/errors'
import { markingIsInBytes, type AiProvenanceMarking } from '@/lib/ai-provenance'
import type { AuthorizedSession } from '@/lib/auth/types'
import { recordAuditEvent } from '@/lib/audit/service'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getBackendUrl } from '@/lib/backend-proxy'
import { placementCollectionFor } from '@/lib/authz/folder-access'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { admitRestrictedUse } from '@/lib/conversations/restricted-use'
import { findProjectCollectionName } from '@/lib/projects/repository'
import type { Document, DocumentVersion } from '@/lib/db/schema'
import { getOrganizationDisplayName } from '@/lib/organizations/service'
import { bucketAdminS3Client, s3Client } from '@/lib/s3'
import { discardObject } from '@/lib/storage/discard'
import {
  assertWithinStorageQuota,
  getStorageQuotaBytes,
  STORAGE_QUOTA_EXCEEDED_MESSAGE,
} from '@/lib/storage/service'
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
  setDocumentLifecycle,
  swapVersionContent,
  type SwapVersionContentOutcome,
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
 * A fresh id for one object write — twelve hex characters of a random uuid.
 *
 * The collision space is per document and per version number, so twelve hex
 * digits (48 bits) is far past what two concurrent writers of one file need.
 */
export function newVersionWriteId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/**
 * `…/doc/<id>/v<n>/<write id>/<filename>` — one object per write, always.
 *
 * There is no version-1 shortcut, and that is the point. Every write that is
 * not a document's first upload goes here: a re-upload on any shelf (project,
 * Archiv, session) and a rewrite of a version's bytes. A first upload keeps the
 * plain `doc/<id>/<filename>` key, because its id is fresh. The version number
 * is a HINT (`nextVersionNumber`): it reads 1 while a concurrent first upload
 * has its row but not yet its version, so a helper that returned the plain key
 * for "version 1" aimed a re-upload at the winner's own object and overwrote
 * its bytes. That helper (`versionedStorageKey`) is gone for that reason. The
 * write id keeps two overlapping writes of one number apart; the row's number
 * is allocated under a lock when the version is recorded.
 *
 * Derived from the item's OWN key rather than rebuilt from its parts, so the
 * folder path, the shelf prefix (`project/`, `archiv/`, `session/`) and the
 * sanitised filename are whatever this document already uses. Rebuilding them
 * here would be a second copy of `buildStorageKey`'s three shelf variants, and
 * the copies would agree until somebody moved a document. Whatever already
 * sits between `doc/<id>/` and the filename — an earlier `v<n>/` or
 * `v<n>/<write id>/` — is replaced rather than nested, so a document's keys do
 * not grow a segment per revision.
 */
export function versionWriteKey(key: string, versionNumber: number, writeId: string): string {
  const segment = `v${versionNumber}/${writeId}`
  const underDoc = /^(.*\/doc\/[^/]+)\/(?:.+\/)?([^/]+)$/.exec(key)
  if (underDoc) return `${underDoc[1]}/${segment}/${underDoc[2]}`
  // A key without a `doc/<id>/` segment predates the shelf layout; it still
  // gets a directory of its own beside its filename.
  return key.replace(/\/?([^/]+)$/, (_match, name: string) =>
    key.includes('/') ? `/${segment}/${name}` : `${segment}/${name}`,
  )
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
 * What a replacement will add to the organization's usage, as best it can be
 * told before anything is locked.
 *
 * The FULL size when the old bytes stay: a draft freshly forked from the
 * published version shares the published object, and replacing the draft does
 * not free it. This used to charge `incoming − version.fileSize` there too — the
 * published file's size, so ≈ 0 for a same-sized revision — and fork, write,
 * reject, fork again grew storage without ever being checked. The DELTA when the
 * version owns its old object alone (a draft that has been written to, or the
 * version that IS the item's bytes), because that object goes once the swap has
 * won.
 *
 * An estimate for the courtesy check only. The hard ceiling is measured inside
 * the swap's transaction, on the state it is about to commit
 * (`swapVersionContent`), which also sees a key shared with a SUPERSEDED version
 * that this cannot.
 */
export function versionReplacementCharge(
  document: Document,
  version: DocumentVersion,
  incomingBytes: number,
): number {
  const sharesPublishedObject =
    version.storageKey === document.storageKey && !versionMirrorsItem(document, version)
  if (sharesPublishedObject) return incomingBytes
  return incomingBytes - (version.fileSize ?? 0)
}

/**
 * Refuse, before any byte moves, a replacement that obviously does not fit.
 *
 * `assertWithinStorageQuota`, the advisory half, so an over-quota revision is
 * refused before its object is written. The ceiling itself is enforced in
 * `swapVersionContent`, under the per-organization quota lock every upload
 * takes — the object is written first and taken back on a refusal, the same
 * shape as `admitOrDiscard`.
 */
export async function admitVersionBytes(
  organizationId: string,
  document: Document,
  version: DocumentVersion,
  incomingBytes: number,
): Promise<void> {
  const charge = versionReplacementCharge(document, version, incomingBytes)
  if (charge <= 0) return
  await assertWithinStorageQuota(organizationId, charge)
}

/** What {@link writeVersionContent} needs: the row that was read, and the new bytes. */
export interface WriteVersionContentInput {
  organizationId: string
  document: Document
  /** The row as the caller READ it — its state, key and hash are the expectation. */
  version: DocumentVersion
  rendered: RenderedVersionBytes
  /** The transition's stamp (`stampFor`), written with the storage columns. */
  stamp: Record<string, unknown>
}

/**
 * Store a version's new bytes, then swap the row onto them — or take them back.
 *
 * ## Why the object is written FIRST, under a key of its own
 *
 * The key is fresh for every write (`versionWriteKey`), so no other writer —
 * a concurrent replace, the published version a draft was forked from — can be
 * aiming at it. That is what makes writing before the swap safe, and writing
 * before the swap is what makes the row honest: by the time
 * `swapVersionContent` commits, the object it names is stored in full, with the
 * hash and size the row states. The previous order (swap, then write to a
 * shared key) let a slow or failed PUT leave the row describing bytes the
 * object did not hold, and let two winners write one key in either order.
 *
 * The swap asserts the state, key and hash this request READ, so the second of
 * two writers holding one `If-Match` matches no row. Its object is deleted —
 * nothing names it — and it is told 409.
 *
 * The version's PREVIOUS object is deleted after a won swap when nothing names
 * it any more (a draft is not history). When it is shared — the published
 * version's key a fresh fork still carries — it stays.
 */
export async function writeVersionContent(input: WriteVersionContentInput): Promise<DocumentVersion> {
  const { organizationId, document, version, rendered } = input
  await admitVersionBytes(organizationId, document, version, rendered.bytes.byteLength)
  const quotaBytes = await getStorageQuotaBytes(organizationId)

  const storageBucket = await resolveVersionBucket(organizationId)
  const storageKey = versionWriteKey(document.storageKey, version.versionNumber, newVersionWriteId())
  await s3Client.send(
    new PutObjectCommand({
      Bucket: storageBucket,
      Key: storageKey,
      Body: rendered.bytes,
      ContentType: rendered.contentType,
    }),
  )

  let outcome: SwapVersionContentOutcome
  try {
    outcome = await swapVersionContent({
      versionId: version.id,
      documentId: document.id,
      organizationId,
      expected: {
        state: version.state,
        storageKey: version.storageKey,
        contentHash: version.contentHash,
      },
      patch: {
        ...input.stamp,
        storageKey,
        storageBucket,
        contentType: rendered.contentType,
        fileSize: rendered.bytes.byteLength,
        contentHash: rendered.contentHash,
      },
      mirrorsItem: versionMirrorsItem(document, version),
      quotaBytes,
    })
  } catch (error) {
    await discardObject(storageBucket, storageKey)
    throw error
  }

  if (!outcome.ok) {
    // Nothing names the object this request wrote, whichever way it lost.
    await discardObject(storageBucket, storageKey)
    if (outcome.reason === 'quota') {
      throw new InsufficientStorageError(STORAGE_QUOTA_EXCEEDED_MESSAGE, {
        quotaBytes: quotaBytes ?? 0,
        usedBytes: outcome.usedBytes,
        requestedBytes: rendered.bytes.byteLength,
      })
    }
    throw new ConflictError('The version changed while you were writing', {
      contentHash: version.contentHash,
    })
  }
  if (outcome.previousKeyOrphaned) {
    await discardObject(resolveDocumentBucket(version.storageBucket), version.storageKey)
  }
  return outcome.version
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
 * A subject in a restricted folder is opened into the turn's working directory
 * whole, so reading it is USE of that folder (ADR-0084, ADR-0085): admitted for
 * the conversation, against its audience, before the bytes leave. Refused, or
 * with no asker to check, it reads as no subject at all. True when a folder not
 * every member may read was admitted, so the agent knows the conversation is
 * confined from this turn on.
 */
async function admitSubjectRead(
  document: Document,
  organizationId: string,
  conversationId: string,
  askerUserId: string | null,
): Promise<boolean> {
  if (!document.projectId || !document.folderId) return false
  const projectCollection = await findProjectCollectionName(document.projectId, organizationId)
  if (!projectCollection) return false
  const collection = await placementCollectionFor(
    organizationId,
    document.projectId,
    projectCollection,
    document.folderId,
  )
  if (collection === projectCollection) return false
  if (!askerUserId) throw new NotFoundError('Version not found')
  const admission = await admitRestrictedUse(
    { organizationId, conversationId, userId: askerUserId, projectId: document.projectId },
    [collection],
  )
  if (admission.refused.length > 0) throw new NotFoundError('Version not found')
  return admission.admitted.length > 0
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
  /** The turn's asker, as signed; needed only for a document in a restricted folder. */
  askerUserId: string | null = null,
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
  /** The read drew on a folder not every project member may read; the conversation recorded it. */
  drewOnRestrictedFolder: boolean
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
  const drewOnRestrictedFolder = await admitSubjectRead(document, organizationId, conversationId, askerUserId)
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
    drewOnRestrictedFolder,
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
