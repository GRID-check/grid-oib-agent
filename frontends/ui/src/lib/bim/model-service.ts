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
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { signingS3Client } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { requireProjectAccess } from '@/lib/authz/projects'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { findDocumentInOrg } from '@/lib/documents/repository'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  findBimModelByDocument,
  findBimModelById,
  listBimModels,
  type BimModelHeader,
} from './repository'
import { runBimQuery, type BimQuery, type BimQueryResult } from './query'

const presignTtlSeconds = (): number => Number(process.env.SEAWEED_PRESIGNED_URL_TTL_SECONDS || 600)

/**
 * Refuse every model surface when the `ifc-models` flag is off for this org.
 *
 * The routes are otherwise reachable by URL on a deployment that has not bought
 * the feature — the flag would then gate only the upload button, which is a UI
 * preference rather than a boundary.
 */
export function assertIfcModelsEnabled(session: AuthorizedSession): void {
  if (!isFeatureEnabled(session, FEATURE_FLAGS.ifcModels)) {
    throw new ForbiddenError('IFC models are not enabled for this organization')
  }
}

/**
 * Load a model and enforce the access its document's scope demands.
 *
 * The check is on the DOCUMENT, not on the model row: the model is derived data
 * and the document is the thing the sharing rules are written about, so
 * deriving access from anywhere else would eventually let the two disagree.
 */
export async function getAccessibleModel(
  session: AuthorizedSession,
  modelId: string
): Promise<BimModelHeader> {
  assertIfcModelsEnabled(session)
  const model = await findBimModelById(modelId, session.organizationId)
  if (!model) throw new NotFoundError('Model not found')

  const document = await findDocumentInOrg(model.documentId, session.organizationId)
  if (!document) throw new NotFoundError('Model not found')

  // An Archiv document (no project) is readable by any member of the org, which
  // `findDocumentInOrg` has already established.
  if (document.projectId !== null) {
    await requireProjectAccess(session, document.projectId, 'project:view')
  }
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
  if (document.projectId !== null) {
    await requireProjectAccess(session, document.projectId, 'project:view')
  }
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

/** Run a validated query against a model the caller may read. */
export async function queryAccessibleModel(
  session: AuthorizedSession,
  modelId: string,
  request: BimQuery
): Promise<BimQueryResult> {
  const model = await getAccessibleModel(session, modelId)
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
export async function getModelSource(
  session: AuthorizedSession,
  modelId: string
): Promise<BimModelSource> {
  const model = await getAccessibleModel(session, modelId)
  const document = await findDocumentInOrg(model.documentId, session.organizationId)
  if (!document?.storageKey) throw new NotFoundError('Model file not available')

  const expiresIn = presignTtlSeconds()
  const url = await getSignedUrl(
    // The BROWSER fetches this, so it must be signed against the
    // browser-reachable endpoint. Signing with the internal client bakes the
    // Docker hostname into the URL and the viewer can never load the model —
    // the same bug that once broke PDF preview.
    signingS3Client,
    new GetObjectCommand({
      Bucket: resolveDocumentBucket(document.storageBucket),
      Key: document.storageKey,
    }),
    { expiresIn }
  )
  return { url, filename: document.filename, expiresInSeconds: expiresIn }
}
