/**
 * The rate-limit catalog — every app-layer budget, in one file (ADR-0040 L2).
 *
 * Modelled on `@/lib/authz/catalog`, and for the same reason: a policy that
 * lives wherever it was first needed cannot be reviewed, and cannot be audited
 * for gaps. A limit belongs here even when exactly one call site uses it.
 *
 * ## Why this file is CommonJS
 *
 * `server.js` is plain CommonJS and cannot import TypeScript — its own header
 * documents the request-context envelope it had to duplicate for that reason.
 * The WebSocket proxy enforces three of the rules below, so the DATA lives here
 * where both can load it (`require()` from `server.js`, a normal import from
 * `./catalog.ts`, which re-exports it with types). No logic, no dependencies:
 * the enforcement itself is `rate-limiter-flexible`, wired up in `./factory.js`.
 *
 * ## What belongs here, and what does not
 *
 * These are **abuse bounds**. They exist so one account cannot make the product
 * expensive for everyone else — a mention bomb, a runaway client loop, a script
 * pointed at an endpoint that fans out. They are enforced approximately, they
 * fail open, and they are never the record of anything.
 *
 * Two neighbours do the jobs this file must not attempt:
 *
 *   - **Cost** is the ADR-0015 budget ledger: euros, per org/member/project,
 *     append-only, exact, fail-closed on refusal. If the question is "may this
 *     spend money", it is not a rate limit.
 *   - **Capacity** is admission control in the Python API
 *     (`GRID_MAX_ACTIVE_JOBS*`): concurrent slots, not events per minute. If
 *     the question is "is there room to run this now", a rate limit is the
 *     wrong shape — it would admit a fourth long run at a steady trickle.
 *
 * ## About the numbers
 *
 * Every value below is a starting point chosen from what honest use costs, and
 * every one of them should be replaced by a measurement. The three migrated
 * from the retired `@/lib/sharing/rate-limit` keep their original budgets
 * exactly, so that change was an algorithm change and not a silent retune.
 *
 * @typedef {{ limit: number, windowMs: number }} LimitBudget
 * @typedef {{ name: string, limit: number, windowMs: number, burst?: LimitBudget }} LimitRule
 */

/**
 * Sharing a resource with someone.
 * @type {LimitRule}
 */
const SHARE_LIMIT = { name: 'share', limit: 60, windowMs: 60 * 60 * 1000 }

/**
 * Composing presence.
 *
 * The highest-frequency endpoint in the product. A legitimate client publishes
 * once per 3s while somebody types (see `presence-contract`), so this is
 * roughly ten times what honest use costs — but it is the difference between a
 * bounded cost and an open one, because each call resolves access, counts
 * grants, resolves the participant list and then publishes once PER participant
 * onto everybody's open event stream. Shedding is free: presence is worthless
 * one second later.
 * @type {LimitRule}
 */
const TYPING_LIMIT = { name: 'typing', limit: 120, windowMs: 60 * 1000 }

/**
 * Sending mentions (counted per mentioned person, not per message).
 * @type {LimitRule}
 */
const MENTION_LIMIT = { name: 'mention', limit: 100, windowMs: 60 * 60 * 1000 }

/**
 * WebSocket upgrades, per client.
 *
 * Every upgrade triggers session resolution, FGA checks and budget reads in the
 * BFF, so a reconnect storm amplifies straight into WorkOS and Postgres. The
 * edge now carries the same budget (ADR-0040 L1, `rateLimitAppWsUpgrade`); this
 * one stays as the layer that still works while the edge policy is in shadow
 * mode, and as the only one that applies to traffic that never crossed the
 * gateway.
 *
 * The burst clause is the real constraint: a browser reconnecting on a jittered
 * backoff produces a handful of upgrades, never ten in two seconds.
 * @type {LimitRule}
 */
const WS_UPGRADE_LIMIT = {
  name: 'ws-upgrade',
  limit: 30,
  windowMs: 60 * 1000,
  burst: { limit: 10, windowMs: 2 * 1000 },
}

/**
 * Chat turns on an OPEN socket — the rule that closes ADR-0040's second blind
 * spot.
 *
 * The edge sees one HTTP request per chat session (the upgrade) and nothing
 * afterwards, because every turn rides the socket (ADR-0009). So the most
 * expensive thing a user can do — start a multi-agent research run — is
 * invisible to every gateway policy that will ever be written. Only the proxy
 * that owns the socket can count it.
 *
 * 30 turns per 5 minutes is far above deliberate use (a turn takes tens of
 * seconds to read, let alone answer) and far below what a script emits. The
 * burst clause stops a loop from queueing five agent runs in one second, which
 * is the failure this rule exists for. What those runs COST is still the
 * ADR-0015 budget's business, and what fits in the queue is still admission
 * control's.
 * @type {LimitRule}
 */
const CHAT_TURN_LIMIT = {
  name: 'chat-turn',
  limit: 30,
  windowMs: 5 * 60 * 1000,
  burst: { limit: 5, windowMs: 10 * 1000 },
}

/**
 * Everything else a client may send on an open socket — today an interaction
 * response to a human-in-the-loop prompt, tomorrow any new control frame.
 *
 * Cheap per frame, but unbounded without a rule, and each one still reaches the
 * agent process. Loose enough that no interactive use will ever touch it.
 * @type {LimitRule}
 */
const WS_CONTROL_LIMIT = {
  name: 'ws-control',
  limit: 240,
  windowMs: 60 * 1000,
  burst: { limit: 30, windowMs: 2 * 1000 },
}

/**
 * The default budget for a mutating API route that has not declared one.
 *
 * `apiRoute` applies this to every POST/PUT/PATCH/DELETE unless the route says
 * otherwise, so a new endpoint is bounded on the day it ships rather than on
 * the day someone remembers. Deliberately loose — this is a backstop against a
 * runaway client, not a considered per-endpoint policy. A route that needs a
 * real number declares one.
 *
 * Reads are not defaulted: they are cheap, they are the bulk of the traffic,
 * and the edge's per-IP budget already bounds them. Defaulting them would buy
 * little and break a legitimately chatty UI.
 * @type {LimitRule}
 */
const DEFAULT_MUTATION_LIMIT = {
  name: 'api-mutation',
  limit: 300,
  windowMs: 60 * 1000,
  burst: { limit: 40, windowMs: 2 * 1000 },
}

module.exports = {
  SHARE_LIMIT,
  TYPING_LIMIT,
  MENTION_LIMIT,
  WS_UPGRADE_LIMIT,
  CHAT_TURN_LIMIT,
  WS_CONTROL_LIMIT,
  DEFAULT_MUTATION_LIMIT,
}
