/**
 * Uploading one file onto a shelf — the ONE pipeline behind a project's Dateien
 * and the org-wide Archiv (ADR-0078).
 *
 * The two used to be two copies of the same flow, written a year apart, and they
 * drifted: the Archiv had no folders, no origin path, no "same bytes, nothing to
 * do" short-circuit and a different audit shape. The flow is the same on both
 * shelves — authorize, probe the name, store, admit under the quota, record a
 * version, dispatch the ingest, audit — and differs in exactly four places,
 * each of which is a function of the {@link DocumentShelf} below:
 *
 *   1. who may upload (`requireShelfWrite`),
 *   2. the collection the file is ingested into (`shelfCollectionName`),
 *   3. the object key's owner prefix (`uploadStorageKey`),
 *   4. the audit action and what it records (`uploadAuditEvent`).
 *
 * Two gates run on both shelves: the organization's name screening (ADR-0085)
 * and the upload batch the browser opened. One runs on the project shelf only:
 * the folder's access per role (`projectFolderGate`, ADR-0087), which also picks
 * the collection a restricted folder's documents live in. The Archiv has no
 * per-role folder access; `requireShelfWrite` is its whole gate.
 *
 * `@/lib/documents/service#uploadDocument` and
 * `@/lib/archiv/service#uploadArchivDocument` are the names the two shelves'
 * routes call; both are one line over this.
 */

import 'server-only'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { s3Client, bucketAdminS3Client, buildArchivStorageKey, buildStorageKey } from '@/lib/s3'
import { ensureTenantBucketChecked } from '@/lib/storage/bucket'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import { folderReadOnlyError, getProjectFolderAccess } from '@/lib/authz/folder-access'
import { assertIfcMayBeFiledIn } from '@/lib/projects/ifc-folder-guard'
import { acceptedUploadBatchId } from '@/lib/upload-batches/service'
import { assertUploadNameAllowed, auditScreeningOverride } from '@/lib/upload-screening/service'
import { recordAuditEvent } from '@/lib/audit/service'
import { assertWithinStorageQuota } from '@/lib/storage/service'
import { admitOrDiscard, admitReplacementOrDiscard } from '@/lib/storage/admission'
import type { AuthorizedSession } from '@/lib/auth/types'
import { contentDigest } from './content-digest'
import { documentStatusFacts } from './document-status'
import { nextVersionNumber, recordUploadedVersionOrDiscard } from './lifecycle'
import { documentNameKey } from './name-match'
import { sanitizeOriginPath } from './origin-path'
import { resolveShelfFolderPath } from './folder-path'
import { findLiveDocumentByFilename, findProjectCollectionsHoldingFilename } from './repository'
import { retryRacedUpload } from './unique-conflicts'
import { newVersionWriteId, versionWriteKey } from './version-content'
import { shelfOwner, type DocumentShelf } from './shelf'
import { requireShelfWrite } from './shelf-authz'
import { shelfCollectionName } from './shelf-collection'

/** What an upload names besides the file, on either shelf. */
export interface ShelfUploadInput {
  file: File
  folderId: string | null
  originPath?: string | null
  /**
   * The uploader released this file in the upload dialog although the
   * organization's name screening excludes it (ADR-0085) — the Bauvertrag in a
   * folder called „Verträge". Honoured and audited; absent means "do not
   * override", so a client that never asks is screened.
   */
  screeningRelease?: boolean
  /**
   * The upload gesture this file belongs to (migration 0109), as the browser
   * opened it. Recorded on the row when it is the uploader's own open batch
   * for this shelf; anything else is ignored rather than refused.
   */
  uploadBatchId?: string | null
}

export interface UploadDocumentResult {
  documentId: string
  jobId: string | null
  /**
   * `processing` is the IFC path: extraction runs in this process and there is
   * no backend job to report yet, but the document is genuinely being worked on
   * — reporting the `uploaded` birth status would hide that work behind a
   * terminal "Abgelegt" badge for a model that is about to become openable.
   */
  status: 'pending' | 'uploaded' | 'failed' | 'processing'
  filename: string
  /**
   * The bytes were already the live document's, so nothing was written and no
   * version was made. Present only then. The browser says „Unverändert –
   * bereits vorhanden" from it where it could not know beforehand (no stored
   * digest, no `crypto.subtle`).
   */
  unchanged?: true
}

/** 1 and 4 of the four differences between the shelves: the object key's owner prefix. */
function uploadStorageKey(
  shelf: DocumentShelf,
  organizationId: string,
  documentId: string,
  filename: string,
  folderPath: string | null,
): string {
  return shelf.kind === 'project'
    ? buildStorageKey(organizationId, shelf.projectId, documentId, filename, folderPath)
    : buildArchivStorageKey(organizationId, documentId, filename, folderPath)
}

/**
 * Data-provenance event: who brought which file onto which shelf. The two
 * shelves keep their own action names (`document.uploaded`,
 * `archiv.document.uploaded`) because the trail is read per shelf, and record
 * what locates the file there — the project, or the Archiv's collection.
 */
async function uploadAuditEvent(
  session: AuthorizedSession,
  shelf: DocumentShelf,
  request: Request,
  event: { documentId: string; filename: string; fileSize: number; collectionName: string; replaced: boolean },
): Promise<void> {
  const located =
    shelf.kind === 'project' ? { projectId: shelf.projectId } : { collectionName: event.collectionName }
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: shelf.kind === 'project' ? 'document.uploaded' : 'archiv.document.uploaded',
    targetType: 'document',
    targetId: event.documentId,
    // Filename is user-controlled — cap it before it reaches the trail.
    // `replaced` distinguishes a new document from new bytes under an existing
    // id, which is the one thing the trail could no longer infer from the id.
    metadata: {
      ...located,
      filename: event.filename.slice(0, 200),
      fileSize: event.fileSize,
      ...(event.replaced ? { replaced: true } : {}),
    },
    request,
  })
}

interface PlaceUploadInput {
  shelf: DocumentShelf
  collectionName: string
  filename: string
  folderId: string | null
  folderPath: string | null
  originPath: string | null
  file: File
  bytes: Buffer
  contentHash: string
  storageBucket: string
  uploadBatchId: string | null
  /** Whether the session may write into a folder of this shelf (a superseded document's). */
  mayWriteFolder: (folderId: string | null) => boolean
  /** The screening matches the uploader released (ADR-0085), audited once stored. */
  screeningOverridden: Awaited<ReturnType<typeof assertUploadNameAllowed>>['overridden']
}

type Placed =
  | { unchanged: true; documentId: string }
  | { unchanged: false; documentId: string; storageKey: string; replaced: boolean }

/**
 * Probe, store, admit — and once more when a concurrent FIRST upload of this
 * name won the shelf (`retryRacedUpload`). The second run re-probes, finds the
 * winner, and records these bytes as its next version, exactly as the same two
 * drops one after the other would have.
 */
function placeUpload(session: AuthorizedSession, input: PlaceUploadInput): Promise<Placed> {
  const { shelf, collectionName, filename, folderId, file, contentHash, storageBucket } = input
  return retryRacedUpload(async (): Promise<Placed> => {
    const superseded = await findLiveDocumentByFilename(session.organizationId, collectionName, filename)
    // A re-upload is a new version of the document it supersedes, and files it
    // where this upload goes: a write on the folder it is in now, too (ADR-0087).
    if (superseded && !input.mayWriteFolder(superseded.folderId ?? null)) throw folderReadOnlyError()
    const documentId = superseded?.id ?? crypto.randomUUID()
    /*
     * A re-upload writes NEW bytes, so it needs a NEW key (ADR-0054).
     *
     * The id is deliberately kept — that is what makes citations, chat subjects
     * and folder assignments survive a corrected plan — but the key used to be
     * derived from the id alone, so the new bytes landed on top of the old ones
     * and `discardSupersededObjects` tidied up what was left. That is versioning
     * without the history. Version 1 keeps today's key exactly, so nothing that
     * predates this moves; a re-upload lands under `v<n>/<write id>/`, and the
     * previous version's row still names an object a reader can open.
     *
     * A re-upload ALWAYS gets the write segment (`versionWriteKey`), never the
     * version-1 shortcut: the number is a hint, and it reads 1 whenever the
     * existing row has no version recorded yet — the winner of a concurrent
     * first upload, between its insert and its version — which would aim this
     * PUT at the winner's own flat key and overwrite its bytes. The row's number
     * is allocated under a lock when the version is recorded
     * (`allocateVersionNumber`).
     */
    const baseKey = uploadStorageKey(shelf, session.organizationId, documentId, filename, input.folderPath)
    const storageKey = superseded
      ? versionWriteKey(baseKey, await nextVersionNumber(documentId, session.organizationId), newVersionWriteId())
      : baseKey

    /*
     * THE SAME BYTES, ALREADY HERE. Nothing to do.
     *
     * A folder re-sync is mostly this: a büro drops the directory again to bring
     * three corrected drawings in, and five hundred files that have not changed
     * come along with them. The planner already skips the ones it can prove are
     * identical — but only where the row carries a digest, so a corpus that
     * predates `content_hash`, a browser without `crypto.subtle`, and every
     * non-secure context fall through to here.
     *
     * This tier has the bytes and the row, so it can answer. Answering saves the
     * object write, the quota round trip, and — the expensive one — a full
     * re-ingest that would churn the chunks a citation already points at, for a
     * file that did not change.
     *
     * Deliberately narrow. Only when the row has actually LANDED — a failed, a
     * still-processing and an unrecognised status must all be allowed to retry,
     * which is why the test is the status vocabulary's own `success` — and only
     * when it is already filed where this upload would file it, because
     * otherwise the re-file IS the gesture and skipping would drop it.
     *
     * No audit event either: the trail records who brought which file onto which
     * shelf, and this brought nothing.
     */
    if (
      superseded &&
      superseded.contentHash === contentHash &&
      documentStatusFacts(superseded.status)?.variant === 'success' &&
      (superseded.folderId ?? null) === (folderId ?? null)
    ) {
      return { unchanged: true, documentId }
    }

    await s3Client.send(
      new PutObjectCommand({
        Bucket: storageBucket,
        Key: storageKey,
        Body: input.bytes,
        ContentType: file.type || 'application/octet-stream',
      }),
    )

    await admitRow(session, input, { superseded: Boolean(superseded), documentId, storageKey })
    return { unchanged: false, documentId, storageKey, replaced: Boolean(superseded) }
  })
}

/**
 * The quota's HARD ceiling: the usage is re-read inside the same transaction
 * that inserts the row, under a per-organization lock, so concurrent uploads
 * cannot jointly cross the limit the way the pre-check above allows (ADR-0042).
 *
 * The object is already written, so a refusal has to take it back — the row was
 * not inserted, so nothing else will ever reference those bytes and leaving them
 * would be an orphan only a bucket-wide sweep could find.
 */
async function admitRow(
  session: AuthorizedSession,
  input: PlaceUploadInput,
  placed: { superseded: boolean; documentId: string; storageKey: string },
): Promise<void> {
  const { file, storageBucket, contentHash, folderId } = input
  const { documentId, storageKey } = placed
  if (placed.superseded) {
    // The FULL size is charged: the previous bytes stay behind as the superseded
    // version, so the correction frees nothing — see `replaceDocumentWithinQuota`.
    // NOTHING is discarded: the previous bytes are the previous VERSION's now
    // (ADR-0054), and they go when the document is deleted.
    await admitReplacementOrDiscard(storageBucket, storageKey, session.organizationId, documentId, {
      storageKey,
      storageBucket,
      fileSize: file.size,
      contentType: file.type || null,
      contentHash,
      folderId: folderId ?? null,
      createdBy: session.userId,
      uploadBatchId: input.uploadBatchId,
    })
    return
  }
  // A `LiveFilenameTakenError` out of here is the lost first-upload race: the
  // object is already discarded and nothing was charged, so the retry around
  // the caller starts clean.
  await admitOrDiscard(storageBucket, storageKey, {
    id: documentId,
    ...shelfOwner(input.shelf, session.organizationId),
    folderId: folderId ?? null,
    createdBy: session.userId,
    filename: input.filename,
    storageKey,
    // Recorded even when it IS the shared bucket, so only rows predating
    // migration 0033 rely on the NULL-means-shared convention.
    storageBucket,
    collectionName: input.collectionName,
    fileSize: file.size,
    contentType: file.type || null,
    contentHash,
    originPath: input.originPath,
    uploadBatchId: input.uploadBatchId,
    status: 'uploaded',
  })
}

/**
 * Everything an upload decides before a byte is written: the caller may, the
 * file is allowed, the folder and the collection are the shelf's own, and the
 * name and digest are the ones the row will carry.
 */
async function prepareUpload(
  session: AuthorizedSession,
  shelf: DocumentShelf,
  input: ShelfUploadInput,
): Promise<PlaceUploadInput> {
  // Through the service's own exports, imported late: `service.ts` calls this
  // module, and these two are what it owns (the same device `lifecycle.ts` uses
  // for the dispatcher).
  const { assertUploadTypeAllowed, assertFileSizeAllowed } = await import('./service')
  const { file, folderId } = input

  await requireShelfWrite(session, shelf)
  await assertUploadTypeAllowed(session, file.name)
  assertFileSizeAllowed(file.size, file.name)
  // Org-wide ceiling, checked after the per-file one so the caller gets the more
  // specific complaint first, and BEFORE any bytes reach SeaweedFS so a refusal
  // leaves no orphan object behind (ADR-0042).
  await assertWithinStorageQuota(session.organizationId, file.size)

  const shelfCollection = await shelfCollectionName(shelf, session.organizationId)
  if (!shelfCollection) throw new NotFoundError('Project not found')
  // Before anything reads the folder's path: a folder this uploader may not
  // read does not exist for them, and the name gate below would otherwise
  // answer with the hidden folder's name.
  const gate = await projectFolderGate(session, shelf, folderId, file.name, shelfCollection)
  const collectionName = gate.collectionName

  // Scoped to the shelf, so a folder id from another project, shelf or tenant
  // can never redirect an upload.
  let folderPath: string | null = null
  if (folderId) {
    folderPath = await resolveShelfFolderPath(shelf, folderId, session.organizationId)
    if (folderPath === null) {
      throw new NotFoundError(`Folder not found in ${shelf.kind === 'project' ? 'project' : 'Archiv'}`)
    }
  }
  const originPath = sanitizeOriginPath(input.originPath)
  // The name gate's server-side repeat (ADR-0085), before a byte is stored.
  const nameGate = await assertUploadNameAllowed(
    session.organizationId,
    { filename: file.name, originPath, folderPath },
    input.screeningRelease === true,
  )
  const uploadBatchId = await acceptedUploadBatchId(session, input.uploadBatchId, shelfOwner(shelf, session.organizationId))
  const filename = documentNameKey(file.name)
  if (shelf.kind === 'project') {
    await assertNameFreeElsewhereInProject(session.organizationId, shelf.projectId, collectionName, filename)
  }

  // Create the organization's bucket if this is its first upload (ADR-0043). A
  // no-op when per-org buckets are off. Done before the PUT so a provisioning
  // failure leaves nothing behind, same reasoning as the quota check above.
  const storageBucket = await ensureTenantBucketChecked(bucketAdminS3Client, session.organizationId)

  const bytes = Buffer.from(await file.arrayBuffer())
  return {
    shelf,
    collectionName,
    /*
     * The name, in ONE Unicode form. `file.name` is whatever the operating system
     * that produced it uses, and macOS decomposes. Normalizing here — before the
     * probe, before the storage key and before the row — is what makes the
     * identity hold for a büro that drags an Einreichung off a Mac: without it
     * the probe misses and a second row appears under a name nobody can tell
     * apart from the first. `findLiveDocumentByFilename` still looks for both
     * forms, because rows written before this line exist. See `./name-match`.
     */
    filename,
    folderId,
    folderPath,
    originPath,
    file,
    bytes,
    // The digest of the bytes this tier actually wrote — what makes a folder
    // RE-upload cheap. Its shape lives in `./content-digest`.
    contentHash: contentDigest(bytes),
    storageBucket,
    uploadBatchId,
    mayWriteFolder: gate.mayWriteFolder,
    screeningOverridden: nameGate.overridden,
  }
}

interface FolderGate {
  collectionName: string
  mayWriteFolder: (folderId: string | null) => boolean
}

/**
 * The project shelf's folder gate (ADR-0087). A folder the uploader may not
 * read is not found; one they may only read refuses (403) before a byte is
 * stored; and the folder decides the collection (ADR-0086): a restricted
 * folder's documents live in its own, which holds no IFC model until the
 * building data is partitioned. The Archiv has no per-role folder access.
 */
async function projectFolderGate(
  session: AuthorizedSession,
  shelf: DocumentShelf,
  folderId: string | null,
  fileName: string,
  shelfCollection: string,
): Promise<FolderGate> {
  if (shelf.kind !== 'project') return { collectionName: shelfCollection, mayWriteFolder: () => true }
  const access = await getProjectFolderAccess(session, shelf.projectId, shelfCollection)
  if (!access.isVisible(folderId)) throw new NotFoundError('Folder not found in project')
  if (access.levelOf(folderId) !== 'write') throw folderReadOnlyError()
  const collectionName = access.collectionFor(folderId)
  assertIfcMayBeFiledIn(fileName, collectionName, shelfCollection)
  return { collectionName, mayWriteFolder: (id) => access.levelOf(id) === 'write' }
}

/**
 * One document per name in a project, whichever collection holds it
 * (ADR-0086). A re-upload into the collection that already holds the name
 * replaces it, as before; the same name filed under a different restriction is
 * refused, because replacing it would move it across the boundary unseen. The
 * message names no folder: the other one may be one this person cannot see.
 */
async function assertNameFreeElsewhereInProject(
  organizationId: string,
  projectId: string,
  collectionName: string,
  filename: string,
): Promise<void> {
  const holders = await findProjectCollectionsHoldingFilename(organizationId, projectId, filename)
  if (holders.some((holder) => holder !== collectionName)) {
    throw new ConflictError(
      `A document named "${filename}" already exists elsewhere in this project. Rename the file, or upload it where that document is filed.`,
    )
  }
}

/**
 * Store an uploaded file in SeaweedFS, record it, and hand it to the backend for
 * ingestion. The ingest call is best-effort: the document is already durable in
 * SeaweedFS + Postgres, and status reads reconcile the outcome later.
 *
 * A RE-UPLOAD REPLACES; IT DOES NOT ACCUMULATE. The backend treats the filename
 * as the document's identity, so the SAME id is pointed at the new bytes and
 * every citation, chat subject and folder assignment that referenced the
 * document keeps working. Folders do not change that: a document is unique per
 * filename per collection, whatever folder it is filed in, and uploading the
 * same name into a DIFFERENT folder re-files the one document there.
 */
export async function uploadToShelf(
  session: AuthorizedSession,
  shelf: DocumentShelf,
  input: ShelfUploadInput,
  request: Request,
): Promise<UploadDocumentResult> {
  const { dispatchDocument } = await import('./service')
  const upload = await prepareUpload(session, shelf, input)
  const { file, filename, collectionName, folderPath, storageBucket, contentHash } = upload

  const placed = await placeUpload(session, upload)
  if (placed.unchanged) {
    return { documentId: placed.documentId, jobId: null, status: 'uploaded', filename, unchanged: true }
  }
  const { documentId, storageKey } = placed

  // The version, recorded through the SAME transition table the agent's drafts
  // walk (ADR-0054). Born `published` and born approved: the person who uploaded
  // it is the assertion. Handed the columns THIS request stored, not re-read off
  // a row an overlapping upload may have rewritten in the meantime.
  await recordUploadedVersionOrDiscard(session, documentId, request, {
    storageKey,
    storageBucket,
    contentType: file.type || null,
    fileSize: file.size,
    contentHash,
  })

  const { jobId, status } = await dispatchDocument({
    organizationId: session.organizationId,
    projectId: shelf.kind === 'project' ? shelf.projectId : null,
    documentId,
    filename,
    storageKey,
    storageBucket,
    collectionName,
    // The same path the storage key was built from — what the backend files the
    // document under (ADR-0049), so the agent's inventory and
    // `knowledge_search folder=` see the folder from the first ingest onward.
    folderPath,
  })

  await uploadAuditEvent(session, shelf, request, {
    documentId,
    filename,
    fileSize: file.size,
    collectionName,
    replaced: placed.replaced,
  })
  await auditScreeningOverride(
    session,
    {
      documentId,
      projectId: shelf.kind === 'project' ? shelf.projectId : null,
      filename,
      overridden: upload.screeningOverridden,
    },
    request,
  )

  return { documentId, jobId, status, filename }
}
