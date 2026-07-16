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
 */

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
