/**
 * OpenRouter model-catalog client (server-side only).
 *
 * Wraps `GET {OPENROUTER_BASE_URL}/models` — OpenRouter's public model
 * catalog (https://openrouter.ai/docs — Models API). Each entry carries the
 * metadata the agent-group capability filter needs: `context_length`,
 * `supported_parameters`, `architecture.input_modalities`, and `pricing`
 * (USD per token, string-encoded).
 *
 * The catalog is cached in-memory for CATALOG_TTL_MS: it changes rarely and
 * the settings UI queries it per keystroke. An API key is not required for
 * the catalog endpoint; when OPENROUTER_API_KEY is set it is forwarded so the
 * listing reflects account-level availability.
 */

import 'server-only'
import { getCached, invalidateCached } from '@/lib/cache'
import {
  AGENT_GROUPS,
  getAgentGroup,
  OPENROUTER_MODEL_ID_PATTERN,
  type AgentGroupDefinition,
} from './agent-groups'
import { ServiceUnavailableError } from '@/lib/api/errors'
import { ZDR_LIST_UNAVAILABLE, type ModelRejection } from './rejections'

export interface OpenRouterModel {
  id: string
  name: string
  description?: string
  contextLength: number
  /** USD per prompt/completion token, as reported by the catalog. */
  promptPrice: number
  completionPrice: number
  inputModalities: string[]
  supportedParameters: string[]
}

export interface ModelValidationResult {
  ok: boolean
  reasons: ModelRejection[]
}

const CATALOG_TTL_MS = 5 * 60 * 1000
const CATALOG_CACHE_KEY = 'openrouter:catalog'
/**
 * `:v3` because the payload shape changed again: `:v1` held a `Set` (which
 * `JSON.stringify` flattens to `{}`), `:v2` held bare model ids, and this holds
 * one entry per ZDR endpoint with what that endpoint accepts. Entries written
 * by older code are still live in a shared Dragonfly for up to CATALOG_TTL_MS
 * after a deploy, so the new reader must not find them.
 */
const ZDR_CACHE_KEY = 'openrouter:zdr-endpoints:v3'

function baseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function parseModel(raw: unknown): OpenRouterModel | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== 'string' || !OPENROUTER_MODEL_ID_PATTERN.test(entry.id)) return null
  const architecture = (entry.architecture ?? {}) as Record<string, unknown>
  const pricing = (entry.pricing ?? {}) as Record<string, unknown>
  return {
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : entry.id,
    description: typeof entry.description === 'string' ? entry.description : undefined,
    contextLength: toNumber(entry.context_length),
    promptPrice: toNumber(pricing.prompt),
    completionPrice: toNumber(pricing.completion),
    inputModalities: Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities.filter((m): m is string => typeof m === 'string')
      : [],
    supportedParameters: Array.isArray(entry.supported_parameters)
      ? entry.supported_parameters.filter((p): p is string => typeof p === 'string')
      : [],
  }
}

/** Fetch (or reuse) the OpenRouter model catalog. Throws on upstream failure. */
export async function fetchModelCatalog(): Promise<OpenRouterModel[]> {
  return getCached(CATALOG_CACHE_KEY, CATALOG_TTL_MS, async () => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const apiKey = process.env.OPENROUTER_API_KEY
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const response = await fetch(`${baseUrl()}/models`, { headers, cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`OpenRouter model catalog request failed: HTTP ${response.status}`)
    }
    const body = (await response.json()) as { data?: unknown[] }
    const models = (body.data ?? []).map(parseModel).filter((m): m is OpenRouterModel => m !== null)
    if (models.length === 0) {
      throw new Error('OpenRouter model catalog response contained no models')
    }
    return models
  })
}

/** Test hook. */
export async function _clearCatalogCache(): Promise<void> {
  await invalidateCached(CATALOG_CACHE_KEY)
  await invalidateCached(ZDR_CACHE_KEY)
}

/** One provider endpoint from `GET /endpoints/zdr`: which model it serves, and what it accepts. */
export interface ZdrEndpoint {
  /** Exactly as listed, variant included (`qwen/qwen3.8-27b:free` is its own entry). */
  modelId: string
  supportedParameters: string[]
  /** 0 when the listing did not say. */
  contextLength: number
}

/** Model id → the zero-data-retention endpoints that serve it. */
export type ZdrIndex = ReadonlyMap<string, readonly ZdrEndpoint[]>

/**
 * The zero-data-retention list could not be read or trusted. Callers fail
 * CLOSED on it: a model is never offered, saved or reported as ZDR on a guess.
 */
export class ZdrListUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ZdrListUnavailableError'
  }
}

/**
 * The 503 a route answers when the catalog or the ZDR list is down. The two are
 * told apart (`details.reason`) because the admin's next step differs: a ZDR
 * list outage is why a ZDR organization sees no models at all, and "the model
 * configuration could not be loaded" would send them looking in the wrong place.
 */
export function catalogUnavailableError(error: unknown): ServiceUnavailableError {
  if (error instanceof ZdrListUnavailableError) {
    return new ServiceUnavailableError(
      'The zero-data-retention list could not be loaded, so no model can be confirmed as ZDR; try again later',
      { reason: ZDR_LIST_UNAVAILABLE }
    )
  }
  return new ServiceUnavailableError('The model catalog is unavailable; try again later')
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * One entry of the listing. The live shape (verified 2026-09) is
 * `{data: [{model_id, provider_name, tag, supported_parameters, context_length, …}]}`.
 * Only `model_id` names the model: `tag` (`azure/eu`, `novita/fp8`) and `name`
 * (`Reka | deepseek/…-20260423`) look like model ids and are not, which is why
 * the old recursive scan over every string was wrong.
 */
function parseZdrEndpoint(raw: unknown): ZdrEndpoint | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  if (typeof entry.model_id !== 'string' || !OPENROUTER_MODEL_ID_PATTERN.test(entry.model_id)) return null
  return {
    modelId: entry.model_id,
    supportedParameters: stringList(entry.supported_parameters),
    contextLength: toNumber(entry.context_length),
  }
}

/** Drop endpoints that are identical for our purposes, so the cached payload stays small. */
function dedupeEndpoints(endpoints: ZdrEndpoint[]): ZdrEndpoint[] {
  const seen = new Set<string>()
  return endpoints.filter((endpoint) => {
    const key = JSON.stringify([endpoint.modelId, [...endpoint.supportedParameters].sort(), endpoint.contextLength])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isUsableEndpoint(value: unknown): value is ZdrEndpoint {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<ZdrEndpoint>
  return (
    typeof entry.modelId === 'string' &&
    OPENROUTER_MODEL_ID_PATTERN.test(entry.modelId) &&
    Array.isArray(entry.supportedParameters) &&
    entry.supportedParameters.every((param) => typeof param === 'string') &&
    typeof entry.contextLength === 'number'
  )
}

async function loadZdrEndpoints(): Promise<ZdrEndpoint[]> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const apiKey = process.env.OPENROUTER_API_KEY
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await fetch(`${baseUrl()}/endpoints/zdr`, { headers, cache: 'no-store' })
  if (!response.ok) {
    throw new ZdrListUnavailableError(`OpenRouter ZDR endpoint listing request failed: HTTP ${response.status}`)
  }
  const body = (await response.json()) as { data?: unknown }
  const endpoints = (Array.isArray(body.data) ? body.data : [])
    .map(parseZdrEndpoint)
    .filter((endpoint): endpoint is ZdrEndpoint => endpoint !== null)
  if (endpoints.length === 0) {
    throw new ZdrListUnavailableError('OpenRouter ZDR endpoint listing contained no model ids')
  }
  return dedupeEndpoints(endpoints)
}

/**
 * Every Zero-Data-Retention endpoint, indexed by the exact model id it serves,
 * from OpenRouter's `GET /api/v1/endpoints/zdr`. Cached like the catalog.
 * Throws `ZdrListUnavailableError` on any failure so callers fail CLOSED — a
 * model may only be offered under a ZDR policy when we can positively confirm
 * it is on the ZDR list, never on a best guess.
 *
 * (The list is per-model/provider and account-independent, so it is the correct
 * source for a per-organization ZDR filter in a multi-tenant deployment; the
 * account-wide `/models/user` privacy filter is not.)
 *
 * **The cache stores an ARRAY, and the index is rebuilt on the way out.**
 * `getCached` round-trips through JSON (the shared store is Dragonfly), and a
 * `Set` or `Map` serialises to `{}`. Caching the `Set` itself once type-checked
 * fine and handed every cache HIT a prototype-less `{}` (issue #242).
 */
export async function fetchZdrEndpoints(): Promise<ZdrIndex> {
  let endpoints: unknown
  try {
    endpoints = await getCached<ZdrEndpoint[]>(ZDR_CACHE_KEY, CATALOG_TTL_MS, loadZdrEndpoints)
  } catch (error) {
    if (error instanceof ZdrListUnavailableError) throw error
    throw new ZdrListUnavailableError(`OpenRouter ZDR endpoint listing is unavailable: ${String(error)}`, {
      cause: error,
    })
  }

  // A cache entry we cannot read is not an empty allowlist. Every element is
  // checked, not just the array-ness: `getCached` casts rather than validates,
  // so a foreign payload like `[null]` would otherwise reach callers inside an
  // index that holds nothing, and every model would read as "not ZDR" — or,
  // worse, a malformed one as ZDR.
  if (!Array.isArray(endpoints) || endpoints.length === 0 || !endpoints.every(isUsableEndpoint)) {
    throw new ZdrListUnavailableError('OpenRouter ZDR endpoint listing is unusable')
  }
  const index = new Map<string, ZdrEndpoint[]>()
  for (const endpoint of endpoints) {
    const list = index.get(endpoint.modelId)
    if (list) list.push(endpoint)
    else index.set(endpoint.modelId, [endpoint])
  }
  return index
}

/**
 * Variant suffixes that are only a routing preference over the SAME endpoints
 * (`:nitro` sorts by throughput, `:floor` by price), so they share the base
 * model's ZDR endpoints. Every other suffix (`:free`, `:extended`, `:thinking`,
 * `:online`, …) is a different offering with its own endpoints and matches only
 * if the listing names it exactly.
 */
export const ZDR_ROUTING_ONLY_VARIANTS: readonly string[] = ['nitro', 'floor']

/** The ZDR endpoints that would serve `modelId`: exact id first, then a routing-only variant's base. */
export function zdrEndpointsFor(modelId: string, zdr: ZdrIndex): readonly ZdrEndpoint[] {
  const exact = zdr.get(modelId)
  if (exact) return exact
  const colon = modelId.indexOf(':')
  if (colon < 0) return []
  const variant = modelId.slice(colon + 1)
  return ZDR_ROUTING_ONLY_VARIANTS.includes(variant) ? (zdr.get(modelId.slice(0, colon)) ?? []) : []
}

/**
 * Whether one ZDR endpoint can serve what a group sends: every required
 * parameter (tools, …) and the group's minimum context. Image input is not
 * checked here: the endpoint listing carries no modality field, so vision stays
 * a model-level check in `validateModelForGroup`.
 */
export function zdrEndpointServesGroup(endpoint: ZdrEndpoint, group: AgentGroupDefinition): boolean {
  const { requiredParameters, minContextLength } = group.requirements
  if (endpoint.contextLength > 0 && endpoint.contextLength < minContextLength) return false
  return requiredParameters.every((param) => endpoint.supportedParameters.includes(param))
}

/**
 * Whether `modelId` has a zero-data-retention endpoint — and, given a group,
 * one that can actually serve that group's requests. Exact-id matching (see
 * `zdrEndpointsFor`): `foo/bar:free` is not ZDR just because `foo/bar` is.
 */
export function hasZdrEndpoint(modelId: string, zdr: ZdrIndex, group?: AgentGroupDefinition): boolean {
  if (!group) return zdrEndpointsFor(modelId, zdr).length > 0
  return zdrShortfall(modelId, group, zdr) === null
}

/** Why a model cannot serve a group under ZDR; the codes are `ModelRejectionCode`s. */
export type ZdrShortfall = 'not_zdr' | 'zdr_endpoint_lacks_capability'

/**
 * The one ZDR verdict for a (model, group): null when some ZDR endpoint of the
 * model serves the group, else why not. The save paths, the picker and the
 * coverage report all ask this, so they cannot disagree.
 */
export function zdrShortfall(modelId: string, group: AgentGroupDefinition, zdr: ZdrIndex): ZdrShortfall | null {
  const endpoints = zdrEndpointsFor(modelId, zdr)
  if (endpoints.length === 0) return 'not_zdr'
  return endpoints.some((endpoint) => zdrEndpointServesGroup(endpoint, group)) ? null : 'zdr_endpoint_lacks_capability'
}

/** `zdrShortfall` as a rejection, or null when the model passes it. */
export function zdrRejection(
  model: Pick<OpenRouterModel, 'id'>,
  group: AgentGroupDefinition,
  zdr: ZdrIndex
): ModelRejection | null {
  const shortfall = zdrShortfall(model.id, group, zdr)
  if (!shortfall) return null
  return {
    code: shortfall,
    message:
      shortfall === 'not_zdr'
        ? `model '${model.id}' has no zero-data-retention endpoint`
        : `no zero-data-retention endpoint of '${model.id}' supports what this group requires`,
    params: { model: model.id },
  }
}

/**
 * Denylist of reasoning-MANDATORY model families — models that ALWAYS reason
 * and reject reasoning-off (`reasoning_effort: none` / `reasoning:{enabled:false}`)
 * with OpenRouter HTTP 400 "Reasoning is mandatory for this endpoint and cannot
 * be disabled". Exported so ops can extend both lists without a code review of
 * the rule itself.
 *
 * `REASONING_MANDATORY_PREFIXES` is matched with `startsWith` (a whole family);
 * `REASONING_MANDATORY_IDS` is matched by exact id.
 *
 * Known reasoning-only families: OpenAI's o-series (`openai/o1`, `o3`, `o4`),
 * xAI's Grok 4 line (an org override that pinned a reasoning-off group to
 * x-ai/grok-4.5 is the incident that motivated this filter), and DeepSeek R1. Everything else is assumed hybrid — see below.
 */
export const REASONING_MANDATORY_PREFIXES: string[] = [
  'openai/o1',
  'openai/o3',
  'openai/o4',
  'x-ai/grok-4',
  'deepseek/deepseek-r1',
]
export const REASONING_MANDATORY_IDS: string[] = []

/**
 * Whether a model is safe to select for a group that runs with reasoning
 * DISABLED (`reasoning_effort: none`).
 *
 * Rationale — we fail OPEN, the inverse of the original allowlist:
 *   - OpenRouter's catalog cannot distinguish "supports optional reasoning"
 *     from "reasoning is mandatory" — both merely list `reasoning` in
 *     supported_parameters. Failing CLOSED on that signal excluded nearly the
 *     entire modern catalog: almost every current frontier model advertises
 *     reasoning yet accepts reasoning-off (the hybrid "reasoning is optional"
 *     design). The old rule left only legacy non-reasoning models plus a
 *     one-family allowlist.
 *   - So a model is assumed SAFE for reasoning-off unless it is a known
 *     reasoning-mandatory family/id (REASONING_MANDATORY_PREFIXES via
 *     startsWith, REASONING_MANDATORY_IDS via exact match), which ops can
 *     extend. A false-inclusion (a mandatory model not yet on the denylist)
 *     breaks that group with an OpenRouter 400 until the id is added; that is
 *     the accepted cost of not hiding the whole catalog.
 */
export function isReasoningSafeForOff(model: OpenRouterModel): boolean {
  if (REASONING_MANDATORY_IDS.includes(model.id)) return false
  return !REASONING_MANDATORY_PREFIXES.some((prefix) => model.id.startsWith(prefix))
}

/**
 * Check one model against one agent group's requirements.
 * Text input is required for every group — all agents converse in text.
 *
 * `strictCapabilities: false` (BYOK catalogs, ADR-0022) skips the
 * required-parameter check: provider-native `/models` listings carry no
 * capability metadata, so absence of `supported_parameters` must not read
 * as "unsupported". The modality/context checks already self-skip on
 * missing metadata.
 *
 * `zdr` (the org enforces zero data retention on an OpenRouter catalog): the
 * model must also have a ZDR endpoint, and one of those endpoints must serve
 * the group — OpenRouter refuses a ZDR request when no ZDR endpoint accepts its
 * parameters, so a model whose only tool-capable endpoint retains data is as
 * unusable for a tool-calling group as one with no ZDR endpoint at all.
 */
export function validateModelForGroup(
  model: OpenRouterModel,
  group: AgentGroupDefinition,
  strictCapabilities = true,
  zdr: ZdrIndex | null = null,
): ModelValidationResult {
  const reasons: ModelRejection[] = []
  if (model.inputModalities.length > 0 && !model.inputModalities.includes('text')) {
    reasons.push({ code: 'no_text_input', message: 'model does not accept text input' })
  }
  // Vision groups (ingestion VLM) send images; a text-only model cannot see
  // them. Self-skips when the catalog carries no modality metadata (relaxed
  // BYOK catalogs), like the text-input check above.
  if (
    group.requirements.requiresImageInput &&
    model.inputModalities.length > 0 &&
    !model.inputModalities.includes('image')
  ) {
    reasons.push({
      code: 'no_image_input',
      message: 'model does not accept image input (a vision model is required)',
    })
  }
  if (model.contextLength > 0 && model.contextLength < group.requirements.minContextLength) {
    reasons.push({
      code: 'context_too_small',
      message: `context length ${model.contextLength} is below the required ${group.requirements.minContextLength}`,
      params: { actual: model.contextLength, required: group.requirements.minContextLength },
    })
  }
  if (strictCapabilities) {
    for (const param of group.requirements.requiredParameters) {
      if (!model.supportedParameters.includes(param)) {
        reasons.push({
          code: 'missing_parameter',
          message: `model does not support required parameter '${param}'`,
          params: { parameter: param },
        })
      }
    }
  }
  // Reasoning-off groups (e.g. follow_ups, `reasoning_effort: none`) must not
  // select a reasoning-mandatory model. Runs regardless of strictCapabilities:
  // relaxed BYOK catalogs carry no `supported_parameters`, so isReasoningSafeForOff
  // treats them as safe (fails open only when there is no reasoning evidence).
  if (group.requirements.reasoningOff && !isReasoningSafeForOff(model)) {
    reasons.push({
      code: 'reasoning_mandatory',
      message: 'model always reasons, and this group runs with reasoning off',
    })
  }
  const zdrReason = zdr ? zdrRejection(model, group, zdr) : null
  if (zdrReason) reasons.push(zdrReason)
  return { ok: reasons.length === 0, reasons }
}

/** Models from the catalog that are appropriate for a group, best-name-match first. */
export function searchModelsForGroup(
  catalog: OpenRouterModel[],
  groupId: string,
  query: string,
  limit = 30,
  strictCapabilities = true,
  zdr: ZdrIndex | null = null,
): OpenRouterModel[] {
  const group = getAgentGroup(groupId)
  if (!group) return []
  const q = query.trim().toLowerCase()
  return catalog
    .filter((model) => validateModelForGroup(model, group, strictCapabilities, zdr).ok)
    .filter((model) => !q || model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit)
}

/**
 * Server-side validation of a full overrides object against the live catalog.
 * Returns per-group rejections; an unknown model id, a capability mismatch or
 * (with `zdr`) a model without a usable ZDR endpoint rejects the save — the
 * picker UI can never be trusted alone.
 *
 * `catalog` is the UNFILTERED catalog even under ZDR, so a model that exists
 * but has no ZDR endpoint is reported as `not_zdr`, not as `not_in_catalog`.
 */
export function validateOverrides(
  catalog: OpenRouterModel[],
  overrides: Record<string, string>,
  strictCapabilities = true,
  zdr: ZdrIndex | null = null,
): { ok: boolean; errors: Record<string, ModelRejection[]>; snapshot: Record<string, OpenRouterModel> } {
  const errors: Record<string, ModelRejection[]> = {}
  const snapshot: Record<string, OpenRouterModel> = {}
  for (const [groupId, modelId] of Object.entries(overrides)) {
    const group = AGENT_GROUPS.find((g) => g.id === groupId)
    if (!group) {
      errors[groupId] = [{ code: 'unknown_group', message: 'unknown agent group' }]
      continue
    }
    const model = catalog.find((m) => m.id === modelId)
    if (!model) {
      errors[groupId] = [
        {
          code: 'not_in_catalog',
          message: `model '${modelId}' not found in the model catalog`,
          params: { model: modelId },
        },
      ]
      continue
    }
    const validation = validateModelForGroup(model, group, strictCapabilities, zdr)
    if (!validation.ok) {
      errors[groupId] = validation.reasons
      continue
    }
    snapshot[groupId] = model
  }
  return { ok: Object.keys(errors).length === 0, errors, snapshot }
}
