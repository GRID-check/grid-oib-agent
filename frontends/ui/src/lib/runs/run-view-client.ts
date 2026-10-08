import { z } from 'zod'
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
import type { PlanDocument, PlanDocuments } from './plan-documents'

/** How a request is made — injected so a spec can hand in a fake. */
export type RunViewFetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * A request the API refused, with the status the caller decides on, and the
 * API's own `code` when the body named one. When it did, `message` is the
 * API's sentence, already in the reader's language (a 403
 * `CONVERSATION_CONFINED` is written to be shown as it is).
 */
export class RunViewError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null
  ) {
    super(message)
    this.name = 'RunViewError'
  }
}

/** The API's error envelope (`lib/api/handler.ts` `errorResponse`): `{ error, code }`. */
const apiRefusalSchema = z.object({ error: z.string().min(1), code: z.string().min(1) })

/** The refusal as the API worded it, or the generic one when the body says nothing usable. */
async function refusalOf(response: Response): Promise<RunViewError> {
  const fallback = `Run view request failed with ${response.status}`
  const body: unknown = await response.json().catch(() => null)
  const parsed = apiRefusalSchema.safeParse(body)
  return parsed.success
    ? new RunViewError(response.status, parsed.data.error, parsed.data.code)
    : new RunViewError(response.status, fallback)
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
  run: RunViewFetch = (input, init) => fetch(input, init)
): Promise<RunView> {
  return requestRunView(run, runViewPath(projectId, runId), 'GET')
}

export function runCancelPath(projectId: string, runId: string): string {
  return `${runViewPath(projectId, runId)}/cancel`
}

export function runsPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/runs`
}

export const commissionedRunSchema = z
  .object({
    runId: z.string().min(1),
    runMessageId: z.string().nullable(),
    conversationId: z.string(),
    status: z.string(),
  })
  .strict()
export type CommissionedRun = z.infer<typeof commissionedRunSchema>

/**
 * Commission a research run from the thread: an open finding to clear, or a
 * report to carry forward. The run's message is minted server-side in the
 * conversation; the caller re-reads the thread to show it.
 */
export async function commissionRun(
  projectId: string,
  input: { conversationId: string; question: string; context?: string; documents?: PlanDocuments },
  run: RunViewFetch = (i, init) => fetch(i, init)
): Promise<CommissionedRun> {
  const response = await run(runsPath(projectId), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new RunViewError(response.status, 'The run could not be commissioned')
  return commissionedRunSchema.parse(await response.json())
}

export function runDocumentsPath(projectId: string, runId: string): string {
  return `${runViewPath(projectId, runId)}/documents`
}

/**
 * Add a document to a running run's Grundlage. Same errors as the cancel, and
 * the API's code and sentence on the error when it gave them: a document from
 * a restricted folder is a 403 `CONVERSATION_CONFINED` the block shows as is.
 *
 * Only the plan document's own fields are sent. A caller holds richer rows (the
 * picker's inventory carries the file row it opens from) and the route's
 * schema is strict, so a whole row is refused as a bad request.
 */
export async function addRunDocument(
  projectId: string,
  runId: string,
  document: PlanDocument,
  run: RunViewFetch = (input, init) => fetch(input, init)
): Promise<RunView> {
  const { name, title, shelf } = document
  const response = await run(runDocumentsPath(projectId, runId), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ name, title, shelf }),
  })
  if (!response.ok) throw await refusalOf(response)
  return runViewSchema.parse(await response.json())
}

export function runWriteNowPath(projectId: string, runId: string): string {
  return `${runViewPath(projectId, runId)}/write-now`
}

/** „Jetzt schreiben": same errors as the cancel; the view it answers is the run before the request took. */
export async function writeNowRun(
  projectId: string,
  runId: string,
  run: RunViewFetch = (input, init) => fetch(input, init)
): Promise<RunView> {
  return requestRunView(run, runWriteNowPath(projectId, runId), 'POST')
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
  run: RunViewFetch = (input, init) => fetch(input, init)
): Promise<RunView> {
  return requestRunView(run, runCancelPath(projectId, runId), 'POST')
}

async function requestRunView(
  run: RunViewFetch,
  path: string,
  method: 'GET' | 'POST'
): Promise<RunView> {
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
