/**
 * BIM model service — the authorized, user-facing surface over parsed models.
 *
 * Split from `service.ts` (which owns the extraction pipeline) because the two
 * answer different questions: that module turns bytes into a model, this one
 * decides who may look at one. Authorization mirrors the documents domain
 * exactly, because a model IS a document — a project model goes through
 * per-project FGA, an Archiv model (no project) is readable by any member of
 * the organization that owns it. Cross-tenant and no-access both surface as 404.
 */

import 'server-only'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, signingS3Client } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { requireProjectAccess } from '@/lib/authz/projects'
import { requireResourceAccess } from '@/lib/sharing/access'
import { isIfcModelsEnabled } from '@/lib/authz/feature-flags'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { findDocumentInOrg } from '@/lib/documents/repository'
import type { Document } from '@/lib/db/schema'
import { findProjectInOrg } from '@/lib/projects/repository'
import type { AuthorizedSession } from '@/lib/auth/types'
import { buildComplianceBcf, type BcfExport } from './bcf'
import { buildBimDerivedKeys } from './service'
import { attachConfirmations } from './rules'
import { revisionSeriesKey } from './revision-series'
import {
  deleteBimCheckConfirmation,
  findBimModelByDocument,
  findBimModelById,
  listBimCheckConfirmations,
  listBimModels,
  upsertBimCheckConfirmation,
  type BimModelHeader,
  type BimStoredConfirmation,
} from './repository'
import { runBimQuery, type BimHauptnutzung, type BimQuery, type BimQueryResult } from './query'

const presignTtlSeconds = (): number => Number(process.env.SEAWEED_PRESIGNED_URL_TTL_SECONDS || 600)

/**
 * Refuse every model surface when the `ifc-models` flag is off for this org.
 *
 * The routes are otherwise reachable by URL on a deployment that has not bought
 * the feature — the flag would then gate only the upload button, which is a UI
 * preference rather than a boundary.
 */
export function assertIfcModelsEnabled(session: AuthorizedSession): void {
  if (!isIfcModelsEnabled(session)) {
    throw new ForbiddenError('IFC models are not enabled for this organization')
  }
}

/**
 * Enforce, on the document a model was read from, the access ITS SHELF demands.
 *
 * The check is on the DOCUMENT, not on the model row: the model is derived data
 * and the document is the thing the sharing rules are written about, so
 * deriving access from anywhere else would eventually let the two disagree.
 *
 * ## Why this switches on `scope` and not on `projectId`
 *
 * It used to be `if (document.projectId !== null) requireProjectAccess(...)`,
 * i.e. "a model with no project is an Archiv model, and any member of the
 * organization may read it". That was true while the Archiv was the only
 * project-less shelf. ADR-0047 Phase 2 added a second one: a file dropped into
 * a chat is `scope = 'session'` with a NULL project, and it goes through the
 * same dispatcher, so an IFC attached to a private conversation becomes a
 * `bim_models` row with `project_id IS NULL` — indistinguishable, under the old
 * test, from a document deliberately shared with the whole office.
 *
 * The consequence was not theoretical. Every surface that authorizes through
 * here — the model header, the element query, the compliance run, and the
 * presigned URL that streams the raw file — would have served a private chat
 * attachment to any member of the organization holding its model id. The
 * documents domain closed this exact hole in `getAccessibleDocument` (and the
 * `documents` table states it as a CHECK constraint); the BIM surface still
 * carried the old disjunction.
 *
 * An exhaustive `switch` is what keeps it closed: a fourth shelf fails to
 * compile here rather than silently inheriting the Archiv's rule.
 */
async function assertDocumentReadable(
  session: AuthorizedSession,
  document: Document,
  notFoundMessage: string
): Promise<void> {
  switch (document.scope) {
    case 'archiv':
      // Org-wide by design, and `findDocumentInOrg` has already established that
      // the row belongs to the caller's organization.
      return
    case 'session':
      // As private as the chat it hangs off — the same grant the document's own
      // download route requires (ADR-0032/0047).
      if (!document.conversationId) throw new NotFoundError(notFoundMessage)
      await requireResourceAccess(session, 'conversation', document.conversationId, 'viewer')
      return
    case 'project': {
      // A `project` row with no project is a corrupt row, not an org-wide one:
      // there is nothing to authorize against, so it is not found.
      if (document.projectId === null) throw new NotFoundError(notFoundMessage)
      await requireProjectAccess(session, document.projectId, 'project:view')
      return
    }
    default: {
      const unreachable: never = document.scope
      throw new NotFoundError(`Unknown document scope: ${String(unreachable)}`)
    }
  }
}

/** Load a model and enforce the access its document's shelf demands. */
export async function getAccessibleModel(
  session: AuthorizedSession,
  modelId: string
): Promise<BimModelHeader> {
  assertIfcModelsEnabled(session)
  const model = await findBimModelById(modelId, session.organizationId)
  if (!model) throw new NotFoundError('Model not found')

  const document = await findDocumentInOrg(model.documentId, session.organizationId)
  if (!document) throw new NotFoundError('Model not found')

  await assertDocumentReadable(session, document, 'Model not found')
  return model
}

/** The model belonging to a document the caller may read, or null. */
export async function getModelForDocument(
  session: AuthorizedSession,
  documentId: string
): Promise<BimModelHeader | null> {
  assertIfcModelsEnabled(session)
  const document = await findDocumentInOrg(documentId, session.organizationId)
  if (!document) throw new NotFoundError('Document not found')
  await assertDocumentReadable(session, document, 'Document not found')
  return findBimModelByDocument(documentId, session.organizationId)
}

/**
 * Models a project can see: its own, plus the org-wide Archiv's.
 *
 * The same scope rule retrieval uses — a chat that can cite an Archiv document
 * can query the model that document is.
 */
export async function listAccessibleModels(
  session: AuthorizedSession,
  projectId: string
): Promise<BimModelHeader[]> {
  assertIfcModelsEnabled(session)
  await requireProjectAccess(session, projectId, 'project:view')
  return listBimModels(session.organizationId, { projectId, includeArchiv: true })
}

/**
 * Run a validated query against a model the caller may read.
 *
 * BOTH models are authorized when the op names a second one. `compare` and
 * `compliance-diff` take a `baseModelId` straight from the request body, and
 * `runBimQuery` resolves it with `findBimModelById`, which scopes on the
 * ORGANIZATION and nothing else — the per-project FGA that `getAccessibleModel`
 * applies to the target never reaches the base.
 *
 * Without the check below, a member holding `project:view` on one project can
 * name any model id in the organization as the base and read another project's
 * building out of the diff: `compare` reports every base element absent from
 * the revision as `removed`, with its name and storey, and `compliance-diff`
 * reports the base's per-rule verdict counts and its file name.
 * `requireProjectAccess` deliberately answers 404 so a caller cannot even
 * confirm such a project exists; handing its element names over through a
 * second parameter undoes that.
 */
export async function queryAccessibleModel(
  session: AuthorizedSession,
  modelId: string,
  request: BimQuery
): Promise<BimQueryResult> {
  const model = await getAccessibleModel(session, modelId)
  const baseModelId = 'baseModelId' in request ? request.baseModelId : undefined
  if (typeof baseModelId === 'string' && baseModelId !== model.id) {
    await getAccessibleModel(session, baseModelId)
  }
  return runBimQuery(request, { modelId: model.id, organizationId: session.organizationId })
}

export interface BimModelSource {
  /** Presigned GET for the raw IFC — the viewer streams geometry from this. */
  url: string
  filename: string
  expiresInSeconds: number
}

/**
 * A short-lived download URL for the model's own bytes.
 *
 * The 3D viewer parses and triangulates in the BROWSER: ifc-lite's geometry
 * kernel is WASM, the renderer is WebGPU, and neither exists server-side. That
 * makes the source file the viewer's actual input — it is not a download link
 * bolted on, it is how the model is displayed at all. The URL is presigned with
 * the same TTL as every other document read, so it expires like one.
 */
/**
 * The compressed source key when one exists, else `null`.
 *
 * Returns the KEY rather than a boolean so the caller reads as "this, or the
 * original". Any failure — no gzip, no permission, store unreachable — falls
 * back to the raw object, which is slower and completely correct.
 */
async function hasObject(bucket: string, storageKey: string): Promise<string | null> {
  const keys = buildBimDerivedKeys(storageKey)
  if (!keys) return null
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: keys.sourceKey }))
    return keys.sourceKey
  } catch {
    return null
  }
}

export async function getModelSource(
  session: AuthorizedSession,
  modelId: string
): Promise<BimModelSource> {
  const model = await getAccessibleModel(session, modelId)
  const document = await findDocumentInOrg(model.documentId, session.organizationId)
  if (!document?.storageKey) throw new NotFoundError('Model file not available')

  const expiresIn = presignTtlSeconds()
  const bucket = resolveDocumentBucket(document.storageBucket)
  // Prefer the gzipped sibling written at extraction. An IFC is STEP text and
  // compresses 5–10×, and a presigned URL is unique per request so the raw
  // object is never cached — this is the difference between the viewer pulling
  // 149 MB and pulling ~20 MB, every time anyone opens the page.
  //
  // Probed rather than recorded on the row: models extracted before the gzip
  // existed simply do not have one, and a HEAD against the same store the
  // presign already talks to is cheaper than a migration plus a backfill.
  const key = (await hasObject(bucket, document.storageKey)) ?? document.storageKey
  const url = await getSignedUrl(
    // The BROWSER fetches this, so it must be signed against the
    // browser-reachable endpoint. Signing with the internal client bakes the
    // Docker hostname into the URL and the viewer can never load the model —
    // the same bug that once broke PDF preview.
    signingS3Client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn }
  )
  return { url, filename: document.filename, expiresInSeconds: expiresIn }
}

// ---------------------------------------------------------------------------
// Human confirmations on rule verdicts
// ---------------------------------------------------------------------------

/**
 * Every model in the project that is a revision of the same building.
 *
 * The lineage is the file name, the way the revision timeline reads it
 * (`lib/bim/revision-series.ts`) — a lineage column would be exact and empty,
 * because nobody fills those in. Used to scope a human confirmation: a
 * signature belongs to the building it was made about, and a project holds
 * several buildings in the ordinary case.
 *
 * Always contains the model itself, even when the listing is unavailable, so a
 * caller can never end up with an empty scope and silently withdraw nothing.
 */
async function revisionSiblingIds(
  organizationId: string,
  projectId: string,
  model: { id: string; filename: string }
): Promise<string[]> {
  const series = revisionSeriesKey(model.filename)
  const models = await listBimModels(organizationId, {
    projectId,
    includeArchiv: true,
    limit: 200,
  })
  const ids = models
    .filter((candidate) => revisionSeriesKey(candidate.filename) === series)
    .map((candidate) => candidate.id)
  return ids.includes(model.id) ? ids : [...ids, model.id]
}

/**
 * The confirmations recorded for a project's Prüfbuch.
 *
 * `project:view` is enough to READ them: a confirmation is part of the record
 * everyone working on the project needs to see, and hiding it from a viewer
 * would show them open questions somebody has already answered.
 */
export async function listAccessibleCheckConfirmations(
  session: AuthorizedSession,
  projectId: string
): Promise<BimStoredConfirmation[]> {
  assertIfcModelsEnabled(session)
  await requireProjectAccess(session, projectId, 'project:view')
  return listBimCheckConfirmations(session.organizationId, projectId)
}

/**
 * The model is one this PROJECT can speak for.
 *
 * `getAccessibleModel` authorizes against the model's OWN project, which is a
 * different question from the `projectId` in the URL. An org admin bypasses
 * per-project authorization entirely, and an ordinary member can hold
 * `project:edit` on A and `project:view` on B — so without this a confirmation
 * about B's building could be written into A's ledger. `null` is the org-wide
 * Archiv, which every project in the org may speak for.
 *
 * Not a second access check: the caller has already passed one. This is about
 * which record the result is being filed under.
 */
function assertModelInProject(model: BimModelHeader, projectId: string): void {
  if (model.projectId !== null && model.projectId !== projectId) {
    throw new NotFoundError('Model not found in this project')
  }
}

/**
 * Record a human verdict on one rule, against the revision they looked at.
 *
 * `project:edit`, and the confirming identity comes from the SESSION rather
 * than the request body — a signature a caller could address to somebody else
 * is not a signature. The model is re-resolved through `getAccessibleModel` so
 * a confirmation cannot be pinned to a revision in another tenant, and checked
 * against this project so it cannot be filed under another one's ledger.
 */
export async function confirmAccessibleCheck(
  session: AuthorizedSession,
  projectId: string,
  input: { ruleId: string; modelId: string; note: string | null }
): Promise<void> {
  assertIfcModelsEnabled(session)
  await requireProjectAccess(session, projectId, 'project:edit')
  const model = await getAccessibleModel(session, input.modelId)
  // Without this the row is written with a `modelId` that is not in this
  // project's revision series: invisible to `attachConfirmations`, and
  // un-withdrawable, because `withdrawAccessibleCheck` deletes by the sibling
  // ids of a model in THIS project. A permanent orphan in a signed-off ledger.
  assertModelInProject(model, projectId)
  await upsertBimCheckConfirmation({
    organizationId: session.organizationId,
    projectId,
    ruleId: input.ruleId,
    modelId: model.id,
    confirmedBy: session.userId,
    note: input.note,
  })
}

/**
 * Find one readable model in a project by its file name.
 *
 * An exact match wins over a substring, and the NEWEST wins when several
 * still match: a project carrying `Haus-A_V3.ifc` and `Haus-A_V3 (1).ifc`
 * should answer for the one the architect uploaded last, not for whichever
 * row the database happened to return first. `listBimModels` already orders
 * newest-first, so the first hit is that one.
 *
 * The caller has already passed `project:view`; this narrows within what that
 * check allowed and never widens it.
 */
async function resolveModelByName(
  session: AuthorizedSession,
  projectId: string,
  name: string
): Promise<BimModelHeader> {
  // The ceiling, not the default page: this is name RESOLUTION, and a name
  // that exists but sits past the 51st-newest model must not come back as
  // "Model not found in this project".
  const models = (
    await listBimModels(session.organizationId, { projectId, includeArchiv: true, limit: 200 })
  ).filter((model) => model.status === 'ready')
  const needle = name.trim().toLowerCase()
  const model =
    models.find((entry) => entry.filename.toLowerCase() === needle) ??
    models.find((entry) => entry.filename.toLowerCase().includes(needle))
  if (!model) throw new NotFoundError('Model not found in this project')
  return model
}

/**
 * The Prüfbuch's open items as a BCF 2.1 archive.
 *
 * Runs the SAME query op the panel reads (`compliance`) rather than a second
 * path to the same numbers — an export that can disagree with the screen is
 * worse than no export, because only one of them ends up in the submission.
 *
 * The model must belong to this project (or be an org-wide Archiv model). That
 * is not a second access check — `getAccessibleModel` already made one — it
 * stops a model from being exported under a project whose confirmations were
 * recorded about a different building.
 */
export async function exportAccessibleComplianceBcf(
  session: AuthorizedSession,
  projectId: string,
  input: {
    modelId: string | null
    /** File name, for the callers that address models the way people do. */
    modelName?: string | null
    gebaeudeklasse: number | null
    // The vocabulary, not free text: the catalogue stands rules down for a
    // value it does not recognise, and a stand-down reads as a verdict.
    hauptnutzung: BimHauptnutzung | null
  }
): Promise<BcfExport> {
  assertIfcModelsEnabled(session)
  await requireProjectAccess(session, projectId, 'project:view')

  const model = input.modelId
    ? await getAccessibleModel(session, input.modelId)
    : await resolveModelByName(session, projectId, input.modelName ?? '')
  assertModelInProject(model, projectId)

  const [result, confirmations, project] = await Promise.all([
    runBimQuery(
      {
        op: 'compliance',
        gebaeudeklasse: input.gebaeudeklasse,
        hauptnutzung: input.hauptnutzung,
      },
      { modelId: model.id, organizationId: session.organizationId }
    ),
    listBimCheckConfirmations(session.organizationId, projectId),
    findProjectInOrg(projectId, session.organizationId),
  ])

  const results = attachConfirmations(
    result.compliance ?? [],
    confirmations.map((entry) => ({
      ruleId: entry.ruleId,
      modelId: entry.modelId,
      confirmedBy: entry.confirmedBy,
      note: entry.note,
      confirmedAt: entry.confirmedAt.toISOString(),
    })),
    model.id,
    await revisionSiblingIds(session.organizationId, projectId, model)
  )

  const root = model.summary?.spatial
  return buildComplianceBcf({
    projectId,
    projectName: project?.name ?? null,
    model: {
      id: model.id,
      filename: model.filename,
      ifcProjectGlobalId: root?.ifcType === 'IfcProject' ? root.globalId : null,
      updatedAt: model.updatedAt,
    },
    results,
    // The person pressing export, not the person who confirmed anything — a
    // BCF reader shows this as who raised the topic.
    author: session.email,
  })
}

/** Withdraw a confirmation; the rule returns to whatever the catalogue says. */
export async function withdrawAccessibleCheck(
  session: AuthorizedSession,
  projectId: string,
  ruleId: string,
  /**
   * The building being withdrawn from.
   *
   * Required now that a confirmation is keyed per revision: without it there
   * is no way to say WHICH signature is being taken back, and deleting every
   * row for the rule would silently withdraw the other buildings' too.
   */
  modelId: string
): Promise<void> {
  assertIfcModelsEnabled(session)
  await requireProjectAccess(session, projectId, 'project:edit')
  const model = await getAccessibleModel(session, modelId)
  assertModelInProject(model, projectId)
  await deleteBimCheckConfirmation({
    organizationId: session.organizationId,
    projectId,
    ruleId,
    // Across the building's revisions: the panel may well have been showing a
    // confirmation from an earlier one, marked stale, and that is the one the
    // reader is taking back.
    modelIds: await revisionSiblingIds(session.organizationId, projectId, model),
  })
}
