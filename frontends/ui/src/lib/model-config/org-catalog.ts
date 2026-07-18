/**
 * Org-aware model catalog (ADR-0022 × ADR-0014).
 *
 * The model switcher follows the organization's LLM credential:
 *
 *  - No BYOK credential      → platform OpenRouter catalog (ADR-0014 as-is).
 *  - BYOK `openrouter` key   → same OpenRouter catalog (full capability
 *    metadata) — the org picks models exactly as before, billed to its own
 *    OpenRouter account.
 *  - BYOK openai/azure/custom → the provider's live `GET {baseUrl}/models`
 *    listing, fetched with the ORG's key. These listings carry ids only (no
 *    context-length / supported-parameter metadata), so capability checks
 *    run in relaxed mode: membership in the listing is the gate.
 *
 * Catalogs are cacheable (no secrets inside) per org+credential for the same
 * 5 minutes as the platform catalog.
 */

import 'server-only'
import { getCached } from '@/lib/cache'
import { resolveActiveCredentialForBackend, type ResolvedCredential } from '@/lib/llm-credentials/service'
import { MODEL_ID_PATTERN } from './agent-groups'
import { fetchModelCatalog, fetchZdrModelIds, filterCatalogToZdr, type OpenRouterModel } from './openrouter'

const BYOK_CATALOG_TTL_MS = 5 * 60 * 1000
const BYOK_LIST_TIMEOUT_MS = 8_000

export interface OrgModelCatalog {
  models: OpenRouterModel[]
  /** Where the models come from — drives the UI hint and snapshot metadata. */
  source: 'openrouter' | 'byok'
  /** BYOK provider id when `source === 'byok'`. */
  provider: string | null
  /**
   * 'full'   — OpenRouter metadata present, capability requirements enforced.
   * 'listed' — provider-native listing; membership is the only enforceable check.
   */
  validation: 'full' | 'listed'
  /**
   * True when the Zero-Data-Retention filter was requested AND applied — the
   * `models` list has been narrowed to models with a ZDR endpoint. False when
   * ZDR was not requested, or could not be honoured for this catalog source
   * (a BYOK provider-native listing OpenRouter cannot ZDR-filter).
   */
  zdrOnly: boolean
}

export interface OrgCatalogOptions {
  /** Restrict the catalog to models offered under a Zero-Data-Retention policy. */
  zdrOnly?: boolean
}

function toBareModel(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    contextLength: 0,
    promptPrice: 0,
    completionPrice: 0,
    inputModalities: [],
    supportedParameters: [],
  }
}

/** `GET {baseUrl}/models` with the org's key — ids only, never cached with the key. */
async function fetchProviderModelList(credential: ResolvedCredential): Promise<string[]> {
  const response = await fetch(`${credential.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${credential.apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(BYOK_LIST_TIMEOUT_MS),
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`BYOK provider model listing failed: HTTP ${response.status}`)
  }
  const body = (await response.json()) as { data?: unknown[] }
  const ids = (body.data ?? [])
    .map((entry) =>
      entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
        ? (entry as { id: string }).id
        : null,
    )
    .filter((id): id is string => id !== null && MODEL_ID_PATTERN.test(id))
  if (ids.length === 0) {
    throw new Error('BYOK provider model listing contained no models')
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

/**
 * Restrict an OpenRouter-sourced catalog to Zero-Data-Retention models. Fails
 * CLOSED: a ZDR-list outage throws (callers surface 503) rather than falling
 * back to the unfiltered catalog, so a non-ZDR model is never offered while the
 * ZDR filter is on.
 */
async function applyZdrFilter(models: OpenRouterModel[]): Promise<OpenRouterModel[]> {
  const zdrModelIds = await fetchZdrModelIds()
  return filterCatalogToZdr(models, zdrModelIds)
}

/**
 * The catalog the org's admins pick models from. Throws on upstream failure
 * (callers surface 503, same contract as `fetchModelCatalog`).
 *
 * With `zdrOnly`, OpenRouter-sourced catalogs (platform or a BYOK OpenRouter
 * key) are narrowed to models with a Zero-Data-Retention endpoint. A BYOK
 * provider-native listing (openai/azure/custom) cannot be ZDR-filtered through
 * OpenRouter, so the flag is reported as not-applied there — the org's own
 * provider contract governs retention for those keys.
 */
export async function getCatalogForOrg(
  organizationId: string,
  options: OrgCatalogOptions = {},
): Promise<OrgModelCatalog> {
  const wantZdr = options.zdrOnly === true
  const credential = await resolveActiveCredentialForBackend(organizationId)

  if (!credential) {
    const models = await fetchModelCatalog()
    return {
      models: wantZdr ? await applyZdrFilter(models) : models,
      source: 'openrouter',
      provider: null,
      validation: 'full',
      zdrOnly: wantZdr,
    }
  }
  if (credential.provider === 'openrouter') {
    // Same public catalog, full metadata — traffic just bills to the org key.
    const models = await fetchModelCatalog()
    return {
      models: wantZdr ? await applyZdrFilter(models) : models,
      source: 'byok',
      provider: 'openrouter',
      validation: 'full',
      zdrOnly: wantZdr,
    }
  }

  const cacheKey = `orgmodelcatalog:${organizationId}:${credential.id}`
  const ids = await getCached(cacheKey, BYOK_CATALOG_TTL_MS, async () => fetchProviderModelList(credential))
  return {
    models: ids.map(toBareModel),
    source: 'byok',
    provider: credential.provider,
    validation: 'listed',
    // ZDR-via-OpenRouter does not apply to a provider-native listing.
    zdrOnly: false,
  }
}
