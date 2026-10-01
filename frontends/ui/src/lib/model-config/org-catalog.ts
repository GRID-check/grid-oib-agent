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
import {
  getActiveCredentialProvider,
  resolveActiveCredentialForBackend,
  type ResolvedCredential,
} from '@/lib/llm-credentials/service'
import { MODEL_ID_PATTERN } from './agent-groups'
import { fetchModelCatalog, fetchZdrEndpoints, type OpenRouterModel, type ZdrIndex } from './openrouter'

const BYOK_CATALOG_TTL_MS = 5 * 60 * 1000
const BYOK_LIST_TIMEOUT_MS = 8_000

export interface OrgModelCatalog {
  /**
   * The whole catalog, NOT narrowed to ZDR models: callers pass `zdr` to
   * `searchModelsForGroup` / `validateOverrides`, which filter the picker and
   * name a non-ZDR model as such (`not_zdr`) instead of "not in the catalog".
   */
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
   * True when the Zero-Data-Retention filter was requested AND applies — `zdr`
   * then holds the ZDR endpoint index every selection is checked against. False
   * when ZDR was not requested, or cannot be honoured for this catalog source
   * (see `zdrApplicable`).
   */
  zdrOnly: boolean
  /**
   * Whether Piloti can enforce zero data retention for this org's traffic at
   * all. False for a BYOK key on a provider other than OpenRouter: those
   * requests go straight to the org's own provider, whose retention is governed
   * by the org's contract with it. The stored setting is left untouched.
   */
  zdrApplicable: boolean
  /** The ZDR endpoint index when `zdrOnly`, else null. */
  zdr: ZdrIndex | null
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
 * Whether zero data retention through OpenRouter can apply to a credential:
 * the platform key, or the org's own OpenRouter key. A key on any other
 * provider sends traffic past OpenRouter, where `provider.zdr` means nothing.
 */
export function isZdrApplicableForCredential(credential: Pick<ResolvedCredential, 'provider'> | null): boolean {
  return !credential || credential.provider === 'openrouter'
}

/**
 * `isZdrApplicableForCredential` for an org: reads which provider its traffic
 * goes to, without revealing the key or fetching any catalog.
 */
export async function isZdrApplicableForOrg(organizationId: string): Promise<boolean> {
  const provider = await getActiveCredentialProvider(organizationId)
  return isZdrApplicableForCredential(provider === null ? null : { provider })
}

/**
 * The catalog the org's admins pick models from. Throws on upstream failure
 * (callers surface 503, same contract as `fetchModelCatalog`).
 *
 * With `zdrOnly`, OpenRouter-sourced catalogs (platform or a BYOK OpenRouter
 * key) carry the ZDR endpoint index, and the ZDR list failing throws
 * `ZdrListUnavailableError` rather than falling back to the unfiltered catalog,
 * so a non-ZDR model is never offered or accepted while the policy is on. A
 * BYOK provider-native listing (openai/azure/custom) cannot be ZDR-filtered
 * through OpenRouter, so the flag is reported as not applicable there — the
 * org's own provider contract governs retention for those keys.
 */
export async function getCatalogForOrg(
  organizationId: string,
  options: OrgCatalogOptions = {},
): Promise<OrgModelCatalog> {
  const wantZdr = options.zdrOnly === true
  const credential = await resolveActiveCredentialForBackend(organizationId)

  // Spelled out rather than `isZdrApplicableForCredential(credential)` so the
  // compiler narrows `credential` for the provider-native branch below.
  if (!credential || credential.provider === 'openrouter') {
    // No credential (platform key), or the org's own OpenRouter key: the same
    // public catalog with full metadata — traffic just bills to the org key.
    const [models, zdr] = await Promise.all([fetchModelCatalog(), wantZdr ? fetchZdrEndpoints() : null])
    return {
      models,
      source: credential ? 'byok' : 'openrouter',
      provider: credential ? 'openrouter' : null,
      validation: 'full',
      zdrOnly: wantZdr,
      zdrApplicable: true,
      zdr,
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
    zdrApplicable: false,
    zdr: null,
  }
}
