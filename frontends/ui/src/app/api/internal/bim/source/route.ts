/**
 * INTERNAL service endpoint — the agent's way to the model's own BYTES
 * (the `ifc_measure` tool).
 *
 * Its sibling `POST /api/internal/bim/query` answers questions the extracted
 * index can answer: counts, properties, storeys, quantities the export wrote
 * down. `ifc_measure` answers the ones it cannot — a room's floor area when the
 * export published none, a window's sill height, the clear height under a
 * suspended ceiling — and those need the geometry, which means they need the
 * file. The agent backend has no object storage of its own (ADR-0045: the BFF
 * owns `grid_app` and the bucket), so it obtains the source the way the viewer
 * does: it asks for a short-lived presigned URL and reads it.
 *
 * ## Why this is a source URL and not "run the operator here"
 *
 * The spatial engine is IfcOpenShell (roadmap §13b), which is Python, and the
 * only Python process in this system is the agent's. Streaming the file to it
 * is the smaller of the two moves; the alternative is a second geometry stack
 * in Node that would have to agree with the first about every number — the
 * thing ADR-0045's "one parser, one interpretation" rule exists to prevent.
 *
 * ## Tenancy is the host's, and it is not restated here
 *
 * Every check the query route applies is applied by the same two functions, in
 * `lib/bim/internal-access`: the `ifc-models` flag evaluated per-organization,
 * and a model list scoped to the conversation's project plus the org-wide
 * Archiv. A model this route will hand over is by construction a model the
 * query route would already answer questions about — a second tool must not be
 * able to reach a building the first one could not.
 *
 * Read-only, like its sibling, and for the same reason: nothing an agent says
 * may change what the file says.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import {
  assertInternalIfcModelsEnabled,
  describeModel,
  getInternalModelSource,
  resolveInternalModel,
} from '@/lib/bim/internal-access'

const requestSchema = z
  .object({
    organizationId: z.string().min(1).max(255),
    /** Project scope. Omitted, only `modelId` can select a model. */
    projectId: z.string().uuid().optional(),
    modelId: z.string().uuid().optional(),
    /** Case-insensitive substring of the model's filename. */
    modelName: z.string().trim().min(1).max(255).optional(),
  })
  .refine((value) => Boolean(value.projectId || value.modelId), {
    message: 'projectId or modelId is required',
  })

export const POST = internalApiRoute(
  'Internal BIM Source',
  async ({ request }) => {
    const { organizationId, projectId, modelId, modelName } = await parseJsonBody(
      request,
      requestSchema
    )

    await assertInternalIfcModelsEnabled(organizationId)

    const resolution = await resolveInternalModel({
      organizationId,
      projectId,
      modelId,
      modelName,
    })
    // "There is no model", "there are several" and "it is still being read" are
    // answers, not failures — returned verbatim so the tool renders the same
    // German sentence `ifc_query` would.
    if (!resolution.resolved) return resolution

    const source = await getInternalModelSource(resolution.model, organizationId)
    return {
      resolved: true,
      model: {
        ...describeModel(resolution.model),
        schemaVersion: resolution.model.schemaVersion,
        // The caller caches PARSED models across turns, and a re-export under
        // the same file name must not be served out of that cache. This plus
        // the object's ETag is what tells it whether it is holding the same
        // building it was holding a minute ago.
        updatedAt: resolution.model.updatedAt.toISOString(),
      },
      source,
    }
  },
  { tenancy: { fromPayload: 'body.organizationId' } }
)
