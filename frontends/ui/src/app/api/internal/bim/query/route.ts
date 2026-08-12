/**
 * INTERNAL service endpoint — the agent's deterministic read path into a
 * project's BIM models (the `ifc_query` tool).
 *
 * Keeps `grid_app` single-writer and single-owner: the Python backend never
 * opens a connection to it, it calls this route over the compose network with
 * the shared service token (`GRID_INTERNAL_API_TOKEN`), exactly like the
 * `remember` tool's `POST /api/internal/memory`.
 *
 * ## Why the tool does not have to know a model id
 *
 * The agent has a conversation, not a database. Asking it to carry a UUID
 * through a turn is a reliable source of hallucinated identifiers, so the tool
 * addresses models the way a person does — by project, and by name when there
 * is more than one. `modelId` is accepted for the case where a previous call
 * already resolved one (or a card names one), and `modelName` matches
 * case-insensitively on the document filename.
 *
 * There is no write path here on purpose: a model is derived from an uploaded
 * file, and nothing an agent says should be able to change what the file says.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { bimQuerySchema, runBimQuery, BimModelNotReadyError } from '@/lib/bim/query'
import {
  assertInternalIfcModelsEnabled,
  describeModel,
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
    /**
     * For `op: 'compare'` — the OLDER revision, named the way the agent names
     * models: by file name. Resolved here so the tool never handles a UUID.
     */
    compareWithName: z.string().trim().min(1).max(255).optional(),
    query: bimQuerySchema,
  })
  .refine((value) => Boolean(value.projectId || value.modelId), {
    message: 'projectId or modelId is required',
  })

export const POST = internalApiRoute(
  'Internal BIM Query',
  async ({ request }) => {
    const { organizationId, projectId, modelId, modelName, compareWithName, query } =
      await parseJsonBody(request, requestSchema)

    // The gate and the model resolution both live in `lib/bim/internal-access`,
    // shared with `POST /api/internal/bim/source` — see that module's header
    // for why a second internal route may not carry a second copy of the rule.
    await assertInternalIfcModelsEnabled(organizationId)

    const resolution = await resolveInternalModel({
      organizationId,
      projectId,
      modelId,
      modelName,
    })
    if (!resolution.resolved) return resolution
    const { model: selected, readable } = resolution

    // Both two-revision ops name their counterpart by file name, and resolving
    // it here keeps the tool free of ids on both sides of the comparison.
    //
    // A `baseModelId` that arrived in the BODY is discarded rather than
    // trusted. `runBimQuery` scopes a base model to the ORGANIZATION and
    // nothing else, so a caller that supplied one directly could read another
    // PROJECT's building out of the diff: `compare` reports every base element
    // absent from the revision as `removed`, with its name and storey, and
    // `compliance-diff` reports the base's per-rule verdict counts and its
    // file name. `queryAccessibleModel` closes exactly this on the user path;
    // this route is the other half, and `readable` below is already scoped to
    // the conversation's project plus the org Archiv.
    let resolvedQuery = query
    if (query.op === 'compliance-diff' || query.op === 'compare') {
      if (!compareWithName) {
        return {
          resolved: false,
          reason: 'compare_target_missing',
          message: 'Für einen Vergleich muss die zweite Revision benannt werden.',
          models: readable.map(describeModel),
        }
      }
      const needle = compareWithName.toLowerCase()
      const matches = readable.filter(
        (candidate) =>
          candidate.id !== selected.id && candidate.filename.toLowerCase().includes(needle)
      )
      if (matches.length !== 1) {
        return {
          resolved: false,
          reason: matches.length === 0 ? 'no_match' : 'ambiguous',
          message:
            matches.length === 0
              ? `Keine zweite Revision mit dem Namen „${compareWithName}“ gefunden.`
              : `Mehrere Revisionen passen auf „${compareWithName}“. Bitte eindeutig benennen.`,
          models: readable.map(describeModel),
        }
      }
      resolvedQuery = { ...query, baseModelId: matches[0].id }
    }

    try {
      const result = await runBimQuery(resolvedQuery, { modelId: selected.id, organizationId })
      return { resolved: true, ...result }
    } catch (error) {
      if (error instanceof BimModelNotReadyError) {
        // A 400 here would tell the agent it sent a malformed request; the request
        // was fine and the MODEL is not ready, which is an answer, not an error.
        return {
          resolved: false,
          reason: error.modelStatus === 'failed' ? 'extraction_failed' : 'not_ready',
          message: error.message,
          models: [describeModel(selected)],
        }
      }
      // Anything else is OURS, not the caller's. Turning a statement timeout
      // or an exhausted pool into a `BadRequestError` told the agent it had
      // sent a malformed request — and because an `ApiError` is returned
      // directly, it also skipped the handler's logging, so the operator saw
      // nothing at all. Rethrowing lets the factory log it and answer 500,
      // which is the difference between "your query is wrong" and "we are
      // broken".
      throw error
    }
  },
  { tenancy: { fromPayload: 'body.organizationId' } }
)
