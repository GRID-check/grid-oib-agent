/**
 * Why a re-ingest was refused, as the `details.code` of its 409.
 *
 * The client keys its copy on these: "already running" and "already finished"
 * are not failures to retry, and a generic "please try again" for either sent
 * the reader into a loop of clicks that could only ever answer 409 again.
 * No imports, so the client hook can read them without pulling in the service.
 */

/** The backend still has a job (or a file mid-flight) for this document. */
export const INGEST_RUNNING = 'INGEST_RUNNING'

/**
 * The backend had already finished it; the row was stale and has just been
 * healed to `completed`. The document is citable, there is nothing to retry.
 */
export const INGEST_ALREADY_DONE = 'INGEST_ALREADY_DONE'

/** The row is in a state re-ingest does not apply to (e.g. an agent's `stored` report). */
export const INGEST_NOT_ELIGIBLE = 'INGEST_NOT_ELIGIBLE'

export type ReingestRefusalCode =
  | typeof INGEST_RUNNING
  | typeof INGEST_ALREADY_DONE
  | typeof INGEST_NOT_ELIGIBLE
