/**
 * The browser's typed client for one run: `GET /api/projects/[id]/runs/[runId]`
 * (ADR-0055).
 *
 * The session-scoped read door of the run primitive, beside
 * `./run-ledger-client` which is the internal WRITE door. The block in the
 * thread calls this once when it mounts on a live run, for two things the
 * stored message cannot tell it: the backend job id its event stream hangs off,
 * and a ledger that may be newer than the one the message was loaded with.
 *
 * Parsed with `runViewSchema`, never cast, for the reason the ledger client
 * gives: a cast makes the compiler agree with an assumption, a parse makes the
 * runtime disagree with a wrong one.
 *
 * No `server-only`: the caller is a React hook.
 */

import { runViewSchema, type RunView } from './run-ledger-types'

/** How a request is made — injected so a spec can hand in a fake. */
export type RunViewFetch = (input: string, init?: RequestInit) => Promise<Response>

/** A request the API refused, with the status the caller decides on. */
export class RunViewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'RunViewError'
  }
}

export function runViewPath(projectId: string, runId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`
}

/**
 * One run, as the session may read it. Throws `RunViewError` on a refused
 * request and a zod error on a body this build does not recognise; the hook
 * that calls it treats both the same way — keep what is already shown.
 */
export async function fetchRunView(
  projectId: string,
  runId: string,
  run: RunViewFetch = (input, init) => fetch(input, init),
): Promise<RunView> {
  const response = await run(runViewPath(projectId, runId), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new RunViewError(response.status, `Run view request failed with ${response.status}`)
  }
  const payload: unknown = await response.json()
  return runViewSchema.parse(payload)
}
