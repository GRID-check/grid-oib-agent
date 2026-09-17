/**
 * The browser's typed client for one run: `GET /api/projects/[id]/runs/[runId]`
 * and `POST …/cancel` (ADR-0055).
 *
 * The session-scoped doors of the run primitive, beside `./run-ledger-client`
 * which is the internal WRITE door. The block in the thread reads once when it
 * mounts on a live run, for two things the stored message cannot tell it: the
 * backend job id its event stream hangs off, and a ledger that may be newer
 * than the one the message was loaded with. It cancels when the person asks,
 * and then waits for the stream to say `abgebrochen` — the cancel answers the
 * view as it stands, never a ledger it invented.
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
  return requestRunView(run, runViewPath(projectId, runId), 'GET')
}

export function runCancelPath(projectId: string, runId: string): string {
  return `${runViewPath(projectId, runId)}/cancel`
}

/**
 * Ask for one run to be stopped. Same errors as the read: `RunViewError` with
 * the status — 404 for a run the session cannot see, 409 for one that has
 * already ended or never reached the worker — and a zod error on a strange
 * body. The view it answers is the run BEFORE the cancel took; the ledger
 * turns `abgebrochen` on the stream.
 */
export async function cancelRun(
  projectId: string,
  runId: string,
  run: RunViewFetch = (input, init) => fetch(input, init),
): Promise<RunView> {
  return requestRunView(run, runCancelPath(projectId, runId), 'POST')
}

async function requestRunView(run: RunViewFetch, path: string, method: 'GET' | 'POST'): Promise<RunView> {
  const response = await run(path, {
    method,
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new RunViewError(response.status, `Run view request failed with ${response.status}`)
  }
  const payload: unknown = await response.json()
  return runViewSchema.parse(payload)
}
