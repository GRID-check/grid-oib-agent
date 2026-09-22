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
/**
 * `:v2` because the payload shape changed: this key used to hold a `Set`, which
 * `JSON.stringify` flattens to `{}`. Entries written by the old code are still
 * live in a shared Dragonfly for up to CATALOG_TTL_MS after a deploy, so the new
 * reader must not find them.
 */
const ZDR_CACHE_KEY = 'openrouter:zdr-endpoints:v2'

function baseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')
}

/**
 * The base `author/slug`, dropping any `:variant` suffix (`:free`, `:nitro`, …).
 *
 * Exported because the ZDR listing is keyed by base id: anyone testing a
 * catalog model against it has to strip the variant the same way, and two
 * hand-rolled `split(':')`s are two chances to drift.
 */
export function baseModelId(id: string): string {
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
 *
 * **The cache stores the ARRAY, and the `Set` is rebuilt on the way out.**
 * `getCached` round-trips through JSON (it has to — the shared store is
 * Dragonfly), and `JSON.stringify(new Set(['a']))` is `'{}'`. Caching the `Set`
 * itself type-checked fine and returned a real `Set` on the miss, then handed
 * every cache HIT a prototype-less `{}` that blew up on `.has(...)`. Same
 * pattern as `enabledSlugsForOrg` in `@/lib/workos/feature-flags`.
 */
export async function fetchZdrModelIds(): Promise<Set<string>> {
  const ids = await getCached<string[]>(ZDR_CACHE_KEY, CATALOG_TTL_MS, async () => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const apiKey = process.env.OPENROUTER_API_KEY
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const response = await fetch(`${baseUrl()}/endpoints/zdr`, { headers, cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`OpenRouter ZDR endpoint listing request failed: HTTP ${response.status}`)
    }
    const body = (await response.json()) as { data?: unknown }
    const collected = new Set<string>()
    collectZdrModelIds(body.data ?? body, collected)
    if (collected.size === 0) {
      throw new Error('OpenRouter ZDR endpoint listing contained no model ids')
    }
    return [...collected]
  })

  // A cache entry we cannot read is not an empty allowlist — same fail-CLOSED
  // contract as the upstream failure above, so a foreign payload can never
  // quietly widen (or silently empty) the ZDR filter. Every element is checked,
  // not just the array-ness: `getCached` casts rather than validates, so a
  // foreign payload like `[null]` would otherwise reach callers inside a
  // `Set<string>` that does not hold strings.
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => typeof id !== 'string' || !OPENROUTER_MODEL_ID_PATTERN.test(id))
  ) {
    throw new Error('OpenRouter ZDR model listing is unusable')
  }
  return new Set(ids)
}

/** Keep only catalog models whose base id has a Zero-Data-Retention endpoint. */
export function filterCatalogToZdr(catalog: OpenRouterModel[], zdrModelIds: Set<string>): OpenRouterModel[] {
  return catalog.filter((model) => zdrModelIds.has(baseModelId(model.id)))
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
  // Vision groups (ingestion VLM) send images; a text-only model cannot see
  // them. Self-skips when the catalog carries no modality metadata (relaxed
  // BYOK catalogs), like the text-input check above.
  if (
    group.requirements.requiresImageInput &&
    model.inputModalities.length > 0 &&
    !model.inputModalities.includes('image')
  ) {
    reasons.push('model does not accept image input (a vision model is required)')
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
  // Reasoning-off groups (e.g. follow_ups, `reasoning_effort: none`) must not
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
