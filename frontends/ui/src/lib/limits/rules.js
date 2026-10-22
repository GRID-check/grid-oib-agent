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
 *     (`GRID_MAX_ACTIVE_JOBS_PER_ORG`): concurrent slots, not events per minute. If
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
 * The motion a viewer sends to one document's room (`POST /api/realtime/send`,
 * `doc:<id>`): its pointer at most every 80ms while it moves and where it is
 * scrolled to at most every 200ms (`lib/annotations/room-types.ts`). Spent per
 * member AND channel (`lib/realtime/send.ts`), so a second document open in
 * another tab has a budget of its own. A pointer and a scroll that never stop
 * for a minute cost about 1,050 calls; one person has one pointer, so a
 * second tab on the same document adds little. Shedding is free for the same
 * reason as typing: a pointer is worthless a moment later. The client drops a
 * refused one and pauses its motion for the `Retry-After`.
 *
 * Presence claims and the selected mark do NOT spend this: they spend
 * {@link ROOM_CLAIM_LIMIT}, so motion can never starve the claim that keeps a
 * person in everyone's roster.
 * @type {LimitRule}
 */
const ROOM_LIMIT = { name: 'document-room', limit: 1500, windowMs: 60 * 1000 }

/**
 * The claims a viewer makes in one document's room: its presence (a refresh
 * every 10s, a `here` on each reconnect and to each newcomer, `gone` when the
 * tab goes) and which mark it has selected. Per member and channel, like
 * {@link ROOM_LIMIT}, and a bucket of its own so that a refused pointer never
 * means a refused claim: a refused claim ages out of everyone's roster and the
 * person silently disappears. Honest use is a few dozen a minute; the rest is
 * room for someone clicking briskly through the marks.
 * @type {LimitRule}
 */
const ROOM_CLAIM_LIMIT = { name: 'document-room-claim', limit: 600, windowMs: 60 * 1000 }

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
 * Structured BIM queries (`POST /api/bim/models/[modelId]/query`).
 *
 * A READ that travels as POST — the request is a nested filter object that
 * would be unreadable and over-long as a query string — so without its own
 * rule the factory's default charged it as a mutation. That shared bucket is
 * how reading a model broke uploading a document: the viewer pages a whole
 * model's elements sequentially, a real model is hundreds of pages, and the
 * pager first tripped `api-mutation`'s burst clause and then (each refusal
 * still spending a sustained point) drained the budget the UPLOAD route needed.
 * "Too many requests" on an upload, caused by looking at a viewer.
 *
 * Sized against the legitimate worst case, which the catalog spec pins: a full
 * element walk of a model at the extraction cap must fit inside the sustained
 * clause with room for the workspace's card queries beside it. Still a real
 * abuse bound — the pager is single-flight, so the burst clause only exists to
 * stop PARALLEL hammering, and every query underneath is further bounded by
 * the statement timeout.
 * @type {LimitRule}
 */
const BIM_QUERY_LIMIT = {
  name: 'bim-query',
  limit: 900,
  windowMs: 60 * 1000,
  burst: { limit: 100, windowMs: 2 * 1000 },
}

/**
 * The Prüfbuch as a BCF archive (`GET /api/projects/[id]/bim/checks/export`).
 *
 * The heaviest thing this product will do for one GET, and reads are not
 * defaulted — so it had no bound at all. It runs the full `compliance` op,
 * whose memo is keyed on `(modelId, Gebäudeklasse, Hauptnutzung)` and holds 64
 * entries process-wide; both facts are caller-supplied query parameters over a
 * 5-value range and a 9-value enum, so 54 URLs per model each miss the cache,
 * each parse the whole `rule_inputs` blob — tens of megabytes on a large model
 * — run the catalogue synchronously on the event loop, and build a ZIP in
 * memory. One project viewer could do that in a loop, for the whole
 * deployment, with plain GETs.
 *
 * Much tighter than `bim-query` because the two are not the same kind of read:
 * that one is sized for a pager walking a model page by page, this one is a
 * person pressing Export. Twelve a minute is more exports than anyone makes
 * and few enough that the cache cannot be walked.
 * @type {LimitRule}
 */
const BIM_EXPORT_LIMIT = {
  name: 'bim-export',
  limit: 12,
  windowMs: 60 * 1000,
  burst: { limit: 3, windowMs: 5 * 1000 },
}

/**
 * A RIS document, read for a citation (`GET /api/ris/document`).
 *
 * A read, and reads are not defaulted — so this one had no bound at all, which
 * was the wrong answer for the only read in this product that makes a
 * THIRD-PARTY network call per request. The cost of one unbounded request is
 * not a database row: `RisClient._get_with_retries` will spend three attempts
 * with a 30 s timeout each plus 1 s and 2 s of backoff before it gives up, and
 * a Gesamtfassung is megabytes — so a loop here is a self-DoS on backend
 * workers AND an amplifier pointed at a government service that has done
 * nothing to deserve it.
 *
 * Sized for what a person does. Checking a citation is one open; reading an
 * answer with a dozen RIS sources and opening every one is a dozen. Sixty a
 * minute leaves that untouched and stops a loop dead; the burst clause is what
 * actually catches the loop, since a human cannot open six documents in five
 * seconds and a script does nothing else.
 * @type {LimitRule}
 */
const RIS_DOCUMENT_LIMIT = {
  name: 'ris-document',
  limit: 60,
  windowMs: 60 * 1000,
  burst: { limit: 6, windowMs: 5 * 1000 },
}

/**
 * Document uploads (`POST /api/office-shelf/documents/upload`, `/api/documents/upload`,
 * `/api/session/documents/upload`), one request per file.
 *
 * Its own bucket for the same reason `bim-query` has one: on the shared
 * `api-mutation` budget, dropping a folder of a few hundred files into the
 * Archiv spent the member's whole minute, and the chat opened next could not
 * save its answer, create its conversation or name it — every one a 429.
 * Uploading must not break chatting, and chatting must not refuse an upload.
 *
 * Sized for a folder upload at the client's three-at-a-time concurrency: small
 * files turn around in ~100 ms, so an honest batch peaks near thirty a second,
 * and the burst clause sits above that. The sustained clause is what a person
 * does in a minute with a large Einreichung, and the client waits out
 * `Retry-After` on a refusal rather than failing the file, so a folder bigger
 * than the minute's budget slows down instead of breaking. What the files cost
 * to store is the quota's business; what fits in the ingest queue is admission
 * control's.
 * @type {LimitRule}
 */
const DOCUMENT_UPLOAD_LIMIT = {
  name: 'document-upload',
  limit: 600,
  windowMs: 60 * 1000,
  burst: { limit: 80, windowMs: 2 * 1000 },
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

/**
 * PostHog's poke that a feedback ticket has a new message
 * (`POST /api/webhooks/posthog-support`, ADR-0118, second amendment).
 *
 * The route has no session, so there is no member to charge. Two buckets
 * instead: one per ticket, which bounds how often a real ticket is re-read
 * from PostHog (a forged poke can do nothing else), and one for the whole
 * deployment, which bounds the lookups a flood of made-up ids costs. A team
 * answers at human pace: thirty messages on one ticket in ten minutes is a
 * lively exchange, six hundred pokes in ten minutes across every ticket is
 * far past the team's whole day, and sixty in five seconds is a script.
 * @type {LimitRule}
 */
const POSTHOG_SUPPORT_POKE_TICKET_LIMIT = { name: 'posthog-support-poke-ticket', limit: 30, windowMs: 10 * 60 * 1000 }

/** @type {LimitRule} */
const POSTHOG_SUPPORT_POKE_LIMIT = {
  name: 'posthog-support-poke',
  limit: 600,
  windowMs: 10 * 60 * 1000,
  burst: { limit: 60, windowMs: 5 * 1000 },
}

/**
 * Sending product feedback to the platform owners.
 *
 * Every report becomes an inbox item for every platform owner (and, once a
 * sender exists, an email), so one person's budget is a blast-radius bound on
 * the platform's inbox, not a load bound. Ten an hour is far more than anyone
 * honestly writes and far less than a stuck retry loop would.
 * @type {LimitRule}
 */
const FEEDBACK_REPORT_LIMIT = { name: 'feedback-report', limit: 10, windowMs: 60 * 60 * 1000 }

/**
 * A reporter answering on their own feedback thread.
 *
 * A reply posts into the platform's Support inbox and the Slack channel the
 * PostHog workflow feeds, so it is bounded like a report, only looser: a
 * conversation runs to a few messages in a row. Sixty an hour is a lively
 * exchange; a stuck client is stopped well before it floods the channel.
 * @type {LimitRule}
 */
const FEEDBACK_REPLY_LIMIT = { name: 'feedback-reply', limit: 60, windowMs: 60 * 60 * 1000 }

/**
 * Dictating into the chat composer.
 *
 * Every call is a paid transcription the member is never billed for and no
 * budget counts (ADR-0015 budgets deliberately skip it), so this rule is the
 * only bound on what one member can make the platform spend. A recording is at
 * most 45 seconds, so one a minute is a person talking without pause; the
 * hourly clause is a long working session of dictated messages, and the burst
 * clause stops a stuck retry loop within the minute.
 * @type {LimitRule}
 */
const DICTATION_LIMIT = {
  name: 'dictation',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  burst: { limit: 6, windowMs: 60 * 1000 },
}

/**
 * One HTTP request to the agent door, `/api/mcp` (ADR-0122), per member.
 *
 * Charged once per request after the caller is known (an external agent's
 * token, or Piloti's envelope: both are the same person's budget), before any
 * tool runs. It bounds the door, not the work: every operation it dispatches
 * still pays its own route's rule (`api-mutation`, `bim-query`, ...), and a
 * write by Piloti only files a proposal. A model making a tool call a second
 * for ten minutes is far past an honest agent, which pauses to think between
 * calls; a stuck client loop is not, and the burst clause stops it within
 * seconds. A turn's few dozen calls fit with room to spare.
 * @type {LimitRule}
 */
const MCP_REQUEST_LIMIT = {
  name: 'mcp-request',
  limit: 600,
  windowMs: 10 * 60 * 1000,
  burst: { limit: 30, windowMs: 5 * 1000 },
}

/**
 * Mail reaching one project's address (ADR-0134, DECISION D18), per address.
 *
 * Every mail arrives through Cloudflare's shared egress and one signing key, so
 * no client address or person tells two senders apart: the address is the
 * unit, and the organization and the key are bounds around it. Charged by the
 * webhook after the signature and before a byte of the body is read; over it,
 * the answer is a 429 the sending server retries for days, so a burst delays
 * mail and never loses it. Two a minute for an hour is a busy project's whole
 * correspondence and far below a script pointed at a leaked address, which the
 * office then rotates. There is no count cap on what waits: a byte cap does
 * that (`INBOUND_MAIL_ADDRESS_STAGED_BYTES` in `lib/inbound-mail/receive.ts`),
 * because a count cap bounces real senders after a backlog (RT-X5).
 * @type {LimitRule}
 */
const INBOUND_MAIL_ADDRESS_LIMIT = { name: 'inbound-mail-address', limit: 120, windowMs: 60 * 60 * 1000 }

/**
 * Mail reaching any address of one organization, per hour: five busy projects
 * at once. One leaked address cannot spend it alone (the per-address rule
 * stops it at a fifth).
 * @type {LimitRule}
 */
const INBOUND_MAIL_ORGANIZATION_LIMIT = { name: 'inbound-mail-organization', limit: 600, windowMs: 60 * 60 * 1000 }

/**
 * Every delivery one signing key makes, per hour: the Worker's whole traffic
 * under that key. A leaked key spraying known addresses meets this before it
 * meets the database.
 * @type {LimitRule}
 */
const INBOUND_MAIL_SIGNING_KEY_LIMIT = { name: 'inbound-mail-signing-key', limit: 3000, windowMs: 60 * 60 * 1000 }

/**
 * Deliveries to a token no project has, per signing key, in a bucket of their
 * own (RT-S9): a guesser walking the token space is answered „unknown“ (and
 * its sender bounces) until this runs out, then 429, and none of it spends the
 * budgets real mail is charged to.
 * @type {LimitRule}
 */
const INBOUND_MAIL_UNKNOWN_ADDRESS_LIMIT = {
  name: 'inbound-mail-unknown-address',
  limit: 300,
  windowMs: 60 * 60 * 1000,
}

/**
 * Downloading a mail's original `.eml` (ADR-0134, D6), per person: a held
 * mail's (`inbound-mail-original-get`) and a filed message's
 * (`mail-thread-entry-original-get`) share one budget.
 *
 * Every download is scanned whole by the in-cluster ClamAV on that request (up
 * to 26 MiB, `ScanMail`), because a verdict from the day the mail arrived says
 * nothing about today's signatures. So this rule bounds the scanner's load one
 * person can cause, not the bytes: sixty an hour is a person working through a
 * dispute's correspondence one original at a time, and the burst clause stops
 * a script or a stuck client within the minute, before it queues the scanner
 * for everyone else in the office.
 * @type {LimitRule}
 */
const MAIL_ORIGINAL_DOWNLOAD_LIMIT = {
  name: 'mail-original-download',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  burst: { limit: 10, windowMs: 60 * 1000 },
}

module.exports = {
  MAIL_ORIGINAL_DOWNLOAD_LIMIT,
  INBOUND_MAIL_ADDRESS_LIMIT,
  INBOUND_MAIL_ORGANIZATION_LIMIT,
  INBOUND_MAIL_SIGNING_KEY_LIMIT,
  INBOUND_MAIL_UNKNOWN_ADDRESS_LIMIT,
  MCP_REQUEST_LIMIT,
  DICTATION_LIMIT,
  FEEDBACK_REPORT_LIMIT,
  FEEDBACK_REPLY_LIMIT,
  POSTHOG_SUPPORT_POKE_LIMIT,
  POSTHOG_SUPPORT_POKE_TICKET_LIMIT,
  BIM_QUERY_LIMIT,
  BIM_EXPORT_LIMIT,
  RIS_DOCUMENT_LIMIT,
  DOCUMENT_UPLOAD_LIMIT,
  SHARE_LIMIT,
  TYPING_LIMIT,
  ROOM_LIMIT,
  ROOM_CLAIM_LIMIT,
  MENTION_LIMIT,
  WS_UPGRADE_LIMIT,
  CHAT_TURN_LIMIT,
  WS_CONTROL_LIMIT,
  DEFAULT_MUTATION_LIMIT,
}
