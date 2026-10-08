/**
 * Bounded-concurrency runner for a batch of uploads.
 *
 * Sending one file at a time would start file two only after file one had
 * crossed the wire, been written to object storage, been admitted against the
 * org quota and been dispatched to the ingest API. A twelve-document Einreichung
 * would take twelve round trips end to end, on a link that was idle for most of
 * each one, and the last file in the list would show no sign of life until the
 * eleven before it had finished.
 *
 * Running several at once fixes both: wall-clock time collapses toward the
 * slowest file rather than the sum of all of them, and every file in the batch
 * is visibly either moving or queued from the first second.
 */

/**
 * How many uploads may be in flight at once.
 *
 * Browsers allow six connections per host, and this shares that budget with the
 * job-status polling and the ordinary page traffic behind it. Three leaves room
 * for those, and beyond three the per-file rate just divides — a single upload
 * already saturates a typical office uplink, so more parallelism would buy
 * nothing but a slower-moving bar on every row at once.
 */
export const UPLOAD_CONCURRENCY = 3

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the results.
 *
 * Never rejects: each item's outcome is reported as a settled result, because a
 * batch upload has to keep going when one file is refused — the other eleven
 * are still wanted, and the failure belongs on that file's row, not on the
 * whole batch.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let cursor = 0

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const runners = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: runners }, runner))
  return results
}

/** How many times one file waits out a rate-limit refusal before it is marked failed. */
export const RATE_LIMIT_RETRIES = 3

/**
 * `send`, waiting out a 429 with the server's own `Retry-After` instead of
 * failing the file.
 *
 * A folder bigger than the upload budget would lose every file past the limit,
 * and "Retry all" would then fire them all at once into the same refusal. So a
 * refused file waits its turn and goes again, a bounded number of times, and a
 * big batch slows down rather than breaks. Any other failure, and an abort
 * during the wait, is rethrown as it came.
 */
export async function sendWaitingOutRateLimit<T>(
  send: () => Promise<T>,
  retryAfterOf: (error: unknown) => number | null,
  signal?: AbortSignal
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send()
    } catch (error) {
      const wait = retryAfterOf(error)
      if (wait === null || attempt >= RATE_LIMIT_RETRIES) throw error
      await abortableDelay(wait * 1000, signal)
    }
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Upload aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Upload aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
