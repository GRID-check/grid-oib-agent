/**
 * The organization's upload-screening policy, as the browser reads it before
 * sending a file (ADR-0083).
 *
 * The name gate runs here first because it is the only place that keeps an
 * excluded file on the office's own machine: the server repeats it, but by the
 * time the server can refuse, the bytes have arrived. So a policy that cannot
 * be read is NOT "no policy", and it is not Piloti's suggestion either: a file
 * that matches only a term the office added would pass that list and be sent.
 * The load rejects with {@link UploadScreeningPolicyUnavailableError}, and the
 * upload paths send nothing.
 *
 * Read fresh for every upload. Only a request already in flight is shared, so
 * a folder upload that plans against the policy and then screens again does
 * not ask twice at once. A kept copy would let a term an admin saved a moment
 * ago, in this tab or any other, miss the next upload.
 */

import { getUploadScreening } from './upload-screening-client'
import type { UploadScreeningPolicy } from '@/lib/upload-screening/policy'

/** The office's policy could not be read, so nothing may be sent. */
export class UploadScreeningPolicyUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The upload-screening policy could not be loaded', options)
    this.name = 'UploadScreeningPolicyUnavailableError'
  }
}

let inFlight: Promise<UploadScreeningPolicy> | null = null

/**
 * The policy in force for the signed-in member's organization. Rejects with
 * {@link UploadScreeningPolicyUnavailableError} when it cannot be read.
 */
export function loadUploadScreeningPolicy(): Promise<UploadScreeningPolicy> {
  if (!inFlight) {
    const request = getUploadScreening().then(
      (state) => state.policy,
      (cause: unknown) => {
        throw new UploadScreeningPolicyUnavailableError({ cause })
      }
    )
    inFlight = request
    const settle = (): void => {
      if (inFlight === request) inFlight = null
    }
    request.then(settle, settle)
  }
  return inFlight
}

/**
 * After an admin saved a new policy in this tab: a read already under way may
 * predate the save, so the next upload starts its own. Nothing is kept
 * between reads, so there is no copy to clear.
 */
export function forgetPendingUploadScreeningPolicyRead(): void {
  inFlight = null
}
