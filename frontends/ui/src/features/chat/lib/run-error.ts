/**
 * Which banner a failed turn earns.
 *
 * Most `RUN_ERROR`s are generic, but one is not a fault at all: under the
 * organization's zero-data-retention policy OpenRouter refuses a model with no
 * ZDR endpoint that can serve the request. Shown as a generic failure it reads
 * like an outage and invites "try again", which fails identically every time;
 * what helps is an admin choosing a ZDR model, so it gets its own code, copy
 * and no retry button. The text contract lives in `isZdrPolicyRefusal`.
 */

import { isZdrPolicyRefusal } from '@/lib/model-config/zdr-refusal'
import type { ErrorCode } from '../types'

export { isZdrPolicyRefusal }

/** The `RUN_ERROR` codes the wire carries, mapped to what the reader is told. */
const RUN_ERROR_CODES: Record<string, ErrorCode> = {
  workflow_error: 'agent.workflow_error',
  auth_error: 'auth.session_expired',
  interaction_expired: 'agent.response_interrupted',
}

export interface RunErrorCard {
  code: ErrorCode
  /** Overrides the registry's localized message; omitted for codes whose copy says it all. */
  message?: string
  /** The raw text behind a localized message, for the banner's "details". */
  details?: string
}

/**
 * The error card for a turn that ended in `RUN_ERROR` (or without one).
 *
 * A ZDR refusal is recognised in the message whatever the wire code, because
 * the backend reports provider errors as `workflow_error`; the raw provider text
 * moves to `details` so support can still read it.
 */
export function runErrorCard(error: { code: string; message: string } | undefined): RunErrorCard {
  if (!error) return { code: 'agent.response_failed' }
  if (isZdrPolicyRefusal(error.message)) return { code: 'agent.zdr_refused', details: error.message }
  return { code: RUN_ERROR_CODES[error.code] ?? 'agent.response_failed', message: error.message }
}
