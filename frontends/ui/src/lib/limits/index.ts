/**
 * Rate limiting for the BFF — ADR-0040 layer L2.
 *
 * ```ts
 * import { consumeLimit, memberSubject, SHARE_LIMIT } from '@/lib/limits'
 *
 * const decision = await consumeLimit(SHARE_LIMIT, memberSubject(session))
 * if (!decision.allowed) throw new ForbiddenError('Too many sharing changes.')
 * ```
 *
 * Four layers surround this one and each owns a different question. Reaching
 * for the wrong one is the most common way a limit ends up in the wrong place:
 *
 * | Question | Layer | Where |
 * |---|---|---|
 * | Too many requests from this address? | L1 | Envoy Gateway, `deploy/pulumi` |
 * | Too many actions from this member? | **L2** | **here** |
 * | Too many frames on this socket? | L2b | `server.js` (same primitive) |
 * | Is there capacity to run this now? | L3 | `GRID_MAX_ACTIVE_JOBS*` |
 * | May this spend money? | L4 | ADR-0015 budgets |
 */

export { consumeLimit, enforceLimit, rateLimitHeaders } from './enforce'
export { getLimitStore, setLimitStore, createInProcessStore } from './store'
export type { LimitStore, StoreOutcome } from './store'
export type { LimitBudget, LimitRule, RateLimitDecision } from './types'
export {
  CHAT_TURN_LIMIT,
  BIM_QUERY_LIMIT,
  DEFAULT_MUTATION_LIMIT,
  LIMIT_CATALOG,
  MAX_MENTIONS_PER_MESSAGE,
  MAX_MESSAGES_PER_REQUEST,
  MENTION_LIMIT,
  SHARE_LIMIT,
  TYPING_LIMIT,
  WS_CONTROL_LIMIT,
  WS_UPGRADE_LIMIT,
} from './catalog'
export { memberSubject } from './subject'
