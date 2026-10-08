/**
 * The organization's upload-screening policy, as the browser reads it before
 * sending a file (ADR-0085).
 *
 * The name gate runs here first because it is the only place that keeps an
 * excluded file on the office's own machine: the server repeats it, but by the
 * time the server can refuse, the bytes have arrived. So a policy that cannot
 * be read is NOT "no policy": the browser screens with Piloti's suggestion and
 * leaves the final word to the server, which knows the office's own list.
 *
 * Cached for a minute per page: a folder upload plans against it, then the
 * upload hook checks again, and the two must not each pay a round trip.
 */

import { getUploadScreening } from './upload-screening-client'
import { SUGGESTED_SCREENING_POLICY, type UploadScreeningPolicy } from '@/lib/upload-screening/policy'

const CACHE_TTL_MS = 60_000

let cached: { at: number; policy: Promise<UploadScreeningPolicy> } | null = null

/** The policy in force for the signed-in member's organization. Never rejects. */
export function loadUploadScreeningPolicy(now: number = Date.now()): Promise<UploadScreeningPolicy> {
  if (!cached || now - cached.at > CACHE_TTL_MS) {
    cached = {
      at: now,
      policy: getUploadScreening().then(
        (state) => state.policy,
        () => SUGGESTED_SCREENING_POLICY
      ),
    }
  }
  return cached.policy
}

/** After an admin saved a new policy on this page, or in a test. */
export function clearUploadScreeningPolicyCache(): void {
  cached = null
}
