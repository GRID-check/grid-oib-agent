/**
 * Work that saves a settled turn, run after the frame that shows it.
 *
 * The frame an answer settles in is the most expensive the chat draws: the
 * whole answer re-renders with its cards, its citations and its footer. Its
 * saving used to run in the same task, ahead of that render: the browser copy
 * of the history (a prune, a `JSON.stringify` and a `localStorage.setItem` of
 * every changed conversation), the server copy of the message and of its
 * provenance, and the conversation's name. A 1 s task at the end of a
 * recorded production turn. None of it is anything the reader sees.
 *
 * So it is queued, and run as a background task once the browser is free
 * (`scheduler.postTask`, else a `setTimeout(0)`). Nothing queued may be lost:
 * the queue is run at once when the page is hidden or left (`pagehide`,
 * `visibilitychange`), which is the last moment a page is guaranteed to run,
 * and by anything about to change what a job reads (a switch of conversation,
 * `flushDeferredPersistence`).
 */

type Job = () => void

interface BackgroundScheduler {
  postTask: (task: () => void, options: { priority: 'background' }) => Promise<unknown>
}

const queue: Job[] = []
let scheduled = false
let listening = false

const backgroundScheduler = (): BackgroundScheduler | null => {
  const candidate = (globalThis as { scheduler?: Partial<BackgroundScheduler> }).scheduler
  return typeof candidate?.postTask === 'function' ? (candidate as BackgroundScheduler) : null
}

/** Run every queued job now, in the order they were queued. */
export function flushDeferredPersistence(): void {
  scheduled = false
  while (queue.length > 0) {
    const job = queue.shift()
    try {
      job?.()
    } catch (error) {
      // One mirror failing must not keep the others, or the browser copy, from running.
      console.warn('[deferred-persistence] a queued save failed', error)
    }
  }
}

const listen = (): void => {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('pagehide', flushDeferredPersistence)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDeferredPersistence()
  })
}

/** Queue `job` to run after the current frame, or when the page is hidden, whichever is first. */
export function deferPersistence(job: Job): void {
  queue.push(job)
  listen()
  if (scheduled) return
  scheduled = true
  const scheduler = backgroundScheduler()
  if (scheduler) {
    scheduler
      .postTask(flushDeferredPersistence, { priority: 'background' })
      .catch(flushDeferredPersistence)
    return
  }
  setTimeout(flushDeferredPersistence, 0)
}
