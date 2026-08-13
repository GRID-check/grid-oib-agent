/**
 * What a SERVICE TOKEN is allowed to reach in the BIM domain, in one place.
 *
 * The agent's routes under `app/api/internal/bim/*` carry
 * `GRID_INTERNAL_API_TOKEN` and no session, so none of the machinery that keeps
 * a model inside its tenant and its project on the user-facing routes applies
 * to them: there is no `AuthorizedSession` to read feature flags off, and no
 * `requireProjectAccess` to call. Each internal route therefore has to
 * re-establish the same boundary by hand — which is exactly the shape of thing
 * that drifts once there are two of them.
 *
 * So there is one of them. `POST /api/internal/bim/query` (the `ifc_query`
 * tool) and `POST /api/internal/bim/source` (the `ifc_measure` tool) both go
 * through {@link assertInternalIfcModelsEnabled} and
 * {@link resolveInternalModel}, and a model either route can address is by
 * construction a model the other one can too. A second tool cannot widen what
 * the first was allowed to see, because there is no second copy of the rule to
 * widen.
 *
 * Nothing here is a WRITE path, and that is deliberate for the same reason it
 * is on the query route: a model is derived from an uploaded file, and nothing
 * an agent says should be able to change what the file says.
 */

import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { FEATURE_FLAGS, enforcementOn, ifcModelsEnvEnabled } from '@/lib/authz/feature-flags'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { listBimModels, type BimModelHeader } from './repository'

/**
 * The SAME gate the UI and every user-facing route apply, evaluated
 * per-organization because these routes carry a service token and no session.
 *
 * Mirrors `isIfcModelsEnabled` for a caller that has neither: under enforcement
 * the per-org flag decides (`isOrgFeatureEnabled` is itself fail-closed on a
 * lookup error); without it, the deployment-level switch does — which defaults
 * to ON, like the UI. The point is that the two agree: the agent answering
 * questions about a building makes the same claim the UI makes, so withdrawing
 * the feature has to stop both.
 */
export async function assertInternalIfcModelsEnabled(organizationId: string): Promise<void> {
  const allowed = enforcementOn()
    ? await isOrgFeatureEnabled(FEATURE_FLAGS.ifcModels, organizationId)
    : ifcModelsEnvEnabled()
  if (!allowed) {
    throw new ForbiddenError('IFC models are not enabled for this organization')
  }
}

/** Public shape of a model in a disambiguation list. */
export function describeModel(model: BimModelHeader) {
  return {
    modelId: model.id,
    filename: model.filename,
    status: model.status,
    projectName: model.summary?.projectName ?? null,
    elements: model.summary?.totals.elements ?? model.elementCount,
    storeys: model.summary?.totals.storeys ?? 0,
  }
}

/** Why a model could not be selected — reported, never thrown. */
export interface UnresolvedModel {
  resolved: false
  reason: 'no_match' | 'ambiguous' | 'not_ready' | 'no_models'
  message: string
  models: ReturnType<typeof describeModel>[]
}

export interface ResolvedModel {
  resolved: true
  /** The model the caller addressed. */
  model: BimModelHeader
  /**
   * Every `ready` model in scope — the list a second revision is resolved
   * against, and the list a `resolved: false` answer offers as alternatives.
   */
  readable: BimModelHeader[]
}

export interface InternalModelQuery {
  organizationId: string
  /** Project scope. Omitted, only `modelId` can select a model. */
  projectId?: string
  modelId?: string
  /** Case-insensitive substring of the model's filename. */
  modelName?: string
}

/**
 * The model an agent meant, from a project and a file name.
 *
 * A `resolved: false` result is a normal outcome carrying a German sentence for
 * the user — "there is no model", "there are several", "it is still being read"
 * are different answers and the caller must not flatten them into an error.
 * Only a `modelId` naming a model outside the organization throws, because that
 * is not a question anyone asked in words.
 */
export async function resolveInternalModel(
  input: InternalModelQuery
): Promise<ResolvedModel | UnresolvedModel> {
  // `?? null`, NOT `?? undefined`: `listBimModels` reads an UNDEFINED
  // projectId as "no project predicate at all", i.e. every model in the
  // organization. A project-less chat (org-level or Archiv) would then
  // resolve — and answer questions about — models in projects the asker holds
  // no grant on, and every `resolved: false` branch below returns the
  // describe()d list, which hands out their UUIDs. `null` scopes to the
  // org-wide Archiv, which is what a project-less conversation is entitled to.
  const candidates = await listBimModels(input.organizationId, {
    projectId: input.projectId ?? null,
    includeArchiv: true,
    // The ceiling, not the default 50. This list is what a MODEL NAME is
    // resolved against, and a project plus the org Archiv can hold more than
    // fifty files — past which "Kein Modell mit dem Namen … gefunden" is a
    // fact about the page size, and the `readable.length === 1` auto-selection
    // below picks from a clipped list without saying so.
    limit: 200,
  })
  // Only `ready` models can answer anything. A model still extracting is
  // reported as such below rather than filtered into silence, because "the
  // model is still being read" and "there is no model" are different answers
  // and the agent must not conflate them.
  const readable = candidates.filter((model) => model.status === 'ready')

  if (input.modelId) {
    const selected = candidates.find((model) => model.id === input.modelId)
    if (!selected) throw new NotFoundError('Model not found in this organization')
    // An id is not a readiness claim, and this branch is the only one that
    // could mistake it for one: every other path below resolves against
    // `readable`. Without this check `POST /api/internal/bim/source` presigned
    // the raw `.ifc` of a model whose extraction had not finished — the route
    // does not re-check `status` itself, so the agent would measure a
    // half-written building and report the numbers as fact. `.../query`
    // happened to survive it only because `runBimQuery` throws
    // `BimModelNotReadyError` further in; the two routes must refuse here,
    // identically, as ADR-0045 says they do.
    if (selected.status !== 'ready') {
      return {
        resolved: false,
        reason: 'not_ready',
        message:
          selected.status === 'failed'
            ? 'Dieses IFC-Modell konnte nicht gelesen werden.'
            : 'Dieses IFC-Modell wird derzeit verarbeitet. Es steht noch nicht zur Abfrage bereit.',
        models: [describeModel(selected)],
      }
    }
    return { resolved: true, model: selected, readable }
  }

  if (input.modelName) {
    const needle = input.modelName.toLowerCase()
    const matches = readable.filter((model) => model.filename.toLowerCase().includes(needle))
    if (matches.length === 0) {
      return {
        resolved: false,
        reason: 'no_match',
        message: `Kein Modell mit dem Namen „${input.modelName}“ gefunden.`,
        models: readable.map(describeModel),
      }
    }
    if (matches.length > 1) {
      return {
        resolved: false,
        reason: 'ambiguous',
        message: `Mehrere Modelle passen auf „${input.modelName}“. Bitte eines auswählen.`,
        models: matches.map(describeModel),
      }
    }
    return { resolved: true, model: matches[0], readable }
  }

  if (readable.length === 1) return { resolved: true, model: readable[0], readable }

  if (readable.length === 0) {
    return {
      resolved: false,
      reason: candidates.length > 0 ? 'not_ready' : 'no_models',
      message:
        candidates.length > 0
          ? 'Für dieses Projekt wird derzeit ein IFC-Modell verarbeitet. Es steht noch nicht zur Abfrage bereit.'
          : 'Für dieses Projekt ist kein IFC-Modell hinterlegt.',
      models: candidates.map(describeModel),
    }
  }

  return {
    resolved: false,
    reason: 'ambiguous',
    message: 'Für dieses Projekt gibt es mehrere IFC-Modelle. Bitte eines auswählen.',
    models: readable.map(describeModel),
  }
}

export interface InternalModelSource {
  /** Presigned GET for the raw `.ifc`, signed against the INTERNAL endpoint. */
  url: string
  expiresInSeconds: number
  /** Byte length of the object, when the store reported one. */
  bytes: number | null
  /**
   * The store's content identity for these bytes (an S3 ETag), or `null`.
   *
   * The reason it is returned at all: the caller parses the model in its own
   * process and must not download 150 MB again to discover it already has it.
   * A tag that changes when the object changes is exactly what a cache key
   * needs, and it comes free from the HEAD that already decides the size.
   */
  etag: string | null
}

const presignTtlSeconds = (): number => Number(process.env.SEAWEED_PRESIGNED_URL_TTL_SECONDS || 600)

/**
 * A short-lived download URL for one model's own bytes, for a SERVER consumer.
 *
 * Two deliberate differences from `getModelSource`, which serves the browser:
 *
 * - **Signed with the internal client.** A presigned URL bakes in the signing
 *   client's endpoint host. The browser cannot resolve `seaweedfs`, so the
 *   viewer's URL is signed against the public endpoint; the agent backend is on
 *   the compose network and the public host may not resolve there at all. The
 *   consumer decides the endpoint, and this consumer is inside.
 * - **The ORIGINAL object, never the gzip.** The viewer's `_bim/source.ifc.gz`
 *   is transparent only because a browser inflates `Content-Encoding: gzip`
 *   itself. A plain HTTP client does not, and IfcOpenShell handed gzip bytes
 *   does not fail loudly — it fails as "this file cannot be read", which is the
 *   one sentence this whole feature must never say about a readable building.
 *   The transfer is internal, so the compression bought nothing here anyway.
 */
export async function getInternalModelSource(
  model: BimModelHeader,
  organizationId: string
): Promise<InternalModelSource> {
  const document = await findDocumentInOrg(model.documentId, organizationId)
  if (!document?.storageKey) throw new NotFoundError('Model file not available')

  const bucket = resolveDocumentBucket(document.storageBucket)
  const expiresIn = presignTtlSeconds()

  // Best-effort: a store that will not answer a HEAD can still serve the GET,
  // and the two fields it fills are a cache hint and a size hint — neither is
  // load-bearing for correctness.
  let bytes: number | null = null
  let etag: string | null = null
  try {
    const head = await s3Client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: document.storageKey })
    )
    bytes = typeof head.ContentLength === 'number' ? head.ContentLength : null
    etag = head.ETag ? head.ETag.replace(/"/g, '') : null
  } catch {
    // Left null.
  }

  const url = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: bucket, Key: document.storageKey }),
    { expiresIn }
  )
  return { url, expiresInSeconds: expiresIn, bytes, etag }
}
