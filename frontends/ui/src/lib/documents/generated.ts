/**
 * Filing a document no person wrote.
 *
 * ## Why this is one function and not a pattern
 *
 * `fileGeneratedDocument` is the ONLY way a machine-authored `documents` row
 * comes into existence. The second producer — a compliance export, a BCF
 * round-trip, a Prüfbuch — is a member of {@link GENERATED_DOCUMENT_PRODUCERS}
 * and a CALL SITE. It is never a copy of this function.
 *
 * That is ADR-0042's "one admitting path" applied one level up. Three rules
 * hold for every agent-authored row, and each of them is one line here:
 *
 *   - the bytes are admitted through `admitOrDiscard`, so the quota ledger sees
 *     them (bytes written outside the document service have no row and are
 *     invisible to it);
 *   - nothing is ever dispatched to `/v1/ingest`, so no chunk of a document the
 *     agent wrote can come back to the agent as *Projektwissen*;
 *   - the audit event is emitted with the throwing variant, because "this
 *     document was written by a machine on this human's authority" has no
 *     domain table to fall back on.
 *
 * A producer that copies a route handler instead of calling this keeps none of
 * the three, and it keeps them silently: the row looks identical.
 *
 * ## What it deliberately does not decide
 *
 * `render` is the caller's. The service knows how to FILE bytes, not how to
 * make them — so a new deliverable is a new renderer at a new call site rather
 * than a new pipeline through here.
 */

import 'server-only'
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { bucketAdminS3Client, buildStorageKey, s3Client } from '@/lib/s3'
import { ensureTenantBucketChecked } from '@/lib/storage/bucket'
import { admitOrDiscard } from '@/lib/storage/admission'
import { requireProjectAccess } from '@/lib/authz/projects'
import { recordAuditEventOrThrow } from '@/lib/audit/service'
import { NotFoundError } from '@/lib/api/errors'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getOrCreateProjectFolderByName } from '@/lib/projects/folder-service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { deleteProjectDocument, findDocumentAuthoredByRun } from './repository'

/**
 * What produced a document no person wrote.
 *
 * A `const` tuple for the same reason `DOCUMENT_AUTHORS` is one: the set is
 * enumerable at runtime and the type is derived rather than restated, so the
 * value written into `documents.authored_by_producer` cannot drift from the
 * values this service accepts.
 *
 * **The second producer is a member of this tuple and a caller of
 * {@link fileGeneratedDocument}.** It is not a second copy of the filing code.
 * `deep_research` is the only member today because there is one producer today
 * — read the tuple as the reason the next one is a one-line change, not as a
 * promise that it is coming.
 */
export const GENERATED_DOCUMENT_PRODUCERS = ['deep_research'] as const
export type GeneratedDocumentProducer = (typeof GENERATED_DOCUMENT_PRODUCERS)[number]

/**
 * What the service already knows and a renderer would otherwise re-query.
 *
 * The project is loaded here to validate tenancy and to name the collection, so
 * handing it to the renderer costs nothing; making the renderer fetch it again
 * would cost a round trip per filed document for a fact that cannot have
 * changed in between.
 */
export interface GeneratedRenderContext {
  projectId: string
  projectName: string
}

/** The bytes a producer made, and what they are. */
export interface GeneratedRendering {
  bytes: Uint8Array
  /** The stored `content_type`; also picks the file extension (see below). */
  contentType: string
}

export interface FileGeneratedDocumentInput {
  /** The commissioning human. Their permission is what authorizes the write. */
  session: AuthorizedSession
  projectId: string
  producer: GeneratedDocumentProducer
  /** The backend async job id — `authored_by_run_id`, and the idempotency key. */
  runId: string
  /** What a reader should see in the Files pane. */
  title: string
  /**
   * Produce the bytes. Called only once the write is authorized and the run has
   * been confirmed unfiled, so a producer never renders for a refusal.
   */
  render: (context: GeneratedRenderContext) => Promise<GeneratedRendering> | GeneratedRendering
  /** Source request, for the audit event's IP + user agent context. */
  request?: Request
}

export interface FiledGeneratedDocument {
  documentId: string
  filename: string
  /**
   * Where it landed. Nullable because a row filed by an earlier build, or one a
   * person has since moved to the project root, has no folder — and reporting
   * an empty string for that would be this function inventing a folder id.
   */
  folderId: string | null
  /**
   * True when this call found the run already filed and did nothing. The caller
   * decides whether that is worth a toast; it is never worth an error.
   */
  alreadyFiled: boolean
}

/**
 * Where a producer's output lands.
 *
 * A resolver and not an `if` in the caller, because "does this file itself, and
 * where" is the thing enterprise will want per organization — the precedent is
 * `platform_model_defaults` overridden by an org row (ADR-0014/0022): platform
 * default, tenant override, explicit beats inherited. v1 returns a constant, so
 * becoming that policy is replacing the constant with a lookup rather than
 * finding every call site that hard-coded a folder name.
 *
 * There is deliberately NO policy table yet. One row of one table with one
 * possible value is the speculative version of this function.
 */
export const GENERATED_DOCUMENT_FOLDER_NAME = 'Berichte'

export interface GeneratedDocumentDestination {
  /** A root folder of the project, created on first use. */
  folderName: string
}

export function resolveGeneratedDocumentDestination(
  _producer: GeneratedDocumentProducer,
): GeneratedDocumentDestination {
  return { folderName: GENERATED_DOCUMENT_FOLDER_NAME }
}

/**
 * The extension for a rendered content type.
 *
 * About FILE NAMING only — it decides nothing about what may be rendered, which
 * is the caller's business. An unmapped type still files; it just lands with a
 * generic extension rather than with a wrong one, because a `.docx` that is not
 * one is worse for the person who double-clicks it than a `.bin` that says so.
 */
const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/pdf': 'pdf',
  'text/markdown': 'md',
  'application/json': 'json',
}

/**
 * A header-safe, ASCII file name from a human title.
 *
 * Transliterated rather than carried verbatim, for the reason
 * `answer-export/service.ts` gives about the same problem: this name is
 * GENERATED, so a plain predictable stem is worth more than an umlaut — it is
 * what an architect types into a folder search a year later.
 */
export function generatedFilename(title: string, contentType: string, now: Date): string {
  const day = now.toISOString().slice(0, 10)
  const slug = title
    .normalize('NFKD')
    // `ö` decomposes to `o` + diaeresis and strips to `o`; `ß` has no
    // decomposition at all and would otherwise vanish mid-word.
    .replace(/ß/g, 'ss')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60)
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType.split(';')[0].trim()] ?? 'bin'
  return `${slug || 'piloti'}-${day}.${extension}`
}

/**
 * File a machine-authored document into a project.
 *
 * Returns the existing row when this run has already been filed: a report is
 * fetched every time its tab is opened, and a second document per re-read would
 * be a silent duplicate of a multi-minute run's only artifact.
 */
export async function fileGeneratedDocument(
  input: FileGeneratedDocumentInput,
): Promise<FiledGeneratedDocument> {
  const { session, projectId, producer, runId, title, render, request } = input

  // The capability an organization can withhold (ADR-0038 §3). Spelled exactly
  // as `uploadDocument` spells it, legacy umbrella included: a custom role
  // provisioned before the split holds only `project:edit`, and a filing path
  // that refused it would make "Piloti may write here" depend on when the role
  // was created rather than on what it grants.
  await requireProjectAccess(session, projectId, ['project:documents:write', 'project:edit'])

  // Idempotency, before any byte is rendered. The run id is the key because it
  // is the one identifier the producer and the row already share; a lookup
  // rather than a unique index because the index would have to be partial on
  // three columns to leave `user` rows alone, and the window this closes is a
  // human re-opening a tab, not two writers racing.
  const existing = await findDocumentAuthoredByRun(runId, session.organizationId)
  if (existing) {
    return {
      documentId: existing.id,
      filename: existing.filename,
      folderId: existing.folderId,
      alreadyFiled: true,
    }
  }

  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')

  const rendered = await render({ projectId, projectName: project.name })

  // After the render, so a producer that fails leaves no empty `Berichte`
  // folder standing in a project that never got a report.
  const destination = resolveGeneratedDocumentDestination(producer)
  const folder = await getOrCreateProjectFolderByName(projectId, destination.folderName)

  const documentId = crypto.randomUUID()
  const filename = generatedFilename(title, rendered.contentType, new Date())
  const storageKey = buildStorageKey(session.organizationId, projectId, documentId, filename, folder.path)

  // Create the organization's bucket on first use (ADR-0043) before the PUT, so
  // a provisioning failure leaves nothing behind.
  const storageBucket = await ensureTenantBucketChecked(bucketAdminS3Client, session.organizationId)

  const body = Buffer.from(rendered.bytes)
  await s3Client.send(
    new PutObjectCommand({
      Bucket: storageBucket,
      Key: storageKey,
      Body: body,
      ContentType: rendered.contentType,
    }),
  )

  // The object exists and the row does not, which is the one order every read
  // path can survive — and the reason admission has to be able to take the
  // bytes back. `InsufficientStorageError` propagates unchanged: a generated
  // report is refused by the quota exactly like an upload is.
  await admitOrDiscard(storageBucket, storageKey, {
    id: documentId,
    organizationId: session.organizationId,
    projectId,
    folderId: folder.id,
    // Provenance is not responsibility (ADR-0047): the human commissioned the
    // run and the export needs somebody to print, so `createdBy` stays theirs.
    createdBy: session.userId,
    authoredBy: 'agent',
    authoredByProducer: producer,
    authoredByRunId: runId,
    filename,
    displayName: title.trim() || filename,
    storageKey,
    storageBucket,
    // The collection this project's evidence lives in — recorded because the
    // column says which corpus the row BELONGS to, not which one holds chunks
    // for it. Nothing is ever indexed here, so there are none; the safety comes
    // from the dispatch that does not happen, never from this string.
    collectionName: project.collectionName,
    fileSize: body.byteLength,
    contentType: rendered.contentType,
    // Terminal, and honest: the bytes are here and indexing was deliberately
    // skipped. `pending` would render a spinner waiting on a job nobody
    // dispatched.
    status: 'stored',
  })

  // NOTHING is dispatched here. No `/v1/ingest`, no collection write, no
  // `dispatchDocument`. A report the agent wrote, embedded into the project
  // corpus, comes back to the agent as retrievable evidence under a green
  // *Projektwissen* badge, indistinguishable from a stamped Gutachten — and the
  // retrieval path's documented posture is fail-OPEN, so a filter there is not
  // a safety mechanism. No chunks exist, so self-citation is unrepresentable
  // rather than filtered. `src/lib/documents/generated.spec.ts` asserts the
  // absence at the dispatch site; do not add a call here.

  try {
    await recordAuditEventOrThrow({
      organizationId: session.organizationId,
      // The actor stays the human — they are the authorization principal, and
      // the trail is searched by actor. The run rides along as a second target.
      actor: { type: 'agent', userId: session.userId, email: session.email, runId },
      action: 'document.generated',
      targetType: 'document',
      targetId: documentId,
      metadata: { projectId, producer, filename, fileSize: body.byteLength },
      request,
    })
  } catch (error) {
    // The record IS the answer to "who authorized this document", and there is
    // no domain table that answers it instead. A row we cannot account for must
    // not be left looking like a filed report, so the filing is undone and the
    // failure is surfaced.
    await unfile(documentId, projectId, session.organizationId, storageBucket, storageKey)
    throw error
  }

  return { documentId, filename, folderId: folder.id, alreadyFiled: false }
}

/**
 * Take back a document that was filed and then could not be accounted for.
 *
 * Both steps are best-effort in the same direction admission's discard is: the
 * caller is already failing, and turning the compensation's own failure into a
 * different error would hide the one that matters. The row goes first — it is
 * what any surface reads — so a failure after it leaves an orphan object the
 * project purge collects, never a document with no bytes.
 */
async function unfile(
  documentId: string,
  projectId: string,
  organizationId: string,
  bucket: string,
  storageKey: string,
): Promise<void> {
  try {
    await deleteProjectDocument(documentId, organizationId, projectId)
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }))
  } catch (error) {
    console.error(
      '[documents] failed to unfile a generated document after its audit write failed',
      { documentId, bucket, storageKey, cause: error instanceof Error ? error.name : 'unknown' },
    )
  }
}
