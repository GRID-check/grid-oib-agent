/**
 * A refused request about held mail, as the code the UI words.
 *
 * The routes answer one code per check (`INBOUND_MAIL_REFUSALS`, carried as
 * `details.reason` and lifted into `ApiRequestError.reason` by the client).
 * Anything else, a network failure or a code this build does not know, is
 * `unknown`, which the UI words as a plain failure with a retry.
 *
 * Pure.
 */

import { ApiRequestError } from '@/adapters/api/api-error'
import { INBOUND_MAIL_REFUSALS, type InboundMailRefusal } from '@/lib/inbound-mail/inbound-mail-wire'

export type RefusalCode = InboundMailRefusal | 'unknown'

export function refusalOf(error: unknown): RefusalCode {
  if (!(error instanceof ApiRequestError) || !error.reason) return 'unknown'
  return (INBOUND_MAIL_REFUSALS as readonly string[]).includes(error.reason) ? (error.reason as InboundMailRefusal) : 'unknown'
}

/** A refusal after which the mail must be read again before anything else is decided. */
export function refusalNeedsReload(code: RefusalCode): boolean {
  return code === 'stale' || code === 'part_not_waiting' || code === 'part_unknown' || code === 'gone'
}
