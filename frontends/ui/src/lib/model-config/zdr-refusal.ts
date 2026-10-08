/**
 * Whether a failure text is the provider refusing a request under the
 * organization's zero-data-retention policy.
 *
 * Exactly two texts, and nothing looser:
 *
 *  - OpenRouter's own refusal, documented as "No endpoints found matching your
 *    data policy" — matched on `data policy`, case-insensitive
 *    (`DATA_POLICY_REFUSAL_MARKER` on the Python side).
 *  - The backend's canned answer for it (`ZDR_MODEL_REFUSED_MESSAGE` in
 *    `src/aiq_agent/common/canned_replies.py`), which chat turns answer with and
 *    deep-research jobs persist as `job.error` — matched on its opening clause.
 *
 * Deliberately NOT on "ZDR" or "zero data retention" alone: an internal fault
 * that merely mentions ZDR ("ZDR policy lookup failed") is a bug to retry and
 * report, and reading it as "an admin must choose a model" would hide both the
 * fault and the retry.
 */

const DATA_POLICY_MARKER = /data policy/i

/** The opening clause of `ZDR_MODEL_REFUSED_MESSAGE`, verbatim. */
export const ZDR_CANNED_REFUSAL_PREFIX =
  'Diese Frage konnte nicht beantwortet werden, weil das eingestellte Modell keinen Anbieter ohne Datenspeicherung hat'

export function isZdrPolicyRefusal(text: string | null | undefined): boolean {
  if (!text) return false
  return DATA_POLICY_MARKER.test(text) || text.includes(ZDR_CANNED_REFUSAL_PREFIX)
}
