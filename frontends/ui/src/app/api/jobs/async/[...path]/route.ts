/**
 * Deep Research API Route Proxy
 *
 * Proxies requests to the deep research async jobs API.
 * This avoids CORS issues by keeping browser requests on the same origin.
 *
 * Authentication handling:
 * - When REQUIRE_AUTH=true: Forwards idToken cookie to backend for backend authentication
 * - When REQUIRE_AUTH=false: Skips all auth info to ensure anonymous requests
 *
 * Session/bearer resolution (incl. the `?token=` fallback for EventSource
 * streams) is shared with the v1 proxy via `@/lib/proxy/proxy-request`.
 *
 * Handles:
 * - GET /api/jobs/async/agents - List available agents
 * - POST /api/jobs/async/submit - Submit a new job
 * - GET /api/jobs/async/job/{job_id} - Get job status
 * - GET /api/jobs/async/job/{job_id}/stream - SSE stream (primary use case)
 * - GET /api/jobs/async/job/{job_id}/stream/{last_event_id} - SSE reconnection
 * - POST /api/jobs/async/job/{job_id}/cancel - Cancel job
 * - DELETE /api/jobs/async/job/{job_id}/cancel - Cancel job
 * - GET /api/jobs/async/job/{job_id}/state - Get job artifacts
 * - GET /api/jobs/async/job/{job_id}/report - Get final report
 *
 * The report GET is also where a commissioned run's completion is OBSERVED on
 * the BFF, and therefore where the report stops being a chat message that dies
 * with the run's file system and becomes a `documents` row the project can
 * find, assign, preview and delete (`fileReportIfCommissioned` below).
 *
 * @see docs/api/bff-routes.md - Deep Research / Async Jobs, incl. the additive
 *      `filed` object this route adds to the report response
 */

import { NextResponse } from 'next/server'
import { tenantSlotRoute } from '@/lib/db/tenant-context'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import type { ScopedCollection } from '@/lib/collection-scope'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { isAuthzError } from '@/lib/auth-utils'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { loadProjectBundesland } from '@/lib/project-profile/prompt-view'
import {
  buildGridRequestContextWireHeaders,
  type GridRequestContextInput,
} from '@/lib/request-context'
import {
  buildAuthHeaders,
  backendErrorEnvelope,
  noResponseBodyEnvelope,
  handleAuthzError,
  proxyErrorEnvelope,
  sseStreamResponse,
} from '@/lib/backend-proxy'
import { parseBodyContext, parseQueryContext } from '@/lib/proxy/collection-authz'
import { buildProxyUrl, resolveSessionAndBearer } from '@/lib/proxy/proxy-request'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import { fileResearchReport } from '@/lib/documents/research-report'
import { findProjectIdByCollectionName } from '@/lib/projects/repository'

/**
 * Per-org runtime model overrides ({agentGroup: openrouterModelId}) plus the
 * signed context envelope (backlog T3-9 follow-up, 2026-07-16, user-mandated)
 * for the async-submit proxy — same header/encoding server.js forwards on
 * the WebSocket upgrade (x-grid-model-overrides, base64url JSON), decoded by
 * the backend (model_overrides.py). Without the overrides header, submit
 * falls through to the WS-only override path and jobs silently run on
 * YAML-default models even when the org has configured overrides; without
 * the envelope, the backend's enforcement middleware rejects the submit
 * outright for an authenticated caller (REQUIRE_AUTH=true).
 *
 * Routed through the shared `GridRequestContext` builder
 * (`@/lib/request-context`, backlog T3-9) so this path's headers can never
 * drift from every other producer/consumer. Always returns at least the
 * envelope headers (never just `{}`) so the caller can unconditionally
 * spread the result into the fetch headers.
 *
 * The model-overrides lookup is best-effort: a failure must not block job
 * submission — the rest of the context (org/user/project/scope, still
 * enough to satisfy the envelope requirement) is still sent, matching the
 * fail-open contract of every other override consumer.
 */
async function resolveGridContextHeaders(
  session: GridSession | null,
  extra: { projectId?: string; collectionScope?: ReadonlyArray<string | ScopedCollection> }
): Promise<Record<string, string>> {
  const input: GridRequestContextInput = {
    organizationId: session?.organizationId ?? null,
    userId: session?.userId ?? null,
    projectId: extra.projectId ?? null,
    collectionScope: extra.collectionScope ?? null,
  }

  if (session?.organizationId) {
    try {
      const overrides = await getEffectiveModelOverrides(session.organizationId)
      if (overrides) {
        input.modelOverrides = overrides
      }
    } catch (error) {
      console.warn('[Deep Research API] Failed to load model overrides:', error)
    }
  }

  if (extra.projectId) {
    // Structured jurisdiction fact (backlog T3-9 follow-up, 2026-07-16,
    // user-mandated) — rides the envelope's `bundesland` field. Best-effort:
    // a lookup failure must not block job submission; the backend falls back
    // to prompt-text parsing of `project_context` (unaffected either way).
    try {
      const bundesland = await loadProjectBundesland(extra.projectId, session?.organizationId)
      if (bundesland) {
        input.bundesland = bundesland
      }
    } catch (error) {
      console.warn('[Deep Research API] Failed to load bundesland fact:', error)
    }
  }

  return buildGridRequestContextWireHeaders(input, process.env.GRID_INTERNAL_API_TOKEN)
}

const LOG_LABEL = 'Deep Research API'

/**
 * Per-request proxy tracing. Dev-only: these fire on every deep-research
 * request (including each SSE reconnect), so at production volume they are
 * pure noise in the service log while telling an operator nothing an error
 * path does not already report.
 */
const traceRequest = (...args: unknown[]): void => {
  if (process.env.NODE_ENV !== 'development') return
  console.debug(`[${LOG_LABEL}]`, ...args)
}
const JOBS_BASE_PATH = '/v1/jobs/async'

/**
 * What the client is told about the filing, alongside the report itself.
 *
 * Additive: every field the report response already had is untouched, so a
 * client that has never heard of filing keeps working. `documentId` is what the
 * toast's *Öffnen* and *Zuweisen* actions need; `alreadyFiled` distinguishes
 * "this run just produced a document" from "this is the fourth time the tab was
 * opened", which is the difference between showing that toast and not.
 */
interface ReportFilingResult {
  documentId: string
  filename: string
  alreadyFiled: boolean
}

/**
 * What happened to the filing, when something happened at all.
 *
 * ## Why a failure is reported and not just swallowed
 *
 * Filing stays best-effort — the answer is never the filing's to lose, and the
 * `catch` below still swallows the error. What changed is that swallowing it
 * SILENTLY is a broken promise: before the run starts, the banner prints
 * „Der fertige Bericht wird in diesem Projekt unter ‚Berichte' abgelegt."
 * (`deepResearch.starting.filingDisclosure`). A reader who was told that, and
 * is then shown a plain success, goes to Berichte and finds nothing — with
 * nothing anywhere to tell them why, because the only record is a server log
 * they cannot read.
 *
 * `null` used to mean four different things: not a report request, no project
 * to file into, no report yet, and "we tried and it did not work". The first
 * three are states in which no promise was made. Only the fourth is a promise
 * broken, and it is the only one worth a word to the reader.
 *
 * ## Why the reason does not travel
 *
 * A quota refusal, a revoked permission and an object store that is down are
 * one fact to this reader: the document is not there. The differences between
 * them are actionable by an administrator, not by the architect reading a
 * report, and the messages that carry them name buckets, permissions and
 * limits. Those belong in the log, which already has them. A boolean is the
 * whole of what the surface can honestly act on.
 */
type ReportFilingOutcome = { status: 'filed'; filed: ReportFilingResult } | { status: 'failed' }

/** The report endpoint's body, as `JobReportResponse` on the backend defines it. */
function readReportMarkdown(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const body = data as { has_report?: unknown; report?: unknown }
  if (body.has_report !== true) return null
  return typeof body.report === 'string' && body.report.trim() ? body.report : null
}

/**
 * The collection of the project this run was COMMISSIONED in, off the same body.
 *
 * The backend records it on `job_access` at submit time, from the request that
 * started the run, and returns it beside the report. It is the only statement
 * about the destination that the reader of the report cannot influence.
 */
function readCommissioningCollection(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const body = data as { project_collection?: unknown }
  return typeof body.project_collection === 'string' && body.project_collection
    ? body.project_collection
    : null
}

/**
 * The run's cards off the same body, for the filed PDF's „Rechtsgrundlagen".
 *
 * Only shape is checked, not card identity: the backend already validated these
 * at generation (`aiq_agent.cards.validate_cards`) and `legalBasisSection`
 * narrows them again at render, so a third opinion here could only reject a
 * card both of those accept. What it does do is refuse a non-array, so a
 * malformed body cannot reach `fileResearchReport` as something to iterate.
 *
 * Absent rather than empty when there is nothing: the section prints no heading
 * at all for an absent value, which is the state a report with no legal basis
 * should reach.
 */
function readReportCards(data: unknown): unknown[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { cards } = data as { cards?: unknown }
  return Array.isArray(cards) && cards.length > 0 ? cards : undefined
}

/**
 * File a finished run's report into the project, if this is one.
 *
 * ## Why the failure is swallowed
 *
 * The user asked a question and waited minutes for the answer. Filing is a
 * SECOND thing that happens to that answer, and no failure of it — a quota
 * refusal, a revoked permission, an object store that is down — is a reason to
 * throw the answer away. It is logged and surfaced on the response (`filed`
 * absent) rather than raised, which is the same posture every other best-effort
 * enrichment on this route already takes.
 *
 * ## Interactive runs only
 *
 * A scheduled run (`jobs.schedule_cron`) has no live session, and there is no
 * BFF path today on which one reaches this handler — nothing polls a report on
 * a user's behalf. The session check below is therefore both the anonymous-mode
 * guard and the scheduled-run guard: with no session there is no principal
 * whose `project:documents:write` could authorize the write, and resolving the
 * scheduler's `triggered_by` permission at fire time is a real design that v1.1
 * owns (design doc decision 10). Do not paper over it by falling back to a
 * service token — the agent's principal is WIDER than the user's, which is the
 * hole this whole feature was shaped to avoid.
 */
async function fileReportIfCommissioned(
  req: Request,
  path: string[],
  session: GridSession | null,
  projectId: string | undefined,
  data: unknown
): Promise<ReportFilingOutcome | null> {
  if (path.length !== 3 || path[0] !== 'job' || path[2] !== 'report') return null
  const runId = path[1]
  if (!session?.organizationId || !projectId) return null

  const report = readReportMarkdown(data)
  if (!report) return null

  // WHERE the report goes is a property of the RUN, never of the request that
  // reads it. `projectId` above is whatever the reader's request named, and
  // `buildCollectionScopeFromRequest` fills a missing one in from their stored
  // `active_project_id` — so a run started in a project-less chat (whose banner
  // therefore promised no filing at all) would be filed into whatever project
  // that reader last had open, and an old run reopened while a different
  // project is active would be filed there. Both file a report researched under
  // one Bauordnung carrying a cover sheet that names another one, marked
  // „KI-generiert" and shaped for an Einreichung.
  //
  // So the destination is DERIVED from the run's own `job_access` row and the
  // request's project is not consulted. A run with no commissioning project
  // files nothing: that is the honest reading of „no promise was made", not a
  // licence to pick one.
  const commissioned = readCommissioningCollection(data)
  if (!commissioned) return null
  const commissionedProjectId = await findProjectIdByCollectionName(commissioned, session.organizationId)
  // The collection is real but names no project THIS organization owns. Filing
  // anywhere on that basis would be the cross-tenant version of the bug above.
  if (!commissionedProjectId) return null

  try {
    // Narrowed the way every other proxy-layer call to a session-taking service
    // narrows it (`collection-scope-request.ts`): the organization is what makes
    // a session authorized, and it has just been checked.
    const filed = await fileResearchReport({
      session: session as AuthorizedSession,
      projectId: commissionedProjectId,
      runId,
      report,
      cards: readReportCards(data),
      request: req,
    })
    return {
      status: 'filed',
      filed: { documentId: filed.documentId, filename: filed.filename, alreadyFiled: filed.alreadyFiled },
    }
  } catch (error) {
    // Logged with the reason, reported without it. The log is where an operator
    // finds the bucket, the permission or the limit; the response carries only
    // what the reader can act on.
    console.error(`[${LOG_LABEL}] failed to file the report as a document:`, error)
    return { status: 'failed' }
  }
}

/**
 * Handle GET requests (status, stream, state, report)
 */
export const GET = tenantSlotRoute(async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const isStreamRequest = path.includes('stream')
    const { searchParams } = new URL(req.url)

    // SSE reconnection: the browser's EventSource automatically sends a
    // `Last-Event-ID` header when it reconnects after a dropped connection.
    // Map it onto the backend's /stream/{last_event_id} resume endpoint so
    // reconnects resume after the last delivered event instead of replaying
    // the whole job (duplicated steps/tool calls, double-counted tokens).
    // Backend event ids are integers — anything else is ignored so a bogus
    // header can never break the stream.
    const lastEventId = req.headers.get('Last-Event-ID')?.trim()
    const upstreamPath =
      isStreamRequest &&
      path[path.length - 1] === 'stream' &&
      lastEventId &&
      /^\d+$/.test(lastEventId)
        ? [...path, lastEventId]
        : path
    const backendUrl = buildProxyUrl(JOBS_BASE_PATH, upstreamPath)

    traceRequest('GET:', backendUrl, isStreamRequest ? '(SSE)' : '')

    const { session, authHeader } = await resolveSessionAndBearer(req, path, LOG_LABEL)
    const authHeaders = buildAuthHeaders(authHeader)
    traceRequest('WorkOS access token present:', !!authHeaders.Authorization)

    const { headerValue, projectId } = await buildCollectionScopeFromRequest(
      session,
      parseQueryContext(searchParams)
    )

    // The token query param is consumed for auth and forwarded via headers.
    const upstreamUrl = buildProxyUrl(JOBS_BASE_PATH, upstreamPath, searchParams, ['token'])

    // Forward the request to the backend
    const response = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        ...authHeaders,
        Accept: isStreamRequest ? 'text/event-stream' : 'application/json',
        'X-Grid-Collection-Scope': headerValue,
      },
      ...(isStreamRequest ? { signal: req.signal } : {}),
    })

    // Handle error responses
    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Deep Research API] Backend error:', response.status, errorText)

      return backendErrorEnvelope(response.status, errorText)
    }

    // For SSE streams, pass through the response body
    if (isStreamRequest) {
      if (!response.body) {
        return noResponseBodyEnvelope('Backend returned no SSE stream body')
      }

      // Stream the SSE response back to the client.
      //
      // NOTE: the body is piped AFTER this handler returns, so it runs outside
      // the `runWithTenantSlot` scope this route opened. The pipeline only
      // forwards upstream bytes, so nothing there touches the database today —
      // but a database read added inside the stream would throw
      // `MissingTenantContextError` at an awkward moment. Read what you need
      // before returning, or open a fresh scope inside the stream.
      return sseStreamResponse(response.body, {
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      })
    }

    // For regular JSON responses
    const data = await response.json()

    // This is where a run's completion is observed on the BFF: the client asks
    // for the finished report, and until now the answer was read once, rendered
    // into a chat message and thrown away with the run's file system.
    const filing = await fileReportIfCommissioned(req, path, session, projectId, data)

    // Three shapes, and the third is the point: `filed` when it landed,
    // `filingFailed` when a promise was made and broken, and the untouched body
    // when no promise was made at all (no project, no report, not a report
    // request). A client that has never heard of either key keeps working.
    if (filing?.status === 'filed') return NextResponse.json({ ...data, filed: filing.filed })
    if (filing?.status === 'failed') return NextResponse.json({ ...data, filingFailed: true })
    return NextResponse.json(data)
  } catch (error) {
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    console.error('[Deep Research API] GET error:', error)

    return proxyErrorEnvelope(error)
  }
})

/**
 * Handle POST requests (submit, cancel)
 */
export const POST = tenantSlotRoute(async function POST(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const backendUrl = buildProxyUrl(JOBS_BASE_PATH, path)

    traceRequest('POST:', backendUrl)

    // Get the request body (may be empty for cancel)
    let parsedBody: Record<string, unknown> | undefined
    let body: string | undefined
    try {
      parsedBody = await req.json()
      body = JSON.stringify(parsedBody)
    } catch {
      // No body or invalid JSON - that's okay for cancel
      parsedBody = undefined
      body = undefined
    }

    const { session, authHeader } = await resolveSessionAndBearer(req, path, LOG_LABEL)
    const authHeaders = buildAuthHeaders(authHeader)
    traceRequest('POST WorkOS access token present:', !!authHeaders.Authorization)

    // Deep research is flag-gated (expensive workflow). Only the submit
    // entry point is gated — cancel/stream on running jobs stay available.
    // Anonymous mode (REQUIRE_AUTH=false) has no session to evaluate.
    if (path[0] === 'submit' && session) {
      const gated = requireFeature(session, FEATURE_FLAGS.deepResearch)
      if (gated) return gated
    }

    const { headerValue, scopedCollections, projectId } = await buildCollectionScopeFromRequest(
      session,
      parseBodyContext(parsedBody)
    )
    // The shelf-bearing entries, not the bare names: the signed envelope is the
    // copy `scoping.py` trusts for an authenticated turn (ADR-0047).
    const gridContextHeaders = await resolveGridContextHeaders(session, {
      projectId,
      collectionScope: scopedCollections,
    })

    // Forward the request to the backend.
    //
    // `resolveGridContextHeaders` also emits `X-Grid-Collection-Scope` (it
    // encodes the same `scope` for the signed envelope), so it must NOT be
    // spread over the authoritative header the route computed. Set the scope
    // header from `buildCollectionScopeFromRequest`'s `headerValue` LAST so it
    // is the single source of truth — identical to the envelope's encoding in
    // production, and consistent with the GET/DELETE handlers.
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...gridContextHeaders,
        'X-Grid-Collection-Scope': headerValue,
      },
      ...(body ? { body } : {}),
    })

    // Handle error responses
    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Deep Research API] Backend error:', response.status, errorText)

      return backendErrorEnvelope(response.status, errorText)
    }

    // Return JSON response
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (error) {
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    console.error('[Deep Research API] POST error:', error)

    return proxyErrorEnvelope(error)
  }
})

/**
 * Handle DELETE requests (cancel)
 */
export const DELETE = tenantSlotRoute(async function DELETE(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const backendUrl = buildProxyUrl(JOBS_BASE_PATH, path)
    const { searchParams } = new URL(req.url)

    traceRequest('DELETE:', backendUrl)

    const { session, authHeader } = await resolveSessionAndBearer(req, path, LOG_LABEL)
    const authHeaders = buildAuthHeaders(authHeader)
    traceRequest('DELETE WorkOS access token present:', !!authHeaders.Authorization)

    const { headerValue } = await buildCollectionScopeFromRequest(
      session,
      parseQueryContext(searchParams)
    )

    const upstreamUrl = buildProxyUrl(JOBS_BASE_PATH, path, searchParams, ['token'])

    const response = await fetch(upstreamUrl, {
      method: 'DELETE',
      headers: {
        ...authHeaders,
        Accept: 'application/json',
        'X-Grid-Collection-Scope': headerValue,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Deep Research API] DELETE Backend error:', response.status, errorText)

      return backendErrorEnvelope(response.status, errorText)
    }

    const data = await response.json().catch(() => ({}))
    return NextResponse.json(data, { status: response.status })
  } catch (error) {
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    console.error('[Deep Research API] DELETE error:', error)

    return proxyErrorEnvelope(error)
  }
})
