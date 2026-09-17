/**
 * The rate-limit catalog, with types.
 *
 * The rules themselves live in `./rules.js` — CommonJS, because `server.js`
 * enforces three of them on an open WebSocket and cannot import TypeScript.
 * This module is the typed face of that file: import from here (or from
 * `@/lib/limits`) everywhere in the app, and `require('./rules.js')` only from
 * the socket proxy. The `satisfies` below is what keeps the two honest — if a
 * rule in the JS file stops matching `LimitRule`, this file stops compiling.
 *
 * Read `./rules.js` for what belongs in the catalog and what belongs to the
 * neighbouring layers (cost → ADR-0015 budgets, capacity → job admission).
 */

import * as rules from './rules.js'
import type { LimitRule } from './types'

export const SHARE_LIMIT: LimitRule = rules.SHARE_LIMIT
export const TYPING_LIMIT: LimitRule = rules.TYPING_LIMIT
export const MENTION_LIMIT: LimitRule = rules.MENTION_LIMIT
export const WS_UPGRADE_LIMIT: LimitRule = rules.WS_UPGRADE_LIMIT
export const CHAT_TURN_LIMIT: LimitRule = rules.CHAT_TURN_LIMIT
export const WS_CONTROL_LIMIT: LimitRule = rules.WS_CONTROL_LIMIT
export const DEFAULT_MUTATION_LIMIT: LimitRule = rules.DEFAULT_MUTATION_LIMIT
export const BIM_QUERY_LIMIT: LimitRule = rules.BIM_QUERY_LIMIT
export const BIM_EXPORT_LIMIT: LimitRule = rules.BIM_EXPORT_LIMIT
export const RIS_DOCUMENT_LIMIT: LimitRule = rules.RIS_DOCUMENT_LIMIT

/**
 * Every rule, for the coverage spec and for anything that wants to enumerate
 * the policy. Keyed by rule name, so two rules sharing a name — and therefore
 * silently sharing a bucket — is a collision you can see rather than a
 * coincidence you cannot.
 */
export const LIMIT_CATALOG = {
  [SHARE_LIMIT.name]: SHARE_LIMIT,
  [TYPING_LIMIT.name]: TYPING_LIMIT,
  [MENTION_LIMIT.name]: MENTION_LIMIT,
  [WS_UPGRADE_LIMIT.name]: WS_UPGRADE_LIMIT,
  [CHAT_TURN_LIMIT.name]: CHAT_TURN_LIMIT,
  [WS_CONTROL_LIMIT.name]: WS_CONTROL_LIMIT,
  [DEFAULT_MUTATION_LIMIT.name]: DEFAULT_MUTATION_LIMIT,
  [BIM_QUERY_LIMIT.name]: BIM_QUERY_LIMIT,
  [BIM_EXPORT_LIMIT.name]: BIM_EXPORT_LIMIT,
  [RIS_DOCUMENT_LIMIT.name]: RIS_DOCUMENT_LIMIT,
} as const satisfies Record<string, LimitRule>

/**
 * Maximum people one message may mention (spec MN-13, which mandates a bound
 * but names no number).
 *
 * The single source of truth for that bound: the mentions service refuses above
 * it, and the messages route's request schema caps its `mentions` array with
 * this same constant. Keeping them one value is deliberate — a looser schema
 * cap meant an over-limit message passed validation and was then refused by the
 * service, two different errors for one rule.
 *
 * Not a `LimitRule`: it bounds one message's shape, not a rate.
 */
export const MAX_MENTIONS_PER_MESSAGE = 10

/**
 * Maximum messages one POST to the messages route may carry.
 *
 * That route accepts either a single message or an array, and the route factory
 * charges `DEFAULT_MUTATION_LIMIT` once per REQUEST. Without a cap the two
 * combine badly: an unbounded array turns one unit of budget into arbitrarily
 * much insert work, so the rate limit stops bounding anything the endpoint
 * actually does.
 *
 * The cap is half the answer and the route supplies the other half — it charges
 * one unit per message rather than per request, so a batch of ten costs what ten
 * single posts cost. The cap then bounds the work of a single request; the
 * budget bounds the work over time.
 *
 * The number itself is constrained from above by `DEFAULT_MUTATION_LIMIT`'s
 * BURST clause, and that is not a coincidence to leave implicit: charging per
 * message means a batch of N spends N points at once, so a cap above the burst
 * limit would advertise a batch size the limiter refuses every single time. The
 * spec asserts the relationship, so lowering the burst later fails a test
 * instead of quietly making the documented maximum unusable.
 *
 * Sized as headroom, not as a fit: no caller batches today (the client's
 * `createMessages` exists but every live path posts one message), so this is
 * room for a future sync or import path rather than a number anything currently
 * approaches.
 *
 * Not a `LimitRule`: it bounds one request's shape, not a rate.
 */
export const MAX_MESSAGES_PER_REQUEST = 25
