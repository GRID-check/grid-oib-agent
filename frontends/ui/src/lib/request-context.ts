/**
 * GridRequestContext — the single typed builder for every `X-Grid-*`
 * cross-cutting context header the BFF forwards to the Python backend
 * (aiq_agent) on a submission path.
 *
 * Backlog T3-9 (2026-07-16 audit): each submission path used to hand-roll its
 * own subset of these headers — the WS-upgrade block in `server.js`, the
 * `/api/auth/websocket-scope` route, the async-jobs REST proxy, and the
 * workflows submission path all independently remembered (or, in one
 * audited case, forgot) to forward `x-grid-model-overrides`. This module is
 * the wire contract: build the input once, get back every header with the
 * exact encoding the Python side (`src/aiq_agent/project_context.py`,
 * `common/model_overrides.py`, `common/cost_tracking.py`,
 * `common/data_sources.py`, `knowledge/scoping.py`) expects. A path that
 * forgets a field now gets it via `buildGridRequestContextHeaders`; a path
 * that encodes something differently is caught by the shared fixture at
 * `tests/fixtures/grid_request_context.json` (TS twin:
 * `frontends/ui/tests/fixtures/grid_request_context.json`).
 *
 * Header inventory (every `x-grid-*` header found via
 * `grep -rniE "x-grid-[a-z-]+"` across `frontends/ui/src`, `server.js`, and
 * `src/aiq_agent` as of this audit):
 *
 * | Header                              | Wire encoding                          | Source of truth (pre-refactor)                          |
 * |--------------------------------------|-----------------------------------------|----------------------------------------------------------|
 * | X-Grid-Organization-Id                | raw string                              | server.js WS upgrade (~line 300)                         |
 * | X-Grid-User-Id                        | raw string                              | server.js WS upgrade (~line 301)                         |
 * | X-Grid-Project-Id                     | raw string                              | server.js WS upgrade (~line 322)                         |
 * | X-Grid-Collection-Scope               | base64url(JSON.stringify(string[]))     | `collection-scope.ts` buildCollectionScopeHeader          |
 * | X-Grid-Project-Context                | base64url(utf8 text)                    | server.js WS upgrade (~line 313)                         |
 * | X-Grid-Project-Memory                 | base64url(utf8 text)                    | server.js WS upgrade (~line 325)                         |
 * | X-Grid-Model-Overrides                | base64url(JSON.stringify(Record))       | server.js (~342) / `model-config/header-encoding.ts`     |
 * | X-Grid-Budget                         | base64url(JSON.stringify(BudgetSnapshot))| server.js (~348) / `workflows/service.ts` buildBudgetHeader |
 * | X-Grid-Disabled-Sources               | base64url(JSON.stringify(string[]))     | server.js (~358), only set when non-empty                |
 * | X-Grid-Feature-Memory-Reflection      | `"true"` / `"false"`                    | server.js (~333)                                          |
 *
 * Deliberately OUT of scope: `X-Grid-Internal-Token` (`internal-auth.ts`,
 * `INTERNAL_TOKEN_HEADER`). That header authenticates the BFF *service*
 * against internal-only backend/BFF endpoints with a static shared secret
 * (`GRID_INTERNAL_API_TOKEN`) — it isn't derived from per-request caller
 * context (org/project/model-overrides/...) the way every header above is,
 * and it already has a single centralized producer/consumer pair, so it
 * doesn't belong to the "hand-forwarded, easy to drop" bug class this module
 * targets.
 *
 * `bundesland` (backlog T3-9 follow-up, 2026-07-16, user-mandated) is
 * DELIBERATELY envelope-only: unlike every field in the table above it never
 * had an individual `X-Grid-*` header to dual-write, so
 * `buildGridRequestContextHeaders` below has no case for it — only
 * `buildGridRequestContextEnvelopePayload` does. See
 * `aiq_agent.project_context`'s module docstring for the matching Python-side
 * choice (envelope-only parsing, no legacy individual-header fallback).
 */

import { createHmac } from 'node:crypto'

export interface GridBudgetSnapshot {
  remainingOrgUsd: number | null
  remainingUserUsd: number | null
  remainingProjectUsd: number | null
}

export interface GridRequestContextInput {
  /** → `X-Grid-Organization-Id` (raw). Omitted when falsy (anonymous mode). */
  organizationId?: string | null
  /** → `X-Grid-User-Id` (raw). Omitted when falsy. */
  userId?: string | null
  /** → `X-Grid-Project-Id` (raw). Omitted when falsy (no active project). */
  projectId?: string | null
  /**
   * → `X-Grid-Collection-Scope` (base64url JSON array). Omitted when empty —
   * callers that always want a scope header should pass at least the base
   * collection (`computeCollectionScope` never returns an empty array).
   */
  collectionScope?: string[] | null
  /** → `X-Grid-Project-Context` (base64url text). Omitted when falsy/blank. */
  projectContext?: string | null
  /** → `X-Grid-Project-Memory` (base64url text). Omitted when falsy/blank. */
  projectMemory?: string | null
  /**
   * → `X-Grid-Model-Overrides` (base64url JSON object). Omitted when
   * null/undefined/empty — "no header" means "use the YAML defaults"
   * (fail-open), matching `common/model_overrides.py`.
   */
  modelOverrides?: Record<string, string> | null
  /** → `X-Grid-Budget` (base64url JSON object). Omitted when null/undefined. */
  budget?: GridBudgetSnapshot | null
  /**
   * → `X-Grid-Disabled-Sources` (base64url JSON array). Omitted when
   * null/undefined/empty, mirroring server.js's `.length > 0` guard.
   */
  disabledSources?: string[] | null
  /**
   * → `X-Grid-Feature-Memory-Reflection` (`"true"`/`"false"`). Only omitted
   * when `undefined` — pass an explicit boolean to preserve the fail-closed
   * contract (`get_memory_reflection_enabled_from_context` treats an absent
   * header as `false`).
   */
  memoryReflectionEnabled?: boolean
  /**
   * → envelope payload field `bundesland` ONLY (backlog T3-9 follow-up,
   * 2026-07-16, user-mandated) — there is no individual `X-Grid-Bundesland`
   * header; see `buildGridRequestContextEnvelopePayload`'s docstring for why.
   * The validated jurisdiction token the intake wizard collects (PR #71) as
   * a structured project-profile fact (nine Bundesland tokens plus
   * `ausserhalb_oesterreichs` — see
   * `@/lib/project-profile/intake-definition`'s `BUNDESLAND_TOKENS`),
   * carried STRUCTURED alongside the unchanged `bundesland=<token>` text
   * line inside `projectContext` (still read by the LLM — this is a
   * parallel channel, not a replacement). Omitted when falsy: a producer
   * with no project scope (or an unresolved/unknown token) must omit the
   * field rather than send an unvalidated value — the backend's fallback
   * (structured prompt-text line, then free-text probing) takes over
   * exactly as it did before this field existed.
   */
  bundesland?: string | null
}

/** Canonical header names, exact casing as sent on the wire. */
export const GRID_HEADER_NAMES = {
  ORGANIZATION_ID: 'X-Grid-Organization-Id',
  USER_ID: 'X-Grid-User-Id',
  PROJECT_ID: 'X-Grid-Project-Id',
  COLLECTION_SCOPE: 'X-Grid-Collection-Scope',
  PROJECT_CONTEXT: 'X-Grid-Project-Context',
  PROJECT_MEMORY: 'X-Grid-Project-Memory',
  MODEL_OVERRIDES: 'X-Grid-Model-Overrides',
  BUDGET: 'X-Grid-Budget',
  DISABLED_SOURCES: 'X-Grid-Disabled-Sources',
  MEMORY_REFLECTION: 'X-Grid-Feature-Memory-Reflection',
  /**
   * Consolidated, signed context envelope (backlog T3-9 follow-up,
   * 2026-07-16, user-mandated): base64url(JSON) of every field above (minus
   * the internal token — see the module docstring), sent ALONGSIDE the
   * individual headers (dual-write; legacy removal is a later cleanup). See
   * `buildGridRequestContextEnvelope` below for the exact payload shape and
   * `aiq_agent.project_context.GridRequestContext.from_envelope` for the
   * Python-side verify+parse counterpart.
   */
  REQUEST_CONTEXT: 'X-Grid-Request-Context',
  /** HMAC-SHA256 (hex) of the envelope's raw JSON, keyed on `GRID_INTERNAL_API_TOKEN`. */
  REQUEST_CONTEXT_SIG: 'X-Grid-Request-Context-Sig',
} as const

/** base64url(JSON.stringify(value)) — the scheme every structured header uses. */
export function encodeGridJsonHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/**
 * base64url(utf8 text) — for the two headers (`project-context`,
 * `project-memory`) that carry raw multi-line text rather than JSON. Node
 * rejects `\n` in header values (`ERR_INVALID_CHAR`), hence the encoding.
 */
export function encodeGridTextHeader(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/**
 * `X-Grid-Model-Overrides` encoder, kept as a named export so callers that
 * only need this one header's wire value (not the full context) don't have
 * to build a whole `GridRequestContextInput`.
 * `@/lib/model-config/header-encoding` re-exports this for back-compat.
 */
export function encodeModelOverridesHeader(overrides: Record<string, string>): string {
  return encodeGridJsonHeader(overrides)
}

/**
 * `X-Grid-Budget` encoder. Same shape/encoding
 * `get_budget_status`/`cost_tracking.py`'s `BUDGET_HEADER` consumer expects.
 */
export function encodeGridBudgetHeader(snapshot: GridBudgetSnapshot): string {
  return encodeGridJsonHeader(snapshot)
}

/**
 * Build the complete set of `X-Grid-*` context headers for one request.
 * Every field is independently optional and independently omitted from the
 * output when absent/empty — callers merge the result into their fetch
 * headers (`{ ...baseHeaders, ...buildGridRequestContextHeaders(input) }`)
 * instead of hand-rolling each header.
 */
export function buildGridRequestContextHeaders(input: GridRequestContextInput): Record<string, string> {
  const headers: Record<string, string> = {}

  if (input.organizationId) {
    headers[GRID_HEADER_NAMES.ORGANIZATION_ID] = input.organizationId
  }
  if (input.userId) {
    headers[GRID_HEADER_NAMES.USER_ID] = input.userId
  }
  if (input.projectId) {
    headers[GRID_HEADER_NAMES.PROJECT_ID] = input.projectId
  }
  if (input.collectionScope && input.collectionScope.length > 0) {
    headers[GRID_HEADER_NAMES.COLLECTION_SCOPE] = encodeGridJsonHeader(input.collectionScope)
  }
  if (input.projectContext) {
    headers[GRID_HEADER_NAMES.PROJECT_CONTEXT] = encodeGridTextHeader(input.projectContext)
  }
  if (input.projectMemory) {
    headers[GRID_HEADER_NAMES.PROJECT_MEMORY] = encodeGridTextHeader(input.projectMemory)
  }
  if (input.modelOverrides && Object.keys(input.modelOverrides).length > 0) {
    headers[GRID_HEADER_NAMES.MODEL_OVERRIDES] = encodeModelOverridesHeader(input.modelOverrides)
  }
  if (input.budget) {
    headers[GRID_HEADER_NAMES.BUDGET] = encodeGridBudgetHeader(input.budget)
  }
  if (input.disabledSources && input.disabledSources.length > 0) {
    headers[GRID_HEADER_NAMES.DISABLED_SOURCES] = encodeGridJsonHeader(input.disabledSources)
  }
  if (input.memoryReflectionEnabled !== undefined) {
    headers[GRID_HEADER_NAMES.MEMORY_REFLECTION] = input.memoryReflectionEnabled ? 'true' : 'false'
  }

  return headers
}

// ---------------------------------------------------------------------------
// Signed context envelope (backlog T3-9 follow-up, 2026-07-16, user-mandated)
// ---------------------------------------------------------------------------
//
// "This consolidated header must be present, because without it we cannot
// verify who the user is, which organization he belongs to, and what model
// overrides the organization — without it, it is just not a valid request."
//
// One consolidated, signed envelope carrying every field above (minus the
// internal token) as a single `X-Grid-Request-Context` header, plus an
// integrity signature (`X-Grid-Request-Context-Sig`, HMAC-SHA256 hex over
// the raw JSON, keyed on `GRID_INTERNAL_API_TOKEN`). This is the ONE place
// that builds it — every producer (this module's own callers, the
// async-jobs proxy route, the workflows service, and `server.js`'s WS-upgrade
// block, which duplicates this logic with a pinning comment because it is
// plain CommonJS and cannot import this TS module) reduces to calling
// `buildGridRequestContextEnvelope`/`buildGridRequestContextWireHeaders` so
// the wire format can never drift between paths. The backend
// (`aiq_agent.project_context.GridRequestContext.from_envelope`) verifies the
// signature with `hmac.compare_digest` and treats an invalid/missing
// signature as an ABSENT envelope (logged as a WARNING tamper signal), not
// an error — callers fall back to the individual headers during the DUAL-WRITE
// transition.

/** Signed envelope wire values for one request. */
export interface GridRequestContextEnvelope {
  /** → `X-Grid-Request-Context`: base64url(JSON) of the envelope payload. */
  header: string
  /**
   * → `X-Grid-Request-Context-Sig`: hex HMAC-SHA256 of the raw JSON, or
   * `null` when no secret was supplied (dev only — see
   * `buildGridRequestContextEnvelope`'s docstring for the fail-open note).
   */
  signature: string | null
}

/**
 * Build the JSON payload embedded in the envelope. Uses the EXACT SAME
 * omission rules as `buildGridRequestContextHeaders` (a field absent from
 * the individual headers is also absent here — see the cross-language
 * contract fixture's `envelopeCases`), and a FIXED key order (organizationId,
 * userId, projectId, collectionScope, projectContext, projectMemory,
 * modelOverrides, budget, disabledSources, memoryReflectionEnabled) so the
 * signed bytes are deterministic across producers/runs for the same input —
 * required for the fixture's precomputed `header`/`signature` values to be
 * exact-match assertable rather than semantic-JSON-equal.
 *
 * `bundesland` (backlog T3-9 follow-up, 2026-07-16, user-mandated) was added
 * LAST in the key order (after `memoryReflectionEnabled`) specifically so
 * every pre-existing fixture case's signed bytes stay byte-identical — an
 * earlier position would have required recomputing every prior case's
 * `header`/`signature`.
 */
export function buildGridRequestContextEnvelopePayload(input: GridRequestContextInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {}

  if (input.organizationId) {
    payload.organizationId = input.organizationId
  }
  if (input.userId) {
    payload.userId = input.userId
  }
  if (input.projectId) {
    payload.projectId = input.projectId
  }
  if (input.collectionScope && input.collectionScope.length > 0) {
    payload.collectionScope = input.collectionScope
  }
  if (input.projectContext) {
    payload.projectContext = input.projectContext
  }
  if (input.projectMemory) {
    payload.projectMemory = input.projectMemory
  }
  if (input.modelOverrides && Object.keys(input.modelOverrides).length > 0) {
    payload.modelOverrides = input.modelOverrides
  }
  if (input.budget) {
    payload.budget = input.budget
  }
  if (input.disabledSources && input.disabledSources.length > 0) {
    payload.disabledSources = input.disabledSources
  }
  if (input.memoryReflectionEnabled !== undefined) {
    payload.memoryReflectionEnabled = input.memoryReflectionEnabled
  }
  if (input.bundesland) {
    payload.bundesland = input.bundesland
  }

  return payload
}

/** HMAC-SHA256 (hex) of `json`, keyed on `secret` — the envelope's integrity signature. */
export function signGridRequestContextEnvelope(json: string, secret: string): string {
  return createHmac('sha256', secret).update(json, 'utf8').digest('hex')
}

/**
 * Mint the signed context envelope for one request.
 *
 * `secret` is normally `process.env.GRID_INTERNAL_API_TOKEN`. When falsy
 * (local dev without the token configured), the envelope is still minted
 * but UNSIGNED (`signature: null`) — the backend's enforcement middleware
 * mirrors this exact fail-open choice: signature verification is skipped
 * when the backend also has no token configured, but envelope PRESENCE is
 * still required for authenticated requests either way, so dev still
 * exercises "did this producer remember to attach the envelope at all".
 */
export function buildGridRequestContextEnvelope(
  input: GridRequestContextInput,
  secret: string | null | undefined,
): GridRequestContextEnvelope {
  const json = JSON.stringify(buildGridRequestContextEnvelopePayload(input))
  const header = Buffer.from(json, 'utf8').toString('base64url')
  const signature = secret ? signGridRequestContextEnvelope(json, secret) : null
  return { header, signature }
}

/**
 * The envelope as a ready-to-spread header map: always sets
 * `X-Grid-Request-Context`; sets `X-Grid-Request-Context-Sig` only when
 * `secret` was supplied. Called by `buildGridRequestContextWireHeaders`
 * below — most producers should call that instead so they dual-write the
 * individual headers and the envelope in one call.
 */
export function buildGridRequestContextEnvelopeHeaders(
  input: GridRequestContextInput,
  secret: string | null | undefined,
): Record<string, string> {
  const { header, signature } = buildGridRequestContextEnvelope(input, secret)
  const headers: Record<string, string> = {
    [GRID_HEADER_NAMES.REQUEST_CONTEXT]: header,
  }
  if (signature) {
    headers[GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG] = signature
  }
  return headers
}

/**
 * The full dual-write header set for one request: every individual
 * `X-Grid-*` header (`buildGridRequestContextHeaders`, unchanged, kept for
 * transition safety) PLUS the signed envelope
 * (`buildGridRequestContextEnvelopeHeaders`). This is the function
 * submission-path producers should call — a caller that uses this instead
 * of the two builders separately cannot forget one side of the dual-write.
 */
export function buildGridRequestContextWireHeaders(
  input: GridRequestContextInput,
  secret: string | null | undefined,
): Record<string, string> {
  return {
    ...buildGridRequestContextHeaders(input),
    ...buildGridRequestContextEnvelopeHeaders(input, secret),
  }
}
