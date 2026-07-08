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

interface CatalogCache {
  fetchedAt: number
  models: OpenRouterModel[]
}

let catalogCache: CatalogCache | null = null

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
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.models
  }
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
  catalogCache = { fetchedAt: Date.now(), models }
  return models
}

/** Test hook. */
export function _clearCatalogCache(): void {
  catalogCache = null
}

/**
 * Check one model against one agent group's requirements.
 * Text input is required for every group — all agents converse in text.
 */
export function validateModelForGroup(model: OpenRouterModel, group: AgentGroupDefinition): ModelValidationResult {
  const reasons: string[] = []
  if (model.inputModalities.length > 0 && !model.inputModalities.includes('text')) {
    reasons.push('model does not accept text input')
  }
  if (model.contextLength > 0 && model.contextLength < group.requirements.minContextLength) {
    reasons.push(
      `context length ${model.contextLength.toLocaleString()} is below the required ${group.requirements.minContextLength.toLocaleString()}`,
    )
  }
  for (const param of group.requirements.requiredParameters) {
    if (!model.supportedParameters.includes(param)) {
      reasons.push(`model does not support required parameter '${param}'`)
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/** Models from the catalog that are appropriate for a group, best-name-match first. */
export function searchModelsForGroup(
  catalog: OpenRouterModel[],
  groupId: string,
  query: string,
  limit = 30,
): OpenRouterModel[] {
  const group = getAgentGroup(groupId)
  if (!group) return []
  const q = query.trim().toLowerCase()
  return catalog
    .filter((model) => validateModelForGroup(model, group).ok)
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
      errors[groupId] = `model '${modelId}' not found in the OpenRouter catalog`
      continue
    }
    const validation = validateModelForGroup(model, group)
    if (!validation.ok) {
      errors[groupId] = validation.reasons.join('; ')
      continue
    }
    snapshot[groupId] = model
  }
  return { ok: Object.keys(errors).length === 0, errors, snapshot }
}
