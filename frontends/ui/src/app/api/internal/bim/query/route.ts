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
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import { bimQuerySchema, runBimQuery, BimModelNotReadyError } from '@/lib/bim/query'
import { listBimModels, type BimModelHeader } from '@/lib/bim/repository'

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

/** Public shape of a model in the disambiguation list. */
function describe(model: BimModelHeader) {
  return {
    modelId: model.id,
    filename: model.filename,
    status: model.status,
    projectName: model.summary?.projectName ?? null,
    elements: model.summary?.totals.elements ?? model.elementCount,
    storeys: model.summary?.totals.storeys ?? 0,
  }
}

export const POST = internalApiRoute(
  'Internal BIM Query',
  async ({ request }) => {
    const { organizationId, projectId, modelId, modelName, compareWithName, query } =
      await parseJsonBody(request, requestSchema)

    // `?? null`, NOT `?? undefined`: `listBimModels` reads an UNDEFINED
    // projectId as "no project predicate at all", i.e. every model in the
    // organization. A project-less chat (org-level or Archiv) would then
    // resolve — and answer questions about — models in projects the asker
    // holds no grant on, and every `resolved: false` branch below returns
    // `models: readable.map(describe)`, which hands out their UUIDs. `null`
    // scopes to the org-wide Archiv, which is what a project-less
    // conversation is entitled to.
    const candidates = await listBimModels(organizationId, {
      projectId: projectId ?? null,
      includeArchiv: true,
    })
    // Only `ready` models can answer anything. A model still extracting is
    // reported as such below rather than filtered into silence, because "the
    // model is still being read" and "there is no model" are different answers
    // and the agent must not conflate them.
    const readable = candidates.filter((model) => model.status === 'ready')

    let selected: BimModelHeader | undefined
    if (modelId) {
      selected = candidates.find((model) => model.id === modelId)
      if (!selected) throw new NotFoundError('Model not found in this organization')
    } else if (modelName) {
      const needle = modelName.toLowerCase()
      const matches = readable.filter((model) => model.filename.toLowerCase().includes(needle))
      if (matches.length === 0) {
        return {
          resolved: false,
          reason: 'no_match',
          message: `Kein Modell mit dem Namen „${modelName}“ gefunden.`,
          models: readable.map(describe),
        }
      }
      if (matches.length > 1) {
        return {
          resolved: false,
          reason: 'ambiguous',
          message: `Mehrere Modelle passen auf „${modelName}“. Bitte eines auswählen.`,
          models: matches.map(describe),
        }
      }
      selected = matches[0]
    } else if (readable.length === 1) {
      selected = readable[0]
    } else if (readable.length === 0) {
      return {
        resolved: false,
        reason: candidates.length > 0 ? 'not_ready' : 'no_models',
        message:
          candidates.length > 0
            ? 'Für dieses Projekt wird derzeit ein IFC-Modell verarbeitet. Es steht noch nicht zur Abfrage bereit.'
            : 'Für dieses Projekt ist kein IFC-Modell hinterlegt.',
        models: candidates.map(describe),
      }
    } else {
      return {
        resolved: false,
        reason: 'ambiguous',
        message: 'Für dieses Projekt gibt es mehrere IFC-Modelle. Bitte eines auswählen.',
        models: readable.map(describe),
      }
    }

    // `compare` names its counterpart by file name too, and resolving it here
    // keeps the tool free of ids on both sides of the comparison.
    let resolvedQuery = query
    if (query.op === 'compare') {
      if (!compareWithName) {
        return {
          resolved: false,
          reason: 'compare_target_missing',
          message: 'Für einen Vergleich muss der zweite Modellstand benannt werden.',
          models: readable.map(describe),
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
              ? `Kein zweiter Modellstand mit dem Namen „${compareWithName}“ gefunden.`
              : `Mehrere Modellstände passen auf „${compareWithName}“. Bitte eindeutig benennen.`,
          models: readable.map(describe),
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
          reason: error.status === 'failed' ? 'extraction_failed' : 'not_ready',
          message: error.message,
          models: [describe(selected)],
        }
      }
      throw new BadRequestError('BIM query could not be executed')
    }
  },
  { tenancy: { fromPayload: 'body.organizationId' } }
)
