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
import type { AuthoredRefKind } from './document-authors'
import { deleteProjectDocument, findDocumentAuthoredByRef } from './repository'

/**
 * What produced a document no person wrote, and what kind of identifier it
 * files under.
 *
 * A `const` map for the reason `AUDIT_SCHEMAS` is one: the set is enumerable at
 * runtime, the type is DERIVED from the keys rather than restated, and the fact
 * each producer owes — its reference kind — is stated in the same place as the
 * producer itself, so the two cannot drift. A producer without a kind is
 * unrepresentable rather than merely detectable.
 *
 * **The second producer is a key of this map and a caller of
 * {@link fileGeneratedDocument}.** It is not a second copy of the filing code.
 * `src/lib/diagrams/filing.ts` is what that looked like when it happened: two
 * members added here, one new caller, no second insert path — so the quota, the
 * audit emit and the no-ingest rule are true of the new rows because they go
 * through the same function rather than through a copy of it.
 *
 * A producer is a KIND OF DELIVERABLE, not a piece of software. `diagram_svg`
 * and `diagram_pdf` are two members rather than one `diagram` because they are
 * two files with two content types a reader uses for two different things — one
 * previews in the Files pane and carries the diagram source for regeneration,
 * the other is what gets attached to an Einreichung — and because since
 * migration 0065 the producer is half of the idempotency key. Collapsing them
 * into one member would make a diagram file one artifact or the other and never
 * both, which is the bug 0065 exists to fix.
 *
 * ## Why the reference KIND lives here and not at the call site
 *
 * Because a call site that can state it is a call site that can state the wrong
 * one, and nothing downstream could tell. That is not hypothetical — it is
 * exactly what happened without this map: `authored_by_run_id` held a backend
 * job id for `deep_research` and `{chat message id}-{source hash}` for the two
 * diagram producers, both written by callers passing a field called `runId`,
 * and the row, the column comment and the `agent_run` audit target all went on
 * saying "job id" for all three. Migration 0066 is the repair; this map is what
 * stops it recurring, because the kind is now a property of the deliverable and
 * the caller supplies only the identifier itself.
 */
export const GENERATED_DOCUMENT_PRODUCER_REF_KINDS = {
  /** The backend async job that ran the research. */
  deep_research: 'agent_run',
  /** The chat answer the diagram was drawn in, plus a hash of its source. */
  diagram_svg: 'answer_artifact',
  diagram_pdf: 'answer_artifact',
} as const satisfies Record<string, AuthoredRefKind>

export type GeneratedDocumentProducer = keyof typeof GENERATED_DOCUMENT_PRODUCER_REF_KINDS

/**
 * The producers, as a list. DERIVED from the map above and never hand-written,
 * for the reason `AUDIT_ACTIONS` is derived from `AUDIT_SCHEMAS`: two lists that
 * are meant to be one are two lists that drift, and the drift here would be a
 * producer this service accepts and has no reference kind for.
 */
export const GENERATED_DOCUMENT_PRODUCERS = Object.keys(
  GENERATED_DOCUMENT_PRODUCER_REF_KINDS,
) as readonly GeneratedDocumentProducer[]

/**
 * Postgres' `unique_violation`.
 *
 * Named rather than spelled at the catch site for the reason
 * `folder-service.ts` names it too: `'23505'` in a conditional reads as a magic
 * number, and the branch it guards is the difference between recovering from a
 * race and swallowing an unrelated database failure.
 */
const UNIQUE_VIOLATION = '23505'

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
  /**
   * WHICH ONE — the identifier of the thing that produced this deliverable, and
   * the idempotency key. It lands in `authored_by_ref`.
   *
   * Only the identifier. What KIND of identifier it is is not the caller's to
   * say: it is read off the producer through
   * {@link GENERATED_DOCUMENT_PRODUCER_REF_KINDS} and written into
   * `authored_by_ref_kind` beside it, so the row can be resolved by somebody who
   * was not here. See that map for what happened while callers of a field called
   * `runId` were free to pass anything.
   */
  ref: string
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
  'image/svg+xml': 'svg',
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
 * Returns the existing row when this reference has already been filed: a report is
 * fetched every time its tab is opened, and a second document per re-read would
 * be a silent duplicate of a multi-minute run's only artifact.
 *
 * ## Once per (reference, producer), whichever way the calls interleave
 *
 * That guarantee is TWO mechanisms, and it needs both. The probe below answers
 * the sequential case cheaply and before anything is rendered. The unique index
 * `uniq_documents_authored_ref_producer_per_project` (migration 0065, widening
 * 0064's key by the producer; renamed with its column by 0066) answers the concurrent one, which the probe cannot: two tabs open the same report, both
 * probe before either inserts, both miss, and a lookup has no way to know it
 * lost. The catch around `admitOrDiscard` is what turns the index's rejection
 * into the same `alreadyFiled` answer the probe gives.
 *
 * The duplicate this forecloses is not merely untidy. `generatedFilename` is
 * deterministic, so two rows of ONE producer agree on filename, display name,
 * size, folder, author, run and second — identical in every attribute a reader
 * can see. (Two rows of two producers do not: they differ by extension, which
 * is why 0065 lets a diagram be both an SVG and a PDF and still be one thing.) The
 * repository calls that out as "precisely the thing an office cannot untangle
 * later", and an office that cannot tell two reports apart keeps both.
 */
export async function fileGeneratedDocument(
  input: FileGeneratedDocumentInput,
): Promise<FiledGeneratedDocument> {
  const { session, projectId, producer, ref, title, render, request } = input
  // Not passed in, and that is the point — see the producer map's header.
  const refKind = GENERATED_DOCUMENT_PRODUCER_REF_KINDS[producer]

  // The capability an organization can withhold (ADR-0038 §3). Spelled exactly
  // as `uploadDocument` spells it, legacy umbrella included: a custom role
  // provisioned before the split holds only `project:edit`, and a filing path
  // that refused it would make "Piloti may write here" depend on when the role
  // was created rather than on what it grants.
  await requireProjectAccess(session, projectId, ['project:documents:write', 'project:edit'])

  // Idempotency, before any byte is rendered. The reference is the key because
  // it is the one identifier the producer and the row already share.
  //
  // This is the CHEAP half, not the guarantee: it saves a re-opened tab a render,
  // a PUT and a quota round trip. It cannot see a concurrent caller that has not
  // inserted yet, which is why 0064's unique index exists and why the catch
  // below has to key on the same three columns this asks about — an index and a
  // probe that disagree turn a race into either a 500 or a duplicate.
  const existing = await findDocumentAuthoredByRef(ref, session.organizationId, projectId, producer)
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
  try {
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
      authoredByRef: ref,
      // Written, not derived on read. The producer→kind map is CODE and code
      // changes; recomputing the kind would silently re-interpret rows that were
      // written under an older answer. See the column's own note.
      authoredByRefKind: refKind,
      filename,
      displayName: title.trim() || filename,
      storageKey,
      storageBucket,
      // The collection this project's evidence lives in — recorded because the
      // column says which corpus the row BELONGS to, not which one holds chunks
      // for it. Nothing is ever indexed here, so there are none; the safety
      // comes from the dispatch that does not happen, never from this string.
      collectionName: project.collectionName,
      fileSize: body.byteLength,
      contentType: rendered.contentType,
      // Terminal, and honest: the bytes are here and indexing was deliberately
      // skipped. `pending` would render a spinner waiting on a job nobody
      // dispatched.
      status: 'stored',
    })
  } catch (error) {
    // The probe above lost a race. Both callers ran it before either had
    // inserted, both missed, both rendered, both PUT an object — and because
    // `generatedFilename` is deterministic (slug + date + extension), the two
    // rows would have been identical in every attribute a person can see. An
    // office cannot untangle two byte-identical reports of one run, so
    // `uniq_documents_authored_ref_producer_per_project` (migrations 0065/0066)
    // makes the second insert fail instead of succeed. This is the folder path's shape
    // one level up: the index is what makes it correct, the catch is what makes
    // it graceful — the loser must not 500 on somebody's finished report.
    if ((error as { code?: string } | null)?.code !== UNIQUE_VIOLATION) throw error

    // The winner's row, which is now the only document this run has. Re-probed
    // rather than assumed, because the answer the caller needs (the id, the
    // filename, the folder) belongs to the row that survived, not to the one
    // this call built.
    const winner = await findDocumentAuthoredByRef(ref, session.organizationId, projectId, producer)
    // Cannot happen while the index and the probe key on the same four columns
    // — which is exactly why 0065's header derives one from the other. If it
    // ever does, the two have drifted, and a violation reported as success would
    // hand the caller a document id it does not have.
    if (!winner) throw error

    // NOT unfiled here, and nothing is left behind: this call inserted no row,
    // and its object is already gone. `admitOrDiscard` discards on ANY throw
    // from admission, not only on a quota refusal, and the loser's key carries
    // its own `documentId`, so the delete cannot touch the winner's bytes.
    // Without that, every lost race would leave an object with no row —
    // invisible to the UI and to the quota ledger, findable only by a
    // bucket-wide sweep. `generated.spec.ts` asserts one surviving object.
    return {
      documentId: winner.id,
      filename: winner.filename,
      folderId: winner.folderId,
      alreadyFiled: true,
    }
  }

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
      // The run — or whatever kind of thing this reference names. The kind IS
      // the audit target type, so a diagram's reference lands as an
      // `answer_artifact` target rather than being asserted to be a job id
      // nobody can look up. See `AUTHORED_REF_KINDS`.
      actor: { type: 'agent', userId: session.userId, email: session.email, ref: { kind: refKind, id: ref } },
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
 *
 * They are, however, INDEPENDENTLY best-effort, and that is the whole point of
 * the two blocks below. Sharing one `try` made the object delete conditional on
 * the row delete having succeeded, so the one failure the ordering was chosen
 * to survive — the row delete itself — skipped the object entirely and left
 * exactly what this function exists to prevent: a row that is filed,
 * quota-charged, visible in Files as „Von Piloti erstellt", and backed by no
 * audit record at all. The ordering argument above only ever justified the
 * SEQUENCE; it never justified coupling the second step's execution to the
 * first step's success.
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
  } catch (error) {
    console.error(
      '[documents] failed to delete the row of a generated document after its audit write failed',
      { documentId, cause: error instanceof Error ? error.name : 'unknown' },
    )
  }

  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }))
  } catch (error) {
    console.error(
      '[documents] failed to delete the object of a generated document after its audit write failed',
      { documentId, bucket, storageKey, cause: error instanceof Error ? error.name : 'unknown' },
    )
  }
}
