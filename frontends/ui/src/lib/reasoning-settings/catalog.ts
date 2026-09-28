/**
 * The reasoning-effort ("thinking level") vocabulary a platform owner may set
 * per agent group (Platform → Models).
 *
 * Source of truth for the accepted values. Mirrored by `_EFFORTS` in the
 * backend's `src/aiq_agent/common/reasoning_settings.py`; parity is pinned from
 * both sides by `tests/fixtures/reasoning_efforts_catalog.json`, so a value
 * added here without the backend counterpart fails in CI.
 *
 * These are OpenRouter's UNIFIED effort levels, passed through verbatim. We
 * deliberately do NOT translate them per model family: OpenRouter maps the
 * requested effort to the nearest level each model actually supports,
 * server-side, per model. That is what makes an effort chosen here survive the
 * group's model changing underneath it — and why provider-native tier names
 * (DeepSeek's `max`) must never appear: OpenRouter rejects them. See
 * https://openrouter.ai/docs/guides/best-practices/reasoning-tokens and the
 * NOTE in `aiq_agent/common/llm_factory.py`.
 */

/** Ordered cheapest → most expensive; the UI renders them in this order. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * Validate one chosen effort. Returns null when acceptable, else the reason.
 *
 * Intentionally value-only: whether a given MODEL honours a given effort is
 * OpenRouter's business (it maps to the nearest supported level), and a
 * reasoning-mandatory model refusing `none` is caught at request time by
 * `is_reasoning_incompatible_error`, which falls back rather than failing the
 * turn. Validating that here would duplicate a contract we do not own.
 */
export function validateReasoningEffort(effort: unknown): string | null {
  if (!isReasoningEffort(effort)) {
    return `not a reasoning effort (expected one of: ${REASONING_EFFORTS.join(', ')})`
  }
  return null
}

/**
 * The levels the chat composer's Aufwand dial offers, cheapest first: the
 * dial's stops, left ("Schneller") to right ("Intelligenter").
 *
 * `none` is not a stop. The chat answer's envelope is a contract the model has
 * to reason its way into, and without reasoning it loses it. Mirrored by
 * `CHAT_EFFORTS` in `aiq_agent/common/reasoning_settings.py`; the wire schema
 * (`UserMessage.reasoning_effort`) refuses anything else.
 */
export const CHAT_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

export type ChatEffort = (typeof CHAT_EFFORTS)[number]

/** Where a chat starts when neither the chat nor the organization chose a level. */
export const DEFAULT_CHAT_EFFORT: ChatEffort = 'medium'

/**
 * The organization's default for new chats lives in its settings bag under this
 * key (Organisation → Einstellungen). Any member may read it; `org:settings:manage`
 * writes it.
 */
export const CHAT_EFFORT_SETTING = 'chatReasoningEffort'

export function isChatEffort(value: unknown): value is ChatEffort {
  return typeof value === 'string' && (CHAT_EFFORTS as readonly string[]).includes(value)
}

/** The organization's stored default, or the product default for a missing or stale value. */
export function chatEffortFromSettings(settings: Record<string, unknown> | null | undefined): ChatEffort {
  const stored = settings?.[CHAT_EFFORT_SETTING]
  return isChatEffort(stored) ? stored : DEFAULT_CHAT_EFFORT
}
