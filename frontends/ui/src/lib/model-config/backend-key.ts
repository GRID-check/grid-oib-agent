/**
 * The BACKEND's copy of an org's effective model config in the shared cache.
 *
 * `src/aiq_agent/common/model_overrides.py` (`shared_model_config_key`) writes
 * `modelconfig:{org}` after its just-in-time fetch and memoises it per process
 * for seconds only, so deleting the key here is what makes a save reach every
 * backend replica within seconds instead of the minute a per-replica TTL
 * allowed. Three writers own a deletion: an org's config save or rollback, an
 * org's ZDR toggle, and a platform-defaults save, which moves every org and so
 * drops the whole prefix. Keep the key in step with the Python side.
 *
 * Its own module so `organizations/service.ts` and `model-config/service.ts`
 * can both reach it without importing each other.
 */

import { invalidateCached, invalidateCachedPrefix } from '@/lib/cache'

const PREFIX = 'modelconfig:'

export const backendModelConfigKey = (organizationId: string): string => `${PREFIX}${organizationId}`

export async function invalidateBackendModelConfig(organizationId: string): Promise<void> {
  // Fail-open by construction: `invalidateCached` logs `[cache] invalidate
  // failed for <key>` with the key name and never throws, so a sick cache
  // cannot fail the admin save it follows. METRICS HOOK: count those lines
  // (key prefix `modelconfig:`) if missed invalidations ever need an alert —
  // a silent drop here reads as "the save did nothing" for up to L2 60s.
  await invalidateCached(backendModelConfigKey(organizationId))
}

export async function invalidateEveryBackendModelConfig(): Promise<void> {
  await invalidateCachedPrefix(PREFIX)
}
