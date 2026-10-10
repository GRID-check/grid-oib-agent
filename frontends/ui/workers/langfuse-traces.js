// @ts-check
/**
 * Deleting Langfuse traces: the one client the purger and the scheduler share.
 *
 * Langfuse keeps every prompt and answer a turn produced (ADR-0044), and its
 * automatic retention is an Enterprise feature, so two jobs of ours do the
 * deleting through the native API that every edition has:
 *
 *   - **erasure** (`purger/`): a conversation that is erased takes its traces
 *     with it. They are found by `sessionId`, because `langfuse.session.id` is
 *     the conversation id on every span (`langfuse_trace_attributes.py`).
 *   - **retention** (`scheduler/`): a daily sweep deletes traces older than the
 *     retention window, a bounded number of batches per run.
 *
 * ## The API shapes, and where they were checked
 *
 * Checked against the version `deploy/pulumi/src/config.ts` pins (Langfuse
 * 4.48.0), its OpenAPI spec (`web/public/generated/api/openapi.yml`), its route
 * source (`web/src/pages/api/public/traces/index.ts`,
 * `.../v2/observations/index.ts`) and the v3 -> v4 upgrade guide:
 *
 * - **Delete:** `DELETE /api/public/traces`, body `{ "traceIds": string[] }`,
 *   1 to 1000 ids, answers `200 { "message": string }`. Deletion is
 *   asynchronous: the route records the ids and a worker deletes them. It is
 *   not one of the legacy endpoints v4 switches off.
 * - **List:** `GET /api/public/traces` IS switched off. Langfuse v4 answers it
 *   with 404 under the default write mode (`events_only`; the route is
 *   `rejectInEventsOnlyMode`), and Piloti is heading there from `dual`. So the
 *   traces are found through `GET /api/public/v2/observations`: `sessionId`,
 *   `isRootObservation`, `toStartTime` (exclusive), `fields`, `limit` (max
 *   1000) and an opaque `cursor`, answering `{ data: [{ traceId, ... }],
 *   meta: { cursor? } }`; `meta.cursor` is absent on the last page. It answers
 *   404 unless the deployment writes v4 data (`dual` or `events_only`), which
 *   is why a Langfuse in write mode `legacy` is not supported here.
 * - **Auth:** HTTP Basic, public key as user and secret key as password.
 *
 * ## Two guards a wrong filter cannot get past
 *
 * A filter Langfuse ignores returns everything, and this client deletes what it
 * is shown. So a row that does not belong (another session; a start time at or
 * after the cutoff) aborts the run with an error before anything is deleted
 * from that page, and an empty session id is refused before a request is made.
 */

/** `DELETE /api/public/traces` refuses more than this many ids. */
const MAX_DELETE_BATCH = 1000
/** `GET /api/public/v2/observations` caps `limit` here. */
const LIST_PAGE_SIZE = 1000
/**
 * A runaway guard on one listing, not a budget: a million observations of one
 * conversation, or a cursor that never ends. The retention sweep has its own,
 * much smaller, budget.
 */
const MAX_LIST_PAGES = 1000
/** Per request. Langfuse answers a list of 1000 in well under this. */
const REQUEST_TIMEOUT_MS = 30_000

/** The shortest window Langfuse's own retention setting accepts. */
const MIN_RETENTION_DAYS = 3
const DEFAULT_RETENTION_DAYS = 30

const SETTINGS = /** @type {const} */ (['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'])

/**
 * A Langfuse call that did not succeed. `transient` is the caller's cue to wait
 * and try again rather than to page somebody: a transport error, a timeout, a
 * rate limit, or a 5xx.
 */
class LangfuseError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, transient: boolean, kind: string, cause?: unknown }} details
   */
  constructor(message, { status, transient, kind, cause }) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LangfuseError'
    this.status = status
    this.transient = transient
    /** Stable text for a log line or an escalation, with no ids and no body. */
    this.kind = kind
  }
}

/**
 * @typedef {object} LangfuseConfig
 * @property {string} host  base URL, no trailing slash
 * @property {string} authorization  the full `Authorization` header value
 */

/**
 * The Langfuse connection from the environment, or null when it is not all
 * there. Never a default host: the SDK's own default is Langfuse Cloud, which
 * is the one place these keys do not belong, and a deletion sent to the wrong
 * Langfuse is worse than none.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ config: LangfuseConfig | null, missing: string[] }}
 */
function readLangfuseConfig(env) {
  const host = (env.LANGFUSE_HOST ?? '').trim().replace(/\/+$/, '')
  const publicKey = (env.LANGFUSE_PUBLIC_KEY ?? '').trim()
  const secretKey = (env.LANGFUSE_SECRET_KEY ?? '').trim()
  const present = { LANGFUSE_HOST: host, LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey }
  const missing = SETTINGS.filter((name) => !present[name])
  if (missing.length > 0) return { config: null, missing }
  if (!/^https?:\/\//i.test(host)) return { config: null, missing: ['LANGFUSE_HOST (not an http(s) URL)'] }
  const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`
  return { config: { host, authorization }, missing: [] }
}

/**
 * The retention window in days: `GRID_LANGFUSE_TRACE_RETENTION_DAYS`, default
 * 30, never below Langfuse's own minimum of 3.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ days: number, clamped: boolean }}
 */
function readTraceRetentionDays(env) {
  const raw = (env.GRID_LANGFUSE_TRACE_RETENTION_DAYS ?? '').trim()
  if (!raw) return { days: DEFAULT_RETENTION_DAYS, clamped: false }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return { days: DEFAULT_RETENTION_DAYS, clamped: true }
  if (parsed < MIN_RETENTION_DAYS) return { days: MIN_RETENTION_DAYS, clamped: true }
  return { days: parsed, clamped: false }
}

/**
 * @typedef {object} Observation
 * @property {string} [traceId]
 * @property {string} [sessionId]
 * @property {string} [startTime]
 */

/**
 * @typedef {object} TraceClient
 * @property {(params: ObservationQuery) => AsyncGenerator<Observation[]>} observationPages
 * @property {(traceIds: string[]) => Promise<void>} deleteTraces
 */

/**
 * @typedef {object} ObservationQuery
 * @property {string} [sessionId]
 * @property {string} [toStartTime]  ISO 8601, exclusive
 * @property {boolean} [isRootObservation]
 * @property {string} fields  field groups; `core` carries `traceId`, `startTime`
 */

/**
 * @param {unknown} error
 * @returns {LangfuseError}
 */
function transportError(error) {
  const name = error instanceof Error ? error.name : typeof error
  const timedOut = name === 'TimeoutError' || name === 'AbortError'
  return new LangfuseError(`Langfuse request failed (${timedOut ? 'timeout' : name})`, {
    transient: true,
    kind: timedOut ? 'timeout' : `transport error (${name})`,
    cause: error,
  })
}

/**
 * @param {LangfuseConfig} config
 * @param {typeof fetch} [fetchImpl]
 * @returns {TraceClient}
 */
function createTraceClient(config, fetchImpl = fetch) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {{ query?: Record<string, string>, body?: unknown }} [options]
   * @returns {Promise<any>}
   */
  async function request(method, path, { query, body } = {}) {
    const search = query ? `?${new URLSearchParams(query).toString()}` : ''
    /** @type {Response} */
    let res
    try {
      res = await fetchImpl(`${config.host}${path}${search}`, {
        method,
        headers: {
          authorization: config.authorization,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw transportError(error)
    }
    if (!res.ok) {
      // The path only: no query (it carries a conversation id), no body.
      const transient = res.status === 429 || res.status >= 500
      throw new LangfuseError(`Langfuse ${method} ${path} answered ${res.status}`, {
        status: res.status,
        transient,
        kind: `HTTP ${res.status}`,
      })
    }
    return res.json().catch(() => ({}))
  }

  return {
    async *observationPages({ sessionId, toStartTime, isRootObservation, fields }) {
      /** @type {string | undefined} */
      let cursor
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        /** @type {Record<string, string>} */
        const query = { limit: String(LIST_PAGE_SIZE), fields }
        if (sessionId !== undefined) query.sessionId = sessionId
        if (toStartTime !== undefined) query.toStartTime = toStartTime
        if (isRootObservation !== undefined) query.isRootObservation = String(isRootObservation)
        if (cursor) query.cursor = cursor
        const body = await request('GET', '/api/public/v2/observations', { query })
        if (!body || !Array.isArray(body.data)) {
          throw new LangfuseError('Langfuse observations answer had no data array', {
            transient: false,
            kind: 'unexpected response',
          })
        }
        yield /** @type {Observation[]} */ (body.data)
        cursor = typeof body.meta?.cursor === 'string' && body.meta.cursor ? body.meta.cursor : undefined
        if (!cursor) return
      }
      throw new LangfuseError(`Langfuse listing ran past ${MAX_LIST_PAGES} pages`, {
        transient: false,
        kind: 'listing did not end',
      })
    },

    async deleteTraces(traceIds) {
      if (traceIds.length === 0 || traceIds.length > MAX_DELETE_BATCH) {
        throw new RangeError(`a trace delete takes 1 to ${MAX_DELETE_BATCH} ids, got ${traceIds.length}`)
      }
      await request('DELETE', '/api/public/traces', { body: { traceIds } })
    },
  }
}

/**
 * Delete the first full batches out of `pending`, oldest insertion first.
 *
 * @param {TraceClient} client
 * @param {Set<string>} pending  trace ids waiting to be deleted; drained as batches go
 * @param {{ all: boolean, room: number }} options  `all` also sends a short last batch;
 *   `room` is how many batches may still be sent
 * @returns {Promise<number>} the number of batches sent
 */
async function flushBatches(client, pending, { all, room }) {
  let sent = 0
  while (sent < room && (pending.size >= MAX_DELETE_BATCH || (all && pending.size > 0))) {
    const batch = [...pending].slice(0, MAX_DELETE_BATCH)
    await client.deleteTraces(batch)
    for (const id of batch) pending.delete(id)
    sent += 1
  }
  return sent
}

/**
 * Delete every trace of one conversation. Idempotent: a conversation with no
 * traces, or whose traces are already gone or already queued for deletion, is a
 * clean finish.
 *
 * @param {TraceClient} client
 * @param {string} sessionId  the conversation id
 * @returns {Promise<{ traces: number, batches: number }>}
 */
async function eraseSessionTraces(client, sessionId) {
  // Without this an empty id is a request with no `sessionId` filter, which is
  // every trace in the project.
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new TypeError('eraseSessionTraces needs a session id')
  }
  const pending = new Set()
  // Every trace id seen, not only those waiting: one trace's spans arrive on
  // several pages, and the count should say traces, not sightings.
  const seen = new Set()
  let batches = 0
  for await (const page of client.observationPages({ sessionId, fields: 'core,basic' })) {
    for (const observation of page) {
      if (observation.sessionId !== sessionId) {
        throw new LangfuseError('Langfuse returned an observation outside the requested session', {
          transient: false,
          kind: 'session filter ignored',
        })
      }
      if (observation.traceId && !seen.has(observation.traceId)) {
        seen.add(observation.traceId)
        pending.add(observation.traceId)
      }
    }
    batches += await flushBatches(client, pending, { all: false, room: Infinity })
  }
  batches += await flushBatches(client, pending, { all: true, room: Infinity })
  return { traces: seen.size, batches }
}

/** One retention run: how many batches may be sent, and how many list pages read. */
const DEFAULT_MAX_BATCHES = 50
const DEFAULT_MAX_PAGES = 100
/**
 * Wall-clock budget of one retention run. The scheduler's tick waits for it, and
 * the tick also fires schedules, so a slow Langfuse may not hold it for long.
 */
const DEFAULT_MAX_DURATION_MS = 120_000

/**
 * Delete traces whose root observation started before `cutoff`, at most
 * `maxBatches` delete requests, `maxPages` list requests and `maxDurationMs` per call, so a
 * backlog drains over several runs instead of hammering the API in one.
 *
 * Roots only (`isRootObservation`): a page then holds up to 1000 traces rather
 * than 1000 spans of a few, and deleting the trace takes its spans with it. A
 * trace whose root span was never recorded is not found by this.
 *
 * @param {TraceClient} client
 * @param {Date} cutoff  exclusive
 * @param {{ maxBatches?: number, maxPages?: number, maxDurationMs?: number, now?: () => number }} [limits]
 * @returns {Promise<{ traces: number, batches: number, capped: boolean }>}
 *   `capped`: a limit stopped the run with traces possibly left
 */
async function deleteTracesBefore(
  client,
  cutoff,
  { maxBatches = DEFAULT_MAX_BATCHES, maxPages = DEFAULT_MAX_PAGES, maxDurationMs = DEFAULT_MAX_DURATION_MS, now = Date.now } = {},
) {
  const pending = new Set()
  let traces = 0
  let batches = 0
  let pages = 0
  let capped = false
  const cutoffMs = cutoff.getTime()
  const startedMs = now()
  const pagesOfOld = client.observationPages({
    toStartTime: cutoff.toISOString(),
    isRootObservation: true,
    fields: 'core',
  })
  for await (const page of pagesOfOld) {
    pages += 1
    for (const observation of page) {
      const startedAt = Date.parse(observation.startTime ?? '')
      if (!(startedAt < cutoffMs)) {
        throw new LangfuseError('Langfuse returned an observation newer than the cutoff', {
          transient: false,
          kind: 'time filter ignored',
        })
      }
      if (observation.traceId) pending.add(observation.traceId)
    }
    const sent = await flushBatches(client, pending, { all: false, room: maxBatches - batches })
    batches += sent
    traces += sent * MAX_DELETE_BATCH
    if (batches >= maxBatches || pages >= maxPages || now() - startedMs >= maxDurationMs) {
      capped = true
      break
    }
  }
  if (!capped && pending.size > 0 && batches < maxBatches) {
    const last = pending.size
    batches += await flushBatches(client, pending, { all: true, room: 1 })
    traces += last
  } else if (pending.size > 0) {
    capped = true
  }
  return { traces, batches, capped }
}

/**
 * The erasure step of a purge, over the environment: a function from a
 * conversation id to what was asked of Langfuse. Not configured is a logged
 * no-op, once, and never an error: a deployment without Langfuse has no traces
 * to erase, and one that forgot its keys is told so at boot and here.
 *
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, log?: Pick<Console, 'log' | 'warn'> }} [options]
 * @returns {(conversationId: string) => Promise<{ configured: boolean, traces: number, batches: number }>}
 */
function createConversationTraceEraser({ env = process.env, fetchImpl, log = console } = {}) {
  const { config, missing } = readLangfuseConfig(env)
  const client = config ? createTraceClient(config, fetchImpl) : undefined
  let warned = false
  return async (conversationId) => {
    if (!client) {
      if (!warned) {
        warned = true
        log.warn(`[langfuse-traces] not configured (${missing.join(', ')}): traces of erased conversations are not deleted`)
      }
      return { configured: false, traces: 0, batches: 0 }
    }
    const result = await eraseSessionTraces(client, conversationId)
    if (result.traces > 0) {
      log.log(`[langfuse-traces] asked Langfuse to delete ${result.traces} trace(s) of conversation ${conversationId}`)
    }
    return { configured: true, ...result }
  }
}

module.exports = {
  DEFAULT_MAX_BATCHES,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MAX_PAGES,
  DEFAULT_RETENTION_DAYS,
  LangfuseError,
  MAX_DELETE_BATCH,
  MIN_RETENTION_DAYS,
  createConversationTraceEraser,
  createTraceClient,
  deleteTracesBefore,
  eraseSessionTraces,
  readLangfuseConfig,
  readTraceRetentionDays,
}
