/**
 * Server-side VLM capability probe (single source of truth for the BFF).
 *
 * Image-upload availability = the `image-upload` product flag AND a derived VLM
 * capability. The capability lives on the backend (it depends on which VLM API
 * key resolves there), exposed as `vlm_available` on `GET /v1/data_sources`.
 *
 * The final accepted-types list must be identical for the two BFF surfaces that
 * consume it — the server-rendered picker/validation config (layout.tsx) and
 * the server-side upload allow-list (documents/service.ts). To keep ONE source
 * of truth, BOTH resolve the capability here and feed it into the SAME
 * `getFileUploadConfigFromEnv({ imageUploadEnabled, vlmAvailable })`. (This is
 * why the design fetches the capability server-side rather than composing the
 * final list on the client from the layout store's `vlmAvailable`: the
 * server-side allow-list has no client store to read, and must apply the exact
 * same flag∧capability rule.)
 *
 * Fail-closed: any error, timeout, or malformed payload resolves to `false`, so
 * images are never offered/accepted on a deployment whose VLM we couldn't
 * confirm. Cached with a short TTL so per-request uploads don't each pay a
 * backend round-trip while still reflecting config changes within seconds.
 */

import 'server-only'
import { getBackendUrl } from '@/lib/backend-proxy'

/** Bound the capability probe so a hung backend can't stall the BFF request. */
const PROBE_TIMEOUT_MS = 5_000

/** How long a resolved capability is reused before re-probing the backend. */
const CACHE_TTL_MS = 30_000

interface CacheEntry {
  value: boolean
  expiresAt: number
}

let cache: CacheEntry | null = null

/** Test-only: drop the cached capability so the next call re-probes. */
export function __resetVlmCapabilityCache(): void {
  cache = null
}

/**
 * Whether a vision model is configured on the backend (derived capability).
 * Cached; fail-closed to `false` on any error/timeout/malformed response.
 */
export async function isVlmConfigured(now: number = Date.now()): Promise<boolean> {
  if (cache && cache.expiresAt > now) {
    return cache.value
  }

  let value = false
  try {
    const response = await fetch(`${getBackendUrl()}/v1/data_sources`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (response.ok) {
      const data: unknown = await response.json()
      // Wrapped shape only carries the capability; a bare array (older backend)
      // reports it absent → false.
      value =
        !Array.isArray(data) &&
        typeof data === 'object' &&
        data !== null &&
        (data as { vlm_available?: unknown }).vlm_available === true
    }
  } catch {
    // Unreachable/slow backend or bad JSON — fail closed (no image offer).
    value = false
  }

  cache = { value, expiresAt: now + CACHE_TTL_MS }
  return value
}
