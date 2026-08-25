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
 * That is ADR-0042's "one admitting path" applied one level up. Five rules
 * hold for every agent-authored row, and each of them is one line here:
 *
 *   - the write is gated on `project:documents:write` AND
 *     `project:documents:generate`, and on the deployment's own flag, so an
 *     organization can stop machine authorship without stopping its people
 *     uploading and an operator can stop it everywhere at once (see the
 *     conjunction argument at the checks themselves);
 *   - the bytes are admitted through `admitOrDiscard`, so the quota ledger sees
 *     them (bytes written outside the document service have no row and are
 *     invisible to it);
 *   - nothing is ever dispatched to `/v1/ingest`, so no chunk of a document the
 *     agent wrote can come back to the agent as *Projektwissen*;
 *   - the audit event is emitted with the throwing variant, because "this
 *     document was written by a machine on this human's authority" has no
 *     domain table to fall back on;
 *   - the bytes SAY a machine wrote them, checked against the bytes themselves
 *     before anything is stored. The byline "Von Piloti erstellt" is chrome and
 *     stays in the app; a file on somebody's disk, or attached to an
 *     Einreichung, carries only what is inside it. See
 *     {@link GeneratedRendering.marking} for why that stopped being a
 *     convention each producer kept, and what it cost while it was one.
 *
 * A producer that copies a route handler instead of calling this keeps none of
 * the five, and it keeps them silently: the row looks identical.
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
import { aiProvenanceMarking, markingIsInBytes, type AiProvenanceMarking } from '@/lib/ai-provenance'
import { latinize } from '@/lib/text/latinize'
import { FEATURE_FLAGS, isAgentAuthoredDocumentsEnabled } from '@/lib/authz/feature-flags'
import { recordAuditEventOrThrow } from '@/lib/audit/service'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
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
 * Which reference kinds are a RUN, and therefore belong in `AIRunId`.
 *
 * A `Record<AuthoredRefKind, boolean>` and not an `if`, for the reason
 * {@link GENERATED_DOCUMENT_PRODUCER_REF_KINDS} is a map: it is exhaustive by
 * construction, so a third kind of reference is a compile error here rather
 * than a silent decision that it is not a run.
 *
 * The distinction is the one migration 0066 exists for. `AIRunId` names
 * something an auditor can look up in the job store; a diagram's reference is
 * `{chat message id}-{hash of its source}` and is not in that store. Writing it
 * into `AIRunId` anyway would put a value nobody can resolve into the field a
 * detector reads — the same mistake the column made while it was called
 * `authored_by_run_id`, in the one place that reaches a Behörde. So a diagram's
 * marking carries no run id at all, which `AiProvenance.runId` already says is
 * the right answer: "a run id nobody can look up is worse than no run id".
 */
const REF_KIND_IS_A_RUN: Record<AuthoredRefKind, boolean> = {
  agent_run: true,
  answer_artifact: false,
}

/**
 * The marking a producer's bytes must carry, decided HERE.
 *
 * Exported because `lib/diagrams/filing.ts` has to write the marking into the
 * SVG it hands back, and it builds those bytes before `render` is called — but
 * the value is still this module's answer, not that caller's, and
 * `fileGeneratedDocument` recomputes it and refuses a rendering that disagrees.
 * A caller can therefore be early, never different.
 */
export function generatedDocumentMarking(
  producer: GeneratedDocumentProducer,
  ref: string,
): AiProvenanceMarking {
  const refKind = GENERATED_DOCUMENT_PRODUCER_REF_KINDS[producer]
  return aiProvenanceMarking(REF_KIND_IS_A_RUN[refKind] ? { runId: ref } : {})
}

/**
 * A producer handed back bytes that do not say a machine wrote them.
 *
 * Named, and thrown rather than logged, because the alternative is the failure
 * this whole mechanism exists to prevent: a file leaving the product with no
 * statement of its own authorship, filed and quota-charged and looking exactly
 * like a document a person wrote. Nothing is stored when this throws — the
 * check runs after `render` and before the folder, the PUT and the row — so the
 * user is told the filing failed, which is true, instead of being handed an
 * unmarked artifact they may attach to an Einreichung.
 *
 * It carries no bytes and no marking in its message. It is a bug report for a
 * PRODUCER, and the producer is named; the rest is in the code that failed.
 */
export class UnmarkedRenderingError extends Error {
  constructor(readonly producer: GeneratedDocumentProducer, readonly contentType: string) {
    super(`${producer} rendered ${contentType} bytes that do not carry the AI marking`)
    this.name = 'UnmarkedRenderingError'
  }
}

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
  /**
   * The marking these bytes MUST carry — handed down rather than looked up, so
   * that no producer decides what "marked" means. See
   * {@link generatedDocumentMarking} for why the seam and not the producer
   * chooses it, and {@link GeneratedRendering.marking} for what is done with it.
   */
  marking: AiProvenanceMarking
}

/** The bytes a producer made, what they are, and how they say who wrote them. */
export interface GeneratedRendering {
  bytes: Uint8Array
  /** The stored `content_type`; also picks the file extension (see below). */
  contentType: string
  /**
   * The marking that is IN {@link bytes}. Mandatory, and checked.
   *
   * ## Why this is a field and not a convention
   *
   * It used to be a convention, and the convention was two-thirds unkept. The
   * marking was applied at each producer — `deep_research` set the PDF's
   * `Keywords` and printed a notice, `diagram_pdf` printed a footer line and
   * set no metadata at all, and `diagram_svg` marked NOTHING anywhere in its
   * bytes — and nothing in the type system or the tests noticed, because every
   * assertion available was about the object that described the file rather
   * than about the file.
   *
   * Required here, a producer cannot return bytes without answering the
   * question, and a FOURTH producer cannot be added without answering it
   * either. Branded ({@link AiProvenanceMarking}), the answer cannot be a
   * sentence of the producer's own invention — the only way to obtain the type
   * is `aiProvenanceMarking`, so every marked file is marked in the one
   * vocabulary a detector matches on. And verified against the real bytes at
   * the seam, the answer cannot be merely claimed: `fileGeneratedDocument`
   * refuses to store a rendering whose marking is not findable in it.
   *
   * Together those three make an unmarked machine-authored file
   * unrepresentable, which is what a byline inside the app cannot do for a file
   * on somebody's disk or attached to an Einreichung.
   */
  marking: AiProvenanceMarking
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
 *
 * Which is exactly why it goes through `lib/text/latinize` rather than doing
 * its own NFKD. The hand-rolled version spelled only `ß`, so every other umlaut
 * was STRIPPED rather than spelled: „Fluchtweglängen Gebäudeklasse 4" filed as
 * `fluchtweglangen-gebaudeklasse-4-…`, two misspelt German words on the
 * filename of a document that goes to a Behörde. It also defeated the stated
 * purpose — an architect searching a folder types „Fluchtweglängen" or
 * „Fluchtweglaengen", and that stem matches neither.
 *
 * `latinize` is DIN 5007-2 (the passport transliteration) followed by the
 * generic fold, so `ä ö ü ß` spell out and a Czech or Polish client name
 * survives instead of becoming hyphens. It was written to end precisely this
 * drift — three private copies of the table, one of which slugged
 * `Beispielstraße` to `Beispielstra-e` — and its header lists the callers that
 * deliberately opt out. This was never one of them; it was a fourth copy,
 * written after the module existed.
 */
export function generatedFilename(title: string, contentType: string, now: Date): string {
  const day = now.toISOString().slice(0, 10)
  const slug = latinize(title)
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

  // ## The gates, in the order they are cheapest to fail
  //
  // First the deployment's own answer, which costs no I/O and is nobody's
  // grant: with agent-authored documents switched off there is no capability to
  // authorize, so a refusal here must not spend an FGA round trip or read like a
  // permission the reader could be given. See the flag's registry entry for why
  // an operator kill switch cannot be a permission (editing the catalog's own
  // roles is CI drift) and why a tenant lever cannot be a flag (targeting is the
  // platform owner's, not the organization's).
  if (!isAgentAuthoredDocumentsEnabled(session)) {
    throw new ForbiddenError('Agent-authored documents are disabled', {
      feature: FEATURE_FLAGS.agentAuthoredDocuments,
    })
  }

  // ## Two permissions, and why this is a conjunction rather than a substitution
  //
  // `project:documents:write` is asked FIRST and unchanged — spelled exactly as
  // `uploadDocument` spells it, legacy umbrella included, because a custom role
  // provisioned before ADR-0038 §3's split holds only `project:edit` and a
  // filing path that refused it would make "may write here" depend on when the
  // role was created rather than on what it grants.
  //
  // It is asked because **filing a generated document IS a document write.**
  // Same bucket, same `admitOrDiscard` quota ledger, same folder tree, same
  // `deleteDocument` afterwards. The question that permission answers — may
  // bytes be admitted into this project's file system, in this session's name —
  // is not changed by whose hand shaped the bytes.
  //
  // `project:documents:generate` answers a second and narrower question: may a
  // **non-`user` author's** bytes be admitted at all. It is required IN ADDITION,
  // and the reasons are ADR-0047's, in its own terms:
  //
  //   1. **ADR-0047 adds relations, it never substitutes them.** Provenance
  //      arrived in the 2026-08-20 addendum as a FOURTH relation beside access
  //      and assignment — "`createdBy` and `authored_by` are deliberately not
  //      collapsed" — precisely because a schema that can record only one of two
  //      facts has to lie about the other. A permission model that let
  //      authorship REPLACE access would collapse at the capability level the
  //      pair the data model was careful to keep apart.
  //   2. **Substitution rebuilds the wider principal the design deleted.** The
  //      design's decision 4 put the write in the commissioning user's session
  //      so that the agent never holds authority the human lacks. If `generate`
  //      stood alone, an organization could grant a role the power to put bytes
  //      into the project file system that it cannot put there by uploading —
  //      and cannot remove afterwards, since delete is `documents:write`. A
  //      principal that writes more than it can undo is the "agent's principal
  //      is wider than the user's" hole, rebuilt in the catalog after having
  //      been deleted from the request path.
  //   3. **It keeps the addendum's sentence literally true.** ADR-0047's second
  //      addendum states what the column means: "this row was filed through the
  //      generated-document path, in `createdBy`'s session, with
  //      `project:documents:write` in hand." The "forged shelf is the LESS
  //      capable one" argument rests on that — an author who can file but cannot
  //      upload or delete is not less capable in the way the paragraph claims.
  //      Conjunction is what keeps the sentence a fact instead of history.
  //
  // The cost is real and it is the correct one: nothing holds the new permission
  // until the catalog is provisioned (`npm run provision:authz -- --apply`), so
  // a custom project role that predates this change stops filing until somebody
  // grants it. A capability whose whole purpose is to be withholdable must fail
  // to the state the organization has not asked for — which is also why the
  // `project:edit` umbrella is NOT accepted here. The umbrella keeps grants that
  // predate a SPLIT working; this is not a split, and a permission every legacy
  // role already implicitly holds would be exactly the un-withholdable lever
  // this one exists to replace.
  await requireProjectAccess(session, projectId, ['project:documents:write', 'project:edit'])
  await requireProjectAccess(session, projectId, 'project:documents:generate')

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

  const marking = generatedDocumentMarking(producer, ref)
  const rendered = await render({ projectId, projectName: project.name, marking })

  // THE marking check, and the reason it is here rather than in three producers.
  //
  // Two questions, both asked of what actually exists rather than of what a
  // producer intended:
  //
  //   - is this the marking this document is supposed to carry? A producer that
  //     built its own — with a run id for a reference that is not a run, say —
  //     is refused rather than quietly filed under a weaker statement;
  //   - is that marking IN the bytes? Every producer builds its file through a
  //     library that is free to drop what it was handed, and two of the three
  //     did exactly that: `diagram_pdf` set no PDF keywords and `diagram_svg`
  //     wrote no marking at all. Both passed every test there was, because the
  //     tests could only ask the element tree.
  //
  // Before the folder, the PUT and the row, so an unmarked rendering leaves
  // nothing behind — the same ordering argument the folder creation makes one
  // line down.
  if (rendered.marking !== marking || !markingIsInBytes(rendered.bytes, marking)) {
    throw new UnmarkedRenderingError(producer, rendered.contentType)
  }

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
 * Both steps are best-effort in the direction admission's discard is: the
 * caller is already failing, and turning the compensation's own failure into a
 * different error would hide the one that matters. Neither throws.
 *
 * ## Which leftover is worse, which is what decides the order
 *
 * Compensation can fail, so the only question this function gets to answer is
 * WHICH wreckage it leaves. There are two:
 *
 *   - **Row gone, object left.** An orphan object. Nobody can see it, nothing
 *     lists it, and the project purge collects it. Costs bytes.
 *   - **Row left, object gone.** A document in the Files pane, labelled „Von
 *     Piloti erstellt", whose preview and download 404 forever, and whose
 *     idempotency key is occupied — so the report it stood for can never be
 *     filed again under that (project, reference, producer). Costs the reader's
 *     trust in every other row beside it.
 *
 * The second is strictly worse, so the object is deleted only once the row is
 * known to be gone.
 *
 * This corrects the arrangement that stood here before, which ran the two
 * deletes independently so that neither waited on the other. That was reasoned
 * from a real failure — an earlier version shared one `try`, so a failed row
 * delete skipped the object — but it fixed it by producing the worse leftover
 * instead of the better one: with the steps independent, a failed row delete
 * still deletes the object, which is precisely "row left, object gone". The
 * header nonetheless kept claiming the outcome was "never a document with no
 * bytes", one paragraph above the change that made it reachable.
 *
 * What the coupling actually leaves when the row delete fails is a filed,
 * quota-charged row with no audit record AND ITS BYTES INTACT — bad, and worth
 * the log line below, but a document that opens. An operator can delete it
 * through the application, which releases the quota and the object together.
 * The other order leaves them nothing to delete cleanly.
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
      '[documents] failed to delete the row of a generated document after its audit write failed; ' +
        'its object is deliberately LEFT so the document still opens — delete it through the application',
      { documentId, bucket, storageKey, cause: error instanceof Error ? error.name : 'unknown' },
    )
    return
  }

  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }))
  } catch (error) {
    console.error(
      '[documents] failed to delete the object of a generated document after its audit write failed; ' +
        'the row is gone, so this is an orphan object for the project purge',
      { documentId, bucket, storageKey, cause: error instanceof Error ? error.name : 'unknown' },
    )
  }
}
