/**
 * The claim on `bff_job_queue`, as the BFF sees it (ADR-0078).
 *
 * The SQL is not here. The runner that claims is a plain Node process with no
 * build step, so the claim lives in `workers/job-queue.js` and this module is
 * how TypeScript reaches that one copy, the way `lib/db/errors.ts` reaches
 * `workers/database-unavailable.js`. The BFF itself only enqueues and reads
 * (`./repository.ts`); its tests and the internal run route claim through here.
 */

import 'server-only'

export {
  claimNext,
  complete,
  depth,
  enqueue,
  fail,
  heartbeat,
  reapExhausted,
  release,
  saveProgress,
} from '../../../workers/job-queue.js'
export type { Claim, ClaimOptions } from '../../../workers/job-queue.js'
