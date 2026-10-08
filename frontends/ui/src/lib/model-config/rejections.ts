/**
 * Why a model was refused for an agent group, as a stable code.
 *
 * The save paths (org PUT, rollback, platform defaults) used to answer a 422
 * with English prose per group, which the admin cards pasted into a toast
 * verbatim: a German admin read `model 'x' not found in the model catalog` for
 * what was really "this model has no zero-data-retention endpoint", and one
 * reason was hard-coded German for everybody. A code is what the UI localizes;
 * `message` stays English for logs and for API clients that do not.
 *
 * Client-safe on purpose (no `server-only`): the cards import the type and
 * `localizeRejection`, the server builds the values.
 */

import type { Translator } from '@/i18n'

export const MODEL_REJECTION_CODES = [
  'unknown_group',
  'not_in_catalog',
  /** The model has no endpoint on OpenRouter's zero-data-retention list. */
  'not_zdr',
  /** It has ZDR endpoints, but none of them serves what the group sends (tools, context). */
  'zdr_endpoint_lacks_capability',
  'no_text_input',
  'no_image_input',
  'context_too_small',
  'missing_parameter',
  'reasoning_mandatory',
] as const

export type ModelRejectionCode = (typeof MODEL_REJECTION_CODES)[number]

export interface ModelRejection {
  code: ModelRejectionCode
  /** English, for logs and API clients that do not localize. */
  message: string
  /** Values the localized copy interpolates (`model`, `parameter`, `actual`, `required`). */
  params?: Record<string, string | number>
}

/** 503 `details.reason` when the zero-data-retention list could not be read. */
export const ZDR_LIST_UNAVAILABLE = 'zdr_list_unavailable'

/**
 * Whether a failed response is the ZDR list being unreadable (a 503 whose
 * `details.reason` names it). Reads the body, so call it once per response.
 */
export async function isZdrListUnavailableResponse(res: Response): Promise<boolean> {
  if (res.status !== 503) return false
  try {
    const body = (await res.json()) as { details?: { reason?: unknown } }
    return body.details?.reason === ZDR_LIST_UNAVAILABLE
  } catch {
    return false
  }
}

export function isModelRejectionCode(value: unknown): value is ModelRejectionCode {
  return typeof value === 'string' && (MODEL_REJECTION_CODES as readonly string[]).includes(value)
}

function isModelRejection(value: unknown): value is ModelRejection {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ModelRejection>
  return isModelRejectionCode(candidate.code) && typeof candidate.message === 'string'
}

/**
 * A 422 body's `details`, read as `{group: rejections}`.
 *
 * Tolerant because it reads the network: a group whose value is not a list of
 * rejections is dropped rather than rendered as `[object Object]`.
 */
export function readRejectionDetails(details: unknown): Record<string, ModelRejection[]> {
  if (!details || typeof details !== 'object') return {}
  const out: Record<string, ModelRejection[]> = {}
  for (const [group, value] of Object.entries(details as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const rejections = value.filter(isModelRejection)
    if (rejections.length > 0) out[group] = rejections
  }
  return out
}

/** One rejection in the reader's language. `t` is bound to the `organization` namespace. */
export function localizeRejection(rejection: ModelRejection, t: Translator): string {
  return t(`models.rejection.${rejection.code}`, rejection.params)
}

/**
 * Every rejected group as one line each: `Label: reason; reason`.
 * `labelOf` maps a group id to what the card calls it.
 */
export function describeRejections(
  details: unknown,
  t: Translator,
  labelOf: (groupId: string) => string
): string[] {
  return Object.entries(readRejectionDetails(details)).map(
    ([group, rejections]) =>
      `${labelOf(group)}: ${rejections.map((rejection) => localizeRejection(rejection, t)).join('; ')}`
  )
}
