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
  reasons: string[]
}

const CATALOG_TTL_MS = 5 * 60 * 1000
const CATALOG_CACHE_KEY = 'openrouter:catalog'
const ZDR_CACHE_KEY = 'openrouter:zdr-endpoints'

function baseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')
}

/** The base `author/slug`, dropping any `:variant` suffix (`:free`, `:nitro`, …). */
function baseModelId(id: string): string {
  return id.split(':', 1)[0]
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

/**
 * Recursively collect every plausible OpenRouter model id (`author/slug`) from
 * a ZDR-endpoint entry, whatever the exact response shape is. `/endpoints/zdr`
 * returns provider endpoints with a Zero-Data-Retention policy; each entry
 * references its model under a field whose name has varied across OpenRouter
 * revisions (`id`, `slug`, `canonical_slug`, nested `model.slug`, …), so we
 * scan defensively rather than pin one path. Ids are normalised to the base
 * `author/slug` so they match catalog ids regardless of `:variant` suffix.
 */
function collectZdrModelIds(node: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || node === null) return
  if (typeof node === 'string') {
    if (OPENROUTER_MODEL_ID_PATTERN.test(node)) into.add(baseModelId(node))
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectZdrModelIds(item, into, depth + 1)
    return
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      collectZdrModelIds(value, into, depth + 1)
    }
  }
}

/**
 * The set of base model ids that have at least one Zero-Data-Retention
 * endpoint, from OpenRouter's `GET /api/v1/endpoints/zdr` listing. Cached like
 * the catalog. Throws on upstream failure so callers fail CLOSED — a model may
 * only be offered under a ZDR policy when we can positively confirm it is on
 * the ZDR list, never on a best-guess.
 *
 * (See openrouter.ai/docs — Zero Data Retention. The list is per-model/provider
 * and account-independent, so it is the correct source for a per-organization
 * ZDR filter in a multi-tenant deployment; the account-wide `/models/user`
 * privacy filter is not.)
 */
export async function fetchZdrModelIds(): Promise<Set<string>> {
  return getCached(ZDR_CACHE_KEY, CATALOG_TTL_MS, async () => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const apiKey = process.env.OPENROUTER_API_KEY
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const response = await fetch(`${baseUrl()}/endpoints/zdr`, { headers, cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`OpenRouter ZDR endpoint listing request failed: HTTP ${response.status}`)
    }
    const body = (await response.json()) as { data?: unknown }
    const ids = new Set<string>()
    collectZdrModelIds(body.data ?? body, ids)
    if (ids.size === 0) {
      throw new Error('OpenRouter ZDR endpoint listing contained no model ids')
    }
    return ids
  })
}

/** Keep only catalog models whose base id has a Zero-Data-Retention endpoint. */
export function filterCatalogToZdr(catalog: OpenRouterModel[], zdrModelIds: Set<string>): OpenRouterModel[] {
  return catalog.filter((model) => zdrModelIds.has(baseModelId(model.id)))
}

/**
 * Allowlist of reasoning-capable model families that are known to ACCEPT
 * reasoning-off (`reasoning_effort: none` / `reasoning: {enabled:false}`) —
 * i.e. hybrid "reasoning is optional" models. Exported so ops can extend
 * both lists without a code review of the rule itself.
 *
 * `REASONING_OPTIONAL_PREFIXES` is matched with `startsWith` (a whole family);
 * `REASONING_OPTIONAL_IDS` is matched by exact id.
 */
export const REASONING_OPTIONAL_PREFIXES: string[] = ['deepseek/']
export const REASONING_OPTIONAL_IDS: string[] = []

/**
 * Whether a model is safe to select for a group that runs with reasoning
 * DISABLED (`reasoning_effort: none`).
 *
 * Rationale (verbatim — do not "optimize" this asymmetry away):
 *   - Models that do NOT list 'reasoning' (or 'include_reasoning') in
 *     supportedParameters never reason → always safe.
 *   - Models that DO list reasoning are UNSAFE by default, because
 *     OpenRouter's catalog cannot distinguish "supports optional reasoning"
 *     from "reasoning is mandatory". The costs are asymmetric: a
 *     false-exclusion merely loses one picker option, while a false-inclusion
 *     breaks EVERY turn of that group (OpenRouter 400 "Reasoning is mandatory
 *     for this endpoint and cannot be disabled"). We therefore fail closed.
 *   - EXCEPT ids on the allowlist (REASONING_OPTIONAL_PREFIXES via startsWith,
 *     REASONING_OPTIONAL_IDS via exact match): known hybrid families that
 *     accept reasoning-off, which ops can extend.
 */
export function isReasoningSafeForOff(model: OpenRouterModel): boolean {
  const declaresReasoning =
    model.supportedParameters.includes('reasoning') || model.supportedParameters.includes('include_reasoning')
  if (!declaresReasoning) return true
  if (REASONING_OPTIONAL_IDS.includes(model.id)) return true
  return REASONING_OPTIONAL_PREFIXES.some((prefix) => model.id.startsWith(prefix))
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
 */
export function validateModelForGroup(
  model: OpenRouterModel,
  group: AgentGroupDefinition,
  strictCapabilities = true,
): ModelValidationResult {
  const reasons: string[] = []
  if (model.inputModalities.length > 0 && !model.inputModalities.includes('text')) {
    reasons.push('model does not accept text input')
  }
  if (model.contextLength > 0 && model.contextLength < group.requirements.minContextLength) {
    reasons.push(
      `context length ${model.contextLength.toLocaleString()} is below the required ${group.requirements.minContextLength.toLocaleString()}`,
    )
  }
  if (strictCapabilities) {
    for (const param of group.requirements.requiredParameters) {
      if (!model.supportedParameters.includes(param)) {
        reasons.push(`model does not support required parameter '${param}'`)
      }
    }
  }
  // Reasoning-off groups (e.g. intent, `reasoning_effort: none`) must not
  // select a reasoning-mandatory model. Runs regardless of strictCapabilities:
  // relaxed BYOK catalogs carry no `supported_parameters`, so isReasoningSafeForOff
  // treats them as safe (fails open only when there is no reasoning evidence).
  if (group.requirements.reasoningOff && !isReasoningSafeForOff(model)) {
    reasons.push('Modell erfordert Reasoning — für diese Aufgabe ist Reasoning deaktiviert')
  }
  return { ok: reasons.length === 0, reasons }
}

/** Models from the catalog that are appropriate for a group, best-name-match first. */
export function searchModelsForGroup(
  catalog: OpenRouterModel[],
  groupId: string,
  query: string,
  limit = 30,
  strictCapabilities = true,
): OpenRouterModel[] {
  const group = getAgentGroup(groupId)
  if (!group) return []
  const q = query.trim().toLowerCase()
  return catalog
    .filter((model) => validateModelForGroup(model, group, strictCapabilities).ok)
    .filter((model) => !q || model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit)
}

/**
 * Server-side validation of a full overrides object against the live catalog.
 * Returns per-group errors; an unknown model id or a capability mismatch
 * rejects the save (the picker UI can never be trusted alone).
 */
export function validateOverrides(
  catalog: OpenRouterModel[],
  overrides: Record<string, string>,
  strictCapabilities = true,
): { ok: boolean; errors: Record<string, string>; snapshot: Record<string, OpenRouterModel> } {
  const errors: Record<string, string> = {}
  const snapshot: Record<string, OpenRouterModel> = {}
  for (const [groupId, modelId] of Object.entries(overrides)) {
    const group = AGENT_GROUPS.find((g) => g.id === groupId)
    if (!group) {
      errors[groupId] = 'unknown agent group'
      continue
    }
    const model = catalog.find((m) => m.id === modelId)
    if (!model) {
      errors[groupId] = `model '${modelId}' not found in the model catalog`
      continue
    }
    const validation = validateModelForGroup(model, group, strictCapabilities)
    if (!validation.ok) {
      errors[groupId] = validation.reasons.join('; ')
      continue
    }
    snapshot[groupId] = model
  }
  return { ok: Object.keys(errors).length === 0, errors, snapshot }
}
