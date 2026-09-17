/**
 * The typed client for the run-ledger API (ADR-0055).
 *
 * ## Why a client module and not `fetch` at each call site
 *
 * ADR-0055 says every workspace primitive is an HTTP route with a typed client,
 * and that every consumer is an equal client of it. A client is what makes
 * „equal" mean something: the path, the verb and the two op shapes are written
 * once, so the fold that flushes a ledger and the spec that exercises the route
 * cannot quietly disagree about what `append` sends — and the route's own spec
 * drives the REAL handler through these functions, so the contract is exercised
 * rather than described.
 *
 * Responses are PARSED with the zod schemas from `./run-ledger-types`, never
 * cast. A cast makes the compiler agree with an assumption; a parse makes the
 * runtime disagree with a wrong one, which is what a client is for when the
 * server it talks to may be a deploy ahead.
 *
 * ## Why there is no default browser instance
 *
 * The route is `internalApiRoute`: it is guarded by `GRID_INTERNAL_API_TOKEN`
 * and no browser holds one. So the transport is always INJECTED — a spec hands
 * in a function that calls the handler, a service hands in one that adds the
 * token — and exporting a `fetch`-backed singleton here would be exporting a
 * call that can only ever 401. What the browser reads is
 * `GET /api/projects/[id]/runs/[runId]`, which is a session route.
 */

import {
  runLedgerResponseSchema,
  type RunLedgerResponse,
  type RunPhaseEntry,
  type RunResult,
  type RunStatus,
  type RunStep,
} from './run-ledger-types'

/**
 * How a request is made. Injected rather than closed over, so a route spec can
 * hand in a function that calls the real handler and a caller in the BFF can
 * hand in one that carries the internal token.
 */
export type RunLedgerFetch = (path: string, init?: RequestInit) => Promise<Response>

/**
 * A request the API refused, carrying the status and the body's own code.
 *
 * A typed error rather than a thrown `Response`, because every caller needs the
 * same three facts — what happened, what the server called it, and whether it is
 * worth retrying. A ledger flush must never fail a run, and a caller can only
 * decide that if the refusal is legible.
 */
export class RunLedgerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'RunLedgerError'
  }
}

/** What an `append` op may carry. Every field is optional; all of them are bounded. */
export interface RunLedgerAppend {
  steps?: readonly RunStep[]
  phases?: readonly RunPhaseEntry[]
  status?: RunStatus
}

/** What a `finish` op may carry: exactly one of the two. */
export type RunLedgerOutcome = { result: RunResult } | { error: { reason: string } }

export interface RunLedgerClient {
  append(runId: string, patch: RunLedgerAppend): Promise<RunLedgerResponse>
  finish(runId: string, outcome: RunLedgerOutcome): Promise<RunLedgerResponse>
}

async function request(
  run: RunLedgerFetch,
  runId: string,
  body: Record<string, unknown>,
): Promise<RunLedgerResponse> {
  const response = await run(`/api/internal/runs/${encodeURIComponent(runId)}/ledger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = (payload ?? {}) as { error?: string; code?: string; details?: unknown }
    throw new RunLedgerError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.error ?? `Request failed with ${response.status}`,
      error.details,
    )
  }
  return runLedgerResponseSchema.parse(payload)
}

/** The two ops, as functions. One path, spelled once. */
export function createRunLedgerClient(run: RunLedgerFetch): RunLedgerClient {
  return {
    append: (runId, patch) =>
      // Absent rather than empty: the request schema is `.strict()` and an
      // omitted list is the same statement as an empty one, so the wire stays
      // as small as what actually happened.
      request(run, runId, {
        op: 'append',
        ...(patch.steps ? { steps: [...patch.steps] } : {}),
        ...(patch.phases ? { phases: [...patch.phases] } : {}),
        ...(patch.status ? { status: patch.status } : {}),
      }),

    finish: (runId, outcome) => request(run, runId, { op: 'finish', ...outcome }),
  }
}
