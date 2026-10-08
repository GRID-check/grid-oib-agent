// @ts-check
/**
 * The claim for `bff_job_queue` (ADR-0079, migration 0104): the BFF's durable
 * background work, in the order ADR-0076 proved for ingestion.
 *
 * THE CLAIM IS FAIR, ACROSS THE WHOLE FLEET. A free worker takes the next job of
 * the LANE (an organization) with the fewest live claims anywhere; among equals,
 * the lane served longest ago (`bff_job_lane_turns`); then the lane whose best
 * job has the better priority (0 interactive before 1 bulk) and is the oldest.
 * Inside the chosen lane the job is the best by priority, then oldest. So one
 * office's ten-thousand-document reindex takes every worker while it is alone,
 * and the next office's request takes the next worker that frees up, whatever
 * the backlog ahead of it. The optional per-lane cap is hard: two claims racing
 * past it both commit, then each checks again under a per-lane advisory lock and
 * the later check gives its job back.
 *
 * The Python queues (`aiq_agent.common.claim_queue`) run the same algorithm over
 * their own tables, in their own database. Two implementations of one algorithm,
 * each held to the same scenarios by its own tests; a shared SQL function was
 * rejected because the Python side also runs on SQLite in tests.
 *
 * WHY THIS IS A CommonJS FILE AND NOT PART OF `src/lib`. The runner that claims
 * is a plain Node process with no build step (`workers/jobs/index.js`, the shape
 * of the purger and the scheduler), so it cannot import TypeScript. The BFF
 * reaches the same functions through `lib/jobs-queue/`, as it reaches
 * `workers/database-unavailable.js`. One copy of the SQL, not two that agree.
 *
 * EVERY FUNCTION RUNS UNDER THE PLATFORM ROLE (`workers/platform-scope.js`): the
 * queue spans organizations by nature. Without the step-up, row-level security
 * hides every row and the queue looks empty forever, which is the quietest way
 * a worker can break.
 *
 * A job lives and dies by four verbs, each a conditional UPDATE on
 * `claimed_by = worker`, so a worker that lost its claim (it stalled past the
 * stale window and another worker took the job) can neither finish nor release
 * what is no longer its own:
 *
 *   - `complete`   the job is done: the row is deleted.
 *   - `release`    give it back WITHOUT spending an attempt (a drain, a cap).
 *   - `fail`       the attempt went wrong: queued again AFTER A BACKOFF
 *                  (`not_before`, doubling per attempt), or `dead` when it was
 *                  the last one. A dead row keeps its reason in `last_error`.
 *   - `reapExhausted` claims whose worker vanished on their last attempt are
 *                  marked dead too, so a job is never silently dropped.
 *
 * A DEAD ROW IS A TRACE, NOT A COPY OF THE JOB. A payload holds what the job was
 * asked to do: a research report, the requester's email and permissions, storage
 * keys. Once the row is dead nothing will run it, so the payload is reduced to the
 * few identifiers a sweep still matches a job by (`KEPT_PAYLOAD_KEYS`) at the
 * moment it goes dead, exactly as the Python substrate blanks its own. The row
 * is then deleted after the retention (`purgeDead`), and with its project
 * (`eraseProject`, the purger's step) or its organization (`eraseLane`).
 */

const { withPlatformScope } = require('./platform-scope')

/** @typedef {import('postgres').Sql} Sql */
/** @typedef {import('../purger/types').Tx} Tx */

/**
 * @typedef {object} Claim
 * @property {string} jobId
 * @property {string} kind
 * @property {string} lane
 * @property {number} priority
 * @property {Record<string, unknown>} payload
 * @property {number} attempts attempts spent so far, this one included
 */

/**
 * @typedef {object} ClaimOptions
 * @property {number} staleSeconds a claim whose heartbeat is older than this is up for grabs again
 * @property {number} maxAttempts a job is claimed at most this many times
 * @property {number} [perLaneCap] most live claims one lane may hold; 0 or absent is no cap
 */

const QUEUED = 'queued'
const CLAIMED = 'claimed'
const DEAD = 'dead'

/**
 * What a dead row keeps of its payload: ids, never content. The sweeps find a
 * dead job by `runId` (a report's filing) and the document and project ids say
 * what it was for; everything else (the report text, the requester, storage
 * keys, file names) goes with the attempt that failed.
 */
const KEPT_PAYLOAD_KEYS = ['runId', 'projectId', 'documentId', 'taskRunId']

/** Wait before a failed job's second attempt; each further one doubles it. 0 retries at once. */
const DEFAULT_RETRY_BACKOFF_SECONDS = 30

/** The longest a job waits between attempts, however many it has had. */
const MAX_RETRY_BACKOFF_SECONDS = 900

/** Lanes ranked per claim: more than one, so a claim still succeeds while racing claimers hold the top lane's next job. */
const LANES_PER_CLAIM = 4

/** Stored text of a failure, so one runaway message cannot bloat the row. */
const MAX_ERROR_CHARS = 2000

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, MAX_ERROR_CHARS)
}

/**
 * The payload of a row going dead: its identifiers only. A fragment of the
 * UPDATE it sits in (it reads that row's `payload`).
 *
 * @param {Tx} tx
 */
function scrubbedPayload(tx) {
  return tx`(
    SELECT COALESCE(jsonb_object_agg(kept.key, kept.value), '{}'::jsonb)
    FROM jsonb_each(CASE WHEN jsonb_typeof(payload) = 'object' THEN payload ELSE '{}'::jsonb END) AS kept
    WHERE kept.key = ANY(${KEPT_PAYLOAD_KEYS}::text[])
  )`
}

/**
 * A job a worker may take now, on the alias `q`: queued and past its backoff,
 * or claimed by a worker that went silent with attempts left.
 *
 * @param {Tx} tx
 * @param {ClaimOptions} options
 */
function runnable(tx, options) {
  return tx`(
    (q.status = ${QUEUED} AND (q.not_before IS NULL OR q.not_before <= now()))
    OR (q.status = ${CLAIMED} AND q.attempts < ${options.maxAttempts}::int
        AND q.heartbeat_at < now() - make_interval(secs => ${options.staleSeconds}::float8))
  )`
}

/**
 * Store a claimable job. The row is the lane's: the caller states the lane
 * (the organization id) and the priority (`0` interactive, `1` bulk).
 *
 * @param {Sql} sql
 * @param {{ kind: string, lane: string, priority?: 0 | 1, payload?: Record<string, unknown> }} job
 * @returns {Promise<string>} the job id
 */
async function enqueue(sql, job) {
  const rows = await withPlatformScope(
    sql,
    (tx) => tx`
      INSERT INTO bff_job_queue (kind, lane, priority, payload)
      VALUES (${job.kind}, ${job.lane}, ${job.priority ?? 0}, ${JSON.stringify(job.payload ?? {})}::text::jsonb)
      RETURNING job_id
    `,
  )
  return String(rows[0].job_id)
}

/**
 * Two steps, so a claim never sorts the whole backlog: rank the LANES (one row
 * per organization with work), then take the best runnable job of the best few
 * through the `(lane, priority, created_at)` index.
 *
 * @param {Tx} tx
 * @param {string} worker
 * @param {ClaimOptions} options
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
async function claimStatement(tx, worker, options) {
  const stale = options.staleSeconds
  const cap = Math.max(0, options.perLaneCap ?? 0)
  const rows = await tx`
    WITH running AS (
      SELECT lane, COUNT(*) AS n FROM bff_job_queue
      WHERE status = ${CLAIMED} AND heartbeat_at >= now() - make_interval(secs => ${stale}::float8)
      GROUP BY lane
    ),
    lanes AS (
      SELECT w.lane, COALESCE(r.n, 0) AS n, t.last_claimed_at, w.best, w.oldest
      FROM (
        SELECT q.lane, MIN(q.priority) AS best, MIN(q.created_at) AS oldest
        FROM bff_job_queue q
        WHERE ${runnable(tx, options)}
        GROUP BY q.lane
      ) w
      LEFT JOIN running r ON r.lane = w.lane
      LEFT JOIN bff_job_lane_turns t ON t.lane = w.lane
      WHERE (${cap}::int = 0 OR COALESCE(r.n, 0) < ${cap}::int)
      ORDER BY COALESCE(r.n, 0), t.last_claimed_at NULLS FIRST, w.best, w.oldest
      LIMIT ${LANES_PER_CLAIM}
    ),
    candidate AS (
      SELECT pick.job_id FROM lanes
      CROSS JOIN LATERAL (
        SELECT q.job_id FROM bff_job_queue q
        WHERE q.lane = lanes.lane AND ${runnable(tx, options)}
        ORDER BY q.priority, q.created_at, q.job_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ) pick
      ORDER BY lanes.n, lanes.last_claimed_at NULLS FIRST, lanes.best, lanes.oldest
      LIMIT 1
    ),
    claimed AS (
      UPDATE bff_job_queue q
      SET status = ${CLAIMED}, claimed_by = ${worker}, claimed_at = now(), heartbeat_at = now(),
          not_before = NULL, attempts = q.attempts + 1
      FROM candidate WHERE q.job_id = candidate.job_id
      RETURNING q.job_id, q.kind, q.lane, q.priority, q.payload, q.attempts
    ),
    turn AS (
      INSERT INTO bff_job_lane_turns (lane, last_claimed_at)
      SELECT lane, now() FROM claimed
      ON CONFLICT (lane) DO UPDATE SET last_claimed_at = EXCLUDED.last_claimed_at
    )
    SELECT job_id, kind, lane, priority, payload, attempts FROM claimed
  `
  return rows[0]
}

/**
 * Put a claim back when its lane already holds `cap` other live claims; whether
 * it did.
 *
 * The claim query skips a lane at its cap, but two claims committing at once
 * each saw the lane one under it. So every claim, once committed, checks again
 * under a per-lane advisory lock, counting EVERY other live claim of the lane.
 * The checks run one at a time and each claim commits before its own check, so
 * the last check of a race sees all the others and the lane ends at most at its
 * cap. A claim given back costs no attempt: the next free worker takes it.
 *
 * @param {Sql} sql
 * @param {string} worker
 * @param {Claim} claim
 * @param {ClaimOptions} options
 * @returns {Promise<boolean>}
 */
async function releaseOverCap(sql, worker, claim, options) {
  const cap = options.perLaneCap ?? 0
  return withPlatformScope(sql, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`bff-cap:${claim.lane}`}))`
    const others = await tx`
      SELECT COUNT(*)::int AS n FROM bff_job_queue
      WHERE lane = ${claim.lane} AND status = ${CLAIMED} AND job_id <> ${claim.jobId}::uuid
        AND heartbeat_at >= now() - make_interval(secs => ${options.staleSeconds}::float8)
    `
    if (Number(others[0].n) < cap) return false
    await tx`
      UPDATE bff_job_queue
      SET status = ${QUEUED}, claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
          not_before = NULL, attempts = GREATEST(attempts - 1, 0)
      WHERE job_id = ${claim.jobId}::uuid AND claimed_by = ${worker}
    `
    return true
  })
}

/**
 * Claim the fairest runnable job (see the file comment), or null.
 *
 * @param {Sql} sql
 * @param {string} worker who is claiming: the heartbeat and every later verb are conditional on it
 * @param {ClaimOptions} options
 * @returns {Promise<Claim | null>}
 */
async function claimNext(sql, worker, options) {
  const row = await withPlatformScope(sql, (tx) => claimStatement(tx, worker, options))
  if (!row) return null
  const claim = {
    jobId: String(row.job_id),
    kind: String(row.kind),
    lane: String(row.lane),
    priority: Number(row.priority),
    payload: /** @type {Record<string, unknown>} */ (row.payload ?? {}),
    attempts: Number(row.attempts),
  }
  if ((options.perLaneCap ?? 0) > 0 && (await releaseOverCap(sql, worker, claim, options))) return null
  return claim
}

/**
 * Refresh a claim; false when it is not this worker's any more.
 *
 * @param {Sql} sql
 * @param {string} jobId
 * @param {string} worker
 * @returns {Promise<boolean>}
 */
async function heartbeat(sql, jobId, worker) {
  const rows = await withPlatformScope(
    sql,
    (tx) => tx`
      UPDATE bff_job_queue SET heartbeat_at = now()
      WHERE job_id = ${jobId}::uuid AND claimed_by = ${worker} AND status = ${CLAIMED}
      RETURNING job_id
    `,
  )
  return rows.length > 0
}

/**
 * Record a job's progress. The payload is the job's own resumable state (a
 * cursor, the counts so far), and writing it is also a heartbeat, so a job that
 * keeps making progress is never reclaimed from under itself. False when the
 * claim is not this worker's any more: the caller must stop, because the new
 * owner resumes from what was stored last.
 *
 * @param {Sql} sql
 * @param {string} jobId
 * @param {string} worker
 * @param {Record<string, unknown>} payload
 * @returns {Promise<boolean>}
 */
async function saveProgress(sql, jobId, worker, payload) {
  const rows = await withPlatformScope(
    sql,
    (tx) => tx`
      UPDATE bff_job_queue SET payload = ${JSON.stringify(payload)}::text::jsonb, heartbeat_at = now()
      WHERE job_id = ${jobId}::uuid AND claimed_by = ${worker} AND status = ${CLAIMED}
      RETURNING job_id
    `,
  )
  return rows.length > 0
}

/**
 * Forget a finished job. Only while the claim is still this worker's.
 *
 * @param {Sql} sql
 * @param {string} jobId
 * @param {string} worker
 * @returns {Promise<boolean>}
 */
async function complete(sql, jobId, worker) {
  const rows = await withPlatformScope(
    sql,
    (tx) => tx`
      DELETE FROM bff_job_queue
      WHERE job_id = ${jobId}::uuid AND claimed_by = ${worker} AND status = ${CLAIMED}
      RETURNING job_id
    `,
  )
  return rows.length > 0
}

/**
 * Give a claim back WITHOUT spending an attempt: the worker is draining, or the
 * claim was over its lane's cap. The job keeps the progress it saved, so the
 * next worker resumes where this one stopped. False when it was not this
 * worker's.
 *
 * @param {Sql} sql
 * @param {string} jobId
 * @param {string} worker
 * @returns {Promise<boolean>}
 */
async function release(sql, jobId, worker) {
  const rows = await withPlatformScope(
    sql,
    (tx) => tx`
      UPDATE bff_job_queue
      SET status = ${QUEUED}, claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
          not_before = NULL, attempts = GREATEST(attempts - 1, 0)
      WHERE job_id = ${jobId}::uuid AND claimed_by = ${worker} AND status = ${CLAIMED}
      RETURNING job_id
    `,
  )
  return rows.length > 0
}

/**
 * The attempt went wrong. The job is queued again while it has attempts left,
 * not before `retryBackoffSeconds` (doubling with each attempt, at most
 * {@link MAX_RETRY_BACKOFF_SECONDS}): three attempts in the same few seconds
 * would only test whether the cause was a blip, and a dependency that is down
 * for a minute would take every job's attempts with it. It goes `dead` on its
 * last attempt, its payload reduced to ids, with the reason kept in
 * `last_error` either way. Null when the claim was not this worker's.
 *
 * @param {Sql} sql
 * @param {string} jobId
 * @param {string} worker
 * @param {unknown} error
 * @param {number} maxAttempts
 * @param {number} [retryBackoffSeconds]
 * @returns {Promise<'queued' | 'dead' | null>}
 */
async function fail(sql, jobId, worker, error, maxAttempts, retryBackoffSeconds = DEFAULT_RETRY_BACKOFF_SECONDS) {
  const base = Math.max(0, retryBackoffSeconds)
  const rows = await withPlatformScope(
    sql,
    (tx) => tx`
      UPDATE bff_job_queue
      SET status = CASE WHEN attempts >= ${maxAttempts}::int THEN ${DEAD} ELSE ${QUEUED} END,
          dead_at = CASE WHEN attempts >= ${maxAttempts}::int THEN now() END,
          payload = CASE WHEN attempts >= ${maxAttempts}::int THEN ${scrubbedPayload(tx)} ELSE payload END,
          not_before = CASE WHEN attempts >= ${maxAttempts}::int THEN NULL ELSE
            now() + make_interval(secs => LEAST(${base}::float8 * power(2, GREATEST(attempts - 1, 0)), ${MAX_RETRY_BACKOFF_SECONDS}::float8))
          END,
          claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
          last_error = ${describeError(error)}
      WHERE job_id = ${jobId}::uuid AND claimed_by = ${worker} AND status = ${CLAIMED}
      RETURNING status
    `,
  )
  return rows.length === 0 ? null : /** @type {'queued' | 'dead'} */ (String(rows[0].status))
}

/**
 * Mark `dead` the claims whose worker vanished on their last attempt: nothing
 * will claim them again (`attempts` is spent), and a row nobody can see is how
 * work gets lost without a trace. One statement, safe from any number of
 * runners at once: a second one waits on the row lock, re-reads the row as dead
 * and skips it.
 *
 * @param {Sql} sql
 * @param {{ staleSeconds: number, maxAttempts: number }} options
 * @returns {Promise<string[]>} the ids marked dead
 */
async function reapExhausted(sql, options) {
  const rows = await withPlatformScope(
    sql,
    (tx) => tx`
      UPDATE bff_job_queue
      SET status = ${DEAD}, dead_at = now(), payload = ${scrubbedPayload(tx)},
          claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
          last_error = COALESCE(last_error || ' | ', '') ||
            ${`worker lost on its last attempt (${options.maxAttempts} claims)`}
      WHERE status = ${CLAIMED} AND attempts >= ${options.maxAttempts}::int
        AND heartbeat_at < now() - make_interval(secs => ${options.staleSeconds}::float8)
      RETURNING job_id
    `,
  )
  return rows.map((row) => String(row.job_id))
}

/**
 * Delete the dead rows older than the retention: a dead row is the trace of a
 * failure, kept long enough for an operator to see it, not a record.
 *
 * @param {Sql} sql
 * @param {{ olderThanSeconds: number }} options
 * @returns {Promise<number>} how many rows were deleted
 */
async function purgeDead(sql, options) {
  const rows = await withPlatformScope(
    sql,
    (tx) => tx`
      DELETE FROM bff_job_queue
      WHERE status = ${DEAD} AND dead_at < now() - make_interval(secs => ${options.olderThanSeconds}::float8)
      RETURNING job_id
    `,
  )
  return rows.length
}

/**
 * Erase every job of one project, whatever its state: the project is being
 * purged, and its jobs' payloads hold its reports, file names and storage keys.
 * Runs in the caller's transaction (the purger's, already under the platform
 * role), so it commits or rolls back with the rest of the purge. A claimed row
 * is deleted too: its worker's next heartbeat finds the claim gone and stops.
 *
 * @param {Tx} tx
 * @param {string} lane the organization id
 * @param {string} projectId
 * @returns {Promise<number>} how many rows were deleted
 */
async function eraseProject(tx, lane, projectId) {
  const rows = await tx`
    DELETE FROM bff_job_queue WHERE lane = ${lane} AND payload ->> 'projectId' = ${projectId} RETURNING job_id
  `
  return rows.length
}

/**
 * Erase every job of one organization, and its place in the fairness rotation.
 * What an organization purge calls (none exists yet; see `purger/index.js`).
 *
 * @param {Tx} tx
 * @param {string} lane the organization id
 * @returns {Promise<number>} how many jobs were deleted
 */
async function eraseLane(tx, lane) {
  const rows = await tx`DELETE FROM bff_job_queue WHERE lane = ${lane} RETURNING job_id`
  await tx`DELETE FROM bff_job_lane_turns WHERE lane = ${lane}`
  return rows.length
}

/**
 * Jobs a worker could still run or is running: what the pool scales on. Dead
 * rows are not work.
 *
 * @param {Sql} sql
 * @returns {Promise<number>}
 */
async function depth(sql) {
  const rows = await withPlatformScope(
    sql,
    (tx) => tx`SELECT COUNT(*)::int AS n FROM bff_job_queue WHERE status <> ${DEAD}`,
  )
  return Number(rows[0].n)
}

module.exports = {
  CLAIMED,
  DEAD,
  DEFAULT_RETRY_BACKOFF_SECONDS,
  KEPT_PAYLOAD_KEYS,
  MAX_RETRY_BACKOFF_SECONDS,
  QUEUED,
  claimNext,
  complete,
  depth,
  describeError,
  enqueue,
  eraseLane,
  eraseProject,
  fail,
  heartbeat,
  purgeDead,
  reapExhausted,
  release,
  saveProgress,
}
